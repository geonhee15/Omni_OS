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
    import torch
    # WavLM은 MPS에서 연산자 이슈가 있을 수 있어 실패 시 CPU 폴백
    if torch.backends.mps.is_available():
        return "mps"
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
