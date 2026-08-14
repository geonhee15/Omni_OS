#!/bin/zsh
# VOICE CHANGER 신경망 엔진 설치: venv + torch/torchaudio + kNN-VC 모델 프리페치
set -e
cd "$(dirname "$0")"
echo "[1/3] python venv"
[ -d venv ] || python3 -m venv venv
./venv/bin/pip install --upgrade pip --quiet
echo "[2/3] pip install torch torchaudio (수십 MB~수백 MB)"
./venv/bin/pip install torch torchaudio soundfile certifi --quiet
echo "[3/3] kNN-VC 모델 다운로드 (WavLM-Large ~1.2GB + HiFi-GAN)"
./venv/bin/python worker.py prefetch
echo "ENGINE READY"
