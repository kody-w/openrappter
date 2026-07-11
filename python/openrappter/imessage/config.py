"""Configuration for the supervised ``imsg rpc`` iMessage transport."""

from __future__ import annotations

import json
import os
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Mapping


IMSG_PINNED_VERSION = "0.12.3"
DEFAULT_CONFIG_PATH = Path.home() / ".openrappter" / "imessage" / "config.json"


class ConfigError(ValueError):
    """Raised when an iMessage configuration is unsafe or malformed."""


def normalize_handle(value: str) -> str:
    """Normalize only transport-safe differences, never display names."""
    return value.strip().casefold()


def _strings(value: object, field_name: str) -> tuple[str, ...]:
    if value is None:
        return ()
    if not isinstance(value, list):
        raise ConfigError(f"{field_name} must be an array")
    result: list[str] = []
    for item in value:
        if not isinstance(item, (str, int)):
            raise ConfigError(f"{field_name} entries must be strings or integers")
        text = str(item).strip()
        if text:
            result.append(text)
    return tuple(result)


def _mapping_of_strings(value: object, field_name: str) -> dict[str, tuple[str, ...]]:
    if value is None:
        return {}
    if not isinstance(value, Mapping):
        raise ConfigError(f"{field_name} must be an object")
    result: dict[str, tuple[str, ...]] = {}
    for key, items in value.items():
        label = str(key).strip()
        if not label:
            raise ConfigError(f"{field_name} keys cannot be empty")
        result[label] = _strings(items, f"{field_name}.{label}")
    return result


def _string_mapping(value: object, field_name: str) -> dict[str, str]:
    if value is None:
        return {}
    if not isinstance(value, Mapping):
        raise ConfigError(f"{field_name} must be an object")
    result: dict[str, str] = {}
    for key, item in value.items():
        alias = str(key).strip()
        target = str(item).strip()
        if not alias or not target:
            raise ConfigError(f"{field_name} keys and values cannot be empty")
        result[alias] = target
    return result


def _atomic_json_write(path: Path, value: Mapping[str, Any], mode: int = 0o600) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    try:
        os.chmod(path.parent, 0o700)
    except OSError:
        pass
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode)
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            json.dump(value, stream, indent=2, sort_keys=True)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        try:
            os.chmod(path, mode)
        except OSError:
            pass
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


@dataclass(frozen=True)
class IMessageConfig:
    """Validated local transport and authorization configuration."""

    rappter_instance_id: str
    account_id: str
    owner_handles: tuple[str, ...]
    owner_chat_ids: tuple[str, ...] = ()
    allowed_dm_handles: tuple[str, ...] = ()
    allowed_group_chat_ids: tuple[str, ...] = ()
    mention_required: bool = True
    mention_tokens: tuple[str, ...] = ("@rappter", "@openrappter", "@rapp")
    reply_prefix: str = "🦖 "
    state_dir: Path = field(
        default_factory=lambda: Path.home() / ".openrappter" / "imessage" / "state"
    )
    imsg_path: str = "imsg"
    imsg_version: str = IMSG_PINNED_VERSION
    identity_links: dict[str, tuple[str, ...]] = field(default_factory=dict)
    group_aliases: dict[str, str] = field(default_factory=dict)
    request_timeout_seconds: float = 30.0
    restart_initial_seconds: float = 0.25
    restart_max_seconds: float = 8.0
    history_limit: int = 100
    worker_count: int = 1

    def __post_init__(self) -> None:
        if not self.rappter_instance_id.strip():
            raise ConfigError("rappter_instance_id is required")
        if not self.account_id.strip():
            raise ConfigError("account_id is required")
        if self.imsg_version != IMSG_PINNED_VERSION:
            raise ConfigError(f"imsg_version must be pinned to {IMSG_PINNED_VERSION}")
        if not self.imsg_path.strip():
            raise ConfigError("imsg_path is required")
        if self.request_timeout_seconds <= 0:
            raise ConfigError("request_timeout_seconds must be positive")
        if self.restart_initial_seconds < 0:
            raise ConfigError("restart_initial_seconds cannot be negative")
        if self.restart_max_seconds < self.restart_initial_seconds:
            raise ConfigError("restart_max_seconds must be at least restart_initial_seconds")
        if self.history_limit < 2:
            raise ConfigError("history_limit must be at least 2")
        if self.worker_count != 1:
            raise ConfigError("worker_count must be 1 to preserve iMessage turn order")
        if self.mention_required and not any(token.strip() for token in self.mention_tokens):
            raise ConfigError("mention_tokens cannot be empty when mention_required is true")

        owner = {normalize_handle(item) for item in self.owner_handles}
        seen: dict[str, str] = {}
        for principal, handles in self.identity_links.items():
            if not principal.strip():
                raise ConfigError("identity_links principal labels cannot be empty")
            for handle in handles:
                normalized = normalize_handle(handle)
                if not normalized:
                    raise ConfigError("identity_links handles cannot be empty")
                previous = seen.setdefault(normalized, principal)
                if previous != principal:
                    raise ConfigError("a handle cannot be linked to multiple principals")
                if normalized in owner:
                    raise ConfigError("owner handles cannot appear in identity_links")

        allowed_groups = set(self.allowed_group_chat_ids)
        if set(self.owner_chat_ids) & allowed_groups:
            raise ConfigError("owner_chat_ids cannot also be allowed group chats")
        for target in self.group_aliases.values():
            if target not in allowed_groups:
                raise ConfigError("group_aliases may reference only allowed_group_chat_ids")

    @classmethod
    def from_dict(cls, raw: Mapping[str, Any]) -> "IMessageConfig":
        if not isinstance(raw, Mapping):
            raise ConfigError("configuration must be a JSON object")
        state_value = raw.get("state_dir")
        state_dir = (
            Path(os.path.expanduser(str(state_value)))
            if state_value
            else Path.home() / ".openrappter" / "imessage" / "state"
        )
        try:
            request_timeout = float(raw.get("request_timeout_seconds", 30.0))
            restart_initial = float(raw.get("restart_initial_seconds", 0.25))
            restart_max = float(raw.get("restart_max_seconds", 8.0))
            history_limit = int(raw.get("history_limit", 100))
            worker_count = int(raw.get("worker_count", 1))
        except (TypeError, ValueError) as error:
            raise ConfigError("numeric configuration values are invalid") from error
        return cls(
            rappter_instance_id=str(raw.get("rappter_instance_id", "")).strip(),
            account_id=str(raw.get("account_id", "")).strip(),
            owner_handles=_strings(raw.get("owner_handles"), "owner_handles"),
            owner_chat_ids=_strings(raw.get("owner_chat_ids"), "owner_chat_ids"),
            allowed_dm_handles=_strings(raw.get("allowed_dm_handles"), "allowed_dm_handles"),
            allowed_group_chat_ids=_strings(
                raw.get("allowed_group_chat_ids"), "allowed_group_chat_ids"
            ),
            mention_required=bool(raw.get("mention_required", True)),
            mention_tokens=_strings(
                raw.get("mention_tokens", ["@rappter", "@openrappter", "@rapp"]),
                "mention_tokens",
            ),
            reply_prefix=str(raw.get("reply_prefix", "🦖 ")),
            state_dir=state_dir,
            imsg_path=str(raw.get("imsg_path", "imsg")).strip(),
            imsg_version=str(raw.get("imsg_version", IMSG_PINNED_VERSION)).strip(),
            identity_links=_mapping_of_strings(raw.get("identity_links"), "identity_links"),
            group_aliases=_string_mapping(raw.get("group_aliases"), "group_aliases"),
            request_timeout_seconds=request_timeout,
            restart_initial_seconds=restart_initial,
            restart_max_seconds=restart_max,
            history_limit=history_limit,
            worker_count=worker_count,
        )

    @classmethod
    def load(cls, path: Path | str = DEFAULT_CONFIG_PATH) -> "IMessageConfig":
        config_path = Path(path).expanduser()
        try:
            raw = json.loads(config_path.read_text(encoding="utf-8"))
        except FileNotFoundError as error:
            raise ConfigError(f"configuration not found: {config_path}") from error
        except (OSError, json.JSONDecodeError) as error:
            raise ConfigError(f"unable to read configuration: {config_path}") from error
        return cls.from_dict(raw)

    @classmethod
    def initialize(cls, path: Path | str = DEFAULT_CONFIG_PATH, force: bool = False) -> Path:
        config_path = Path(path).expanduser()
        if config_path.exists() and not force:
            raise ConfigError(f"configuration already exists: {config_path}")
        state_dir = config_path.parent / "state"
        payload = {
            "rappter_instance_id": str(uuid.uuid4()),
            "account_id": "default",
            "imsg_path": "imsg",
            "imsg_version": IMSG_PINNED_VERSION,
            "owner_handles": [],
            "owner_chat_ids": [],
            "allowed_dm_handles": [],
            "allowed_group_chat_ids": [],
            "mention_required": True,
            "mention_tokens": ["@rappter", "@openrappter", "@rapp"],
            "reply_prefix": "🦖 ",
            "identity_links": {},
            "group_aliases": {},
            "state_dir": str(state_dir),
        }
        _atomic_json_write(config_path, payload)
        return config_path

    def operational_errors(self) -> list[str]:
        errors: list[str] = []
        if not self.owner_handles:
            errors.append("at least one owner handle is required")
        if not self.owner_chat_ids:
            errors.append("at least one exact owner self-chat id/guid is required")
        return errors

    @property
    def normalized_owner_handles(self) -> frozenset[str]:
        return frozenset(normalize_handle(item) for item in self.owner_handles)

    @property
    def normalized_allowed_dm_handles(self) -> frozenset[str]:
        return frozenset(normalize_handle(item) for item in self.allowed_dm_handles)
