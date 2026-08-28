#!/bin/bash
# 오미니아용 로컬 LLM 서버(Ollama) 자동 시작 등록 — 1회 실행
#
# 로그인할 때마다 `ollama serve`가 자동으로 뜨고, 죽으면 다시 살아난다.
# 오미니아(OMNI_OS)가 127.0.0.1:11434로 붙는다.
#
# 사용:  bash scripts/setup_ollama_agent.sh
# 해제:  launchctl bootout gui/$(id -u)/com.omni.ollama
#        rm ~/Library/LaunchAgents/com.omni.ollama.plist
set -euo pipefail

LABEL="com.omni.ollama"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
OLLAMA="$(command -v ollama || echo /opt/homebrew/bin/ollama)"

if [ ! -x "$OLLAMA" ]; then
  echo "ollama를 찾을 수 없습니다. 먼저 설치하십시오: brew install ollama"
  exit 1
fi

mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>$LABEL</string>
	<key>ProgramArguments</key>
	<array>
		<string>$OLLAMA</string>
		<string>serve</string>
	</array>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<true/>
	<key>ThrottleInterval</key>
	<integer>10</integer>
	<key>StandardOutPath</key>
	<string>/tmp/omni_ollama.out</string>
	<key>StandardErrorPath</key>
	<string>/tmp/omni_ollama.err</string>
	<key>EnvironmentVariables</key>
	<dict>
		<key>PATH</key>
		<string>/opt/homebrew/bin:/usr/bin:/bin:/usr/local/bin</string>
		<key>OLLAMA_HOST</key>
		<string>127.0.0.1:11434</string>
		<key>OLLAMA_KEEP_ALIVE</key>
		<string>30m</string>
	</dict>
</dict>
</plist>
PLISTEOF

# 이미 떠 있는 수동 인스턴스는 정리 (포트 충돌 방지)
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
pkill -f "ollama serve" 2>/dev/null || true
sleep 1

launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl enable "gui/$(id -u)/$LABEL"

echo "등록됨: $LABEL"
for i in $(seq 1 15); do
  if curl -s --max-time 2 http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then
    echo "✓ Ollama 서버 응답 확인 (127.0.0.1:11434)"
    exit 0
  fi
  sleep 1
done
echo "경고: 서버가 아직 응답하지 않습니다. /tmp/omni_ollama.err 확인"
exit 1
