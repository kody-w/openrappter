#!/bin/sh
# Run the pinned grail kernel in its own home on its own port. Never touches any other Brainstem
# (the grail's install.sh stops whatever holds :7071, so this script does not use the installer).
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
# Apple's placeholders open a dialog rather than run on a new Mac. Never let KeepAlive repeat it.
PYTHON=$(command -v python3 || true)
GIT=$(command -v git || true)
if [ -z "$PYTHON" ] || [ -z "$GIT" ] ||
   { { [ "$PYTHON" = /usr/bin/python3 ] || [ "$GIT" = /usr/bin/git ]; } && ! /usr/bin/xcode-select -p >/dev/null 2>&1; }; then
    echo "I need Apple's tools. Open OpenRappter and choose Install." >&2
    sleep 60
    exit 78
fi
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
VENV="$KHOME/env-$SHA"
if [ ! -f "$VENV/.ready" ] || ! "$VENV/bin/python" -m pip --version >/dev/null 2>&1; then
    mkdir -p "$KHOME/environments"
    BUILD=$(mktemp -d "$KHOME/environments/build.XXXXXX")
    trap 'rm -rf "$BUILD"' EXIT HUP INT TERM
    python3 -m venv "$BUILD"
    "$BUILD/bin/python" -m pip install -q -r "$SRC/requirements.txt"
    touch "$BUILD/.ready"
    # Keep installed command shebangs valid: publish a link, never relocate the completed environment.
    trap - EXIT HUP INT TERM
    LINK="$KHOME/.env-link-$$"
    ln -s "$BUILD" "$LINK"
    # Preserve a broken old copy, but never trust or reuse a half-installed environment.
    if [ -e "$VENV" ]; then mv "$VENV" "$VENV-incomplete-$$"; fi
    mv "$LINK" "$VENV"
fi
[ -f "$SRC/.env" ] || sed "s/^PORT=.*/PORT=$PORT/" "$SRC/.env.example" > "$SRC/.env"
cd "$SRC"
echo "[openrappter] kernel $SHA on 127.0.0.1:$PORT home $KHOME"
PORT="$PORT" exec "$VENV/bin/python" brainstem.py
