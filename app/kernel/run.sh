#!/bin/sh
# Run the pinned grail kernel in its own home on its own port. Never touches any other Brainstem
# (the grail's install.sh stops whatever holds :7071, so this script does not use the installer).
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
KHOME="${OPENRAPPTER_KERNEL_HOME:-$HOME/.openrappter/kernel}"
PORT="${OPENRAPPTER_KERNEL_PORT:-18790}"
mkdir -p "$KHOME/logs"
LAST_ERROR="$KHOME/logs/last-error.txt"

# One plain sentence for the person, on stderr and in last-error.txt (the app shows it). Exit 3 = cannot start here.
fail() { echo "$1" >&2; printf '%s\n' "$1" > "$LAST_ERROR"; exit 3; }

# Apple's command line tools: without them /usr/bin/git and /usr/bin/python3 are stubs that pop an install dialog
# every time launchd restarts us. Check before running either of them.
xcode-select -p >/dev/null 2>&1 || fail "OpenRappter needs Apple's command line tools: run xcode-select --install"
git --version >/dev/null 2>&1 || fail "OpenRappter needs Apple's command line tools: run xcode-select --install"
python3 -c 'import sys' >/dev/null 2>&1 || fail "OpenRappter needs Apple's command line tools: run xcode-select --install"

# Something else on our port? A Brainstem answers JSON on GET /health; anything else means we cannot bind.
if python3 -c 'import socket,sys; s=socket.socket(); s.settimeout(1); sys.exit(0 if s.connect_ex(("127.0.0.1",int(sys.argv[1])))==0 else 1)' "$PORT" 2>/dev/null; then
  if curl -fsS --max-time 3 "http://127.0.0.1:$PORT/health" 2>/dev/null | python3 -c 'import json,sys; json.load(sys.stdin)' 2>/dev/null; then
    echo "[openrappter] a Brainstem already answers on 127.0.0.1:$PORT; nothing to start"
    exit 0
  fi
  fail "Something else on this Mac is already using port $PORT, so OpenRappter cannot start its kernel there"
fi

SHA=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["sha"])' "$HERE/kernel.json")
REPO=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["repo"])' "$HERE/kernel.json")
if [ ! -d "$KHOME/src/.git" ]; then
  git clone -q "$REPO" "$KHOME/src" || { rm -rf "$KHOME/src"; fail "OpenRappter could not reach the internet to fetch its kernel; connect and it will try again"; }
fi
git -C "$KHOME/src" cat-file -e "$SHA^{commit}" 2>/dev/null || git -C "$KHOME/src" fetch -q origin || fail "OpenRappter could not reach the internet to fetch its kernel; connect and it will try again"
git -C "$KHOME/src" checkout -q --detach "$SHA"
[ "$(git -C "$KHOME/src" rev-parse HEAD)" = "$SHA" ] || { echo "kernel pin mismatch" >&2; exit 2; }
SRC="$KHOME/src/rapp_brainstem"
[ -x "$KHOME/venv/bin/python" ] || python3 -m venv "$KHOME/venv"
"$KHOME/venv/bin/pip" install -q -r "$SRC/requirements.txt"
[ -f "$SRC/.env" ] || sed "s/^PORT=.*/PORT=$PORT/" "$SRC/.env.example" > "$SRC/.env"
cd "$SRC"
rm -f "$LAST_ERROR"
echo "[openrappter] kernel $SHA on 127.0.0.1:$PORT home $KHOME"
PORT="$PORT" exec "$KHOME/venv/bin/python" brainstem.py
