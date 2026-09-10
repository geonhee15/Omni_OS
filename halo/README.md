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

## 폰 안경 (Phone Glasses) — 안경이 오기 전에 폰으로

`venv/bin/python phone_glasses.py` (앱 HALO GLASSES 패널의 START PHONE GLASSES가 이걸 띄운다).
같은 와이파이의 폰 브라우저가 `https://<맥IP>:8443` 을 열면:

| 폰 | 안경 역할 |
| --- | --- |
| 뒤 카메라 | 안경 카메라 — 배경 미리보기 + `look_camera`("지금 뭐 보여?", Haiku 비전) |
| 마이크 | 안경 마이크 — 16k PCM을 WebSocket으로 → 앱 ALWAYS와 같은 게이트 사이드카(내 목소리·호출어·이어가기) → gpt-realtime |
| 화면 | 안경 HUD — `hud.py` 스프라이트(배경·상태·자막·배너)를 `hud_compose.py`가 256×256 원형 PNG로 합성해 푸시 |
| 스피커 | 안경 스피커 — marin 24k PCM (재생 중엔 폰 마이크 입력을 버려 에코 방지) |
| 화면 탭 | 안경 탭 — 알림 브리핑 |

- **안경 시점(GLASSES)**: 폰 화면에 안경 프레임을 그리고, 실제 Halo처럼 **오른쪽 렌즈 위쪽의 작은 원형 디스플레이**에만 HUD를 띄운다(렌즈 밖은 어둡게). Halo는 0.2인치 컬러 microOLED 단안 디스플레이를 올려다보는 구조(시야각 미공개 → 렌즈 폭의 약 40%로 가정, 1x/1.5x/2x 조절)이고 SDK·에뮬레이터 기준 256×256·16색이라 HUD PNG를 `image-rendering: pixelated`로 화소 그대로 보여 준다. **HUD** 보기로 바꾸면 256×256 화소를 크게 본다. 상단 GLASSES/HUD 버튼으로 전환, 선택은 폰에 저장.
- 폰 브라우저는 https여야 카메라·마이크를 허용한다. 서버가 `~/.omni/halo_phone/`에 로컬 CA와 서버 인증서(SAN=맥 IP)를 openssl로 만들고, 폰은 `https://<맥IP>:8443/ca.crt` 를 한 번 설치한다 (아이폰: 프로파일 설치 후 설정 → 일반 → 정보 → 인증서 신뢰 설정 켜기 / 안드로이드: 설정 → 보안 → CA 인증서 설치). IP가 바뀌면 서버 인증서는 자동 재발급.
- 상태 파일 `~/.omni/store/halo_phone.json`(주소·QR·접속 수·상태·자막·도구·로그)을 앱 패널이 5초마다 읽는다. 학교 모드(`quiet_mode.json`)면 마이크 입력을 버리고 HUD에 "학교 모드" 배너.
- 테스트: `--http --port 8790 --no-gate` 로 띄우면 평문 HTTP·서버 VAD로 로컬 검증 가능 (`/status.json`, `/hud.png`, `/ws`).

폰 안경 HUD는 기본이 **최소 모드**(`--full-hud`로 원래 링 HUD): 시야를 가리는 링·워드마크 없이 상태·자막·알림 배너·텍스트 리더만 그린다. 안경 시점 화면의 점선 원·라벨·긴 안내도 뺐다.

## 카메라 텍스트 리더 (폰 안경)

카메라에 글자가 보이면 폰이 0.2초 간격으로 480px 프레임을 서버에 보내고, 맥이 Vision OCR(한국어·영어)로 글자와 위치를 돌려준다. 같은 글자가 **0.1초 이상**(연속 2프레임) 같은 자리에 머물면(프레임 0.12초 간격, 맥 OCR 속도만큼) "파싱 중" 연출: 글자 위에 파란 반투명 직사각형이 1·2·3글자 단위(길이에 따라)로 왼쪽부터 따다닥 켜지며 글로우 → 페이드아웃(70%→0). 그 뒤 글자가 계속 보이는 동안 글자에서 HUD로 리드선이 뻗고, HUD에는 인식된 글자가 한 줄로 다시 써진다(`reader_packet`, 스프라이트 0x16 — Lua 클라이언트도 인식). 글자가 사라지면 선과 HUD 표시도 사라진다. 학교 모드면 프레임을 보내지 않는다.

### 인식 엔진 (`ocr_engine.py`) — 방향 불변 · 흐림 내성 · 최대 속도

- 맥 Vision(한국어·영어, 정확 모드)을 **8방향**(정방향·좌우거울·180°·상하거울·90°·270°·전치·역전치)으로 병렬 실행해 점수가 가장 높은 방향을 고른다 → 거꾸로 보거나 유리 뒤에서(거울상) 봐도, 세로로 놓인 글자도 읽는다. 점수 = 신뢰도 × 글자 수 × 토큰 그럴듯함(숫자·글자 섞임, 기호 끼임 감점) × 기하(가로 글줄은 박스 가로세로비가 글자 수에 비례해야 함).
- 속도: 직전에 이긴 방향만 매 프레임(≈30~60ms). 전체 탐색은 결과가 약할 때·0.4~1.2초마다(≈250ms). 폰은 결과가 오는 즉시 다음 프레임을 보내는 요청-응답 페이싱(최소 60ms).
- 흐린 글자: 신뢰도 0.3 이상이면 유추 결과를 받아들이고, 탐색에서도 아무것도 없으면 자동 대비 + 언샤프 + 1.6배 확대 프레임으로 한 번 더.
- 좌표는 원본 프레임 기준으로 되돌려 주고, 세로 글줄은 `vertical`로 표시해 폰이 위→아래로 조각 연출한다. 방향 라벨(거꾸로·거울상·세로)이 박스 옆에 붙는다.
- 합성 테스트: 정방향·180°·거울·거울+180°·90°·270°·흐림 3px·세리프체 모두 올바른 방향 선택. 한계: 한글은 Vision 신뢰도가 0.5로 고정되어 전부 한글인 오인식과 정답의 동점이 생길 수 있어 흔한 상황 순(정방향 > 거울 > 거꾸로)으로 우선한다.

## 안경 옴니 = 앱 옴니 (`glasses_core.py`)

에뮬레이터(live_demo.py)와 폰 안경이 같은 두뇌를 쓴다: 지시문·도구·전사 정제·게이트 경로·알림 감시. 도구는 앱 옴니와 대응 — ask_brain, get_time, check_notifications, check_gmail, calculate, check_weather, check_news, check_markets, **smart_control**(Tapo 사이드카 직접 호출), **quiet_mode**(학교 모드 파일), **save_memory / recall_memory**(공유 기억), **look_camera**(폰 카메라), **run_shell**, check_calendar, add_event, app_action(패널·web.search·computer·ui.*·halo.*).

## 안경에서 되는 것 (live_demo)

- **대화**: gpt-realtime(marin) 음성 + 실시간 한글 자막
- **두뇌 질문**: "…에 대해 분석해줘" → ask_brain(Claude) — 앱과 같은
  기억을 갖고 답함
- **알림 확인**: "카톡 온 거 있어?" / "메일 확인해줘" → 음성 요약
- **알림 푸시**: 새 카톡·메일 도착 시 HUD에 배너 자동 표시(8초 후 소멸)
- **탭 제스처**(SPACE): 알림 브리핑 요청
- **정보 조회**: 날씨·뉴스·환율/주식·일정을 앱 스냅샷 경유로 (check_weather /
  check_news / check_markets / check_calendar), "내일 3시 치과" → add_event
- **일정 리마인더**: 시작 10분 전 HUD 배너 자동 표시
- **음성 게이트(앱과 동일)**: 안경 마이크(BLE 0x20)를 사이드카 파이프 모드
  (`omni_gate.py pipe`)로 흘려 내 목소리 발화만 세션에 넣고, 호출어
  "옴니"/이어가기 창(Haiku 분류기)으로 옴니에게 한 말만 응답. 프로필·
  기억(`~/.omni/memory`)은 앱과 공유(안경 대화도 일지에 기록). `--no-gate`로 끌 수 있음
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
