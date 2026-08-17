#!/usr/bin/env python3
"""VOICE CHANGER 신경망 워커 (kNN-VC).

WavLM-Large 특징 공간에서 소스 프레임을 레퍼런스 프레임의 k-최근접으로
치환한 뒤 HiFi-GAN으로 재합성한다 — 별도 훈련 없이 레퍼런스 오디오만으로
음색 전이. 모델은 첫 실행 시 torch.hub 캐시(~/.cache/torch)로 받는다.

사용:
  worker.py status                      # 엔진/모델 준비 상태 JSON
  worker.py prefetch                    # 모델 다운로드만
  worker.py learn <ref.wav> <out.pt>    # 레퍼런스 특징 추출 → 프로파일 저장
  worker.py convert <profile.pt> <in.wav> <out.wav> [topk]
  worker.py ttsserve <profile.pt>       # OMNI_AI TTS 변환 데몬 (JSON 라인)
"""
import json
import os
import sys
import traceback

try:  # macOS 파이썬의 SSL CA 번들 미지정 문제 해결
    import certifi
    os.environ.setdefault("SSL_CERT_FILE", certifi.where())
    os.environ.setdefault("REQUESTS_CA_BUNDLE", certifi.where())
except ImportError:
    pass


def out(obj):
    print(json.dumps(obj), flush=True)


def pick_device():
    # knn-vc가 내부에서 CUDA 외 GPU를 cpu로 강제 + MPS는 float64 이슈.
    # M4 CPU에서 RTF 0.1 수준이라 CPU로 충분하다.
    return "cpu"


def patch_torchaudio_io():
    """torchaudio 2.9+는 load/save를 torchcodec에 위임한다 — FFmpeg 의존을
    피하려고 soundfile 기반 IO로 교체 (우리 입출력은 항상 16kHz WAV)."""
    import numpy as np
    import soundfile as sf
    import torch
    import torchaudio

    def _load(path, normalize=True, **kw):
        data, sr = sf.read(str(path), dtype="float32", always_2d=True)
        return torch.from_numpy(np.ascontiguousarray(data.T)), sr

    def _save(path, tensor, sample_rate, **kw):
        arr = tensor.detach().cpu().numpy()
        if arr.ndim == 2:
            arr = arr.T
        sf.write(str(path), arr, sample_rate)

    torchaudio.load = _load
    torchaudio.save = _save


_hub = None


def hub(device):
    global _hub
    if _hub is None:
        import torch
        patch_torchaudio_io()
        _hub = torch.hub.load(
            "bshall/knn-vc", "knn_vc",
            prematched=True, trust_repo=True, pretrained=True,
            device=device,
        )
    return _hub


def load_with_fallback():
    device = pick_device()
    try:
        return hub(device), device
    except Exception:
        if device != "cpu":
            global _hub
            _hub = None
            return hub("cpu"), "cpu"
        raise


def cmd_status():
    try:
        import torch  # noqa: F401
        import torchaudio  # noqa: F401
    except Exception as e:
        out({"ok": False, "installed": False, "error": str(e)})
        return
    from pathlib import Path
    cache = Path.home() / ".cache" / "torch"
    has_models = any(cache.rglob("WavLM-Large.pt")) if cache.exists() else False
    out({"ok": True, "installed": True, "models": has_models,
         "device": pick_device()})


def cmd_prefetch():
    load_with_fallback()
    out({"ok": True})


def cmd_learn(ref_wav, out_pt):
    import torch
    knn, device = load_with_fallback()
    # VAD 트리밍 비활성 — 임의 오디오(음악·합성음)를 통째로 잘라버릴 수 있음
    matching = knn.get_matching_set([ref_wav], vad_trigger_level=0)
    torch.save(matching.cpu(), out_pt)
    out({"ok": True, "frames": int(matching.shape[0]), "device": device})


def cmd_convert(profile_pt, in_wav, out_wav, topk=4):
    import torch
    import torchaudio
    knn, device = load_with_fallback()
    query = knn.get_features(in_wav, vad_trigger_level=0)
    matching = torch.load(profile_pt, map_location=query.device
                          if hasattr(query, "device") else "cpu")
    matching = matching.to(query.device)
    wav = knn.match(query, matching, topk=int(topk))
    torchaudio.save(out_wav, wav[None].cpu(), 16000)
    out({"ok": True, "seconds": round(wav.shape[-1] / 16000, 2),
         "device": device})


def cmd_serve(profile_pt):
    """라이브 스트리밍 데몬: stdin으로 4바이트 길이 + float32 PCM(16kHz) 청크를
    받아 변환 후 stdout에 base64 한 줄씩 출력. 길이 0 프레임 = 종료.
    각 청크는 직전 컨텍스트(0.5초)를 붙여 특징을 뽑고 꼬리만 내보내
    경계 품질을 유지한다."""
    import base64
    import contextlib
    import struct

    import numpy as np
    import torch

    # 모델 로딩이 stdout에 찍는 로그가 프로토콜을 오염시키지 않게 우회
    with contextlib.redirect_stdout(sys.stderr):
        knn, device = load_with_fallback()
        matching = torch.load(profile_pt, map_location="cpu")
    sr = 16000
    ctx_len = sr // 2
    ctx = np.zeros(ctx_len, dtype=np.float32)  # 첫 청크도 균일 길이로 나오게
    stdin = sys.stdin.buffer
    stdout = sys.stdout
    print("READY", flush=True)
    while True:
        hdr = stdin.read(4)
        if len(hdr) < 4:
            break
        n = struct.unpack("<I", hdr)[0]
        if n == 0 or n > sr * 30 * 4:
            break
        raw = b""
        while len(raw) < n:
            more = stdin.read(n - len(raw))
            if not more:
                return
            raw += more
        chunk = np.frombuffer(raw, dtype=np.float32)
        full = np.concatenate([ctx, chunk])
        ctx = full[-ctx_len:].copy()
        try:
            wav_t = torch.from_numpy(full.copy())
            q = knn.get_features(wav_t, vad_trigger_level=0)
            out = knn.match(q, matching, topk=4, tgt_loudness_db=None)
            out_np = out.cpu().numpy().astype(np.float32)
            # 컨텍스트에 해당하는 앞부분을 버리고 청크 분량 꼬리만 방출
            emit_len = (len(chunk) // 320) * 320
            emit = out_np[-emit_len:] if len(out_np) >= emit_len else out_np
            stdout.write(base64.b64encode(emit.tobytes()).decode() + "\n")
            stdout.flush()
        except Exception as e:
            stdout.write(f"ERR {str(e)[:120]}\n")
            stdout.flush()


# ── OMNI_AI TTS 후처리 (numpy 포트: vendor/dsp/voice_dsp.js 와 같은 알고리즘) ──
# kNN-VC 출력은 타겟보다 피치가 높고(얇게 들림) 평균 스펙트럼이 어긋난다.
# 위상 보코더 피치 다운 + 타겟 LTAS 포락선 매칭으로 원본 톤에 붙인다.

def _pv_time_stretch(x, stretch):
    import numpy as np
    N, hop_a = 1024, 256
    hop_s = max(1, round(hop_a * stretch))
    w = np.hanning(N).astype(np.float32)
    half = N // 2
    out_len = int(np.ceil(len(x) * stretch)) + N
    out = np.zeros(out_len, dtype=np.float32)
    win = np.zeros(out_len, dtype=np.float32)
    last_ph = np.zeros(half + 1)
    sum_ph = np.zeros(half + 1)
    expct = 2 * np.pi * hop_a * np.arange(half + 1) / N
    pos = 0
    for s in range(0, len(x) - N + 1, hop_a):
        spec = np.fft.rfft(x[s:s + N] * w)
        mag, ph = np.abs(spec), np.angle(spec)
        dphi = ph - last_ph - expct
        last_ph = ph
        dphi -= 2 * np.pi * np.round(dphi / (2 * np.pi))
        sum_ph += (hop_s / hop_a) * (expct + dphi)
        seg = np.fft.irfft(mag * np.exp(1j * sum_ph))
        out[pos:pos + N] += seg * w
        win[pos:pos + N] += w * w
        pos += hop_s
    floor = max(1e-6, win.max() * 0.1)
    n = round(len(x) * stretch)
    res = out[:n]
    wv = win[:n]
    res = np.where(wv >= floor, res / np.maximum(wv, 1e-9), 0)
    return res.astype(np.float32)


def _pitch_shift(x, ratio):
    import numpy as np
    if abs(ratio - 1) < 1e-3:
        return x
    st = _pv_time_stretch(x, ratio)
    n2 = len(x)
    idx = np.linspace(0, len(st) - 1, n2)
    return np.interp(idx, np.arange(len(st)), st).astype(np.float32)


def _ltas(x, sr):
    import numpy as np
    N, hop = 1024, 256
    w = np.hanning(N)
    acc = np.zeros(N // 2)
    c = 0
    for s in range(0, len(x) - N, hop):
        acc += np.abs(np.fft.rfft(x[s:s + N] * w))[:N // 2]
        c += 1
    return acc / max(c, 1)


def _smooth_ltas(l, frac=0.5):
    import numpy as np
    half = len(l)
    out = np.empty(half)
    for k in range(half):
        lo = max(1, int(k * 2 ** -frac))
        hi = min(half - 1, int(np.ceil(k * 2 ** frac)))
        out[k] = l[lo:hi + 1].mean() if hi >= lo else l[k]
    return out


def _envelope_match(x, sr, ref_ltas, strength=0.75, floor=0.2):
    """타겟 LTAS로 포락선 보정. strength<1 이면 보정을 부분 적용하고,
    floor 는 대역별 최대 감쇠 한계 — 타겟의 고역 컷(~4kHz)을 그대로 강제하면
    자음이 뭉개져 딕션이 탁해지므로 기본값을 완만하게 잡는다."""
    import numpy as np
    N, hop = 1024, 256
    w = np.hanning(N).astype(np.float32)
    half = N // 2
    rs = _smooth_ltas(ref_ltas)
    ts = _smooth_ltas(_ltas(x, sr))
    gain = np.clip((rs / max(rs.mean(), 1e-9))
                   / np.maximum(ts / max(ts.mean(), 1e-9), 1e-6), floor, 20)
    gain = gain ** strength
    gain = np.append(gain, gain[-1]).astype(np.float32)
    out = np.zeros(len(x), dtype=np.float32)
    win = np.zeros(len(x), dtype=np.float32)
    for s in range(0, len(x) - N + 1, hop):
        spec = np.fft.rfft(x[s:s + N] * w) * gain
        seg = np.fft.irfft(spec).astype(np.float32)
        out[s:s + N] += seg * w
        win[s:s + N] += w * w
    floor = max(1e-6, win.max() * 0.1)
    out = np.where(win >= floor, out / np.maximum(win, 1e-9), 0)
    return out.astype(np.float32)


def _f0_median(x, sr, lo=70, hi=350):
    import numpy as np
    frame, hop = int(sr * 0.04), int(sr * 0.02)
    f0s = []
    for s in range(0, len(x) - frame, hop):
        seg = x[s:s + frame]
        if (seg ** 2).mean() < 1e-5:
            continue
        seg = seg - seg.mean()
        ac = np.correlate(seg, seg, "full")[frame - 1:]
        if ac[0] <= 0:
            continue
        l0, l1 = int(sr / hi), int(sr / lo)
        lag = l0 + int(np.argmax(ac[l0:l1]))
        if ac[lag] / ac[0] > 0.4:
            f0s.append(sr / lag)
    return float(np.median(f0s)) if f0s else 0.0


def _ring_mod(x, sr, hz=40.0, wet=0.3):
    import numpy as np
    t = np.arange(len(x), dtype=np.float32)
    m = np.sin(2 * np.pi * hz * t / sr).astype(np.float32)
    return x * (1 - wet) + x * m * wet


def cmd_ttsserve(profile_pt, ref_wav=None):
    """OMNI_AI TTS 변환 데몬: 모델·프로파일을 상주시켜 두고 stdin의 JSON 라인
    {"in": path, "out": path, "topk"?, "pitch"?, "ltas"?} 마다 전체 발화를
    오프라인 변환 + 후처리한다. 응답은 stdout에 JSON 한 줄씩.
    기본 후처리(topk=1, pitch=0.855, LTAS 매칭)는 로봇 대사팩 실측 튜닝값 —
    WavLM cosine 0.788(기본 변환) → 0.818, F0 152→132Hz(타겟 131Hz).
    모델 로그(리샘플 알림 등)가 프로토콜을 오염시키지 않게 stdout을 우회한다."""
    import contextlib

    import numpy as np
    import soundfile as sf
    import torch

    real_stdout = sys.stdout
    with contextlib.redirect_stdout(sys.stderr):
        knn, device = load_with_fallback()
        matching = torch.load(profile_pt, map_location="cpu")
    ref_ltas = None
    if ref_wav and os.path.exists(ref_wav):
        rx, rsr = sf.read(ref_wav, always_2d=True)
        rx = rx.mean(axis=1)[:rsr * 90]
        ref_ltas = _ltas(rx, rsr)  # 레퍼런스도 16kHz라 빈 정렬 일치
    print("READY", file=real_stdout, flush=True)
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            lang = req.get("lang", "ko")
            with contextlib.redirect_stdout(sys.stderr):
                if lang == "ko":
                    # 한국어: kNN 프레임 치환 — 대사팩(한국어)과 음소 공간이 같아
                    # 억양 왜곡 없이 진짜 그 목소리가 된다
                    query = knn.get_features(req["in"], vad_trigger_level=0)
                    wav = knn.match(query, matching.to(query.device),
                                    topk=int(req.get("topk", 1)))
                    y = wav.cpu().numpy().astype(np.float32).reshape(-1)
                    y = _pitch_shift(y, float(req.get("pitch", 0.855)))
                    if req.get("ltas", True) and ref_ltas is not None:
                        y = _envelope_match(y, 16000, ref_ltas)
                else:
                    # 비한국어: kNN 치환은 한국어 프레임으로 갈아끼워 한국인
                    # 억양이 생긴다 → 네이티브 TTS 발음을 유지한 채 대사팩
                    # 톤(피치·포락선)과 가벼운 로봇 질감만 입힌다
                    xx, xsr = sf.read(req["in"], always_2d=True)
                    xx = xx.mean(axis=1).astype(np.float32)
                    if xsr != 16000:
                        n2 = int(len(xx) * 16000 / xsr)
                        y = np.interp(np.linspace(0, len(xx) - 1, n2),
                                      np.arange(len(xx)), xx).astype(np.float32)
                    else:
                        y = xx
                    f0 = _f0_median(y, 16000)
                    ratio = min(1.15, max(0.6, 131.0 / f0)) if f0 > 0 else 1.0
                    y = _pitch_shift(y, ratio)
                    if ref_ltas is not None:
                        y = _envelope_match(y, 16000, ref_ltas,
                                            strength=0.65, floor=0.25)
                    y = _ring_mod(y, 16000, hz=40.0, wet=0.3)
                peak = max(abs(y).max(), 1e-9)
                sf.write(req["out"], y / peak * 0.95, 16000)
            resp = {"ok": True, "seconds": round(len(y) / 16000, 2)}
        except Exception as e:  # 요청 하나의 실패가 데몬을 죽이지 않게
            resp = {"ok": False, "error": str(e)[:200]}
        print(json.dumps(resp), file=real_stdout, flush=True)


def main():
    if len(sys.argv) < 2:
        out({"ok": False, "error": "no command"})
        return 1
    cmd = sys.argv[1]
    try:
        if cmd == "status":
            cmd_status()
        elif cmd == "prefetch":
            cmd_prefetch()
        elif cmd == "learn":
            cmd_learn(sys.argv[2], sys.argv[3])
        elif cmd == "serve":
            cmd_serve(sys.argv[2])
        elif cmd == "ttsserve":
            cmd_ttsserve(sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else None)
        elif cmd == "convert":
            topk = sys.argv[5] if len(sys.argv) > 5 else 4
            cmd_convert(sys.argv[2], sys.argv[3], sys.argv[4], topk)
        else:
            out({"ok": False, "error": f"unknown command {cmd}"})
            return 1
    except Exception as e:
        out({"ok": False, "error": str(e),
             "trace": traceback.format_exc()[-1500:]})
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
