#!/bin/bash
set -euo pipefail

VERSION="${VERSION:-0.0.0}"
if [[ ! "$VERSION" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]; then
    printf 'VERSION must match X.Y.Z exactly (received %q)\n' "$VERSION" >&2
    exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
DIST_DIR="$PROJECT_DIR/dist"
APP_NAME="OpenRappter Bar"
BUNDLE_ID="com.openrappter.bar"

echo "==> Building OpenRappter Bar v${VERSION} (universal binary)..."

cd "$PROJECT_DIR"

# Build universal binary — build each arch separately then lipo merge
# (--arch arm64 --arch x86_64 in a single swift build uses xcodebuild
# which has issues with swiftLanguageMode in Package.swift)
swift build -c release --arch arm64 --product OpenRappterBar
swift build -c release --arch x86_64 --product OpenRappterBar

ARM_BIN=$(swift build -c release --arch arm64 --product OpenRappterBar --show-bin-path)/OpenRappterBar
X86_BIN=$(swift build -c release --arch x86_64 --product OpenRappterBar --show-bin-path)/OpenRappterBar

# Create .app bundle structure
APP_DIR="$DIST_DIR/$APP_NAME.app"
rm -rf "$APP_DIR"
mkdir -p "$APP_DIR/Contents/MacOS"
mkdir -p "$APP_DIR/Contents/Resources"

# Copy binary — lipo merge into universal
lipo -create "$ARM_BIN" "$X86_BIN" -output "$APP_DIR/Contents/MacOS/OpenRappterBar"

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
    <key>CFBundleURLTypes</key>
    <array>
        <dict>
            <key>CFBundleURLName</key>
            <string>${BUNDLE_ID}</string>
            <key>CFBundleURLSchemes</key>
            <array>
                <string>openrappter</string>
            </array>
        </dict>
    </array>
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

if [ -n "${CODESIGN_IDENTITY:-}" ]; then
    CODESIGN_IDENTITY="$CODESIGN_IDENTITY" bash "$SCRIPT_DIR/codesign-mac-app.sh"
elif [ "${REQUIRE_SIGNING:-0}" = "1" ]; then
    echo "Error: release build requires CODESIGN_IDENTITY." >&2
    exit 1
fi

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

# Include installation instructions that reflect the artifact's trust state.
if [ -n "${CODESIGN_IDENTITY:-}" ]; then
    cat > "$DMG_STAGING/READ ME FIRST.txt" << 'README'
OpenRappter Bar — macOS Menu Bar Companion

INSTALL:
  1. Drag "OpenRappter Bar" to Applications
  2. Launch it normally from Applications
  3. The dinosaur icon appears in the menu bar

Requires: macOS 14 (Sonoma) or later
Gateway:  The app connects to the OpenRappter gateway at localhost:18790
README
else
    cat > "$DMG_STAGING/READ ME FIRST.txt" << 'README'
OpenRappter Bar — Local Unsigned Build

This image was built without a Developer ID identity and is intended only for
local development. Public release images are signed and notarized by Apple.
README
fi

# Create DMG via hdiutil
echo "==> Creating DMG..."
hdiutil create \
    -volname "OpenRappter Bar" \
    -srcfolder "$DMG_STAGING" \
    -ov \
    -format UDZO \
    "$DMG_PATH"

rm -rf "$DMG_STAGING"

if [ -n "${CODESIGN_IDENTITY:-}" ]; then
    echo "==> Signing DMG..."
    codesign --force --timestamp --sign "$CODESIGN_IDENTITY" "$DMG_PATH"
    codesign --verify --strict --verbose=2 "$DMG_PATH"
fi

echo "==> DMG created: $DMG_PATH"
echo "==> Size: $(du -h "$DMG_PATH" | cut -f1)"
echo "Done."
