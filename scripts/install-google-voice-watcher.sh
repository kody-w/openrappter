#!/usr/bin/env bash
#
# Install the Google Voice watcher as a 24/7 launchd agent.
#
# WHAT THIS RUNS
#   1. A Chrome instance dedicated to openrappter, using its OWN profile at
#      ~/.openrappter/chrome-profile with a DevTools port. Your everyday Chrome
#      is never started, stopped, or attached to. The two are separate browsers
#      that happen to share an application binary.
#   2. The watcher, which polls that Chrome's Google Voice session and replies.
#
# WHY A SEPARATE PROFILE IS THE WHOLE DESIGN
#   Chrome only exposes a debugging port when it is started with one, and adding
#   that to a running browser means killing it and everything unsaved in it. A
#   daemon that closes your windows to do its job is not a good trade. So it
#   brings its own browser. You sign that profile into Google Voice once; the
#   session persists there and nowhere else.
#
# SAFETY
#   The watcher never answers the inbox it finds on first run. It records a
#   watermark per thread and only becomes live from the NEXT message onward —
#   otherwise starting it would text everyone who has ever messaged the number.
#   Start with --dry-run and read the log before letting it speak.
#
set -euo pipefail

LABEL_CHROME="com.openrappter.googlevoice.chrome"
LABEL_WATCH="com.openrappter.googlevoice.watch"
HOME_DIR="${HOME}"
OR_DIR="${HOME_DIR}/.openrappter"
PROFILE="${OR_DIR}/chrome-profile"
LOGS="${OR_DIR}/logs"
AGENTS="${HOME_DIR}/Library/LaunchAgents"
PORT="${OPENRAPPTER_CDP_PORT:-9222}"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_BIN="$(command -v node || true)"
DRY_RUN="${1:-}"

die() { printf '\n  %s\n\n' "$1" >&2; exit 1; }

[ -x "${CHROME}" ] || die "Google Chrome not found at ${CHROME}"
[ -n "${NODE_BIN}" ] || die "node not on PATH"

mkdir -p "${PROFILE}" "${LOGS}" "${AGENTS}"

cat > "${AGENTS}/${LABEL_CHROME}.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL_CHROME}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${CHROME}</string>
    <string>--remote-debugging-port=${PORT}</string>
    <string>--user-data-dir=${PROFILE}</string>
    <string>--no-first-run</string>
    <string>--no-default-browser-check</string>
    <string>--disable-background-timer-throttling</string>
    <string>https://voice.google.com/u/0/messages</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${LOGS}/gv-chrome.log</string>
  <key>StandardErrorPath</key><string>${LOGS}/gv-chrome.err</string>
</dict>
</plist>
PLIST

cat > "${AGENTS}/${LABEL_WATCH}.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL_WATCH}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NODE_BIN}</string>
    <string>${REPO_ROOT}/typescript/dist/telephony/watch-main.js</string>${DRY_RUN:+
    <string>${DRY_RUN}</string>}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>OPENRAPPTER_CDP_PORT</key><string>${PORT}</string>
  </dict>
  <key>WorkingDirectory</key><string>${REPO_ROOT}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <!-- Give Chrome a moment to bind the port before the first poll; the watcher
       also degrades gracefully when it is not there yet, so this is comfort
       rather than correctness. -->
  <key>ThrottleInterval</key><integer>15</integer>
  <key>StandardOutPath</key><string>${LOGS}/gv-watch.log</string>
  <key>StandardErrorPath</key><string>${LOGS}/gv-watch.err</string>
</dict>
</plist>
PLIST

for label in "${LABEL_CHROME}" "${LABEL_WATCH}"; do
  launchctl unload "${AGENTS}/${label}.plist" 2>/dev/null || true
  launchctl load "${AGENTS}/${label}.plist"
done

printf '\n  installed:\n    %s\n    %s\n\n' "${LABEL_CHROME}" "${LABEL_WATCH}"
printf '  logs:   %s/gv-watch.log\n' "${LOGS}"
printf '  chrome: separate profile at %s — your everyday Chrome is untouched\n' "${PROFILE}"
printf '  stop:   launchctl unload ~/Library/LaunchAgents/%s.plist\n\n' "${LABEL_WATCH}"
printf '  If Google Voice shows a sign-in page in that window, sign in once.\n'
printf '  The watcher stays silent about every thread it has not seen before,\n'
printf '  so it will not answer your history.\n\n'
