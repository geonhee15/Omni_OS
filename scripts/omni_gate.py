#!/usr/bin/env python3
"""옴니 음성 게이트 사이드카 — "내가 옴니에게 말할 때만" 1·2단계.

마이크를 직접 열고, 사람 말(VAD)만 잘라, 등록된 사용자 목소리인지
(화자 임베딩 코사인 유사도) 확인해서 통과한 발화만 24kHz PCM으로 내보낸다.
유튜브·TV·타인의 목소리는 여기서 떨어진다. (3단계 — 옴니에게 한 말인지 —
는 전사 텍스트를 보는 앱 JS가 판정한다: 호출어 + 대화 이어가기 창.)

I/O 규약 (앱 네이티브가 NSTask로 띄운다):
  stdout  JSON 한 줄씩:
    {"ev":"ready","profile":bool,"threshold":f}
    {"ev":"speech_start"}
    {"ev":"segment","user":bool,"sim":f,"dur":f,"pcm24":"<b64 PCM16 24k>"}  (pcm24는 user일 때만)
    {"ev":"enroll","progress":f,"segments":n}   {"ev":"enrolled",...}   {"ev":"enroll_failed",...}
    {"ev":"log","text":...}
  stdin   JSON 한 줄씩:
    {"cmd":"mute","on":bool}      옴니가 말하는 동안 마이크 무시(에코)
    {"cmd":"enroll","seconds":n}  사용자 목소리 등록 시작
    {"cmd":"threshold","value":f}
    {"cmd":"quit"}

테스트용:  omni_gate.py enroll-files a.wav b.wav ...   /   omni_gate.py test-file x.wav
"""
import base64
import json
import os
import queue
import sys
import threading
import time
import warnings

import numpy as np

warnings.filterwarnings("ignore")

SR = 16000
WIN = 512                       # silero VAD 프레임 (32ms @16k)
PROFILE = os.path.expanduser("~/.omni/voice_profile.json")
DEFAULT_THRESHOLD = 0.76
MIN_SEG = 0.4                   # 이보다 짧으면 판정 불가 → 버림
MIN_ENROLL_SEG = 0.7
MAX_SEG = 12.0
PRE_ROLL = 0.25


def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def resample_24k(x16: np.ndarray) -> np.ndarray:
    n = int(len(x16) * 24000 / SR)
    idx = np.linspace(0, len(x16) - 1, n)
    return np.interp(idx, np.arange(len(x16)), x16).astype(np.float32)


class Gate:
    def __init__(self, threshold=None):
        import torch
        from silero_vad import load_silero_vad, VADIterator
        from resemblyzer import VoiceEncoder
        torch.set_num_threads(2)
        self.vad_model = load_silero_vad()
        self.vad = VADIterator(self.vad_model, threshold=0.5, sampling_rate=SR,
                               min_silence_duration_ms=450, speech_pad_ms=100)
        self.encoder = VoiceEncoder("cpu", verbose=False)
        self.ref = None
        self.threshold = DEFAULT_THRESHOLD
        self.load_profile()
        if threshold is not None:
            self.threshold = float(threshold)
        self.muted = False
        self.in_speech = False
        self.seg = []
        self.pre = []                       # 프리롤 링버퍼 (청크 단위)
        self.pre_n = int(PRE_ROLL * SR / WIN) + 1
        self.enroll_until = 0.0
        self.enroll_embs = []
        self.enroll_target = 0
        self.last_user_emb = None       # 마지막으로 통과한 발화 임베딩 (적응용)

    # ---------------- 프로필
    def load_profile(self):
        try:
            with open(PROFILE) as f:
                p = json.load(f)
            self.ref = np.asarray(p["emb"], dtype=np.float32)
            self.ref /= np.linalg.norm(self.ref) + 1e-9
            self.threshold = float(p.get("threshold", DEFAULT_THRESHOLD))
        except (OSError, ValueError, KeyError):
            self.ref = None

    def save_profile(self, embs):
        ref = np.mean(embs, axis=0)
        ref /= np.linalg.norm(ref) + 1e-9
        sims = [float(np.dot(ref, e / (np.linalg.norm(e) + 1e-9))) for e in embs]
        mean_self = float(np.mean(sims))
        # 자기 유사도에서 여유를 둔 임계 (0.70~0.78). 마이크 거리·자세에 따라
        # 같은 사람도 0.1 가까이 흔들리므로 넉넉히 — 타인 배제는 호출어
        # 게이트가 함께 맡고, 호출어로 확정된 발화로 프로필이 계속 적응한다.
        thr = max(0.70, min(0.78, mean_self - 0.15))
        os.makedirs(os.path.dirname(PROFILE), exist_ok=True)
        with open(PROFILE, "w") as f:
            json.dump({"emb": ref.tolist(), "threshold": thr, "self_sim": mean_self,
                       "segments": len(embs), "created": time.time()}, f)
        os.chmod(PROFILE, 0o600)
        self.ref = ref
        self.threshold = thr
        return mean_self, thr

    # ---------------- 임베딩
    def embed(self, pcm: np.ndarray):
        from resemblyzer import preprocess_wav
        wav = preprocess_wav(pcm.astype(np.float32), source_sr=SR)
        if len(wav) < int(0.3 * SR):
            return None
        return self.encoder.embed_utterance(wav)

    def verify(self, pcm: np.ndarray):
        if self.ref is None:
            return None
        e = self.embed(pcm)
        if e is None:
            return None
        self._last_emb = e
        return float(np.dot(self.ref, e / (np.linalg.norm(e) + 1e-9)))

    def adapt(self):
        """호출어까지 확인된 발화(= 사용자 본인 확실)로 프로필을 점진 갱신."""
        e = getattr(self, "_last_emb", None)
        if e is None or self.ref is None:
            return
        e = e / (np.linalg.norm(e) + 1e-9)
        self.ref = self.ref * 0.9 + e * 0.1
        self.ref /= np.linalg.norm(self.ref) + 1e-9
        try:
            with open(PROFILE) as f:
                p = json.load(f)
        except (OSError, ValueError):
            p = {}
        p["emb"] = self.ref.tolist()
        p["threshold"] = self.threshold
        p["adapted"] = int(p.get("adapted", 0)) + 1
        with open(PROFILE, "w") as f:
            json.dump(p, f)
        emit({"ev": "log", "text": f"profile adapted x{p['adapted']}"})

    # ---------------- 오디오 스트림
    def on_chunk(self, chunk: np.ndarray, now: float):
        """512샘플 float32 청크 하나 처리."""
        import torch
        if self.muted:
            if self.in_speech:
                self.in_speech = False
                self.seg = []
            self.vad.reset_states()
            return
        self.pre.append(chunk)
        if len(self.pre) > self.pre_n:
            self.pre.pop(0)
        r = self.vad(torch.from_numpy(chunk), return_seconds=False)
        if r and "start" in r and not self.in_speech:
            self.in_speech = True
            self.seg = list(self.pre)
            emit({"ev": "speech_start"})
        elif self.in_speech:
            self.seg.append(chunk)
        if self.in_speech and (r and "end" in r
                               or len(self.seg) * WIN / SR > MAX_SEG):
            self.finish(now)
        if self.enroll_until and now > self.enroll_until:
            self.finish_enroll()

    def finish(self, now):
        pcm = np.concatenate(self.seg) if self.seg else np.zeros(0, np.float32)
        self.seg = []
        self.in_speech = False
        dur = len(pcm) / SR
        if self.enroll_until:
            if dur >= MIN_ENROLL_SEG:
                e = self.embed(pcm)
                if e is not None:
                    self.enroll_embs.append(e)
            emit({"ev": "enroll", "progress": min(1.0, 1 - (self.enroll_until - now) / self.enroll_target),
                  "segments": len(self.enroll_embs)})
            return
        if dur < MIN_SEG:
            emit({"ev": "segment", "user": False, "sim": None, "dur": round(dur, 2), "why": "short"})
            return
        sim = self.verify(pcm)
        if sim is None:
            user = self.ref is None      # 프로필 없으면 통과(등록 전 폴백) — JS가 안내
            why = "no_profile" if self.ref is None else "unverifiable"
        else:
            user = sim >= self.threshold
            why = ""
        out = {"ev": "segment", "user": bool(user), "sim": None if sim is None else round(sim, 3),
               "dur": round(dur, 2)}
        if why:
            out["why"] = why
        if user:
            pcm24 = np.clip(resample_24k(pcm), -1, 1)
            out["pcm24"] = base64.b64encode((pcm24 * 32767).astype("<i2").tobytes()).decode()
        emit(out)

    # ---------------- 등록
    def start_enroll(self, seconds):
        self.enroll_target = float(seconds)
        self.enroll_until = time.monotonic() + float(seconds)
        self.enroll_embs = []
        emit({"ev": "enroll", "progress": 0.0, "segments": 0})

    def finish_enroll(self):
        self.enroll_until = 0.0
        if len(self.enroll_embs) < 3:
            emit({"ev": "enroll_failed", "segments": len(self.enroll_embs),
                  "text": "말소리가 충분하지 않습니다 — 15초 동안 여러 문장을 또렷하게 말해 주세요"})
            return
        mean_self, thr = self.save_profile(self.enroll_embs)
        emit({"ev": "enrolled", "segments": len(self.enroll_embs),
              "self_sim": round(mean_self, 3), "threshold": round(thr, 3)})


# ---------------------------------------------------------------- 실행 모드

def feed_wav(gate: Gate, path: str, t0: float = 0.0):
    import wave
    with wave.open(path) as w:
        assert w.getframerate() == SR and w.getnchannels() == 1, "16k mono wav 필요"
        x = np.frombuffer(w.readframes(w.getnframes()), dtype="<i2").astype(np.float32) / 32768
    x = np.concatenate([x, np.zeros(SR, np.float32)])          # 꼬리 무음으로 세그먼트 종료
    t = t0
    for i in range(0, len(x) - WIN + 1, WIN):
        gate.on_chunk(x[i:i + WIN].copy(), t)
        t += WIN / SR
    return t


def handle_cmd(gate: Gate, c: dict):
    cmd = c.get("cmd")
    if cmd == "mute":
        gate.muted = bool(c.get("on"))
    elif cmd == "enroll":
        gate.start_enroll(c.get("seconds", 15))
    elif cmd == "adapt":
        gate.adapt()
    elif cmd == "threshold":
        gate.threshold = float(c.get("value", gate.threshold))
        emit({"ev": "log", "text": f"threshold={gate.threshold:.2f}"})
    elif cmd == "quit":
        os._exit(0)


def run_mic(threshold=None):
    import sounddevice as sd
    gate = Gate(threshold)
    emit({"ev": "ready", "profile": gate.ref is not None, "threshold": round(gate.threshold, 3)})
    q: "queue.Queue[np.ndarray]" = queue.Queue()

    def cb(indata, frames, t_info, status):
        q.put(indata[:, 0].copy())

    def stdin_loop():
        for line in sys.stdin:
            try:
                handle_cmd(gate, json.loads(line))
            except ValueError:
                continue

    threading.Thread(target=stdin_loop, daemon=True).start()
    with sd.InputStream(samplerate=SR, blocksize=WIN, channels=1, dtype="float32", callback=cb):
        while True:
            chunk = q.get()
            gate.on_chunk(chunk, time.monotonic())


def run_pipe(threshold=None):
    """외부 스트림 모드 (안경 BLE 등): stdin 프레임 = <u32 길이><페이로드>.
    페이로드가 '{'로 시작하면 JSON 명령, 아니면 PCM16 16kHz 모노."""
    import struct
    gate = Gate(threshold)
    emit({"ev": "ready", "profile": gate.ref is not None, "threshold": round(gate.threshold, 3)})
    stdin = sys.stdin.buffer
    buf = np.zeros(0, np.float32)
    while True:
        hdr = stdin.read(4)
        if len(hdr) < 4:
            return
        (n,) = struct.unpack("<I", hdr)
        data = stdin.read(n)
        if len(data) < n:
            return
        if data[:1] == b"{":
            try:
                handle_cmd(gate, json.loads(data))
            except ValueError:
                pass
            continue
        pcm = np.frombuffer(data, dtype="<i2").astype(np.float32) / 32768
        buf = np.concatenate([buf, pcm])
        while len(buf) >= WIN:
            gate.on_chunk(buf[:WIN].copy(), time.monotonic())
            buf = buf[WIN:]


def main():
    args = sys.argv[1:]
    mode = args[0] if args else "run"
    if mode == "run":
        thr = float(args[1]) if len(args) > 1 else None
        run_mic(thr)
    elif mode == "pipe":
        run_pipe(float(args[1]) if len(args) > 1 else None)
    elif mode == "enroll-files":
        gate = Gate()
        gate.enroll_target = 1e9
        gate.enroll_until = 1e12       # finish()가 등록 경로를 타게
        for p in args[1:]:
            feed_wav(gate, p)
        gate.enroll_until = 1.0        # 강제 종료 경로
        gate.finish_enroll()
    elif mode == "test-file":
        gate = Gate(float(args[2]) if len(args) > 2 else None)
        emit({"ev": "ready", "profile": gate.ref is not None, "threshold": round(gate.threshold, 3)})
        feed_wav(gate, args[1])
    else:
        print(__doc__)


if __name__ == "__main__":
    main()
