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


# ---------------------------------------------------------------- 카톡 알림

def check_kakao(hours: float = 12.0) -> list[dict]:
    """usernoted DB(WAL 사본)에서 카카오톡 알림 조회 — 앱 로직의 파이썬 판."""
    if not os.access(NOTIF_DB, os.R_OK):
        return []
    tmp = tempfile.mkdtemp(prefix="halo_notif_")
    try:
        for sfx in ("", "-wal", "-shm"):
            src = NOTIF_DB + sfx
            if os.path.exists(src):
                shutil.copy2(src, os.path.join(tmp, "db" + sfx))
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
