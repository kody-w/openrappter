"""Confined regular-file references, never attachments interpreted as commands."""

from __future__ import annotations

import errno
import hashlib
import os
import re
import stat
import uuid
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

from .config import PortalError, absolute


def private_directory(path: Path) -> Path:
    path = absolute(path)
    for component in reversed((path, *path.parents)):
        if component.is_symlink():
            raise PortalError("unsafe_path", "A private directory cannot traverse a symlink.")
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    info = path.stat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid():
        raise PortalError("unsafe_path", "Private directory ownership is invalid.")
    path.chmod(0o700)
    return path


def filename(value: object) -> str:
    name = str(value or "attachment").replace("\\", "/").split("/")[-1]
    name = re.sub(r"[^A-Za-z0-9._-]", "_", name).strip(".")
    suffix = Path(name).suffix[:20]
    stem = name[:-len(suffix)] if suffix else name
    return (stem[:160 - len(suffix)] + suffix) or "attachment"


def confined_relative(path: Path, roots: tuple[Path, ...]) -> tuple[Path, Path]:
    path = absolute(path)
    for root in roots:
        root = absolute(root)
        try:
            relative = path.relative_to(root)
        except ValueError:
            continue
        if relative.parts and all(part not in ("", ".", "..") for part in relative.parts):
            return root, relative
    raise PortalError("unsafe_path", "File is outside the configured attachment or artifact root.")


@contextmanager
def regular_file(
    path: str | Path, roots: tuple[Path, ...], max_bytes: int
) -> Iterator[tuple[int, os.stat_result]]:
    root, relative = confined_relative(Path(path), roots)
    directory = None
    descriptor = None
    try:
        for parent in (root, *root.parents):
            if parent.is_symlink():
                raise PortalError("unsafe_path", "Symlinked file roots are not allowed.")
        directory = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        for component in relative.parts[:-1]:
            child = os.open(
                component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory
            )
            os.close(directory)
            directory = child
        descriptor = os.open(
            relative.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory
        )
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode):
            raise PortalError("unsafe_file", "Only regular files may be transferred.")
        if info.st_nlink != 1 or info.st_mode & 0o111:
            raise PortalError("unsafe_file", "Hardlinked or executable files may not be staged or transferred.")
        if info.st_size > max_bytes:
            raise PortalError("file_too_large", "Attachment exceeds the 100 MiB/file safety limit.")
        yield descriptor, info
    except FileNotFoundError:
        raise
    except OSError as error:
        if error.errno in (errno.ENOSPC, errno.EDQUOT):
            raise PortalError("disk_full", "The disk is full; free space and it will be retried.") from error
        raise PortalError("unsafe_file", "File is inaccessible or traverses an unsafe link.") from error
    finally:
        if descriptor is not None:
            os.close(descriptor)
        if directory is not None:
            os.close(directory)


def copy_reference(
    path: str | Path,
    roots: tuple[Path, ...],
    destination: Path,
    max_bytes: int,
    *,
    expected_sha256: str | None = None,
    expected_size: int | None = None,
) -> dict:
    private_directory(destination.parent)
    pending = destination.with_name(f".{destination.name}.{uuid.uuid4().hex}.pending")
    try:
        with regular_file(path, roots, max_bytes) as (source, before):
            if expected_size is not None and before.st_size != expected_size:
                raise PortalError("file_changed", "File size does not match its trusted manifest.")
            digest = hashlib.sha256()
            total = 0
            descriptor = os.open(pending, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(descriptor, "wb") as output:
                while block := os.read(source, 1024 * 1024):
                    total += len(block)
                    if total > max_bytes:
                        raise PortalError("file_too_large", "Attachment exceeded the file safety limit.")
                    digest.update(block)
                    output.write(block)
                output.flush()
                os.fsync(output.fileno())
            after = os.fstat(source)
            if (before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (
                after.st_size, after.st_mtime_ns, after.st_ctime_ns
            ) or total != before.st_size:
                raise PortalError("file_changed", "Attachment changed while it was being staged.")
            checksum = digest.hexdigest()
            if expected_sha256 is not None and checksum != expected_sha256:
                raise PortalError("file_changed", "File hash does not match its trusted manifest.")
        os.replace(pending, destination)
        return {"path": str(destination), "size_bytes": total, "sha256": checksum}
    finally:
        pending.unlink(missing_ok=True)
