#!/usr/bin/env python3
"""폰 안경(Phone Glasses) — 안경이 오기 전에 폰을 안경처럼 쓴다.

같은 와이파이의 폰 브라우저가 https://<맥IP>:8443 에 접속하면
  폰 카메라(뒤) = 안경 카메라(배경 미리보기 + look_camera),
  폰 마이크     = 안경 마이크 → 앱과 같은 음성 게이트(내 목소리·호출어·이어가기) → gpt-realtime,
  폰 화면       = 안경 HUD(256×256 원형, hud.py 스프라이트를 hud_compose로 합성한 PNG),
  폰 스피커     = 안경 스피커(옴니 음성 24k PCM), 화면 탭 = 안경 탭(알림 브리핑).
앱과 공유: 기억·두뇌·도구·메일박스·학교 모드(quiet_mode.json이면 듣지 않음).
상태는 ~/.omni/store/halo_phone.json 으로 앱 HALO GLASSES 패널에 보인다.

실행: halo/venv/bin/python halo/phone_glasses.py [--port 8443] [--no-gate] [--http]
"""
import asyncio
import base64
import io
import json
import os
import socket
import ssl
import struct
import subprocess
import sys
import threading
import time
from collections import deque
from http import HTTPStatus

import certifi
import numpy as np
import websockets
from websockets.asyncio.server import serve

import glasses_core as core
import omni_link as link
from hud import banner_packet, caption_packet, render_background, status_packet
from hud_compose import HudCanvas

HERE = os.path.dirname(os.path.abspath(__file__))
WEB_DIR = os.path.join(HERE, "web")
CERT_DIR = os.path.expanduser("~/.omni/halo_phone")
STATUS_PATH = os.path.expanduser("~/.omni/store/halo_phone.json")
PORT = int(next((sys.argv[i + 1] for i, a in enumerate(sys.argv) if a == "--port" and i + 1 < len(sys.argv)), 8443))
USE_TLS = "--http" not in sys.argv
USE_GATE = core.GATE_AVAILABLE and "--no-gate" not in sys.argv

LOG = deque(maxlen=40)


def log(msg: str):
    line = f"[{time.strftime('%H:%M:%S')}] {msg}"
    LOG.append(line)
    print(line, flush=True)


def lan_ip() -> str:
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 53))
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


# ---------------------------------------------------------------- TLS (폰 브라우저는 https여야 카메라·마이크를 허용)

def ensure_certs(ip: str) -> tuple[str, str]:
    """로컬 CA + 서버 인증서 생성(openssl). CA는 폰에 1회 설치. 반환 (cert, key) 경로."""
    os.makedirs(CERT_DIR, exist_ok=True)
    ca_key, ca_crt = os.path.join(CERT_DIR, "ca.key"), os.path.join(CERT_DIR, "ca.crt")
    sv_key, sv_crt = os.path.join(CERT_DIR, "server.key"), os.path.join(CERT_DIR, "server.crt")
    marker = os.path.join(CERT_DIR, "server.ip")
    if not (os.path.exists(ca_key) and os.path.exists(ca_crt)):
        subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "3650",
                        "-keyout", ca_key, "-out", ca_crt, "-subj", "/CN=Omni Halo Local CA/O=OMNI_OS",
                        "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign"],
                       check=True, capture_output=True)
        log("로컬 CA 생성 (폰에 1회 설치 필요)")
    host = socket.gethostname().split(".")[0]
    same_ip = os.path.exists(marker) and open(marker).read().strip() == ip
    if not (os.path.exists(sv_crt) and os.path.exists(sv_key) and same_ip):
        ext = os.path.join(CERT_DIR, "server.ext")
        with open(ext, "w") as f:
            f.write("basicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\n"
                    "extendedKeyUsage=serverAuth\n"
                    f"subjectAltName=IP:{ip},IP:127.0.0.1,DNS:localhost,DNS:{host}.local\n")
        csr = os.path.join(CERT_DIR, "server.csr")
        subprocess.run(["openssl", "req", "-new", "-newkey", "rsa:2048", "-nodes", "-keyout", sv_key,
                        "-out", csr, "-subj", f"/CN={ip}/O=OMNI_OS"], check=True, capture_output=True)
        subprocess.run(["openssl", "x509", "-req", "-in", csr, "-CA", ca_crt, "-CAkey", ca_key,
                        "-CAcreateserial", "-out", sv_crt, "-days", "825", "-extfile", ext],
                       check=True, capture_output=True)
        open(marker, "w").write(ip)
        log(f"서버 인증서 생성 ({ip})")
    return sv_crt, sv_key


# ---------------------------------------------------------------- 상태

class State:
    def __init__(self):
        self.clients: set = set()
        self.canvas = HudCanvas()
        self.canvas.apply(render_background())
        self.canvas.apply(status_packet("LISTENING"))
        self.status = "LISTENING"
        self.caption = ""
        self.speaking_until = 0.0
        self.mic_on = False
        self.frame_waiters: list[asyncio.Future] = []
        self.loop: asyncio.AbstractEventLoop | None = None
        self.ip = lan_ip()
        self.url = f"{'https' if USE_TLS else 'http'}://{self.ip}:{PORT}/"
        self.gate_ready = None
        self.started = time.time()
        self.quiet = False
        self._qr = None

    def qr_data_url(self) -> str:
        if self._qr is not None:
            return self._qr
        try:
            import qrcode
            img = qrcode.make(self.url, box_size=6, border=2)
            buf = io.BytesIO()
            img.save(buf, format="PNG")
            self._qr = "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()
        except Exception:  # noqa: BLE001
            self._qr = ""
        return self._qr

    def status_doc(self) -> dict:
        return {"running": True, "url": self.url, "ip": self.ip, "port": PORT, "tls": USE_TLS,
                "clients": len(self.clients), "state": self.status, "caption": self.caption,
                "gate": USE_GATE, "gate_ready": self.gate_ready, "mic": self.mic_on,
                "quiet": self.quiet, "tools": core.TOOL_NAMES, "log": list(LOG)[-10:],
                "qr": self.qr_data_url(),
                "uptime": int(time.time() - self.started), "ts": time.time()}


S = State()


def write_status(extra: dict | None = None):
    try:
        os.makedirs(os.path.dirname(STATUS_PATH), exist_ok=True)
        d = S.status_doc()
        if extra:
            d.update(extra)
        tmp = STATUS_PATH + ".tmp"
        with open(tmp, "w") as f:
            json.dump(d, f, ensure_ascii=False)
        os.replace(tmp, STATUS_PATH)
    except OSError:
        pass


async def broadcast(obj: dict):
    if not S.clients:
        return
    msg = json.dumps(obj)
    dead = []
    for c in list(S.clients):
        try:
            await c.send(msg)
        except Exception:  # noqa: BLE001
            dead.append(c)
    for c in dead:
        S.clients.discard(c)


async def push_hud():
    await broadcast({"type": "hud", "png": base64.b64encode(S.canvas.png()).decode(), "v": S.canvas.version})


def camera_provider() -> bytes | None:
    """look_camera 도구가 부른다(스레드) — 폰에 프레임 요청 후 최대 4초 대기."""
    if S.loop is None or not S.clients:
        return None
    fut = asyncio.run_coroutine_threadsafe(_request_frame(), S.loop)
    try:
        return fut.result(timeout=5)
    except Exception:  # noqa: BLE001
        return None


async def _request_frame() -> bytes | None:
    f: asyncio.Future = S.loop.create_future()
    S.frame_waiters.append(f)
    await broadcast({"type": "want_frame"})
    try:
        return await asyncio.wait_for(f, 4.0)
    except asyncio.TimeoutError:
        return None
    finally:
        if f in S.frame_waiters:
            S.frame_waiters.remove(f)


core.CAMERA_PROVIDER = camera_provider


# ---------------------------------------------------------------- HTTP (정적) + WebSocket

def _file(path: str, ctype: str, extra: dict | None = None):
    with open(path, "rb") as f:
        body = f.read()
    headers = {"Content-Type": ctype, "Cache-Control": "no-store"}
    if extra:
        headers.update(extra)
    return headers, body


def process_request(connection, request):
    path = request.path.split("?")[0]
    if path == "/ws":
        return None                                  # WebSocket 업그레이드
    try:
        if path in ("/", "/index.html", "/phone.html"):
            h, b = _file(os.path.join(WEB_DIR, "phone.html"), "text/html; charset=utf-8")
        elif path == "/ca.crt":
            h, b = _file(os.path.join(CERT_DIR, "ca.crt"), "application/x-x509-ca-cert",
                         {"Content-Disposition": 'attachment; filename="omni-halo-ca.crt"'})
        elif path == "/status.json":
            b = json.dumps(S.status_doc(), ensure_ascii=False).encode()
            h = {"Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store"}
        elif path == "/hud.png":
            b = S.canvas.png()
            h = {"Content-Type": "image/png", "Cache-Control": "no-store"}
        else:
            return connection.respond(HTTPStatus.NOT_FOUND, "not found\n")
    except OSError:
        return connection.respond(HTTPStatus.NOT_FOUND, "missing\n")
    resp = connection.respond(HTTPStatus.OK, "")
    resp.headers.clear()
    for k, v in h.items():
        resp.headers[k] = v
    resp.headers["Content-Length"] = str(len(b))
    resp.body = b
    return resp


class Bridge:
    """폰 ↔ gpt-realtime 브리지 (live_demo.bridge와 같은 흐름, I/O만 폰 WebSocket)."""

    def __init__(self):
        self.ws = None
        self.gate_proc = None
        self.gate_q: asyncio.Queue = asyncio.Queue()
        self.gate_state = {"last_done": 0.0, "muted": False, "last_omni": ""}
        self.banner_seq = 0
        self.omni_txt = ""
        self.last_cap = 0.0
        self.mic_q: asyncio.Queue = asyncio.Queue()

    # ---- 게이트 사이드카
    def gate_write(self, payload: bytes):
        if self.gate_proc is None or self.gate_proc.stdin is None:
            return
        try:
            self.gate_proc.stdin.write(struct.pack("<I", len(payload)) + payload)
            self.gate_proc.stdin.flush()
        except (BrokenPipeError, OSError):
            pass

    def gate_cmd(self, obj: dict):
        self.gate_write(json.dumps(obj).encode())

    def start_gate(self, loop):
        if not USE_GATE:
            return
        self.gate_proc = subprocess.Popen(
            [core.GATE_PY, core.GATE_SCRIPT, "pipe"], stdin=subprocess.PIPE,
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, cwd=core.REPO)

        def reader():
            for line in self.gate_proc.stdout:
                try:
                    ev = json.loads(line)
                except ValueError:
                    continue
                loop.call_soon_threadsafe(self.gate_q.put_nowait, ev)
        threading.Thread(target=reader, daemon=True).start()
        log("음성 게이트 사이드카 기동 (내 목소리 + 호출어만 통과 — 앱 ALWAYS와 동일)")

    async def set_status(self, st: str):
        if st == S.status:
            return
        S.status = st
        S.canvas.apply(status_packet(st))
        await push_hud()
        await broadcast({"type": "status", "state": st})

    async def caption(self, text: str):
        S.caption = text
        S.canvas.apply(caption_packet(text))
        await push_hud()

    async def show_banner(self, text: str, secs: float = 8.0):
        self.banner_seq += 1
        seq = self.banner_seq
        S.canvas.apply(banner_packet(text))
        await push_hud()
        await asyncio.sleep(secs)
        if self.banner_seq == seq:
            S.canvas.apply(banner_packet(""))
            await push_hud()

    # ---- 폰 마이크 → 게이트/세션
    async def mic_pump(self):
        while True:
            pcm16 = await self.mic_q.get()          # bytes, 16k PCM16
            if time.time() < S.speaking_until or S.quiet:
                continue                            # 옴니 발화 중(에코)·학교 모드면 버림
            if USE_GATE:
                self.gate_write(b"M" + pcm16)
            elif self.ws is not None:
                pcm24 = core.resample(np.frombuffer(pcm16, dtype=np.int16), 16000, 24000)
                await self.ws.send(json.dumps({"type": "input_audio_buffer.append",
                                               "audio": base64.b64encode(pcm24.tobytes()).decode()}))

    async def gate_events(self):
        while True:
            ev = await self.gate_q.get()
            e = ev.get("ev")
            if e == "ready":
                S.gate_ready = bool(ev.get("profile"))
                log(f"게이트 준비 · 화자 인증 {'ON' if ev.get('profile') else 'OFF(미등록)'} thr={ev.get('threshold')}")
            elif e == "speech_start":
                await self.set_status("HEARING")
            elif e == "segment":
                if ev.get("partial"):
                    continue
                if ev.get("user") and ev.get("pcm24") and self.ws is not None:
                    await self.ws.send(json.dumps({"type": "input_audio_buffer.append", "audio": ev["pcm24"]}))
                    await self.ws.send(json.dumps({"type": "input_audio_buffer.commit"}))
                    await self.set_status("THINKING")
                else:
                    if ev.get("why") not in ("short", "omni_voice"):
                        log(f"경청 · {ev.get('label')} sim={ev.get('sim')}")
                    await self.set_status("LISTENING")
            elif e == "exit":
                log("게이트 종료됨")

    async def tap(self):
        if self.ws is None:
            return
        log("탭 → 알림 브리핑")
        await self.ws.send(json.dumps({
            "type": "conversation.item.create",
            "item": {"type": "message", "role": "user",
                     "content": [{"type": "input_text", "text": "(탭 제스처) 새 카톡/메일 알림을 브리핑해 주세요."}]}}))
        await self.ws.send(json.dumps({"type": "response.create"}))

    # ---- 리얼타임 세션
    async def run(self):
        loop = asyncio.get_running_loop()
        S.loop = loop
        self.start_gate(loop)
        ssl_ctx = ssl.create_default_context(cafile=certifi.where())
        backoff = 2
        while True:
            try:
                async with websockets.connect(core.RT_URL, additional_headers={"Authorization": f"Bearer {core.read_key()}"},
                                              max_size=None, ssl=ssl_ctx) as ws:
                    self.ws = ws
                    backoff = 2
                    await ws.send(json.dumps({
                        "type": "session.update",
                        "session": {
                            "type": "realtime", "model": core.RT_MODEL,
                            "output_modalities": ["audio"],
                            "instructions": core.build_instructions("폰을 안경처럼 쓰는 폰 안경(카메라·마이크·HUD)"),
                            "tools": core.TOOLS, "tool_choice": "auto",
                            "audio": {
                                "input": {
                                    "format": {"type": "audio/pcm", "rate": 24000},
                                    "transcription": {"model": "gpt-4o-transcribe", "prompt": "옴니, 옴니야, 오미니아, OMNI_OS"},
                                    "turn_detection": None if USE_GATE else {
                                        "type": "server_vad", "threshold": 0.7,
                                        "prefix_padding_ms": 300, "silence_duration_ms": 600, "create_response": True},
                                },
                                "output": {"format": {"type": "audio/pcm", "rate": 24000}, "voice": "marin"},
                            },
                        }}))
                    log("리얼타임 세션 연결")
                    await self.events(ws)
            except Exception as e:  # noqa: BLE001
                log(f"세션 끊김: {e} — {backoff}초 후 재연결")
                self.ws = None
                await asyncio.sleep(backoff)
                backoff = min(30, backoff * 2)

    async def events(self, ws):
        async for raw in ws:
            ev = json.loads(raw)
            t = ev.get("type")
            if t == "input_audio_buffer.speech_started":
                await self.set_status("HEARING")
            elif t == "input_audio_buffer.speech_stopped":
                await self.set_status("THINKING")
            elif t == "conversation.item.input_audio_transcription.completed":
                ut = (ev.get("transcript") or "").strip()
                if USE_GATE:
                    item_id = ev.get("item_id")
                    follow = time.time() - self.gate_state["last_done"] < core.FOLLOWUP_SEC
                    san = core.sanitize_transcript(ut)
                    ut = san.get("text", ut)
                    if san.get("drop"):
                        addressed, why = False, san["why"]
                    elif san.get("wake_only"):
                        self.gate_state["last_done"] = time.time()
                        addressed, why = False, "호출만 감지 → 듣는 창"
                    elif core.WAKE_RE.search(ut):
                        addressed, why = True, "호출어"
                    elif follow:
                        addressed = await asyncio.to_thread(link.classify_addressed, ut, self.gate_state["last_omni"])
                        why = "이어지는 대화" if addressed else "이어지는 대화 아님"
                    else:
                        addressed, why = False, "호출어 없음"
                    if addressed:
                        log(f"YOU ({why}): {ut}")
                        link.mailbox_push({"type": "transcript", "who": "you", "text": ut})
                        link.mem_append("conv", f"나(폰 안경): {ut}")
                        await ws.send(json.dumps({"type": "response.create"}))
                        if why == "호출어":
                            self.gate_cmd({"cmd": "adapt"})
                    else:
                        log(f"무시 ({why}): {ut}")
                        await self.set_status("LISTENING")
                        if item_id:
                            await ws.send(json.dumps({"type": "conversation.item.delete", "item_id": item_id}))
                    continue
                if ut:
                    log(f"YOU: {ut}")
                    link.mailbox_push({"type": "transcript", "who": "you", "text": ut})
            elif t == "response.function_call_arguments.done":
                name = ev.get("name", "")
                try:
                    fargs = json.loads(ev.get("arguments") or "{}")
                except ValueError:
                    fargs = {}
                log(f"TOOL: {name} {fargs}")
                await self.set_status("THINKING")
                out = await asyncio.to_thread(core.run_tool, name, fargs)
                await ws.send(json.dumps({"type": "conversation.item.create",
                                          "item": {"type": "function_call_output", "call_id": ev.get("call_id"), "output": out}}))
                await ws.send(json.dumps({"type": "response.create"}))
            elif t in ("response.output_audio.delta", "response.audio.delta"):
                await self.set_status("SPEAKING")
                if USE_GATE and not self.gate_state["muted"]:
                    self.gate_state["muted"] = True
                    self.gate_cmd({"cmd": "mute", "on": True})
                chunk = base64.b64decode(ev.get("delta", ""))
                await broadcast({"type": "audio", "pcm": base64.b64encode(chunk).decode(), "rate": 24000})
                S.speaking_until = max(S.speaking_until, time.time()) + len(chunk) / 2 / 24000
            elif t in ("response.output_audio_transcript.delta", "response.audio_transcript.delta"):
                self.omni_txt += ev.get("delta", "")
                if time.time() - self.last_cap > 0.35:
                    self.last_cap = time.time()
                    await self.caption(self.omni_txt)
            elif t in ("response.output_audio_transcript.done", "response.audio_transcript.done"):
                ft = (ev.get("transcript") or self.omni_txt).strip()
                self.gate_state["last_omni"] = ft
                if ft:
                    log(f"OMNI: {ft}")
                    link.mem_append("conv", f"옴니(폰 안경): {ft}")
                    link.mailbox_push({"type": "transcript", "who": "omni", "text": ft})
                await self.caption(ft)
                self.omni_txt = ""
            elif t == "response.done":
                S.speaking_until += 0.5
                await self.set_status("LISTENING")
                await broadcast({"type": "speaking", "on": False, "until": S.speaking_until})
                if USE_GATE:
                    async def unmute_after():
                        while time.time() < S.speaking_until:
                            await asyncio.sleep(0.1)
                        self.gate_state["muted"] = False
                        self.gate_state["last_done"] = time.time()
                        self.gate_cmd({"cmd": "mute", "on": False})
                    asyncio.ensure_future(unmute_after())
            elif t == "error":
                log(f"RT ERROR: {ev.get('error')}")


BRIDGE = Bridge()


async def ws_handler(conn):
    S.clients.add(conn)
    log(f"폰 접속 ({conn.remote_address[0] if conn.remote_address else '?'}) · 클라이언트 {len(S.clients)}")
    write_status()
    try:
        await conn.send(json.dumps({"type": "hello", "state": S.status, "gate": USE_GATE, "tools": core.TOOL_NAMES,
                                    "quiet": S.quiet}))
        await conn.send(json.dumps({"type": "hud", "png": base64.b64encode(S.canvas.png()).decode(), "v": S.canvas.version}))
        async for msg in conn:
            if isinstance(msg, (bytes, bytearray)):
                BRIDGE.mic_q.put_nowait(bytes(msg))
                continue
            try:
                ev = json.loads(msg)
            except ValueError:
                continue
            t = ev.get("type")
            if t == "tap":
                await BRIDGE.tap()
            elif t == "mic":
                S.mic_on = bool(ev.get("on"))
                log(f"폰 마이크 {'ON' if S.mic_on else 'OFF'}")
            elif t == "frame":
                try:
                    jpeg = base64.b64decode(ev.get("jpeg") or "")
                except ValueError:
                    jpeg = b""
                for f in list(S.frame_waiters):
                    if not f.done():
                        f.set_result(jpeg)
            elif t == "ping":
                await conn.send(json.dumps({"type": "pong", "t": time.time()}))
    except websockets.ConnectionClosed:
        pass
    finally:
        S.clients.discard(conn)
        log(f"폰 접속 종료 · 클라이언트 {len(S.clients)}")
        write_status()


async def status_loop():
    while True:
        q = core.quiet_active()
        if q != S.quiet:
            S.quiet = q
            log("학교 모드 ON — 폰 마이크 입력 무시" if q else "학교 모드 해제")
            await broadcast({"type": "quiet", "on": q})
            if q:
                S.canvas.apply(banner_packet("학교 모드 · 듣지 않음"))
            else:
                S.canvas.apply(banner_packet(""))
            await push_hud()
        write_status()
        await asyncio.sleep(3)


async def main():
    ip = S.ip
    ssl_ctx = None
    if USE_TLS:
        crt, key = ensure_certs(ip)
        ssl_ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ssl_ctx.load_cert_chain(crt, key)
    write_status()
    log(f"폰 안경 서버 {S.url}  (폰에서 열기 · CA 설치: {S.url}ca.crt)")
    async with serve(ws_handler, "0.0.0.0", PORT, ssl=ssl_ctx, process_request=process_request,
                     max_size=8 * 1024 * 1024, ping_interval=20, ping_timeout=20):
        await asyncio.gather(
            BRIDGE.run(), BRIDGE.mic_pump(), BRIDGE.gate_events() if USE_GATE else asyncio.sleep(0),
            core.notif_watch(BRIDGE.show_banner, lambda: True), status_loop())


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
    finally:
        try:
            d = S.status_doc()
            d["running"] = False
            os.makedirs(os.path.dirname(STATUS_PATH), exist_ok=True)
            json.dump(d, open(STATUS_PATH, "w"), ensure_ascii=False)
        except OSError:
            pass
