"""Storage regressions for the live JSON memory agents, not MemoryManager."""

import json
import os
from pathlib import Path
import queue
import stat
import subprocess
import sys
import threading
import uuid
from types import SimpleNamespace
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeout

import pytest

from openrappter.agents.manage_memory_agent import ManageMemoryAgent
from openrappter.agents.context_memory_agent import ContextMemoryAgent
from openrappter.agents import manage_memory_agent as json_store


def memory_agent(directory):
    agent = ManageMemoryAgent()
    agent.home = directory
    agent.memory_file = directory / "memory.json"
    return agent


@pytest.mark.parametrize("separate", [False, True])
def test_concurrent_writers_preserve_every_acknowledged_fact(tmp_path, separate):
    shared = memory_agent(tmp_path)
    with ThreadPoolExecutor(max_workers=12) as executor:
        results = list(executor.map(
            lambda index: json.loads(
                (memory_agent(tmp_path) if separate else shared).perform(
                    content=f"fact-{index:03d}"
                )
            ),
            range(12),
        ))
    assert all(result["status"] == "success" for result in results)
    memories = json.loads(shared.memory_file.read_text())
    assert sorted(entry["message"] for entry in memories.values()) == [
        f"fact-{index:03d}" for index in range(12)
    ]


@pytest.mark.parametrize("content", [
    "{broken", "null", "[]", '{"broken":42}', '{"broken":{"message":42}}',
])
def test_invalid_store_is_not_replaced(tmp_path, content):
    agent = memory_agent(tmp_path)
    agent.memory_file.write_text(content)
    with pytest.raises(Exception):
        agent.perform(content="new fact")
    assert agent.memory_file.read_text() == content


def test_invalid_utf8_is_not_rewritten(tmp_path):
    agent = memory_agent(tmp_path)
    content = b'{"legacy":{"message":"\xff"}}'
    agent.memory_file.write_bytes(content)
    with pytest.raises(json_store.MemoryStoreError, match="not valid JSON"):
        agent.perform(content="new fact")
    assert agent.memory_file.read_bytes() == content


def test_id_collision_does_not_overwrite_existing_fact(tmp_path, monkeypatch):
    agent = memory_agent(tmp_path)
    fixed = uuid.UUID("11111111-1111-1111-1111-111111111111")
    monkeypatch.setattr(uuid, "uuid4", lambda: fixed)
    agent.perform(content="first fact")
    before = agent.memory_file.read_bytes()
    with pytest.raises(Exception):
        agent.perform(content="second fact")
    assert agent.memory_file.read_bytes() == before


def test_legacy_schema_and_unknown_metadata_survive(tmp_path):
    agent = memory_agent(tmp_path)
    legacy = {
        "id": "old-id", "message": "legacy fact", "theme": "fact",
        "trust": {"custodians": ["principal:local-owner"], "grants": []},
        "custom": {"nested": [1, 2, 3]},
    }
    agent.memory_file.write_text(json.dumps({"mem_123": legacy}))
    agent.perform(content="new fact")
    assert json.loads(agent.memory_file.read_text())["mem_123"] == legacy


def test_direct_delete_is_in_the_same_transaction_as_perform(tmp_path):
    deleting = memory_agent(tmp_path)
    writing = memory_agent(tmp_path)
    first = json.loads(writing.perform(content="first fact"))["memory_id"]
    loaded = threading.Event()
    release = threading.Event()
    original_load = deleting._load_memories

    def pause_after_read():
        result = original_load()
        loaded.set()
        assert release.wait(5)
        return result

    deleting._load_memories = pause_after_read
    with ThreadPoolExecutor(max_workers=2) as executor:
        removal = executor.submit(deleting.delete_memory, first)
        assert loaded.wait(5)
        addition = executor.submit(writing.perform, content="second fact")
        try:
            # A writer must not commit while delete owns an old snapshot.
            with pytest.raises(FutureTimeout):
                addition.result(timeout=0.05)
        finally:
            release.set()
        assert json.loads(removal.result())["status"] == "success"
        assert json.loads(addition.result())["status"] == "success"
    assert [entry["message"] for entry in json.loads(writing.memory_file.read_text()).values()] == ["second fact"]


@pytest.fixture
def launch_writer(tmp_path):
    children = []
    fixture = Path(__file__).parent / "fixtures" / "memory_writer.py"
    home = tmp_path / "home"
    home.mkdir()

    def launch(mode="write", prefix="child", count=1):
        process = subprocess.Popen(
            [sys.executable, "-B", str(fixture), str(tmp_path), mode, prefix, str(count)],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True,
            env={
                "PATH": os.environ.get("PATH", ""),
                "HOME": str(home),
                "USERPROFILE": str(home),
                **{key: os.environ[key] for key in ("SYSTEMROOT", "WINDIR") if key in os.environ},
                "OPENRAPPTER_HOME": str(home),
                "TMPDIR": str(tmp_path),
                "TEMP": str(tmp_path),
                "TMP": str(tmp_path),
                "PYTHONPATH": str(Path(__file__).resolve().parents[1]),
                "PYTHONDONTWRITEBYTECODE": "1",
            },
        )
        children.append(process)
        lines = queue.Queue()

        def read_output():
            for line in process.stdout:
                lines.put(line.rstrip("\n"))

        threading.Thread(target=read_output, daemon=True).start()

        def line():
            return lines.get(timeout=10)

        def release():
            process.stdin.write("go\n")
            process.stdin.flush()
            assert line() == "attempting"

        assert line() == "ready"
        return process, release, line

    yield launch
    for process in children:
        if process.poll() is None:
            process.kill()
        process.wait(timeout=10)
        process.stdin.close()
        process.stdout.close()
        process.stderr.close()


def test_independent_python_processes_share_the_transaction(tmp_path, launch_writer):
    first, release_first, line_first = launch_writer(prefix="first", count=8)
    second, release_second, line_second = launch_writer(prefix="second", count=8)
    release_first()
    release_second()
    assert all(result["status"] == "success" for result in json.loads(line_first()))
    assert all(result["status"] == "success" for result in json.loads(line_second()))
    assert first.wait(timeout=10) == second.wait(timeout=10) == 0
    memories = json.loads((tmp_path / "memory.json").read_text())
    assert sorted(entry["message"] for entry in memories.values()) == sorted(
        [f"{prefix}-{index}" for prefix in ("first", "second") for index in range(8)]
    )


def test_lock_timeout_does_not_reclaim_a_live_writer(tmp_path, launch_writer):
    process, release, line = launch_writer(mode="hold")
    release()
    assert line() == "locked"
    file = tmp_path / "memory.json"
    lock = tmp_path / "memory.json.lock.sqlite3"
    inode = lock.stat().st_ino
    with pytest.raises(json_store.MemoryStoreError, match="lock could not be acquired"):
        with json_store._memory_file_lock(file, timeout_ms=30):
            pytest.fail("entered another process's transaction")
    assert lock.stat().st_ino == inode
    process.kill()
    process.wait(timeout=10)
    assert json.loads(memory_agent(tmp_path).perform(content="after crash"))["status"] == "success"


@pytest.mark.parametrize("phase", ["before-replace", "after-replace", "acknowledged"])
def test_writer_crash_keeps_a_valid_durable_snapshot(tmp_path, launch_writer, phase):
    agent = memory_agent(tmp_path)
    agent.perform(content="existing fact")
    process, release, line = launch_writer(mode=phase)
    release()
    if phase == "acknowledged":
        assert json.loads(line())[0]["status"] == "success"
    else:
        assert line() == phase
    process.kill()
    process.wait(timeout=10)
    assert json.loads(agent.perform(content="after recovery"))["status"] == "success"
    actual = sorted(entry["message"] for entry in json_store._read_memory_file(agent.memory_file).values())
    expected = ["existing fact", "after recovery"]
    if phase != "before-replace":
        expected.append("child-0")
    assert actual == sorted(expected)


@pytest.mark.parametrize("kind", ["corrupt", "directory", "symlink"])
def test_unusable_lock_fails_closed(tmp_path, kind):
    agent = memory_agent(tmp_path)
    agent.memory_file.write_text('{"legacy":{"message":"existing fact"}}')
    before = agent.memory_file.read_bytes()
    lock = tmp_path / "memory.json.lock.sqlite3"
    if kind == "corrupt":
        lock.write_text("not a database")
    elif kind == "directory":
        lock.mkdir()
    else:
        lock.symlink_to(agent.memory_file)
    with pytest.raises(json_store.MemoryStoreError, match="lock could not be acquired"):
        agent.perform(content="must not commit")
    assert agent.memory_file.read_bytes() == before


@pytest.mark.parametrize("kind", ["symlink", "hardlink"])
def test_linked_memory_files_do_not_split_lock_identities(tmp_path, kind):
    agent = memory_agent(tmp_path)
    destination = tmp_path / "original.json"
    before = b'{"legacy":{"message":"existing fact"}}'
    destination.write_bytes(before)
    if kind == "symlink":
        agent.memory_file.symlink_to(destination)
    else:
        os.link(destination, agent.memory_file)
    with pytest.raises(Exception):
        agent.perform(content="must not commit")
    assert destination.read_bytes() == before


def test_first_write_syncs_new_directory_entries(tmp_path, monkeypatch):
    agent = memory_agent(tmp_path)
    agent.memory_file = tmp_path / "new" / "nested" / "memory.json"
    synced = []
    descriptors = {}
    original_open, original_sync = os.open, os.fsync

    def opened(file, *args, **kwargs):
        descriptor = original_open(file, *args, **kwargs)
        descriptors.pop(descriptor, None)
        if stat.S_ISDIR(os.fstat(descriptor).st_mode):
            descriptors[descriptor] = Path(file)
        return descriptor

    def sync(descriptor):
        if descriptor in descriptors:
            synced.append(descriptors[descriptor])
        return original_sync(descriptor)

    monkeypatch.setattr(os, "open", opened)
    monkeypatch.setattr(os, "fsync", sync)
    assert json.loads(agent.perform(content="first fact"))["status"] == "success"
    assert synced == ([] if sys.platform == "win32" else [
        tmp_path / "new" / "nested", tmp_path / "new", tmp_path,
        tmp_path / "new" / "nested",
    ])


def test_read_failure_never_becomes_an_empty_snapshot(tmp_path, monkeypatch):
    agent = memory_agent(tmp_path)
    agent.perform(content="existing fact")
    before = agent.memory_file.read_bytes()
    original = os.open

    def denied(file, *args, **kwargs):
        if Path(file) == agent.memory_file:
            raise PermissionError("injected access denial")
        return original(file, *args, **kwargs)

    monkeypatch.setattr(os, "open", denied)
    with pytest.raises(json_store.MemoryStoreError, match="could not be read"):
        agent.perform(content="must not commit")
    assert agent.memory_file.read_bytes() == before


def test_context_reader_does_not_hide_corrupt_storage(tmp_path):
    agent = ContextMemoryAgent()
    agent.memory_file = tmp_path / "memory.json"
    agent.memory_file.write_text("{broken")
    with pytest.raises(RuntimeError, match="not valid JSON"):
        agent.perform(full_recall=True)


def test_rename_failure_does_not_acknowledge_or_discard_the_old_snapshot(tmp_path, monkeypatch):
    agent = memory_agent(tmp_path)
    agent.perform(content="existing fact")
    before = agent.memory_file.read_bytes()

    def fail(*_args):
        raise OSError("injected rename failure")

    monkeypatch.setattr(os, "replace", fail)
    with pytest.raises(OSError, match="rename failure"):
        agent.perform(content="must not commit")
    assert agent.memory_file.read_bytes() == before
    assert not list(tmp_path.glob("*.pending"))


def test_fsync_order_and_private_file_mode(tmp_path, monkeypatch):
    agent = memory_agent(tmp_path)
    order = []
    fsync, replace = os.fsync, os.replace

    def synced(descriptor):
        order.append("directory-sync" if stat.S_ISDIR(os.fstat(descriptor).st_mode) else "file-sync")
        return fsync(descriptor)

    def replaced(source, target):
        order.append("replace")
        return replace(source, target)

    monkeypatch.setattr(os, "fsync", synced)
    monkeypatch.setattr(os, "replace", replaced)
    assert json.loads(agent.perform(content="durable fact"))["status"] == "success"
    assert order == ["file-sync", "replace", "file-sync" if sys.platform == "win32" else "directory-sync"]
    if sys.platform != "win32":
        assert stat.S_IMODE(agent.memory_file.stat().st_mode) == 0o600


@pytest.mark.parametrize("after_replacement", [False, True])
def test_fsync_failure_is_never_acknowledged(tmp_path, monkeypatch, after_replacement):
    agent = memory_agent(tmp_path)
    agent.perform(content="existing fact")
    before = agent.memory_file.read_bytes()
    original = os.fsync
    stage = 0

    def failed(descriptor):
        nonlocal stage
        stage += 1
        if stage == (2 if after_replacement else 1):
            raise OSError("injected fsync failure")
        return original(descriptor)

    monkeypatch.setattr(os, "fsync", failed)
    with pytest.raises(OSError, match="fsync failure"):
        agent.perform(content="not acknowledged")
    if not after_replacement:
        assert agent.memory_file.read_bytes() == before
    else:
        assert any(entry["message"] == "not acknowledged" for entry in json_store._read_memory_file(agent.memory_file).values())


def windows_file_handles(monkeypatch):
    monkeypatch.setattr(json_store, "sys", SimpleNamespace(platform="win32"), raising=False)
    original = os.open
    directories = []

    def opened(file, *args, **kwargs):
        if Path(file).is_dir():
            directories.append(Path(file))
            raise PermissionError("Windows CRT cannot open directories")
        return original(file, *args, **kwargs)

    monkeypatch.setattr(os, "open", opened)
    return directories


@pytest.mark.parametrize("nested", [False, True])
def test_windows_writes_without_directory_handles(tmp_path, monkeypatch, nested):
    agent = memory_agent(tmp_path)
    directories = windows_file_handles(monkeypatch)
    if nested:
        agent.memory_file = tmp_path / "new" / "nested" / "memory.json"
    order = []
    fsync, replace = os.fsync, os.replace
    replaced = False

    def synced(descriptor):
        assert stat.S_ISREG(os.fstat(descriptor).st_mode)
        order.append("published-file-sync" if replaced else "staged-file-sync")
        return fsync(descriptor)

    def replaced_file(source, target):
        nonlocal replaced
        replace(source, target)
        replaced = True
        order.append("replace")

    monkeypatch.setattr(os, "fsync", synced)
    monkeypatch.setattr(os, "replace", replaced_file)
    assert json.loads(agent.perform(content="Windows fact"))["status"] == "success"
    assert directories == []
    assert order == ["staged-file-sync", "replace", "published-file-sync"]
    assert any(entry["message"] == "Windows fact" for entry in json_store._read_memory_file(agent.memory_file).values())


def test_windows_constructor_does_not_require_directory_handles(tmp_path, monkeypatch):
    directories = windows_file_handles(monkeypatch)
    owner = tmp_path / "new-owner"
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: owner))
    ManageMemoryAgent()
    assert (owner / ".openrappter").is_dir()
    assert directories == []


@pytest.mark.parametrize("failed_stage", [1, 2])
def test_windows_flush_failures_are_not_acknowledged(tmp_path, monkeypatch, failed_stage):
    agent = memory_agent(tmp_path)
    agent.perform(content="existing fact")
    before = agent.memory_file.read_bytes()
    windows_file_handles(monkeypatch)
    original = os.fsync
    stage = 0

    def failed(descriptor):
        nonlocal stage
        stage += 1
        if stage == failed_stage:
            raise OSError("injected Windows file-flush failure")
        return original(descriptor)

    monkeypatch.setattr(os, "fsync", failed)
    with pytest.raises(OSError, match="Windows file-flush failure"):
        agent.perform(content="not acknowledged")
    if failed_stage == 1:
        assert agent.memory_file.read_bytes() == before
    else:
        assert any(entry["message"] == "not acknowledged" for entry in json_store._read_memory_file(agent.memory_file).values())


def test_windows_published_file_open_failure_is_not_swallowed(tmp_path, monkeypatch):
    agent = memory_agent(tmp_path)
    agent.perform(content="existing fact")
    monkeypatch.setattr(json_store, "sys", SimpleNamespace(platform="win32"), raising=False)
    original = os.open

    def denied(file, flags, *args, **kwargs):
        if Path(file) == agent.memory_file and flags == os.O_RDWR:
            raise PermissionError("published file access denied")
        return original(file, flags, *args, **kwargs)

    monkeypatch.setattr(os, "open", denied)
    with pytest.raises(PermissionError, match="published file access denied"):
        agent.perform(content="not acknowledged")


def test_posix_directory_open_failure_remains_fatal(tmp_path, monkeypatch):
    agent = memory_agent(tmp_path)
    agent.perform(content="existing fact")
    before = agent.memory_file.read_bytes()
    monkeypatch.setattr(json_store, "sys", SimpleNamespace(platform="linux"), raising=False)
    original = os.open

    def denied(file, *args, **kwargs):
        if Path(file) == tmp_path:
            raise PermissionError("directory access denied")
        return original(file, *args, **kwargs)

    monkeypatch.setattr(os, "open", denied)
    with pytest.raises(PermissionError, match="directory access denied"):
        agent.perform(content="must not commit")
    assert agent.memory_file.read_bytes() == before
