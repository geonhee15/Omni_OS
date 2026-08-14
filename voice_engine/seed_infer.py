#!/usr/bin/env python3
"""Seed-VC inference.py 래퍼 (ULTRA 엔진).

- torchaudio 2.9+의 load/save torchcodec 위임을 soundfile로 대체
- SSL 인증서(certifi) 지정 — 모델 자동 다운로드용
- seedvc 디렉토리를 cwd로 강제 (HF 캐시 상대경로)
사용: seed_infer.py --source a.wav --target ref.wav --output outdir [inference.py 인자 그대로]
"""
import os
import runpy
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SEEDVC = os.path.join(HERE, "seedvc")

try:
    import certifi
    os.environ.setdefault("SSL_CERT_FILE", certifi.where())
    os.environ.setdefault("REQUESTS_CA_BUNDLE", certifi.where())
except ImportError:
    pass


def patch_torchaudio_io():
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


patch_torchaudio_io()
os.chdir(SEEDVC)
sys.path.insert(0, SEEDVC)
sys.argv[0] = "inference.py"
runpy.run_path(os.path.join(SEEDVC, "inference.py"), run_name="__main__")
