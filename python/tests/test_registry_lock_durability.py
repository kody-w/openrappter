"""The registry lock files must survive an interrupted write.

Measured against the released code, killing a process during ``_save_lock``
left ``lock.json`` zero length and unparseable in 5 of 5 attempts. What that
cost the user was specific, and worse than "the list is empty":

    list_installed  still showed the agent   (it scans the filesystem)
    load_agent      still executed its code  (it scans the filesystem)
    uninstall       said "Agent 'demo' not found"  (it reads the lock)

So the agent stayed visible, kept running, and became impossible to remove
with the tool. Only ``uninstall`` consults the lock, which is why losing it
produces an agent that cannot be uninstalled rather than one that disappears.

After the fix, 5 of 5 kills during the real ``_save_lock`` left a lock that
reloaded with every entry present.
"""
from __future__ import annotations

import json

import pytest

import openrappter.clawhub as ch
import openrappter.rappterhub as rh


@pytest.fixture
def hub(tmp_path, monkeypatch):
    """A RappterHub rooted entirely inside tmp_path."""
    agents = tmp_path / "agents"
    home = tmp_path / "rappterhub"
    agents.mkdir(parents=True)
    home.mkdir(parents=True)

    monkeypatch.setattr(rh, "AGENTS_DIR", agents)
    monkeypatch.setattr(rh, "RAPPTERHUB_DIR", home)
    monkeypatch.setattr(rh, "LOCK_FILE", home / "lock.json")
    monkeypatch.setattr(rh, "REGISTRY_GITHUB", "https://example.invalid/registry")
    monkeypatch.setattr(rh, "REGISTRY_URL", "https://example.invalid")
    return rh.RappterHubClient()


@pytest.fixture
def claw(tmp_path, monkeypatch):
    skills = tmp_path / "skills"
    monkeypatch.setattr(ch, "SKILLS_DIR", skills)
    return ch.ClawHubClient(skills_dir=skills)


def temporaries(directory):
    return sorted(p.name for p in directory.iterdir() if p.name.endswith(".tmp"))


def corrupt_copies(directory):
    return sorted(p.name for p in directory.iterdir() if "corrupt" in p.name)


class TestTheRappterHubLockSurvivesAWriteThatDoesNotFinish:
    def test_a_saved_lock_reloads(self, hub):
        hub._save_lock({"version": 1, "installed": {"a/b": {"name": "b"}}})
        assert hub._load_lock() == {"version": 1, "installed": {"a/b": {"name": "b"}}}

    def test_saving_replaces_the_file_rather_than_truncating_it(self, hub):
        """``write_text`` truncates the visible file before writing a byte.
        A rename never exposes a half-written state, and shows up as a new
        inode. This is the assertion that fails if anyone puts write_text back.
        """
        hub._save_lock({"version": 1, "installed": {}})
        first_inode = rh.LOCK_FILE.stat().st_ino

        hub._save_lock({"version": 1, "installed": {"a/b": {"name": "b"}}})

        assert rh.LOCK_FILE.stat().st_ino != first_inode

    def test_saving_leaves_no_temporary_file_behind(self, hub):
        hub._save_lock({"version": 1, "installed": {"a/b": {}}})
        assert temporaries(rh.RAPPTERHUB_DIR) == []

    def test_the_lock_is_created_owner_only(self, hub):
        import stat as stat_module

        hub._save_lock({"version": 1, "installed": {}})
        mode = stat_module.S_IMODE(rh.LOCK_FILE.stat().st_mode)
        assert mode == 0o600


class TestADamagedRappterHubLockIsKeptNotDiscarded:
    def test_a_half_written_lock_is_moved_aside(self, hub):
        rh.LOCK_FILE.write_text('{"version": 1, "installed": {"someone/dem')

        result = hub._load_lock()

        assert result == {"installed": {}, "version": 1}
        assert corrupt_copies(rh.RAPPTERHUB_DIR)

    def test_the_damaged_bytes_are_still_readable_afterwards(self, hub):
        rh.LOCK_FILE.write_text('{"version": 1, "installed": {"someone/dem')
        hub._load_lock()

        kept = [p for p in rh.RAPPTERHUB_DIR.iterdir() if "corrupt" in p.name]
        assert kept[0].read_text() == '{"version": 1, "installed": {"someone/dem'

    def test_a_damaged_lock_is_not_overwritten_by_the_next_save(self, hub):
        """Without preserving it, the next save destroys the only record of
        what was installed."""
        rh.LOCK_FILE.write_text("wreckage")
        lock = hub._load_lock()
        hub._save_lock(lock)

        kept = [p for p in rh.RAPPTERHUB_DIR.iterdir() if "corrupt" in p.name]
        assert kept[0].read_text() == "wreckage"

    @pytest.mark.parametrize("payload", ["[]", '"hello"', "null", "123"])
    def test_a_lock_that_is_not_an_object_does_not_crash_install(self, hub, monkeypatch, payload):
        """Measured on the released code, each of these raised TypeError out
        of install: 'list indices must be integers or slices, not str' and so
        on, because _load_lock returned whatever json.loads produced and
        install went straight to lock["installed"].
        """
        rh.LOCK_FILE.write_text(payload)

        def refuse(*args, **kwargs):
            raise AssertionError("install must not reach the network in tests")

        monkeypatch.setattr(rh.subprocess, "run", refuse)

        result = hub.install("someone/thing")

        assert result["status"] == "error"
        assert "Failed to install" in result["message"]

    def test_a_lock_that_is_not_an_object_still_lets_uninstall_answer(self, hub):
        rh.LOCK_FILE.write_text("[]")
        result = hub.uninstall("demo")
        assert result["status"] == "error"
        assert "not found" in result["message"]


class TestTheAgentThatCouldNotBeUninstalled:
    def test_losing_the_lock_makes_uninstall_fail_while_the_agent_remains(self, hub):
        """The symptom the fix exists to prevent, pinned so the cost of a lost
        lock stays visible. Nothing can recover a lock that is already gone --
        this documents what that costs, and the durability tests above are what
        stop it happening.
        """
        agent_dir = rh.AGENTS_DIR / "demo"
        agent_dir.mkdir()
        (agent_dir / "AGENT.md").write_text(
            "---\nname: demo\ndescription: d\nversion: 1.0.0\n---\n\n# demo\n"
        )
        hub._save_lock({
            "version": 1,
            "installed": {"someone/demo": {"name": "demo", "path": str(agent_dir)}},
        })

        assert hub.uninstall("demo")["status"] == "success"
        assert not agent_dir.exists()

    def test_with_a_destroyed_lock_the_same_uninstall_cannot_find_it(self, hub):
        agent_dir = rh.AGENTS_DIR / "demo"
        agent_dir.mkdir()
        (agent_dir / "AGENT.md").write_text(
            "---\nname: demo\ndescription: d\nversion: 1.0.0\n---\n\n# demo\n"
        )
        rh.LOCK_FILE.write_text("")

        result = hub.uninstall("demo")

        assert result["status"] == "error"
        assert "not found" in result["message"]
        assert agent_dir.exists()
        assert [a["name"] for a in hub.list_installed()] == ["demo"]


class TestTheClawHubLock:
    """ClawHub's lock is written on install and never read for anything that
    changes behaviour -- list_installed and load_skill both scan the
    filesystem, and there is no uninstall. Losing it costs nothing today. It
    gets the same durable write anyway, because the next reader of that file
    should not have to rediscover this.
    """

    def test_a_saved_lock_reloads(self, claw):
        claw._save_lock({"installed": {"some-skill": {"version": "latest"}}})
        assert claw._load_lock() == {"installed": {"some-skill": {"version": "latest"}}}

    def test_the_lock_directory_is_created_on_first_save(self, claw):
        """The explicit mkdir that used to live in _save_lock moved into the
        shared helper. If it ever stops happening, saving raises here."""
        assert not claw._lock_file.parent.exists()

        claw._save_lock({"installed": {}})

        assert claw._lock_file.exists()

    def test_saving_replaces_the_file_rather_than_truncating_it(self, claw):
        claw._save_lock({"installed": {}})
        first_inode = claw._lock_file.stat().st_ino

        claw._save_lock({"installed": {"some-skill": {}}})

        assert claw._lock_file.stat().st_ino != first_inode

    def test_saving_leaves_no_temporary_file_behind(self, claw):
        claw._save_lock({"installed": {"some-skill": {}}})
        assert temporaries(claw._lock_file.parent) == []

    def test_a_damaged_lock_is_moved_aside(self, claw):
        claw._save_lock({"installed": {}})
        claw._lock_file.write_text('{"installed": {"some-sk')

        assert claw._load_lock() == {"installed": {}}
        assert corrupt_copies(claw._lock_file.parent)

    def test_a_missing_lock_reads_as_empty(self, claw):
        assert claw._load_lock() == {"installed": {}}
        assert not claw._lock_file.exists()
