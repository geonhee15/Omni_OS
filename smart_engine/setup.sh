#!/bin/bash
# SMART CONTROL 엔진 설치 — Tapo 로컬 제어용 python-kasa
set -e
cd "$(dirname "$0")"
python3 -m venv venv
venv/bin/python -m pip install -q -r requirements.txt
echo "smart_engine 준비 완료"
