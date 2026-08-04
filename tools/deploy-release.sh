#!/usr/bin/env bash
# Build the current tree and publish it as a release the daemon can run.
#
# The release layout already in use is releases/<short-sha> with a `current`
# symlink pointing at one of them. That convention existed before this script
# did — the directories were being produced by hand, which is how a machine
# ends up running a binary nobody can name. A release built by a script is at
# least reproducible from a SHA.
#
# Usage: tools/deploy-release.sh [--restart]
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SHARE="${HOME}/.local/share/openrappter"
RELEASES="${SHARE}/releases"
LABEL="com.openrappter.daemon"

cd "${REPO}"
SHA="$(git rev-parse --short HEAD)"
if ! git diff --quiet || ! git diff --cached --quiet; then
  SHA="${SHA}-dirty"
fi
TARGET="${RELEASES}/${SHA}"

echo "==> building typescript"
( cd typescript && npm run build --silent )

echo "==> building ui"
( cd typescript/ui && npm run build --silent )

echo "==> staging ${TARGET}"
rm -rf "${TARGET}"
mkdir -p "${TARGET}"
cp -R typescript/dist "${TARGET}/dist"
mkdir -p "${TARGET}/ui"
cp -R typescript/ui/dist "${TARGET}/ui/dist"
cp typescript/package.json typescript/package-lock.json "${TARGET}/"

# Runtime deps only. Reusing the previous release's node_modules keeps this
# fast, but only when the lockfile is unchanged — otherwise the release would
# silently run against dependencies it was not built with.
PREV="$(readlink "${SHARE}/current" 2>/dev/null || true)"
if [[ -n "${PREV}" && -d "${PREV}/node_modules" ]] \
   && cmp -s "${PREV}/package-lock.json" "${TARGET}/package-lock.json"; then
  echo "==> reusing node_modules from $(basename "${PREV}") (lockfile identical)"
  cp -R "${PREV}/node_modules" "${TARGET}/node_modules"
else
  echo "==> installing production deps"
  ( cd "${TARGET}" && npm ci --omit=dev --silent )
fi

ln -sfn "${TARGET}" "${SHARE}/current"
echo "==> current -> ${SHA}"

if [[ "${1:-}" == "--restart" ]]; then
  echo "==> restarting ${LABEL}"
  launchctl kickstart -k "gui/$(id -u)/${LABEL}" 2>/dev/null \
    || { launchctl stop "${LABEL}" 2>/dev/null || true; launchctl start "${LABEL}"; }
  sleep 4
  # A label present in `launchctl list` is not a running process — check the pid.
  PID="$(launchctl list | awk -v l="${LABEL}" '$3==l && $1 ~ /^[0-9]+$/ {print $1}')"
  if [[ -n "${PID}" ]]; then
    echo "==> ${LABEL} running (pid ${PID})"
  else
    echo "!! ${LABEL} is loaded but has no pid — it did not come back up" >&2
    exit 1
  fi
fi
