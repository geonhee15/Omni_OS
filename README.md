# OMNI_OS

자비스(J.A.R.V.I.S.) 스타일의 파란색 HUD 인터페이스를 가진 개인용 대시보드 앱.
이름만 OS일 뿐, 실제로는 맥 앱이다. UI는 웹 기술(HTML/CSS/JS)로 만들고
네이티브 래퍼(Objective-C + WKWebView)로 감싼 구조.

## ⛔ 개인용 빌드 (오너 잠금)

이 레포는 소스 공개용이지, 배포용이 아니다. 앱은 부팅 시
`~/.omni/owner.key`(레포에 없음, 오너 기기에만 존재)의 SHA-256이
소스에 박힌 해시와 일치해야만 실행된다 — 클론해서 빌드해도
**ACCESS DENIED 화면만 뜨고 종료**된다. 해시는 공개돼도 256비트
랜덤 키를 역산할 수 없다. 코드 참고는 자유, 실행은 오너만.

## 맥 앱 빌드 & 설치

```bash
bash macos/build.sh                          # dist/Omni OS.app 생성
ditto "dist/Omni OS.app" "/Applications/Omni OS.app"   # 설치
```

Xcode 없이 Command Line Tools만으로 빌드된다.

## 웹으로 바로 보기

`index.html`을 브라우저에서 열어도 동일한 화면이 나온다 (개발할 때 편함).

## 현재 기능

UI는 영어 전용. 왼쪽 사이드바에서 패널을 전환한다.

- **CLOCK** — 중앙 디지털 시계 (시간 / 날짜 / 업타임), 회전 링 HUD
- **RENDER_3D** — three.js 기반 3D 모델 뷰어. STL·OBJ/MTL·GLTF/GLB·FBX·PLY·3MF·DAE에 더해
  **STEP/IGES/BREP**(OpenCascade WASM, 원본 CAD 색상·조립 좌표 유지)를
  파일 선택 또는 드래그&드롭으로 로드 (동반 파일 — mtl·텍스처·bin — 함께 선택하면 자동 연결).
  **워크스페이스 탭**: 로드마다 파일명 탭이 생기고, 여러 파일을 한 번에 선택하면 파트별 탭과 함께
  원본 좌표를 보존한 **ASSEMBLY 탭**(파트별 구분 색상)을 자동 생성 — 공유 좌표계로 내보낸 파트는 자동 조립.
  멀티파트 모델은 열릴 때 파트가 아래부터 하나씩 날아와 **조립되는 인트로 애니메이션**이 재생되고,
  **분해(explode) 뷰**를 트랙패드 핀치(벌리기 = 분해, 오므리기 = 재조립) 또는
  HANDS 모드에서 **양손 주먹을 쥐고 반대 방향으로 당기기/모으기**로 조절할 수 있다.
  표시 모드 4종: FULL(원본 재질) / COLOR(색상만) / TEXTURE(텍스처만) / WIREFRAME(메인 컬러 청록 와이어프레임).
  LIGHTS 토글(입체 조명 ↔ 균일 평면광) + KEY/AMBIENT/SHADOW 슬라이더, 오빗 컨트롤, 자동 스케일 정규화, 그리드 바닥.
  **HANDS 모드** — 웹캠 손 추적(MediaPipe Tasks HandLandmarker, GPU)으로 영화식 제스처 컨트롤:
  한 손 핀치 드래그 = 회전, 양손 핀치 = 줌/팬, 빠르게 날리며 핀치 해제 = 모멘텀 스핀(감쇠),
  핀치로 아래→위 직선 스트로크 후 유지 = Y축 잠금 / 왼→오른쪽 = X축 잠금 /
  **원을 그린 뒤 멈추고 유지 = Z축 잠금**(반대 손이 해당 축만 회전),
  양손 주먹을 세게 당기며 놓으면 분해가 관성으로 끝까지 진행.
  랜드마크 지수평활 + 60fps 보간 스켈레톤. 켜는 동안 Security-Protocol-1 워처를 깨끗하게 종료
  (launchctl bootout)해 카메라를 해제하고, 끄거나 앱 종료 시 자동 재기동
- **PROJECTS** — 앱 안에서 직접 관리하는 프로젝트 등록부. **+ NEW PROJECT** 버튼으로 HUD
  다이얼로그를 열어 이름 / 형식(SOFTWARE·HARDWARE·HYBRID) / 우선순위(LOW~CRIT) /
  **시작 상태(PLANNING·ACTIVE·PAUSED·DONE — 끝난 프로젝트도 바로 등록)** /
  설명 / 태그 / 목표일 / 링크를 입력해 등록. 목록에는 이름과 만든 날짜가 나란히 표시되고,
  형식 배지(색 구분)·태그·우선순위·**상태 칩**(클릭할 때마다 PLANNING → ACTIVE → PAUSED →
  DONE 순환, DONE은 흐리게)·목표일 **D-day 카운트다운**(임박 앰버, 초과 레드)이 함께 보인다.
  삭제는 오클릭 방지 2단계(✕ → SURE?). 링크는 기본 브라우저로 열림(http/https만).
  **행 우클릭 컨텍스트 메뉴**: RELOAD / **LINK WITH PANEL**(사이드바 패널 서브메뉴에서 선택해
  프로젝트-패널 연결, 연결되면 행에 ⇄ 칩 표시, UNLINK 가능) / **GO TO CONNECTED PANEL**
  (연결된 패널로 바로 이동, 미연결 시 비활성) / **EDITOR**.
  **EDITOR 모드**: 프로젝트 전용 편집 화면 — 상단 도구 버튼(현재 RENDER_3D)을 누르면
  해당 패널이 통째로 에디터 창에 이식되어 그 프로젝트의 3D 편집기로 동작, CLOSE 하면
  패널이 원위치로 복원 (도구는 계속 추가 예정).
  데이터는 `~/.omni/store/projects.json`에 저장 — 범용 store.read/write 브리지
  (이름 검증 + 폴더 한정)라 다른 패널 영속화에도 재사용 가능.
- **SYSTEM MONITOR** — 아이언맨 미션 컨트롤 스타일 실시간 시스템 대시보드 (1초 갱신, 패널이
  보일 때만 폴링). 네이티브 수집기(`macos/sysmon.m`, mach/sysctl/IOKit — 루트 불필요):
  **CPU** 전체·코어별 사용률(원호 게이지 + 코어 바, 부하별 색), **GPU** 사용률(IOAccelerator),
  **MEMORY** 사용률 게이지 + WIRED/APP/COMPRESSED/FREE 구성 바 + 메모리 압력,
  **DISK** 사용량 + 읽기/쓰기 속도 스파크라인(IOBlockStorageDriver),
  **NETWORK** 다운/업 속도 + 60초 스파크라인, **BATTERY** 잔량·충전 상태·건강도·사이클·남은 시간,
  **PROCESS TOP** CPU 상위 8개, 열 상태(THERMAL)·로드평균·업타임·macOS 버전.
  브라우저 개발 모드에서는 모의 지표로 렌더.
- **ARC-SCAN** — [arc-scan](https://github.com/geonhee15/arc-scan)(ESP32 + VL53L1X ToF 7개 회전 라이다)
  실시간 포인트 클라우드 뷰어. **FIND DEVICES**로 로컬 서브넷(/24)을 스캔해 포트 81이 열린 기기를
  찾고 웹소켓 핸드셰이크로 arc-scan 프로토콜인지 검증해 목록에 띄운다 — 클릭 한 번으로 연결
  (수동 IP 입력도 가능, 마지막 주소 기억). 웹소켓(포트 81)으로 `{a: 서보각, d: [7거리]}`를 받아
  마스트 틸트(±30°/10° 간격)와 구면좌표 변환으로 방을 3D 렌더링. 높이 그라데이션 색상,
  채널별 실시간 거리 리드아웃, 방위각 스윕 표시, 링버퍼 30만 포인트, 자동 재연결.
  START SCAN/STOP/CENTER 스캔 컨트롤, **SCAN ANALYTICS**(거리 히스토그램 + 평균·중앙값·σ·유효율·
  스윕 수 · 좌표 분포 퍼센타일 기반 **추정 방 크기 W×D×H**), 뷰 모드 3종 —
  **POINT / LINE / RETOUCH / PLAN을 독립 토글로 자유 조합** — LINE은 채널별 최신 스윕 등고선,
  RETOUCH는 방위각별 벽 반경 중앙값 + 미디언 스무딩으로 추정한 반투명 방 셸,
  **PLAN은 점유 격자(8×8m, 5cm 셀) 기반 2D 평면도 미니맵**(방 윤곽 + 면적 ㎡ 계산).
  평면도에서 **드래그로 영역 선택**(스크린샷 영역 지정처럼) — 선택한 부분만 3D 뷰에 표시
  (클리핑 평면으로 POINT/LINE/RETOUCH 전부 적용), 평면도 빈 곳 클릭으로 해제.
  **PLY 내보내기**(NSSavePanel 저장) 및 **→ RENDER_3D 원클릭 핸드오프** — 스캔을 그대로
  RENDER_3D 워크스페이스에 열어 오빗/제스처로 감상 (패널 간 연동).
  내보내기 소스 선택 3종: **POINT**(색상 포인트 클라우드) / **LINE**(최신 스윕 정점 + 엣지) /
  **RETOUCH**(추정 방 셸을 삼각형 면이 있는 진짜 메시로) — 영역 선택 중이면 POINT/LINE은 선택 부분만.
  **색상 모드 3종 + RESET**: **CUSTOM**(전용 **COLOR PLAN** 미니맵이 우하단에 떠서 —
  컬러 피커 + 프리셋 스와치 6종 포함 — 거기서 영역을 드래그하면 하이라이트 → 색을 고르면 그
  부분만 칠하기, 색 안 고르고 해제하면 원래 색 복원) / **DIST**(CH3 센서 기준 3D 거리
  파랑→초록→빨강 무지개) / **ORIGINAL**(원본 arc-scan 웹 뷰어의 높이 무지개, 0m 파랑→2.5m 빨강) /
  **RESET**(시그니처 HUD 홀로그램 램프로 복귀, 커스텀 페인트 초기화).
  색상 모드·페인트는 POINT뿐 아니라 **LINE·RETOUCH 레이어와 PLY 내보내기에도 동일 적용**.
  **자동 저장**: 💾 PLY가 `ARC-SCAN-SAVES/` 폴더에 바로 누적 저장(패널 없음), 툴바 **RECENT**에
  최근 3개가 칩으로 떠서 원클릭 리로드(스윕 그리드·점유 격자·통계까지 역추론 복원) + 📁 LOAD로
  임의 PLY 불러오기.
  **워크스페이스 탭**: RENDER_3D처럼 상단 탭으로 여러 스캔 동시 사용 — ◎ LIVE(실시간 스트림) +
  불러온 PLY마다 탭 생성(✕로 닫기), 다른 탭을 보는 동안에도 라이브 수집은 계속됨.
  각 탭이 독립된 통계·그리드·점유격자·페인트 로그를 가져 어느 스캔이든 색상 모드/페인팅/
  레이어/내보내기 전부 가능. **PLY 로드 강화**: POINT/LINE/RETOUCH 어떤 저장본이든 열림 —
  윤곽이 역추론되지 않는 파일(RETOUCH 리본 등)은 방위각별 최외곽 샘플로 CH3 윤곽·점유를
  합성해 LINE/RETOUCH/PLAN까지 살려냄. 뷰포트에 .ply **드래그&드롭**으로도 열기.
  **선택 분리**: FLOOR PLAN 드래그 = 영역 격리(그 부분만 3D 표시), COLOR PLAN 드래그 =
  페인트 선택 — 두 선택이 독립적으로 공존 (격리해 놓고 다른 영역 칠하기 가능).
  **떠 있는 패널 리사이즈**: SCAN ANALYTICS·채널 리드아웃·FLOOR PLAN·COLOR PLAN 네 오버레이 모두
  모서리 그립을 드래그해 크기 조절(캔버스는 새 해상도로 선명하게 재렌더링, 채널 바는 늘어남),
  더블클릭으로 기본 크기 복원, 크기는 localStorage에 저장되어 재시작 후에도 유지.
  앱에서는 네이티브 WebSocket 릴레이(NSURLSessionWebSocketTask) 사용 — omni:// 보안 컨텍스트에서
  평문 ws://가 차단되는 문제 회피. 브라우저 개발 모드는 JS WebSocket 폴백
- **CODE EDITOR** — VSCode 감성의 미니 코드 IDE. **OPEN FOLDER**(최근 폴더 자동 재오픈)로
  파일 트리(지연 로딩)를 열고, 파일 탭 + CodeMirror 에디터로 편집(Cmd+S 저장, 수정 표시 ●).
  구문 강조 13종: C/C++/Obj-C/Java·JS/TS·JSON·HTML·CSS·XML·Python·Shell·Markdown·
  YAML·Rust·Go·Swift·TOML. **진짜 PTY 터미널**(forkpty + zsh + xterm.js) — + TERM으로
  얼마든지 생성, 터미널 탭 전환·닫기·접기, 열린 폴더에서 시작, 256색·리사이즈 지원.
  **VSCode Dark+ 하이라이팅**: CODE EDITOR 전용 팔레트 — 키워드 퍼플, 임포트 모듈명·변수
  라이트블루, 함수 정의 옐로, 타입 틸, 문자열 오렌지, 숫자 연두, 주석 그린 등 토큰 전면 채색.
  **자동완성(IntelliSense 근사)**: 타이핑하면 커서 옆에 완성 팝업 — `p` → print/pass/pow…
  (키워드+내장함수+버퍼의 내 변수·함수, 접두사 우선 + 포함 매칭), `random.` → choice/choices/
  sample/shuffle… (파이썬 random/math/os/sys/json/re/datetime 등 + JS console/Math/JSON/
  document 등 모듈 멤버 사전, 미지의 객체엔 제네릭 메서드), 항목마다 출처 태그 표시,
  ↑↓/Enter/Tab 선택, Ctrl+Space 수동 호출. 전부 오프라인 내장 사전.
  **RUN 버튼**: 활성 파일을 자동 저장 후 터미널(없으면 자동 생성)에서 실행 —
  py/js/ts/sh/swift/go/rs/c/cpp/objc(-framework Foundation)/java/rb/php/pl/lua 러너 내장,
  html은 기본 브라우저로. 경로 공백·따옴표 셸 이스케이프 처리.
  **+ NEW FILE**: 이름을 안 넣으면 `Untitled.txt`(중복 시 자동 넘버링), 넣으면
  `이름.선택확장자` — 확장자 그룹 선택(TEXT/CODE/IMAGE/AUDIO/VIDEO 30여 종), 트리에서
  선택한 폴더에 생성되고 텍스트 계열은 바로 편집 탭으로 열림. **미디어 뷰어**: 이미지
  (체커보드 배경)·오디오·비디오 파일은 탭에서 뷰어로 열림 — omni:// 스킴 핸들러가
  열어둔 폴더 안의 파일만 서빙(MIME 매핑). 파일 접근은 열어둔 폴더 내부로 제한,
  바이너리/5MB 초과 가드(텍스트). 앱 종료 시 셸 세션 정리.
  PROJECTS 에디터 모드의 도구(RENDER_3D · ARDUINO IDE · CODE EDITOR)로도 이식 가능.
- **ARDUINO IDE** — Arduino IDE.app에 번들된 arduino-cli를 백엔드로 쓰는 임베디드 툴체인 패널.
  스케치북(~/Documents/Arduino) 목록·임의 .ino 선택, 보드 포트 스캔(FQBN 자동 감지 + ESP32/UNO/NANO/MEGA 칩),
  VERIFY(컴파일)/UPLOAD(컴파일+플래시) 스트리밍 출력 터미널, 라이브러리 검색·설치·설치 목록,
  **CODE 에디터**(CodeMirror, C++ 구문 강조 HUD 테마 — 스케치 선택 시 .ino/.h/.cpp 파일 탭으로 열림,
  Cmd+S 저장, VERIFY/UPLOAD 전 수정 파일 자동 저장, 쓰기는 열린 스케치 폴더로 제한),
  시리얼 모니터(보드레이트·포트 선택·송신, **열 때 ESP32 자동 리셋(DTR/RTS 펄스)으로 부팅 로그 재생** +
  RESET 버튼, 출력에서 IPv4 감지 시 **→ ARC-SCAN 원클릭 칩**으로 IP 전달·자동 연결), 시리얼 플로터("L:V" 또는 "V1 V2" 라인 자동 파싱, 6시리즈 오토스케일).
  네이티브 브리지: NSTask 스트리밍 잡 + POSIX termios 시리얼 세션. 업로드 시 모니터 자동 닫고 복구
- **SECURITY-PROTOCOL-1** — [Security-Protocol-1](https://github.com/geonhee15/Security-Protocol-1) 실시간 상태 대시보드
  - 시스템 상태 (LOCKDOWN / UNLOCKED / WATCHER OFFLINE) — protocol.log의 상태 마커로 판별.
    워처가 꺼져 있으면 **START WATCHER 버튼**으로 앱에서 바로 기동 (launchctl bootstrap / 앱 번들 실행)
  - 감시 프로세스(PID 검증), ntfy 서버 연결, 알림 프로바이더, 원격 제어, 자동 시작, 침입 스냅샷 수, 구성요소 점검
  - 이벤트 피드 (한국어 로그를 영어 라벨로 변환 표시)
  - **INTRUDER GALLERY** — 침입 스냅샷을 카테고리별(WRONG GESTURE / KEYBOARD / MOUSE / REMOTE SNAP)로
    필터링해 보는 갤러리. 네이티브에서 썸네일 생성(ImageIO, mtime 캐시), 클릭하면 원본 크기 라이트박스
  - **신경망 인물 분석** — 사진을 열면 [vladmandic/human](https://github.com/vladmandic/human)으로
    얼굴 박스·페이스 메시·나이·성별·감정·신체 포즈·자세 단서를 즉석 분석해 HUD 오버레이로 표시.
    라이브러리와 모델(`vendor/`, 약 16MB)은 앱에 번들되어 완전히 로컬에서 동작 — 사진이 기기 밖으로 나가지 않음.
    WKWebView에서 모델 fetch가 되도록 `omni://` 커스텀 URL 스킴으로 앱 리소스를 서빙
  - 네이티브 브리지(WKScriptMessageHandler)로 5초마다 갱신. topic·토큰·제스처 값은 브리지로 절대 내보내지 않음

## 구조

| 파일 | 역할 |
| --- | --- |
| `index.html` | 레이아웃 |
| `style.css` | HUD 테마 |
| `app.js` | `OmniOS` 코어 + 모듈 등록 시스템 |
| `macos/main.m` | 네이티브 맥 앱 래퍼 (WKWebView + JS 브리지) |
| `macos/sp1_status.m` | Security-Protocol-1 상태 수집 (프로세스/로그/설정/ntfy) |
| `macos/build.sh` | 앱 번들 빌드 스크립트 (아이콘 포함) |
| `macos/icon.svg` | 앱 아이콘 원본 |

## 앞으로

다른 앱들을 `OmniOS.register("이름", 모듈)` 방식으로 모듈로 등록해서 연동할 예정.
