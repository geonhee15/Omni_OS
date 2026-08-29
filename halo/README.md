# OMNI for Halo

옴니를 Brilliant Labs Halo 스마트 글래스에 얹는 작업 공간 (ECHO 대체).
하드웨어 도착 전 — `halo-emulator`로 전체 루프를 개발·검증한다.

## 구조

```
질문 음성 → [에뮬레이터 마이크] → lua/main.lua (안경 앱)
  → BLE(0x20+PCM16k) → bridge.py → 리샘플 24k → gpt-realtime(marin)
  → 응답 오디오/전사 → BLE(0x10 스피커 / 0x13 상태 / 0x14 자막) → 원형 HUD
```

- `lua/main.lua` — 안경 쪽 씬 클라이언트: 마이크 스트림, 스피커 재생,
  호스트 스프라이트 블릿, 탭 이벤트. **소스는 latin-1만 허용** (한글 주석 금지)
- `hud.py` — 호스트 사이드 HUD 렌더러. 디스플레이는 256×256 원형
  16색 인덱스드(인덱스 0=투명)라 펌웨어 폰트/프리미티브만으로는 품질에
  한계 → 호스트에서 2× 슈퍼샘플링 + 안티앨리어싱 + 글로우로 그린 뒤
  시안 램프 팔레트로 양자화해 4bpp 스프라이트 전송.
  링·틱·대각 액센트 아크 배경(0x12, 부팅 시 1회), LED 상태
  스프라이트(0x13), 산돌고딕 한글 자막(0x14, 줄별 원형 코드 맞춤 +
  중앙 정렬). 한글 글리프가 펌웨어 폰트에 없는 문제도 이 방식으로 해결
- `bridge.py` — 호스트 브리지. 실기기 전환 시 에뮬레이터 I/O만
  brilliant_ble 전송으로 교체하면 됨 (배경 32KB는 BLE MTU 분할 필요)

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
