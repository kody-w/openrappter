#!/bin/bash
set -euo pipefail

LABEL="com.openrappter.imessage"
OPENRAPPTER_HOME="${OPENRAPPTER_HOME:-$HOME/.openrappter}"
CONFIG_PATH="${OPENRAPPTER_IMESSAGE_CONFIG:-$OPENRAPPTER_HOME/imessage/config.json}"
PLIST_PATH="$HOME/Library/LaunchAgents/$LABEL.plist"
PYTHON_BIN="${OPENRAPPTER_PYTHON:-$OPENRAPPTER_HOME/runtimes/imessage/current/bin/python}"
DOMAIN="gui/$(id -u)"

if [[ "${1:-}" == "--uninstall" ]]; then
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  rm -f "$PLIST_PATH"
  echo "Removed $LABEL"
  exit 0
fi

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "The OpenRappter iMessage service requires macOS." >&2
  exit 1
fi
if [[ "$EUID" -eq 0 ]]; then
  echo "Install the iMessage service as the logged-in Messages user, never root." >&2
  exit 1
fi
if ! launchctl print "$DOMAIN" >/dev/null 2>&1; then
  echo "No logged-in Aqua session is available for $DOMAIN." >&2
  exit 1
fi
if [[ -z "$PYTHON_BIN" || ! -x "$PYTHON_BIN" ]]; then
  echo "Python 3 was not found." >&2
  exit 1
fi
if [[ ! -f "$CONFIG_PATH" ]]; then
  echo "iMessage configuration not found: $CONFIG_PATH" >&2
  echo "Create it with: cd python && python3 -m openrappter.imessage --config \"$CONFIG_PATH\" init --owner <your-handle>" >&2
  exit 1
fi

"$PYTHON_BIN" -m openrappter.imessage --config "$CONFIG_PATH" preflight

mkdir -p "$(dirname "$PLIST_PATH")" "$OPENRAPPTER_HOME/logs"

xml_escape() {
  printf '%s' "$1" \
    | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' \
      -e 's/"/\&quot;/g' -e "s/'/\&apos;/g"
}

python_xml="$(xml_escape "$PYTHON_BIN")"
config_xml="$(xml_escape "$CONFIG_PATH")"
home_xml="$(xml_escape "$OPENRAPPTER_HOME")"
path_xml="$(xml_escape "$OPENRAPPTER_HOME/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin")"

cat > "$PLIST_PATH" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$python_xml</string>
    <string>-m</string>
    <string>openrappter.imessage</string>
    <string>--config</string>
    <string>$config_xml</string>
    <string>run</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>OPENRAPPTER_HOME</key>
    <string>$home_xml</string>
    <key>PATH</key>
    <string>$path_xml</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>ProcessType</key>
  <string>Interactive</string>
  <key>LimitLoadToSessionType</key>
  <string>Aqua</string>
  <key>StandardOutPath</key>
  <string>$home_xml/logs/imessage.out.log</string>
  <key>StandardErrorPath</key>
  <string>$home_xml/logs/imessage.err.log</string>
</dict>
</plist>
PLIST

chmod 600 "$PLIST_PATH"
plutil -lint "$PLIST_PATH" >/dev/null
if [[ "${OPENRAPPTER_SERVICE_DRY_RUN:-0}" == "1" ]]; then
  echo "Validated $PLIST_PATH (dry run; service not loaded)"
  exit 0
fi
launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
launchctl bootstrap "$DOMAIN" "$PLIST_PATH"
launchctl kickstart -k "$DOMAIN/$LABEL"

echo "Installed and started $LABEL"
echo "Config: $CONFIG_PATH"
echo "Status: launchctl print $DOMAIN/$LABEL"
