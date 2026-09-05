#!/usr/bin/env python3
"""OMNI x Halo 라이브 데모 — 책상 위에서 안경 체험.

맥 마이크(실제 목소리) → 에뮬 안경 → gpt-realtime(marin) → 맥 스피커,
원형 HUD는 pygame 창에 실시간 표시. 종료: 창 닫기 또는 ESC.
SPACE = 안경 탭 제스처 주입.

주의: 스피커 소리가 마이크로 들어가는 에코를 막기 위해 옴니가 말하는
동안은 마이크를 잠시 닫는다(half-duplex). 실기기는 온디바이스 AEC가
있어 이 제약이 없다.
"""
import asyncio
import base64
import json
import os
import queue
import re
import ssl
import struct
import subprocess
import sys
import threading
import time

import certifi
import numpy as np
import sounddevice as sd
import websockets
from halo_emulator import HaloEmulator

from hud import banner_packet, caption_packet, render_background, status_packet

import omni_link as link

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(
    os.path.abspath(__file__))), "scripts"))
import omni_calc  # noqa: E402 — 앱과 같은 정확 계산기

HERE = os.path.dirname(os.path.abspath(__file__))
KEY = open(os.path.expanduser("~/.omni/openai.key")).read().strip()
RT_MODEL = "gpt-realtime-2.1"

# ---- 음성 게이트 (앱과 동일: 사람 말 → 내 목소리 → 옴니에게 한 말) ----
REPO = os.path.dirname(HERE)
GATE_PY = os.path.join(REPO, "voice_engine/venv/bin/python")
GATE_SCRIPT = os.path.join(REPO, "scripts/omni_gate.py")
USE_GATE = os.path.exists(GATE_PY) and os.path.exists(GATE_SCRIPT) \
    and "--no-gate" not in sys.argv
WAKE_RE = re.compile(r"(옴니|omni|오므니|옴늬|옴미|^\s*(엄니|음니|오니|옴니)\s*[야아,]?)", re.I)
FOLLOWUP_SEC = 15.0
HALLU_RE = re.compile(r"(시청해\s*주셔서|구독과?\s*좋아요|자막\s*(제공|by)|OMNI_OS|AI 비서 이름|사용자는 '?옴니|아라비아 숫자|MBC 뉴스|KBS 뉴스)", re.I)


def sanitize_transcript(text: str):
    """전사 정제: 환각(프롬프트 되풀이·한자·상투구) 차단, 호출어만 있는 발화 판별."""
    t = re.sub(r"[\u3400-\u9fff]", " ", text or "")
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
URL = f"wss://api.openai.com/v1/realtime?model={RT_MODEL}"

PANELS = ("cmd", "ai", "notif", "clock", "proj", "sys", "sp1", "r3d",
          "ino", "ce", "notes", "voice", "arc", "weather", "news", "map",
          "markets", "calendar", "smart")


def build_instructions() -> str:
    return (
        "당신은 OMNI_OS의 관제 AI '옴니'입니다. 지금은 스마트 글래스(Halo)를 "
        "통한 실시간 음성 대화입니다. 반드시 한국어 존댓말(합니다체)로만 "
        "말합니다 — 반말 금지, 호칭 금지. 담백한 보고체로 1~2문장씩 짧게 "
        "답합니다.\n"
        "도구 규칙: 깊은 분석·조사·기억 관련 질문은 ask_brain에 넘깁니다. "
        "카톡은 check_notifications, 메일은 check_gmail로 확인해 핵심만 "
        "요약해 말합니다. 맥의 옴니 앱 패널을 열거나 조작해 달라는 요청은 "
        "app_action을 사용합니다. 날씨는 check_weather, 뉴스는 check_news, "
        "환율·주식은 check_markets, 일정은 check_calendar, 일정 추가는 "
        "add_event를 씁니다. 집 조명·플러그는 check_smart(상태)와 "
        "app_action의 smart.on/smart.off/smart.timer 스펙으로 제어합니다. "
        "숫자 계산은 아무리 작아도 암산하지 말고 "
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
    {"type": "function", "name": "check_smart",
     "description": "집 스마트 플러그·조명(Tapo) 현재 상태 — '불 켜져 있어?'. "
                    "켜기/끄기/예약은 app_action spec smart.on:이름, smart.off:이름, "
                    "smart.timer:이름:분 으로 보낸다.",
     "parameters": {"type": "object", "properties": {}}},
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
                    "shell:명령 — 맥에서 셸 명령 실행(파일 찾기·정리·설치), "
                    "smart.on:기기이름 / smart.off:기기이름 / smart.timer:기기이름:분 — 집 스마트 플러그·조명(Tapo) 제어, "
                    "ui.read:패널키 / ui.click:패널키:버튼글자 — 패널 직접 조작).",
     "parameters": {"type": "object", "properties": {
         "open": {"type": "string", "description": "열 패널 키"},
         "spec": {"type": "string", "description": "실행할 액션 스펙"}}}},
]


def run_tool(name: str, args: dict) -> str:
    """RT 함수 호출 실행 (블로킹 — to_thread로 감싸서 호출)."""
    if name == "ask_brain":
        return link.ask_brain(str(args.get("question", "")))
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
    if name == "check_smart":
        snap = link.request_refresh("smart")
        devs = (snap or {}).get("devices") or []
        if not devs:
            return "등록된 스마트 기기가 없습니다. 맥의 옴니 앱 SMART CONTROL 패널에서 SCAN을 눌러 주십시오."
        return "\n".join(
            f"{d.get('alias') or d.get('model')}: {'오프라인' if d.get('offline') else ('켜짐' if d.get('on') else '꺼짐')}"
            + (f", 밝기 {d['brightness']}%" if d.get("brightness") is not None else "")
            for d in devs)
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
            "종일" if i.get("allDay")
            else f"{t.tm_hour:02d}:{t.tm_min:02d}–{te.tm_hour:02d}:{te.tm_min:02d}")
        out.append(f"[{when}] {i.get('title','')}"
                   + (f" ({i.get('calendar')})" if i.get("calendar") else ""))
    if not out:
        return ""
    return ("캘린더 원본 그대로 (시작–종료). 여기 없는 시각은 추정 금지.\n"
            + "\n".join(out[:12]))


emu = HaloEmulator(sandbox_dir=os.path.join(HERE, "sandbox"))
speaker_q: "queue.Queue[bytes]" = queue.Queue()
running = True
speaking_until = 0.0  # 이 시각까지는 마이크 게이트 (에코 방지)


def resample(pcm: np.ndarray, src: int, dst: int) -> np.ndarray:
    if src == dst or len(pcm) == 0:
        return pcm
    n = int(len(pcm) * dst / src)
    idx = np.linspace(0, len(pcm) - 1, n)
    return np.interp(idx, np.arange(len(pcm)), pcm.astype(np.float64)).astype(np.int16)


def speaker_thread():
    with sd.OutputStream(samplerate=24000, channels=1, dtype="int16") as out:
        while running:
            try:
                chunk = speaker_q.get(timeout=0.2)
            except queue.Empty:
                continue
            out.write(np.frombuffer(chunk, dtype=np.int16).reshape(-1, 1))


async def bridge():
    global speaking_until
    ssl_ctx = ssl.create_default_context(cafile=certifi.where())
    async with websockets.connect(
        URL, additional_headers={"Authorization": f"Bearer {KEY}"},
        max_size=None, ssl=ssl_ctx,
    ) as ws:
        await ws.send(json.dumps({
            "type": "session.update",
            "session": {
                "type": "realtime", "model": RT_MODEL,
                "output_modalities": ["audio"],
                "instructions": build_instructions(),
                "tools": TOOLS, "tool_choice": "auto",
                "audio": {
                    "input": {
                        "format": {"type": "audio/pcm", "rate": 24000},
                        "transcription": {
                            "model": "gpt-4o-transcribe",
                            "prompt": "옴니, 옴니야, 오미니아, OMNI_OS",
                        },
                        "turn_detection": None if USE_GATE else {
                            "type": "server_vad", "threshold": 0.7,
                            "prefix_padding_ms": 300, "silence_duration_ms": 600,
                            "create_response": True,
                        },
                    },
                    "output": {"format": {"type": "audio/pcm", "rate": 24000},
                               "voice": "marin"},
                },
            },
        }))

        cur_status = [""]

        # ---- 게이트 사이드카 (파이프 모드) ----
        gate_proc = None
        gate_q: "asyncio.Queue[dict]" = asyncio.Queue()
        loop = asyncio.get_running_loop()
        gate_state = {"last_done": 0.0, "muted": False, "last_omni": ""}

        def gate_write(payload: bytes):
            if gate_proc is None or gate_proc.stdin is None:
                return
            try:
                gate_proc.stdin.write(struct.pack("<I", len(payload)) + payload)
                gate_proc.stdin.flush()
            except (BrokenPipeError, OSError):
                pass

        def gate_cmd(obj: dict):
            gate_write(json.dumps(obj).encode())

        if USE_GATE:
            gate_proc = subprocess.Popen(
                [GATE_PY, GATE_SCRIPT, "pipe"], stdin=subprocess.PIPE,
                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, cwd=REPO)

            def gate_reader():
                for line in gate_proc.stdout:
                    try:
                        ev = json.loads(line)
                    except ValueError:
                        continue
                    loop.call_soon_threadsafe(gate_q.put_nowait, ev)
            threading.Thread(target=gate_reader, daemon=True).start()
            print("음성 게이트: 사이드카 기동 (내 목소리 + 호출어만 통과)")

        def set_status(st: str):
            if st != cur_status[0]:
                cur_status[0] = st
                emu.inject_bluetooth_data(status_packet(st))

        # 맥 마이크 → 에뮬 안경 마이크 (16k, 옴니 발화 중엔 게이트)
        def mic_cb(indata, frames, t, status_):
            if time.time() < speaking_until:
                return
            emu.inject_microphone_data(indata.tobytes())

        mic = sd.InputStream(samplerate=16000, channels=1, dtype="int16",
                             blocksize=800, callback=mic_cb)
        mic.start()

        async def glasses_to_ws():
            while running:
                for pkt in emu.get_bluetooth_sent():
                    if pkt[:1] == b"\x20":
                        if USE_GATE:
                            gate_write(pkt[1:])      # 16k PCM → 사이드카 판정
                            continue
                        pcm24 = resample(
                            np.frombuffer(pkt[1:], dtype=np.int16), 16000, 24000)
                        await ws.send(json.dumps({
                            "type": "input_audio_buffer.append",
                            "audio": base64.b64encode(pcm24.tobytes()).decode(),
                        }))
                    elif pkt[:1] == b"\xF0":
                        # 탭 제스처 = 알림 브리핑 요청
                        print("[tap] glasses tap -> notification brief")
                        await ws.send(json.dumps({
                            "type": "conversation.item.create",
                            "item": {"type": "message", "role": "user",
                                     "content": [{"type": "input_text",
                                                  "text": "(탭 제스처) 새 카톡/메일 알림을 브리핑해 주세요."}]}}))
                        await ws.send(json.dumps({"type": "response.create"}))
                emu.clear_bluetooth_sent()
                await asyncio.sleep(0.04)

        async def gate_events():
            """사이드카 판정: 내 목소리 발화만 세션에 append+commit."""
            while running:
                ev = await gate_q.get()
                e = ev.get("ev")
                if e == "ready":
                    print(f"게이트 준비 · 화자 인증 {'ON' if ev.get('profile') else 'OFF(미등록)'} thr={ev.get('threshold')}")
                elif e == "speech_start":
                    set_status("HEARING")
                elif e == "segment":
                    if ev.get("user") and ev.get("pcm24"):
                        await ws.send(json.dumps({"type": "input_audio_buffer.append",
                                                  "audio": ev["pcm24"]}))
                        await ws.send(json.dumps({"type": "input_audio_buffer.commit"}))
                        set_status("THINKING")
                    else:
                        if ev.get("why") != "short":
                            print(f"무시 · 내 목소리 아님 (sim={ev.get('sim')})")
                        set_status("LISTENING")
                elif e == "exit":
                    print("게이트 종료됨")

        banner_seq = [0]

        async def show_banner(text: str, secs: float = 8.0):
            banner_seq[0] += 1
            seq = banner_seq[0]
            emu.inject_bluetooth_data(banner_packet(text))
            await asyncio.sleep(secs)
            if banner_seq[0] == seq:  # 새 배너가 덮지 않았으면 클리어
                emu.inject_bluetooth_data(banner_packet(""))

        async def notif_watch():
            """카톡/지메일 감시 → 새 항목을 HUD 배너로 푸시."""
            seen_kakao: set = set()
            seen_mail: set = set()
            reminded: set = set()
            first_k, first_m = True, True
            last_mail = 0.0
            while running:
                try:
                    items = await asyncio.to_thread(link.check_kakao, 1.0)
                    for i in (items or []):
                        k = f"{i['ts']:.0f}|{i['title']}|{i['body']}"
                        if k in seen_kakao:
                            continue
                        seen_kakao.add(k)
                        if not first_k:
                            asyncio.ensure_future(show_banner(
                                f"카톡 · {i['title']}: {i['body']}"[:60]))
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
                                    f"메일 · {i.get('from','')}: "
                                    f"{i.get('subject','')}"[:60]))
                        first_m = False
                    # 캘린더: 10분 전 리마인더 배너 (앱이 5분마다 스냅샷 갱신)
                    csnap = link.snapshot("calendar")
                    for i in (csnap or {}).get("items", []):
                        st = float(i.get("start", 0))
                        lead = st - time.time()
                        key = f"{i.get('id')}|{st:.0f}"
                        if 0 < lead <= 600 and key not in reminded \
                                and not i.get("allDay"):
                            reminded.add(key)
                            asyncio.ensure_future(show_banner(
                                f"{int(lead // 60)}분 후 · {i.get('title','')}"[:60], 12))
                except Exception as e:  # noqa: BLE001
                    print("notif_watch:", e)
                await asyncio.sleep(10)

        async def ws_events():
            global speaking_until
            omni_txt = ""
            last_cap = 0.0
            async for raw in ws:
                if not running:
                    return
                ev = json.loads(raw)
                t = ev.get("type")
                if t == "input_audio_buffer.speech_started":
                    set_status("HEARING")
                elif t == "input_audio_buffer.speech_stopped":
                    set_status("THINKING")
                elif t == "conversation.item.input_audio_transcription.completed":
                    # 사용자 발화는 화면에 띄우지 않음 (로그 + 앱 릴레이만)
                    ut = ev.get("transcript", "").strip()
                    if USE_GATE:
                        # 3단: 옴니에게 한 말인가 — 호출어 / 이어가기 창(분류기)
                        item_id = ev.get("item_id")
                        follow = time.time() - gate_state["last_done"] < FOLLOWUP_SEC
                        san = sanitize_transcript(ut)
                        ut = san.get("text", ut)
                        if san.get("drop"):
                            addressed, why = False, san["why"]
                        elif san.get("wake_only"):
                            gate_state["last_done"] = time.time()   # 듣는 창만 열기
                            addressed, why = False, "호출만 감지 → 듣는 창"
                        elif WAKE_RE.search(ut):
                            addressed, why = True, "호출어"
                        elif follow:
                            addressed = await asyncio.to_thread(
                                link.classify_addressed, ut, gate_state["last_omni"])
                            why = "이어지는 대화" if addressed else "이어지는 대화 아님"
                        else:
                            addressed, why = False, "호출어 없음"
                        if addressed:
                            print(f"YOU ({why}):", ut)
                            link.mailbox_push({"type": "transcript", "who": "you", "text": ut})
                            link.mem_append("conv", f"나(안경): {ut}")
                            await ws.send(json.dumps({"type": "response.create"}))
                            if why == "호출어":
                                gate_cmd({"cmd": "adapt"})
                        else:
                            print(f"무시 ({why}):", ut)
                            set_status("LISTENING")
                            if item_id:
                                await ws.send(json.dumps({"type": "conversation.item.delete",
                                                          "item_id": item_id}))
                        continue
                    print("YOU :", ut)
                    if ut:
                        link.mailbox_push({"type": "transcript",
                                           "who": "you", "text": ut})
                elif t == "response.function_call_arguments.done":
                    name = ev.get("name", "")
                    try:
                        fargs = json.loads(ev.get("arguments") or "{}")
                    except ValueError:
                        fargs = {}
                    print("TOOL:", name, fargs)
                    emu.inject_bluetooth_data(status_packet("THINKING"))
                    cur_status[0] = "THINKING"
                    out = await asyncio.to_thread(run_tool, name, fargs)
                    await ws.send(json.dumps({
                        "type": "conversation.item.create",
                        "item": {"type": "function_call_output",
                                 "call_id": ev.get("call_id"),
                                 "output": out}}))
                    await ws.send(json.dumps({"type": "response.create"}))
                elif t in ("response.output_audio.delta", "response.audio.delta"):
                    set_status("SPEAKING")
                    if USE_GATE and not gate_state["muted"]:
                        gate_state["muted"] = True
                        gate_cmd({"cmd": "mute", "on": True})
                    chunk = base64.b64decode(ev.get("delta", ""))
                    speaker_q.put(chunk)
                    pcm16 = resample(
                        np.frombuffer(chunk, dtype=np.int16), 24000, 16000)
                    emu.inject_bluetooth_data(b"\x10" + pcm16.tobytes())
                    # 재생 큐 길이만큼 마이크 게이트 연장
                    speaking_until = max(speaking_until, time.time()) \
                        + len(chunk) / 2 / 24000
                elif t in ("response.output_audio_transcript.delta",
                           "response.audio_transcript.delta"):
                    omni_txt += ev.get("delta", "")
                    if time.time() - last_cap > 0.35:
                        last_cap = time.time()
                        emu.inject_bluetooth_data(
                            caption_packet(omni_txt))
                elif t in ("response.output_audio_transcript.done",
                           "response.audio_transcript.done"):
                    ft = ev.get("transcript", "") or omni_txt
                    gate_state["last_omni"] = ft
                    print("OMNI:", ft)
                    if ft.strip():
                        link.mem_append("conv", f"옴니(안경): {ft.strip()}")
                    emu.inject_bluetooth_data(caption_packet(ft))
                    if ft.strip():
                        link.mailbox_push({"type": "transcript",
                                           "who": "omni", "text": ft.strip()})
                    omni_txt = ""
                elif t == "response.done":
                    speaking_until += 0.5
                    set_status("LISTENING")
                    if USE_GATE:
                        async def unmute_after_playback():
                            while time.time() < speaking_until and running:
                                await asyncio.sleep(0.1)
                            gate_state["muted"] = False
                            gate_state["last_done"] = time.time()
                            gate_cmd({"cmd": "mute", "on": False})
                        asyncio.ensure_future(unmute_after_playback())
                elif t == "error":
                    print("RT ERROR:", ev.get("error"))

        try:
            tasks = [glasses_to_ws(), ws_events(), notif_watch()]
            if USE_GATE:
                tasks.append(gate_events())
            await asyncio.gather(*tasks)
        finally:
            mic.stop()
            if gate_proc is not None:
                try:
                    gate_proc.terminate()
                except OSError:
                    pass


def main():
    global running
    import pygame

    emu.load_directory(os.path.join(HERE, "lua"))
    emu.start("main.lua")
    time.sleep(0.4)
    if emu.get_error():
        print("LUA ERROR:", emu.get_error())
        return
    emu.inject_bluetooth_data(render_background())  # HUD 배경 아트 (1회)
    emu.inject_bluetooth_data(status_packet("LISTENING"))

    threading.Thread(target=speaker_thread, daemon=True).start()
    loop = asyncio.new_event_loop()
    threading.Thread(target=lambda: loop.run_until_complete(bridge()),
                     daemon=True).start()

    pygame.init()
    screen = pygame.display.set_mode((512, 512))
    pygame.display.set_caption("OMNI - HALO EMULATOR (ESC exit / SPACE tap)")
    clock = pygame.time.Clock()
    print("준비됨 — 마이크에 대고 말하세요. (SPACE = 탭, ESC = 종료)")
    while running:
        for e in pygame.event.get():
            if e.type == pygame.QUIT or (
                    e.type == pygame.KEYDOWN and e.key == pygame.K_ESCAPE):
                running = False
            elif e.type == pygame.KEYDOWN and e.key == pygame.K_SPACE:
                emu.inject_imu_tap("single")
        img = emu.get_framebuffer().convert("RGB")
        surf = pygame.image.frombytes(img.tobytes(), img.size, "RGB")
        screen.blit(pygame.transform.smoothscale(surf, (512, 512)), (0, 0))
        pygame.display.flip()
        clock.tick(20)
    pygame.quit()
    emu.stop()


if __name__ == "__main__":
    main()
