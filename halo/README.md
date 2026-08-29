# OMNI for Halo

옴니를 Brilliant Labs Halo 스마트 글래스에 얹는 작업 공간 (ECHO 대체).
하드웨어 도착 전 — `halo-emulator`로 전체 루프를 개발·검증한다.

## 구조

```
질문 음성 → [에뮬레이터 마이크] → lua/main.lua (안경 앱)
  → BLE(0x20+PCM16k) → bridge.py → 리샘플 24k → gpt-realtime(marin)
  → 응답 오디오/전사 → BLE(0x10 스피커 / 0x02 자막 / 0x03 상태) → 원형 HUD
```

- `lua/main.lua` — 안경 쪽 씬 클라이언트: 마이크 스트림, 스피커 재생,
  256×256 HUD(상태·자막), 탭 이벤트. **소스는 latin-1만 허용** (한글 주석 금지)
- `bridge.py` — 호스트 브리지. 실기기 전환 시 에뮬레이터 I/O만
  brilliant_ble 전송으로 교체하면 됨
- 디스플레이 폰트에 한글 글리프 없음 → 한글 자막은 추후 호스트에서
  비트맵 렌더 후 sprite로 전송

## 라이브 데모 (책상 위 안경 체험)

```bash
cd halo && ./venv/bin/python live_demo.py
```
맥 마이크에 실제로 말하면 → 에뮬 안경 → marin 응답이 스피커로,
원형 HUD는 pygame 창에 실시간 표시. SPACE=탭, ESC=종료.
(스피커 에코 방지로 옴니 발화 중엔 마이크 게이트 — 실기기는 AEC 내장)

## 파일 데모 실행

```bash
cd halo
./venv/bin/python bridge.py question.wav
# 산출: halo_demo.gif(화면 녹화) · halo_reply.wav(marin 응답) · halo_final.png
```

## 셋업

```bash
python3 -m venv venv
./venv/bin/pip install brilliant-sdk halo-emulator websockets numpy certifi
```
