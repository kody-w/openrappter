"""A locked, fsynced transport journal; job state remains in copilot_jobs."""

from __future__ import annotations

import fcntl
import json
import os
import stat
import uuid
from pathlib import Path

from .config import PortalError
from .files import private_directory


class JournalWriteError(OSError):
    """The journal could not be written (for example, a full disk). Never quarantined: the
    tick must fail loudly rather than carry on without durable state."""


def strict() -> bool:
    """Re-raise unexpected errors instead of quarantining them (the test suite, debugging)."""
    return os.environ.get("RAPP_BUBBLES_STRICT") == "1"


class Store:
    def __init__(self, root: Path):
        self.root = root
        self.data: dict = {}
        self._lock: int | None = None

    def __enter__(self) -> "Store":
        private_directory(self.root)
        self._lock = os.open(
            self.root / "transport.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600
        )
        try:
            fcntl.flock(self._lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            os.close(self._lock)
            self._lock = None
            raise PortalError("tick_busy", "The existing watcher already has a portal tick running.") from error
        try:
            path = self.root / "transport.json"
            try:
                descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
            except FileNotFoundError:
                self.data = {
                    "version": 1, "cursor": None, "floor": None, "inbox": {},
                    "conversations": {}, "jobs": {}, "outbox": [], "errors": [],
                }
                return self
            with os.fdopen(descriptor, "r", encoding="utf-8") as stream:
                info = os.fstat(stream.fileno())
                if (
                    not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
                    or stat.S_IMODE(info.st_mode) & 0o077 or info.st_size > 64 * 1024 * 1024
                ):
                    raise ValueError("unsafe state")
                self.data = json.load(stream)
            if self.data["version"] != 1:
                raise ValueError("unknown state version")
            for key in ("inbox", "conversations", "jobs"):
                if not isinstance(self.data[key], dict):
                    raise ValueError("invalid journal")
            for key in ("outbox", "errors"):
                if not isinstance(self.data[key], list):
                    raise ValueError("invalid journal")
            return self
        except (OSError, ValueError, KeyError, TypeError) as error:
            self.__exit__(None, None, None)
            raise PortalError("state_corrupt", "Transport state is unsafe; refusing to reset deduplication.") from error

    def save(self) -> None:
        if self._lock is None:
            raise RuntimeError("transport state must be locked")
        pending = self.root / f".transport.{uuid.uuid4().hex}.pending"
        try:
            self._write(pending)
        except OSError as error:
            raise JournalWriteError(error.errno, error.strerror or str(error)) from error
        finally:
            pending.unlink(missing_ok=True)

    def _write(self, pending: Path) -> None:
        descriptor = os.open(pending, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            json.dump(self.data, stream, ensure_ascii=False, separators=(",", ":"))
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(pending, self.root / "transport.json")
        directory = os.open(self.root, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)

    def error(self, code: str, now: float) -> None:
        # One entry per code (first and last time, count), so a failure that repeats cannot
        # push every other cause out of the ring.
        previous = next((item for item in self.data["errors"] if item.get("code") == code), None)
        entry = {"code": code, "time": now, "first": now, "count": 1}
        if previous:
            entry.update(first=previous.get("first", previous.get("time", now)), count=previous.get("count", 1) + 1)
        self.data["errors"] = [item for item in self.data["errors"] if item is not previous][-99:] + [entry]
        self.save()

    def __exit__(self, *_args) -> None:
        if self._lock is not None:
            os.close(self._lock)
            self._lock = None
