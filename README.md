# OMNI_OS

자비스(J.A.R.V.I.S.) 스타일의 파란색 HUD 인터페이스를 가진 개인용 대시보드 앱.
이름만 OS일 뿐, 실제로는 맥 앱이다. UI는 웹 기술(HTML/CSS/JS)로 만들고
네이티브 래퍼(Objective-C + WKWebView)로 감싼 구조.

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
- **ARC-SCAN** — [arc-scan](https://github.com/geonhee15/arc-scan)(ESP32 + VL53L1X ToF 7개 회전 라이다)
  실시간 포인트 클라우드 뷰어. **FIND DEVICES**로 로컬 서브넷(/24)을 스캔해 포트 81이 열린 기기를
  찾고 웹소켓 핸드셰이크로 arc-scan 프로토콜인지 검증해 목록에 띄운다 — 클릭 한 번으로 연결
  (수동 IP 입력도 가능, 마지막 주소 기억). 웹소켓(포트 81)으로 `{a: 서보각, d: [7거리]}`를 받아
  마스트 틸트(±30°/10° 간격)와 구면좌표 변환으로 방을 3D 렌더링. 높이 그라데이션 색상,
  채널별 실시간 거리 리드아웃, 방위각 스윕 표시, 링버퍼 30만 포인트, 자동 재연결.
  앱에서는 네이티브 WebSocket 릴레이(NSURLSessionWebSocketTask) 사용 — omni:// 보안 컨텍스트에서
  평문 ws://가 차단되는 문제 회피. 브라우저 개발 모드는 JS WebSocket 폴백
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
