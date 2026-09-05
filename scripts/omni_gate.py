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
PROFILE = os.path.expanduser("~/.omni/voice_profile.json")   # 구버전 (이전용)
VOICE_DIR = os.path.expanduser("~/.omni/voice")
STORE = os.path.join(VOICE_DIR, "profiles.json")
DEFAULT_THRESHOLD = 0.76
MAYBE_MARGIN = 0.08             # 임계 바로 아래 구간 — 버리지 않고 호출어/분류기 게이트에 맡김
MAX_PROFILE_EMBS = 40           # 프로필당 임베딩 집합 상한 (등록 누적 + 적응)
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
        self.ref_set = []
        self.neg_sets = {}
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
        self.enroll_secs = 0.0
        self._enroll_tick = 0.0
        self.enroll_kind = "user"
        self.enroll_name = None
        self.last_user_emb = None       # 마지막으로 통과한 발화 임베딩 (적응용)

    # ---------------- 프로필 저장소 (~/.omni/voice/profiles.json)
    #
    # {"active": "me", "profiles": {이름: {"kind": "user"|"other", "embs": [...],
    #   "secs": 누적 발화초, "sessions": 등록 횟수, "threshold": (user만), ...}}}
    # user 프로필은 골라 쓰고(active) ENROLL마다 덧붙인다. other 프로필(타인 목소리)은
    # 전부 부정 예시로 쓰여 "나보다 타인에 더 가까운" 발화를 거부하고 임계를 보정한다.

    def load_profile(self):
        self.store = {"active": None, "profiles": {}}
        try:
            with open(STORE) as f:
                self.store = json.load(f)
        except (OSError, ValueError):
            # 구버전 단일 프로필 이전
            try:
                with open(PROFILE) as f:
                    old = json.load(f)
                embs = old.get("embs") or [old["emb"]]
                self.store = {"active": "me", "profiles": {"me": {
                    "kind": "user", "embs": embs, "secs": 0.0,
                    "sessions": int(old.get("segments", 0) > 0),
                    "threshold": float(old.get("threshold", DEFAULT_THRESHOLD)),
                    "created": old.get("created", time.time()), "updated": time.time()}}}
                self._save_store()
            except (OSError, ValueError, KeyError):
                pass
        self._rebuild_sets()

    def _save_store(self):
        os.makedirs(VOICE_DIR, exist_ok=True)
        tmp = STORE + ".tmp"
        with open(tmp, "w") as f:
            json.dump(self.store, f)
        os.replace(tmp, STORE)
        os.chmod(STORE, 0o600)

    @staticmethod
    def _unit(e):
        e = np.asarray(e, dtype=np.float32)
        return e / (np.linalg.norm(e) + 1e-9)

    def _rebuild_sets(self):
        """active user 집합 + 모든 other 집합을 메모리에 준비."""
        profs = self.store.get("profiles", {})
        name = self.store.get("active")
        prof = profs.get(name) if name else None
        if prof and prof.get("kind") == "user" and prof.get("embs"):
            self.ref_set = [self._unit(e) for e in prof["embs"]]
            self.ref = self._unit(np.mean(self.ref_set, axis=0))
            self.threshold = float(prof.get("threshold", DEFAULT_THRESHOLD))
        else:
            self.ref_set, self.ref = [], None
            self.threshold = DEFAULT_THRESHOLD
        self.neg_sets = {n: [self._unit(e) for e in p.get("embs", [])]
                         for n, p in profs.items() if p.get("kind") == "other" and p.get("embs")}

    def profiles_event(self):
        profs = self.store.get("profiles", {})
        return {"ev": "profiles", "active": self.store.get("active"),
                "list": [{"name": n, "kind": p.get("kind"), "embs": len(p.get("embs", [])),
                          "secs": round(float(p.get("secs", 0)), 1),
                          "sessions": int(p.get("sessions", 0)),
                          "threshold": p.get("threshold")} for n, p in profs.items()]}

    def select_profile(self, name):
        if name in self.store.get("profiles", {}) and self.store["profiles"][name].get("kind") == "user":
            self.store["active"] = name
            self._save_store()
        self._rebuild_sets()
        emit(self.profiles_event())

    def new_profile(self, name, kind="user"):
        name = (name or "").strip()[:32] or ("me" if kind == "user" else "other")
        profs = self.store.setdefault("profiles", {})
        if name not in profs:
            profs[name] = {"kind": kind, "embs": [], "secs": 0.0, "sessions": 0,
                           "created": time.time(), "updated": time.time()}
        if kind == "user":
            self.store["active"] = name
        self._save_store()
        self._rebuild_sets()
        emit(self.profiles_event())
        return name

    def delete_profile(self, name):
        profs = self.store.get("profiles", {})
        if name in profs:
            del profs[name]
            if self.store.get("active") == name:
                users = [n for n, p in profs.items() if p.get("kind") == "user"]
                self.store["active"] = users[0] if users else None
            self._save_store()
        self._rebuild_sets()
        emit(self.profiles_event())

    # ---------------- 보정·분석
    def calibrate(self):
        """active user 프로필의 자기 유사도(leave-one-out)와 타인 최대 유사도로
        임계를 정하고 구분 여유를 리포트한다."""
        units = self.ref_set
        if len(units) < 2:
            return None
        loo = []
        for i, e in enumerate(units):
            others = units[:i] + units[i + 1:]
            loo.append(max(float(np.dot(e, o)) for o in others))
        mean_self, min_self = float(np.mean(loo)), float(np.min(loo))
        per_neg = {}
        for label, negs in self.neg_sets.items():
            per_neg[label] = max(max(float(np.dot(n, u)) for u in units) for n in negs)
        max_neg = max(per_neg.values()) if per_neg else None
        if max_neg is None:
            thr = max(0.68, min(0.76, mean_self - 0.15))
            margin = None
        else:
            thr = max(0.62, min(0.80, max(max_neg + 0.04, (mean_self + max_neg) / 2)))
            margin = mean_self - max_neg
        verdict = ("타인 미등록" if margin is None else
                   "명확" if margin >= 0.15 else "보통" if margin >= 0.08 else "약함")
        self.threshold = thr
        prof = self.store["profiles"][self.store["active"]]
        prof["threshold"] = thr
        prof["updated"] = time.time()
        self._save_store()
        report = {"ev": "analysis", "name": self.store["active"], "embs": len(units),
                  "sessions": int(prof.get("sessions", 0)), "secs": round(float(prof.get("secs", 0)), 1),
                  "self_mean": round(mean_self, 3), "self_min": round(min_self, 3),
                  "neg": {k: round(v, 3) for k, v in per_neg.items()},
                  "neg_max": None if max_neg is None else round(max_neg, 3),
                  "margin": None if margin is None else round(margin, 3),
                  "threshold": round(thr, 3), "verdict": verdict}
        emit(report)
        return report

    # ---------------- 임베딩
    def embed(self, pcm: np.ndarray):
        from resemblyzer import preprocess_wav
        wav = preprocess_wav(pcm.astype(np.float32), source_sr=SR)
        if len(wav) < int(0.3 * SR):
            return None
        return self.encoder.embed_utterance(wav)

    def verify(self, pcm: np.ndarray):
        """(내 집합 최대 유사도, 타인 집합 최대 유사도, 가장 가까운 타인 라벨)."""
        if self.ref is None:
            return None, None, None
        e = self.embed(pcm)
        if e is None:
            return None, None, None
        u = self._unit(e)
        self._last_emb = u
        best = float(np.dot(self.ref, u))
        for r in self.ref_set:
            best = max(best, float(np.dot(r, u)))
        neg, label = None, None
        for lab, negs in self.neg_sets.items():
            m = max(float(np.dot(n, u)) for n in negs)
            if neg is None or m > neg:
                neg, label = m, lab
        return best, neg, label

    def adapt(self):
        """호출어까지 확인된 발화(= 사용자 본인 확실)로 active 집합을 넓힌다.
        단, 등록된 타인 목소리에 더 가까운 발화는 넣지 않는다(오염 방지)."""
        u = getattr(self, "_last_emb", None)
        if u is None or self.ref is None or not self.store.get("active"):
            return
        if self.ref_set and max(float(np.dot(r, u)) for r in self.ref_set) > 0.95:
            return
        for negs in self.neg_sets.values():
            if max(float(np.dot(n, u)) for n in negs) > max(float(np.dot(r, u)) for r in self.ref_set):
                emit({"ev": "log", "text": "adapt skipped: closer to a known other voice"})
                return
        prof = self.store["profiles"][self.store["active"]]
        prof["embs"].append(u.tolist())
        if len(prof["embs"]) > MAX_PROFILE_EMBS:
            prof["embs"].pop(0)
        prof["adapted"] = int(prof.get("adapted", 0)) + 1
        prof["updated"] = time.time()
        self._save_store()
        self._rebuild_sets()
        emit({"ev": "log", "text": f"profile adapted x{prof['adapted']} (set={len(self.ref_set)})"})

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
            if self.in_speech:
                self.finish(now)        # 마감 시점에 말하던 발화도 반영
            self.finish_enroll()
        elif self.enroll_until and now - self._enroll_tick > 1.0:
            self._enroll_tick = now
            emit({"ev": "enroll", "progress": min(1.0, 1 - (self.enroll_until - now) / self.enroll_target),
                  "segments": len(self.enroll_embs), "secs": round(self.enroll_secs, 1)})

    def finish(self, now):
        pcm = np.concatenate(self.seg) if self.seg else np.zeros(0, np.float32)
        self.seg = []
        self.in_speech = False
        dur = len(pcm) / SR
        if self.enroll_until:
            # 쉬지 않고 말하면 세그먼트가 하나로 이어지므로 2초 창으로 쪼개 임베딩
            step = int(2.0 * SR)
            for i in range(0, len(pcm), step):
                part = pcm[i:i + step]
                if len(part) / SR >= MIN_ENROLL_SEG:
                    e = self.embed(part)
                    if e is not None:
                        self.enroll_embs.append(e)
                        self.enroll_secs += len(part) / SR
            emit({"ev": "enroll", "progress": min(1.0, 1 - (self.enroll_until - now) / self.enroll_target),
                  "segments": len(self.enroll_embs), "secs": round(self.enroll_secs, 1)})
            return
        if dur < MIN_SEG:
            emit({"ev": "segment", "user": False, "sim": None, "dur": round(dur, 2), "why": "short"})
            return
        sim, neg, neg_label = self.verify(pcm)
        if sim is None:
            user = self.ref is None      # 프로필 없으면 통과(등록 전 폴백) — JS가 안내
            band = "user" if user else "other"
            why = "no_profile" if self.ref is None else "unverifiable"
        elif neg is not None and neg >= 0.5 and neg >= sim - 0.02:
            band, user, why = "other", False, f"closer_to:{neg_label}"   # 타인 집합에 더 가까움
        else:
            band = ("user" if sim >= self.threshold
                    else "maybe" if sim >= self.threshold - MAYBE_MARGIN else "other")
            user = band != "other"       # maybe도 전달 — 호출어/분류기가 최종 판정
            why = ""
        out = {"ev": "segment", "user": bool(user), "band": band,
               "sim": None if sim is None else round(sim, 3),
               "neg": None if neg is None else round(neg, 3), "neg_label": neg_label,
               "thr": round(self.threshold, 3), "dur": round(dur, 2)}
        if why:
            out["why"] = why
        if user:
            pcm24 = np.clip(resample_24k(pcm), -1, 1)
            out["pcm24"] = base64.b64encode((pcm24 * 32767).astype("<i2").tobytes()).decode()
        emit(out)

    # ---------------- 등록
    def start_enroll(self, seconds, kind="user", name=None):
        self.enroll_kind = "other" if kind == "other" else "user"
        if self.enroll_kind == "user":
            name = name or self.store.get("active") or "me"
            if name not in self.store.get("profiles", {}):
                self.new_profile(name, "user")
            elif self.store.get("active") != name:
                self.select_profile(name)
        else:
            name = self.new_profile(name or "other", "other")
        self.enroll_name = name
        self.enroll_target = float(seconds)
        self.enroll_until = time.monotonic() + float(seconds)
        self.enroll_embs = []
        self.enroll_secs = 0.0
        self._enroll_tick = time.monotonic()
        self.muted = False
        emit({"ev": "enroll", "progress": 0.0, "segments": 0, "secs": 0})

    def finish_enroll(self):
        self.enroll_until = 0.0
        if len(self.enroll_embs) < 3 and self.enroll_secs < 4.0:
            emit({"ev": "enroll_failed", "segments": len(self.enroll_embs),
                  "secs": round(self.enroll_secs, 1),
                  "text": f"말소리가 충분하지 않습니다 (인식된 발화 {self.enroll_secs:.1f}초) — 마이크 가까이에서 15초 동안 또렷하게 말해 주세요"})
            return
        prof = self.store["profiles"][self.enroll_name]
        units = [self._unit(e) for e in self.enroll_embs]
        warn = ""
        if self.enroll_kind == "other" and self.ref is not None:
            # 타인 등록인데 내 목소리와 아주 닮았으면 경고 (잘못 등록 방지)
            close = max(max(float(np.dot(u, r)) for r in self.ref_set) for u in units)
            if close >= self.threshold:
                warn = f"주의: 이 목소리는 내 프로필과 {close:.2f}로 매우 닮았습니다 — 정말 다른 사람인지 확인"
        prof["embs"].extend(u.tolist() for u in units)
        if len(prof["embs"]) > MAX_PROFILE_EMBS:
            prof["embs"] = prof["embs"][-MAX_PROFILE_EMBS:]
        prof["secs"] = float(prof.get("secs", 0)) + self.enroll_secs
        prof["sessions"] = int(prof.get("sessions", 0)) + 1
        prof["updated"] = time.time()
        self._save_store()
        self._rebuild_sets()
        report = self.calibrate() if self.ref is not None else None
        emit({"ev": "enrolled", "name": self.enroll_name, "kind": self.enroll_kind,
              "added": len(units), "total": len(prof["embs"]),
              "secs": round(float(prof["secs"]), 1), "sessions": prof["sessions"],
              "threshold": round(self.threshold, 3), "warn": warn,
              "verdict": report["verdict"] if report else None})
        emit(self.profiles_event())


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
        gate.start_enroll(c.get("seconds", 15), c.get("kind", "user"), c.get("name"))
    elif cmd == "profiles":
        emit(gate.profiles_event())
    elif cmd == "select":
        gate.select_profile(c.get("name"))
    elif cmd == "new":
        gate.new_profile(c.get("name"), c.get("kind", "user"))
    elif cmd == "delete":
        gate.delete_profile(c.get("name"))
    elif cmd == "analyze":
        if gate.ref is not None:
            gate.calibrate()
        else:
            emit({"ev": "analysis", "name": None, "verdict": "프로필 없음"})
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
    emit({"ev": "ready", "profile": gate.ref is not None, "threshold": round(gate.threshold, 3),
          "active": gate.store.get("active"), "negatives": list(gate.neg_sets.keys())})
    emit(gate.profiles_event())
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
    emit({"ev": "ready", "profile": gate.ref is not None, "threshold": round(gate.threshold, 3),
          "active": gate.store.get("active"), "negatives": list(gate.neg_sets.keys())})
    emit(gate.profiles_event())
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
    elif mode in ("enroll-files", "enroll-other-files"):
        # enroll-files <이름> a.wav ...  /  enroll-other-files <라벨> a.wav ...
        gate = Gate()
        kind = "other" if mode == "enroll-other-files" else "user"
        gate.start_enroll(1e9, kind, args[1])
        gate.enroll_until = 1e12       # finish()가 등록 경로를 타게
        for p in args[2:]:
            feed_wav(gate, p)
        gate.enroll_until = 1.0        # 강제 종료 경로
        gate.finish_enroll()
    elif mode == "test-file":
        gate = Gate(float(args[2]) if len(args) > 2 else None)
        emit({"ev": "ready", "profile": gate.ref is not None, "threshold": round(gate.threshold, 3),
              "active": gate.store.get("active"), "negatives": list(gate.neg_sets.keys())})
        feed_wav(gate, args[1])
    else:
        print(__doc__)


if __name__ == "__main__":
    main()
