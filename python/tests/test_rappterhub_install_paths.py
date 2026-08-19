"""Installing an agent must not touch anything outside the agents directory.

Measured before the fix, with the agents directory at ~/.openrappter/agents:

    install("evil/../precious")      -> shutil.rmtree deleted .../precious
    install("evil//etc/cron.d")      -> target_dir was /etc/cron.d
    install("x//")                   -> target_dir was /
    install("http://h/path/..")      -> target_dir was ~/.openrappter itself

`install` deletes target_dir and then runs `git clone` into it, so the same
two lines gave a remote repository both arbitrary deletion and arbitrary
file write. Only the first slash was consumed by the split, so everything
after it -- separators, `..`, a leading `/` -- became part of the path.
"""
import json
import shutil
import subprocess
from pathlib import Path

import pytest

from openrappter import rappterhub as rh


@pytest.fixture
def hub(tmp_path, monkeypatch):
    """A client rooted entirely inside tmp_path, never the real home."""
    agents = tmp_path / "home" / ".openrappter" / "agents"
    agents.mkdir(parents=True)
    hub_dir = tmp_path / "home" / ".rappterhub"
    hub_dir.mkdir(parents=True)

    monkeypatch.setattr(rh, "AGENTS_DIR", agents)
    monkeypatch.setattr(rh, "RAPPTERHUB_DIR", hub_dir)
    monkeypatch.setattr(rh, "LOCK_FILE", hub_dir / "lock.json")
    monkeypatch.setattr(rh, "REGISTRY_GITHUB", "http://127.0.0.1:1/registry")
    monkeypatch.setattr(rh, "REGISTRY_URL", "http://127.0.0.1:1")

    client = rh.RappterHubClient()
    client.root = tmp_path
    return client


@pytest.fixture
def victim(tmp_path):
    """A directory outside the agents tree that must survive every test."""
    directory = tmp_path / "home" / "precious"
    directory.mkdir(parents=True)
    (directory / "important.txt").write_text("irreplaceable")
    return directory


def _no_network(monkeypatch):
    """Fail any clone or download instantly instead of reaching the network."""
    def refuse(*args, **kwargs):
        raise AssertionError("test attempted a real network call")

    monkeypatch.setattr(subprocess, "run", refuse)


class TestReferencesCannotEscapeTheAgentsDirectory:
    @pytest.mark.parametrize(
        "ref",
        [
            "evil/../precious",
            "evil/../../precious",
            "evil/../../../../etc",
            "evil//etc/cron.d",
            "evil//",
            "x//",
            "evil/sub/dir",
            "evil/.",
            "evil/..",
            "evil/.ssh",
            "evil/-rf",
            "evil/na\x00me",
            "evil/na me",
            "../evil",
        ],
    )
    def test_a_traversing_reference_is_rejected(self, hub, monkeypatch, ref):
        _no_network(monkeypatch)
        result = hub.install(ref)
        assert result["status"] == "error"

    @pytest.mark.parametrize(
        "ref",
        [
            "evil/../precious",
            "evil/../../precious",
        ],
    )
    def test_the_directory_outside_survives(self, hub, victim, monkeypatch, ref):
        _no_network(monkeypatch)
        hub.install(ref)
        assert victim.exists()
        assert (victim / "important.txt").read_text() == "irreplaceable"

    def test_an_absolute_reference_cannot_target_another_directory(
        self, hub, victim, monkeypatch
    ):
        _no_network(monkeypatch)
        result = hub.install(f"evil/{victim}")
        assert result["status"] == "error"
        assert (victim / "important.txt").exists()

    def test_a_url_ending_in_dotdot_cannot_target_the_openrappter_home(
        self, hub, monkeypatch
    ):
        _no_network(monkeypatch)
        home = hub.agents_dir.parent
        marker = home / "config.json5"
        marker.write_text("{}")

        result = hub.install("http://127.0.0.1:1/path/..")

        assert result["status"] == "error"
        assert marker.exists()
        assert home.exists()


class TestLegitimateInstallsStillWork:
    """The validator must not be so tight that it rejects real agents."""

    @pytest.mark.parametrize(
        "segment", ["agent", "my-agent", "my_agent", "agent.v2", "Agent2", "a"]
    )
    def test_ordinary_names_are_accepted(self, segment):
        assert rh._is_safe_segment(segment)

    @pytest.mark.parametrize(
        "segment", ["", ".", "..", "/", "a/b", "../a", "/etc", ".hidden", "-flag", "a\x00b"]
    )
    def test_dangerous_names_are_refused(self, segment):
        assert not rh._is_safe_segment(segment)

    def test_a_valid_reference_reaches_the_install_body(self, hub, monkeypatch):
        """Proves validation lets a good ref through, without any network."""
        created = {}

        def fake_clone(argv, **kwargs):
            Path(argv[-1]).mkdir(parents=True, exist_ok=True)
            created["target"] = Path(argv[-1])
            return subprocess.CompletedProcess(argv, 0, "", "")

        monkeypatch.setattr(subprocess, "run", fake_clone)

        result = hub.install("someauthor/someagent")

        assert created["target"] == hub.agents_dir / "someagent"
        # Got past validation and cloning, and stopped on the manifest check.
        assert "AGENT.md" in result["message"]

    def test_reinstalling_still_replaces_an_existing_agent(self, hub, monkeypatch):
        stale = hub.agents_dir / "someagent"
        stale.mkdir()
        (stale / "old.txt").write_text("stale")

        def fake_clone(argv, **kwargs):
            Path(argv[-1]).mkdir(parents=True, exist_ok=True)
            return subprocess.CompletedProcess(argv, 0, "", "")

        monkeypatch.setattr(subprocess, "run", fake_clone)

        hub.install("someauthor/someagent")

        assert not (stale / "old.txt").exists()


class TestContainment:
    def test_a_path_inside_is_accepted(self, tmp_path):
        assert rh._is_within(tmp_path, tmp_path / "a" / "b")

    def test_the_base_itself_is_accepted(self, tmp_path):
        assert rh._is_within(tmp_path, tmp_path)

    def test_a_sibling_is_rejected(self, tmp_path):
        base = tmp_path / "base"
        base.mkdir()
        assert not rh._is_within(base, tmp_path / "other")

    def test_a_parent_is_rejected(self, tmp_path):
        base = tmp_path / "base"
        base.mkdir()
        assert not rh._is_within(base, tmp_path)

    def test_a_symlink_out_of_the_base_is_rejected(self, tmp_path):
        base = tmp_path / "base"
        base.mkdir()
        outside = tmp_path / "outside"
        outside.mkdir()
        link = base / "link"
        link.symlink_to(outside, target_is_directory=True)

        assert not rh._is_within(base, link / "file")


class TestUninstallWillNotFollowAPoisonedLockFile:
    def test_a_lock_entry_pointing_outside_is_refused(self, hub, victim):
        rh.LOCK_FILE.parent.mkdir(parents=True, exist_ok=True)
        rh.LOCK_FILE.write_text(
            json.dumps(
                {
                    "installed": {
                        "evil/agent": {
                            "name": "evil",
                            "version": "1",
                            "path": str(victim),
                            "author": "evil",
                        }
                    },
                    "version": 1,
                }
            )
        )

        result = hub.uninstall("evil")

        assert result["status"] == "error"
        assert (victim / "important.txt").read_text() == "irreplaceable"

    def test_an_agent_inside_the_directory_is_still_removed(self, hub):
        installed = hub.agents_dir / "good"
        installed.mkdir()
        (installed / "agent.py").write_text("# code")
        rh.LOCK_FILE.parent.mkdir(parents=True, exist_ok=True)
        rh.LOCK_FILE.write_text(
            json.dumps(
                {
                    "installed": {
                        "someauthor/good": {
                            "name": "good",
                            "version": "1",
                            "path": str(installed),
                            "author": "someauthor",
                        }
                    },
                    "version": 1,
                }
            )
        )

        result = hub.uninstall("good")

        assert result["status"] == "success"
        assert not installed.exists()
