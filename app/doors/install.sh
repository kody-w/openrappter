#!/usr/bin/env bash
# Puts rappter-door + rappter_doors.py in ~/bin (copies; re-run after an update).
set -euo pipefail; HERE="$(cd "$(dirname "$0")" && pwd)"; mkdir -p "$HOME/bin"
cp "$HERE/rappter-door" "$HERE/rappter-doors-mcp" "$HERE/rappter_doors.py" "$HOME/bin/"; cp "$HERE/../../contracts/doors.md" "$HOME/bin/doors.md"
chmod +x "$HOME/bin/rappter-door" "$HOME/bin/rappter-doors-mcp"
echo "installed: $HOME/bin/rappter-door $HOME/bin/rappter-doors-mcp"
