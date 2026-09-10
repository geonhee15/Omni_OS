#!/usr/bin/env python3
"""CAMERA 패널 사이드카 — 집 카메라(Tapo C210 등)를 클라우드 없이 맥에서 직접 본다.

halo/venv 로 실행 (PIL·numpy·mediapipe·omni_link 공유). 앱의 cam.start 가 띄운다.
  http://127.0.0.1:8484/status.json          카메라 목록·상태·최근 사건
  /live.mjpg?cam=이름                          라이브(MJPEG, ffmpeg가 RTSP→JPEG 8fps 640px)
  /snap.jpg?cam=이름                           스냅샷 한 장
  /describe?cam=이름&q=질문                     스냅샷을 Haiku 비전으로 설명 (옴니 "카메라 봐줘")
  /discover?deep=0|1                          같은 /24에서 RTSP(554)+ONVIF(2020) 열린 기기 찾기 (deep=1: Tapo 계정으로 모델명까지)
  POST /setup {username,password}             카메라 계정(Tapo 앱 > 카메라 > 고급 설정 > 카메라 계정)
  POST /add {host,name} /remove {name} /rename {name,new} /watch {name,on}
  POST /ptz {name,dir,step} /privacy {name,on}  (python-kasa, smart_engine/venv, Tapo 클라우드 계정 필요)
감시: watch=on 카메라는 0.7초마다 사람 감지(MediaPipe EfficientDet) → 사건을 ~/.omni/store/camera_events.json,
스냅샷을 ~/.omni/camera/, 옴니 기억(observe)에 남긴다. 앱이 새 사건을 보면 말로 알린다.
"""
import base64
import io
import json
import os
import socket
import subprocess
import sys
import threading
import time
import urllib.parse
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from queue import Empty, Full, Queue

import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(REPO, "halo"))
import omni_link as link  # noqa: E402

PORT = int(next((sys.argv[i + 1] for i, a in enumerate(sys.argv) if a == "--port" and i + 1 < len(sys.argv)), 8484))
CFG_PATH = os.path.expanduser("~/.omni/camera.json")
EVENTS_PATH = os.path.expanduser("~/.omni/store/camera_events.json")
STATUS_PATH = os.path.expanduser("~/.omni/store/camera_status.json")
SNAP_DIR = os.path.expanduser("~/.omni/camera")
SMART_PY = os.path.join(REPO, "smart_engine/venv/bin/python")
SMART_SCRIPT = os.path.join(REPO, "scripts/omni_smart.py")
SMART_CACHE = os.path.expanduser("~/.omni/smart_devices.json")
DET_MODEL = os.path.join(REPO, "halo/models/efficientdet_lite0.tflite")
FFMPEG = next((p for p in ("/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "ffmpeg") if os.path.exists(p) or p == "ffmpeg"), "ffmpeg")
EVENT_COOLDOWN = 60.0
LOG: list[str] = []


def log(msg: str):
    line = f"[{time.strftime('%H:%M:%S')}] {msg}"
    LOG.append(line)
    del LOG[:-60]
    print(line, flush=True)


def load_cfg() -> dict:
    try:
        return json.load(open(CFG_PATH))
    except (OSError, ValueError):
        return {"account": {}, "cameras": []}


def save_cfg(cfg: dict):
    os.makedirs(os.path.dirname(CFG_PATH), exist_ok=True)
    tmp = CFG_PATH + ".tmp"
    with open(tmp, "w") as f:
        json.dump(cfg, f, ensure_ascii=False, indent=1)
    os.replace(tmp, CFG_PATH)
    os.chmod(CFG_PATH, 0o600)


def load_events() -> list:
    try:
        return json.load(open(EVENTS_PATH))
    except (OSError, ValueError):
        return []


def save_events(events: list):
    os.makedirs(os.path.dirname(EVENTS_PATH), exist_ok=True)
    tmp = EVENTS_PATH + ".tmp"
    with open(tmp, "w") as f:
        json.dump(events[-40:], f, ensure_ascii=False)
    os.replace(tmp, EVENTS_PATH)


# ---------------------------------------------------------------- 사람 감지

class PersonDetector:
    def __init__(self):
        self.det = None
        try:
            import mediapipe as mp
            from mediapipe.tasks.python import BaseOptions, vision
            self.mp = mp
            opts = vision.ObjectDetectorOptions(
                base_options=BaseOptions(model_asset_path=DET_MODEL), running_mode=vision.RunningMode.IMAGE,
                score_threshold=0.45, category_allowlist=["person"], max_results=6)
            self.det = vision.ObjectDetector.create_from_options(opts)
            log("사람 감지기 준비 (EfficientDet-Lite0)")
        except Exception as e:  # noqa: BLE001
            log(f"[!] 사람 감지기 사용 불가: {e}")

    def count(self, jpeg: bytes) -> int:
        if self.det is None or not jpeg:
            return 0
        try:
            img = Image.open(io.BytesIO(jpeg)).convert("RGB")
            if img.width > 480:
                img = img.resize((480, int(img.height * 480 / img.width)), Image.BILINEAR)
            mimg = self.mp.Image(image_format=self.mp.ImageFormat.SRGB, data=np.asarray(img, dtype=np.uint8))
            return len(self.det.detect(mimg).detections)
        except Exception:  # noqa: BLE001
            return 0


# ---------------------------------------------------------------- 카메라 (ffmpeg RTSP → MJPEG)

class Camera:
    def __init__(self, entry: dict):
        self.name = entry.get("name") or entry.get("host")
        self.host = entry.get("host", "")
        self.watch = bool(entry.get("watch", True))
        self.stream_path = entry.get("stream", "stream2")     # stream2=SD(빠름) stream1=HD
        self.proc = None
        self.reader = None
        self.latest = b""
        self.latest_at = 0.0
        self.subs: list[Queue] = []
        self.lock = threading.Lock()
        self.online = False
        self.error = ""
        self.person_now = False
        self.person_hits = 0
        self.last_person_at = 0.0
        self.last_event_at = 0.0
        self.idle_since = time.time()
        self.started_at = 0.0
        self.frames = 0

    def rtsp_url(self, account: dict) -> str:
        u = urllib.parse.quote(account.get("username", ""), safe="")
        p = urllib.parse.quote(account.get("password", ""), safe="")
        return f"rtsp://{u}:{p}@{self.host}:554/{self.stream_path}"

    def running(self) -> bool:
        return self.proc is not None and self.proc.poll() is None

    def start(self, account: dict):
        with self.lock:
            if self.running():
                return
            url = self.rtsp_url(account)
            src = ["-rtsp_transport", "tcp", "-i", url]
            if self.host.startswith("lavfi:"):                # 개발용 가짜 카메라 (-re: 실시간 속도로)
                src = ["-re", "-f", "lavfi", "-i", self.host[6:]]
            cmd = [FFMPEG, "-hide_banner", "-loglevel", "error", "-nostdin", *src,
                   "-an", "-vf", "scale=640:-2", "-r", "8", "-f", "mjpeg", "-q:v", "6", "pipe:1"]
            try:
                self.proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=0)
            except OSError as e:
                self.error = f"ffmpeg 실행 실패: {e}"
                return
            self.started_at = time.time()
            self.error = ""
            self.reader = threading.Thread(target=self._read, daemon=True)
            self.reader.start()
            log(f"{self.name}: 스트림 시작 ({self.host})")

    def stop(self):
        with self.lock:
            if self.proc is not None:
                try:
                    self.proc.terminate()
                except OSError:
                    pass
                self.proc = None
                self.online = False
                log(f"{self.name}: 스트림 정지")

    def _read(self):
        proc = self.proc
        buf = bytearray()
        while proc is not None and proc.poll() is None:
            chunk = proc.stdout.read(65536)
            if not chunk:
                break
            buf += chunk
            while True:
                s = buf.find(b"\xff\xd8")
                e = buf.find(b"\xff\xd9", s + 2) if s >= 0 else -1
                if s < 0 or e < 0:
                    if len(buf) > 4_000_000:
                        del buf[:]
                    break
                frame = bytes(buf[s:e + 2])
                del buf[:e + 2]
                self.latest = frame
                self.latest_at = time.time()
                self.online = True
                self.frames += 1
                for q in list(self.subs):
                    try:
                        q.put_nowait(frame)
                    except Full:
                        try:
                            q.get_nowait()
                            q.put_nowait(frame)
                        except (Empty, Full):
                            pass
        err = b""
        try:
            err = proc.stderr.read() if proc is not None else b""
        except Exception:  # noqa: BLE001
            pass
        if self.proc is proc:
            self.online = False
            self.error = (err.decode(errors="replace").strip().splitlines() or ["스트림 종료"])[-1][:160]
            log(f"{self.name}: 스트림 끊김 — {self.error}")

    def subscribe(self) -> Queue:
        q: Queue = Queue(maxsize=4)
        self.subs.append(q)
        self.idle_since = 0.0
        return q

    def unsubscribe(self, q: Queue):
        if q in self.subs:
            self.subs.remove(q)
        if not self.subs:
            self.idle_since = time.time()

    def snapshot(self, account: dict, wait: float = 6.0) -> bytes:
        if time.time() - self.latest_at < 1.5 and self.latest:
            return self.latest
        self.start(account)
        t0 = time.time()
        while time.time() - t0 < wait:
            if time.time() - self.latest_at < 1.5 and self.latest:
                return self.latest
            time.sleep(0.1)
        return self.latest if self.latest else b""

    def info(self) -> dict:
        return {"name": self.name, "host": self.host, "watch": self.watch, "online": self.online,
                "streaming": self.running(), "error": self.error, "person": self.person_now,
                "last_person": self.last_person_at, "frames": self.frames,
                "age": round(time.time() - self.latest_at, 1) if self.latest_at else None}


# ---------------------------------------------------------------- 서버 상태

class Hub:
    def __init__(self):
        self.cfg = load_cfg()
        self.cams: dict[str, Camera] = {}
        for e in self.cfg.get("cameras", []):
            self.cams[e["name"]] = Camera(e)
        self.events = load_events()
        self.detector = PersonDetector()
        self.started = time.time()
        self.lock = threading.Lock()

    @property
    def account(self) -> dict:
        return self.cfg.get("account") or {}

    def persist(self):
        self.cfg["cameras"] = [{"name": c.name, "host": c.host, "watch": c.watch, "stream": c.stream_path}
                               for c in self.cams.values()]
        save_cfg(self.cfg)

    def get(self, name: str) -> "Camera | None":
        if not name:
            return next(iter(self.cams.values()), None)
        if name in self.cams:
            return self.cams[name]
        low = name.lower()
        for c in self.cams.values():
            if low in c.name.lower() or low == c.host:
                return c
        return None

    def status(self) -> dict:
        return {"running": True, "port": PORT, "creds": bool(self.account.get("username")),
                "username": self.account.get("username", ""), "detector": self.detector.det is not None,
                "cameras": [c.info() for c in self.cams.values()], "events": self.events[-12:],
                "log": LOG[-8:], "uptime": int(time.time() - self.started), "ts": time.time()}

    def write_status(self):
        try:
            os.makedirs(os.path.dirname(STATUS_PATH), exist_ok=True)
            tmp = STATUS_PATH + ".tmp"
            with open(tmp, "w") as f:
                json.dump(self.status(), f, ensure_ascii=False)
            os.replace(tmp, STATUS_PATH)
        except OSError:
            pass

    # ---- 감시 루프: 사람 감지 + 유휴 스트림 정리
    def watcher(self):
        while True:
            try:
                for cam in list(self.cams.values()):
                    if cam.watch and self.account.get("username") and not cam.running() and time.time() - cam.started_at > 8:
                        cam.start(self.account)
                    if not cam.watch and not cam.subs and cam.running() and cam.idle_since and time.time() - cam.idle_since > 30:
                        cam.stop()
                    if cam.watch and cam.latest and time.time() - cam.latest_at < 2.0:
                        n = self.detector.count(cam.latest)
                        if n > 0:
                            cam.person_hits += 1
                            cam.last_person_at = time.time()
                            cam.person_now = True
                            if cam.person_hits >= 2 and time.time() - cam.last_event_at > EVENT_COOLDOWN:
                                self.record_event(cam, n)
                        else:
                            cam.person_hits = 0
                            if time.time() - cam.last_person_at > 3:
                                cam.person_now = False
                self.write_status()
            except Exception as e:  # noqa: BLE001
                log(f"감시 루프 오류: {e}")
            time.sleep(0.7)

    def record_event(self, cam: Camera, n: int):
        cam.last_event_at = time.time()
        os.makedirs(SNAP_DIR, exist_ok=True)
        ts = time.strftime("%Y%m%d_%H%M%S")
        path = os.path.join(SNAP_DIR, f"{ts}_{cam.name}.jpg")
        try:
            with open(path, "wb") as f:
                f.write(cam.latest)
        except OSError:
            path = ""
        ev = {"ts": time.time(), "cam": cam.name, "count": n, "snapshot": path,
              "text": f"{cam.name}에 사람 {n}명 감지"}
        self.events.append(ev)
        save_events(self.events)
        link.mem_append("observe", f"카메라 {cam.name}: 사람 {n}명 감지", ["camera"], {"snapshot": path})
        log(ev["text"])

    # ---- 검색: RTSP+ONVIF 포트 열린 기기
    def discover(self, deep: bool = False) -> dict:
        ip = lan_ip()
        base = ip.rsplit(".", 1)[0]

        def probe(host):
            hits = []
            for port in (554, 2020):
                s = socket.socket()
                s.settimeout(0.4)
                try:
                    s.connect((host, port))
                    hits.append(port)
                except OSError:
                    pass
                finally:
                    s.close()
            return host, hits
        with ThreadPoolExecutor(64) as ex:
            found = [(h, p) for h, p in ex.map(probe, [f"{base}.{i}" for i in range(1, 255)]) if 554 in p]
        known = {}
        try:
            for host, e in json.load(open(SMART_CACHE)).items():
                if str(e.get("type", "")).lower() == "camera":
                    known[host] = e
        except (OSError, ValueError):
            pass
        if deep and os.path.exists(SMART_PY):
            try:
                out = subprocess.run([SMART_PY, SMART_SCRIPT, "discover"], capture_output=True, text=True, timeout=60, cwd=REPO).stdout
                for line in reversed(out.splitlines()):
                    if line.startswith("{"):
                        for d in json.loads(line).get("devices", []):
                            if str(d.get("type", "")).lower() == "camera":
                                known[d["host"]] = d
                        break
            except Exception as e:  # noqa: BLE001
                log(f"Tapo 계정 검색 실패: {e}")
        cands = []
        for host, ports in found:
            k = known.get(host, {})
            cands.append({"host": host, "ports": ports, "alias": k.get("alias", ""), "model": k.get("model", ""),
                          "added": any(c.host == host for c in self.cams.values())})
        # 새 후보는 자동 등록
        for c in cands:
            if not c["added"]:
                name = c["alias"] or f"카메라 {len(self.cams) + 1}"
                self.cams[name] = Camera({"name": name, "host": c["host"], "watch": True})
                c["added"] = True
                c["name"] = name
                log(f"카메라 등록: {name} ({c['host']})")
        self.persist()
        return {"ok": True, "candidates": cands, "hint": "" if cands else
                "RTSP(554)가 열린 기기가 없습니다 — 카메라가 같은 와이파이에 있고 Tapo 앱에서 카메라 계정을 만들었는지 확인"}

    # ---- PTZ / 프라이버시 (python-kasa, Tapo 클라우드 계정)
    def smart(self, args: dict) -> dict:
        if not os.path.exists(SMART_PY):
            return {"ok": False, "error": "NO_ENGINE"}
        try:
            p = subprocess.run([SMART_PY, SMART_SCRIPT, "camera", json.dumps(args)], capture_output=True, text=True, timeout=40, cwd=REPO)
            for line in reversed(p.stdout.splitlines()):
                if line.startswith("{"):
                    return json.loads(line)
            return {"ok": False, "error": "NO_OUTPUT", "hint": p.stderr[-200:]}
        except Exception as e:  # noqa: BLE001
            return {"ok": False, "error": str(e)[:120]}


def lan_ip() -> str:
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 53))
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


HUB = Hub()


# ---------------------------------------------------------------- HTTP

class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):   # 조용히
        pass

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def _json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(status)
        self._cors()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _bytes(self, data: bytes, ctype: str):
        self.send_response(200)
        self._cors()
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        q = {k: v[0] for k, v in urllib.parse.parse_qs(u.query).items()}
        if u.path == "/status.json":
            return self._json(HUB.status())
        if u.path == "/events.json":
            return self._json({"ok": True, "events": HUB.events[-40:]})
        if u.path == "/discover":
            return self._json(HUB.discover(deep=q.get("deep") == "1"))
        cam = HUB.get(q.get("cam", ""))
        if u.path in ("/snap.jpg", "/live.mjpg", "/describe") and cam is None:
            return self._json({"ok": False, "error": "NO_CAMERA", "hint": "등록된 카메라가 없습니다 — DISCOVER"}, 404)
        if u.path == "/snap.jpg":
            jpeg = cam.snapshot(HUB.account)
            if not jpeg:
                return self._json({"ok": False, "error": "NO_FRAME", "hint": cam.error or "영상을 아직 받지 못했습니다"}, 503)
            return self._bytes(jpeg, "image/jpeg")
        if u.path == "/describe":
            jpeg = cam.snapshot(HUB.account)
            if not jpeg:
                return self._json({"ok": False, "error": "NO_FRAME", "hint": cam.error or "영상을 아직 받지 못했습니다"}, 503)
            text = link.describe_image(jpeg, q.get("q") or f"{cam.name} 카메라 화면입니다. 지금 무엇이 보이는지 핵심만 2문장으로.")
            link.mem_append("observe", f"카메라 {cam.name}: {text[:300]}", ["camera"])
            return self._json({"ok": True, "cam": cam.name, "text": text, "person": cam.person_now})
        if u.path == "/live.mjpg":
            cam.start(HUB.account)
            sub = cam.subscribe()
            try:
                self.send_response(200)
                self._cors()
                self.send_header("Content-Type", "multipart/x-mixed-replace; boundary=omniframe")
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                deadline = time.time() + 8
                while True:
                    try:
                        frame = sub.get(timeout=1.0)
                    except Empty:
                        if time.time() > deadline and not cam.latest:
                            break
                        continue
                    self.wfile.write(b"--omniframe\r\nContent-Type: image/jpeg\r\nContent-Length: %d\r\n\r\n" % len(frame))
                    self.wfile.write(frame + b"\r\n")
                    self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError, OSError):
                pass
            finally:
                cam.unsubscribe(sub)
            return
        self._json({"ok": False, "error": "NOT_FOUND"}, 404)

    def do_POST(self):
        u = urllib.parse.urlparse(self.path)
        n = int(self.headers.get("Content-Length") or 0)
        try:
            body = json.loads(self.rfile.read(n) or b"{}")
        except ValueError:
            body = {}
        if u.path == "/setup":
            user, pw = str(body.get("username") or "").strip(), str(body.get("password") or "")
            if not user or not pw:
                return self._json({"ok": False, "error": "EMPTY"})
            HUB.cfg["account"] = {"username": user, "password": pw}
            HUB.persist()
            for c in HUB.cams.values():
                c.stop()
            log(f"카메라 계정 저장 ({user})")
            return self._json({"ok": True})
        if u.path == "/add":
            host, name = str(body.get("host") or "").strip(), str(body.get("name") or "").strip()
            if not host:
                return self._json({"ok": False, "error": "NO_HOST"})
            name = name or f"카메라 {len(HUB.cams) + 1}"
            HUB.cams[name] = Camera({"name": name, "host": host, "watch": True})
            HUB.persist()
            return self._json({"ok": True, "name": name})
        if u.path == "/remove":
            cam = HUB.get(str(body.get("name") or ""))
            if cam:
                cam.stop()
                HUB.cams.pop(cam.name, None)
                HUB.persist()
            return self._json({"ok": bool(cam)})
        if u.path == "/rename":
            cam = HUB.get(str(body.get("name") or ""))
            new = str(body.get("new") or "").strip()
            if cam and new:
                HUB.cams.pop(cam.name, None)
                cam.name = new
                HUB.cams[new] = cam
                HUB.persist()
            return self._json({"ok": bool(cam and new)})
        if u.path == "/watch":
            cam = HUB.get(str(body.get("name") or ""))
            if cam:
                cam.watch = bool(body.get("on"))
                HUB.persist()
            return self._json({"ok": bool(cam), "watch": cam.watch if cam else None})
        if u.path == "/ptz":
            cam = HUB.get(str(body.get("name") or ""))
            if not cam:
                return self._json({"ok": False, "error": "NO_CAMERA"})
            d, step = str(body.get("dir") or ""), int(body.get("step") or 15)
            pan = step if d == "right" else -step if d == "left" else 0
            tilt = step if d == "up" else -step if d == "down" else 0
            return self._json(HUB.smart({"target": cam.host, "action": "ptz", "pan": pan, "tilt": tilt}))
        if u.path == "/privacy":
            cam = HUB.get(str(body.get("name") or ""))
            if not cam:
                return self._json({"ok": False, "error": "NO_CAMERA"})
            return self._json(HUB.smart({"target": cam.host, "action": "privacy", "on": bool(body.get("on"))}))
        self._json({"ok": False, "error": "NOT_FOUND"}, 404)


def main():
    os.makedirs(SNAP_DIR, exist_ok=True)
    threading.Thread(target=HUB.watcher, daemon=True).start()
    HUB.write_status()
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    srv.daemon_threads = True
    log(f"카메라 서버 http://127.0.0.1:{PORT}  카메라 {len(HUB.cams)}대 · 계정 {'있음' if HUB.account.get('username') else '없음'}")
    try:
        srv.serve_forever()
    finally:
        for c in HUB.cams.values():
            c.stop()
        try:
            st = HUB.status()
            st["running"] = False
            json.dump(st, open(STATUS_PATH, "w"), ensure_ascii=False)
        except OSError:
            pass


if __name__ == "__main__":
    main()
