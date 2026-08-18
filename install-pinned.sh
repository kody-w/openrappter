#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
#
# Install OpenRappter from an exact source commit, verifiably, with nothing
# installed globally. Conformant with rapp-local-install/1.0:
#   https://github.com/kody-w/rapp-local-install
#
# Every rule this satisfies is there because its absence is a real failure mode
# somebody has already hit, not because it sounded rigorous.
#
#   OPENRAPPTER_COMMIT=<40-hex> bash install-pinned.sh
#
# Uninstall is `rm -rf` of one directory. There is no other footprint.
set -euo pipefail

SPEC="rapp-local-install/1.0"
REPO="kody-w/openrappter"
NODE_MAJOR="24"

COMMIT="${OPENRAPPTER_COMMIT:-}"
INSTALL_ROOT="${OPENRAPPTER_INSTALL_ROOT:-}"

info() { printf '[openrappter] %s\n' "$*"; }
die()  { printf '[openrappter] ERROR: %s\n' "$*" >&2; exit 1; }

# ── 3.1 Pin or refuse ────────────────────────────────────────────────────────
# A branch is not a pin. Two users running this a day apart must get identical
# bytes or an error. `main`, `HEAD` and `latest` are refused by shape, not by
# name, so a new mutable ref cannot slip through an allowlist nobody updated.
[ -n "$COMMIT" ] || die "OPENRAPPTER_COMMIT is required (an exact 40-character commit)."
# Echo what the caller typed, not the case-folded value: lowercasing HEAD
# reports it back as "Head", which reads like a bug in the installer.
COMMIT_INPUT="$COMMIT"
COMMIT="$(printf '%s' "$COMMIT" | tr 'A-F' 'a-f')"
case "$COMMIT" in
  *[!0-9a-f]* | "") die "OPENRAPPTER_COMMIT must be 40 hex characters, got: $COMMIT_INPUT" ;;
esac
[ "${#COMMIT}" -eq 40 ] || die "OPENRAPPTER_COMMIT must be exactly 40 characters, got ${#COMMIT} ($COMMIT_INPUT)."

# ── 4.1/4.2/4.3 Enumerate, normalise, then refuse ────────────────────────────
SYSTEM="$(uname -s)"
MACHINE="$(uname -m)"
case "$SYSTEM" in
  Darwin)
    PLATFORM="darwin"
    DEFAULT_ROOT="$HOME/Library/Application Support/OpenRappter"
    ;;
  Linux)
    [ -r /etc/os-release ] || die "Cannot identify this Linux distribution from /etc/os-release."
    OS_ID="$(sed -n 's/^ID=//p' /etc/os-release | head -n 1 | tr -d '\"')"
    case "$OS_ID" in
      ubuntu|debian) ;;
      *) die "install-pinned.sh is tested on Ubuntu and Debian only; found ${OS_ID:-unknown}." ;;
    esac
    PLATFORM="linux"
    DEFAULT_ROOT="${XDG_DATA_HOME:-$HOME/.local/share}/OpenRappter"
    ;;
  *) die "install-pinned.sh supports macOS and Ubuntu/Debian only; found $SYSTEM." ;;
esac
case "$MACHINE" in
  x86_64|amd64)  ARCH="x64"   ;;
  arm64|aarch64) ARCH="arm64" ;;
  *) die "Unsupported processor architecture: $MACHINE." ;;
esac

INSTALL_ROOT="${INSTALL_ROOT:-$DEFAULT_ROOT}"
mkdir -p "$INSTALL_ROOT"
INSTALL_ROOT="$(cd "$INSTALL_ROOT" && pwd -P)"
RUNTIME_ROOT="$INSTALL_ROOT/runtime"
VERSIONS_ROOT="$INSTALL_ROOT/versions"      # 3.7 content-addressed
SOURCE_DIR="$VERSIONS_ROOT/$COMMIT"
mkdir -p "$RUNTIME_ROOT" "$VERSIONS_ROOT"

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/openrappter-install.XXXXXX")"
cleanup() { [ -n "${WORK_DIR:-}" ] && rm -rf -- "$WORK_DIR"; }
trap cleanup EXIT

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1;   then shasum -a 256 "$1" | awk '{print $1}'
  else die "No SHA-256 tool available (sha256sum or shasum). Refusing to install unverified bytes."
  fi
}

# ── 3.2 HTTPS only, refused explicitly ───────────────────────────────────────
download() {
  local url="$1" dest="$2"
  case "$url" in
    https://*) ;;
    *) die "Refusing non-HTTPS download: $url" ;;
  esac
  curl --fail --location --silent --show-error "$url" --output "$dest" \
    || die "Download failed: $url"
  [ -s "$dest" ] || die "Download produced an empty file: $url"
}

# ── 3.3/3.4 Verify the runtime, fail closed, check the name ──────────────────
install_node_runtime() {
  local channel="https://nodejs.org/dist/latest-v${NODE_MAJOR}.x"
  local sums="$WORK_DIR/SHASUMS256.txt"
  download "$channel/SHASUMS256.txt" "$sums"

  local suffix="-${PLATFORM}-${ARCH}.tar.gz" archive
  archive="$(awk -v s="$suffix" 'index($2, s) && substr($2, length($2)-length(s)+1) == s {print $2; exit}' "$sums")"
  [ -n "$archive" ] || die "Node.js ${NODE_MAJOR} publishes no ${PLATFORM}-${ARCH} archive."

  # 3.4 — a hash proves the bytes are unmodified, not that they are the bytes
  # you asked for. Check the name against an expected shape as well.
  case "$archive" in
    node-v${NODE_MAJOR}.*-"$PLATFORM"-"$ARCH".tar.gz) ;;
    *) die "Unexpected Node.js archive name: $archive" ;;
  esac

  local expected
  expected="$(awk -v n="$archive" '$2 == n || $2 == "*" n {print tolower($1); exit}' "$sums")"
  [ -n "$expected" ] || die "Node.js checksums do not list $archive."

  local base="${archive%.tar.gz}"
  RUNTIME_DIR="$RUNTIME_ROOT/$base"
  NODE="$RUNTIME_DIR/bin/node"
  NPM="$RUNTIME_DIR/bin/npm"

  # 3.5 — re-verify what is already on disk. Presence is not integrity: a
  # directory that exists proves only that something wrote to it once.
  if [ -x "$NODE" ] && [ -x "$NPM" ] &&
     [ "$(cat "$RUNTIME_DIR/.archive-sha256" 2>/dev/null || true)" = "$expected" ] &&
     [ "$(cat "$RUNTIME_DIR/.node-sha256" 2>/dev/null || true)" = "$(sha256_file "$NODE")" ]; then
    info "Reusing verified Node.js runtime $base."
  else
    info "Downloading official Node.js ${NODE_MAJOR} for ${PLATFORM}-${ARCH}."
    download "$channel/$archive" "$WORK_DIR/$archive"
    local actual; actual="$(sha256_file "$WORK_DIR/$archive")"
    [ "$actual" = "$expected" ] \
      || die "Node.js archive SHA-256 mismatch. Expected $expected, got $actual."

    rm -rf -- "$RUNTIME_DIR"
    mkdir -p "$WORK_DIR/x"
    tar -xzf "$WORK_DIR/$archive" -C "$WORK_DIR/x"
    [ -d "$WORK_DIR/x/$base" ] || die "Node.js archive did not contain $base."
    mv "$WORK_DIR/x/$base" "$RUNTIME_DIR"
    # Both tests are pure predicates, so `die` runs exactly when either is
    # false. Not the A && B || C hazard SC2015 warns about.
    # shellcheck disable=SC2015
    [ -x "$NODE" ] && [ -x "$NPM" ] || die "Extracted Node.js runtime is incomplete."
    printf '%s\n' "$expected" > "$RUNTIME_DIR/.archive-sha256"
    sha256_file "$NODE" > "$RUNTIME_DIR/.node-sha256"
  fi

  PATH="$RUNTIME_DIR/bin:$PATH"; export PATH

  # 3.8 — ask the runtime what it is. An archive named darwin-arm64 that
  # reports linux-x64 is worth learning now rather than at first run.
  local v p a
  v="$("$NODE" -p 'process.versions.node')"
  p="$("$NODE" -p 'process.platform')"
  a="$("$NODE" -p 'process.arch')"
  [ "${v%%.*}" = "$NODE_MAJOR" ] || die "Expected Node.js ${NODE_MAJOR}, got $v."
  [ "$p" = "$PLATFORM" ] || die "Expected platform $PLATFORM, got $p."
  [ "$a" = "$ARCH" ]     || die "Expected architecture $ARCH, got $a."
  NODE_VERSION="$v"
}

# ── 3.9 Completeness manifest ────────────────────────────────────────────────
REQUIRED_FILES="
LICENSE
typescript/package.json
typescript/package-lock.json
typescript/dist/index.js
typescript/dist/providers/copilot-cli-local.js
"
check_required_files() {
  local d="$1" rel
  while IFS= read -r rel; do
    [ -z "$rel" ] && continue
    [ -e "$d/$rel" ] || die "Installed source is missing a required file: $rel"
  done <<EOF
$REQUIRED_FILES
EOF
}

# ── The GitHub Copilot CLI is part of the pin ────────────────────────────────
#
# OpenRappter reasons through the Copilot CLI, so an install that pins the
# source but leaves the CLI ambient has not pinned the thing that actually
# decides the answers. `@github/copilot` is a lockfile dependency, so `npm ci`
# already places it here; what remains is to record which bytes arrived and to
# refuse them later if they change.
copilot_binary() {
  printf '%s\n' "$1/typescript/node_modules/@github/copilot-${PLATFORM}-${ARCH}/copilot"
}

# The stamp lives beside the package because that is where the runtime looks:
# `packageRoot()` in copilot-cli-local.ts resolves to typescript/.
copilot_stamp() { printf '%s\n' "$1/typescript/.openrappter-copilot-sha256"; }

stamp_copilot_cli() {
  local d="$1" binary
  binary="$(copilot_binary "$d")"
  [ -x "$binary" ] ||
    die "The pinned GitHub Copilot CLI did not install for ${PLATFORM}-${ARCH}."
  sha256_file "$binary" > "$(copilot_stamp "$d")"
}

# Re-checked on every run, not only at build time. A pin verified once is a
# claim about the past; this makes it a claim about the binary about to run.
verify_copilot_cli() {
  local d="$1" binary expected
  binary="$(copilot_binary "$d")"
  expected="$(cat "$(copilot_stamp "$d")" 2>/dev/null || true)"
  [ -n "$expected" ] || return 1
  [ -x "$binary" ] || return 1
  [ "$expected" = "$(sha256_file "$binary")" ] || return 1
  return 0
}

# ── 3.5 Re-verify an existing install before reusing it ──────────────────────
validate_existing_install() {
  local d="$1" record="$1/.rapp-install.json"
  [ -f "$record" ] || return 1
  local pin lock_expected lock_actual
  pin="$("$NODE" -p "JSON.parse(require('fs').readFileSync('$record','utf8')).pin" 2>/dev/null || true)"
  [ "$pin" = "$COMMIT" ] || return 1
  lock_expected="$("$NODE" -p "JSON.parse(require('fs').readFileSync('$record','utf8')).lockfile_sha256" 2>/dev/null || true)"
  lock_actual="$(sha256_file "$d/typescript/package-lock.json" 2>/dev/null || true)"
  [ -n "$lock_expected" ] && [ "$lock_expected" = "$lock_actual" ] || return 1
  # A changed Copilot CLI invalidates the reuse just as a changed lockfile does.
  # Returning 1 rebuilds from source rather than running a binary nobody vouched
  # for — the failure mode this guards against is a substitution after install.
  verify_copilot_cli "$d" || return 1
  check_required_files "$d"
  return 0
}

build_from_source() {
  local archive="$WORK_DIR/src.tar.gz"
  info "Downloading $REPO at $COMMIT."
  download "https://codeload.github.com/$REPO/tar.gz/$COMMIT" "$archive"
  SOURCE_SHA256="$(sha256_file "$archive")"

  local staging="$WORK_DIR/staging"
  mkdir -p "$staging"
  tar -xzf "$archive" -C "$staging"
  local extracted; extracted="$(find "$staging" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
  [ -d "$extracted" ] || die "Source archive did not contain a directory."

  info "Installing dependencies from the lockfile."
  # 3.11 — `npm ci` fails on lockfile drift; `npm install` silently resolves it.
  ( cd "$extracted/typescript" && npm ci --no-fund --no-audit >/dev/null ) \
    || die "npm ci failed. The lockfile and package.json disagree."
  ( cd "$extracted/typescript" && npm run build >/dev/null ) \
    || die "Build failed for commit $COMMIT."

  stamp_copilot_cli "$extracted"
  check_required_files "$extracted"
  rm -rf -- "$SOURCE_DIR"
  mkdir -p "$(dirname "$SOURCE_DIR")"
  mv "$extracted" "$SOURCE_DIR"
}

# ── 3.9 Provenance record ────────────────────────────────────────────────────
write_provenance() {
  local d="$1"
  cat > "$d/.rapp-install.json" <<JSON
{
  "schema": "$SPEC",
  "pin": "$COMMIT",
  "pin_kind": "git-commit",
  "installed_utc": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "platform": "$PLATFORM",
  "architecture": "$ARCH",
  "sources": [
    {
      "url": "https://codeload.github.com/$REPO/tar.gz/$COMMIT",
      "sha256": "${SOURCE_SHA256:-reused}"
    }
  ],
  "runtime": {
    "name": "node",
    "version": "$NODE_VERSION",
    "archive_sha256": "$(cat "$RUNTIME_DIR/.archive-sha256")",
    "binary_sha256": "$(cat "$RUNTIME_DIR/.node-sha256")"
  },
  "lockfile_sha256": "$(sha256_file "$d/typescript/package-lock.json")",
  "copilot_cli": {
    "package": "@github/copilot-${PLATFORM}-${ARCH}",
    "path": "$(copilot_binary "$d")",
    "sha256": "$(cat "$(copilot_stamp "$d")")"
  }
}
JSON
}

install_node_runtime

if [ -d "$SOURCE_DIR" ] && validate_existing_install "$SOURCE_DIR"; then
  info "Reusing verified install at $SOURCE_DIR."
else
  build_from_source
  write_provenance "$SOURCE_DIR"
fi

# 3.6 — nothing global. One launcher inside the root; no sudo, no PATH edits,
# no npm -g. Uninstall is `rm -rf "$INSTALL_ROOT"`.
mkdir -p "$INSTALL_ROOT/bin"
cat > "$INSTALL_ROOT/bin/openrappter" <<LAUNCH
#!/usr/bin/env bash
set -euo pipefail
exec "$RUNTIME_DIR/bin/node" "$SOURCE_DIR/typescript/dist/index.js" "\$@"
LAUNCH
chmod +x "$INSTALL_ROOT/bin/openrappter"

info "Installed $REPO@${COMMIT:0:12} (${PLATFORM}-${ARCH}, node $NODE_VERSION)."
info "Launcher: $INSTALL_ROOT/bin/openrappter"
info "Copilot CLI: $(copilot_binary "$SOURCE_DIR")"
info "Copilot CLI sha256: $(cat "$(copilot_stamp "$SOURCE_DIR")")"
info "Uninstall: rm -rf \"$INSTALL_ROOT\""
