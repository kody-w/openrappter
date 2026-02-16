#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
DIST_DIR="$PROJECT_DIR/dist"
APP_NAME="OpenRappter Bar"
APP_DIR="$DIST_DIR/$APP_NAME.app"
DMG_NAME="OpenRappterBar"
VERSION="1.0.0"
DMG_PATH="$DIST_DIR/$DMG_NAME-$VERSION.dmg"

if [ ! -d "$APP_DIR" ]; then
    echo "Error: $APP_DIR not found. Run build-mac-app.sh first."
    exit 1
fi

# Remove existing DMG
rm -f "$DMG_PATH"

# Create temporary DMG directory
TEMP_DIR=$(mktemp -d)
cp -R "$APP_DIR" "$TEMP_DIR/"

# Create Applications symlink for drag-and-drop install
ln -s /Applications "$TEMP_DIR/Applications"

echo "Creating DMG..."

hdiutil create \
    -volname "$APP_NAME" \
    -srcfolder "$TEMP_DIR" \
    -ov \
    -format UDZO \
    "$DMG_PATH"

# Cleanup
rm -rf "$TEMP_DIR"

echo "Created: $DMG_PATH"
echo "Done."
