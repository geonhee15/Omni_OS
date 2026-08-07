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

- 중앙 디지털 시계 (시간 / 날짜 / 업타임)
- 자비스 스타일 HUD (회전 링, 그리드, 스캔라인)

## 구조

| 파일 | 역할 |
| --- | --- |
| `index.html` | 레이아웃 |
| `style.css` | HUD 테마 |
| `app.js` | `OmniOS` 코어 + 모듈 등록 시스템 |
| `macos/main.m` | 네이티브 맥 앱 래퍼 (WKWebView) |
| `macos/build.sh` | 앱 번들 빌드 스크립트 (아이콘 포함) |
| `macos/icon.svg` | 앱 아이콘 원본 |

## 앞으로

다른 앱들을 `OmniOS.register("이름", 모듈)` 방식으로 모듈로 등록해서 연동할 예정.
