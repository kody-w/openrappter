#!/bin/sh
# Run the pinned grail kernel in its own home on its own port. Never touches any other Brainstem
# (the grail's install.sh stops whatever holds :7071, so this script does not use the installer).
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
SHA=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["sha"])' "$HERE/kernel.json")
REPO=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["repo"])' "$HERE/kernel.json")
KHOME="${OPENRAPPTER_KERNEL_HOME:-$HOME/.openrappter/kernel}"
PORT="${OPENRAPPTER_KERNEL_PORT:-18790}"
mkdir -p "$KHOME"
if [ ! -d "$KHOME/src/.git" ]; then git clone -q "$REPO" "$KHOME/src"; fi
git -C "$KHOME/src" cat-file -e "$SHA^{commit}" 2>/dev/null || git -C "$KHOME/src" fetch -q origin
git -C "$KHOME/src" checkout -q --detach "$SHA"
[ "$(git -C "$KHOME/src" rev-parse HEAD)" = "$SHA" ] || { echo "kernel pin mismatch" >&2; exit 2; }
SRC="$KHOME/src/rapp_brainstem"
[ -x "$KHOME/venv/bin/python" ] || python3 -m venv "$KHOME/venv"
"$KHOME/venv/bin/pip" install -q -r "$SRC/requirements.txt"
[ -f "$SRC/.env" ] || sed "s/^PORT=.*/PORT=$PORT/" "$SRC/.env.example" > "$SRC/.env"
cd "$SRC"
echo "[openrappter] kernel $SHA on 127.0.0.1:$PORT home $KHOME"
PORT="$PORT" exec "$KHOME/venv/bin/python" brainstem.py
