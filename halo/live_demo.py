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
import ssl
import threading
import time

import certifi
import numpy as np
import sounddevice as sd
import websockets
from halo_emulator import HaloEmulator

from hud import banner_packet, caption_packet, render_background, status_packet

import omni_link as link

HERE = os.path.dirname(os.path.abspath(__file__))
KEY = open(os.path.expanduser("~/.omni/openai.key")).read().strip()
URL = "wss://api.openai.com/v1/realtime?model=gpt-realtime"

PANELS = ("cmd", "ai", "notif", "clock", "proj", "sys", "sp1", "r3d",
          "ino", "ce", "notes", "voice", "arc", "weather", "news", "map",
          "markets", "calendar")


def build_instructions() -> str:
    memory = link.load_memory()
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
        "add_event를 씁니다. 도구 결과는 그대로 읽지 말고 요약합니다."
        + (f"\n\n[장기 메모리 — 앱과 공유]\n{memory}" if memory else ""))


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
                    "(예: notes.open:파일명, proj.editor:프로젝트명, "
                    "omnia, lang.auto).",
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
        when = f"{t.tm_mon}/{t.tm_mday}" + (
            " 종일" if i.get("allDay") else f" {t.tm_hour:02d}:{t.tm_min:02d}")
        out.append(f"{when} {i.get('title','')}"
                   + (f" ({i.get('calendar')})" if i.get("calendar") else ""))
    return "\n".join(out[:12])


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
                "type": "realtime", "model": "gpt-realtime",
                "output_modalities": ["audio"],
                "instructions": build_instructions(),
                "tools": TOOLS, "tool_choice": "auto",
                "audio": {
                    "input": {
                        "format": {"type": "audio/pcm", "rate": 24000},
                        "transcription": {"model": "whisper-1"},
                        "turn_detection": {
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
                    print("OMNI:", ft)
                    emu.inject_bluetooth_data(caption_packet(ft))
                    if ft.strip():
                        link.mailbox_push({"type": "transcript",
                                           "who": "omni", "text": ft.strip()})
                    omni_txt = ""
                elif t == "response.done":
                    speaking_until += 0.5
                    set_status("LISTENING")
                elif t == "error":
                    print("RT ERROR:", ev.get("error"))

        try:
            await asyncio.gather(glasses_to_ws(), ws_events(), notif_watch())
        finally:
            mic.stop()


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
