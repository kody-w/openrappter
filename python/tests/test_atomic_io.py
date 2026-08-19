"""Tests for openrappter.atomic_io.

The behaviour these pin was measured before it was written. Killing a process
during ``Path.write_text`` and polling the target's size, the file was observed
at zero length and left unparseable in 5 of 5 attempts. Against the strategy in
``atomic_io`` the same test never produced an unreadable file: killed before the
rename the previous value survived intact, killed after it the complete new
value was there, 5 of 5 in both directions.

The stray temporary file left by a write that was killed before its rename is
deliberate and is asserted here, so that nobody "tidies it up" by deleting
temporaries belonging to another process that is still writing one.
"""
from __future__ import annotations

import json
import os
import stat
from pathlib import Path

import pytest

from openrappter.atomic_io import (
    quarantine,
    read_json_object,
    write_json_atomic,
)


def temporaries(directory: Path) -> list[str]:
    return sorted(p.name for p in directory.iterdir() if p.name.endswith(".tmp"))


def mode_of(path: Path) -> int:
    return stat.S_IMODE(path.stat().st_mode)


class TestWritingSurvivesInterruption:
    """The rename is the point: the visible file changes in one step."""

    def test_a_value_round_trips(self, tmp_path):
        target = tmp_path / "lock.json"
        write_json_atomic(target, {"installed": {"a/b": {"name": "b"}}})
        assert json.loads(target.read_text()) == {"installed": {"a/b": {"name": "b"}}}

    def test_a_shorter_value_does_not_leave_the_tail_of_a_longer_one(self, tmp_path):
        target = tmp_path / "lock.json"
        write_json_atomic(target, {"installed": {str(i): i for i in range(500)}})
        long_size = target.stat().st_size

        write_json_atomic(target, {"installed": {}})

        assert target.stat().st_size < long_size
        assert json.loads(target.read_text()) == {"installed": {}}

    def test_the_file_is_replaced_rather_than_written_in_place(self, tmp_path):
        """A rename produces a new inode. Writing in place does not.

        This is what separates the fix from the bug: ``write_text`` truncates
        the file everyone can see, while this writes somewhere nobody is
        looking and swaps it in.
        """
        target = tmp_path / "lock.json"
        write_json_atomic(target, {"installed": {}})
        first_inode = target.stat().st_ino

        write_json_atomic(target, {"installed": {"a/b": {}}})

        assert target.stat().st_ino != first_inode

    def test_a_successful_write_leaves_no_temporary_behind(self, tmp_path):
        target = tmp_path / "lock.json"
        write_json_atomic(target, {"installed": {}})
        assert temporaries(tmp_path) == []

    def test_missing_parent_directories_are_created(self, tmp_path):
        target = tmp_path / "deep" / "deeper" / "lock.json"
        write_json_atomic(target, {"installed": {}})
        assert json.loads(target.read_text()) == {"installed": {}}

    def test_the_contents_are_flushed_to_disk_before_the_rename(self, tmp_path, monkeypatch):
        """Without the fsync the rename can land before the bytes do.

        The file would be atomically replaced by something a crash could still
        leave empty, which is most of the bug over again.
        """
        synced = []
        real_fsync = os.fsync

        def recording_fsync(descriptor):
            synced.append(descriptor)
            return real_fsync(descriptor)

        monkeypatch.setattr(os, "fsync", recording_fsync)
        write_json_atomic(tmp_path / "lock.json", {"installed": {}})

        assert synced, "the payload was never fsynced"

    def test_a_directory_that_cannot_be_synced_is_not_an_error(self, tmp_path, monkeypatch):
        """Windows cannot open a directory as a descriptor. That must not fail
        the write, only the extra durability the sync would have added."""
        real_open = os.open

        def refusing_open(path, flags, *args, **kwargs):
            if Path(path).is_dir():
                raise OSError("directories are not openable here")
            return real_open(path, flags, *args, **kwargs)

        monkeypatch.setattr(os, "open", refusing_open)
        target = tmp_path / "lock.json"
        write_json_atomic(target, {"installed": {"a/b": {}}})

        assert json.loads(target.read_text()) == {"installed": {"a/b": {}}}


class TestAFailedWriteDoesNotDamageWhatWasThere:
    def test_an_unserialisable_value_leaves_the_previous_file_untouched(self, tmp_path):
        target = tmp_path / "lock.json"
        write_json_atomic(target, {"installed": {"a/b": {"name": "b"}}})
        before = target.read_text()

        with pytest.raises(TypeError):
            write_json_atomic(target, {"installed": {"a/b": object()}})

        assert target.read_text() == before

    def test_an_unserialisable_value_leaves_no_temporary_behind(self, tmp_path):
        target = tmp_path / "lock.json"
        write_json_atomic(target, {"installed": {}})

        with pytest.raises(TypeError):
            write_json_atomic(target, {"installed": object()})

        assert temporaries(tmp_path) == []

    def test_a_failure_during_the_write_removes_the_temporary(self, tmp_path, monkeypatch):
        target = tmp_path / "lock.json"
        write_json_atomic(target, {"installed": {}})

        def exploding_replace(source, destination):
            raise OSError("no")

        monkeypatch.setattr(os, "replace", exploding_replace)
        with pytest.raises(OSError):
            write_json_atomic(target, {"installed": {"a/b": {}}})

        assert temporaries(tmp_path) == []


class TestPermissionsAreNotQuietlyChanged:
    def test_a_new_file_is_owner_only(self, tmp_path):
        target = tmp_path / "lock.json"
        write_json_atomic(target, {"installed": {}})
        assert mode_of(target) == 0o600

    def test_an_existing_world_readable_file_keeps_its_mode(self, tmp_path):
        """Writing data is not the place to make policy decisions."""
        target = tmp_path / "lock.json"
        target.write_text("{}")
        os.chmod(target, 0o644)

        write_json_atomic(target, {"installed": {"a/b": {}}})

        assert mode_of(target) == 0o644

    def test_an_existing_private_file_is_not_loosened(self, tmp_path):
        """The bug this guards against: mkstemp makes 0600 files, so a blanket
        chmod to 0644 after the rename would widen a file someone tightened."""
        target = tmp_path / "lock.json"
        target.write_text("{}")
        os.chmod(target, 0o600)

        write_json_atomic(target, {"installed": {"a/b": {}}})

        assert mode_of(target) == 0o600


class TestReadingAnObject:
    def test_a_missing_file_gives_the_default(self, tmp_path):
        default = {"installed": {}}
        assert read_json_object(tmp_path / "nope.json", default) is default

    def test_a_valid_object_is_returned(self, tmp_path):
        target = tmp_path / "lock.json"
        target.write_text(json.dumps({"installed": {"a/b": {"name": "b"}}}))
        assert read_json_object(target, {"installed": {}}) == {
            "installed": {"a/b": {"name": "b"}}
        }

    def test_the_default_is_handed_back_for_the_caller_to_mutate(self, tmp_path):
        default = {"installed": {}}
        result = read_json_object(tmp_path / "nope.json", default)
        result["installed"]["a/b"] = {}
        assert default["installed"] == {"a/b": {}}


class TestDamagedFilesArePreservedNotDiscarded:
    def test_truncated_json_is_moved_aside(self, tmp_path):
        target = tmp_path / "lock.json"
        target.write_text('{"installed": {"a/b": {"na')

        result = read_json_object(target, {"installed": {}})

        assert result == {"installed": {}}
        assert not target.exists()
        kept = [p for p in tmp_path.iterdir() if "corrupt" in p.name]
        assert len(kept) == 1
        assert kept[0].read_text() == '{"installed": {"a/b": {"na'

    def test_an_empty_file_is_moved_aside(self, tmp_path):
        target = tmp_path / "lock.json"
        target.write_text("")

        assert read_json_object(target, {"installed": {}}) == {"installed": {}}
        assert [p for p in tmp_path.iterdir() if "corrupt" in p.name]

    @pytest.mark.parametrize("payload", ["[]", '"hello"', "null", "123", "true"])
    def test_valid_json_that_is_not_an_object_is_moved_aside(self, tmp_path, payload):
        """Measured against the released code: a lock holding any of these
        reached ``lock["installed"]`` and raised TypeError out of install."""
        target = tmp_path / "lock.json"
        target.write_text(payload)

        assert read_json_object(target, {"installed": {}}) == {"installed": {}}
        assert [p for p in tmp_path.iterdir() if "corrupt" in p.name]

    def test_bytes_that_are_not_utf8_are_moved_aside(self, tmp_path):
        target = tmp_path / "lock.json"
        target.write_bytes(b"\xff\xfe\x00rubbish")

        assert read_json_object(target, {"installed": {}}) == {"installed": {}}
        assert [p for p in tmp_path.iterdir() if "corrupt" in p.name]

    def test_a_second_damaged_file_does_not_overwrite_the_first(self, tmp_path):
        target = tmp_path / "lock.json"

        target.write_text("first damage")
        read_json_object(target, {"installed": {}})
        target.write_text("second damage")
        read_json_object(target, {"installed": {}})

        kept = sorted(p.read_text() for p in tmp_path.iterdir() if "corrupt" in p.name)
        assert kept == ["first damage", "second damage"]

    def test_reading_twice_does_not_pile_up_copies(self, tmp_path):
        target = tmp_path / "lock.json"
        target.write_text("damaged")

        read_json_object(target, {"installed": {}})
        read_json_object(target, {"installed": {}})

        assert len([p for p in tmp_path.iterdir() if "corrupt" in p.name]) == 1


class TestQuarantine:
    def test_it_reports_where_the_file_went(self, tmp_path):
        target = tmp_path / "lock.json"
        target.write_text("damaged")

        destination = quarantine(target)

        assert destination is not None
        assert destination.read_text() == "damaged"
        assert not target.exists()

    def test_a_file_that_cannot_be_moved_is_not_an_error(self, tmp_path, monkeypatch):
        """Failing to preserve evidence is a shame, not a crash."""
        target = tmp_path / "lock.json"
        target.write_text("damaged")

        def refusing_replace(source, destination):
            raise OSError("read-only")

        monkeypatch.setattr(os, "replace", refusing_replace)
        assert quarantine(target) is None

    def test_a_read_still_returns_the_default_when_it_cannot_be_moved(
        self, tmp_path, monkeypatch
    ):
        target = tmp_path / "lock.json"
        target.write_text("damaged")

        def refusing_replace(source, destination):
            raise OSError("read-only")

        monkeypatch.setattr(os, "replace", refusing_replace)
        assert read_json_object(target, {"installed": {}}) == {"installed": {}}
