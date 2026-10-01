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

# ------------------------------------------------- 1. git snapshot  (SAFE — never main)
# This used to run `git add -A` + a commit + `git push HEAD:main` on a 20-minute timer. Pushing to
# main triggers BOTH deploy workflows, so a cron snapshot of whatever was lying around became an
# unreviewed production deploy — and it once committed MID-WORK, capturing another process's
# half-finished tree (e0579f2, 2b6de82).
#
# Rules now:
#   * A dirty tree means edits are in flight (a worker, an editor, a review wave). The default is
#     to SKIP the whole snapshot: no `git add`, no commit, no push. The server keepalive below
#     still runs — that is this job's primary purpose.
#   * If a snapshot is ever explicitly wanted, KEEPALIVE_BACKUP=1 takes it NON-destructively:
#     `git stash create` never stages and never touches the working tree, and the resulting commit
#     is pushed to a dedicated ref (refs/keepalive/snapshots/<stamp>) — never a branch, never main,
#     so it cannot trigger a deploy or disturb anything mid-edit.
#   * main is never pushed from here, under any flag.
KEEPALIVE_REMOTE="git@github.com:ratul-sraj/hvac.git"
KEEPALIVE_REF="refs/keepalive/snapshots"
DIRTY="$(git status --porcelain)"
if [ -n "$DIRTY" ]; then
  DIRTY_N="$(printf '%s\n' "$DIRTY" | wc -l | tr -d ' ')"
  if [ "${KEEPALIVE_BACKUP:-0}" = "1" ]; then
    SNAP="$(git stash create "keepalive snapshot ${STAMP}" 2>/dev/null)"
    if [ -n "$SNAP" ]; then
      REF="${KEEPALIVE_REF}/$(date '+%Y%m%d-%H%M%S')"
      if GIT_SSH_COMMAND="ssh -i ${HOME}/.ssh/hvac_deploy -o IdentitiesOnly=yes" \
           git push -q "$KEEPALIVE_REMOTE" "+${SNAP}:${REF}" 2>>"$LOG"; then
        echo "${STAMP}  backup: snapshot ${SNAP:0:10} pushed to ${REF} (not main)" >> "$LOG"
        echo "LoadLens backup: snapshot pushed to ${REF} (never main) (${STAMP})"
      else
        echo "${STAMP}  backup: snapshot ${SNAP:0:10} kept locally, push to ${REF} FAILED" >> "$LOG"
        echo "PROBLEM: LoadLens backup snapshot was created but its push FAILED (${STAMP})"
      fi
    else
      echo "${STAMP}  backup: git stash create produced nothing" >> "$LOG"
    fi
  else
    # Expected during active work: silent on stdout (no_agent delivers stdout verbatim), recorded
    # once in the log so the reason a snapshot was skipped is always recoverable.
    echo "${STAMP}  backup: SKIPPED — working tree dirty (${DIRTY_N} path(s) with edits in flight); no commit, no push to main" >> "$LOG"
  fi
else
  echo "${STAMP}  backup: working tree clean — nothing to snapshot" >> "$LOG"
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
