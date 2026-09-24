#!/usr/bin/env bash
# Install the Laya pilot environment: torch (CPU-only) + the laya package.
#
# Run it as a tracked background job:
#   terminal(command="bash tools/laya/install.sh", background=true, notify_on_complete=true)
# Progress: tools/laya/install.log
#
# Notes learned on this machine:
#  - `uv` is NOT on the PATH inside a non-interactive bash script; use its absolute path.
#  - The only system Python is 3.14.5, which torch has no wheels for yet, so uv installs a
#    managed 3.12 for the venv.
set -u
cd "$(dirname "$0")/../.." || exit 1

UV="/c/Users/Aorus/AppData/Local/hermes/bin/uv.exe"
PY="tools/laya/.venv/Scripts/python.exe"
LOG="tools/laya/install.log"

{
  echo "=== $(date '+%F %T') install start ==="
  "$UV" --version

  echo "--- managed CPython 3.12 ---"
  "$UV" python install 3.12
  echo "python install exit=$?"

  echo "--- venv ---"
  rm -rf tools/laya/.venv
  "$UV" venv --python 3.12 tools/laya/.venv
  "$PY" --version

  echo "--- torch (CPU wheels, keeps the download small) ---"
  "$UV" pip install --python "$PY" torch --index-url https://download.pytorch.org/whl/cpu
  echo "torch exit=$?"

  echo "--- laya ---"
  "$UV" pip install --python "$PY" laya
  echo "laya exit=$?"

  echo "--- versions ---"
  "$PY" -c "import torch, laya; print('torch', torch.__version__); print('laya', getattr(laya,'__version__','?'))"
  echo "=== $(date '+%F %T') install done ==="
} >> "$LOG" 2>&1