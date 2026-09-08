#!/bin/zsh
# VOICE CHANGER 신경망 엔진 설치: venv + torch/torchaudio + kNN-VC 모델 프리페치
set -e
cd "$(dirname "$0")"
echo "[1/3] python venv"
[ -d venv ] || python3 -m venv venv
./venv/bin/pip install --upgrade pip --quiet
echo "[2/3] pip install torch torchaudio (수십 MB~수백 MB)"
./venv/bin/pip install torch torchaudio soundfile certifi --quiet
echo "[3/4] 상시 대기 음성 게이트 의존성 (scripts/omni_gate.py — 화자 임베딩·VAD)"
./venv/bin/pip install "setuptools<80" resemblyzer silero-vad numpy --quiet
echo "[4/4] kNN-VC 모델 다운로드 (WavLM-Large ~1.2GB + HiFi-GAN)"
# 로제타(x86_64) 셸에서 실행돼도 유니버설 파이썬이 arm64 torch를 쓰도록 강제
if [ "$(sysctl -n hw.optional.arm64 2>/dev/null)" = "1" ]; then
  arch -arm64 ./venv/bin/python worker.py prefetch
else
  ./venv/bin/python worker.py prefetch
fi
echo "ENGINE READY"
