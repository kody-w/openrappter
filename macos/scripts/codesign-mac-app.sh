#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
DIST_DIR="$PROJECT_DIR/dist"
APP_NAME="OpenRappter Bar"
APP_DIR="$DIST_DIR/$APP_NAME.app"

IDENTITY="${CODESIGN_IDENTITY:-}"

if [ ! -d "$APP_DIR" ]; then
    echo "Error: $APP_DIR not found. Run build-mac-app.sh first."
    exit 1
fi

if [ -z "$IDENTITY" ] || [ "$IDENTITY" = "-" ]; then
    echo "Error: CODESIGN_IDENTITY must name a Developer ID Application identity." >&2
    exit 1
fi

echo "Codesigning with identity: $IDENTITY"

codesign --force --sign "$IDENTITY" \
    --options runtime \
    --timestamp \
    "$APP_DIR"

echo "Verifying..."
codesign --verify --deep --strict --verbose=2 "$APP_DIR"

echo "Codesigning complete."
