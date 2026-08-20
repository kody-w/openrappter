"""The Pokemon runtime publishes JSON from several threads at once.

``atomic_write_json`` named its temporary file after the process id and opened
it with ``O_TRUNC``. Threads share a process id, so that was one temporary name
for the whole process rather than one per writer, and the viewer answers its
control endpoint from a ThreadingHTTPServer. Two overlapping requests therefore
opened the same temporary file, interleaved bytes into it, and raced to rename
it -- and ``O_TRUNC`` additionally followed any symlink planted at that very
guessable path.

Every other atomic writer in this codebase (brainstem, imessage.config,
imessage.state, show_and_tell, atomic_io) already uses a unique name and either
``mkstemp`` or ``O_EXCL``. These tests pin this one to the same contract.
"""

from __future__ import annotations

import json
import os
import threading
import uuid
from pathlib import Path

import pytest

import openrappter.agents.pokemon_agent as pokemon_module
from openrappter.agents.pokemon_agent import atomic_write_json

SMALL = {"who": "small", "pad": "x"}
LARGE = {"who": "large", "pad": "y" * 4000}


@pytest.fixture()
def runtime(tmp_path: Path) -> Path:
    root = tmp_path / "pokemon-red"
    root.mkdir(mode=0o700)
    return root


class TestConcurrentWritersNeverPublishAFragment:
    """The whole point of an atomic write is that readers see one value."""

    @staticmethod
    def _hammer(path: Path, rounds: int = 50):
        write_errors: list[str] = []
        decode_failures: list[str] = []
        unknown_values: list[object] = []
        stop = threading.Event()

        def write_loop(value: dict) -> None:
            for _ in range(rounds):
                try:
                    atomic_write_json(path, value)
                except Exception as exc:  # noqa: BLE001
                    write_errors.append(f"{type(exc).__name__}: {exc}")

        def read_loop() -> None:
            while not stop.is_set():
                try:
                    raw = path.read_bytes()
                except FileNotFoundError:
                    write_errors.append("published file vanished")
                    continue
                if not raw:
                    continue
                try:
                    parsed = json.loads(raw)
                except (json.JSONDecodeError, UnicodeDecodeError) as exc:
                    decode_failures.append(str(exc))
                    continue
                if parsed not in (SMALL, LARGE):
                    unknown_values.append(parsed)

        reader = threading.Thread(target=read_loop, daemon=True)
        reader.start()
        writers = [
            threading.Thread(target=write_loop, args=(SMALL,)),
            threading.Thread(target=write_loop, args=(LARGE,)),
        ]
        for thread in writers:
            thread.start()
        for thread in writers:
            thread.join()
        stop.set()
        reader.join(timeout=10)
        return write_errors, decode_failures, unknown_values

    def test_a_reader_never_sees_unparseable_json(self, runtime: Path) -> None:
        path = runtime / "status.json"
        atomic_write_json(path, SMALL)
        _, decode_failures, _ = self._hammer(path)
        assert decode_failures == []

    def test_a_reader_never_sees_a_value_nobody_wrote(self, runtime: Path) -> None:
        path = runtime / "status.json"
        atomic_write_json(path, SMALL)
        _, _, unknown = self._hammer(path)
        assert unknown == []

    def test_no_writer_fails_because_another_consumed_its_temporary(
        self, runtime: Path
    ) -> None:
        path = runtime / "desired.json"
        atomic_write_json(path, SMALL)
        write_errors, _, _ = self._hammer(path)
        assert write_errors == []

    def test_the_file_is_left_holding_a_complete_value(self, runtime: Path) -> None:
        path = runtime / "status.json"
        atomic_write_json(path, SMALL)
        self._hammer(path)
        assert json.loads(path.read_text(encoding="utf-8")) in (SMALL, LARGE)


class TestEachWriteUsesItsOwnTemporary:
    """Two writers must not be able to collide on one name."""

    def test_two_writes_use_different_temporary_names(
        self, runtime: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        seen: list[str] = []
        real_replace = os.replace

        def recording_replace(source, destination):
            seen.append(Path(source).name)
            return real_replace(source, destination)

        monkeypatch.setattr(os, "replace", recording_replace)
        atomic_write_json(runtime / "status.json", SMALL)
        atomic_write_json(runtime / "status.json", LARGE)
        assert len(seen) == 2
        assert seen[0] != seen[1]

    def test_the_temporary_name_does_not_carry_the_process_id(
        self, runtime: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        seen: list[str] = []
        real_replace = os.replace

        def recording_replace(source, destination):
            seen.append(Path(source).name)
            return real_replace(source, destination)

        monkeypatch.setattr(os, "replace", recording_replace)
        atomic_write_json(runtime / "status.json", SMALL)
        assert str(os.getpid()) not in seen[0]


class TestASymlinkCannotRedirectTheWrite:
    """O_EXCL refuses to follow a link; O_TRUNC happily truncated its target."""

    def test_a_symlink_at_the_temporary_path_is_refused(
        self, runtime: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        victim = runtime / "VICTIM.txt"
        victim.write_text("precious\n", encoding="utf-8")
        path = runtime / "desired.json"

        fixed = uuid.UUID("00000000-0000-4000-8000-000000000000")
        monkeypatch.setattr(pokemon_module.uuid, "uuid4", lambda: fixed)
        os.symlink(victim, runtime / f".{path.name}.{fixed.hex}.tmp")

        with pytest.raises(FileExistsError):
            atomic_write_json(path, {"running": True})

        assert victim.read_text(encoding="utf-8") == "precious\n"

    def test_the_refused_write_does_not_publish_anything(
        self, runtime: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        victim = runtime / "VICTIM.txt"
        victim.write_text("precious\n", encoding="utf-8")
        path = runtime / "desired.json"

        fixed = uuid.UUID("00000000-0000-4000-8000-000000000000")
        monkeypatch.setattr(pokemon_module.uuid, "uuid4", lambda: fixed)
        os.symlink(victim, runtime / f".{path.name}.{fixed.hex}.tmp")

        with pytest.raises(FileExistsError):
            atomic_write_json(path, {"running": True})

        assert not path.exists()

    def test_a_link_at_the_old_predictable_name_is_simply_irrelevant(
        self, runtime: Path
    ) -> None:
        victim = runtime / "VICTIM.txt"
        victim.write_text("precious\n", encoding="utf-8")
        path = runtime / "desired.json"
        os.symlink(victim, runtime / f".{path.name}.{os.getpid()}.tmp")

        atomic_write_json(path, {"running": True})

        assert victim.read_text(encoding="utf-8") == "precious\n"
        assert json.loads(path.read_text(encoding="utf-8")) == {"running": True}


class TestTheOrdinaryWriteStillBehaves:
    """A guard that broke the happy path would be worse than the bug."""

    def test_it_writes_a_value_that_reads_back(self, runtime: Path) -> None:
        path = runtime / "status.json"
        atomic_write_json(path, {"running": True, "frame": 12})
        assert json.loads(path.read_text(encoding="utf-8")) == {
            "running": True,
            "frame": 12,
        }

    def test_it_replaces_the_previous_value(self, runtime: Path) -> None:
        path = runtime / "status.json"
        atomic_write_json(path, SMALL)
        atomic_write_json(path, LARGE)
        assert json.loads(path.read_text(encoding="utf-8")) == LARGE

    def test_the_published_file_stays_owner_only(self, runtime: Path) -> None:
        path = runtime / "status.json"
        atomic_write_json(path, SMALL)
        assert oct(path.stat().st_mode & 0o777) == oct(0o600)

    def test_it_creates_a_missing_parent_directory(self, tmp_path: Path) -> None:
        path = tmp_path / "made" / "up" / "status.json"
        atomic_write_json(path, SMALL)
        assert json.loads(path.read_text(encoding="utf-8")) == SMALL

    def test_a_successful_write_leaves_no_temporary_behind(
        self, runtime: Path
    ) -> None:
        path = runtime / "status.json"
        atomic_write_json(path, SMALL)
        assert [entry.name for entry in runtime.iterdir()] == ["status.json"]

    def test_the_directory_is_synced_so_the_rename_survives_a_crash(
        self, runtime: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        synced: list[Path] = []
        monkeypatch.setattr(
            pokemon_module, "fsync_directory", lambda directory: synced.append(directory)
        )
        atomic_write_json(runtime / "status.json", SMALL)
        assert synced == [runtime]

    def test_the_payload_reaches_disk_before_the_rename_publishes_it(
        self, runtime: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        order: list[str] = []
        real_fsync = os.fsync
        real_replace = os.replace

        def recording_fsync(descriptor):
            order.append("fsync")
            return real_fsync(descriptor)

        def recording_replace(source, destination):
            order.append("replace")
            return real_replace(source, destination)

        monkeypatch.setattr(os, "fsync", recording_fsync)
        monkeypatch.setattr(os, "replace", recording_replace)
        atomic_write_json(runtime / "status.json", SMALL)
        assert "replace" in order
        assert order.index("fsync") < order.index("replace")


class TestAFailedWriteCleansUpAfterItself:
    """A uuid name never gets reused, so a leaked temporary leaks forever."""

    def test_a_failed_rename_leaves_no_temporary_behind(
        self, runtime: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        path = runtime / "status.json"
        atomic_write_json(path, SMALL)

        def exploding_replace(source, destination):
            raise OSError("no room")

        monkeypatch.setattr(os, "replace", exploding_replace)
        with pytest.raises(OSError):
            atomic_write_json(path, LARGE)

        assert [entry.name for entry in runtime.iterdir()] == ["status.json"]

    def test_a_failed_rename_leaves_the_previous_value_intact(
        self, runtime: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        path = runtime / "status.json"
        atomic_write_json(path, SMALL)

        def exploding_replace(source, destination):
            raise OSError("no room")

        monkeypatch.setattr(os, "replace", exploding_replace)
        with pytest.raises(OSError):
            atomic_write_json(path, LARGE)

        assert json.loads(path.read_text(encoding="utf-8")) == SMALL
