#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
DIST_DIR="$PROJECT_DIR/dist"
APP_NAME="OpenRappter Bar"
BUNDLE_ID="com.openrappter.bar"
VERSION="${VERSION:-1.0.0}"

echo "==> Building OpenRappter Bar v${VERSION} (universal binary)..."

cd "$PROJECT_DIR"

# Build universal binary (arm64 + x86_64)
swift build -c release --arch arm64 --arch x86_64 --product OpenRappterBar

# Create .app bundle structure
APP_DIR="$DIST_DIR/$APP_NAME.app"
rm -rf "$APP_DIR"
mkdir -p "$APP_DIR/Contents/MacOS"
mkdir -p "$APP_DIR/Contents/Resources"

# Copy binary
BUILD_DIR=$(swift build -c release --arch arm64 --arch x86_64 --product OpenRappterBar --show-bin-path)
cp "$BUILD_DIR/OpenRappterBar" "$APP_DIR/Contents/MacOS/"

# Verify universal binary
echo "==> Verifying architectures..."
file "$APP_DIR/Contents/MacOS/OpenRappterBar"
lipo -info "$APP_DIR/Contents/MacOS/OpenRappterBar"

# Create Info.plist
cat > "$APP_DIR/Contents/Info.plist" << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleName</key>
    <string>${APP_NAME}</string>
    <key>CFBundleDisplayName</key>
    <string>${APP_NAME}</string>
    <key>CFBundleIdentifier</key>
    <string>${BUNDLE_ID}</string>
    <key>CFBundleVersion</key>
    <string>${VERSION}</string>
    <key>CFBundleShortVersionString</key>
    <string>${VERSION}</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleExecutable</key>
    <string>OpenRappterBar</string>
    <key>LSMinimumSystemVersion</key>
    <string>14.0</string>
    <key>LSUIElement</key>
    <true/>
    <key>NSHighResolutionCapable</key>
    <true/>
</dict>
</plist>
PLIST

echo "==> Built: $APP_DIR"

# Create DMG
DMG_NAME="OpenRappter-Bar-${VERSION}.dmg"
DMG_PATH="$DIST_DIR/$DMG_NAME"
DMG_STAGING="$DIST_DIR/dmg-staging"

rm -rf "$DMG_STAGING" "$DMG_PATH"
mkdir -p "$DMG_STAGING"

# Copy .app into staging
cp -R "$APP_DIR" "$DMG_STAGING/"

# Create Applications symlink for drag-to-install
ln -s /Applications "$DMG_STAGING/Applications"

# Create a README for Gatekeeper bypass
cat > "$DMG_STAGING/READ ME FIRST.txt" << 'README'
OpenRappter Bar — macOS Menu Bar Companion

FIRST LAUNCH (unsigned app):
  1. Drag "OpenRappter Bar" to Applications
  2. Right-click the app in Applications → Open
  3. Click "Open" in the Gatekeeper dialog
  4. Subsequent launches work normally from the menu bar

Requires: macOS 14 (Sonoma) or later
Gateway:  The app connects to the OpenRappter gateway at localhost:18790
README

# Create DMG via hdiutil
echo "==> Creating DMG..."
hdiutil create \
    -volname "OpenRappter Bar" \
    -srcfolder "$DMG_STAGING" \
    -ov \
    -format UDZO \
    "$DMG_PATH"

rm -rf "$DMG_STAGING"

echo "==> DMG created: $DMG_PATH"
echo "==> Size: $(du -h "$DMG_PATH" | cut -f1)"
echo "Done."
