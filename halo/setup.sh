#!/bin/zsh
# 안경 브리지 + 폰 안경 환경 설치: venv + 의존성 + 손 추적 모델
set -e
cd "$(dirname "$0")"
echo "[1/3] python venv"
[ -d venv ] || python3 -m venv venv
./venv/bin/python -m pip install --upgrade pip --quiet
echo "[2/3] pip install (websockets·pillow·Vision·mediapipe…)"
./venv/bin/pip install --quiet -r requirements.txt
echo "[3/3] 손 추적 모델 (~8MB)"
mkdir -p models
if [ ! -f models/hand_landmarker.task ]; then
  curl -sL -o models/hand_landmarker.task \
    "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task"
fi
echo "HALO READY — 폰 안경: venv/bin/python phone_glasses.py (앱 HALO GLASSES 패널 START가 이걸 띄운다)"
