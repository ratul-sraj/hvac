#!/usr/bin/env bash
# Turn the screencast frames into the square ad. Kept in the repo (not in a scratch dir) so a re-shoot
# is reproducible: the drawtext filter segfaults in this MSYS ffmpeg build, so the end card is an HTML
# page screenshotted by the browser instead of drawtext text.
#
#   bash tools/reel/encode.sh <reel-dir>
set -euo pipefail
DIR="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/infra/.tmp/reel}"
cd "$DIR"

[ -f frames/f00001.jpg ] || { echo "no frames in $DIR/frames - run tools/reel/demo-reel.mjs first" >&2; exit 1; }
[ -f endcard.png ]       || { echo "no endcard.png in $DIR - run tools/reel/endcard.mjs first" >&2; exit 1; }

echo "  frames -> video"
ffmpeg -y -loglevel error -framerate 10 -i frames/f%05d.jpg \
  -c:v libx264 -preset medium -crf 20 -pix_fmt yuv420p loadlens-demo.mp4

echo "  end card -> clip"
ffmpeg -y -loglevel error -loop 1 -t 3.5 -i endcard.png -r 25 \
  -c:v libx264 -preset medium -crf 20 -pix_fmt yuv420p endcard.mp4

echo "  concatenate"
printf "file 'loadlens-demo.mp4'\nfile 'endcard.mp4'\n" > list.txt
ffmpeg -y -loglevel error -f concat -safe 0 -i list.txt \
  -c:v libx264 -preset medium -crf 20 -pix_fmt yuv420p loadlens-ad.mp4

echo "  also keep a few stills for the ad images"
for t in 4 9 13; do ffmpeg -y -loglevel error -ss "$t" -i loadlens-ad.mp4 -frames:v 1 -q:v 3 "still-$t.jpg"; done

ffprobe -v error -select_streams v:0 -show_entries stream=width,height,duration \
  -show_entries format=duration,size -of default=nw=1 loadlens-ad.mp4 | sed 's/^/    /'
