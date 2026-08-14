#!/bin/zsh
# ULTRA 엔진 (Seed-VC) 설치: 클론 + venv + 의존성. 모델(~1.8GB)은 첫 변환 때 자동 다운로드.
set -e
cd "$(dirname "$0")"
echo "[1/3] clone seed-vc"
[ -d seedvc ] || git clone --depth 1 https://github.com/Plachtaa/seed-vc.git seedvc
echo "[2/3] python venv"
cd seedvc
[ -d venv ] || python3 -m venv venv
./venv/bin/pip install --upgrade pip --quiet
echo "[3/3] pip install (torch 포함 — 수 분)"
./venv/bin/pip install torch torchaudio numpy scipy librosa pyyaml munch einops tqdm \
  huggingface-hub "transformers==4.46.3" descript-audio-codec pydub soundfile certifi --quiet
echo "ULTRA ENGINE READY (모델은 첫 변환 시 자동 다운로드)"
