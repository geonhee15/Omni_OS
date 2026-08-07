#!/bin/bash
# OMNI_OS 맥 앱 빌드 스크립트
# 사용법: bash macos/build.sh  →  dist/Omni OS.app 생성
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$ROOT/dist/Omni OS.app"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/web"

# 1. 웹 리소스 복사
cp "$ROOT/index.html" "$ROOT/style.css" "$ROOT/app.js" "$APP/Contents/Resources/web/"

# 2. Info.plist
cp "$ROOT/macos/Info.plist" "$APP/Contents/"

# 3. 컴파일
clang -fobjc-arc -O2 "$ROOT/macos/main.m" \
  -o "$APP/Contents/MacOS/OmniOS" \
  -framework Cocoa -framework WebKit

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

echo "✓ 빌드 완료: $APP"
