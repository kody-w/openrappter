#!/usr/bin/env bash
# OpenRappter Quickstart — run from repo root
set -e

usage_error() {
  echo "Error: $1" >&2
  echo "Usage: ./quickstart.sh [--demo live-organ-transplant]" >&2
  exit 2
}

parse_semver() {
  local version="${1#v}"

  if [[ ! "$version" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)([-+][0-9A-Za-z.-]+)?$ ]]; then
    return 1
  fi

  SEMVER_MAJOR=$((10#${BASH_REMATCH[1]}))
  SEMVER_MINOR=$((10#${BASH_REMATCH[2]}))
  SEMVER_PATCH=$((10#${BASH_REMATCH[3]}))
}

semver_at_least() {
  local required_major="$1"
  local required_minor="$2"
  local required_patch="$3"

  (( SEMVER_MAJOR > required_major )) ||
    (( SEMVER_MAJOR == required_major && SEMVER_MINOR > required_minor )) ||
    (( SEMVER_MAJOR == required_major && SEMVER_MINOR == required_minor && SEMVER_PATCH >= required_patch ))
}

require_node() {
  local node_version

  if ! command -v node &>/dev/null; then
    echo "Error: Node.js 20.9.0 or newer is required but was not found." >&2
    echo "Install Node.js 20.9.0+ from https://nodejs.org/ and try again." >&2
    exit 1
  fi

  if ! node_version="$(node --version 2>&1)"; then
    echo "Error: Node.js was found, but its version could not be read." >&2
    exit 1
  fi

  if ! parse_semver "$node_version"; then
    echo "Error: Could not parse Node.js version '$node_version'; expected vMAJOR.MINOR.PATCH." >&2
    exit 1
  fi

  if ! semver_at_least 20 9 0; then
    echo "Error: Node.js 20.9.0 or newer is required; found $node_version." >&2
    exit 1
  fi
}

require_transplant_python() {
  local python_output
  local python_version

  if ! command -v python3 &>/dev/null; then
    echo "Error: Live Organ Transplant requires Python 3.10 or newer, but python3 was not found." >&2
    exit 1
  fi

  if ! python_output="$(python3 --version 2>&1)"; then
    echo "Error: python3 was found, but its version could not be read." >&2
    exit 1
  fi

  python_version="${python_output#Python }"
  if ! parse_semver "$python_version"; then
    echo "Error: Could not parse Python version '$python_output'; expected Python MAJOR.MINOR.PATCH." >&2
    exit 1
  fi

  if ! semver_at_least 3 10 0; then
    echo "Error: Live Organ Transplant requires Python 3.10 or newer; found $python_output." >&2
    exit 1
  fi
}

require_transplant_platform() {
  local platform
  platform="$(uname -s 2>/dev/null || echo unknown)"

  case "$platform" in
    Darwin|Linux) ;;
    *)
      echo "Error: Live Organ Transplant supports macOS, Linux, and WSL; native Windows is deferred (detected $platform)." >&2
      exit 1
      ;;
  esac
}

demo=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --demo)
      if [ -n "$demo" ]; then
        usage_error "--demo may only be specified once."
      fi
      if [ "$#" -lt 2 ] || [[ "$2" == --* ]]; then
        usage_error "--demo requires a demo name."
      fi
      demo="$2"
      shift 2
      ;;
    *)
      usage_error "Unknown argument or flag: $1"
      ;;
  esac
done

if [ -n "$demo" ] && [ "$demo" != "live-organ-transplant" ]; then
  usage_error "Unknown demo: $demo"
fi

require_node

cd "$(dirname "$0")/typescript"

if [ "$demo" = "live-organ-transplant" ]; then
  require_transplant_platform
  require_transplant_python

  echo "Reconstructing locked dependencies for Live Organ Transplant..."
  npm ci --no-audit --no-fund

  npm run demo:transplant --silent
  exit $?
fi

if [ ! -d node_modules ]; then
  echo "Installing dependencies (first run only)..."
  npm install --silent
fi

npx tsx examples/quickstart.ts
