#!/usr/bin/env bash
# Puts rappter-door + rappter_doors.py in ~/bin (copies; re-run after an update).
set -euo pipefail; HERE="$(cd "$(dirname "$0")" && pwd)"; mkdir -p "$HOME/bin"
cp "$HERE/rappter-door" "$HERE/rappter_doors.py" "$HOME/bin/"; chmod +x "$HOME/bin/rappter-door"
echo "installed: $HOME/bin/rappter-door"
