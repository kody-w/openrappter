#!/usr/bin/env bash
# OpenRappter Quickstart — run from repo root
set -e

if ! command -v node &>/dev/null; then
  echo "Error: Node.js is required but not installed."
  echo "Install it from https://nodejs.org (v18+)"
  exit 1
fi

cd "$(dirname "$0")/typescript"

if [ ! -d node_modules ]; then
  echo "Installing dependencies (first run only)..."
  npm install --silent
fi

npx tsx examples/quickstart.ts
