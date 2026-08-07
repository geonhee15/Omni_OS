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

# 1. 웹 리소스 복사
cp "$ROOT/index.html" "$ROOT/style.css" "$ROOT/app.js" "$APP/Contents/Resources/web/"

# 2. Info.plist
cp "$ROOT/macos/Info.plist" "$APP/Contents/"

# 3. 컴파일
clang -fobjc-arc -O2 "$ROOT/macos/main.m" "$ROOT/macos/sp1_status.m" \
  -o "$APP/Contents/MacOS/OmniOS" \
  -framework Cocoa -framework WebKit -framework ImageIO -framework CoreGraphics

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

# 5. ad-hoc 서명 (확장 속성이 남아 있으면 서명이 거부되므로 먼저 제거)
xattr -cr "$APP"
codesign --force --deep --sign - "$APP"

# 6. dist/로 복사
rm -rf "$DEST"
mkdir -p "$ROOT/dist"
ditto "$APP" "$DEST"
rm -rf "$(dirname "$APP")"

echo "✓ 빌드 완료: $DEST"
