#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
REPOSITORY_DIR="$(dirname "$PROJECT_DIR")"
SOURCE_VERSION="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$REPOSITORY_DIR/typescript/package.json")"
VERSION="${VERSION:-$SOURCE_VERSION}"
if [[ ! "$VERSION" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]; then
    printf 'VERSION must match X.Y.Z exactly (received %q)\n' "$VERSION" >&2
    exit 1
fi

DIST_DIR="$PROJECT_DIR/dist"
APP_NAME="OpenRappter Bar"
BUNDLE_ID="com.openrappter.bar"
SOURCE_COMMIT="${SOURCE_COMMIT:-$(git -C "$REPOSITORY_DIR" rev-parse HEAD)}"
[[ "$SOURCE_COMMIT" =~ ^[0-9a-f]{40}$ ]] || { echo "An exact source commit is required." >&2; exit 1; }
BOOTSTRAP_REQUESTED="${RUNTIME_INPUTS:+1}"
RUNTIME_INPUTS="${RUNTIME_INPUTS:-$DIST_DIR}"
BOOTSTRAP=0

if [ "${REQUIRE_SIGNING:-0}" = "1" ] || [ -n "${CODESIGN_IDENTITY:-}" ] || [ "$BOOTSTRAP_REQUESTED" = "1" ]; then
    [[ "$VERSION" == "$SOURCE_VERSION" ]] || { echo "Signed Bar version differs from source." >&2; exit 1; }
    [[ "$(git -C "$REPOSITORY_DIR" rev-parse HEAD)" == "$SOURCE_COMMIT" ]] ||
        { echo "Signed Bar source checkout differs from its identity." >&2; exit 1; }
    python3 "$REPOSITORY_DIR/scripts/bar_runtime.py" verify --root "$RUNTIME_INPUTS" \
        --commit "$SOURCE_COMMIT" --version "$VERSION"
    BOOTSTRAP=1
fi

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
    <key>OpenRappterSourceCommit</key>
    <string>${SOURCE_COMMIT}</string>
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

if [ "$BOOTSTRAP" = "1" ]; then
    cp "$RUNTIME_INPUTS/runtime-bootstrap.json" "$APP_DIR/Contents/Resources/"
    cp "$RUNTIME_INPUTS/verified-runtime-bootstrap.mjs" "$APP_DIR/Contents/Resources/"
    chmod 644 "$APP_DIR/Contents/Resources/runtime-bootstrap.json" \
        "$APP_DIR/Contents/Resources/verified-runtime-bootstrap.mjs"
    python3 "$REPOSITORY_DIR/scripts/bar_runtime.py" verify-app --app "$APP_DIR" \
        --root "$RUNTIME_INPUTS" --commit "$SOURCE_COMMIT" --version "$VERSION"
fi

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
  4. First launch downloads the exact verified Node and approved runtime for
     this signed release. Internet access is required for this one-time setup.
     No system Node, npm install, compiler, or package-manager setup is needed.

Requires: macOS 14 (Sonoma) or later
Gateway:  The app starts its verified local gateway, or uses a configured one.
Trust:    Runtime installation waits for all four finalized release receipts.
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
