"""Private configuration; importing this module does not open any user files."""

from __future__ import annotations

import json
import hashlib
import os
import stat
from dataclasses import dataclass
from pathlib import Path
from typing import Any


MAX_FILE_BYTES = 100 * 1024 * 1024
IMSG_VERSION = "0.12.3"


class PortalError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def normalized(value: str) -> str:
    return value.strip().casefold()


def roster_digest(handles: list[str]) -> str:
    return hashlib.sha256("\0".join(sorted({normalized(handle) for handle in handles})).encode()).hexdigest()


def absolute(value: str | Path) -> Path:
    path = Path(value).expanduser()
    if not path.is_absolute() or ".." in path.parts or "\0" in str(path):
        raise PortalError("unsafe_config", "Configured paths must be absolute without traversal.")
    return path


def private_json(path: str | Path) -> dict:
    path = absolute(path)
    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        with os.fdopen(descriptor, "r", encoding="utf-8") as stream:
            info = os.fstat(stream.fileno())
            if (
                not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
                or stat.S_IMODE(info.st_mode) & 0o077
            ):
                raise PortalError("unsafe_config", "Local configuration must be owner-only.")
            text = stream.read(256 * 1024 + 1)
        if len(text.encode("utf-8")) > 256 * 1024:
            raise PortalError("unsafe_config", "Local configuration is too large.")
        value = json.loads(text)
        if not isinstance(value, dict):
            raise PortalError("unsafe_config", "Local configuration must be a JSON object.")
        return value
    except (OSError, json.JSONDecodeError) as error:
        raise PortalError("unsafe_config", "Cannot read private local configuration.") from error


@dataclass(frozen=True)
class Route:
    sender: str
    chat: str
    allow_group: bool = False
    allow_from_me: bool = False


@dataclass(frozen=True)
class Config:
    state_dir: Path
    messages_db: Path
    imsg_path: Path
    runtime_argv: tuple[str, ...]
    incoming_roots: tuple[Path, ...]
    artifact_root: Path
    routes: tuple[Route, ...]
    profile: str
    artifact_paths: tuple[str, ...] = ()
    max_file_bytes: int = MAX_FILE_BYTES
    max_files: int = 8
    readiness_seconds: float = 120
    stable_seconds: float = 1
    attachment_window_seconds: float = 600
    receipt_seconds: float = 180
    progress_seconds: float = 60
    runtime_timeout: float = 10
    native_timeout: float = 30
    events_per_tick: int = 32
    parts_per_tick: int = 4

    @classmethod
    def from_dict(cls, raw: dict[str, Any]) -> "Config":
        try:
            routes = tuple(
                Route(
                    normalized(item["sender"]),
                    item["chat"].strip(),
                    item.get("allow_group") is True,
                    item.get("allow_from_me") is True,
                )
                for item in raw["authorized"]
            )
            argv = tuple(raw["runtime_argv"])
            if (
                not routes
                or any(not route.sender or not route.chat for route in routes)
                or len({(r.sender, r.chat) for r in routes}) != len(routes)
                or len(routes) > 32
            ):
                raise ValueError("invalid authorization")
            if (
                len(argv) != 4
                or argv[2] != "--portal-config"
                or any(not isinstance(part, str) or "\0" in part for part in argv)
            ):
                raise ValueError("invalid adapter argv")
            for index in (0, 1, 3):
                absolute(argv[index])
            roots = tuple(absolute(p) for p in raw["incoming_roots"])
            if not roots:
                raise ValueError("incoming_roots is required")
            output_values = raw.get("artifact_paths", [])
            if not isinstance(output_values, list) or len(output_values) > 16:
                raise ValueError("invalid declared outputs")
            for output in output_values:
                path = Path(output)
                if (
                    not isinstance(output, str)
                    or not output
                    or path.is_absolute()
                    or ".." in path.parts
                    or "\0" in output
                ):
                    raise ValueError("invalid declared output")
            outputs = tuple(Path(output).as_posix() for output in output_values)
            if len({Path(output).name for output in outputs}) != len(outputs):
                raise ValueError("declared outputs need distinct basenames")
            config = cls(
                state_dir=absolute(raw["state_dir"]),
                messages_db=absolute(raw.get("messages_db", "~/Library/Messages/chat.db")),
                imsg_path=absolute(raw.get("imsg_path", "~/.openrappter/bin/imsg")),
                runtime_argv=argv,
                incoming_roots=roots,
                artifact_root=absolute(raw["artifact_root"]),
                routes=routes,
                profile=str(raw["profile"]),
                artifact_paths=outputs,
                **{
                    name: raw[name]
                    for name in (
                        "max_file_bytes", "max_files", "readiness_seconds", "stable_seconds",
                        "attachment_window_seconds", "receipt_seconds", "progress_seconds",
                        "runtime_timeout", "native_timeout", "events_per_tick", "parts_per_tick",
                    )
                    if name in raw
                },
            )
            for name in (
                "max_file_bytes", "max_files", "events_per_tick", "parts_per_tick",
            ):
                value = getattr(config, name)
                if type(value) is not int or value < 1:
                    raise ValueError("invalid integer limit")
            if config.max_file_bytes > MAX_FILE_BYTES or config.max_files > 32:
                raise ValueError("attachment limits exceed safety bounds")
            if len(outputs) > config.max_files:
                raise ValueError("too many default output paths")
            if config.events_per_tick > 256 or config.parts_per_tick > 16:
                raise ValueError("per-tick limits exceed safety bounds")
            for name in (
                "readiness_seconds", "stable_seconds", "attachment_window_seconds",
                "receipt_seconds", "progress_seconds", "runtime_timeout", "native_timeout",
            ):
                value = getattr(config, name)
                if isinstance(value, bool) or not isinstance(value, (int, float)) or not 0 < value <= 86400:
                    raise ValueError("invalid time limit")
            if not config.profile or len(config.profile) > 80:
                raise ValueError("profile is required")
            return config
        except (KeyError, TypeError, ValueError, AttributeError) as error:
            raise PortalError("unsafe_config", "Invalid private portal configuration.") from error

    @classmethod
    def load(cls, path: str | Path) -> "Config":
        return cls.from_dict(private_json(path))
