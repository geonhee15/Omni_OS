#!/usr/bin/env python3
"""안경용 옴니의 공통 두뇌 — 에뮬레이터(live_demo.py)와 폰 안경(phone_glasses.py)이 같이 쓴다.

앱(Omni OS)의 옴니와 같은 능력을 안경에서도 쓰기 위한 도구·지시문·전사 정제·알림 감시.
앱과 공유하는 것: 장기 기억(~/.omni/memory), 두뇌(Claude), 알림 스냅샷, 메일박스(앱 제어),
스마트 기기(Tapo 사이드카), 학교 모드 파일, 정확 계산기.
"""
import asyncio
import json
import os
import re
import subprocess
import sys
import time
import urllib.parse

import numpy as np

import omni_link as link

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(REPO, "scripts"))
import omni_calc  # noqa: E402 — 앱과 같은 정확 계산기

RT_MODEL = "gpt-realtime-2.1"
RT_URL = f"wss://api.openai.com/v1/realtime?model={RT_MODEL}"
OPENAI_KEY_PATH = os.path.expanduser("~/.omni/openai.key")

# ---- 음성 게이트 (앱과 동일: 사람 말 → 내 목소리 → 옴니에게 한 말) ----
GATE_PY = os.path.join(REPO, "voice_engine/venv/bin/python")
GATE_SCRIPT = os.path.join(REPO, "scripts/omni_gate.py")
GATE_AVAILABLE = os.path.exists(GATE_PY) and os.path.exists(GATE_SCRIPT)
WAKE_RE = re.compile(r"(옴니|omni|오므니|옴늬|옴미|^\s*(엄니|음니|오니|옴니)\s*[야아,]?)", re.I)
FOLLOWUP_SEC = 15.0
HALLU_RE = re.compile(r"(시청해\s*주셔서|구독과?\s*좋아요|자막\s*(제공|by)|OMNI_OS|AI 비서 이름|사용자는 '?옴니|아라비아 숫자|MBC 뉴스|KBS 뉴스)", re.I)

SMART_PY = os.path.join(REPO, "smart_engine/venv/bin/python")
SMART_SCRIPT = os.path.join(REPO, "scripts/omni_smart.py")
QUIET_PATH = os.path.expanduser("~/.omni/store/quiet_mode.json")
PRESENCE_PATH = os.path.expanduser("~/.omni/store/presence.json")

PANELS = ("cmd", "ai", "notif", "clock", "proj", "sys", "sp1", "r3d",
          "ino", "ce", "notes", "voice", "arc", "weather", "news", "map",
          "markets", "calendar", "smart", "halo")

# 폰 안경 모드에서 카메라 프레임을 주는 콜백 (jpeg bytes 또는 None). 에뮬레이터에선 None.
CAMERA_PROVIDER = None


def read_key() -> str:
    return open(OPENAI_KEY_PATH).read().strip()


def sanitize_transcript(text: str):
    """전사 정제: 환각(프롬프트 되풀이·한자·상투구) 차단, 호출어만 있는 발화 판별."""
    t = re.sub(r"[㐀-鿿]", " ", text or "")
    t = re.sub(r"[^\w\s.,!?%'\-]", " ", t)
    t = re.sub(r"\s+", " ", t).strip()
    if not t:
        return {"drop": True, "why": "빈 전사"}
    if HALLU_RE.search(t) or HALLU_RE.search(text or ""):
        return {"drop": True, "why": "전사 환각"}
    leftover = re.sub(r"[\s.,!?'\-]", "", re.sub(r"옴니야|옴니|오미니아|omni[_ ]?os|omni", "", t, flags=re.I))
    if not leftover and re.search(r"오미니아|omni[_ ]?os", t, re.I):
        return {"drop": True, "why": "전사 환각(프롬프트 되풀이)"}
    rest = re.sub(r"[\s.,!?'\-0-9]", "", WAKE_RE.sub("", t))
    if WAKE_RE.search(t) and len(rest) <= 2:
        return {"wake_only": True, "text": t}
    return {"text": t}


def resample(pcm: np.ndarray, src: int, dst: int) -> np.ndarray:
    if src == dst or len(pcm) == 0:
        return pcm
    n = int(len(pcm) * dst / src)
    idx = np.linspace(0, len(pcm) - 1, n)
    return np.interp(idx, np.arange(len(pcm)), pcm.astype(np.float64)).astype(np.int16)


def build_instructions(surface: str = "스마트 글래스(Halo)") -> str:
    return (
        f"당신은 OMNI_OS의 관제 AI '옴니'입니다. 지금은 {surface}를 "
        "통한 실시간 음성 대화입니다. 반드시 한국어 존댓말(합니다체)로만 "
        "말합니다 — 반말 금지, 호칭 금지. 담백한 보고체로 1~2문장씩 짧게 "
        "답합니다.\n"
        "도구 규칙: 깊은 분석·조사·설계 질문은 ask_brain에 넘깁니다. "
        "카톡은 check_notifications, 메일은 check_gmail로 확인해 핵심만 "
        "요약해 말합니다. 맥의 옴니 앱 패널을 열거나 조작해 달라는 요청은 "
        "app_action을 사용합니다. 날씨는 check_weather, 뉴스는 check_news, "
        "환율·주식은 check_markets, 일정은 check_calendar, 일정 추가는 "
        "add_event, 지금 시각은 get_time을 씁니다. 집 조명·플러그는 smart_control로 "
        "직접 켜고 끕니다(\"불 꺼줘\"). \"학교 모드 켜줘/카메라 다 꺼줘\"는 quiet_mode. "
        "기억해 달라는 것은 save_memory, 예전 일은 recall_memory. "
        "\"지금 뭐 보여?/이게 뭐야?\"처럼 눈앞을 묻는 말은 look_camera로 카메라를 봅니다. "
        "맥에서 명령 실행·파일 정리는 run_shell, 브라우저 검색·마우스 조작은 app_action의 "
        "web.search / computer 스펙. 숫자 계산은 아무리 작아도 암산하지 말고 "
        "calculate에 수식으로 넘깁니다. 도구 결과에 있는 수치·시각만 말하고 "
        "없는 것은 추정하지 말고 '기록에 없다'고 합니다. 도구 결과는 그대로 "
        "읽지 말고 요약합니다."
        + "\n\n" + link.mem_context())


TOOLS = [
    {"type": "function", "name": "ask_brain",
     "description": "깊은 분석·조사·설계·기억이 필요한 질문을 추론 두뇌"
                    "(Claude)에 전달하고 답을 받는다.",
     "parameters": {"type": "object", "properties": {
         "question": {"type": "string"}}, "required": ["question"]}},
    {"type": "function", "name": "get_time",
     "description": "지금 날짜·시각·요일 (\"몇 시야\", \"오늘 며칠이야\").",
     "parameters": {"type": "object", "properties": {}}},
    {"type": "function", "name": "check_notifications",
     "description": "카카오톡 최근 알림을 확인한다.",
     "parameters": {"type": "object", "properties": {
         "hours": {"type": "number", "description": "조회 범위(시간), 기본 12"}}}},
    {"type": "function", "name": "check_gmail",
     "description": "지메일 받은편지함 최근 메일을 확인한다.",
     "parameters": {"type": "object", "properties": {
         "hours": {"type": "number", "description": "조회 범위(시간), 기본 24"}}}},
    {"type": "function", "name": "calculate",
     "description": "정확 계산기 — 숫자 계산은 전부 여기로(암산 금지). "
                    "expression은 파이썬식 수식 (예: 2400*0.15, sqrt(2), 2**64).",
     "parameters": {"type": "object", "properties": {
         "expression": {"type": "string"}}, "required": ["expression"]}},
    {"type": "function", "name": "check_weather",
     "description": "현재 위치(앱 설정)의 날씨 — 현재/오늘/내일/주간 요약.",
     "parameters": {"type": "object", "properties": {}}},
    {"type": "function", "name": "check_news",
     "description": "뉴스 헤드라인. query를 주면 키워드 검색, 비우면 주요 뉴스.",
     "parameters": {"type": "object", "properties": {
         "query": {"type": "string"}}}},
    {"type": "function", "name": "check_markets",
     "description": "환율(원화 기준)과 관심 종목/지수/코인 시세 요약.",
     "parameters": {"type": "object", "properties": {}}},
    {"type": "function", "name": "smart_control",
     "description": "집 스마트 플러그·조명(Tapo) — action: status/on/off/toggle/brightness/timer(minutes 뒤 끄기). "
                    "device는 기기 이름 일부(하나뿐이면 생략). \"불 꺼줘\", \"켜져 있어?\", \"30분 뒤 꺼줘\".",
     "parameters": {"type": "object", "properties": {
         "action": {"type": "string"}, "device": {"type": "string"},
         "minutes": {"type": "number"}, "brightness": {"type": "number"}},
         "required": ["action"]}},
    {"type": "function", "name": "quiet_mode",
     "description": "학교/시험 모드 — 맥의 카메라 감시(SP-1)·마이크 상시 대기·화면 관찰을 전부 정지(on=true) 또는 해제(on=false). "
                    "\"학교 모드 켜줘\", \"카메라 다 꺼줘\". action=status면 상태만.",
     "parameters": {"type": "object", "properties": {
         "on": {"type": "boolean"}, "minutes": {"type": "number"}, "action": {"type": "string"}}}},
    {"type": "function", "name": "save_memory",
     "description": "사용자가 기억해 달라고 한 사실·선호·할 일을 장기 기억에 저장한다 (앱과 공유).",
     "parameters": {"type": "object", "properties": {
         "text": {"type": "string"}}, "required": ["text"]}},
    {"type": "function", "name": "recall_memory",
     "description": "예전 대화·관찰·메모를 검색한다 (\"저번에 뭐라고 했지\", \"어제 뭐 했어\"). days 기본 7.",
     "parameters": {"type": "object", "properties": {
         "query": {"type": "string"}, "days": {"type": "number"}}, "required": ["query"]}},
    {"type": "function", "name": "look_camera",
     "description": "안경(폰) 카메라로 지금 눈앞을 보고 설명한다 — \"지금 뭐 보여?\", \"이거 뭐야?\", \"이 글자 읽어줘\". question에 사용자가 궁금해한 점.",
     "parameters": {"type": "object", "properties": {
         "question": {"type": "string"}}}},
    {"type": "function", "name": "camera_control",
     "description": "집 카메라(Tapo) — action: look(카메라 화면 설명, question 선택), status, privacy_on/off, ptz_left/right/up/down, watch_on/off. camera는 이름 일부.",
     "parameters": {"type": "object", "properties": {
         "action": {"type": "string"}, "camera": {"type": "string"}, "question": {"type": "string"}},
         "required": ["action"]}},
    {"type": "function", "name": "run_shell",
     "description": "맥에서 셸 명령 실행(zsh, 60초) — 파일 찾기·정리·설치·git. 되돌릴 수 없는 삭제·포맷은 사용자 명시 요청 시에만.",
     "parameters": {"type": "object", "properties": {
         "cmd": {"type": "string"}}, "required": ["cmd"]}},
    {"type": "function", "name": "check_calendar",
     "description": "맥 캘린더의 오늘/다가오는 일정. days 기본 3.",
     "parameters": {"type": "object", "properties": {
         "days": {"type": "number"}}}},
    {"type": "function", "name": "add_event",
     "description": "맥 캘린더에 일정 추가. start는 'YYYY-MM-DD HH:MM' "
                    "(종일이면 'YYYY-MM-DD'). minutes 기본 60.",
     "parameters": {"type": "object", "properties": {
         "title": {"type": "string"}, "start": {"type": "string"},
         "minutes": {"type": "number"}},
         "required": ["title", "start"]}},
    {"type": "function", "name": "app_action",
     "description": "맥의 옴니 앱을 제어한다. open=패널 열기 "
                    f"(키: {', '.join(PANELS)}). spec=세부 액션 문자열 "
                    "(예: notes.open:파일명, proj.editor:프로젝트명, omnia, "
                    "web.search:google:검색어 — 브라우저 검색 바로 열기, "
                    "computer:작업설명 — 맥의 마우스·키보드로 직접 수행, "
                    "smart.timer:기기이름:분 — 조명 예약, "
                    "ui.read:패널키 / ui.click:패널키:버튼글자 — 패널 직접 조작, "
                    "halo.start / halo.stop — 폰 안경 서버).",
     "parameters": {"type": "object", "properties": {
         "open": {"type": "string", "description": "열 패널 키"},
         "spec": {"type": "string", "description": "실행할 액션 스펙"}}}},
]

TOOL_NAMES = [t["name"] for t in TOOLS]


def _smart(cmd: str, args: dict | None = None) -> dict:
    if not (os.path.exists(SMART_PY) and os.path.exists(SMART_SCRIPT)):
        return {"ok": False, "error": "NO_ENGINE", "hint": "smart_engine/venv 없음"}
    try:
        p = subprocess.run([SMART_PY, SMART_SCRIPT, cmd, json.dumps(args or {})],
                           capture_output=True, text=True, timeout=45, cwd=REPO)
        for line in reversed(p.stdout.splitlines()):
            if line.startswith("{"):
                return json.loads(line)
        return {"ok": False, "error": "NO_OUTPUT", "hint": p.stderr[-200:]}
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": "TIMEOUT"}
    except (OSError, ValueError) as e:
        return {"ok": False, "error": str(e)[:120]}


def _fmt_device(d: dict) -> str:
    name = d.get("alias") or d.get("model") or d.get("host")
    if d.get("offline"):
        return f"{name}: 오프라인"
    extra = []
    if d.get("brightness") is not None:
        extra.append(f"밝기 {d['brightness']}%")
    if d.get("power_w") is not None:
        extra.append(f"{float(d['power_w']):.1f}W")
    return f"{name} ({d.get('model', '')}): {'켜짐' if d.get('on') else '꺼짐'}" + (f" · {', '.join(extra)}" if extra else "")


def smart_control(args: dict) -> str:
    action = str(args.get("action") or "status").lower()
    device = str(args.get("device") or "").strip()
    if action in ("status", "list"):
        r = _smart("states")
        devs = r.get("devices") or []
        if not r.get("ok"):
            return f"스마트 기기 확인 실패: {r.get('error')} {r.get('hint', '')}".strip()
        if not devs:
            return "등록된 스마트 기기가 없습니다. 맥의 옴니 앱 SMART CONTROL 패널에서 SCAN을 눌러 주십시오."
        if device:
            devs = [d for d in devs if device.lower() in (d.get("alias") or "").lower()] or devs
        return "\n".join(_fmt_device(d) for d in devs)
    if action == "timer":
        mins = int(args.get("minutes") or 30)
        link.mailbox_push({"type": "action", "spec": f"smart.timer:{device}:{mins}"})
        return f"{device or '조명'}: {mins}분 뒤 끄기 예약을 앱에 보냈습니다"
    target = device
    if not target:
        r = _smart("states")
        devs = r.get("devices") or []
        if len(devs) == 1:
            target = devs[0].get("host")
        elif not devs:
            return "등록된 스마트 기기가 없습니다."
        else:
            return "기기가 여러 개입니다. 이름을 말해 주십시오: " + ", ".join(d.get("alias") or d.get("model") for d in devs)
    if action in ("on", "off", "toggle"):
        r = _smart(action, {"target": target})
    elif action == "brightness":
        r = _smart("set", {"target": target, "brightness": int(args.get("brightness") or 50)})
    else:
        return f"알 수 없는 동작: {action}"
    if not r.get("ok"):
        return f"실패: {r.get('error')} {r.get('hint', '')}".strip()
    d = r.get("device") or {}
    link.mem_append("action", f"스마트 제어(안경): {d.get('alias')} {action} → {'켜짐' if d.get('on') else '꺼짐'}")
    return _fmt_device(d)


def quiet_mode(args: dict) -> str:
    def status_text() -> str:
        try:
            q = json.load(open(QUIET_PATH))
        except (OSError, ValueError):
            q = {}
        try:
            p = json.load(open(PRESENCE_PATH))
        except (OSError, ValueError):
            p = {}
        now = time.time()
        manual = q.get("on") and (not q.get("until") or float(q.get("until") or 0) > now)
        away = p and p.get("home") is False and now - float(p.get("ts") or 0) < 120
        if manual or away:
            why = "수동" if manual else "집 네트워크 아님"
            return f"학교 모드 켜짐 ({why}) — 맥 카메라·마이크·화면 관찰 정지"
        return "학교 모드 꺼짐 — 맥 카메라·마이크 사용 가능"
    if str(args.get("action") or "") == "status" or args.get("on") is None:
        return status_text()
    on = bool(args.get("on"))
    mins = float(args.get("minutes") or 0)
    until = time.time() + mins * 60 if on and mins > 0 else 0.0
    os.makedirs(os.path.dirname(QUIET_PATH), exist_ok=True)
    tmp = QUIET_PATH + ".tmp"
    with open(tmp, "w") as f:
        json.dump({"on": on, "until": until, "reason": "manual", "by": "halo", "ts": time.time()}, f)
    os.replace(tmp, QUIET_PATH)
    link.mem_append("action", f"학교 모드 {'ON' if on else 'OFF'} (안경)")
    time.sleep(0.5)
    return status_text()


def recall_memory(args: dict) -> str:
    q = str(args.get("query") or "").strip()
    days = int(args.get("days") or 7)
    if not q:
        return "검색어가 필요합니다."
    toks = [t for t in re.split(r"[\s,.!?]+", q.lower()) if len(t) >= 2]
    items = link.mem_recent(days=max(1, min(60, days)), limit=1500) or []
    hits = []
    for e in items:
        if e.get("kind") == "ambient":
            continue
        text = str(e.get("text") or "")
        low = text.lower()
        score = sum(1 for t in toks if t in low) + sum(1 for t in toks if len(t) >= 3 and t[:-1] in low) * 0.5
        if score > 0:
            hits.append((score, e))
    hits.sort(key=lambda x: (-x[0], -float(x[1].get("ts", 0))))
    if not hits:
        return f"'{q}' 관련 기억이 없습니다 (최근 {days}일)."
    out = []
    for _, e in hits[:8]:
        ts = time.localtime(float(e.get("ts", 0)))
        out.append(f"{ts.tm_mon}/{ts.tm_mday} {ts.tm_hour:02d}:{ts.tm_min:02d} [{e.get('kind')}] {str(e.get('text'))[:160]}")
    return "\n".join(out)


def run_shell(args: dict) -> str:
    cmd = str(args.get("cmd") or "").strip()
    if not cmd:
        return "명령이 없습니다."
    if re.search(r"\brm\s+-[a-z]*r[a-z]*f?\s+(/|~/?|\$HOME)\s*$|mkfs|diskutil\s+(erase|reformat)|dd\s+if=.*of=/dev", cmd):
        return "시스템 전체를 지우거나 포맷하는 명령은 실행하지 않습니다."
    try:
        p = subprocess.run(["/bin/zsh", "-lc", cmd], capture_output=True, text=True, timeout=60,
                           cwd=os.path.expanduser("~"))
        out = (p.stdout + p.stderr).strip()
        link.mem_append("action", f"셸 실행(안경): {cmd[:200]} → 코드 {p.returncode}")
        if len(out) > 4000:
            out = out[:4000] + "\n…(잘림)"
        return f"[exit {p.returncode}]\n{out or '(출력 없음)'}"
    except subprocess.TimeoutExpired:
        return "60초 안에 끝나지 않아 중단했습니다."


def look_camera(args: dict) -> str:
    if CAMERA_PROVIDER is None:
        return "이 환경에는 카메라가 없습니다 (폰 안경 모드에서만 됩니다)."
    try:
        jpeg = CAMERA_PROVIDER()
    except Exception as e:  # noqa: BLE001
        return f"카메라 프레임을 받지 못했습니다: {e}"
    if not jpeg:
        return "카메라 프레임을 받지 못했습니다. 폰 화면에서 카메라가 켜져 있는지 확인해 주십시오."
    q = str(args.get("question") or "").strip()
    desc = link.describe_image(jpeg, q or "지금 눈앞에 무엇이 보이는지 핵심만 2문장으로.")
    link.mem_append("observe", f"안경 카메라: {desc[:300]}", ["camera"])
    return desc


CAMERA_BASE = "http://127.0.0.1:8484"


def camera_control(args: dict) -> str:
    """집 카메라 사이드카(scripts/omni_camera.py) 직접 호출 — 앱이 서버를 켜 둔 상태여야 한다."""
    import urllib.request
    action = str(args.get("action") or "status").lower()
    cam = str(args.get("camera") or "")
    try:
        if action in ("look", "describe"):
            q = urllib.parse.urlencode({"cam": cam, "q": args.get("question") or ""})
            with urllib.request.urlopen(f"{CAMERA_BASE}/describe?{q}", timeout=30) as r:
                d = json.load(r)
            return f"{d.get('cam')}: {d.get('text')}" if d.get("ok") else f"실패: {d.get('error')} {d.get('hint', '')}".strip()
        if action in ("status", "list"):
            with urllib.request.urlopen(f"{CAMERA_BASE}/status.json", timeout=8) as r:
                d = json.load(r)
            cams = d.get("cameras") or []
            if not cams:
                return "등록된 카메라가 없습니다. 맥의 옴니 앱 CAMERA 패널에서 DISCOVER를 눌러 주십시오."
            return "\n".join(f"{c['name']}: {'온라인' if c.get('online') else '오프라인'}{' · 지금 사람이 보임' if c.get('person') else ''}" for c in cams)
        body = None
        if action in ("privacy_on", "privacy_off"):
            path, body = "/privacy", {"name": cam, "on": action == "privacy_on"}
        elif action.startswith("ptz_"):
            path, body = "/ptz", {"name": cam, "dir": action[4:], "step": 15}
        elif action in ("watch_on", "watch_off"):
            path, body = "/watch", {"name": cam, "on": action == "watch_on"}
        else:
            return f"알 수 없는 동작: {action}"
        req = urllib.request.Request(f"{CAMERA_BASE}{path}", data=json.dumps(body).encode(),
                                     headers={"Content-Type": "application/json"}, method="POST")
        with urllib.request.urlopen(req, timeout=40) as r:
            d = json.load(r)
        return "완료" if d.get("ok") else f"실패: {d.get('error')} {d.get('hint', '')}".strip()
    except Exception as e:  # noqa: BLE001
        return f"카메라 서버에 연결할 수 없습니다 (앱 CAMERA 패널에서 START SERVER): {e}"


def run_tool(name: str, args: dict) -> str:
    """RT 함수 호출 실행 (블로킹 — to_thread로 감싸서 호출)."""
    if name == "ask_brain":
        return link.ask_brain(str(args.get("question", "")))
    if name == "get_time":
        t = time.localtime()
        return f"{t.tm_year}년 {t.tm_mon}월 {t.tm_mday}일 {'월화수목금토일'[t.tm_wday]}요일 {t.tm_hour:02d}:{t.tm_min:02d}"
    if name == "check_notifications":
        items = link.check_kakao_fresh(float(args.get("hours", 12)))
        if items is None:
            return ("카톡 알림 정보를 받지 못했습니다. 맥의 옴니 앱이 실행 "
                    "중이어야 확인할 수 있습니다.")
        if not items:
            return "새 카카오톡 알림이 없습니다."
        lines = [f"{i['title']}: {i['body']}" for i in items[:8]]
        return f"카카오톡 알림 {len(items)}건 —\n" + "\n".join(lines)
    if name == "check_gmail":
        g = link.check_gmail(float(args.get("hours", 24)))
        if not g.get("ok"):
            return f"메일 확인 실패: {g.get('error')}"
        items = g.get("items", [])
        if not items:
            return "새 메일이 없습니다."
        lines = [f"{i.get('from','')}: {i.get('subject','')}"
                 + (" (안읽음)" if i.get("unread") else "")
                 for i in items[:8]]
        return f"메일 {len(items)}건 —\n" + "\n".join(lines)
    if name == "calculate":
        r = omni_calc.evaluate(str(args.get("expression", "")))
        return f"{r['expr']} = {r['text']}" if r.get("ok") else f"계산 오류: {r.get('error')}"
    if name == "check_weather":
        snap = link.request_refresh("weather")
        return (snap or {}).get("summary") or \
            "날씨 정보를 받지 못했습니다. 맥의 옴니 앱이 실행 중이어야 합니다."
    if name == "check_news":
        q = str(args.get("query", "")).strip()
        if q:
            link.mailbox_push({"type": "action", "spec": f"news.search:{q}"})
            time.sleep(1.0)
        snap = link.request_refresh("news")
        items = (snap or {}).get("items") or []
        if not items:
            return "뉴스를 받지 못했습니다. 맥의 옴니 앱이 실행 중이어야 합니다."
        return "헤드라인 —\n" + "\n".join(
            f"{i.get('source','')}: {i.get('title','')}" for i in items[:6])
    if name == "check_markets":
        snap = link.request_refresh("markets")
        return (snap or {}).get("summary") or \
            "시세 정보를 받지 못했습니다. 맥의 옴니 앱이 실행 중이어야 합니다."
    if name in ("smart_control", "check_smart"):
        return smart_control(args if name == "smart_control" else {"action": "status"})
    if name == "quiet_mode":
        return quiet_mode(args)
    if name == "save_memory":
        text = str(args.get("text") or "").strip()
        if not text:
            return "저장할 내용이 없습니다."
        link.mem_append("note", text, ["remember"])
        return f"기억했습니다: {text[:80]}"
    if name == "recall_memory":
        return recall_memory(args)
    if name == "look_camera":
        return look_camera(args)
    if name == "run_shell":
        return run_shell(args)
    if name == "camera_control":
        return camera_control(args)
    if name == "check_calendar":
        snap = link.request_refresh("calendar")
        if not snap:
            return "일정 정보를 받지 못했습니다. 맥의 옴니 앱이 실행 중이어야 합니다."
        days = float(args.get("days", 3))
        return calendar_lines(snap.get("items") or [], days) or "예정된 일정이 없습니다."
    if name == "add_event":
        title = str(args.get("title", "")).strip()
        start = str(args.get("start", "")).strip()
        mins = int(args.get("minutes", 60) or 60)
        if not title or not start:
            return "제목과 시작 시각이 필요합니다."
        link.mailbox_push({"type": "action",
                           "spec": f"cal.add:{title}:{start}:{mins}"})
        time.sleep(3.0)
        snap = link.request_refresh("calendar", wait=6)
        ok = any(i.get("title") == title for i in (snap or {}).get("items", []))
        return (f"일정 추가됨: {title} ({start})" if ok
                else f"일정 추가를 앱에 요청했습니다: {title} ({start}). 캘린더 패널에서 확인해 주세요.")
    if name == "app_action":
        sent = []
        if args.get("open") in PANELS:
            link.mailbox_push({"type": "action", "open": args["open"]})
            sent.append(f"패널 열기 {args['open']}")
        if args.get("spec"):
            link.mailbox_push({"type": "action", "spec": args["spec"]})
            sent.append(f"액션 {args['spec']}")
        return ("앱으로 전달했습니다: " + ", ".join(sent)) if sent \
            else "전달할 액션이 없습니다."
    return f"알 수 없는 도구: {name}"


def calendar_lines(items: list, days: float = 3) -> str:
    """캘린더 스냅샷 → 음성용 줄 목록."""
    now = time.time()
    end = now + days * 86400
    out = []
    for i in items:
        st = float(i.get("start", 0))
        if st > end or float(i.get("end", st)) < now - 60:
            continue
        t = time.localtime(st)
        te = time.localtime(float(i.get("end", st)))
        day = time.strftime("%Y-%m-%d", t)
        label = ("오늘" if day == time.strftime("%Y-%m-%d") else
                 "내일" if day == time.strftime("%Y-%m-%d", time.localtime(now + 86400))
                 else "월화수목금토일"[t.tm_wday] + "요일")
        when = f"{label} {t.tm_mon}/{t.tm_mday} " + (
            "종일" if i.get("allDay") else
            f"{t.tm_hour:02d}:{t.tm_min:02d}–{te.tm_hour:02d}:{te.tm_min:02d}")
        out.append(f"[{when}] {i.get('title', '')}" + (f" @{i['location']}" if i.get("location") else ""))
    return "\n".join(out[:20])


async def notif_watch(show_banner, is_running):
    """카톡/지메일/캘린더 감시 → 새 항목을 HUD 배너로 푸시. show_banner(text, secs)는 코루틴 함수."""
    seen_kakao: set = set()
    seen_mail: set = set()
    reminded: set = set()
    first_k, first_m = True, True
    last_mail = 0.0
    while is_running():
        try:
            items = await asyncio.to_thread(link.check_kakao, 1.0)
            for i in (items or []):
                k = f"{i['ts']:.0f}|{i['title']}|{i['body']}"
                if k in seen_kakao:
                    continue
                seen_kakao.add(k)
                if not first_k:
                    asyncio.ensure_future(show_banner(f"카톡 · {i['title']}: {i['body']}"[:60], 8.0))
            first_k = False
            if time.time() - last_mail > 90:
                last_mail = time.time()
                g = await asyncio.to_thread(link.check_gmail, 1.0)
                for i in (g.get("items") or []):
                    k = f"{i.get('ts')}|{i.get('subject')}"
                    if k in seen_mail:
                        continue
                    seen_mail.add(k)
                    if not first_m:
                        asyncio.ensure_future(show_banner(
                            f"메일 · {i.get('from','')}: {i.get('subject','')}"[:60], 8.0))
                first_m = False
            csnap = link.snapshot("calendar")
            for i in (csnap or {}).get("items", []):
                st = float(i.get("start", 0))
                lead = st - time.time()
                key = f"{i.get('id')}|{st:.0f}"
                if 0 < lead <= 600 and key not in reminded and not i.get("allDay"):
                    reminded.add(key)
                    asyncio.ensure_future(show_banner(f"{int(lead // 60)}분 후 · {i.get('title','')}"[:60], 12.0))
        except Exception as e:  # noqa: BLE001
            print("notif_watch:", e)
        await asyncio.sleep(10)


def quiet_active() -> bool:
    """학교 모드(수동 파일)면 안경도 듣지 않는다."""
    try:
        q = json.load(open(QUIET_PATH))
        return bool(q.get("on")) and (not q.get("until") or float(q.get("until") or 0) > time.time())
    except (OSError, ValueError):
        return False
