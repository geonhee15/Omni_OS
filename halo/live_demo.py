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


HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)

# 공통 두뇌(지시문·도구·전사 정제·게이트 경로)는 glasses_core — 폰 안경(phone_glasses.py)과 동일
from glasses_core import (  # noqa: E402
    FOLLOWUP_SEC, GATE_PY, GATE_SCRIPT, GATE_AVAILABLE, PANELS, RT_MODEL, RT_URL as URL,
    TOOLS, WAKE_RE, build_instructions, read_key, resample, run_tool, sanitize_transcript,
)

KEY = read_key()
USE_GATE = GATE_AVAILABLE and "--no-gate" not in sys.argv

emu = HaloEmulator(sandbox_dir=os.path.join(HERE, "sandbox"))
speaker_q: "queue.Queue[bytes]" = queue.Queue()
running = True
speaking_until = 0.0  # 이 시각까지는 마이크 게이트 (에코 방지)


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
