#!/bin/sh
# mausbridge: one double-click start (see make-launcher.sh). Starts the harness server and the web app
# when they are not already listening, then opens the Electron desktop shell, which in an unpackaged
# checkout talks to those two instead of starting its own server. Everything keeps running after this
# script exits; logs go to ~/.openmausbot/mausbridge/logs.
cd "$(dirname "$0")/../.." || exit 1
. scripts/mausbridge/env.sh
logs="${OMB_DATA_DIR:-$HOME/.openmausbot}/mausbridge/logs"
mkdir -p "$logs"
listening() { lsof -nP -iTCP:"$1" -sTCP:LISTEN -t >/dev/null 2>&1; }

listening 8799 || nohup scripts/mausbridge/start-server.sh >>"$logs/server.log" 2>&1 &
listening 5199 || nohup pnpm dev >>"$logs/web.log" 2>&1 &
for _ in $(seq 1 120); do
  listening 8799 && listening 5199 && break
  sleep 1
done
if ! listening 8799 || ! listening 5199; then
  osascript -e 'display alert "OpenMausBot 没能启动" message "服务两分钟内没有就绪。日志在 ~/.openmausbot/mausbridge/logs 里。"'
  exit 1
fi

# The shell keeps one window; a second launch only brings it forward.
if pgrep -f "$PWD/node_modules/electron/dist/Electron.app" >/dev/null; then
  osascript -e 'tell application "Electron" to activate' >/dev/null 2>&1
else
  nohup node_modules/.bin/electron . >>"$logs/desktop.log" 2>&1 &
fi
