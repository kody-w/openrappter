"""The iMessage attachment send path must verify delivery, not assume it.

Twenty-four consecutive attachment sends failed while the AppleScript that
issued them returned cleanly every time. Nobody noticed for six days because
the only evidence anyone looked at was that clean return. chat.db knew: every
one of those rows carried is_sent=0, error=25, transfer_state=6, and an
attachment.filename still pointing at the source path rather than having been
rewritten into ~/Library/Messages/Attachments.

The cause was imagent, the daemon that performs the transfer, being unable to
open the source file — `open on <path>: Operation not permitted`, EPERM rather
than EACCES, on a mode-0644 file. imagent is sandboxed with no general
file-read grant; its entitlements cover Photos and MediaLibrary, hence
~/Pictures, and nothing else. Measured one send per location: ~/Pictures
delivered, while /tmp, ~/Desktop, ~/Documents, ~/Downloads, ~/Movies and
/Users/Shared each returned error=25.

These tests do not send anything. They pin the two properties that let the
failure hide for six days: the script stages into the one readable directory,
and it decides delivery from chat.db rather than from osascript's exit code.
"""

import re
import subprocess
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "send-attachment.sh"
BODY = SCRIPT.read_text()


def test_the_script_exists_and_is_executable():
    assert SCRIPT.is_file(), "send-attachment.sh is missing"
    assert SCRIPT.stat().st_mode & 0o111, "send-attachment.sh is not executable"


def test_it_is_valid_bash():
    proc = subprocess.run(["bash", "-n", str(SCRIPT)], capture_output=True, text=True)
    assert proc.returncode == 0, proc.stderr


def test_it_stages_into_the_only_directory_imagent_can_read():
    # ~/Pictures is not a preference. It is the single location that worked in
    # a seven-location test, because imagent holds Photos/MediaLibrary access
    # and no general file-read grant.
    assert "$HOME/Pictures" in BODY, "the staging directory must be under ~/Pictures"


def test_it_does_not_send_straight_from_the_source_path():
    # Sending the caller's path directly is the original bug: any path outside
    # ~/Pictures produces error=25 while osascript still reports success.
    send_line = [l for l in BODY.splitlines() if "osascript" in l and "SOURCE" in l]
    assert not send_line, "the source path must be staged, never sent directly"
    assert 'cp "$SOURCE" "$STAGED"' in BODY


def test_it_confirms_delivery_against_chat_db():
    # The whole failure: a clean osascript return was treated as delivery.
    assert "chat.db" in BODY, "delivery must be confirmed against chat.db"
    assert "is_sent" in BODY and "m.error" in BODY


def test_it_requires_both_is_sent_and_error_zero():
    # is_sent alone is not enough — a row can carry is_sent=0 with error=25,
    # and treating a missing error as success would pass the broken case.
    assert re.search(r'"\$SENT"\s*=\s*"1"', BODY), "must require is_sent=1"
    assert re.search(r'"\$ERR"\s*=\s*"0"', BODY), "must require error=0"


def test_it_exits_non_zero_when_the_transfer_fails():
    # A send script that fails silently is how twenty-four videos disappeared.
    assert "exit 1" in BODY, "a failed transfer must be a non-zero exit"
    assert "FAILED" in BODY


def test_it_does_not_give_up_before_the_row_settles():
    # The row does not reach its final state the instant osascript returns;
    # reading it too early would report a false failure.
    assert "seq 1" in BODY, "must poll rather than check once"


def test_it_cleans_up_the_staged_copy():
    # Staging into ~/Pictures without cleanup would slowly fill the Photos
    # directory with copies of every attachment ever sent.
    assert "trap cleanup EXIT" in BODY


def test_it_rejects_a_missing_file_rather_than_sending_nothing():
    proc = subprocess.run(
        ["bash", str(SCRIPT), "+15555550100", "/nonexistent/file.mp4"],
        capture_output=True, text=True, timeout=30,
    )
    assert proc.returncode != 0
    assert "no such file" in proc.stderr.lower()


def test_it_rejects_too_few_arguments():
    proc = subprocess.run(
        ["bash", str(SCRIPT), "+15555550100"], capture_output=True, text=True, timeout=30,
    )
    assert proc.returncode != 0
    assert "usage" in proc.stderr.lower()


def test_the_diagnosis_is_recorded_where_the_next_reader_will_find_it():
    # This cost a full diagnostic session. The next person to see error=25
    # should not have to repeat it.
    for evidence in ("error=25", "Operation not permitted", "imagent"):
        assert evidence in BODY, f"the header should record {evidence!r}"
