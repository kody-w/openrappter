"""The brainstem's saved Copilot credential must not be readable by other accounts.

Measured on `main` before this suite existed, by calling `_save_token_file` with
a real-shaped payload and stat-ing the result:

    token file  ~/.openrappter/brainstem/.copilot_token   mode 0644
    directory   ~/.openrappter/brainstem                  mode 0755

    umask 0022 -> 0644   readable by group, other
    umask 0002 -> 0664   readable by group, other
    umask 0000 -> 0666   readable AND WRITABLE by group, other

The file holds `{"access_token": ..., "refresh_token": ...}`. The refresh token
is the long-lived one, so an account that reads it once keeps access after the
access token expires.

Two things made this a clear defect rather than a judgement call:

  * The flight recorder already treats this exact path as a secret --- it
    redacts `.copilot_token` out of captured logs (`flight_recorder.py:136`).
    The codebase knew the file was sensitive while writing it world-readable.
  * The TypeScript runtime writes the same credential correctly, with
    `{ mode: 0o600 }` (`typescript/src/providers/copilot-token.ts:63`). Same
    credential, same purpose, two runtimes, one of them wrong.

Every other secret in the Python tree already used the strict pattern
(`imessage/config.py`, `flight_recorder.py`, `manage_memory_agent.py`,
`pokemon_agent.py`); `_save_token_file` was the one place that did not.
"""

import json
import os
import stat
from pathlib import Path

import pytest

from openrappter import brainstem


def _mode(path):
    return stat.S_IMODE(os.stat(path).st_mode)


@pytest.fixture
def home(tmp_path, monkeypatch):
    """Point the brainstem at a private directory under tmp_path."""
    root = tmp_path / ".openrappter" / "brainstem"
    monkeypatch.setattr(brainstem, "BRAINSTEM_HOME", root)
    return root


class TestTheSavedCredentialIsPrivate:
    def test_the_token_file_is_not_readable_by_other_accounts(self, home):
        brainstem._save_token_file({"access_token": "ghu_x", "refresh_token": "ghr_y"})
        assert _mode(brainstem._token_file()) & 0o077 == 0

    def test_the_token_file_is_exactly_owner_read_write(self, home):
        brainstem._save_token_file({"access_token": "ghu_x"})
        assert _mode(brainstem._token_file()) == 0o600

    def test_the_directory_holding_it_is_not_listable_by_other_accounts(self, home):
        brainstem._save_token_file({"access_token": "ghu_x"})
        assert _mode(home) & 0o077 == 0

    @pytest.mark.parametrize("umask", [0o022, 0o002, 0o000])
    def test_no_umask_can_widen_it(self, home, umask):
        """A permissive umask used to make the file group- and world-writable."""
        previous = os.umask(umask)
        try:
            brainstem._save_token_file({"access_token": "ghu_x"})
        finally:
            os.umask(previous)
        assert _mode(brainstem._token_file()) == 0o600

    def test_the_credential_still_round_trips(self, home):
        """Locking the file down must not stop the brainstem reading it back."""
        saved = {"access_token": "ghu_x", "refresh_token": "ghr_y"}
        brainstem._save_token_file(saved)
        assert brainstem._read_token_file() == saved

    def test_a_legacy_plain_text_token_still_reads(self, home):
        home.mkdir(parents=True, exist_ok=True)
        brainstem._token_file().write_text("ghu_bare", encoding="utf-8")
        assert brainstem._read_token_file() == {"access_token": "ghu_bare"}


class TestExistingInstallsAreRepaired:
    """Fixing only the write path would leave everyone already logged in exposed."""

    def test_a_token_left_world_readable_is_tightened_on_read(self, home):
        home.mkdir(parents=True, exist_ok=True)
        path = brainstem._token_file()
        path.write_text(json.dumps({"access_token": "ghu_old"}), encoding="utf-8")
        os.chmod(path, 0o644)

        assert brainstem._read_token_file() == {"access_token": "ghu_old"}
        assert _mode(path) == 0o600

    def test_repairing_does_not_lose_the_credential(self, home):
        home.mkdir(parents=True, exist_ok=True)
        path = brainstem._token_file()
        payload = {"access_token": "ghu_old", "refresh_token": "ghr_old"}
        path.write_text(json.dumps(payload), encoding="utf-8")
        os.chmod(path, 0o666)

        assert brainstem._read_token_file() == payload
        assert _mode(path) == 0o600

    def test_an_already_private_token_is_left_alone(self, home):
        home.mkdir(parents=True, exist_ok=True)
        path = brainstem._token_file()
        path.write_text(json.dumps({"access_token": "ghu_x"}), encoding="utf-8")
        os.chmod(path, 0o400)

        brainstem._read_token_file()
        assert _mode(path) == 0o400

    def test_a_missing_token_is_not_an_error(self, home):
        assert brainstem._read_token_file() is None


class TestTheWriteIsAtomic:
    """`write_text` truncated first, so a crash mid-write silently logged you out."""

    def test_a_failed_write_leaves_the_previous_credential_intact(self, home, monkeypatch):
        brainstem._save_token_file({"access_token": "ghu_good"})

        def boom(*args, **kwargs):
            raise OSError("disk full")

        monkeypatch.setattr(brainstem.os, "replace", boom)
        with pytest.raises(OSError):
            brainstem._save_token_file({"access_token": "ghu_new"})

        assert brainstem._read_token_file() == {"access_token": "ghu_good"}

    def test_a_failed_write_does_not_leave_temporary_files_behind(self, home, monkeypatch):
        brainstem._save_token_file({"access_token": "ghu_good"})

        def boom(*args, **kwargs):
            raise OSError("disk full")

        monkeypatch.setattr(brainstem.os, "replace", boom)
        with pytest.raises(OSError):
            brainstem._save_token_file({"access_token": "ghu_new"})

        leftovers = [p.name for p in home.iterdir() if p.name != ".copilot_token"]
        assert leftovers == []

    def test_overwriting_keeps_the_file_private(self, home):
        brainstem._save_token_file({"access_token": "ghu_first"})
        brainstem._save_token_file({"access_token": "ghu_second"})
        assert brainstem._read_token_file() == {"access_token": "ghu_second"}
        assert _mode(brainstem._token_file()) == 0o600


class TestImportedAgentsArePrivate:
    """`AGENTS_PATH` holds code the server imports and then executes."""

    def test_a_secured_directory_is_tightened_even_if_it_already_exists(self, tmp_path):
        existing = tmp_path / "agents"
        existing.mkdir(mode=0o755)
        assert _mode(existing) == 0o755

        brainstem._secure_dir(existing)
        assert _mode(existing) == 0o700

    def test_a_written_agent_file_is_not_readable_by_other_accounts(self, tmp_path):
        target = tmp_path / "agents" / "demo_agent.py"
        brainstem._write_private_file(target, b"# agent code\n")
        assert _mode(target) == 0o600
        assert target.read_bytes() == b"# agent code\n"

    def test_the_directory_is_created_private(self, tmp_path):
        target = tmp_path / "fresh" / "demo_agent.py"
        brainstem._write_private_file(target, b"x")
        assert _mode(target.parent) == 0o700
