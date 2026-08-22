#!/bin/bash
#
# Send an iMessage attachment that actually arrives.
#
#   send-attachment.sh <recipient> <file> [message-file]
#
# WHY THIS EXISTS
#
# `send <alias> to <buddy>` in AppleScript returns cleanly and creates a real
# row in chat.db, but the attachment silently never transfers: the row lands
# with is_sent=0, error=25, transfer_state=6, and attachment.filename is left
# pointing at the source path instead of being rewritten into the Messages
# store. Twenty-four consecutive catch-up videos failed this way.
#
# The cause is not AppleScript, the recipient, the file size, or the file type.
# It is `imagent`, the daemon that performs the transfer. Streaming its log
# during a send shows, eight times per attempt:
#
#   imagent (libcopyfile.dylib) open on /tmp/r21a.mp4: Operation not permitted
#
# EPERM, not EACCES — a sandbox refusal rather than a POSIX mode problem; the
# file was 0644 and world-readable. imagent is sandboxed and carries no general
# file-read grant. Its entitlements do include kTCCServicePhotos and
# kTCCServiceMediaLibrary, which cover ~/Pictures, and that is the whole of the
# rule. Measured, one send per location:
#
#   ~/Pictures      sent=1 error=0   (twice, and the filename was rewritten
#                                     into ~/Library/Messages/Attachments)
#   /tmp            sent=0 error=25
#   ~/Desktop       sent=0 error=25
#   ~/Documents     sent=0 error=25
#   ~/Downloads     sent=0 error=25
#   ~/Movies        sent=0 error=25
#   /Users/Shared   sent=0 error=25
#
# So: stage the file inside ~/Pictures, send it from there, then remove it.
#
# There is no permission toggle for this. imagent is an Apple system daemon and
# does not appear in Full Disk Access; there is no Files-and-Folders entry for
# it or for Messages. Granting Terminal or the calling process more access
# changes nothing, because the process that cannot open the file is imagent.
#
# This is also why sending by hand always worked: dragging a file into the
# Messages window hands imagent a powerbox grant for that specific file, which
# an AppleScript send never obtains.
#
set -euo pipefail

if [ $# -lt 2 ]; then
  echo "usage: send-attachment.sh <recipient> <file> [message-file]" >&2
  exit 64
fi

RECIPIENT="$1"
SOURCE="$2"
MESSAGE_FILE="${3:-}"

[ -f "$SOURCE" ] || { echo "no such file: $SOURCE" >&2; exit 66; }

# The one directory imagent can read. Keep the real extension: Messages picks
# the UTI from it, and a wrong one changes how the attachment is presented.
STAGE_DIR="$HOME/Pictures/.openrappter-outbox"
mkdir -p "$STAGE_DIR"
STAGED="$STAGE_DIR/$(date +%s)-$$-$(basename "$SOURCE")"

# Invoked by the trap below, which shellcheck does not trace.
# shellcheck disable=SC2317
# shellcheck disable=SC2329
cleanup() { rm -f "$STAGED"; }
trap cleanup EXIT

cp "$SOURCE" "$STAGED"

BEFORE=$(sqlite3 -readonly "$HOME/Library/Messages/chat.db" \
  "SELECT COALESCE(MAX(ROWID),0) FROM message;")

/usr/bin/osascript - "$RECIPIENT" "$STAGED" "$MESSAGE_FILE" <<'APPLESCRIPT' >/dev/null
on run argv
  -- Resolve the alias outside the tell block: inside it, `POSIX file` is
  -- interpreted by Messages rather than the system event dispatcher and
  -- fails with -1728.
  set attachmentAlias to (POSIX file (item 2 of argv)) as alias
  set messageFile to item 3 of argv
  set hasMessage to (messageFile is not "")
  if hasMessage then
    set messageBody to read (POSIX file messageFile) as «class utf8»
  end if

  tell application "Messages"
    set targetService to 1st service whose service type = iMessage
    set targetBuddy to participant (item 1 of argv) of targetService
    send attachmentAlias to targetBuddy
    if hasMessage then
      delay 3
      send messageBody to targetBuddy
    end if
  end tell
end run
APPLESCRIPT

# A clean osascript return proves nothing — that is exactly how all 24 failures
# looked. Only chat.db knows whether the transfer happened, and the row does not
# reach its final state instantly.
for _ in $(seq 1 20); do
  sleep 2
  ROW=$(sqlite3 -readonly "$HOME/Library/Messages/chat.db" "
    SELECT m.ROWID || '|' || m.is_sent || '|' || m.error || '|' ||
           COALESCE(a.transfer_state, -1)
    FROM message m
    JOIN message_attachment_join maj ON maj.message_id = m.ROWID
    JOIN attachment a ON a.ROWID = maj.attachment_id
    WHERE m.ROWID > $BEFORE ORDER BY m.ROWID DESC LIMIT 1;")
  [ -n "$ROW" ] || continue
  IFS='|' read -r ROWID SENT ERR STATE <<< "$ROW"
  if [ "$SENT" = "1" ] && [ "$ERR" = "0" ]; then
    echo "delivered: rowid=$ROWID is_sent=$SENT error=$ERR transfer_state=$STATE"
    exit 0
  fi
  if [ "$ERR" != "0" ]; then
    echo "FAILED: rowid=$ROWID is_sent=$SENT error=$ERR transfer_state=$STATE" >&2
    exit 1
  fi
done

echo "FAILED: no confirmed send row appeared within 40s" >&2
exit 1
