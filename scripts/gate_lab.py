#!/usr/bin/env python3
"""음성 게이트 실험실 — 파이프 모드에 합성 신호(마이크/시스템 출력/얼굴)를 넣어
다신호 융합 라벨을 검증한다. 실제 마이크·카메라 없이 돌아간다.

사용: voice_engine/venv/bin/python scripts/gate_lab.py  (OMNI_VOICE_DIR로 격리된 테스트 프로필 사용)
"""
import json
import os
import struct
import subprocess
import sys
import tempfile
import time
import wave

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
PY = os.path.join(REPO, "voice_engine/venv/bin/python")
GATE = os.path.join(HERE, "omni_gate.py")
SR = 16000


def tts(voice, text, path):
    subprocess.run(["say", "-v", voice, "-o", path, "--data-format=LEI16@16000", text], check=True)
    with wave.open(path) as w:
        return np.frombuffer(w.readframes(w.getnframes()), dtype="<i2").astype(np.float32) / 32768


class Lab:
    def __init__(self, voice_dir):
        env = dict(os.environ, OMNI_VOICE_DIR=voice_dir)
        self.p = subprocess.Popen([PY, GATE, "pipe"], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                  stderr=subprocess.DEVNULL, env=env)
        self.events = []
        import threading
        threading.Thread(target=self._reader, daemon=True).start()
        self.wait("ready", 30)

    def _reader(self):
        for line in self.p.stdout:
            try:
                d = json.loads(line)
            except ValueError:
                continue
            d.pop("pcm24", None)
            self.events.append(d)

    def frame(self, payload: bytes):
        self.p.stdin.write(struct.pack("<I", len(payload)) + payload)
        self.p.stdin.flush()

    def wait(self, ev, timeout=10):
        t0 = time.time()
        n = len(self.events)
        while time.time() - t0 < timeout:
            for d in self.events[n:]:
                if d.get("ev") == ev:
                    return d
            n = len(self.events)
            time.sleep(0.05)
        return None

    def stream(self, mic: np.ndarray, sysout: np.ndarray = None, mouth=None, faces=0, frontal=False):
        """실시간 페이스로 마이크(+시스템 출력, 얼굴)를 흘린다. 반환: 세그먼트 이벤트."""
        n0 = len(self.events)
        hop = 1600  # 100ms
        total = len(mic) + SR  # 꼬리 1초 무음
        mic = np.concatenate([mic, np.zeros(SR, np.float32)])
        if sysout is not None:
            sysout = np.concatenate([sysout, np.zeros(max(0, total - len(sysout)), np.float32)])
        t_start = time.time()
        for i in range(0, total, hop):
            t = t_start + i / SR
            if sysout is not None:
                self.frame(b"S" + (np.clip(sysout[i:i + hop], -1, 1) * 32767).astype("<i2").tobytes())
            if mouth is not None:
                k = i // hop
                m = float(mouth[min(k, len(mouth) - 1)])
                self.frame(b"V" + json.dumps({"t": t, "mouth": m, "faces": faces, "frontal": frontal}).encode())
            self.frame(b"M" + (np.clip(mic[i:i + hop], -1, 1) * 32767).astype("<i2").tobytes())
            while time.time() < t + hop / SR:
                time.sleep(0.005)
        segs = None
        for _ in range(60):
            segs = [d for d in self.events[n0:] if d.get("ev") == "segment"]
            if segs:
                time.sleep(0.5)
                segs = [d for d in self.events[n0:] if d.get("ev") == "segment"]
                break
            time.sleep(0.1)
        return segs or []

    def close(self):
        try:
            self.frame(json.dumps({"cmd": "quit"}).encode())
        except OSError:
            pass


def envelope_mouth(x: np.ndarray, hop=1600, lead=1):
    """음성 포락선을 흉내 낸 입 벌림 시계열(100ms) — 소리보다 lead 프레임 앞섬."""
    n = len(x) // hop + 10
    e = np.array([np.sqrt(np.mean(x[i * hop:(i + 1) * hop] ** 2)) if (i + 1) * hop <= len(x) else 0.0
                  for i in range(n)])
    e = e / (e.max() + 1e-9) * 0.35 + 0.02
    return np.concatenate([e[lead:], np.full(lead, 0.02)])


def main():
    tmp = tempfile.mkdtemp(prefix="omni_lab_")
    vdir = os.path.join(tmp, "voice"); os.makedirs(vdir)
    S = ["옴니야 오늘 날씨 어때", "내일 일정 좀 알려줘", "이거 계산 좀 해줄래", "지금 카톡 온 거 있어",
         "노트 패널 열어줘", "이건 그냥 혼잣말이야"]
    me = [tts("Yuna", t, f"{tmp}/me{i}.wav") for i, t in enumerate(S)]
    other = [tts("Eddy (한국어(대한민국))", t, f"{tmp}/ot{i}.wav") for i, t in enumerate(S[:3])]
    # 테스트 프로필: me = Yuna 0~2
    env = dict(os.environ, OMNI_VOICE_DIR=vdir)
    subprocess.run([PY, GATE, "enroll-files", "me", f"{tmp}/me0.wav", f"{tmp}/me1.wav", f"{tmp}/me2.wav"],
                   env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)
    lab = Lab(vdir)
    rng = np.random.default_rng(0)
    results = []

    def run(name, expect, **kw):
        segs = lab.stream(**kw)
        got = segs[0]["label"] if segs else "(없음)"
        ok = got == expect
        results.append(ok)
        d = segs[0] if segs else {}
        print(f"{'PASS' if ok else 'FAIL'} {name:34s} → {got:9s} (기대 {expect}) "
              f"sim={d.get('sim')} media={d.get('media')} lips={d.get('lips', {}).get('corr')}/{d.get('lips', {}).get('act')} band={d.get('band')}")

    # (a) 노트북 재생음: 시스템 출력 = 타인 음성, 마이크 = 같은 소리 120ms 늦게·약하게 + 잡음
    x = other[0]
    mic = np.concatenate([np.zeros(int(0.12 * SR), np.float32), x * 0.5]) + rng.normal(0, 0.003, len(x) + int(0.12 * SR)).astype(np.float32)
    run("(a) 유튜브 재생음 (루프백 상관)", "media", mic=mic, sysout=x)
    # (b) 내 목소리 + 입술 동기 (얼굴 있음)
    run("(b) 내 목소리 + 입 움직임", "user", mic=me[3], mouth=envelope_mouth(me[3]), faces=1, frontal=True)
    # (c) 타인 목소리, 내 얼굴은 입 가만히
    still = np.full(60, 0.02)
    run("(c) 타인 목소리 + 내 입 가만히", "other", mic=other[1], mouth=still, faces=1, frontal=True)
    # (d) 타인 목소리, 카메라 없음 → 목소리만으로
    run("(d) 타인 목소리 (신호 없음)", "other", mic=other[2])
    # (e) 내 목소리, 카메라 없음 → 목소리만으로
    run("(e) 내 목소리 (신호 없음)", "user", mic=me[4])
    # (f) 내 목소리가 유튜브 위에 겹침 (시스템 출력 = 음악 대신 타인 음성), 입 움직임 동기
    mix = me[5][:len(other[0])] if len(me[5]) >= len(other[0]) else np.concatenate([me[5], np.zeros(len(other[0]) - len(me[5]), np.float32)])
    mic = mix + np.concatenate([np.zeros(int(0.1 * SR), np.float32), other[0] * 0.35])[:len(mix)]
    run("(f) 유튜브 위에 내 말 겹침 + 입술", "user", mic=mic, sysout=other[0], mouth=envelope_mouth(me[5]), faces=1, frontal=True)
    # (g) 내 목소리인데 입이 가만히 (녹음된 내 목소리 재생 등) → 유사도만으로는 통과하지만 입 정지면 거부
    run("(g) 내 목소리 재생 + 입 가만히", "other", mic=me[3] * 0.9, mouth=still, faces=1, frontal=True)
    # (h) 옴니가 말하는 중(speaking on): 스피커로 나오는 옴니 목소리 → media/omni_voice (전사 제외)
    lab.frame(json.dumps({"cmd": "speaking", "on": True}).encode())
    x = other[0]
    mic = np.concatenate([np.zeros(int(0.12 * SR), np.float32), x * 0.5]) + rng.normal(0, 0.003, len(x) + int(0.12 * SR)).astype(np.float32)
    segs = lab.stream(mic=mic, sysout=x)
    ok = bool(segs) and segs[0]["label"] == "media" and segs[0].get("why") == "omni_voice"
    results.append(ok)
    print(f"{'PASS' if ok else 'FAIL'} (h) 옴니 발화 중 옴니 목소리            → {segs[0]['label'] if segs else '(없음)'}/{segs[0].get('why') if segs else ''} (기대 media/omni_voice)")
    # (i) 옴니가 말하는 중 내가 끼어듦 (내 목소리 + 입술, 옴니 목소리 겹침) → user
    mix = me[3] if len(me[3]) >= len(other[1]) else np.concatenate([me[3], np.zeros(len(other[1]) - len(me[3]), np.float32)])
    mic = mix + np.concatenate([np.zeros(int(0.1 * SR), np.float32), other[1] * 0.35])[:len(mix)]
    run("(i) 옴니 발화 중 끼어들기 + 입술", "user", mic=mic, sysout=other[1], mouth=envelope_mouth(me[3]), faces=1, frontal=True)
    lab.frame(json.dumps({"cmd": "speaking", "on": False}).encode())
    lab.close()
    print(f"\n{sum(results)}/{len(results)} 통과")
    sys.exit(0 if all(results) else 1)


if __name__ == "__main__":
    main()
