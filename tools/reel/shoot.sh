#!/usr/bin/env bash
# Re-shoot the LoadLens demo ad end to end: record the live app, then encode the 1080x1080 ad.
#
#   bash tools/reel/shoot.sh
#
# Story: the house plan first (auto-fill visibly fills 6 of 10 rooms), then the office sheet at real
# scale (21 of 56), then the summary cards. Scripted, so a re-shoot after any UI change is one command.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT="$REPO_ROOT/infra/.tmp/reel"
cd "$REPO_ROOT"

echo "==> recording the live app (needs the browser, ~60 s)"
node tools/reel/demo-reel.mjs

echo "==> end card still"
node tools/reel/endcard.mjs

echo "==> encoding"
bash tools/reel/encode.sh "$OUT"

echo
echo "  ad:    $OUT/loadlens-ad.mp4"
echo "  stills: $OUT/check-*.jpg (grab frames with ffmpeg if the ad needs images)"
