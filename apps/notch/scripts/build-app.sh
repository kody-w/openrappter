#!/usr/bin/env bash
# Build OpenRappter.app. VERSION=X.Y.Z, CODESIGN_IDENTITY="Developer ID Application: ..." (else ad-hoc),
# ARCHS="arm64 x86_64" for a universal release build (default: the host arch, fast).
set -euo pipefail
VERSION="${VERSION:-0.0.0}"
[[ "$VERSION" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] || { echo "VERSION must be X.Y.Z" >&2; exit 1; }
HERE="$(cd "$(dirname "$0")" && pwd)"; APP_SRC="$(dirname "$HERE")"; DIST="$APP_SRC/dist"
NAME="OpenRappter"; BUNDLE_ID="com.openrappter.app"; APP="$DIST/$NAME.app"
ARCHS="${ARCHS:-$(uname -m)}"
cd "$APP_SRC"
bins=()
mkdir -p "$DIST/slices"
for a in $ARCHS; do
  swift build -c release --arch "$a" --product OpenRappter
  # Copy each slice out: newer SwiftPM layouts reuse one bin path across arches, so the next build would overwrite it.
  cp "$(swift build -c release --arch "$a" --product OpenRappter --show-bin-path)/OpenRappter" "$DIST/slices/OpenRappter-$a"
  bins+=("$DIST/slices/OpenRappter-$a")
done
rm -rf "$APP"; mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
if [ ${#bins[@]} -gt 1 ]; then lipo -create "${bins[@]}" -output "$APP/Contents/MacOS/$NAME"; else cp "${bins[0]}" "$APP/Contents/MacOS/$NAME"; fi
cp -R "$APP_SRC/kernel" "$APP/Contents/Resources/kernel"
cp -R "$APP_SRC/hooks" "$APP/Contents/Resources/hooks"
rm -rf "$APP/Contents/Resources/kernel/.build"
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>$NAME</string>
  <key>CFBundleDisplayName</key><string>$NAME</string>
  <key>CFBundleIdentifier</key><string>$BUNDLE_ID</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>$NAME</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSMicrophoneUsageDescription</key><string>OpenRappter listens while you hold the key so it can hear what you say. Speech stays on this Mac.</string>
  <key>NSSpeechRecognitionUsageDescription</key><string>OpenRappter turns what you say into text on this Mac.</string>
  <key>NSAppleEventsUsageDescription</key><string>OpenRappter types what you dictated into the app you are using.</string>
  <key>CFBundleURLTypes</key><array><dict>
    <key>CFBundleURLName</key><string>$BUNDLE_ID</string>
    <key>CFBundleURLSchemes</key><array><string>openrappter</string></array>
  </dict></array>
</dict></plist>
PLIST
cat > "$DIST/OpenRappter.entitlements" <<ENT
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>com.apple.security.device.audio-input</key><true/>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key><false/>
</dict></plist>
ENT
if [ -f "$APP_SRC/Resources/AppIcon.icns" ]; then cp "$APP_SRC/Resources/AppIcon.icns" "$APP/Contents/Resources/AppIcon.icns"; fi
IDENTITY="${CODESIGN_IDENTITY:-}"
if [ -z "$IDENTITY" ] && [ "${REQUIRE_SIGNING:-0}" = "1" ]; then echo "release build requires CODESIGN_IDENTITY" >&2; exit 1; fi
if [ -n "$IDENTITY" ]; then
  codesign --force --options runtime --timestamp --entitlements "$DIST/OpenRappter.entitlements" --sign "$IDENTITY" "$APP"
else
  codesign --force --sign - --entitlements "$DIST/OpenRappter.entitlements" "$APP"
fi
codesign --verify --deep --strict --verbose=2 "$APP"
echo "==> built $APP ($ARCHS) signed as ${IDENTITY:-ad-hoc}"
if [ "${MAKE_DMG:-0}" = "1" ]; then
  DMG="$DIST/OpenRappter-$VERSION.dmg"; STAGE="$DIST/dmg-staging"; rm -rf "$STAGE" "$DMG"; mkdir -p "$STAGE"
  cp -R "$APP" "$STAGE/"; ln -s /Applications "$STAGE/Applications"
  hdiutil create -volname "OpenRappter" -srcfolder "$STAGE" -ov -format UDZO "$DMG" >/dev/null; rm -rf "$STAGE"
  if [ -n "$IDENTITY" ]; then codesign --force --timestamp --sign "$IDENTITY" "$DMG"; codesign --verify --strict --verbose=2 "$DMG"; fi
  echo "==> dmg $DMG ($(du -h "$DMG" | cut -f1))"
fi
