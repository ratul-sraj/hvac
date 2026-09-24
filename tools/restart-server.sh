#!/usr/bin/env bash
# Restart the LoadLens Express server cleanly. One command, no port race.
#   cd D:/webhvac && bash tools/restart-server.sh
#
# Why this exists: `node --watch` (and any plain restart while the old process is still
# shutting down) fails with EADDRINUSE on Windows, because the previous child keeps port
# 3000 briefly. So: stop whatever holds the port, wait for it to go, then start detached.
set -u

REPO="D:/webhvac"
PORT="${PORT:-3000}"
LOG="$REPO/tools/keepalive.log"
STAMP="$(date '+%Y-%m-%d %H:%M')"

cd "$REPO" || exit 1
mkdir -p tools

port_pids() {
  netstat -ano 2>/dev/null | grep LISTENING | grep ":${PORT} " | awk '{print $5}' | sort -u
}

# 1. stop anything listening on the port
PIDS="$(port_pids)"
if [ -n "$PIDS" ]; then
  for p in $PIDS; do
    taskkill /PID "$p" /F >/dev/null 2>&1 && echo "stopped pid $p"
  done
fi
for _ in $(seq 1 20); do
  [ -z "$(port_pids)" ] && break
  sleep 0.5
done

# 2. start it detached (survives this shell, so no Hermes process notice on exit)
( nohup node server.js >> "$LOG" 2>&1 & echo $! > tools/server.pid ) >/dev/null 2>&1

# 3. wait for it to answer
for _ in $(seq 1 20); do
  CODE="$(curl -s -m 4 -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PORT}/api/health" 2>/dev/null)"
  case "${CODE:0:3}" in
    200) break ;;
  esac
  sleep 0.5
done
CODE="${CODE:0:3}"

LISTENER="$(port_pids | head -1)"
echo "$LISTENER" > tools/server.pid
echo "${STAMP}  restart-server: listening pid ${LISTENER:-none}, health ${CODE}" >> "$LOG"

if [ "$CODE" = "200" ]; then
  echo "LoadLens is live at http://localhost:${PORT}/   (pid ${LISTENER})"
  curl -s -m 5 "http://127.0.0.1:${PORT}/api/health"
  echo
else
  echo "PROBLEM: the server did not come up (health ${CODE}). Last log lines:"
  tail -12 "$LOG"
  exit 1
fi
