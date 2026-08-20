"""A lock file that is an object but not the expected shape must not crash.

Both registry clients read a lock and immediately evaluate
``lock["installed"]``. ``atomic_io.read_json_object`` guarded the top level --
a lock holding ``[]`` or ``"hello"`` is moved aside -- but a lock holding
``{}`` is a perfectly good object and was handed straight back.

Measured against the released code, calling ``install`` with nothing actually
installed:

    {}                                     KeyError: 'installed'
    {"version": 1}                         KeyError: 'installed'
    {"installed": null}                    TypeError: not iterable
    {"installed": 7}                       TypeError: not iterable
    {"installed": "alice/tool-and-more"}   "already installed"
    {"installed": ["alice/tool"]}          "already installed"

The two that do not raise are the worse pair: ``in`` against a string is a
substring test, so ``install`` refuses to run and reports an agent as present
that was never installed.

For ClawHub the crash lands after ``npx clawhub install`` has already put the
skill on disk, so the work succeeds and only the bookkeeping explodes -- the
caller sees a traceback and the lock never learns what was installed.
"""
from __future__ import annotations

import json

import pytest

from openrappter import clawhub as ch
from openrappter import rappterhub as rh


MALFORMED = [
    pytest.param({}, id="empty-object"),
    pytest.param({"version": 1}, id="version-only"),
    pytest.param({"installed": None}, id="installed-null"),
    pytest.param({"installed": 7}, id="installed-number"),
    pytest.param({"installed": True}, id="installed-bool"),
    pytest.param({"installed": "alice/tool-and-then-some"}, id="installed-string"),
    pytest.param({"installed": ["alice/tool"]}, id="installed-list"),
]


@pytest.fixture
def hub(tmp_path, monkeypatch):
    """A RappterHub client rooted in tmp_path, pointed at a dead registry."""
    agents = tmp_path / "home" / ".openrappter" / "agents"
    agents.mkdir(parents=True)
    hub_dir = tmp_path / "home" / ".rappterhub"
    hub_dir.mkdir(parents=True)

    monkeypatch.setattr(rh, "AGENTS_DIR", agents)
    monkeypatch.setattr(rh, "RAPPTERHUB_DIR", hub_dir)
    monkeypatch.setattr(rh, "LOCK_FILE", hub_dir / "lock.json")
    monkeypatch.setattr(rh, "REGISTRY_GITHUB", "http://127.0.0.1:1/registry")
    monkeypatch.setattr(rh, "REGISTRY_URL", "http://127.0.0.1:1")

    return rh.RappterHubClient()


def write_lock(hub_client, value) -> None:
    rh.LOCK_FILE.write_text(json.dumps(value), encoding="utf-8")


class TestRappterHubSurvivesAMalformedLock:
    @pytest.mark.parametrize("lock", MALFORMED)
    def test_install_does_not_raise(self, hub, lock):
        write_lock(hub, lock)

        result = hub.install("alice/tool")

        assert isinstance(result, dict)
        assert result.get("status") in {"error", "success"}

    @pytest.mark.parametrize("lock", MALFORMED)
    def test_install_never_claims_an_agent_is_already_installed(self, hub, lock):
        """Nothing is installed, so "already installed" is a false answer that
        leaves the user unable to install without passing force=True."""
        write_lock(hub, lock)

        result = hub.install("alice/tool")

        assert "already installed" not in result.get("message", "")

    @pytest.mark.parametrize("lock", MALFORMED)
    def test_the_loaded_lock_is_usable_as_the_code_expects(self, hub, lock):
        write_lock(hub, lock)

        loaded = hub._load_lock()

        assert isinstance(loaded["installed"], dict)

    def test_a_lock_that_lost_only_the_key_keeps_its_other_contents(self, hub):
        write_lock(hub, {"version": 4})

        loaded = hub._load_lock()

        assert loaded["version"] == 4
        assert loaded["installed"] == {}
        assert rh.LOCK_FILE.exists()

    def test_a_wrongly_typed_lock_is_preserved_on_disk(self, hub):
        original = {"installed": "alice/tool"}
        write_lock(hub, original)

        hub._load_lock()

        kept = [p for p in rh.LOCK_FILE.parent.iterdir() if "corrupt" in p.name]
        assert len(kept) == 1
        assert json.loads(kept[0].read_text()) == original

    def test_a_real_lock_still_reports_an_installed_agent(self, hub):
        """The guard must not swallow the answer it exists to protect."""
        write_lock(hub, {"installed": {"alice/tool": {"version": "1"}}, "version": 1})

        result = hub.install("alice/tool")

        assert "already installed" in result["message"]

    def test_a_real_lock_survives_a_load_unchanged(self, hub):
        write_lock(hub, {"installed": {"alice/tool": {"version": "1"}}, "version": 1})

        loaded = hub._load_lock()

        assert loaded == {"installed": {"alice/tool": {"version": "1"}}, "version": 1}
        assert rh.LOCK_FILE.exists()

    def test_uninstall_does_not_raise_on_a_malformed_lock(self, hub):
        write_lock(hub, {"installed": "alice/tool"})

        result = hub.uninstall("tool")

        assert isinstance(result, dict)


class TestClawHubSurvivesAMalformedLock:
    @pytest.mark.parametrize("lock", MALFORMED)
    def test_recording_an_install_does_not_raise(self, tmp_path, lock):
        client = ch.ClawHubClient(skills_dir=tmp_path / "skills")
        client._lock_file.parent.mkdir(parents=True, exist_ok=True)
        client._lock_file.write_text(json.dumps(lock), encoding="utf-8")

        loaded = client._load_lock()
        loaded["installed"]["some-skill"] = {"version": "latest"}
        client._save_lock(loaded)

        assert client._load_lock()["installed"]["some-skill"] == {"version": "latest"}

    def test_a_real_lock_is_not_disturbed(self, tmp_path):
        client = ch.ClawHubClient(skills_dir=tmp_path / "skills")
        client._lock_file.parent.mkdir(parents=True, exist_ok=True)
        client._lock_file.write_text(
            json.dumps({"installed": {"kept": {"version": "1"}}}), encoding="utf-8"
        )

        loaded = client._load_lock()

        assert loaded == {"installed": {"kept": {"version": "1"}}}
        assert client._lock_file.exists()

    def test_a_missing_lock_still_starts_empty(self, tmp_path):
        client = ch.ClawHubClient(skills_dir=tmp_path / "skills")

        assert client._load_lock() == {"installed": {}}
