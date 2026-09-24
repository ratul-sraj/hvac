#!/usr/bin/env bash
# LoadLens housekeeping: git backup + keep the Express server alive.
# Run by hand or by the Hermes cron job "webhvac-backup-keepalive".
# Log: tools/keepalive.log
set -u

REPO="D:/webhvac"
PORT="${PORT:-3000}"
HEALTH="http://127.0.0.1:${PORT}/api/health"
LOG="$REPO/tools/keepalive.log"
STAMP="$(date '+%Y-%m-%d %H:%M')"

cd "$REPO" || { echo "cannot cd to $REPO"; exit 1; }
mkdir -p tools

# ---------------------------------------------------------------- 1. git backup
if [ -n "$(git status --porcelain)" ]; then
  git add -A
  if git -c user.name="ratul-sraj" -c user.email="ratul-sraj@users.noreply.github.com" \
       commit -q -m "backup: automatic snapshot ${STAMP}

Co-authored-by: Hermes Agent <hermes-agent@nousresearch.com>"; then
    if GIT_SSH_COMMAND="ssh -i ${HOME}/.ssh/hvac_deploy -o IdentitiesOnly=yes" \
         git push -q git@github.com:ratul-sraj/hvac.git HEAD:main 2>>"$LOG"; then
      echo "${STAMP}  backup: committed and pushed" >> "$LOG"
      echo "LoadLens backup: committed and pushed to GitHub (${STAMP})"
    else
      echo "${STAMP}  backup: committed locally, PUSH FAILED" >> "$LOG"
    echo "PROBLEM: LoadLens backup committed locally but the git push FAILED (${STAMP})"
    fi
  else
    echo "${STAMP}  backup: commit failed" >> "$LOG"
  fi
fi

# ------------------------------------------------------------ 2. server keepalive
# note: curl on this host can exit 23 after printing the code, so take the first 3 chars
CODE="$(curl -s -m 6 -o /dev/null -w '%{http_code}' "$HEALTH" 2>/dev/null)"
CODE="${CODE:0:3}"; [ -n "$CODE" ] || CODE="000"
if [ "$CODE" != "200" ]; then
  # free the port first: a leftover listener makes the new process die with EADDRINUSE
  for p in $(netstat -ano 2>/dev/null | grep LISTENING | grep ":${PORT} " | awk '{print $5}' | sort -u); do
    taskkill /PID "$p" /F >/dev/null 2>&1
  done
  sleep 1
  ( nohup node server.js >> "$LOG" 2>&1 & echo $! > tools/server.pid ) >/dev/null 2>&1
  sleep 2
  NEW="$(curl -s -m 6 -o /dev/null -w '%{http_code}' "$HEALTH" 2>/dev/null)"
  NEW="${NEW:0:3}"; [ -n "$NEW" ] || NEW="000"
  echo "${STAMP}  server: was ${CODE}, restarted (pid $(cat tools/server.pid 2>/dev/null)) -> ${NEW}" >> "$LOG"
  if [ "$NEW" = "200" ]; then
    echo "LoadLens server was down (${CODE}) and has been restarted - live again at http://localhost:${PORT}/ (${STAMP})"
  else
    echo "PROBLEM: LoadLens server was down (${CODE}) and did NOT come back after a restart (now ${NEW}) - check tools/keepalive.log"
  fi
else
  echo "${STAMP}  server: ok (200)" >> "$LOG"
fi
