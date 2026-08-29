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

from hangul import caption_packet

HERE = os.path.dirname(os.path.abspath(__file__))
KEY = open(os.path.expanduser("~/.omni/openai.key")).read().strip()
URL = "wss://api.openai.com/v1/realtime?model=gpt-realtime"
INSTRUCTIONS = (
    "당신은 OMNI_OS의 관제 AI '옴니'입니다. 지금은 스마트 글래스(Halo)를 통한 "
    "실시간 음성 대화입니다. 반드시 한국어 존댓말(합니다체)로만 말합니다 — "
    "반말 금지, 호칭 금지. 담백한 보고체로 1~2문장씩 짧게 답합니다."
)

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
                "instructions": INSTRUCTIONS,
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

        def to_glasses(tag: int, payload: bytes):
            emu.inject_bluetooth_data(bytes([tag]) + payload)

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
                        print("[tap] glasses tap received")
                emu.clear_bluetooth_sent()
                await asyncio.sleep(0.04)

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
                    to_glasses(0x03, b"HEARING...")
                elif t == "input_audio_buffer.speech_stopped":
                    to_glasses(0x03, b"THINKING...")
                elif t == "conversation.item.input_audio_transcription.completed":
                    # 사용자 발화는 화면에 띄우지 않음 (터미널 로그만)
                    print("YOU :", ev.get("transcript", "").strip())
                elif t in ("response.output_audio.delta", "response.audio.delta"):
                    to_glasses(0x03, b"SPEAKING")
                    chunk = base64.b64decode(ev.get("delta", ""))
                    speaker_q.put(chunk)
                    pcm16 = resample(
                        np.frombuffer(chunk, dtype=np.int16), 24000, 16000)
                    to_glasses(0x10, pcm16.tobytes())
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
                    omni_txt = ""
                elif t == "response.done":
                    speaking_until += 0.5
                    to_glasses(0x03, b"LISTENING")
                elif t == "error":
                    print("RT ERROR:", ev.get("error"))

        try:
            await asyncio.gather(glasses_to_ws(), ws_events())
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
        screen.blit(pygame.transform.scale(surf, (512, 512)), (0, 0))
        pygame.display.flip()
        clock.tick(20)
    pygame.quit()
    emu.stop()


if __name__ == "__main__":
    main()
