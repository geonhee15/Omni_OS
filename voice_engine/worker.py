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


def cmd_ttsserve(profile_pt):
    """OMNI_AI TTS 변환 데몬: 모델·프로파일을 상주시켜 두고 stdin의 JSON 라인
    {"in": path, "out": path} 마다 전체 발화를 오프라인 변환한다 (스트리밍 serve와
    달리 문장 단위라 경계 아티팩트가 없음). 응답은 stdout에 JSON 한 줄씩.
    모델 로그(리샘플 알림 등)가 프로토콜을 오염시키지 않게 stdout을 우회한다."""
    import contextlib

    import torch
    import torchaudio

    real_stdout = sys.stdout
    with contextlib.redirect_stdout(sys.stderr):
        knn, device = load_with_fallback()
        matching = torch.load(profile_pt, map_location="cpu")
    print("READY", file=real_stdout, flush=True)
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            with contextlib.redirect_stdout(sys.stderr):
                query = knn.get_features(req["in"], vad_trigger_level=0)
                wav = knn.match(query, matching.to(query.device), topk=4)
                torchaudio.save(req["out"], wav[None].cpu(), 16000)
            resp = {"ok": True, "seconds": round(wav.shape[-1] / 16000, 2)}
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
            cmd_ttsserve(sys.argv[2])
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
