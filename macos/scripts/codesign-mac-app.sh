#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
DIST_DIR="$PROJECT_DIR/dist"
APP_NAME="OpenRappter Bar"
APP_DIR="$DIST_DIR/$APP_NAME.app"

# Use CODESIGN_IDENTITY env var, or ad-hoc signing by default
IDENTITY="${CODESIGN_IDENTITY:--}"

if [ ! -d "$APP_DIR" ]; then
    echo "Error: $APP_DIR not found. Run build-mac-app.sh first."
    exit 1
fi

echo "Codesigning with identity: $IDENTITY"

codesign --force --deep --sign "$IDENTITY" \
    --options runtime \
    --entitlements /dev/null \
    "$APP_DIR"

echo "Verifying..."
codesign --verify --deep --strict "$APP_DIR"

echo "Codesigning complete."
