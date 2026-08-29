#!/usr/bin/env python3
"""OMNI ↔ Halo 브리지 (에뮬레이터 데모).

경로: 질문 wav → [에뮬레이터 마이크] → Lua 앱 → BLE(0x20+PCM16k)
     → 브리지 → 리샘플 24k → gpt-realtime(marin) → 응답 오디오/전사
     → BLE(0x10 스피커 / 0x02 자막 / 0x03 상태) → Lua 렌더.

산출물: halo_demo.gif(원형 화면 녹화), halo_reply.wav(marin 응답),
        halo_final.png(마지막 프레임)
실기기 전환 시 이 파일의 에뮬레이터 I/O만 brilliant_ble 전송으로 교체.
"""
import asyncio
import base64
import json
import os
import sys
import wave

import ssl

import certifi
import numpy as np
import websockets
from halo_emulator import HaloEmulator

KEY = open(os.path.expanduser("~/.omni/openai.key")).read().strip()
URL = "wss://api.openai.com/v1/realtime?model=gpt-realtime"

INSTRUCTIONS = (
    "당신은 OMNI_OS의 관제 AI '옴니'입니다. 지금은 스마트 글래스(Halo)를 통한 "
    "실시간 음성 대화입니다. 반드시 한국어 존댓말(합니다체)로만 말합니다 — "
    "반말 금지. 호칭 금지. 담백한 보고체로 1~2문장씩 짧게 답합니다. "
    "예: \"네, 확인했습니다. 글래스 연결이 정상입니다.\""
)


def resample(pcm: np.ndarray, src: int, dst: int) -> np.ndarray:
    if src == dst or len(pcm) == 0:
        return pcm
    n = int(len(pcm) * dst / src)
    idx = np.linspace(0, len(pcm) - 1, n)
    return np.interp(idx, np.arange(len(pcm)), pcm.astype(np.float64)).astype(np.int16)


def load_question_16k(path: str) -> bytes:
    with wave.open(path, "rb") as w:
        sr = w.getframerate()
        pcm = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16)
    return resample(pcm, sr, 16000).tobytes()


async def main():
    question = load_question_16k(sys.argv[1])
    emu = HaloEmulator(sandbox_dir="./sandbox")
    emu.load_directory("./lua")
    emu.start_recording(fps=15)
    emu.start("main.lua")
    await asyncio.sleep(0.5)
    if emu.get_error():
        print("LUA ERROR:", emu.get_error())
        return

    reply_pcm24 = bytearray()
    transcript = []
    user_text = []
    done = asyncio.Event()

    def to_glasses(tag: int, payload: bytes):
        emu.inject_bluetooth_data(bytes([tag]) + payload)

    def status(s: str):
        to_glasses(0x03, s.encode())

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
                            "type": "server_vad", "threshold": 0.6,
                            "prefix_padding_ms": 300, "silence_duration_ms": 600,
                            "create_response": True,
                        },
                    },
                    "output": {"format": {"type": "audio/pcm", "rate": 24000},
                               "voice": "marin"},
                },
            },
        }))

        async def mic_feed():
            # 질문 wav를 에뮬레이터 마이크에 실시간 페이싱으로 주입 + 꼬리 침묵
            silence = b"\x00" * 1600
            for _ in range(10):
                emu.inject_microphone_data(silence)
                await asyncio.sleep(0.05)
            for i in range(0, len(question), 1600):
                emu.inject_microphone_data(question[i:i + 1600])
                await asyncio.sleep(0.05)
            while not done.is_set():
                emu.inject_microphone_data(silence)
                await asyncio.sleep(0.05)

        async def glasses_to_ws():
            # Lua가 BLE로 내보낸 마이크 청크를 걷어 리얼타임으로 전달
            while not done.is_set():
                for pkt in emu.get_bluetooth_sent():
                    if pkt[:1] == b"\x20":
                        pcm16 = np.frombuffer(pkt[1:], dtype=np.int16)
                        pcm24 = resample(pcm16, 16000, 24000)
                        await ws.send(json.dumps({
                            "type": "input_audio_buffer.append",
                            "audio": base64.b64encode(pcm24.tobytes()).decode(),
                        }))
                emu.clear_bluetooth_sent()
                await asyncio.sleep(0.04)

        async def ws_events():
            speaking = False
            async for raw in ws:
                ev = json.loads(raw)
                t = ev.get("type")
                if t == "input_audio_buffer.speech_started":
                    status("HEARING...")
                elif t == "input_audio_buffer.speech_stopped":
                    status("THINKING...")
                elif t == "conversation.item.input_audio_transcription.completed":
                    user_text.append(ev.get("transcript", "").strip())
                elif t in ("response.output_audio.delta", "response.audio.delta"):
                    if not speaking:
                        speaking = True
                        status("SPEAKING")
                    chunk = base64.b64decode(ev.get("delta", ""))
                    reply_pcm24.extend(chunk)
                    pcm16 = resample(
                        np.frombuffer(chunk, dtype=np.int16), 24000, 16000)
                    to_glasses(0x10, pcm16.tobytes())
                elif t in ("response.output_audio_transcript.done",
                           "response.audio_transcript.done"):
                    transcript.append(ev.get("transcript", ""))
                elif t == "response.done":
                    status("DONE")
                    to_glasses(0x02, b"REPLY RECEIVED\nAUDIO 16K OK")
                    await asyncio.sleep(1.0)
                    done.set()
                    return
                elif t == "error":
                    print("RT ERROR:", ev.get("error"))
                    done.set()
                    return

        try:
            await asyncio.wait_for(
                asyncio.gather(mic_feed(), glasses_to_ws(), ws_events()),
                timeout=60)
        except (asyncio.TimeoutError, asyncio.CancelledError):
            pass

    emu.get_framebuffer().save("halo_final.png")
    emu.stop_recording("halo_demo.gif")
    emu.stop()
    with wave.open("halo_reply.wav", "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(24000)
        w.writeframes(bytes(reply_pcm24))
    print("USER SAID:", " ".join(user_text))
    print("OMNI SAID:", " ".join(transcript))
    print(f"reply audio: {len(reply_pcm24) / 2 / 24000:.1f}s")


if __name__ == "__main__":
    asyncio.run(main())
