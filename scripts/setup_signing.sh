#!/bin/bash
# 고정 코드서명 인증서 1회 설정 — "Omni Dev Signing"
#
# 왜 필요한가: ad-hoc 서명은 빌드마다 지문(CDHash)이 바뀌어 macOS 권한(TCC —
# 전체 디스크 접근, 손쉬운 접근 등)이 리빌드 때마다 풀린다. 자가서명 인증서로
# 서명하면 신원이 고정되어 권한이 계속 유지된다.
#
# 사용: bash scripts/setup_signing.sh   (중간에 macOS 암호 창이 뜰 수 있음)
set -euo pipefail

ID_NAME="Omni Dev Signing"

if security find-identity -p codesigning -v 2>/dev/null | grep -q "$ID_NAME"; then
  echo "이미 설정됨: $ID_NAME"
  exit 0
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
cd "$TMP"

cat > cfg <<'EOF'
[req]
distinguished_name=dn
x509_extensions=ext
prompt=no
[dn]
CN=Omni Dev Signing
[ext]
keyUsage=critical,digitalSignature
extendedKeyUsage=critical,codeSigning
basicConstraints=critical,CA:false
EOF

openssl req -x509 -newkey rsa:2048 -keyout key.pem -out cert.pem \
  -days 3650 -nodes -config cfg
openssl pkcs12 -export -out id.p12 -inkey key.pem -in cert.pem -passout pass:omnitemp

# 로그인 키체인에 개인키+인증서 등록 (codesign이 쓸 수 있게)
security import id.p12 -k ~/Library/Keychains/login.keychain-db \
  -P omnitemp -T /usr/bin/codesign

# 코드서명 용도로 신뢰 등록 (여기서 암호 확인 창이 뜰 수 있음)
security add-trusted-cert -p codeSign \
  -k ~/Library/Keychains/login.keychain-db cert.pem

echo ""
echo "완료. 확인:"
security find-identity -p codesigning -v | grep "$ID_NAME" || {
  echo "경고: identity가 아직 보이지 않습니다. 키체인 접근 앱에서 확인 필요."
  exit 1
}
echo ""
echo "다음: bash macos/build.sh 로 앱을 다시 빌드하면 이 인증서로 서명됩니다."
