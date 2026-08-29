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
- `omni_link.py` — **맥 옴니 앱과의 공유 링크**. 안경의 옴니가 앱과 같은
  자원을 쓴다: 장기 기억(`~/.omni/store/ai_memory.json` 읽기), 두뇌
  (Claude AUTO 라우팅 — 간단→Haiku / 깊은→Opus 5), 지메일
  (`scripts/gmail_helper.py` 재사용), 앱 제어 메일박스
  (`~/.omni/halo_mailbox.jsonl`에 append → 앱이 2.5초마다 폴링해 소비)
- **카톡 알림은 앱 스냅샷 경유** — 알림 DB는 TCC 보호라 브리지의
  파이썬(별도 TCC 신원)이 직접 못 읽는다. FDA를 가진 옴니 앱이 20초
  폴링마다 `~/.omni/store/halo_notif.json`으로 밀어주고 브리지는 그
  파일만 읽는다. 음성으로 "카톡 확인" 시엔 메일박스로 `notif_refresh`를
  보내 즉시 재조회를 트리거

## 안경에서 되는 것 (live_demo)

- **대화**: gpt-realtime(marin) 음성 + 실시간 한글 자막
- **두뇌 질문**: "…에 대해 분석해줘" → ask_brain(Claude) — 앱과 같은
  기억을 갖고 답함
- **알림 확인**: "카톡 온 거 있어?" / "메일 확인해줘" → 음성 요약
- **알림 푸시**: 새 카톡·메일 도착 시 HUD에 배너 자동 표시(8초 후 소멸)
- **탭 제스처**(SPACE): 알림 브리핑 요청
- **앱 제어**: "맥에서 노트 패널 열어줘" → 옴니 앱이 실제로 패널 전환,
  안경 대화 전사는 앱 OMNI_AI 패널에 `[HALO]` 태그로 흐름

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
