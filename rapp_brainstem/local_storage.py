"""
LocalStorageManager — drop-in replacement for AzureFileStorageManager.
Mirrors the CommunityRAPP storage layout:
  shared_memories/memory.json   — shared memories
  memory/{guid}/user_memory.json — per-user memories
Data lives in .brainstem_data/ next to this file.
"""

import os
import json
import tempfile
import threading
import hashlib

_DATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".brainstem_data")
_path_locks = {}
_path_locks_guard = threading.Lock()
_WINDOWS_RESERVED_STEMS = {
    "CON", "PRN", "AUX", "NUL",
    *(f"COM{index}" for index in range(1, 10)),
    *(f"LPT{index}" for index in range(1, 10)),
}


def _safe_join(*parts):
    """Join path parts under _DATA_DIR and refuse anything that escapes it.

    user_guid and agent-supplied file paths are attacker-influenced (they come from
    LLM tool-call arguments), so a value like '../../.env' or an absolute path must
    not be able to read or write outside the data directory. Returns an absolute path
    guaranteed to live under _DATA_DIR, or raises ValueError."""
    base = os.path.abspath(_DATA_DIR)
    target = os.path.abspath(os.path.join(base, *[str(p) for p in parts]))
    try:
        contained = os.path.commonpath(
            [os.path.normcase(base), os.path.normcase(target)]) == os.path.normcase(base)
    except ValueError:
        contained = False
    if not contained:
        raise ValueError(f"path escapes data directory: {os.path.join(*[str(p) for p in parts])}")

    # Resolve only components that already exist. Resolving a destination while
    # another thread creates its parent can yield inconsistent Windows path
    # prefixes; the existing parent is enough to detect a symlink/junction escape.
    existing = target
    while not os.path.exists(existing):
        parent = os.path.dirname(existing)
        if parent == existing:
            break
        existing = parent
    real_base = os.path.realpath(base)
    real_existing = os.path.realpath(existing)
    try:
        contained = os.path.commonpath([
            os.path.normcase(real_base), os.path.normcase(real_existing)
        ]) == os.path.normcase(real_base)
    except ValueError:
        contained = False
    if not contained:
        raise ValueError(f"path escapes data directory: {os.path.join(*[str(p) for p in parts])}")
    return target


def _ensure_private_dir(path):
    os.makedirs(path, exist_ok=True)
    try:
        os.chmod(path, 0o700)
    except OSError:
        pass


def _lock_for(path):
    """Return a process-local lock shared by all managers writing this path."""
    key = os.path.normcase(os.path.abspath(path))
    with _path_locks_guard:
        return _path_locks.setdefault(key, threading.RLock())


def _memory_context_component(user_guid):
    """Return a user identifier only when it is one literal path component."""
    if not isinstance(user_guid, str):
        raise ValueError("user_guid must be a string")
    component = user_guid
    if (
        component in {"", ".", ".."}
        or component.endswith((".", " "))
        or any(char in '<>:"/\\|?*' or ord(char) < 32 for char in component)
        or component.split(".", 1)[0].upper() in _WINDOWS_RESERVED_STEMS
    ):
        raise ValueError("user_guid must be a single path component")
    return component


def _atomic_write(path, write_fn):
    """Write via a temp file in the same directory + os.replace, so a crash or a
    concurrent reader never sees a half-written (and on the next write, silently
    wiped) file. write_fn receives the open file handle."""
    directory = os.path.dirname(os.path.abspath(path))
    _ensure_private_dir(directory)
    fd, tmp = tempfile.mkstemp(
        prefix=f".{os.path.basename(path)}.", suffix=".tmp", dir=directory)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            write_fn(f)
            f.flush()
            os.fsync(f.fileno())
        with _lock_for(path):
            os.replace(tmp, path)
            try:
                os.chmod(path, 0o600)
            except OSError:
                pass
    finally:
        if os.path.exists(tmp):
            try:
                os.remove(tmp)
            except OSError:
                pass


class AzureFileStorageManager:
    """
    Local-first shim that mirrors the AzureFileStorageManager API from
    CommunityRAPP.  Agents import this transparently via the shim in brainstem.py.
    """

    DEFAULT_MARKER_GUID = "c0p110t0-aaaa-bbbb-cccc-123456789abc"

    def __init__(self, share_name=None, **kwargs):
        self.current_guid = None
        normalized_share = str(share_name or "").strip().lower()
        self.share_name = normalized_share or None
        # Preserve the historical unnamed layout for bundled agents. Named Azure
        # shares receive deterministic, non-overlapping roots so cartridges cannot
        # accidentally read or overwrite another share's local data.
        self.storage_root = (
            os.path.join("shares", hashlib.sha256(normalized_share.encode("utf-8")).hexdigest())
            if normalized_share else ""
        )
        # Matches CommunityRAPP paths
        self.shared_memory_path = os.path.join(self.storage_root, "shared_memories")
        self.default_file_name = "memory.json"
        self.current_memory_path = self.shared_memory_path
        _ensure_private_dir(_DATA_DIR)

    def _scoped_path(self, file_path=""):
        return _safe_join(self.storage_root, file_path)

    # ── Context ───────────────────────────────────────────────────────────

    def set_memory_context(self, user_guid=None):
        """Set the memory context — matches CommunityRAPP's set_memory_context."""
        if user_guid is None or user_guid == "" or user_guid == self.DEFAULT_MARKER_GUID:
            self.current_guid = None
            self.current_memory_path = self.shared_memory_path
            return True

        _memory_context_component(user_guid)

        # Valid GUID — set up user-specific path (memory/{guid})
        self.current_guid = user_guid
        self.current_memory_path = os.path.join(self.storage_root, "memory", str(user_guid))
        return True

    # ── Core I/O ──────────────────────────────────────────────────────────

    def _file_path(self):
        """Return the absolute path for the current memory file.
        Shared:  .brainstem_data/shared_memories/memory.json
        User:    .brainstem_data/memory/{guid}/user_memory.json
        A malicious user_guid (e.g. '../../') is contained by _safe_join.
        """
        if self.current_guid:
            context = _memory_context_component(self.current_guid)
            rel = os.path.join(self.storage_root, "memory", context, "user_memory.json")
        else:
            rel = os.path.join(self.shared_memory_path, self.default_file_name)
        path = _safe_join(rel)
        _ensure_private_dir(os.path.dirname(path))
        return path

    def read_json(self, file_path=None):
        """Read JSON data from local storage."""
        path = self._scoped_path(file_path) if file_path else self._file_path()
        if not os.path.exists(path):
            return {}
        try:
            with open(path, "r", encoding="utf-8") as f:
                return json.load(f)
        except (json.JSONDecodeError, IOError):
            return {}

    def write_json(self, data, file_path=None):
        """Write JSON data to local storage (atomically)."""
        path = self._scoped_path(file_path) if file_path else self._file_path()
        with _lock_for(path):
            _atomic_write(path, lambda f: json.dump(data, f, indent=2, default=str))
        return True

    def update_json(self, update_fn, file_path=None):
        """Atomically read, transform, and replace a JSON document.

        The callback runs under a per-path lock and receives the current decoded
        value (or {} for a missing file). Decode/read failures are raised so a
        subsequent save cannot silently erase recoverable bytes.
        """
        path = self._scoped_path(file_path) if file_path else self._file_path()
        with _lock_for(path):
            if os.path.exists(path):
                with open(path, "r", encoding="utf-8") as f:
                    current = json.load(f)
            else:
                current = {}
            updated = update_fn(current)
            _atomic_write(path, lambda f: json.dump(updated, f, indent=2, default=str))
            return updated

    # ── Convenience methods used by some agents ───────────────────────────

    def read_file(self, file_path):
        full = self._scoped_path(file_path)
        if not os.path.exists(full):
            return None
        with open(full, "r", encoding="utf-8") as f:
            return f.read()

    def write_file(self, file_path, content):
        full = self._scoped_path(file_path)
        with _lock_for(full):
            _atomic_write(full, lambda f: f.write(content))
        return True

    def list_files(self, directory=""):
        full = self._scoped_path(directory)
        if not os.path.exists(full):
            return []
        return os.listdir(full)

    def delete_file(self, file_path):
        full = self._scoped_path(file_path)
        if os.path.exists(full):
            os.remove(full)
            return True
        return False

    def file_exists(self, file_path):
        try:
            return os.path.exists(self._scoped_path(file_path))
        except ValueError:
            return False
