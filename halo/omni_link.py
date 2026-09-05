"""옴니 앱 ↔ Halo 브리지 공유 링크.

안경의 옴니가 맥 앱의 옴니와 같은 자원을 쓰게 한다:
- 장기 기억  ~/.omni/store/ai_memory.json (읽기)
- 두뇌       Claude API (~/.omni/anthropic.key) — 앱과 같은 AUTO 라우팅
- 도구       카톡 알림 DB 리더 / scripts/gmail_helper.py
- 앱 제어    ~/.omni/halo_mailbox.jsonl (append) → 앱이 폴링해 실행/표시
"""
import json
import os
import plistlib
import shutil
import sqlite3
import subprocess
import ssl
import tempfile
import time
import urllib.request

import certifi

HOME = os.path.expanduser("~")
REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MEMORY_PATH = os.path.join(HOME, ".omni/store/ai_memory.json")
ANTHROPIC_KEY_PATH = os.path.join(HOME, ".omni/anthropic.key")
GMAIL_KEY_PATH = os.path.join(HOME, ".omni/gmail.key")
GMAIL_HELPER = os.path.join(REPO, "scripts/gmail_helper.py")
MAILBOX = os.path.join(HOME, ".omni/halo_mailbox.jsonl")
NOTIF_DB = os.path.join(
    HOME, "Library/Group Containers/group.com.apple.usernoted/db2/db")

_SSL = ssl.create_default_context(cafile=certifi.where())


# ---------------------------------------------------------------- 장기 기억

def load_memory() -> str:
    """앱과 공유하는 장기 메모리 텍스트 (없으면 빈 문자열)."""
    try:
        with open(MEMORY_PATH) as f:
            data = json.load(f)
        if isinstance(data, dict):
            return str(data.get("text", ""))[:4000]
    except (OSError, ValueError):
        pass
    return ""


# ---------------------------------------------------------------- 두뇌 (Claude)

_DEEP_HINTS = ("왜", "어떻게", "분석", "설계", "비교", "조사", "정리해",
               "계획", "코드", "구현", "차이", "설명", "추천", "전략")


def ask_brain(question: str, extra_context: str = "") -> str:
    """앱과 같은 AUTO 라우팅으로 Claude에 질문 (간단→Haiku, 깊은→Opus 5)."""
    try:
        key = open(ANTHROPIC_KEY_PATH).read().strip()
    except OSError:
        return "두뇌 키가 없습니다 (~/.omni/anthropic.key)."
    deep = len(question) > 60 or any(h in question for h in _DEEP_HINTS)
    model = "claude-opus-5" if deep else "claude-haiku-4-5-20251001"
    memory = load_memory()
    system = (
        "당신은 OMNI_OS의 관제 AI '옴니'의 추론 두뇌입니다. 사용자는 지금 "
        "스마트 글래스(Halo)로 음성 대화 중이며, 이 답은 음성 AI가 그대로 "
        "읽어줍니다. 한국어 존댓말(합니다체), 호칭 금지, 핵심만 3문장 이내."
        + (f"\n\n[장기 메모리]\n{memory}" if memory else "")
        + (f"\n\n[상황]\n{extra_context}" if extra_context else ""))
    body = json.dumps({
        "model": model, "max_tokens": 700,
        "system": [{"type": "text", "text": system,
                    "cache_control": {"type": "ephemeral"}}],
        "messages": [{"role": "user", "content": question}],
    }).encode()
    req = urllib.request.Request(
        "https://api.anthropic.com/v1/messages", data=body,
        headers={"x-api-key": key, "anthropic-version": "2023-06-01",
                 "content-type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=60, context=_SSL) as r:
            res = json.load(r)
        return "".join(b.get("text", "") for b in res.get("content", [])
                       if b.get("type") == "text").strip() or "(응답 없음)"
    except Exception as e:  # noqa: BLE001 — 음성으로 전달할 한 줄 요약
        return f"두뇌 호출 실패: {e}"


def classify_addressed(text: str, last_omni: str = "") -> bool:
    """대화 이어가기 창 안의 호출어 없는 발화 — 옴니에게 이어서 하는 말인가 (Haiku)."""
    try:
        key = open(ANTHROPIC_KEY_PATH).read().strip()
    except OSError:
        return False
    body = json.dumps({
        "model": "claude-haiku-4-5-20251001", "max_tokens": 5,
        "system": ("당신은 음성 비서 '옴니'의 발화 게이트입니다. 사용자는 몇 초 전 옴니의 "
                   "답을 들었습니다. 지금 들린 발화가 옴니에게 이어서 하는 말(질문·요청·"
                   "응답·확인·감사)이면 YES, 다른 사람에게 하는 말·혼잣말·TV/영상 소리·"
                   "무관한 잡담이면 NO. 반드시 YES 또는 NO 한 단어만 출력합니다."),
        "messages": [{"role": "user",
                      "content": f"[옴니의 직전 답] {last_omni[:300] or '(없음)'}\n[지금 들린 발화] {text}"}],
    }).encode()
    req = urllib.request.Request(
        "https://api.anthropic.com/v1/messages", data=body,
        headers={"x-api-key": key, "anthropic-version": "2023-06-01",
                 "content-type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=15, context=_SSL) as r:
            res = json.load(r)
        out = "".join(b.get("text", "") for b in res.get("content", [])
                      if b.get("type") == "text").strip().upper()
        return out.startswith("YES")
    except Exception:  # noqa: BLE001 — 판정 불가 → 안전하게 무시
        return False


# ---------------------------------------------------------------- 카톡 알림
#
# 알림 DB는 TCC 보호라 이 파이썬(별도 TCC 신원)은 직접 못 읽는다.
# 대신 FDA를 가진 옴니 앱이 폴링 때마다 스냅샷을 파일로 밀어주고
# (~/.omni/store/halo_notif.json), 여기서는 그 파일을 읽는다.

NOTIF_SNAPSHOT = os.path.join(HOME, ".omni/store/halo_notif.json")
SNAPSHOT_MAX_AGE = 150.0  # 초 — 이보다 오래되면 앱 미가동으로 간주


def _read_snapshot(hours: float) -> "list[dict] | None":
    """앱 스냅샷에서 카톡 항목. None = 스냅샷 없음/부패(앱 미가동)."""
    try:
        with open(NOTIF_SNAPSHOT) as f:
            snap = json.load(f)
        if time.time() - float(snap.get("ts", 0)) / 1000 > SNAPSHOT_MAX_AGE:
            return None
        cutoff = time.time() - hours * 3600
        return [i for i in snap.get("items", [])
                if "kakao" in str(i.get("app", "")).lower()
                and float(i.get("ts", 0)) > cutoff]
    except (OSError, ValueError):
        return None


def check_kakao(hours: float = 12.0) -> "list[dict] | None":
    """카톡 알림 조회 — 앱 스냅샷 우선, 안 되면 DB 직접(FDA 있을 때만).
    None = 어느 경로로도 확인 불가 (옴니 앱 확인 필요)."""
    snap = _read_snapshot(hours)
    if snap is not None:
        return snap
    direct = _check_kakao_db(hours)
    return direct


def check_kakao_fresh(hours: float = 12.0, wait: float = 6.0) -> "list[dict] | None":
    """앱에 즉시 재조회를 요청하고 새 스냅샷을 기다린 뒤 읽는다."""
    try:
        old_m = os.path.getmtime(NOTIF_SNAPSHOT)
    except OSError:
        old_m = 0
    mailbox_push({"type": "notif_refresh"})
    deadline = time.time() + wait
    while time.time() < deadline:
        try:
            if os.path.getmtime(NOTIF_SNAPSHOT) > old_m:
                break
        except OSError:
            pass
        time.sleep(0.5)
    return check_kakao(hours)


def _check_kakao_db(hours: float) -> "list[dict] | None":
    """usernoted DB(WAL 사본) 직접 조회 — 이 프로세스에 FDA가 있을 때만."""
    if not os.access(NOTIF_DB, os.R_OK):
        return None
    tmp = tempfile.mkdtemp(prefix="halo_notif_")
    try:
        try:
            for sfx in ("", "-wal", "-shm"):
                src = NOTIF_DB + sfx
                if os.path.exists(src):
                    shutil.copy2(src, os.path.join(tmp, "db" + sfx))
        except OSError:
            return None  # TCC 차단 — 앱 스냅샷만이 유일한 경로
        db = sqlite3.connect(os.path.join(tmp, "db"))
        cutoff = time.time() - 978307200.0 - hours * 3600  # Core Data epoch
        out, seen = [], set()
        for table in ("record", "delivered", "displayed", "requests"):
            for datecol in ("delivered_date", "presented_date", "date",
                            "request_date"):
                try:
                    rows = db.execute(
                        f"SELECT app.identifier, t.{datecol}, t.data "
                        f"FROM {table} t JOIN app ON t.app_id = app.app_id "
                        f"WHERE t.{datecol} > ? ORDER BY t.{datecol} DESC "
                        f"LIMIT 100", (cutoff,)).fetchall()
                except sqlite3.OperationalError:
                    continue
                for app, ts, blob in rows:
                    if "kakao" not in (app or "").lower():
                        continue
                    title, body = "", ""
                    if blob:
                        try:
                            p = plistlib.loads(blob)
                            req = p.get("req", p) if isinstance(p, dict) else {}
                            for k in ("titl", "title"):
                                if isinstance(req.get(k), str) and req[k]:
                                    title = req[k]; break
                            for k in ("body", "mesg", "message", "text"):
                                if isinstance(req.get(k), str) and req[k]:
                                    body = req[k]; break
                        except Exception:  # noqa: BLE001
                            pass
                    if not title and not body:
                        body = "(내용 없음)"
                    k = f"{app}|{ts:.0f}|{title}|{body}"
                    if k in seen:
                        continue
                    seen.add(k)
                    out.append({"app": app, "ts": ts + 978307200.0,
                                "title": title, "body": body})
                break
        db.close()
        out.sort(key=lambda x: -x["ts"])
        return out[:30]
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


# ---------------------------------------------------------------- 앱 스냅샷 (범용)
#
# 안경 연동 규약: 앱이 계산·조회하는 정보(날씨·뉴스·마켓·캘린더·알림)는
# 갱신 때마다 ~/.omni/store/halo_<name>.json 으로 내보내고, 브리지는 그
# 파일만 읽는다. 최신이 필요하면 메일박스로 {"type":"refresh","what":name}
# 을 보내 앱의 재조회를 트리거한 뒤 새 파일을 기다린다.

def snapshot(name: str, max_age: float | None = None) -> "dict | None":
    path = os.path.join(HOME, f".omni/store/halo_{name}.json")
    try:
        with open(path) as f:
            snap = json.load(f)
        if max_age is not None and \
                time.time() - float(snap.get("ts", 0)) / 1000 > max_age:
            return None
        return snap
    except (OSError, ValueError):
        return None


def request_refresh(what: str, wait: float = 8.0) -> "dict | None":
    """앱에 재조회를 요청하고 새 스냅샷을 기다린다 (없으면 기존/None)."""
    path = os.path.join(HOME, f".omni/store/halo_{what}.json")
    try:
        old_m = os.path.getmtime(path)
    except OSError:
        old_m = 0
    mailbox_push({"type": "refresh", "what": what})
    deadline = time.time() + wait
    while time.time() < deadline:
        try:
            if os.path.getmtime(path) > old_m:
                break
        except OSError:
            pass
        time.sleep(0.4)
    return snapshot(what)


# ---------------------------------------------------------------- 지메일

def check_gmail(hours: float = 24.0) -> dict:
    """앱과 같은 IMAP 헬퍼로 최근 메일 조회 (읽기 전용)."""
    if not os.path.exists(GMAIL_KEY_PATH):
        return {"ok": False, "error": "지메일 계정이 연동되어 있지 않습니다."}
    try:
        r = subprocess.run(
            ["python3", GMAIL_HELPER, GMAIL_KEY_PATH, str(hours)],
            capture_output=True, text=True, timeout=45)
        return json.loads(r.stdout.strip() or "{}")
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": str(e)}


# ---------------------------------------------------------------- 앱 메일박스

def mailbox_push(obj: dict) -> None:
    """맥 옴니 앱으로 이벤트 전달 (앱이 2.5초마다 폴링해 소비)."""
    try:
        with open(MAILBOX, "a") as f:
            f.write(json.dumps(obj, ensure_ascii=False) + "\n")
    except OSError:
        pass
