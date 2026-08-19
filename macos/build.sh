#!/bin/bash
# OMNI_OS 맥 앱 빌드 스크립트
# 사용법: bash macos/build.sh  →  dist/Omni OS.app 생성
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# 프로젝트 폴더가 iCloud 동기화 대상이면 파일프로바이더가 확장 속성을 계속
# 붙여서 codesign이 거부된다 → 동기화되지 않는 임시 폴더에서 빌드/서명 후 복사
APP="$(mktemp -d)/Omni OS.app"
DEST="$ROOT/dist/Omni OS.app"

mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/web"

# 1. 웹 리소스 복사 (vendor: Human 라이브러리 + 모델)
cp "$ROOT/index.html" "$ROOT/style.css" "$ROOT/app.js" "$APP/Contents/Resources/web/"
cp -R "$ROOT/vendor" "$APP/Contents/Resources/web/vendor"

# 2. Info.plist
cp "$ROOT/macos/Info.plist" "$APP/Contents/"

# 3. 컴파일
clang -fobjc-arc -O2 "$ROOT/macos/main.m" "$ROOT/macos/sp1_status.m" "$ROOT/macos/arduino_bridge.m" "$ROOT/macos/sysmon.m" "$ROOT/macos/code_editor.m" "$ROOT/macos/omni_ai.m" \
  -o "$APP/Contents/MacOS/OmniOS" \
  -framework Cocoa -framework WebKit -framework ImageIO -framework CoreGraphics -framework IOKit \
  -framework Speech -framework AVFoundation -lsqlite3

# 4. 아이콘 (icon.svg → AppIcon.icns)
ICONSET="$(mktemp -d)/AppIcon.iconset"
mkdir -p "$ICONSET"
qlmanage -t -s 1024 -o "$(dirname "$ICONSET")" "$ROOT/macos/icon.svg" >/dev/null
BASE="$(dirname "$ICONSET")/icon.svg.png"
for size in 16 32 64 128 256 512; do
  sips -z $size $size "$BASE" --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
  sips -z $((size * 2)) $((size * 2)) "$BASE" --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/AppIcon.icns"

# 5. 서명 (확장 속성이 남아 있으면 서명이 거부되므로 먼저 제거)
# 고정 인증서("Omni Dev Signing", scripts/setup_signing.sh로 1회 생성)가 있으면
# 그걸로 서명 — TCC 권한(전체 디스크 접근·손쉬운 접근)이 리빌드에도 유지된다.
# 없으면 ad-hoc 폴백 (권한이 빌드마다 풀림)
xattr -cr "$APP"
SIGN_ID="Omni Dev Signing"
if security find-identity -p codesigning -v 2>/dev/null | grep -q "$SIGN_ID"; then
  codesign --force --deep --sign "$SIGN_ID" "$APP"
  echo "서명: $SIGN_ID (고정 신원 — TCC 권한 유지)"
else
  codesign --force --deep --sign - "$APP"
  echo "서명: ad-hoc (권한이 리빌드마다 풀림 — scripts/setup_signing.sh 권장)"
fi

# 6. dist/로 복사
rm -rf "$DEST"
mkdir -p "$ROOT/dist"
ditto "$APP" "$DEST"
rm -rf "$(dirname "$APP")"

echo "✓ 빌드 완료: $DEST"
