#!/bin/bash
set -euo pipefail

DMG="${1:?DMG path required}"
VERSION="${2:?Exact version required}"
EXPECTED_SHA="${3:?Expected SHA-256 required}"
SOURCE_COMMIT="${4:?Exact source commit required}"
RUNTIME_INPUTS="${5:-$(dirname "$DMG")}"
PARTS_ROOT="${6:-$(dirname "$RUNTIME_INPUTS")/candidate-parts}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPOSITORY_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
[[ "$VERSION" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] || exit 1
[[ "$EXPECTED_SHA" =~ ^[0-9a-f]{64}$ ]] || exit 1
[[ "$SOURCE_COMMIT" =~ ^[0-9a-f]{40}$ ]] || exit 1
[[ "$(shasum -a 256 "$DMG" | cut -d' ' -f1)" == "$EXPECTED_SHA" ]] || exit 1

codesign --verify --strict --verbose=2 "$DMG"
xcrun stapler validate "$DMG"
spctl --assess --type open --context context:primary-signature --verbose=2 "$DMG"

MOUNT="$(cd "$(dirname "$DMG")" && pwd)/$(basename "$DMG").verify-mount"
mkdir "$MOUNT"
cleanup() {
    hdiutil detach "$MOUNT" >/dev/null 2>&1 || true
    rmdir "$MOUNT" 2>/dev/null || true
}
trap cleanup EXIT
hdiutil attach "$DMG" -nobrowse -readonly -mountpoint "$MOUNT"
APP="$MOUNT/OpenRappter Bar.app"
codesign --verify --deep --strict --verbose=2 "$APP"
codesign --display --verbose=4 "$APP" 2>&1 | grep '^Authority=Developer ID Application:' >/dev/null
spctl --assess --type execute --verbose=2 "$APP"
lipo -verify_arch arm64 x86_64 "$APP/Contents/MacOS/OpenRappterBar"
# macOS Bash 3.2 does not reliably apply errexit to standalone [[ ... ]] checks.
[[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP/Contents/Info.plist")" == "$VERSION" ]] ||
    { echo "DMG bundle version mismatch" >&2; exit 1; }
[[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$APP/Contents/Info.plist")" == "com.openrappter.bar" ]] ||
    { echo "DMG bundle identifier mismatch" >&2; exit 1; }
python3 "$REPOSITORY_DIR/scripts/bar_runtime.py" verify-app --app "$APP" \
    --root "$RUNTIME_INPUTS" --parts-root "$PARTS_ROOT" --commit "$SOURCE_COMMIT" --version "$VERSION"
# Verification must not staple, re-sign, or otherwise change promoted bytes.
[[ "$(shasum -a 256 "$DMG" | cut -d' ' -f1)" == "$EXPECTED_SHA" ]] ||
    { echo "DMG changed during verification" >&2; exit 1; }
