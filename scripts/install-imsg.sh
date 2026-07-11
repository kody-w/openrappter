#!/bin/bash
set -euo pipefail

IMSG_VERSION="${OPENRAPPTER_IMSG_VERSION:-0.12.3}"
IMSG_ARCHIVE_SHA256="${OPENRAPPTER_IMSG_SHA256:-35977a22e9721440acf9f5b945d67034939948ba4fa4ea46b0f55d527f24d4f2}"
IMSG_TEAM_ID="${OPENRAPPTER_IMSG_TEAM_ID:-Y5PE65HELJ}"
OPENRAPPTER_HOME="${OPENRAPPTER_HOME:-$HOME/.openrappter}"
INSTALL_ROOT="$OPENRAPPTER_HOME/tools/imsg/$IMSG_VERSION"
BIN_DIR="$OPENRAPPTER_HOME/bin"
DOWNLOAD_URL="https://github.com/openclaw/imsg/releases/download/v$IMSG_VERSION/imsg-macos.zip"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "imsg is only supported on macOS." >&2
  exit 1
fi

for command in curl shasum unzip codesign lipo; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "Required command not found: $command" >&2
    exit 1
  fi
done

validate_install() {
  local root="$1"
  [[ -x "$root/imsg" ]] \
    && [[ -f "$root/imsg-bridge-helper.dylib" ]] \
    && [[ -f "$root/SQLite.swift_SQLite.bundle/PrivacyInfo.xcprivacy" ]] \
    && [[ -f "$root/PhoneNumberKit_PhoneNumberKit.bundle/PhoneNumberMetadata.json" ]] \
    || return 1
  codesign --verify --strict "$root/imsg" >/dev/null 2>&1 || return 1
  codesign --verify --strict "$root/imsg-bridge-helper.dylib" >/dev/null 2>&1 || return 1
  local executable_signature helper_signature
  executable_signature="$(codesign -dv --verbose=4 "$root/imsg" 2>&1)"
  helper_signature="$(codesign -dv --verbose=4 "$root/imsg-bridge-helper.dylib" 2>&1)"
  grep -q "TeamIdentifier=$IMSG_TEAM_ID" <<<"$executable_signature" || return 1
  grep -q "TeamIdentifier=$IMSG_TEAM_ID" <<<"$helper_signature" || return 1
  local executable_arches helper_arches
  executable_arches="$(lipo -archs "$root/imsg")"
  helper_arches="$(lipo -archs "$root/imsg-bridge-helper.dylib")"
  [[ "$executable_arches" == *"x86_64"* && "$executable_arches" == *"arm64"* ]] || return 1
  [[ "$helper_arches" == *"x86_64"* && "$helper_arches" == *"arm64"* && "$helper_arches" == *"arm64e"* ]] || return 1
}

link_install() {
  mkdir -p "$BIN_DIR"
  ln -sfn "$INSTALL_ROOT/imsg" "$BIN_DIR/imsg"
  ln -sfn "$INSTALL_ROOT/imsg-bridge-helper.dylib" "$BIN_DIR/imsg-bridge-helper.dylib"
  ln -sfn "$INSTALL_ROOT/SQLite.swift_SQLite.bundle" "$BIN_DIR/SQLite.swift_SQLite.bundle"
  ln -sfn "$INSTALL_ROOT/PhoneNumberKit_PhoneNumberKit.bundle" "$BIN_DIR/PhoneNumberKit_PhoneNumberKit.bundle"
}

if validate_install "$INSTALL_ROOT"; then
  installed_version="$("$INSTALL_ROOT/imsg" --version 2>/dev/null || true)"
  if [[ "$installed_version" == "$IMSG_VERSION" ]]; then
    link_install
    echo "imsg $IMSG_VERSION is already installed at $INSTALL_ROOT/imsg"
    exit 0
  fi
fi

tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/openrappter-imsg.XXXXXX")"
trap 'rm -rf "$tmp_dir"' EXIT

archive="$tmp_dir/imsg-macos.zip"
curl --fail --location --silent --show-error "$DOWNLOAD_URL" --output "$archive"

actual_sha="$(shasum -a 256 "$archive" | awk '{print $1}')"
if [[ "$actual_sha" != "$IMSG_ARCHIVE_SHA256" ]]; then
  echo "imsg archive checksum mismatch." >&2
  echo "Expected: $IMSG_ARCHIVE_SHA256" >&2
  echo "Actual:   $actual_sha" >&2
  exit 1
fi

unzip -q "$archive" -d "$tmp_dir/extracted"
candidate="$tmp_dir/extracted/imsg"
if [[ ! -x "$candidate" ]]; then
  echo "imsg archive did not contain an executable named imsg." >&2
  exit 1
fi

codesign --verify --strict "$candidate"
signature="$(codesign -dv --verbose=4 "$candidate" 2>&1)"
if ! grep -q "Authority=Developer ID Application: Peter Steinberger" <<<"$signature"; then
  echo "imsg executable has an unexpected signing authority." >&2
  exit 1
fi
if ! grep -q "TeamIdentifier=$IMSG_TEAM_ID" <<<"$signature"; then
  echo "imsg executable has an unexpected TeamIdentifier." >&2
  exit 1
fi
helper="$tmp_dir/extracted/imsg-bridge-helper.dylib"
if [[ ! -f "$helper" ]]; then
  echo "imsg archive did not contain the bridge helper." >&2
  exit 1
fi
codesign --verify --strict "$helper"
helper_signature="$(codesign -dv --verbose=4 "$helper" 2>&1)"
if ! grep -q "TeamIdentifier=$IMSG_TEAM_ID" <<<"$helper_signature"; then
  echo "imsg bridge helper has an unexpected TeamIdentifier." >&2
  exit 1
fi

mkdir -p "$INSTALL_ROOT" "$BIN_DIR"
cp -R "$tmp_dir/extracted/." "$INSTALL_ROOT/"
chmod 755 "$INSTALL_ROOT/imsg"
link_install

if ! validate_install "$INSTALL_ROOT"; then
  echo "Installed imsg layout failed validation." >&2
  exit 1
fi

if [[ "$("$BIN_DIR/imsg" --version)" != "$IMSG_VERSION" ]]; then
  echo "Installed imsg version did not match $IMSG_VERSION." >&2
  exit 1
fi

echo "Installed signed imsg $IMSG_VERSION at $INSTALL_ROOT/imsg"
echo "Linked $BIN_DIR/imsg"
echo "Next: grant Full Disk Access to the OpenRappter process and Automation access to Messages."
