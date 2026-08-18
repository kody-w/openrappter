#!/usr/bin/env bash
#
# Deploy the current build to the runtime location the app actually launches.
#
# THE PROBLEM THIS SOLVES
#
# `~/.openrappter` is two things at once: a git checkout of the source AND the
# runtime data directory holding credentials, sessions, memory, and cron state.
# That conflation is why the machine drifted — the source half stopped being
# updated (96 commits behind, pinned at 43ef951) while the data half kept being
# written to, so `git status` showed 21 "dirty" files that are actually live
# user data and can never be discarded.
#
# The result: every fix shipped to the repo was invisible to the product,
# because the LaunchAgent points at that stale checkout's `dist/`.
#
# THE DEPLOYMENT STORY, MADE EXPLICIT
#
# `ProcessManager.resolveProjectPath()` already prefers
# `~/.local/share/openrappter/current` over `~/.openrappter`. That directory
# simply was never created. This script populates it:
#
#   ~/.local/share/openrappter/
#     releases/<git-sha>/     immutable build output
#     current -> releases/…   symlink the app resolves
#
#   ~/.openrappter/           UNTOUCHED — stays the data directory
#
# Code and data stop sharing a directory. Rolling back is repointing a symlink.
#
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TS="$REPO/typescript"
ROOT="$HOME/.local/share/openrappter"
RELEASES="$ROOT/releases"
CURRENT="$ROOT/current"

die() { printf '\n  %s\n\n' "$1" >&2; exit 1; }

[ -d "$TS" ] || die "no typescript/ in $REPO"

SHA="$(git -C "$REPO" rev-parse --short HEAD 2>/dev/null || echo "nogit")"
DIRTY=""
if ! git -C "$REPO" diff --quiet 2>/dev/null || ! git -C "$REPO" diff --cached --quiet 2>/dev/null; then
  DIRTY="-dirty"
fi
TARGET="$RELEASES/${SHA}${DIRTY}"

printf '\n  building %s\n' "$SHA"
# Swallowing the build log made a real failure unreadable: the deploy said only
# "build failed", the symlink silently kept pointing at the previous release, and
# a stale daemon went on serving as though the fix had shipped. Show the reason.
BUILD_LOG="$(mktemp -t openrappter-build)"
if ! (cd "$TS" && npm run build >"$BUILD_LOG" 2>&1); then
  printf '\n  build failed — refusing to deploy\n\n'
  tail -30 "$BUILD_LOG" | sed 's/^/    /'
  printf '\n  full log: %s\n' "$BUILD_LOG"
  exit 1
fi
rm -f "$BUILD_LOG"

[ -f "$TS/dist/index.js" ] || die "build produced no dist/index.js"

printf '  staging  %s\n' "$TARGET"
rm -rf "$TARGET"
mkdir -p "$TARGET"

# Ship the runnable package only. node_modules is copied because the daemon is
# launched directly by launchd, with no install step at start time.
cp -R "$TS/dist" "$TARGET/dist"
cp "$TS/package.json" "$TARGET/package.json"
[ -f "$TS/package-lock.json" ] && cp "$TS/package-lock.json" "$TARGET/package-lock.json"
if [ -d "$TS/node_modules" ]; then
  cp -R "$TS/node_modules" "$TARGET/node_modules"
else
  (cd "$TARGET" && npm ci --omit=dev >/dev/null 2>&1) || die "no node_modules and npm ci failed"
fi
[ -d "$TS/ui/dist" ] && mkdir -p "$TARGET/ui" && cp -R "$TS/ui/dist" "$TARGET/ui/dist"

# Prove the artifact runs before anything is pointed at it. Deploying a build
# that cannot start is how you turn a broken feature into a broken machine.
NODE="$(command -v node || echo /opt/homebrew/bin/node)"
if ! "$NODE" "$TARGET/dist/index.js" --version >/dev/null 2>&1; then
  rm -rf "$TARGET"
  die "the staged build will not run — nothing was changed"
fi

ln -sfn "$TARGET" "$CURRENT"
printf '  current  -> %s\n' "$(readlink "$CURRENT")"

# Keep the last five releases so a rollback target always exists.
# `find` cannot order by mtime, which is the whole point here: keep the five
# newest releases. Release directories are created by this script with
# timestamp names, so they contain no whitespace.
# shellcheck disable=SC2012
ls -1dt "$RELEASES"/* 2>/dev/null | tail -n +6 | while read -r old; do
  [ "$old" = "$TARGET" ] || rm -rf "$old"
done

printf '\n  deployed. %s\n' "$("$NODE" "$TARGET/dist/index.js" --version 2>/dev/null | head -1)"
printf '  the runtime data directory (~/.openrappter) was not touched.\n'
printf '  restart the daemon to pick it up:\n'
printf '    launchctl unload ~/Library/LaunchAgents/com.openrappter.daemon.plist\n'
printf '    launchctl load -w ~/Library/LaunchAgents/com.openrappter.daemon.plist\n\n'
