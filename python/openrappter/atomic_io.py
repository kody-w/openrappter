"""Durable JSON writes, and honest handling of a file that did not survive.

``Path.write_text`` opens with ``O_TRUNC``: the previous contents are gone the
instant the call begins, and the new bytes are only in the page cache when it
returns. A crash, a kill, or a full disk in that window leaves a file that is
empty or half-written, and the old value is unrecoverable.

That is not theoretical. Killing a process during ``write_text`` and polling
the target's size, the file was observed at zero length and left unparseable
in 5 of 5 attempts. The same test against the temp-file-and-rename strategy
below left either the complete old value or the complete new one, 5 of 5 --
never anything in between.

``os.replace`` is atomic on POSIX and on Windows, so a reader either sees the
old file or the new one. Renaming into place is the whole point: the risky
part happens on a file nobody is reading, and the visible file changes in one
indivisible step.

Several modules here already do this correctly by hand -- ``brainstem``,
``show_and_tell``, ``imessage.config``, ``imessage.state``, ``pokemon_agent``.
This module exists so the next one does not have to reinvent it, and so the
two registry clients that were still calling ``write_text`` can share a single
implementation.
"""

from __future__ import annotations

import json
import os
import stat
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

DEFAULT_NEW_FILE_MODE = 0o600


def write_json_atomic(
    path: Path,
    value: Any,
    *,
    indent: int = 2,
    new_file_mode: int = DEFAULT_NEW_FILE_MODE,
) -> None:
    """Write ``value`` as JSON so an interrupted write cannot destroy ``path``.

    The payload is serialised before anything on disk is touched. A value that
    cannot be encoded therefore leaves no trace at all -- not the temporary
    file, and not the parent directory, which would otherwise be created as a
    side effect of a call that went on to fail.
    
    An existing file keeps the permissions it already has: this writes data,
    it does not decide policy, and silently loosening a file someone tightened
    on purpose would be worse than the bug it is fixing. A file being created
    for the first time is owner-only, because it lands in the user's data
    directory and nothing here needs to be world-readable.
    """
    path = Path(path)
    payload = json.dumps(value, indent=indent)

    path.parent.mkdir(parents=True, exist_ok=True)

    try:
        mode = stat.S_IMODE(path.stat().st_mode)
    except OSError:
        mode = new_file_mode

    descriptor, temporary_name = tempfile.mkstemp(
        dir=str(path.parent), prefix=f".{path.name}.", suffix=".tmp"
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, mode)
        os.replace(temporary, path)
    except BaseException:
        try:
            temporary.unlink()
        except OSError:
            pass
        raise

    _sync_directory(path.parent)


def read_json_object(path: Path, default: dict) -> dict:
    """Read a JSON object, moving the file aside if it is not one.

    Returns ``default`` when the file is missing, unreadable as JSON, or holds
    something other than an object. Callers must pass a freshly built default
    each time, because the value is handed back for the caller to mutate.

    A damaged file is renamed rather than ignored. Ignoring it reads the same
    as "nothing is installed", and the next save then overwrites the only
    evidence of what was there. Renaming keeps the bytes next to the file they
    came from, so the state is recoverable by hand and visible to anyone
    wondering why the tool suddenly forgot something.
    """
    path = Path(path)
    if not path.exists():
        return default

    try:
        parsed = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError):
        quarantine(path)
        return default

    if not isinstance(parsed, dict):
        quarantine(path)
        return default

    return parsed


def quarantine(path: Path) -> Optional[Path]:
    """Move a damaged file aside. Returns where it went, or None if it could
    not be moved -- a failure to preserve evidence must not become a crash."""
    path = Path(path)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    target = path.with_name(f"{path.name}.corrupt-{stamp}")
    counter = 1
    while target.exists():
        target = path.with_name(f"{path.name}.corrupt-{stamp}-{counter}")
        counter += 1
    try:
        os.replace(path, target)
    except OSError:
        return None
    return target


def _sync_directory(directory: Path) -> None:
    """Flush the rename itself.

    Without this the new file's contents are durable but the directory entry
    pointing at them may not be. Windows cannot open a directory as a file
    descriptor, so this is best effort by design.
    """
    try:
        descriptor = os.open(str(directory), os.O_RDONLY)
    except OSError:
        return
    try:
        os.fsync(descriptor)
    except OSError:
        pass
    finally:
        os.close(descriptor)
