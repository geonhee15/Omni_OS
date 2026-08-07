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
- **SECURITY-PROTOCOL-1** — [Security-Protocol-1](https://github.com/geonhee15/Security-Protocol-1) 실시간 상태 대시보드
  - 시스템 상태 (LOCKDOWN / UNLOCKED / WATCHER OFFLINE) — protocol.log의 상태 마커로 판별
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
