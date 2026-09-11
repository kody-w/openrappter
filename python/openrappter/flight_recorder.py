"""Privacy-safe, provider-neutral Flight Recorder v1 for the Python runtime."""

from __future__ import annotations

import contextvars
import atexit
import asyncio
import errno
import hashlib
import hmac
import inspect
import json
import math
import os
import re
import sqlite3
import stat as stat_module
import subprocess
import sys
import threading
import time
import uuid
import weakref
from contextlib import contextmanager
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any, Callable, Dict, Iterator, Mapping, Optional, Sequence
from urllib.parse import parse_qsl, unquote, urlparse



FLIGHT_EVENT_SCHEMA = "openrappter-event/1.0"
FLIGHT_EXPORT_SCHEMA = "openrappter-flight-export/1.0"
DEFAULT_RETENTION_EVENTS = 10_000
DEFAULT_MAX_PAYLOAD_BYTES = 16 * 1024
MAX_SANITIZE_STRING_BYTES = 64 * 1024
MAX_EMBEDDED_JSON_PARSE_CHARS = MAX_SANITIZE_STRING_BYTES * 4
MAX_EMBEDDED_JSON_DEPTH = 4
MAX_SANITIZE_NODES = 10_000
MAX_SANITIZE_BYTES = 256 * 1024
TRAVERSAL_LIMIT = "[truncated:budget]"
BUSY_TIMEOUT_MS = 5_000
RUNTIME_BUSY_TIMEOUT_MS = 25
RUNTIME_BUSY_RETRIES = 50
MAX_BUSY_RETRIES = 4
MAX_QUERY_LIMIT = 10_000
MAX_QUERY_OFFSET = 1_000_000
MAX_KIND_FILTERS = 100
JS_MAX_SAFE_INTEGER = 9_007_199_254_740_991
QUERY_KEYS = frozenset(
    {
        "traceId",
        "sessionId",
        "workspaceId",
        "kind",
        "source",
        "providerId",
        "agentName",
        "toolName",
        "status",
        "since",
        "until",
        "order",
        "limit",
        "offset",
    }
)
QUERY_ALIASES = {
    "trace_id": "traceId",
    "session_id": "sessionId",
    "workspace_id": "workspaceId",
    "provider_id": "providerId",
    "agent_name": "agentName",
    "tool_name": "toolName",
}

REDACTED = "[redacted]"
EXCLUDED_PATH = "[excluded-path]"
CIRCULAR = "[circular]"
UNSERIALIZABLE = "[unserializable]"

DEFAULT_REDACTED_KEYS = frozenset(
    {
        "token",
        "secret",
        "password",
        "credential",
        "authorization",
        "api_key",
        "apiKey",
        "apikey",
        "private_key",
        "privateKey",
        "privatekey",
        "cookie",
        "session_token",
        "sessionToken",
        "sessiontoken",
        "access_token",
        "accessToken",
        "accesstoken",
        "refresh_token",
        "refreshToken",
        "refreshtoken",
        "identityKey",
        "identity_key",
        "OPENRAPPTER_FLIGHT_ID_KEY",
        "__proto__",
        "constructor",
        "prototype",
    }
)

DEFAULT_EXCLUDED_PATH_PATTERNS = (
    re.compile(r"(?:^|[\\/])\.env(?:\.[^\\/]+)?(?:$|[\\/])", re.I),
    re.compile(
        r"(?:^|[\\/])(?:\.git-credentials|credentials?|"
        r"application_default_credentials|service[-_.]?account|"
        r"client[-_.]?secret)(?:\.[^\\/]*)?$",
        re.I,
    ),
    re.compile(r"\.(?:pem|key|p12|pfx|jks|keystore)(?:$|[?#])", re.I),
    re.compile(r"(?:^|[\\/])\.ssh(?:[\\/]|$)", re.I),
    re.compile(r"(?:^|[\\/])\.gnupg(?:[\\/]|$)", re.I),
    #: Private SSH keys copied out of ~/.ssh. The trailing anchor is what keeps
    #: `id_rsa.pub` readable: a public key is not a secret, and blanking it
    #: would cost the record for nothing.
    re.compile(r"(?:^|[\\/])id_(?:rsa|dsa|ecdsa|ed25519)(?:$|[\\/])", re.I),
    #: Files whose entire purpose is to hold a credential. `.netrc` is matched
    #: with `[._]` because Windows spells it `_netrc`.
    re.compile(r"(?:^|[\\/])[._]netrc(?:$|[\\/])", re.I),
    re.compile(r"(?:^|[\\/])\.(?:npmrc|pypirc|pgpass|htpasswd)(?:$|[\\/])", re.I),
    re.compile(r"(?:^|[\\/])\.docker[\\/]config\.json(?:$|[\\/])", re.I),
    re.compile(r"(?:^|[\\/])\.kube[\\/]config(?:$|[\\/])", re.I),
    re.compile(r"(?:^|[\\/])\.aws[\\/]credentials(?:$|[\\/])", re.I),
    re.compile(r"(?:^|[\\/])\.copilot_token(?:$|[\\/])", re.I),
    re.compile(
        r"\.identity-key(?:\.\d+\.[0-9a-f-]+\.tmp)?(?:$|[?#])",
        re.I,
    ),
)

_PROCESS_OWNER_PATHS: set[Path] = set()
_RECORDER_INSTANCES: "weakref.WeakSet[FlightRecorder]" = weakref.WeakSet()


@atexit.register
def _cleanup_process_owner_paths() -> None:
    for owner_path in list(_PROCESS_OWNER_PATHS):
        try:
            owner_path.unlink(missing_ok=True)
        except OSError:
            pass

SECRET_VALUE_PATTERNS = (
    re.compile(r"\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,})\b", re.I | re.ASCII),
    re.compile(r"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b", re.ASCII),
    # The providers this repository actually reads keys for. Ported from
    # typescript/src/flight-recorder/redaction.ts, which carried them while
    # this list did not -- so a bare token in a recorded value reached the
    # Python ledger verbatim. The key-based rules only fire when the
    # surrounding field is named something like `api_key`, and a token quoted
    # inside a longer string has no such field.
    #
    # Lengths are deliberately tight: blanking a value that was not a secret
    # costs the record its usefulness, which is the opposite failure and just
    # as real.
    re.compile(r"\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}\b", re.ASCII),  # OpenAI, Anthropic
    re.compile(r"\bAIza[A-Za-z0-9_-]{35}\b", re.ASCII),                 # Google
    re.compile(r"\bxox[abprs]-[A-Za-z0-9-]{10,}\b", re.ASCII),          # Slack bot/user
    re.compile(r"\bxapp-[0-9]-[A-Za-z0-9-]{10,}\b", re.ASCII),          # Slack app-level
    re.compile(r"\b[0-9]{8,10}:AA[A-Za-z0-9_-]{33}\b", re.ASCII),       # Telegram bot
    re.compile(r"\btskey-[a-z]+-[A-Za-z0-9]{10,}\b", re.ASCII),         # Tailscale
    re.compile(
        r"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b",
        re.ASCII,
    ),  # JWT
    re.compile(r"\bBearer\s+[A-Za-z0-9._~+/=-]{8,}", re.I | re.ASCII),
    re.compile(r"\b[a-z][a-z0-9+.-]*://[^/\s:@]*:[^@\s/]+@", re.I | re.ASCII),
    re.compile(r"\b(?:password|pwd)\s*=\s*[^;\s]+", re.I | re.ASCII),
    re.compile(
        r"\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|"
        r"client[_-]?secret|credential)\s*[:=]\s*[\"']?"
        r"[A-Za-z0-9._~+/=-]{8,}",
        re.I | re.ASCII,
    ),
    # `key` and `sig` are credentials in a query string too, and the first is
    # not hypothetical: the shipped Gemini provider builds
    # `...:generateContent?key=<apiKey>`, so a recorded value carrying that URL
    # wrote the key into the ledger. Guarded by a value length so an ordinary
    # `?key=name` is left alone.
    re.compile(r"[?&](?:key|sig|signature)=[A-Za-z0-9._~+/=-]{8,}", re.I | re.ASCII),
    re.compile(
        r"[?&](?:token|secret|password|credential|authorization|"
        r"api[_-]?key|access[_-]?token|refresh[_-]?token|"
        r"client[_-]?secret)=",
        re.I | re.ASCII,
    ),
    re.compile(
        r"(?:^|[{,\s])[\"']?(?:password|pwd|token|secret|credential|"
        r"authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|"
        r"client[_-]?secret)[\"']?\s*[:=]",
        re.I,
    ),
    re.compile(r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----", re.I),
)

EVENT_STATUSES = frozenset({"started", "success", "error", "decision", "info"})
EVENT_KEYS = frozenset(
    {
        "schema",
        "id",
        "sequence",
        "kind",
        "source",
        "status",
        "traceId",
        "parentId",
        "sessionId",
        "workspaceId",
        "providerId",
        "model",
        "agentName",
        "toolName",
        "timestamp",
        "durationMs",
        "metadata",
        "payload",
        "contentHash",
    }
)

_MISSING = object()


class FlightRecorderError(RuntimeError):
    """Base Flight Recorder error."""


class FlightRecorderCorruptionError(FlightRecorderError):
    """Raised when persisted or imported event integrity is invalid."""


class FlightRecorderUnhealthyError(FlightRecorderError):
    """Raised when explicit inspection targets an unhealthy recorder."""


def _json_text(value: Any, *, sort_keys: bool = False) -> str:
    return json.dumps(
        value,
        ensure_ascii=False,
        allow_nan=False,
        separators=(",", ":"),
        sort_keys=sort_keys,
    )


def _reject_json_constant(value: str) -> None:
    raise ValueError(f"Non-standard JSON constant: {value}")


def _strict_json_loads(value: str) -> Any:
    return json.loads(value, parse_constant=_reject_json_constant)


def _ecmascript_number(value: int | float) -> str:
    """Serialize a finite safe number like ECMAScript JSON.stringify."""
    if isinstance(value, bool):
        raise TypeError("Booleans are not numbers.")
    if isinstance(value, int):
        if abs(value) > JS_MAX_SAFE_INTEGER:
            raise ValueError("Integer exceeds the JavaScript safe integer domain.")
        return str(value)
    if not math.isfinite(value):
        raise ValueError("Non-finite numbers are not canonical JSON numbers.")
    if value == 0:
        return "0"

    negative = value < 0
    absolute = abs(value)
    shortest = repr(absolute).lower()
    mantissa, exponent_text = (
        shortest.split("e", 1) if "e" in shortest else (shortest, "0")
    )
    exponent = int(exponent_text)
    integer_part, fractional_part = (
        mantissa.split(".", 1) if "." in mantissa else (mantissa, "")
    )
    raw_digits = integer_part + fractional_part
    leading_zeros = len(raw_digits) - len(raw_digits.lstrip("0"))
    digits = raw_digits.lstrip("0") or "0"
    decimal_position = len(integer_part) + exponent - leading_zeros

    if absolute >= 1e21 or absolute < 1e-6:
        scientific_exponent = decimal_position - 1
        significant = digits.rstrip("0") or "0"
        coefficient = significant[0]
        if len(significant) > 1:
            coefficient += f".{significant[1:]}"
        exponent_sign = "+" if scientific_exponent >= 0 else "-"
        rendered = f"{coefficient}e{exponent_sign}{abs(scientific_exponent)}"
    elif decimal_position <= 0:
        rendered = f"0.{'0' * -decimal_position}{digits}".rstrip("0")
    elif decimal_position >= len(digits):
        rendered = digits + ("0" * (decimal_position - len(digits)))
    else:
        rendered = (
            f"{digits[:decimal_position]}.{digits[decimal_position:]}"
        ).rstrip("0").rstrip(".")

    return f"-{rendered}" if negative else rendered


def _canonical(value: Any) -> str:
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, str):
        return _json_text(value)
    if isinstance(value, int):
        return _ecmascript_number(value)
    if isinstance(value, float):
        if not math.isfinite(value):
            return "null"
        return _ecmascript_number(value)
    if isinstance(value, (list, tuple)):
        return "[" + ",".join(_canonical(item) for item in value) + "]"
    if isinstance(value, Mapping):
        keys = list(value)
        if any(not isinstance(key, str) for key in keys):
            raise TypeError("Flight event object keys must be strings.")
        entries = []
        for key in sorted(keys, key=lambda item: item.encode("utf-16-be")):
            entries.append(f"{_json_text(key)}:{_canonical(value[key])}")
        return "{" + ",".join(entries) + "}"
    raise TypeError(f"Value of type {type(value).__name__} is not JSON-compatible.")


def _portable_json(value: Any) -> str:
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, str):
        return _json_text(value)
    if isinstance(value, int):
        return _ecmascript_number(value)
    if isinstance(value, float):
        if not math.isfinite(value):
            return "null"
        return _ecmascript_number(value)
    if isinstance(value, (list, tuple)):
        return "[" + ",".join(_portable_json(item) for item in value) + "]"
    if isinstance(value, Mapping):
        entries = []
        for key, entry_value in value.items():
            if not isinstance(key, str):
                raise TypeError("JSON object keys must be strings.")
            entries.append(
                f"{_json_text(key)}:{_portable_json(entry_value)}"
            )
        return "{" + ",".join(entries) + "}"
    raise TypeError(
        f"Value of type {type(value).__name__} is not JSON-compatible."
    )


def compute_flight_event_hash(event: Mapping[str, Any]) -> str:
    """Return SHA-256 over the canonical event body, excluding ``contentHash``."""
    body = dict(event)
    body.pop("contentHash", None)
    return hashlib.sha256(_canonical(body).encode("utf-8")).hexdigest()


def verify_flight_event_hash(event: Mapping[str, Any]) -> bool:
    content_hash = event.get("contentHash")
    return (
        isinstance(content_hash, str)
        and re.fullmatch(r"[0-9a-f]{64}", content_hash) is not None
        and compute_flight_event_hash(event) == content_hash
    )


def _exportable_event(event: Mapping[str, Any]) -> Dict[str, Any]:
    exported = dict(event)
    metadata = dict(exported.get("metadata") or {})
    changed = False
    for key in ("ownerPid", "ownerId", "ownerIncarnation"):
        if key in metadata:
            metadata.pop(key)
            changed = True
    if not changed:
        return exported
    exported["metadata"] = metadata
    exported["contentHash"] = compute_flight_event_hash(exported)
    return exported


def _normalize_unicode_scalars(value: str) -> str:
    return "".join(
        "\ufffd" if 0xD800 <= ord(character) <= 0xDFFF else character
        for character in value
    )


def _decode_percent_fixed(value: str) -> str:
    current = value
    for _pass in range(32):
        decoded = unquote(current)
        if decoded == current:
            return decoded
        current = decoded
    return REDACTED


def normalize_flight_workspace_id(value: Optional[str]) -> Optional[str]:
    """Hash absolute filesystem paths while preserving already-opaque IDs."""
    if not value:
        return value
    normalized_value = _normalize_unicode_scalars(value)
    if re.fullmatch(r"workspace:[0-9a-f]{24}", normalized_value):
        return normalized_value
    candidates = [normalized_value]
    try:
        decoded = _decode_percent_fixed(normalized_value)
        if decoded == REDACTED:
            digest = hashlib.sha256(
                normalized_value.encode("utf-8")
            ).hexdigest()[:24]
            return f"workspace:{digest}"
        if decoded != normalized_value:
            candidates.append(decoded)
    except (TypeError, ValueError):
        pass

    def is_path_like(candidate: str) -> bool:
        if (
            re.match(
                r"^[A-Za-z][A-Za-z0-9+.-]*://",
                candidate,
            )
            or re.match(r"^(?:file|workspace):", candidate, re.I)
        ):
            return True
        if (
            candidate.startswith("/")
            or re.match(r"^[A-Za-z]:[\\/]", candidate)
            or candidate.startswith("\\\\")
        ):
            return True
        namespaced = re.match(
            r"^[A-Za-z][A-Za-z0-9+.-]*:(.*)$",
            candidate,
            re.S,
        )
        if namespaced is None or "://" in candidate:
            return False
        suffix = namespaced.group(1)
        return (
            suffix.startswith("/")
            or re.match(r"^[A-Za-z]:[\\/]", suffix) is not None
            or suffix.startswith("\\\\")
        )

    path_like = any(is_path_like(candidate) for candidate in candidates)
    if not path_like:
        return normalized_value
    digest = hashlib.sha256(
        normalized_value.encode("utf-8")
    ).hexdigest()[:24]
    return f"workspace:{digest}"


def normalize_flight_session_id(
    value: Optional[str],
    identity_key: str,
    redacted_values: Sequence[str] = (),
) -> Optional[str]:
    """Hash conversation IDs so counterparty identity is never persisted."""
    if not value:
        return value
    normalized_value = _normalize_unicode_scalars(value)
    exact_secret = any(
        candidate
        and (
            (
                re.fullmatch(r"[0-9a-fA-F]{64}", candidate)
                is not None
                and candidate.lower() == normalized_value.lower()
            )
            or (
                re.fullmatch(r"[0-9a-fA-F]{64}", candidate)
                is None
                and candidate == normalized_value
            )
        )
        for candidate in redacted_values
    )
    if (
        re.fullmatch(r"session:[0-9a-f]{24}", normalized_value)
        and not exact_secret
    ):
        return normalized_value
    if re.fullmatch(r"[0-9a-fA-F]{64}", identity_key) is None:
        raise ValueError(
            "Flight Recorder identity key must be 32-byte hexadecimal."
        )
    digest = hmac.new(
        bytes.fromhex(identity_key),
        normalized_value.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()[:24]
    return f"session:{digest}"


def _harden_private_path(path: Path, *, directory: bool = False) -> None:
    if os.name != "nt":
        os.chmod(path, 0o700 if directory else 0o600)
        return
    user = os.environ.get("USERNAME")
    if not user:
        raise ValueError(
            "USERNAME is required to harden Flight Recorder ACLs."
        )
    security_type = (
        "System.Security.AccessControl.DirectorySecurity"
        if directory
        else "System.Security.AccessControl.FileSecurity"
    )
    io_type = (
        "System.IO.DirectoryInfo"
        if directory
        else "System.IO.FileInfo"
    )
    inheritance = (
        "[System.Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'"
        if directory
        else "[System.Security.AccessControl.InheritanceFlags]::None"
    )
    command = f"""
$ErrorActionPreference = 'Stop'
try {{
  $identity = New-Object System.Security.Principal.NTAccount($env:HF_USER)
  $sid = $identity.Translate([System.Security.Principal.SecurityIdentifier])
  $acl = New-Object {security_type}
  $acl.SetOwner($sid)
  $acl.SetAccessRuleProtection($true, $false)
  $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', {inheritance}, [System.Security.AccessControl.PropagationFlags]::None, [System.Security.AccessControl.AccessControlType]::Allow)
  $acl.AddAccessRule($rule)
  $item = New-Object {io_type}($env:HF_TARGET)
  $item.SetAccessControl($acl)

  $actual = $item.GetAccessControl()
  $ownerSid = $actual.GetOwner([System.Security.Principal.SecurityIdentifier])
  $rules = @($actual.Access)
  $allowedOwners = @($sid.Value, 'S-1-5-18', 'S-1-5-32-544')
  if (-not $actual.AreAccessRulesProtected -or $allowedOwners -notcontains $ownerSid.Value -or $rules.Count -ne 1) {{
    throw 'Flight Recorder ACL verification failed.'
  }}
  $ruleSid = $rules[0].IdentityReference.Translate([System.Security.Principal.SecurityIdentifier])
  $fullControl = [System.Security.AccessControl.FileSystemRights]::FullControl
  if ($ruleSid.Value -ne $sid.Value -or $rules[0].IsInherited -or $rules[0].AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow -or (($rules[0].FileSystemRights -band $fullControl) -ne $fullControl)) {{
    throw 'Flight Recorder ACL rule verification failed.'
  }}
}} catch {{
  [Console]::Error.WriteLine($_.Exception.ToString())
  exit 1
}}
"""
    subprocess.run(
        [
            "powershell.exe",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            command,
        ],
        check=True,
        capture_output=True,
        env={**os.environ, "HF_TARGET": str(path), "HF_USER": user},
    )


def _assert_private_directory(directory: Path) -> None:
    current = directory.absolute()
    while True:
        linked = current.lstat()
        if (
            _is_reparse_or_symlink(linked)
            and (
                os.name == "nt"
                or not hasattr(os, "getuid")
                or linked.st_uid != 0
            )
        ):
            raise FlightRecorderError(
                "Flight Recorder storage parent must not use a "
                f"user-controlled symlink/reparse point: {current}"
            )
        if current.parent == current:
            break
        current = current.parent
    if os.name == "nt":
        user = os.environ.get("USERNAME")
        if not user:
            raise ValueError(
                "USERNAME is required to validate Flight Recorder ACLs."
            )
        command = r"""
$ErrorActionPreference = 'Stop'
try {
  $identity = New-Object System.Security.Principal.NTAccount($env:HF_USER)
  $sid = $identity.Translate([System.Security.Principal.SecurityIdentifier])
  $allowed = @($sid.Value, 'S-1-3-4', 'S-1-5-18', 'S-1-5-32-544')
  $writeRights = [System.Security.AccessControl.FileSystemRights]::Write `
    -bor [System.Security.AccessControl.FileSystemRights]::Modify `
    -bor [System.Security.AccessControl.FileSystemRights]::FullControl `
    -bor [System.Security.AccessControl.FileSystemRights]::CreateFiles `
    -bor [System.Security.AccessControl.FileSystemRights]::CreateDirectories `
    -bor [System.Security.AccessControl.FileSystemRights]::Delete `
    -bor [System.Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles `
    -bor [System.Security.AccessControl.FileSystemRights]::ChangePermissions `
    -bor [System.Security.AccessControl.FileSystemRights]::TakeOwnership
  $item = New-Object System.IO.DirectoryInfo($env:HF_TARGET)
  $acl = $item.GetAccessControl()
  $ownerSid = $acl.GetOwner([System.Security.Principal.SecurityIdentifier])
  if ($allowed -notcontains $ownerSid.Value) {
    throw "Flight Recorder storage parent has untrusted owner $($ownerSid.Value)."
  }
  foreach ($rule in @($acl.Access)) {
    if ($rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow) { continue }
    $ruleSid = $rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier])
    if ($allowed -contains $ruleSid.Value) { continue }
    if (($rule.FileSystemRights -band $writeRights) -ne 0) {
      throw "Flight Recorder storage parent grants write access to $($ruleSid.Value)."
    }
  }
} catch {
  [Console]::Error.WriteLine($_.Exception.ToString())
  exit 1
}
"""
        try:
            subprocess.run(
                [
                    "powershell.exe",
                    "-NoProfile",
                    "-NonInteractive",
                    "-Command",
                    command,
                ],
                check=True,
                capture_output=True,
                text=True,
                env={
                    **os.environ,
                    "HF_TARGET": str(directory),
                    "HF_USER": user,
                },
            )
        except subprocess.CalledProcessError as exc:
            raise FlightRecorderError(
                (exc.stderr or "").strip()
                or "Flight Recorder ACL validation failed."
            ) from exc
        return
    status = directory.lstat()
    if (
        _is_reparse_or_symlink(status)
        or not stat_module.S_ISDIR(status.st_mode)
    ):
        raise FlightRecorderError(
            f"Flight Recorder storage parent must be a directory: {directory}"
        )
    if hasattr(os, "getuid") and status.st_uid != os.getuid():
        raise FlightRecorderError(
            "Flight Recorder storage parent must be owned by the "
            f"current user: {directory}"
        )
    if stat_module.S_IMODE(status.st_mode) & 0o022:
        raise FlightRecorderError(
            "Flight Recorder storage parent must not be group/world "
            f"writable: {directory}"
        )


def _prepare_managed_database_directory(directory: Path) -> None:
    existing = directory
    while not os.path.lexists(existing):
        if existing.parent == existing:
            break
        existing = existing.parent
    _assert_private_directory(existing)
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    _assert_private_directory(directory)
    _harden_private_path(directory, directory=True)


def _sync_directory(directory: Path) -> None:
    if os.name == "nt":
        return
    descriptor = os.open(directory, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _write_all(descriptor: int, data: bytes) -> None:
    view = memoryview(data)
    written = 0
    while written < len(view):
        count = os.write(descriptor, view[written:])
        if count <= 0:
            raise OSError("Flight Recorder key write made no progress.")
        written += count


def _read_all(descriptor: int, expected_size: int) -> bytes:
    chunks: list[bytes] = []
    remaining = max(0, expected_size)
    while remaining > 0:
        chunk = os.read(descriptor, remaining)
        if not chunk:
            break
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def _is_reparse_or_symlink(path_stat: os.stat_result) -> bool:
    return (
        stat_module.S_ISLNK(path_stat.st_mode)
        or bool(
            getattr(path_stat, "st_file_attributes", 0)
            & getattr(stat_module, "FILE_ATTRIBUTE_REPARSE_POINT", 0)
        )
    )


def _prepare_private_database_files(
    database: str,
) -> list[tuple[Path, int, int]]:
    identities: list[tuple[Path, int, int]] = []
    for candidate in (
        Path(database),
        Path(f"{database}-wal"),
        Path(f"{database}-shm"),
    ):
        try:
            existing = candidate.lstat()
            if (
                _is_reparse_or_symlink(existing)
                or not stat_module.S_ISREG(existing.st_mode)
            ):
                raise FlightRecorderError(
                    "Flight Recorder storage must be a regular file: "
                    f"{candidate}"
                )
        except FileNotFoundError:
            pass
        descriptor = os.open(
            candidate,
            os.O_CREAT
            | os.O_RDWR
            | getattr(os, "O_NOFOLLOW", 0),
            0o600,
        )
        try:
            opened = os.fstat(descriptor)
            linked = candidate.lstat()
            if (
                not stat_module.S_ISREG(opened.st_mode)
                or _is_reparse_or_symlink(linked)
                or not stat_module.S_ISREG(linked.st_mode)
                or opened.st_dev != linked.st_dev
                or opened.st_ino != linked.st_ino
            ):
                raise FlightRecorderError(
                    "Flight Recorder storage changed during private open: "
                    f"{candidate}"
                )
            _harden_private_path(candidate)
            verified = candidate.lstat()
            if (
                _is_reparse_or_symlink(verified)
                or verified.st_dev != opened.st_dev
                or verified.st_ino != opened.st_ino
            ):
                raise FlightRecorderError(
                    "Flight Recorder storage identity changed: "
                    f"{candidate}"
                )
            identities.append(
                (candidate, opened.st_dev, opened.st_ino)
            )
        finally:
            os.close(descriptor)
    return identities


def _verify_private_database_files(
    identities: Sequence[tuple[Path, int, int]],
) -> None:
    for candidate, device, inode in identities:
        current = candidate.lstat()
        if (
            _is_reparse_or_symlink(current)
            or not stat_module.S_ISREG(current.st_mode)
            or current.st_dev != device
            or current.st_ino != inode
        ):
            raise FlightRecorderError(
                f"Flight Recorder storage identity changed: {candidate}"
            )


def _recorder_owner_directory(database_path: str) -> Path:
    return Path(f"{database_path}.owners").expanduser()


def _recorder_reset_lock(database_path: str) -> Path:
    return Path(f"{database_path}.reset-lock").expanduser()


def _prepare_recorder_owner_directory(directory: Path) -> None:
    if os.path.lexists(directory):
        before = directory.lstat()
        if (
            _is_reparse_or_symlink(before)
            or not stat_module.S_ISDIR(before.st_mode)
        ):
            raise FlightRecorderError(
                "Flight Recorder owner storage must be a regular "
                f"directory: {directory}"
            )
        _assert_private_directory(directory)
    else:
        _assert_private_directory(directory.parent)
        directory.mkdir(mode=0o700)
        before = directory.lstat()
        _assert_private_directory(directory)
    _harden_private_path(directory, directory=True)
    after = directory.lstat()
    if (
        _is_reparse_or_symlink(after)
        or not stat_module.S_ISDIR(after.st_mode)
        or before.st_dev != after.st_dev
        or before.st_ino != after.st_ino
    ):
        raise FlightRecorderError(
            f"Flight Recorder owner storage identity changed: {directory}"
        )


def _reset_barrier_is_active(reset_lock: Path) -> bool:
    try:
        observed = reset_lock.stat()
        raw = reset_lock.read_text(encoding="utf-8").strip()
        try:
            parsed = json.loads(raw)
            pid = int(parsed["pid"])
            incarnation = parsed.get("incarnation")
        except (json.JSONDecodeError, KeyError, TypeError):
            pid = int(raw)
            incarnation = None
    except FileNotFoundError:
        return False
    except (OSError, ValueError):
        raise FlightRecorderError(
            "Flight Recorder reset barrier cannot be inspected."
        )
    if _process_matches_incarnation(pid, incarnation):
        return True
    try:
        current = reset_lock.stat()
    except FileNotFoundError:
        return False
    if (
        current.st_dev != observed.st_dev
        or current.st_ino != observed.st_ino
        or current.st_mtime_ns != observed.st_mtime_ns
        or current.st_size != observed.st_size
    ):
        return True
    try:
        reset_lock.unlink()
    except FileNotFoundError:
        return False
    _sync_directory(reset_lock.parent)
    return False


def _register_recorder_owner(database_path: str, owner_id: str) -> Path:
    reset_lock = _recorder_reset_lock(database_path)
    if _reset_barrier_is_active(reset_lock):
        raise FlightRecorderError("Flight Recorder reset is in progress.")
    directory = _recorder_owner_directory(database_path)
    _prepare_recorder_owner_directory(directory)
    owner_path = directory / f"{owner_id}.json"
    temporary = Path(
        f"{owner_path}.{os.getpid()}.{uuid.uuid4().hex}.tmp"
    )
    descriptor = os.open(
        temporary,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL,
        0o600,
    )
    try:
        _harden_private_path(temporary)
        owner_record = {"ownerId": owner_id, "pid": os.getpid()}
        incarnation = _current_process_incarnation()
        if incarnation:
            owner_record["incarnation"] = incarnation
        os.write(
            descriptor,
            f"{json.dumps(owner_record)}\n".encode("utf-8"),
        )
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    try:
        os.link(temporary, owner_path)
        _sync_directory(directory)
    finally:
        temporary.unlink(missing_ok=True)
        _sync_directory(directory)
    if _reset_barrier_is_active(reset_lock):
        owner_path.unlink(missing_ok=True)
        _sync_directory(directory)
        raise FlightRecorderError("Flight Recorder reset is in progress.")
    _PROCESS_OWNER_PATHS.add(owner_path)
    return owner_path


def _unregister_recorder_owner(owner_path: Optional[Path]) -> None:
    if owner_path is None:
        return
    _PROCESS_OWNER_PATHS.discard(owner_path)
    try:
        owner_path.unlink(missing_ok=True)
        _sync_directory(owner_path.parent)
    except OSError:
        pass


def _load_or_create_identity_key(
    database_path: str,
    explicit_key: Optional[str] = None,
    allow_unconfigured_create: bool = True,
) -> str:
    explicit = (explicit_key or "").strip()
    environment = os.environ.get(
        "OPENRAPPTER_FLIGHT_ID_KEY",
        "",
    ).strip()
    if (
        explicit
        and environment
        and explicit.lower() != environment.lower()
    ):
        raise ValueError(
            "Configured Flight Recorder identity keys do not match."
        )
    configured = explicit or environment
    if configured:
        if re.fullmatch(r"[0-9a-fA-F]{64}", configured) is None:
            raise ValueError(
                "OPENRAPPTER_FLIGHT_ID_KEY must be 32-byte hexadecimal."
            )

    key_path = Path(f"{database_path}.identity-key").expanduser()
    for _attempt in range(3):
        try:
            observed = key_path.lstat()
            if (
                _is_reparse_or_symlink(observed)
                or not stat_module.S_ISREG(observed.st_mode)
            ):
                raise ValueError(
                    "Flight Recorder identity key must be a regular file."
                )
            descriptor = os.open(
                key_path,
                os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0),
            )
            try:
                opened = os.fstat(descriptor)
                current = key_path.lstat()
                if (
                    _is_reparse_or_symlink(current)
                    or opened.st_dev != current.st_dev
                    or opened.st_ino != current.st_ino
                ):
                    raise ValueError(
                        "Flight Recorder identity key changed during "
                        "private open."
                    )
                existing = _read_all(
                    descriptor,
                    opened.st_size,
                ).decode("utf-8").strip()
            finally:
                os.close(descriptor)
            if re.fullmatch(r"[0-9a-fA-F]{64}", existing):
                if (
                    configured
                    and existing.lower() != configured.lower()
                ):
                    raise ValueError(
                        "Configured Flight Recorder identity key does "
                        "not match the persisted key."
                    )
                _harden_private_path(key_path)
                return existing.lower()
            if existing:
                raise ValueError("Flight Recorder identity key is invalid.")
            current = key_path.lstat()
            if (
                current.st_dev != observed.st_dev
                or current.st_ino != observed.st_ino
                or current.st_mtime_ns != observed.st_mtime_ns
                or current.st_size != observed.st_size
            ):
                continue
            key_path.unlink()
        except FileNotFoundError:
            pass

        if not configured and not allow_unconfigured_create:
            raise ValueError(
                "Flight Recorder identity key is missing for a "
                "non-empty ledger."
            )
        key = configured.lower() if configured else os.urandom(32).hex()
        temporary = Path(
            f"{key_path}.{os.getpid()}.{uuid.uuid4().hex}.tmp"
        )
        descriptor = os.open(
            temporary,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL,
            0o600,
        )
        try:
            _harden_private_path(temporary)
            _write_all(descriptor, f"{key}\n".encode("utf-8"))
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
        try:
            published = False
            try:
                verification = os.open(
                    temporary,
                    os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0),
                )
                try:
                    verified = _read_all(
                        verification,
                        os.fstat(verification).st_size,
                    ).decode("utf-8")
                finally:
                    os.close(verification)
                if verified != f"{key}\n":
                    raise ValueError(
                        "Flight Recorder identity key temporary "
                        "publication is incomplete."
                    )
                os.link(temporary, key_path)
                _harden_private_path(key_path)
                _sync_directory(key_path.parent)
                published = True
                return key
            except FileExistsError:
                continue
        finally:
            temporary.unlink(missing_ok=True)
            if published:
                _sync_directory(key_path.parent)
    raise ValueError("Flight Recorder identity key could not be created.")


def normalize_flight_model_id(value: Optional[str]) -> Optional[str]:
    """Remove routing policies from persisted model attribution."""
    if value is None:
        return None
    model = value.strip()
    if not model or model.lower() == "auto":
        return None
    return model


def _private_identifier(
    value: Optional[str],
    privacy: Optional[Mapping[str, Any]],
    prefix: str,
    field_key: Optional[str] = None,
) -> Optional[str]:
    if value is None:
        return None
    key = field_key or prefix
    if not isinstance(value, str):
        raise TypeError(f"{key} must be a string.")
    value = _normalize_unicode_scalars(value)
    if key == "kind" and value in {
        "trace.started",
        "trace.completed",
        "trace.failed",
    }:
        return value
    configured_values = _privacy_value(
        privacy,
        "redactedValues",
        "redacted_values",
        default=(),
    ) or ()
    exact_secret = any(
        isinstance(candidate, str)
        and candidate
        and (
            (
                re.fullmatch(r"[0-9a-fA-F]{64}", candidate)
                is not None
                and candidate.lower() == value.lower()
            )
            or (
                re.fullmatch(r"[0-9a-fA-F]{64}", candidate)
                is None
                and candidate == value
            )
        )
        for candidate in configured_values
    )
    if exact_secret:
        digest = hashlib.sha256(value.encode("utf-8")).hexdigest()[:24]
        return f"{prefix}:{digest}"
    if _is_canonical_private_identifier(value, prefix):
        return value
    if sanitize_flight_value(
        value,
        {
            "redactedValues": _privacy_value(
                privacy,
                "redactedValues",
                "redacted_values",
                default=(),
            )
            or ()
        },
    ) != value:
        digest = hashlib.sha256(value.encode("utf-8")).hexdigest()[:24]
        return f"{prefix}:{digest}"
    if key == "kind":
        if sanitize_flight_value(
            value,
            {
                "redactedValues": _privacy_value(
                    privacy,
                    "redactedValues",
                    "redacted_values",
                    default=(),
                )
                or ()
            },
        ) == value:
            return value
        digest = hashlib.sha256(value.encode("utf-8")).hexdigest()[:24]
        return f"{prefix}:{digest}"
    policy_keys = (
        ("id", "parentId")
        if key in {"id", "parentId"}
        else (key,)
    )
    if (
        all(
            sanitize_flight_metadata(
                {policy_key: value},
                privacy,
            ).get(policy_key)
            == value
            for policy_key in policy_keys
        )
        and sanitize_flight_value(value, privacy) == value
    ):
        return value
    digest = hashlib.sha256(value.encode("utf-8")).hexdigest()[:24]
    return f"{prefix}:{digest}"


def _is_canonical_private_identifier(
    value: str,
    prefix: str,
) -> bool:
    return (
        re.fullmatch(
            rf"{re.escape(prefix)}:[0-9a-f]{{24}}",
            value,
        )
        is not None
    )


def _privacy_value(privacy: Optional[Mapping[str, Any]], *names: str, default: Any = None) -> Any:
    if not privacy:
        return default
    for name in names:
        if name in privacy:
            return privacy[name]
    return default


def _normalized_key(key: str) -> str:
    return re.sub(r"[^a-z0-9]", "", key.lower())


def _is_prototype_pollution_key(key: str) -> bool:
    if key == "__proto__":
        return True
    return _normalized_key(key) in {"constructor", "prototype"}


#: Words that make a trailing ``key`` a credential.
#:
#: Bare ``key`` is deliberately absent, and that is the whole point of the list.
#: ``key`` is one of the most common field names there is -- map entries, config
#: entries, cache entries, sort keys -- and Show-and-Tell records which keyboard
#: shortcut was pressed under it. Redacting it would blank most of a ledger
#: whose purpose is to be read afterwards. Qualified names carry no such
#: ambiguity: nothing calls a sort key ``sshKey``.
_SECRET_KEY_QUALIFIERS = frozenset({
    "access", "api", "app", "client", "encryption", "master", "private",
    "secret", "session", "signing", "ssh", "token",
})

#: Prefixes that make a whole word a credential.
#:
#: These are prefixes rather than exact words because the singular and the
#: plural are equally secret. Matching ``token`` and ``secret`` exactly while
#: matching ``password`` and ``credential`` as prefixes is what let ``tokens``,
#: ``secrets`` and ``clientSecrets`` reach the flight log in the clear.
_SECRET_WORD_PREFIXES = (
    "authorization", "cookie", "credential", "passphrase", "passwd",
    "password", "secret", "token",
)

#: Sentinel for "the caller has no value in hand", distinct from a real ``None``.
_UNKNOWN_VALUE = object()


def _is_token_count(normalized: str, value: Any) -> bool:
    """Is this a measurement that merely shares a word with a credential?

    ``token`` is the one secret word here that is also a unit. Usage accounting
    records ``inputTokens`` and ``outputTokens`` on every provider call, and
    blanking those protects nothing -- a bare number cannot be a credential --
    while it does destroy the numbers the Bar reports and the cross-runtime
    usage vector in ``contracts/usage-v1.json``.

    The value has to decide, because the name cannot: ``apiTokens`` and
    ``inputTokens`` are the same shape and only one of them holds credentials.
    """
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return False
    return normalized.endswith(("token", "tokens"))


def _is_sensitive_key(
    key: str,
    privacy: Optional[Mapping[str, Any]],
    value: Any = _UNKNOWN_VALUE,
) -> bool:
    """Does this field name mean the value must never be recorded?

    This list is deliberately conservative and stays that way: a ledger that
    redacts too much keeps the record and loses the ability to read it, which is
    a real failure and not a safe default. ``auth``, ``salt``, ``nonce``,
    ``bearer``, ``id``, ``name``, ``path`` and bare ``key`` are all left
    readable on purpose.

    What it was not was *consistent*. It matched ``token``, ``secret`` and
    ``authorization`` as exact words while matching ``password``, ``credential``
    and ``cookie`` as prefixes, so the singular of the first three was redacted
    and the plural was not -- ``secrets``, ``tokens``, ``clientSecrets`` and
    ``apiTokens`` were all written to the flight log in the clear. Nothing about
    conservatism required that; the plural of a credential is still a credential.
    """
    if _is_prototype_pollution_key(key):
        return True
    normalized = _normalized_key(key)
    configured = _privacy_value(privacy, "redactedKeys", "redacted_keys", default=()) or ()
    if any(_normalized_key(str(candidate)) == normalized for candidate in configured):
        return True
    if _is_token_count(normalized, value):
        return False
    words = re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", key).lower()
    words = [word for word in re.split(r"[^a-z0-9]+", words) if word]
    if any(word.startswith(_SECRET_WORD_PREFIXES) for word in words):
        return True
    if (
        len(words) > 1
        and words[-1] in {"key", "keys"}
        and any(word in _SECRET_KEY_QUALIFIERS for word in words[:-1])
    ):
        return True
    return any(
        candidate in normalized
        for candidate in (
            "apikey",
            "privatekey",
            "sessiontoken",
            "accesstoken",
            "refreshtoken",
            "identitykey",
        )
    )


def is_excluded_flight_path(value: str, privacy: Optional[Mapping[str, Any]] = None) -> bool:
    patterns = list(DEFAULT_EXCLUDED_PATH_PATTERNS)
    patterns.extend(
        _privacy_value(privacy, "excludedPathPatterns", "excluded_path_patterns", default=()) or ()
    )
    decoded_value = _decode_percent_fixed(value)
    candidates = {
        value,
        re.sub(r"[?#].*$", "", value),
        decoded_value,
        re.sub(r"[?#].*$", "", decoded_value),
    }
    if re.match(r"^[a-z][a-z0-9+.-]*:", value, re.I):
        try:
            parsed = urlparse(value)
            pathname = _decode_percent_fixed(parsed.path)
            candidates.add(pathname)
            candidates.add(re.sub(r"[?#].*$", "", pathname))
        except (TypeError, ValueError):
            try:
                candidates.add(
                    _decode_percent_fixed(
                        re.sub(
                            r"^[a-z][a-z0-9+.-]*://",
                            "",
                            value,
                            flags=re.I,
                        )
                    )
                )
            except (TypeError, ValueError):
                pass
    for candidate in candidates:
        if candidate == REDACTED:
            return True
        for pattern in patterns:
            if hasattr(pattern, "search") and pattern.search(candidate):
                return True
            if isinstance(pattern, str) and re.search(pattern, candidate, re.I):
                return True
    return False


def _flight_path_string(value: Any) -> Optional[str]:
    if isinstance(value, str):
        return value
    if isinstance(value, os.PathLike):
        try:
            return os.fsdecode(os.fspath(value))
        except (TypeError, ValueError, OSError):
            return None
    return None


def _is_file_locator_key(key: str) -> bool:
    normalized = _normalized_key(_decode_percent_fixed(key))
    return normalized in {
        "path",
        "sourcepath",
        "file",
        "filename",
        "filepath",
        "name",
        "uri",
        "url",
    } or normalized.endswith(
        ("path", "uri", "url", "filename")
    )


def _contains_excluded_file_locator(
    value: Any,
    privacy: Optional[Mapping[str, Any]],
    ancestors: Optional[set[int]] = None,
    depth: int = 0,
) -> bool:
    if (
        value is None
        or isinstance(value, (str, bytes, bytearray, memoryview))
    ):
        return False
    if depth > 16:
        return True
    ancestors = ancestors or set()
    identity = id(value)
    if identity in ancestors:
        return False
    ancestors.add(identity)
    try:
        if isinstance(value, Mapping):
            for key, entry_value in value.items():
                if (
                    _is_file_locator_key(str(key))
                    and _flight_path_string(entry_value) is not None
                    and is_excluded_flight_path(
                        _flight_path_string(entry_value),
                        privacy,
                    )
                ):
                    return True
                if _contains_excluded_file_locator(
                    entry_value,
                    privacy,
                    ancestors,
                    depth + 1,
                ):
                    return True
            return False
        if isinstance(value, (list, tuple, set, frozenset)):
            return any(
                _contains_excluded_file_locator(
                    entry,
                    privacy,
                    ancestors,
                    depth + 1,
                )
                for entry in value
            )
        return False
    finally:
        ancestors.discard(identity)


def _is_safe_file_metadata_field(
    key: str,
    value: Any,
    privacy: Optional[Mapping[str, Any]],
) -> bool:
    normalized = _normalized_key(key)
    if normalized in {"size", "length"}:
        return (
            isinstance(value, (int, float))
            and not isinstance(value, bool)
            and math.isfinite(value)
            and value >= 0
        )
    if normalized in {"language", "mime", "mimetype", "extension"}:
        return (
            isinstance(value, str)
            and len(value) <= 256
            and _sanitize_string(value, privacy) == value
        )
    return False


def _oversized_string_marker(value: str) -> Optional[str]:
    byte_count = len(value.encode("utf-8"))
    return (
        f"[truncated:{byte_count}]"
        if byte_count > MAX_SANITIZE_STRING_BYTES
        else None
    )


def _collect_embedded_json_ranges(
    value: str,
) -> list[Dict[str, Any]]:
    completed: list[Dict[str, Any]] = []
    stack: list[tuple[str, int]] = []
    string_start: Optional[int] = None
    escaped = False

    for index, character in enumerate(value):
        if string_start is not None:
            if escaped:
                escaped = False
            elif character == "\\":
                escaped = True
            elif character == '"':
                completed.append(
                    {
                        "kind": "string",
                        "start": string_start,
                        "end": index,
                        "children": [],
                    }
                )
                string_start = None
            continue

        if character == '"':
            string_start = index
            continue
        if character in "{[":
            stack.append((character, index))
            continue
        if character not in "}]":
            continue
        expected = "{" if character == "}" else "["
        if not stack or stack[-1][0] != expected:
            continue
        _opening, start = stack.pop()
        completed.append(
            {
                "kind": "container",
                "start": start,
                "end": index,
                "children": [],
            }
        )

    completed.sort(
        key=lambda item: (item["start"], -item["end"])
    )
    roots: list[Dict[str, Any]] = []
    parents: list[Dict[str, Any]] = []
    for item in completed:
        while parents and not (
            parents[-1]["start"] < item["start"]
            and item["end"] < parents[-1]["end"]
        ):
            parents.pop()
        if parents:
            parents[-1]["children"].append(item)
        else:
            roots.append(item)
        parents.append(item)
    return roots


def _sanitize_embedded_json(
    value: str,
    privacy: Optional[Mapping[str, Any]],
    depth: int = 0,
    budget: Optional[Dict[str, Any]] = None,
) -> str:
    oversized = _oversized_string_marker(value)
    if oversized is not None:
        return oversized
    if depth > MAX_EMBEDDED_JSON_DEPTH:
        return REDACTED
    if budget is None:
        budget = {
            "remaining": min(
                MAX_EMBEDDED_JSON_PARSE_CHARS,
                max(len(value) * 4, 1024),
            ),
            "exhausted": False,
        }

    ranges = _collect_embedded_json_ranges(value)

    def render_range(item: Mapping[str, Any]) -> str:
        candidate = value[item["start"]:item["end"] + 1]
        budget["remaining"] -= len(candidate)
        if budget["remaining"] < 0:
            budget["exhausted"] = True
            return ""
        try:
            parsed = _strict_json_loads(candidate)
        except (TypeError, ValueError):
            parsed = _MISSING
        if (
            item["kind"] == "container"
            and isinstance(parsed, (dict, list))
        ):
            return _portable_json(
                _sanitize_recursive(parsed, privacy, set())
            )
        if (
            item["kind"] == "string"
            and isinstance(parsed, str)
        ):
            nested = _sanitize_embedded_json(
                parsed,
                privacy,
                depth + 1,
                budget,
            )
            return _portable_json(
                _sanitize_scalar_string(nested, privacy)
            )

        rendered: list[str] = []
        cursor = item["start"]
        for child in item["children"]:
            rendered.append(value[cursor:child["start"]])
            rendered.append(render_range(child))
            cursor = child["end"] + 1
        rendered.append(value[cursor:item["end"] + 1])
        return "".join(rendered)

    output: list[str] = []
    cursor = 0
    for item in ranges:
        output.append(value[cursor:item["start"]])
        output.append(render_range(item))
        cursor = item["end"] + 1
    output.append(value[cursor:])
    if budget["exhausted"]:
        return f"[truncated:{len(value.encode('utf-8'))}]"
    return "".join(output)


def _sanitize_string(value: str, privacy: Optional[Mapping[str, Any]]) -> str:
    value = _normalize_unicode_scalars(value)
    oversized = _oversized_string_marker(value)
    if oversized is not None:
        return oversized
    return _sanitize_scalar_string(
        _sanitize_embedded_json(value, privacy),
        privacy,
    )


def _sanitize_scalar_string(
    value: str,
    privacy: Optional[Mapping[str, Any]],
) -> str:
    if _is_secret_shaped_string(value, privacy):
        return REDACTED
    if is_excluded_flight_path(value, privacy):
        return EXCLUDED_PATH
    return value


def _is_secret_shaped_string(
    value: str,
    privacy: Optional[Mapping[str, Any]] = None,
) -> bool:
    configured = _privacy_value(
        privacy,
        "redactedValues",
        "redacted_values",
        default=(),
    ) or ()
    for candidate_value in {
        value,
        _decode_percent_fixed(value),
    }:
        if candidate_value == REDACTED:
            return True
        uri_secret = False
        if "?" in candidate_value:
            try:
                uri_secret = any(
                    _is_sensitive_key(
                        _decode_percent_fixed(key),
                        privacy,
                    )
                    for key, _entry_value in parse_qsl(
                        urlparse(candidate_value).query,
                        keep_blank_values=True,
                    )
                )
            except (TypeError, ValueError):
                uri_secret = False
        try:
            fragment_secret = any(
                _is_sensitive_key(
                    _decode_percent_fixed(key),
                    privacy,
                )
                for key, _entry_value in parse_qsl(
                    _decode_percent_fixed(
                        urlparse(candidate_value).fragment
                    ),
                    keep_blank_values=True,
                )
            )
        except (TypeError, ValueError):
            fragment_secret = False
        if uri_secret or fragment_secret or any(
            isinstance(candidate, str)
            and candidate
            and (
                (
                    re.fullmatch(r"[0-9a-fA-F]{64}", candidate)
                    is not None
                    and candidate.lower() in candidate_value.lower()
                )
                or (
                    re.fullmatch(r"[0-9a-fA-F]{64}", candidate)
                    is None
                    and candidate in candidate_value
                )
            )
            for candidate in configured
        ) or any(
            pattern.search(candidate_value)
            for pattern in SECRET_VALUE_PATTERNS
        ):
            return True
    return False


def _is_secret_shaped_key(
    value: str,
    privacy: Optional[Mapping[str, Any]] = None,
) -> bool:
    configured = _privacy_value(
        privacy,
        "redactedValues",
        "redacted_values",
        default=(),
    ) or ()
    return any(
        isinstance(candidate, str)
        and candidate
        and (
            (
                re.fullmatch(r"[0-9a-fA-F]{64}", candidate)
                is not None
                and candidate.lower() in value.lower()
            )
            or (
                re.fullmatch(r"[0-9a-fA-F]{64}", candidate)
                is None
                and candidate in value
            )
        )
        for candidate in configured
    ) or any(
        pattern.search(value)
        for pattern in SECRET_VALUE_PATTERNS
    )


def _unsafe_property_key_marker(
    key: str,
    privacy: Optional[Mapping[str, Any]],
) -> Optional[str]:
    if key == REDACTED:
        return REDACTED
    if _is_prototype_pollution_key(key):
        return REDACTED
    if _is_secret_shaped_key(key, privacy):
        return REDACTED
    path_like = (
        "/" in key
        or "\\" in key
        or key.startswith(".")
        or re.search(r"\.[a-z0-9]+$", key, re.I) is not None
        or re.fullmatch(
            r"(?:application_default_credentials|client[-_.]?secret)",
            key,
            re.I,
        )
        is not None
    )
    if path_like and is_excluded_flight_path(key, privacy):
        return EXCLUDED_PATH
    if _is_sensitive_key(key, privacy):
        return None
    return None


def _planned_mapping_entries(
    value: Mapping[Any, Any],
    privacy: Optional[Mapping[str, Any]],
) -> list[tuple[Any, str, str]]:
    entries = [
        (
            original,
            str(original),
            _decode_percent_fixed(
                _normalize_unicode_scalars(str(original))
            ),
        )
        for original in value
    ]
    entries.sort(
        key=lambda entry: entry[1].encode(
            "utf-16-be",
            errors="surrogatepass",
        )
    )
    reserved = {
        string_key
        for _original, _raw_key, string_key in entries
        if _unsafe_property_key_marker(string_key, privacy) is None
    }
    assigned: set[str] = set()
    planned: list[tuple[Any, str, str]] = []
    for original, _raw_key, string_key in entries:
        marker = _unsafe_property_key_marker(string_key, privacy)
        if marker is None and string_key not in assigned:
            sanitized_key = string_key
        else:
            base = marker or string_key
            sanitized_key = base
            suffix = 2
            while sanitized_key in reserved or sanitized_key in assigned:
                sanitized_key = f"{base}#{suffix}"
                suffix += 1
        assigned.add(sanitized_key)
        planned.append((original, string_key, sanitized_key))
    return planned


def _stable_sort_key(value: Any) -> bytes:
    try:
        serialized = _canonical(value)
    except (TypeError, ValueError):
        serialized = str(value)
    return serialized.encode("utf-16-be", errors="surrogatepass")


def _sanitize_recursive(
    value: Any,
    privacy: Optional[Mapping[str, Any]],
    ancestors: set[int],
) -> Any:
    if value is None or isinstance(value, bool):
        return value
    if isinstance(value, str):
        oversized = _oversized_string_marker(value)
        if oversized is not None:
            return oversized
        stripped = value.strip()
        if (
            stripped.startswith("{")
            and stripped.endswith("}")
        ) or (
            stripped.startswith("[")
            and stripped.endswith("]")
        ):
            try:
                parsed = _strict_json_loads(value)
            except (TypeError, ValueError):
                pass
            else:
                if isinstance(parsed, (dict, list)):
                    return _sanitize_recursive(
                        parsed,
                        privacy,
                        ancestors,
                    )
        return _sanitize_string(value, privacy)
    if isinstance(value, int):
        return value if abs(value) <= JS_MAX_SAFE_INTEGER else f"{value}n"
    if isinstance(value, float):
        if not math.isfinite(value):
            return None
        if value.is_integer() and abs(value) > JS_MAX_SAFE_INTEGER:
            return f"{_ecmascript_number(value)}n"
        return value
    if isinstance(value, (bytes, bytearray, memoryview)):
        return list(bytes(value))
    if isinstance(value, (datetime, date)):
        if isinstance(value, datetime) and value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return value.isoformat().replace("+00:00", "Z")
    if isinstance(value, re.Pattern):
        return f"/{value.pattern}/"
    path_string = _flight_path_string(value)
    if path_string is not None:
        return _sanitize_string(path_string, privacy)
    if callable(value):
        return UNSERIALIZABLE

    identity = id(value)
    if identity in ancestors:
        return CIRCULAR
    ancestors.add(identity)
    try:
        if isinstance(value, Mapping):
            result: Dict[str, Any] = {}
            excluded_file_object = _contains_excluded_file_locator(
                value,
                privacy,
            )
            for key, string_key, sanitized_key in _planned_mapping_entries(
                value, privacy
            ):
                if (
                    _unsafe_property_key_marker(string_key, privacy)
                    == EXCLUDED_PATH
                ):
                    result[sanitized_key] = EXCLUDED_PATH
                elif _is_sensitive_key(string_key, privacy, value[key]):
                    result[sanitized_key] = REDACTED
                elif (
                    _is_file_locator_key(string_key)
                    and _flight_path_string(value[key]) is not None
                    and is_excluded_flight_path(
                        _flight_path_string(value[key]),
                        privacy,
                    )
                ):
                    result[sanitized_key] = EXCLUDED_PATH
                elif (
                    excluded_file_object
                    and not _is_safe_file_metadata_field(
                        string_key,
                        value[key],
                        privacy,
                    )
                    and not _is_file_locator_key(string_key)
                    and not _contains_excluded_file_locator(
                        value[key],
                        privacy,
                    )
                ):
                    result[sanitized_key] = EXCLUDED_PATH
                else:
                    try:
                        result[sanitized_key] = _sanitize_recursive(
                            value[key], privacy, ancestors
                        )
                    except Exception:
                        result[sanitized_key] = UNSERIALIZABLE
            return result
        if isinstance(value, (list, tuple)):
            return [_sanitize_recursive(item, privacy, ancestors) for item in value]
        if isinstance(value, (set, frozenset)):
            entries = [_sanitize_recursive(item, privacy, ancestors) for item in value]
            return sorted(entries, key=_stable_sort_key)
        if isinstance(value, BaseException):
            result = {
                "name": value.__class__.__name__,
                "message": _sanitize_string(str(value), privacy),
            }
            if hasattr(value, "code"):
                result["code"] = _sanitize_recursive(value.code, privacy, ancestors)
            if value.__cause__ is not None:
                result["cause"] = _sanitize_recursive(value.__cause__, privacy, ancestors)
            return result
        attributes = vars(value)
        return _sanitize_recursive(attributes, privacy, ancestors)
    finally:
        ancestors.remove(identity)


_SNAPSHOT_LIMIT = object()


def _snapshot_for_sanitization(
    value: Any,
    *,
    max_nodes: int,
    max_bytes: int,
) -> Any:
    seen: Dict[int, Any] = {}
    nodes = 0
    byte_count = 0

    def visit(current: Any) -> Any:
        nonlocal nodes, byte_count
        nodes += 1
        if nodes > max_nodes:
            raise RuntimeError(_SNAPSHOT_LIMIT)
        if isinstance(current, str):
            current = _normalize_unicode_scalars(current)
            byte_count += len(current.encode("utf-8"))
            if byte_count > max_bytes:
                raise RuntimeError(_SNAPSHOT_LIMIT)
            return current
        if current is None or isinstance(
            current,
            (bool, int, float),
        ):
            return current
        if isinstance(current, (bytes, bytearray, memoryview)):
            byte_count += len(current)
            if byte_count > max_bytes:
                raise RuntimeError(_SNAPSHOT_LIMIT)
            return bytes(current)
        if isinstance(current, (datetime, date, re.Pattern)):
            return current
        path_string = _flight_path_string(current)
        if path_string is not None:
            return path_string

        identity = id(current)
        if identity in seen:
            return seen[identity]

        if isinstance(current, Mapping):
            clone: Dict[Any, Any] = {}
            seen[identity] = clone
            try:
                entries = list(current.items())
            except Exception:
                return UNSERIALIZABLE
            if nodes + len(entries) > max_nodes:
                raise RuntimeError(_SNAPSHOT_LIMIT)
            for key, entry_value in entries:
                nodes += 1
                raw_key_text = str(key)
                normalized_key_text = _normalize_unicode_scalars(
                    raw_key_text
                )
                byte_count += len(normalized_key_text.encode("utf-8"))
                if nodes > max_nodes or byte_count > max_bytes:
                    raise RuntimeError(_SNAPSHOT_LIMIT)
                snapshot_key = (
                    raw_key_text
                    if isinstance(key, str)
                    else visit(key)
                )
                snapshot_value = visit(entry_value)
                try:
                    clone[snapshot_key] = snapshot_value
                except TypeError:
                    clone[raw_key_text] = snapshot_value
            return clone
        if isinstance(current, (list, tuple)):
            if nodes + len(current) > max_nodes:
                raise RuntimeError(_SNAPSHOT_LIMIT)
            clone_list: list[Any] = []
            seen[identity] = clone_list
            for entry in current:
                clone_list.append(visit(entry))
            return clone_list
        if isinstance(current, (set, frozenset)):
            if nodes + len(current) > max_nodes:
                raise RuntimeError(_SNAPSHOT_LIMIT)
            clone_set: list[Any] = []
            seen[identity] = clone_set
            for entry in current:
                clone_set.append(visit(entry))
            clone_set.sort(key=_stable_sort_key)
            return clone_set
        if isinstance(current, BaseException):
            clone_error: Dict[str, Any] = {}
            seen[identity] = clone_error
            for key, getter in (
                ("name", lambda: current.__class__.__name__),
                ("message", lambda: str(current)),
                ("code", lambda: getattr(current, "code", None)),
                ("cause", lambda: current.__cause__),
            ):
                try:
                    entry = getter()
                    if entry is not None:
                        clone_error[key] = visit(entry)
                except Exception:
                    clone_error[key] = UNSERIALIZABLE
            return clone_error
        if callable(current):
            return UNSERIALIZABLE
        try:
            attributes = vars(current)
        except Exception:
            return UNSERIALIZABLE
        clone_object: Dict[str, Any] = {}
        seen[identity] = clone_object
        for key, entry_value in list(attributes.items()):
            nodes += 1
            key_text = str(key)
            byte_count += len(
                _normalize_unicode_scalars(key_text).encode("utf-8")
            )
            if nodes > max_nodes or byte_count > max_bytes:
                raise RuntimeError(_SNAPSHOT_LIMIT)
            clone_object[key_text] = visit(entry_value)
        return clone_object

    return visit(value)


def _within_sanitize_budget(
    value: Any,
    *,
    max_nodes: int,
    max_bytes: int,
) -> bool:
    stack: list[tuple[Any, bool]] = [(value, False)]
    ancestors: set[int] = set()
    nodes = 0
    byte_count = 0

    while stack:
        current, exiting = stack.pop()
        if exiting:
            ancestors.discard(id(current))
            continue
        nodes += 1
        if nodes > max_nodes:
            return False
        if isinstance(current, str):
            byte_count += len(current.encode("utf-8"))
            if byte_count > max_bytes:
                return False
            continue
        if current is None or isinstance(
            current,
            (bool, int, float),
        ):
            continue
        if isinstance(current, (bytes, bytearray, memoryview)):
            byte_count += len(current)
            if byte_count > max_bytes:
                return False
            continue

        identity = id(current)
        if identity in ancestors:
            continue
        ancestors.add(identity)
        stack.append((current, True))

        if isinstance(current, Mapping):
            try:
                if len(current) + nodes > max_nodes:
                    return False
                for key, entry_value in current.items():
                    key_text = str(key)
                    nodes += 1
                    byte_count += len(key_text.encode("utf-8"))
                    if nodes > max_nodes or byte_count > max_bytes:
                        return False
                    stack.append((entry_value, False))
            except Exception:
                return True
            continue
        if isinstance(current, (list, tuple, set, frozenset)):
            if len(current) + nodes > max_nodes:
                return False
            stack.extend((entry, False) for entry in current)
            continue
        if isinstance(current, BaseException):
            try:
                error_name = current.__class__.__name__
            except Exception:
                error_name = UNSERIALIZABLE
            try:
                error_message = str(current)
            except Exception:
                error_message = UNSERIALIZABLE
            try:
                error_code = getattr(current, "code", None)
            except Exception:
                error_code = UNSERIALIZABLE
            try:
                error_cause = current.__cause__
            except Exception:
                error_cause = UNSERIALIZABLE
            stack.extend(
                (
                    (error_name, False),
                    (error_message, False),
                    (error_code, False),
                    (error_cause, False),
                )
            )
            continue
        path_string = _flight_path_string(current)
        if path_string is not None:
            stack.append((path_string, False))
            continue
        try:
            attributes = vars(current)
        except Exception:
            return True
        stack.append((attributes, False))
    return True


def _sanitize_bounded_value(
    value: Any,
    privacy: Optional[Mapping[str, Any]],
    *,
    max_nodes: int,
    max_bytes: int,
) -> Any:
    try:
        snapshot = _snapshot_for_sanitization(
            value,
            max_nodes=max_nodes,
            max_bytes=max_bytes,
        )
        if not _within_sanitize_budget(
            snapshot,
            max_nodes=max_nodes,
            max_bytes=max_bytes,
        ):
            return TRAVERSAL_LIMIT
        return _sanitize_recursive(snapshot, privacy, set())
    except RuntimeError as exc:
        if exc.args and exc.args[0] is _SNAPSHOT_LIMIT:
            return TRAVERSAL_LIMIT
        return UNSERIALIZABLE
    except Exception:
        return UNSERIALIZABLE


def sanitize_flight_value(value: Any, privacy: Optional[Mapping[str, Any]] = None) -> Any:
    return _sanitize_bounded_value(
        value,
        privacy,
        max_nodes=MAX_SANITIZE_NODES,
        max_bytes=MAX_SANITIZE_BYTES,
    )


def sanitize_flight_metadata(
    metadata: Optional[Mapping[str, Any]],
    privacy: Optional[Mapping[str, Any]] = None,
) -> Dict[str, Any]:
    if metadata is None:
        return {}
    sanitized = sanitize_flight_value(metadata, privacy)
    if isinstance(sanitized, dict):
        return sanitized
    return {"value": sanitized}


def _safe_error_property(error: Any, key: str) -> Any:
    if isinstance(error, Mapping):
        try:
            return error.get(key)
        except Exception:
            return None
    try:
        return getattr(error, key)
    except Exception:
        return None


def summarize_flight_error(error: Any) -> Dict[str, Any]:
    """Return stable, non-reversible error metadata without the raw message."""
    try:
        if isinstance(error, str):
            raw_message = error
            error_name = "Error"
        else:
            message = _safe_error_property(error, "message")
            raw_message = (
                message
                if isinstance(message, str)
                else str(error)
                if isinstance(error, BaseException)
                else ""
            )
            name = _safe_error_property(error, "name")
            if not isinstance(name, str) and isinstance(error, BaseException):
                name = error.__class__.__name__
            error_name = (
                name
                if isinstance(name, str)
                and re.fullmatch(r"[A-Za-z][A-Za-z0-9_.:-]{0,63}", name)
                and not any(pattern.search(name) for pattern in SECRET_VALUE_PATTERNS)
                and not is_excluded_flight_path(name)
                else "Error"
            )

        summary: Dict[str, Any] = {
            "errorName": error_name,
            "messageHash": hashlib.sha256(raw_message.encode("utf-8")).hexdigest(),
            "messageChars": len(raw_message.encode("utf-16-le")) // 2,
        }

        code = _safe_error_property(error, "code")
        if isinstance(code, bool):
            summary["errorCode"] = code
        elif (
            isinstance(code, (int, float))
            and not isinstance(code, bool)
            and math.isfinite(code)
            and len(str(code)) <= 32
        ):
            summary["errorCode"] = code
        elif (
            isinstance(code, str)
            and re.fullmatch(r"[A-Za-z0-9_.:-]{1,64}", code)
            and not any(pattern.search(code) for pattern in SECRET_VALUE_PATTERNS)
            and not is_excluded_flight_path(code)
        ):
            summary["errorCode"] = code

        for key in ("status", "statusCode"):
            status = _safe_error_property(error, key)
            if (
                isinstance(status, (int, float))
                and not isinstance(status, bool)
                and math.isfinite(status)
                and float(status).is_integer()
                and 100 <= status <= 599
            ):
                summary["httpStatus"] = int(status)
                break
        return summary
    except Exception:
        return {
            "errorName": "Error",
            "messageHash": hashlib.sha256(b"").hexdigest(),
            "messageChars": 0,
        }


def sanitize_flight_payload(
    payload: Any,
    privacy: Optional[Mapping[str, Any]] = None,
) -> Any:
    if _privacy_value(privacy, "recordIO", "record_io", default=False) is not True:
        return None
    configured = _privacy_value(
        privacy,
        "maxPayloadBytes",
        "max_payload_bytes",
        default=DEFAULT_MAX_PAYLOAD_BYTES,
    )
    if isinstance(configured, bool) or not isinstance(configured, (int, float)):
        configured = DEFAULT_MAX_PAYLOAD_BYTES
    if not math.isfinite(configured) or configured < 0:
        configured = DEFAULT_MAX_PAYLOAD_BYTES
    max_payload_bytes = int(configured)
    if max_payload_bytes < 4:
        return f"[truncated:{max_payload_bytes}]"
    resolved = payload() if callable(payload) else payload
    sanitized = _sanitize_bounded_value(
        resolved,
        privacy,
        max_nodes=max(
            64,
            min(
                MAX_SANITIZE_NODES,
                max_payload_bytes * 2 + 64,
            ),
        ),
        max_bytes=max(
            MAX_SANITIZE_STRING_BYTES,
            min(
                MAX_SANITIZE_BYTES,
                max_payload_bytes * 4 + 1_024,
            ),
        ),
    )
    try:
        serialized = _portable_json(sanitized)
    except (TypeError, ValueError):
        return UNSERIALIZABLE
    byte_count = len(serialized.encode("utf-8"))
    if byte_count <= max_payload_bytes:
        return sanitized
    return f"[truncated:{byte_count}]"


def _iso_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _assert_string(value: Any, label: str) -> None:
    if not isinstance(value, str):
        raise FlightRecorderCorruptionError(f"{label} must be a string.")
    if any(0xD800 <= ord(character) <= 0xDFFF for character in value):
        raise FlightRecorderCorruptionError(
            f"{label} must contain valid Unicode scalar values."
        )


def _assert_non_negative_integer(value: Any, label: str) -> None:
    if (
        isinstance(value, bool)
        or not isinstance(value, int)
        or value < 0
        or value > JS_MAX_SAFE_INTEGER
    ):
        raise FlightRecorderCorruptionError(
            f"{label} must be a non-negative integer within the JavaScript safe integer domain."
        )


def _parse_iso_timestamp_ms(value: Any, label: str) -> int:
    _assert_string(value, label)
    match = re.fullmatch(
        r"([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.([0-9]{1,3}))?(?:Z|([+-])([0-9]{2}):([0-9]{2}))",
        value,
    )
    if match is None:
        raise FlightRecorderCorruptionError(f"{label} must be a parseable ISO timestamp.")
    year = int(match.group(1))
    month = int(match.group(2))
    day = int(match.group(3))
    hour = int(match.group(4))
    minute = int(match.group(5))
    second = int(match.group(6))
    fraction = match.group(7) or ""
    offset_sign = match.group(8)
    offset_hour = int(match.group(9) or 0)
    offset_minute = int(match.group(10) or 0)
    leap_year = year % 4 == 0 and (year % 100 != 0 or year % 400 == 0)
    days_in_month = (
        31,
        29 if leap_year else 28,
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    )
    if (
        year < 1
        or month < 1
        or month > 12
        or day < 1
        or day > days_in_month[month - 1]
        or hour > 23
        or minute > 59
        or second > 59
        or offset_hour > 14
        or offset_minute > 59
        or (offset_hour == 14 and offset_minute != 0)
    ):
        raise FlightRecorderCorruptionError(
            f"{label} must be a parseable ISO timestamp."
        )
    fraction_ms = int((fraction[:3]).ljust(3, "0") or "0")
    offset_minutes = (offset_hour * 60 + offset_minute) * (
        -1 if offset_sign == "-" else 1
    )
    return (
        _days_from_civil(year, month, day) * 86_400_000
        + hour * 3_600_000
        + minute * 60_000
        + second * 1_000
        + fraction_ms
        - offset_minutes * 60_000
    )


def _days_from_civil(year: int, month: int, day: int) -> int:
    adjusted_year = year - (1 if month <= 2 else 0)
    era = adjusted_year // 400
    year_of_era = adjusted_year - era * 400
    shifted_month = month + (-3 if month > 2 else 9)
    day_of_year = (153 * shifted_month + 2) // 5 + day - 1
    day_of_era = (
        year_of_era * 365
        + year_of_era // 4
        - year_of_era // 100
        + day_of_year
    )
    return era * 146_097 + day_of_era - 719_468


def _assert_iso_timestamp(value: Any, label: str) -> None:
    _parse_iso_timestamp_ms(value, label)


def _timestamp_ms(value: Any, label: str) -> int:
    return _parse_iso_timestamp_ms(value, label)


def _trace_lifecycle_fields(
    event_json: str,
) -> tuple[
    Optional[str],
    Optional[str],
    Optional[int],
    Optional[str],
]:
    try:
        event = json.loads(event_json)
        metadata = event.get("metadata") or {}
        owner_pid = metadata.get("ownerPid")
        normalized_owner = (
            isinstance(owner_pid, int)
            and not isinstance(owner_pid, bool)
            and owner_pid > 0
        )
        return (
            event.get("id") if isinstance(event.get("id"), str) else None,
            (
                event.get("parentId")
                if isinstance(event.get("parentId"), str)
                else None
            ),
            owner_pid if normalized_owner else None,
            (
                metadata.get("ownerIncarnation")
                if isinstance(metadata.get("ownerIncarnation"), str)
                else None
            ),
        )
    except (AttributeError, TypeError, json.JSONDecodeError):
        pass
    return None, None, None, None


def _process_is_alive(pid: int) -> bool:
    if os.name == "nt":
        import ctypes
        from ctypes import wintypes

        process_query_limited_information = 0x1000
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        open_process = kernel32.OpenProcess
        open_process.argtypes = [
            wintypes.DWORD,
            wintypes.BOOL,
            wintypes.DWORD,
        ]
        open_process.restype = wintypes.HANDLE
        close_handle = kernel32.CloseHandle
        close_handle.argtypes = [wintypes.HANDLE]
        close_handle.restype = wintypes.BOOL

        ctypes.set_last_error(0)
        handle = open_process(
            process_query_limited_information,
            False,
            pid,
        )
        if handle:
            close_handle(handle)
            return True
        error = ctypes.get_last_error()
        if error in {87, 1168}:
            return False
        # Access denial and ambiguous API failures must fail closed so an
        # active owner is never reclaimed merely because it cannot be queried.
        return True
    try:
        os.kill(pid, 0)
        return True
    except PermissionError:
        return True
    except ProcessLookupError:
        return False
    except OSError as exc:
        if exc.errno == errno.ESRCH:
            return False
        if getattr(exc, "winerror", None) in {
            87,
            1168,
        }:
            return False
        raise


def _read_process_incarnation(pid: int) -> Optional[str]:
    try:
        if sys.platform.startswith("linux"):
            stat = Path(f"/proc/{pid}/stat").read_text(
                encoding="utf-8"
            )
            fields = stat[stat.rfind(")") + 2 :].split()
            return f"linux:{fields[19]}" if len(fields) > 19 else None
        if os.name == "nt":
            return "win:" + subprocess.check_output(
                [
                    "powershell.exe",
                    "-NoProfile",
                    "-NonInteractive",
                    "-Command",
                    (
                        f"(Get-Process -Id {pid}).StartTime."
                        "ToUniversalTime().ToFileTimeUtc()"
                    ),
                ],
                text=True,
            ).strip()
        started = subprocess.check_output(
            ["ps", "-o", "lstart=", "-p", str(pid)],
            text=True,
            env={**os.environ, "LC_ALL": "C", "TZ": "UTC"},
        ).strip()
        return f"ps-c-utc:{started}" if started else None
    except (OSError, subprocess.SubprocessError, IndexError):
        return None


_CURRENT_PROCESS_PID = os.getpid()
_CURRENT_PROCESS_INCARNATION = _read_process_incarnation(
    _CURRENT_PROCESS_PID
)


def _current_process_incarnation() -> Optional[str]:
    global _CURRENT_PROCESS_PID, _CURRENT_PROCESS_INCARNATION
    current_pid = os.getpid()
    if current_pid != _CURRENT_PROCESS_PID:
        _CURRENT_PROCESS_PID = current_pid
        _CURRENT_PROCESS_INCARNATION = (
            _read_process_incarnation(current_pid)
        )
    return _CURRENT_PROCESS_INCARNATION


def _process_matches_incarnation(
    pid: int,
    incarnation: Optional[str],
) -> bool:
    if not _process_is_alive(pid):
        return False
    if not incarnation:
        return True
    current = (
        _current_process_incarnation()
        if pid == os.getpid()
        else _read_process_incarnation(pid)
    )
    return current is None or current == incarnation


def _rows_have_live_trace(rows: list[tuple[Any, ...]]) -> bool:
    starts = _unmatched_trace_starts(rows)
    return any(
        owner_pid is not None
        and _process_matches_incarnation(owner_pid, incarnation)
        for owner_pid, incarnation in starts.values()
    )


def _unmatched_trace_starts(
    rows: list[tuple[Any, ...]],
) -> Dict[str, tuple[Optional[int], Optional[str]]]:
    starts: Dict[str, tuple[Optional[int], Optional[str]]] = {}
    for row in rows:
        kind = row[4]
        event_json = row[5]
        (
            event_id,
            parent_id,
            owner_pid,
            owner_incarnation,
        ) = _trace_lifecycle_fields(event_json)
        if kind == "trace.started" and event_id is not None:
            starts[event_id] = (owner_pid, owner_incarnation)
        elif kind in {"trace.completed", "trace.failed"} and parent_id:
            starts.pop(parent_id, None)
    return starts


def _normalize_flight_query(
    query: Optional[Mapping[str, Any]] = None,
    filters: Optional[Mapping[str, Any]] = None,
    identity_key: Optional[str] = None,
    privacy: Optional[Mapping[str, Any]] = None,
) -> Dict[str, Any]:
    normalized: Dict[str, Any] = {}
    for source in (query or {}, filters or {}):
        if not isinstance(source, Mapping):
            raise TypeError("Flight event query must be a mapping.")
        for key, value in source.items():
            if key in normalized:
                raise TypeError(f'Flight event query contains duplicate filter "{key}".')
            normalized[key] = value
    for alias, canonical in QUERY_ALIASES.items():
        if alias not in normalized:
            continue
        if canonical in normalized:
            raise TypeError(
                f'Flight event query contains both "{canonical}" and "{alias}".'
            )
        normalized[canonical] = normalized.pop(alias)
    unexpected = set(normalized) - QUERY_KEYS
    if unexpected:
        raise TypeError(
            f'Flight event query contains unexpected filter "{sorted(unexpected)[0]}".'
        )
    if "sessionId" in normalized:
        _assert_string(normalized["sessionId"], "sessionId")
        if identity_key is not None:
            normalized["sessionId"] = normalize_flight_session_id(
                normalized["sessionId"],
                identity_key,
                _privacy_value(
                    privacy,
                    "redactedValues",
                    "redacted_values",
                    default=(),
                )
                or (),
            )
    if "traceId" in normalized:
        _assert_string(normalized["traceId"], "traceId")
        if not _is_canonical_private_identifier(
            normalized["traceId"],
            "trace",
        ):
            normalized["traceId"] = _private_identifier(
                normalized["traceId"],
                privacy,
                "trace",
                "traceId",
            )
    if "workspaceId" in normalized:
        _assert_string(normalized["workspaceId"], "workspaceId")
        normalized["workspaceId"] = normalize_flight_workspace_id(
            _private_identifier(
                normalized["workspaceId"],
                privacy,
                "workspace",
                "workspaceId",
            )
        )
    for key, prefix in (
        ("source", "source"),
        ("providerId", "provider"),
        ("agentName", "agent"),
        ("toolName", "tool"),
    ):
        if key in normalized:
            _assert_string(normalized[key], key)
            normalized[key] = _private_identifier(
                normalized[key],
                privacy,
                prefix,
                key,
            )
    return normalized


def _assert_json_value(value: Any, label: str, seen: Optional[set[int]] = None) -> None:
    if isinstance(value, str):
        _assert_string(value, label)
        return
    if value is None or isinstance(value, bool):
        return
    if isinstance(value, int):
        if abs(value) <= JS_MAX_SAFE_INTEGER:
            return
        raise FlightRecorderCorruptionError(
            f"{label} must not contain integers outside the JavaScript safe integer domain."
        )
    if isinstance(value, float):
        if (
            math.isfinite(value)
            and not (
                value.is_integer()
                and abs(value) > JS_MAX_SAFE_INTEGER
            )
        ):
            return
        raise FlightRecorderCorruptionError(
            f"{label} must contain only finite numbers and JavaScript-safe integral values."
        )
    if not isinstance(value, (list, dict)):
        raise FlightRecorderCorruptionError(f"{label} must contain only JSON-compatible values.")
    if seen is None:
        seen = set()
    identity = id(value)
    if identity in seen:
        raise FlightRecorderCorruptionError(f"{label} must not contain circular references.")
    seen.add(identity)
    try:
        if isinstance(value, list):
            for index, item in enumerate(value):
                _assert_json_value(item, f"{label}[{index}]", seen)
        else:
            for key, item in value.items():
                if not isinstance(key, str):
                    raise FlightRecorderCorruptionError(f"{label} keys must be strings.")
                _assert_string(key, f"{label} key")
                _assert_json_value(item, f"{label}.{key}", seen)
    finally:
        seen.remove(identity)


def validate_flight_event(value: Any, label: str = "event") -> Dict[str, Any]:
    if not isinstance(value, dict):
        raise FlightRecorderCorruptionError(f"{label} must be an object.")
    unexpected = set(value) - EVENT_KEYS
    if unexpected:
        raise FlightRecorderCorruptionError(
            f'{label} contains unexpected field "{sorted(unexpected)[0]}".'
        )
    if value.get("schema") != FLIGHT_EVENT_SCHEMA:
        raise FlightRecorderCorruptionError(
            f'{label}.schema must be "{FLIGHT_EVENT_SCHEMA}".'
        )
    for key in ("id", "kind", "source", "traceId", "timestamp", "contentHash"):
        _assert_string(value.get(key), f"{label}.{key}")
    _assert_non_negative_integer(value.get("sequence"), f"{label}.sequence")
    if value.get("status") not in EVENT_STATUSES:
        raise FlightRecorderCorruptionError(f"{label}.status is invalid.")
    if value.get("parentId", _MISSING) is _MISSING:
        raise FlightRecorderCorruptionError(f"{label}.parentId is required.")
    if value["parentId"] is not None:
        _assert_string(value["parentId"], f"{label}.parentId")
    _assert_iso_timestamp(value["timestamp"], f"{label}.timestamp")
    for key in ("sessionId", "workspaceId", "providerId", "model", "agentName", "toolName"):
        if key in value:
            _assert_string(value[key], f"{label}.{key}")
    if (
        "model" in value
        and normalize_flight_model_id(value["model"]) != value["model"]
    ):
        raise FlightRecorderCorruptionError(
            f"{label}.model must be a concrete normalized model ID."
        )
    for key in (
        "id",
        "kind",
        "source",
        "traceId",
        "parentId",
        "providerId",
        "workspaceId",
        "model",
        "agentName",
        "toolName",
    ):
        field = value.get(key)
        if (
            isinstance(field, str)
            and sanitize_flight_value(field) != field
        ):
            raise FlightRecorderCorruptionError(
                f"{label}.{key} violates Flight Recorder privacy."
            )
    if "durationMs" in value:
        duration = value["durationMs"]
        if (
            isinstance(duration, bool)
            or not isinstance(duration, (int, float))
            or not math.isfinite(duration)
            or duration < 0
            or (
                isinstance(duration, int)
                and duration > JS_MAX_SAFE_INTEGER
            )
            or (
                isinstance(duration, float)
                and duration.is_integer()
                and duration > JS_MAX_SAFE_INTEGER
            )
        ):
            raise FlightRecorderCorruptionError(
                f"{label}.durationMs must be a finite non-negative number."
            )
    if not isinstance(value.get("metadata"), dict):
        raise FlightRecorderCorruptionError(f"{label}.metadata must be an object.")
    _assert_json_value(value["metadata"], f"{label}.metadata")
    if (
        "sessionId" in value
        and re.fullmatch(r"session:[0-9a-f]{24}", value["sessionId"])
        is None
    ):
        raise FlightRecorderCorruptionError(
            f"{label}.sessionId must be an opaque session identifier."
        )
    if (
        "workspaceId" in value
        and normalize_flight_workspace_id(value["workspaceId"])
        != value["workspaceId"]
    ):
        raise FlightRecorderCorruptionError(
            f"{label}.workspaceId must not contain a raw path."
        )
    if sanitize_flight_metadata(value["metadata"]) != value["metadata"]:
        raise FlightRecorderCorruptionError(
            f"{label}.metadata violates Flight Recorder privacy."
        )
    if "payload" in value:
        _assert_json_value(value["payload"], f"{label}.payload")
        if (
            sanitize_flight_payload(
                value["payload"],
                {
                    "recordIO": True,
                    "maxPayloadBytes": JS_MAX_SAFE_INTEGER,
                },
            )
            != value["payload"]
        ):
            raise FlightRecorderCorruptionError(
                f"{label}.payload violates Flight Recorder privacy."
            )
    if not verify_flight_event_hash(value):
        raise FlightRecorderCorruptionError(f"Flight event integrity check failed for {label}.")
    return value


class SQLiteFlightLedger:
    """SQLite append ledger with integrity validation at every boundary."""

    def __init__(
        self,
        options: Optional[Mapping[str, Any]] = None,
        *,
        database_path: Optional[str | os.PathLike[str]] = None,
        in_memory: Optional[bool] = None,
    ) -> None:
        options = dict(options or {})
        self.database_path = str(
            database_path
            if database_path is not None
            else options.get("databasePath", options.get("database_path", "openrappter-flight.db"))
        )
        self.in_memory = bool(
            in_memory
            if in_memory is not None
            else options.get("inMemory", options.get("in_memory", False))
        )
        self._db: Optional[sqlite3.Connection] = None
        self._state = "created"
        self._lock = threading.RLock()

    def initialize(self) -> None:
        with self._lock:
            if self._state == "closed":
                raise FlightRecorderError("Flight ledger is closed and cannot be initialized.")
            if self._state == "initialized":
                return
            database = ":memory:" if self.in_memory else self.database_path
            prepared_files = (
                []
                if self.in_memory
                else (
                    _assert_private_directory(
                        Path(database).expanduser().parent
                    )
                    or _prepare_private_database_files(database)
                )
            )
            db = sqlite3.connect(
                database,
                timeout=BUSY_TIMEOUT_MS / 1000,
                check_same_thread=False,
                isolation_level=None,
            )
            try:
                if prepared_files:
                    _verify_private_database_files(prepared_files)
                db.execute(f"PRAGMA busy_timeout = {BUSY_TIMEOUT_MS}")
                db.execute("PRAGMA foreign_keys = ON")
                db.execute("PRAGMA secure_delete = ON")
                if not self.in_memory:
                    db.execute("PRAGMA journal_mode = WAL")
                    db.execute("PRAGMA synchronous = FULL")
                    _verify_private_database_files(prepared_files)
                table_exists = db.execute(
                    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'flight_events'"
                ).fetchone()
                if table_exists is None:
                    self._create_table(db)
                    self._create_indexes(db)
                else:
                    columns = {
                        row[1]: row
                        for row in db.execute(
                            "PRAGMA table_info(flight_events)"
                        ).fetchall()
                    }
                    timestamp_column = columns.get("timestamp_ms")
                    if timestamp_column is None or timestamp_column[3] != 1:
                        self._migrate_timestamp_ms(
                            db,
                            source_has_timestamp_ms=timestamp_column is not None,
                        )
                    else:
                        self._create_indexes(db)
                db.execute(
                    """
                    CREATE TABLE IF NOT EXISTS flight_metadata (
                        key TEXT PRIMARY KEY,
                        value TEXT NOT NULL
                    )
                    """
                )
                if not self.in_memory:
                    probe_id = (
                        "__openrappter_sidecar_probe__:"
                        f"{uuid.uuid4()}"
                    )
                    db.execute("BEGIN IMMEDIATE")
                    try:
                        db.execute(
                            """
                            INSERT INTO flight_events (
                                id, sequence, trace_id, timestamp,
                                timestamp_ms, kind, source, status,
                                session_id, workspace_id, provider_id,
                                agent_name, tool_name, event_json
                            ) VALUES (
                                ?, 0, ?, '1970-01-01T00:00:00.000Z',
                                0, 'sidecar.probe', 'flight-recorder',
                                'info', NULL, NULL, NULL, NULL, NULL, '{}'
                            )
                            """,
                            (probe_id, probe_id),
                        )
                        db.execute(
                            "DELETE FROM flight_events WHERE id = ?",
                            (probe_id,),
                        )
                        db.execute("COMMIT")
                    except Exception:
                        db.execute("ROLLBACK")
                        raise
                    candidates = (
                        Path(database),
                        Path(f"{database}-wal"),
                        Path(f"{database}-shm"),
                    )
                    missing = [
                        str(candidate)
                        for candidate in candidates
                        if not candidate.exists()
                    ]
                    if missing:
                        raise FlightRecorderError(
                            "Flight Recorder private SQLite files were "
                            f"not materialized: {', '.join(missing)}"
                        )
                    for candidate in candidates:
                        _harden_private_path(candidate)
                    _verify_private_database_files(prepared_files)
            except Exception:
                db.close()
                raise
            self._db = db
            self._state = "initialized"

    @staticmethod
    def _create_table(db: sqlite3.Connection) -> None:
        db.execute(
            """
            CREATE TABLE flight_events (
                id TEXT PRIMARY KEY,
                sequence INTEGER NOT NULL,
                trace_id TEXT NOT NULL,
                timestamp TEXT NOT NULL,
                timestamp_ms INTEGER NOT NULL,
                kind TEXT NOT NULL,
                source TEXT NOT NULL,
                status TEXT NOT NULL,
                session_id TEXT,
                workspace_id TEXT,
                provider_id TEXT,
                agent_name TEXT,
                tool_name TEXT,
                event_json TEXT NOT NULL,
                UNIQUE (trace_id, sequence)
            )
            """
        )

    @staticmethod
    def _create_indexes(db: sqlite3.Connection) -> None:
        statements = (
            "CREATE INDEX IF NOT EXISTS idx_flight_events_sequence_timestamp "
            "ON flight_events(sequence, timestamp_ms)",
            "CREATE INDEX IF NOT EXISTS idx_flight_events_trace ON flight_events(trace_id)",
            "CREATE INDEX IF NOT EXISTS idx_flight_events_session ON flight_events(session_id)",
            "CREATE INDEX IF NOT EXISTS idx_flight_events_workspace ON flight_events(workspace_id)",
            "CREATE INDEX IF NOT EXISTS idx_flight_events_kind ON flight_events(kind)",
            "CREATE INDEX IF NOT EXISTS idx_flight_events_source ON flight_events(source)",
            "CREATE INDEX IF NOT EXISTS idx_flight_events_provider ON flight_events(provider_id)",
            "CREATE INDEX IF NOT EXISTS idx_flight_events_agent ON flight_events(agent_name)",
            "CREATE INDEX IF NOT EXISTS idx_flight_events_tool ON flight_events(tool_name)",
            "CREATE INDEX IF NOT EXISTS idx_flight_events_status ON flight_events(status)",
            "CREATE INDEX IF NOT EXISTS idx_flight_events_timestamp ON flight_events(timestamp_ms)",
        )
        for statement in statements:
            db.execute(statement)

    @classmethod
    def _migrate_timestamp_ms(
        cls,
        db: sqlite3.Connection,
        *,
        source_has_timestamp_ms: bool,
    ) -> None:
        db.execute("BEGIN IMMEDIATE")
        try:
            db.execute("ALTER TABLE flight_events RENAME TO flight_events_legacy")
            cls._create_table(db)
            source_columns = (
                "rowid, id, sequence, trace_id, timestamp, timestamp_ms, kind, "
                "source, status, session_id, workspace_id, provider_id, "
                "agent_name, tool_name, event_json"
                if source_has_timestamp_ms
                else
                "rowid, id, sequence, trace_id, timestamp, kind, source, status, "
                "session_id, workspace_id, provider_id, agent_name, tool_name, event_json"
            )
            rows = db.execute(
                f"SELECT {source_columns} FROM flight_events_legacy ORDER BY rowid"
            ).fetchall()
            insert_sql = """
                INSERT INTO flight_events (
                    rowid, id, sequence, trace_id, timestamp, timestamp_ms,
                    kind, source, status, session_id, workspace_id, provider_id,
                    agent_name, tool_name, event_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """
            for row in rows:
                if source_has_timestamp_ms:
                    (
                        rowid,
                        event_id,
                        sequence,
                        trace_id,
                        timestamp,
                        _old_timestamp_ms,
                        kind,
                        source,
                        status,
                        session_id,
                        workspace_id,
                        provider_id,
                        agent_name,
                        tool_name,
                        event_json,
                    ) = row
                else:
                    (
                        rowid,
                        event_id,
                        sequence,
                        trace_id,
                        timestamp,
                        kind,
                        source,
                        status,
                        session_id,
                        workspace_id,
                        provider_id,
                        agent_name,
                        tool_name,
                        event_json,
                    ) = row
                db.execute(
                    insert_sql,
                    (
                        rowid,
                        event_id,
                        sequence,
                        trace_id,
                        timestamp,
                        _timestamp_ms(timestamp, f'flight event row "{event_id}".timestamp'),
                        kind,
                        source,
                        status,
                        session_id,
                        workspace_id,
                        provider_id,
                        agent_name,
                        tool_name,
                        event_json,
                    ),
                )
            db.execute("DROP TABLE flight_events_legacy")
            cls._create_indexes(db)
            db.execute("COMMIT")
        except Exception:
            db.execute("ROLLBACK")
            raise

    def close(self) -> None:
        with self._lock:
            if self._state == "closed":
                return
            if self._db is not None:
                self._db.close()
            self._db = None
            self._state = "closed"

    def _ensure_db(self) -> sqlite3.Connection:
        if self._state == "closed":
            raise FlightRecorderError("Flight ledger is closed.")
        if self._state != "initialized" or self._db is None:
            raise FlightRecorderError("Flight ledger is not initialized. Call initialize() first.")
        return self._db

    @staticmethod
    def _parameters(event: Mapping[str, Any], serialized: str) -> tuple[Any, ...]:
        return (
            event["id"],
            event["sequence"],
            event["traceId"],
            event["timestamp"],
            _timestamp_ms(event["timestamp"], "event.timestamp"),
            event["kind"],
            event["source"],
            event["status"],
            event.get("sessionId"),
            event.get("workspaceId"),
            event.get("providerId"),
            event.get("agentName"),
            event.get("toolName"),
            serialized,
        )

    @staticmethod
    def _insert_sql(replace: bool) -> str:
        values = """id, sequence, trace_id, timestamp, timestamp_ms, kind, source, status,
            session_id, workspace_id, provider_id, agent_name, tool_name, event_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"""
        if not replace:
            return f"INSERT INTO flight_events ({values} ON CONFLICT(id) DO NOTHING"
        return f"""INSERT INTO flight_events ({values}
            ON CONFLICT(id) DO UPDATE SET
                sequence=excluded.sequence, trace_id=excluded.trace_id,
                timestamp=excluded.timestamp, timestamp_ms=excluded.timestamp_ms,
                kind=excluded.kind,
                source=excluded.source, status=excluded.status,
                session_id=excluded.session_id, workspace_id=excluded.workspace_id,
                provider_id=excluded.provider_id, agent_name=excluded.agent_name,
                tool_name=excluded.tool_name, event_json=excluded.event_json"""

    def append(self, event: Mapping[str, Any]) -> None:
        validated = validate_flight_event(dict(event), "event")
        serialized = _portable_json(validated)
        with self._lock:
            db = self._ensure_db()
            db.execute(
                f"PRAGMA busy_timeout = {RUNTIME_BUSY_TIMEOUT_MS}"
            )
            try:
                db.execute(
                    self._insert_sql(False),
                    self._parameters(validated, serialized),
                )
            finally:
                db.execute(
                    f"PRAGMA busy_timeout = {BUSY_TIMEOUT_MS}"
                )

    def query(self, query: Optional[Mapping[str, Any]] = None, **filters: Any) -> list[Dict[str, Any]]:
        query_data = _normalize_flight_query(query, filters)
        with self._lock:
            return self._select_events(
                self._ensure_db(),
                query_data,
                public_query=True,
            )

    @classmethod
    def _select_events(
        cls,
        db: sqlite3.Connection,
        query_data: Mapping[str, Any],
        *,
        public_query: bool,
    ) -> list[Dict[str, Any]]:
        columns = {
            "traceId": "trace_id",
            "sessionId": "session_id",
            "workspaceId": "workspace_id",
            "source": "source",
            "providerId": "provider_id",
            "agentName": "agent_name",
            "toolName": "tool_name",
            "status": "status",
        }
        for key in columns:
            if key in query_data:
                _assert_string(query_data[key], key)
        kinds = query_data.get("kind", _MISSING)
        if kinds is not _MISSING:
            kinds = kinds if isinstance(kinds, (list, tuple)) else [kinds]
            if len(kinds) > MAX_KIND_FILTERS:
                raise ValueError(f"kind filter may contain at most {MAX_KIND_FILTERS} values.")
            for kind in kinds:
                _assert_string(kind, "kind")
            kinds = set(kinds)
        since_ms = (
            _timestamp_ms(query_data["since"], "since")
            if "since" in query_data
            else None
        )
        until_ms = (
            _timestamp_ms(query_data["until"], "until")
            if "until" in query_data
            else None
        )
        limit = query_data.get("limit", _MISSING)
        offset = query_data.get("offset", 0)
        if limit is not _MISSING:
            _assert_non_negative_integer(limit, "limit")
        _assert_non_negative_integer(offset, "offset")
        if public_query:
            limit = (
                MAX_QUERY_LIMIT
                if limit is _MISSING
                else min(limit, MAX_QUERY_LIMIT)
            )
            offset = min(offset, MAX_QUERY_OFFSET)
        order = query_data.get("order", "asc")
        if order not in {"asc", "desc"}:
            raise ValueError('order must be "asc" or "desc".')

        rows = db.execute(
            """
            SELECT rowid, id, sequence, trace_id, timestamp, timestamp_ms,
                   kind, source, status, session_id, workspace_id,
                   provider_id, agent_name, tool_name, event_json
            FROM flight_events
            """
        ).fetchall()
        validated = [
            (row, cls._row_to_event(row))
            for row in rows
        ]

        filtered: list[tuple[tuple[Any, ...], Dict[str, Any]]] = []
        for row, event in validated:
            if any(
                key in query_data
                and event.get(key) != query_data[key]
                for key in columns
            ):
                continue
            if kinds is not _MISSING and event["kind"] not in kinds:
                continue
            if since_ms is not None and row[5] < since_ms:
                continue
            if until_ms is not None and row[5] > until_ms:
                continue
            filtered.append((row, event))

        if "traceId" in query_data:
            filtered.sort(
                key=lambda item: (
                    item[1]["sequence"],
                    item[0][5],
                    item[0][0],
                ),
                reverse=order == "desc",
            )
        else:
            filtered.sort(
                key=lambda item: (
                    item[0][5],
                    item[0][0],
                ),
                reverse=order == "desc",
            )
        if limit == 0:
            return []
        end = None if limit is _MISSING else offset + limit
        return [
            event
            for _row, event in filtered[offset:end]
        ]

    @staticmethod
    def _row_to_event(row: tuple[Any, ...]) -> Dict[str, Any]:
        (
            _rowid,
            row_id,
            sequence,
            trace_id,
            timestamp,
            timestamp_ms,
            kind,
            source,
            status,
            session_id,
            workspace_id,
            provider_id,
            agent_name,
            tool_name,
            event_json,
        ) = row
        try:
            parsed = json.loads(event_json)
        except (TypeError, json.JSONDecodeError) as exc:
            raise FlightRecorderCorruptionError(
                f'Corrupt flight event row "{row_id}": event_json is not valid JSON: {exc}'
            ) from exc
        event = validate_flight_event(parsed, f'flight event row "{row_id}"')
        indexed = {
            "id": row_id,
            "sequence": sequence,
            "traceId": trace_id,
            "timestamp": timestamp,
            "kind": kind,
            "source": source,
            "status": status,
            "sessionId": session_id,
            "workspaceId": workspace_id,
            "providerId": provider_id,
            "agentName": agent_name,
            "toolName": tool_name,
        }
        mismatches = [
            key
            for key, indexed_value in indexed.items()
            if indexed_value != event.get(key)
        ]
        expected_timestamp_ms = _timestamp_ms(
            event["timestamp"], f'flight event row "{row_id}".timestamp'
        )
        if timestamp_ms != expected_timestamp_ms:
            mismatches.append("timestamp_ms does not match timestamp")
        if mismatches:
            raise FlightRecorderCorruptionError(
                f'Corrupt flight event row "{row_id}": '
                + ", ".join(f"{key} does not match event_json" for key in mismatches)
                + "."
            )
        return event

    def count(self) -> int:
        with self._lock:
            row = self._ensure_db().execute(
                "SELECT COUNT(*) FROM flight_events"
            ).fetchone()
        return int(row[0])

    def last_sequence(self, trace_id: str) -> int:
        _assert_string(trace_id, "traceId")
        with self._lock:
            row = self._ensure_db().execute(
                """
                SELECT rowid, id, sequence, trace_id, timestamp,
                       timestamp_ms, kind, source, status, session_id,
                       workspace_id, provider_id, agent_name, tool_name,
                       event_json
                FROM flight_events
                WHERE trace_id = ?
                ORDER BY sequence DESC, rowid DESC
                LIMIT 1
                """,
                (trace_id,),
            ).fetchone()
        return self._row_to_event(row)["sequence"] if row else 0

    def bind_identity_key(self, identity_key: str) -> None:
        if re.fullmatch(r"[0-9a-fA-F]{64}", identity_key) is None:
            raise ValueError(
                "Flight Recorder identity key must be 32-byte hexadecimal."
            )
        fingerprint = hashlib.sha256(
            (
                "openrappter-flight-identity/1:"
                f"{identity_key.lower()}"
            ).encode("utf-8")
        ).hexdigest()
        with self._transaction() as db:
            row = db.execute(
                "SELECT value FROM flight_metadata "
                "WHERE key = 'identity-key-fingerprint'"
            ).fetchone()
            if row is not None and row[0] != fingerprint:
                raise FlightRecorderError(
                    "Flight Recorder identity key does not match "
                    "the ledger fingerprint."
                )
            if row is None:
                db.execute(
                    "INSERT INTO flight_metadata (key, value) "
                    "VALUES ('identity-key-fingerprint', ?)",
                    (fingerprint,),
                )

    def prune(self, keep: int) -> int:
        _assert_non_negative_integer(keep, "keep")
        with self._transaction() as db:
            before = int(
                db.execute("SELECT COUNT(*) FROM flight_events").fetchone()[0]
            )
            if before <= keep:
                return 0
            rows = db.execute(
                """
                SELECT rowid, id, sequence, trace_id, timestamp,
                       timestamp_ms, kind, source, status, session_id,
                       workspace_id, provider_id, agent_name, tool_name,
                       event_json
                FROM flight_events
                ORDER BY trace_id, sequence, rowid
                """
            ).fetchall()

            traces: Dict[str, Dict[str, Any]] = {}
            for row in rows:
                event = self._row_to_event(row)
                row_id = row[0]
                timestamp = row[5]
                trace_id = event["traceId"]
                kind = event["kind"]
                trace = traces.setdefault(
                    trace_id,
                    {
                        "traceId": trace_id,
                        "rowCount": 0,
                        "lifecycle": "atomic",
                        "lifecycleDepth": 0,
                        "sawLifecycleStart": False,
                        "malformedLifecycle": False,
                        "lifecycleStarts": {},
                        "latestTimestamp": timestamp,
                        "latestRowId": row_id,
                    },
                )
                trace["rowCount"] += 1
                if kind == "trace.started":
                    trace["sawLifecycleStart"] = True
                    event_id = event["id"]
                    owner_pid = event["metadata"].get("ownerPid")
                    owner_incarnation = event["metadata"].get(
                        "ownerIncarnation"
                    )
                    if event_id is None:
                        trace["malformedLifecycle"] = True
                    else:
                        trace["lifecycleStarts"][event_id] = (
                            owner_pid,
                            owner_incarnation,
                        )
                        trace["lifecycleDepth"] = len(
                            trace["lifecycleStarts"]
                        )
                elif kind in {"trace.completed", "trace.failed"}:
                    parent_id = event.get("parentId")
                    if (
                        parent_id is not None
                        and parent_id in trace["lifecycleStarts"]
                    ):
                        trace["lifecycleStarts"].pop(parent_id)
                        trace["lifecycleDepth"] = len(
                            trace["lifecycleStarts"]
                        )
                    else:
                        trace["malformedLifecycle"] = True
                if (
                    timestamp > trace["latestTimestamp"]
                    or (
                        timestamp == trace["latestTimestamp"]
                        and row_id > trace["latestRowId"]
                    )
                ):
                    trace["latestTimestamp"] = timestamp
                    trace["latestRowId"] = row_id

            retention_traces = list(traces.values())
            for trace in retention_traces:
                if (
                    trace["lifecycleDepth"] > 0
                    and any(
                        owner_pid is not None
                        and _process_matches_incarnation(
                            owner_pid,
                            owner_incarnation,
                        )
                        for owner_pid, owner_incarnation in trace[
                            "lifecycleStarts"
                        ].values()
                    )
                ):
                    trace["lifecycle"] = "active"
                elif (
                    not trace["sawLifecycleStart"]
                    and not trace["malformedLifecycle"]
                ):
                    trace["lifecycle"] = "atomic"
                elif (
                    trace["sawLifecycleStart"]
                    and not trace["malformedLifecycle"]
                ):
                    trace["lifecycle"] = "completed"
                else:
                    trace["lifecycle"] = "malformed"
            active = [
                trace
                for trace in retention_traces
                if trace["lifecycle"] == "active"
            ]
            candidates = sorted(
                (
                    trace
                    for trace in retention_traces
                    if trace["lifecycle"] != "active"
                ),
                key=lambda trace: (
                    trace["latestTimestamp"],
                    trace["latestRowId"],
                ),
                reverse=True,
            )
            retained_trace_ids = {trace["traceId"] for trace in active}
            retained_rows = sum(trace["rowCount"] for trace in active)
            newest_completed = next(
                (
                    trace
                    for trace in candidates
                    if trace["lifecycle"] == "completed"
                ),
                None,
            ) if keep > 0 else None
            if newest_completed is not None:
                retained_trace_ids.add(newest_completed["traceId"])
                retained_rows += newest_completed["rowCount"]

            for trace in candidates:
                if trace["traceId"] in retained_trace_ids:
                    continue
                if retained_rows + trace["rowCount"] > keep:
                    break
                retained_trace_ids.add(trace["traceId"])
                retained_rows += trace["rowCount"]

            if keep > 0 and not active and not retained_trace_ids and candidates:
                retained_trace_ids.add(candidates[0]["traceId"])

            deleted = 0
            for trace in retention_traces:
                if trace["traceId"] not in retained_trace_ids:
                    cursor = db.execute(
                        "DELETE FROM flight_events WHERE trace_id = ?",
                        (trace["traceId"],),
                    )
                    deleted += cursor.rowcount
        if deleted > 0:
            self._purge_deleted_pages(vacuum=False)
        return deleted

    def prune_runtime(self, keep: int) -> int:
        with self._lock:
            db = self._ensure_db()
            db.execute(
                f"PRAGMA busy_timeout = {RUNTIME_BUSY_TIMEOUT_MS}"
            )
            try:
                return self.prune(keep)
            finally:
                db.execute(
                    f"PRAGMA busy_timeout = {BUSY_TIMEOUT_MS}"
                )

    def export(self, query: Optional[Mapping[str, Any]] = None) -> Dict[str, Any]:
        query_data = _normalize_flight_query(query)
        with self._transaction(immediate=False) as db:
            events = self._select_events(
                db,
                query_data,
                public_query=False,
            )
            return {
                "schema": FLIGHT_EXPORT_SCHEMA,
                "exportedAt": _iso_now(),
                "events": [_exportable_event(event) for event in events],
            }

    @staticmethod
    def _validate_export(data: Any) -> list[Dict[str, Any]]:
        if not isinstance(data, dict):
            raise FlightRecorderCorruptionError("Flight export must be an object.")
        unexpected = set(data) - {"schema", "exportedAt", "events"}
        if unexpected:
            raise FlightRecorderCorruptionError(
                f'flight export contains unexpected field "{sorted(unexpected)[0]}".'
            )
        if data.get("schema") != FLIGHT_EXPORT_SCHEMA:
            raise FlightRecorderCorruptionError(
                f'Flight export schema must be "{FLIGHT_EXPORT_SCHEMA}".'
            )
        _assert_iso_timestamp(data.get("exportedAt"), "flight export exportedAt")
        if not isinstance(data.get("events"), list):
            raise FlightRecorderCorruptionError("Flight export events must be an array.")
        validated = []
        event_ids: set[str] = set()
        for index, event in enumerate(data["events"]):
            metadata = event.get("metadata") if isinstance(event, dict) else None
            if isinstance(metadata, dict) and (
                "ownerPid" in metadata
                or "ownerId" in metadata
                or "ownerIncarnation" in metadata
            ):
                raise FlightRecorderCorruptionError(
                    f"flight export events[{index}] must not claim live trace ownership."
                )
            validated_event = validate_flight_event(
                    event,
                    f"flight export events[{index}]",
                )
            if validated_event["id"] in event_ids:
                raise FlightRecorderCorruptionError(
                    f'flight export contains duplicate event ID "{validated_event["id"]}".'
                )
            event_ids.add(validated_event["id"])
            validated.append(validated_event)
        return validated

    def import_(self, data: Mapping[str, Any], *, replace: bool = False) -> int:
        events = self._validate_export(data)
        with self._transaction() as db:
            existing_rows = db.execute(
                """
                SELECT rowid, id, sequence, trace_id, timestamp,
                       timestamp_ms, kind, source, status, session_id,
                       workspace_id, provider_id, agent_name, tool_name,
                       event_json
                FROM flight_events
                """
            ).fetchall()
            existing_by_id: Dict[str, Dict[str, Any]] = {}
            existing_by_trace: Dict[str, list[Dict[str, Any]]] = {}
            for row in existing_rows:
                existing = self._row_to_event(row)
                existing_by_id[existing["id"]] = existing
                existing_by_trace.setdefault(
                    existing["traceId"],
                    [],
                ).append(existing)
            live_trace_ids: set[str] = set()
            live_start_ids: set[str] = set()
            for trace_id, trace_events in existing_by_trace.items():
                unmatched: Dict[
                    str,
                    tuple[Optional[int], Optional[str]],
                ] = {}
                for existing in sorted(
                    trace_events,
                    key=lambda item: item["sequence"],
                ):
                    if existing["kind"] == "trace.started":
                        metadata = existing.get("metadata") or {}
                        owner_pid = metadata.get("ownerPid")
                        unmatched[existing["id"]] = (
                            owner_pid
                            if isinstance(owner_pid, int)
                            and not isinstance(owner_pid, bool)
                            and owner_pid > 0
                            else None,
                            metadata.get("ownerIncarnation")
                            if isinstance(
                                metadata.get("ownerIncarnation"),
                                str,
                            )
                            else None,
                        )
                    elif (
                        existing["kind"]
                        in {"trace.completed", "trace.failed"}
                        and existing.get("parentId")
                    ):
                        unmatched.pop(existing["parentId"], None)
                for start_id, owner in unmatched.items():
                    if (
                        owner[0] is not None
                        and _process_matches_incarnation(
                            owner[0],
                            owner[1],
                        )
                    ):
                        live_trace_ids.add(trace_id)
                        live_start_ids.add(start_id)
            persisted_events = []
            for event in events:
                existing = existing_by_id.get(event["id"])
                if existing is not None and not replace:
                    if (
                        _exportable_event(existing).get(
                            "contentHash"
                        )
                        != event.get("contentHash")
                    ):
                        raise FlightRecorderCorruptionError(
                            f'Flight event ID "{event["id"]}" conflicts '
                            "with existing content."
                        )
                    continue
                if existing is not None:
                    existing_trace_id = existing.get("traceId")
                    if (
                        isinstance(existing_trace_id, str)
                        and existing_trace_id != event["traceId"]
                        and existing_trace_id in live_trace_ids
                    ):
                        raise FlightRecorderCorruptionError(
                            f'Cannot move event "{event["id"]}" out of '
                            f'live trace "{existing_trace_id}".'
                        )
                if event["traceId"] in live_trace_ids:
                    exact = (
                        existing is not None
                        and _exportable_event(existing).get(
                            "contentHash"
                        )
                        == event.get("contentHash")
                    )
                    if not exact:
                        raise FlightRecorderCorruptionError(
                            f'Cannot import event "{event["id"]}" into '
                            f'live trace "{event["traceId"]}".'
                        )
                persisted = event
                if replace and existing is not None:
                        owner_pid = (existing.get("metadata") or {}).get(
                            "ownerPid"
                        )
                        owner_incarnation = (
                            existing.get("metadata") or {}
                        ).get("ownerIncarnation")
                        if (
                            existing.get("kind") == "trace.started"
                            and isinstance(owner_pid, int)
                            and not isinstance(owner_pid, bool)
                            and owner_pid > 0
                            and _process_matches_incarnation(
                                owner_pid,
                                (
                                    owner_incarnation
                                    if isinstance(
                                        owner_incarnation,
                                        str,
                                    )
                                    else None
                                ),
                            )
                            and existing.get("id") in live_start_ids
                        ):
                            if (
                                event["kind"] != "trace.started"
                                or event["traceId"] != existing.get("traceId")
                                or event["sequence"]
                                != existing.get("sequence")
                                or _exportable_event(existing).get(
                                    "contentHash"
                                )
                                != event.get("contentHash")
                            ):
                                raise FlightRecorderCorruptionError(
                                    f'Cannot replace live trace start "{event["id"]}" '
                                    "with different portable content."
                                )
                            persisted = dict(event)
                            metadata = dict(event.get("metadata") or {})
                            metadata["ownerPid"] = owner_pid
                            if isinstance(owner_incarnation, str):
                                metadata["ownerIncarnation"] = (
                                    owner_incarnation
                                )
                            if "ownerId" in (existing.get("metadata") or {}):
                                metadata["ownerId"] = existing["metadata"][
                                    "ownerId"
                                ]
                            persisted["metadata"] = metadata
                            persisted["contentHash"] = (
                                compute_flight_event_hash(persisted)
                            )
                persisted_events.append(persisted)
            if replace:
                for event in persisted_events:
                    db.execute(
                        "DELETE FROM flight_events WHERE id = ?",
                        (event["id"],),
                    )
            imported = 0
            sql = self._insert_sql(False)
            for event in persisted_events:
                cursor = db.execute(
                    sql,
                    self._parameters(event, _portable_json(event)),
                )
                imported += cursor.rowcount
        if replace and imported > 0:
            self._purge_deleted_pages(vacuum=False)
        return imported

    import_bundle = import_
    import_data = import_

    def clear(self) -> None:
        with self._transaction() as db:
            rows = db.execute(
                """
                SELECT rowid, id, sequence, trace_id, timestamp,
                       timestamp_ms, kind, source, status, session_id,
                       workspace_id, provider_id, agent_name, tool_name,
                       event_json
                FROM flight_events
                ORDER BY trace_id, sequence, rowid
                """
            ).fetchall()
            owners: Dict[
                str,
                Dict[str, tuple[Optional[int], Optional[str]]],
            ] = {}
            for row in rows:
                event = self._row_to_event(row)
                trace_id = event["traceId"]
                kind = event["kind"]
                if kind not in {
                    "trace.started",
                    "trace.completed",
                    "trace.failed",
                }:
                    continue
                starts = owners.setdefault(trace_id, {})
                if kind == "trace.started":
                    event_id = event["id"]
                    owner_pid = event["metadata"].get("ownerPid")
                    owner_incarnation = event["metadata"].get(
                        "ownerIncarnation"
                    )
                    if event_id is not None:
                        starts[event_id] = (
                            owner_pid,
                            owner_incarnation,
                        )
                else:
                    parent_id = event.get("parentId")
                    if parent_id is not None:
                        starts.pop(parent_id, None)
            if any(
                any(
                    owner_pid is not None
                    and _process_matches_incarnation(
                        owner_pid,
                        owner_incarnation,
                    )
                    for owner_pid, owner_incarnation in starts.values()
                )
                for starts in owners.values()
            ):
                raise FlightRecorderError(
                    "Flight ledger cannot clear while active traces exist."
                )
            db.execute("DELETE FROM flight_events")
        self._purge_deleted_pages(vacuum=True)

    def release_event_ownership(self, event_id: str) -> None:
        with self._lock:
            db = self._ensure_db()
            db.execute(
                f"PRAGMA busy_timeout = {RUNTIME_BUSY_TIMEOUT_MS}"
            )
            try:
                db.execute("BEGIN IMMEDIATE")
                try:
                    row = db.execute(
                        """
                        SELECT rowid, id, sequence, trace_id, timestamp,
                               timestamp_ms, kind, source, status,
                               session_id, workspace_id, provider_id,
                               agent_name, tool_name, event_json
                        FROM flight_events
                        WHERE id = ?
                        """,
                        (event_id,),
                    ).fetchone()
                    if row is not None:
                        event = self._row_to_event(row)
                        metadata = dict(event.get("metadata") or {})
                        if (
                            "ownerPid" in metadata
                            or "ownerId" in metadata
                            or "ownerIncarnation" in metadata
                        ):
                            metadata.pop("ownerPid", None)
                            metadata.pop("ownerId", None)
                            metadata.pop("ownerIncarnation", None)
                            event["metadata"] = metadata
                            event["contentHash"] = (
                                compute_flight_event_hash(event)
                            )
                            db.execute(
                                "UPDATE flight_events "
                                "SET event_json = ? WHERE id = ?",
                                (_portable_json(event), event_id),
                            )
                    db.execute("COMMIT")
                except Exception:
                    db.execute("ROLLBACK")
                    raise
            finally:
                db.execute(
                    f"PRAGMA busy_timeout = {BUSY_TIMEOUT_MS}"
                )

    def _purge_deleted_pages(self, *, vacuum: bool) -> None:
        with self._lock:
            db = self._ensure_db()
            self._checkpoint_wal(db)
            if vacuum:
                db.execute("VACUUM")
                self._checkpoint_wal(db)

    @staticmethod
    def _checkpoint_wal(db: sqlite3.Connection) -> None:
        for attempt in range(MAX_BUSY_RETRIES + 1):
            row = db.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchone()
            if row is not None and int(row[0]) == 0:
                return
            if attempt < MAX_BUSY_RETRIES:
                time.sleep(0.025 * (attempt + 1))
        raise FlightRecorderError(
            "WAL checkpoint did not complete; deleted data may remain."
        )

    @contextmanager
    def _transaction(
        self,
        *,
        immediate: bool = True,
    ) -> Iterator[sqlite3.Connection]:
        with self._lock:
            db = self._ensure_db()
            db.execute("BEGIN IMMEDIATE" if immediate else "BEGIN")
            try:
                yield db
            except Exception:
                db.execute("ROLLBACK")
                raise
            else:
                db.execute("COMMIT")


class FlightRecorder:
    """Fail-open runtime facade around a Flight Recorder ledger."""

    def __init__(
        self,
        options: Optional[Mapping[str, Any]] = None,
        ledger: Optional[Any] = None,
        *,
        enabled: Optional[bool] = None,
        database_path: Optional[str | os.PathLike[str]] = None,
        in_memory: Optional[bool] = None,
        privacy: Optional[Mapping[str, Any]] = None,
        retention_events: Optional[int] = None,
        identity_key: Optional[str] = None,
    ) -> None:
        options = dict(options or {})
        self.enabled = bool(
            enabled if enabled is not None else options.get("enabled", True)
        )
        configured_database_path = (
            database_path
            if database_path is not None
            else options.get("databasePath", options.get("database_path"))
        )
        self._manages_database_parent = configured_database_path is None
        self.database_path = str(
            configured_database_path
            if configured_database_path is not None
            # `OPENRAPPTER_HOME` moves the whole installation, and the ledger
            # has to move with it: `typescript/src/flight-recorder/recorder.ts`
            # resolves this same file the same way, so a runtime that ignored
            # the variable would write to a different ledger than its twin.
            else Path(
                os.environ.get("OPENRAPPTER_HOME", Path.home() / ".openrappter")
            ) / "flight-recorder.db"
        )
        self.in_memory = bool(
            in_memory
            if in_memory is not None
            else options.get("inMemory", options.get("in_memory", False))
        )
        self.privacy = dict(
            privacy if privacy is not None else options.get("privacy", {})
        )
        self.retention_events = (
            retention_events
            if retention_events is not None
            else options.get(
                "retentionEvents",
                options.get("retention_events", DEFAULT_RETENTION_EVENTS),
            )
        )
        self._ledger = ledger
        self._identity_key = (
            identity_key
            if identity_key is not None
            else options.get("identityKey", options.get("identity_key"))
        )
        self._initialized = False
        self._error_count = 0
        self._last_error: Optional[str] = None
        self._initialization_error: Optional[str] = None
        self._trace_context: contextvars.ContextVar[Optional[Dict[str, Any]]] = (
            contextvars.ContextVar("openrappter_flight_trace", default=None)
        )
        self._sequence_by_trace: Dict[str, int] = {}
        self._sequence_lock = threading.RLock()
        self._sequence_in_flight: set[str] = set()
        self._initialization_condition = threading.Condition(threading.RLock())
        self._initializing = False
        self._next_initialization_attempt_at = 0.0
        self._initialization_waiters = 0
        self._closing = False
        self._clearing = False
        self._last_clear_result = True
        self._last_clear_error: Optional[BaseException] = None
        self._active_trace_operations = 0
        self._closed = False
        self._owner_id = str(uuid.uuid4())
        self._owner_path: Optional[Path] = None
        self._retained_event_count = 0
        self._next_retention_check_count = 0
        _RECORDER_INSTANCES.add(self)

    def _note_error(self, error: BaseException) -> None:
        self._error_count += 1
        try:
            error_name = error.__class__.__name__
        except Exception:
            error_name = "UnknownError"
        try:
            message = str(error)
        except Exception:
            message = "[unavailable]"
        self._last_error = f"{error_name}: {message}"

    def initialize(self) -> None:
        if (
            not self.enabled
            or self._closed
            or self._closing
            or time.monotonic() < self._next_initialization_attempt_at
        ):
            return
        with self._initialization_condition:
            while self._initializing or self._closing:
                self._initialization_waiters += 1
                try:
                    self._initialization_condition.wait()
                finally:
                    self._initialization_waiters -= 1
            if time.monotonic() < self._next_initialization_attempt_at:
                return
            if self._closed or self._closing or self._initialized:
                return
            self._initializing = True
        try:
            creates_ledger = self._ledger is None
            if self._ledger is None:
                if not self.in_memory:
                    directory = Path(self.database_path).expanduser().parent
                    if self._manages_database_parent:
                        _prepare_managed_database_directory(directory)
                    else:
                        directory.mkdir(
                            parents=True,
                            exist_ok=True,
                            mode=0o700,
                        )
                        _assert_private_directory(directory)
                    self._owner_path = _register_recorder_owner(
                        self.database_path,
                        self._owner_id,
                    )
                self._ledger = SQLiteFlightLedger(
                    database_path=str(Path(self.database_path).expanduser()),
                    in_memory=self.in_memory,
                )
            if self.in_memory or not creates_ledger:
                self._identity_key = (
                    self._identity_key
                    or os.urandom(32).hex()
                )
            self._ledger.initialize()
            if self._closed:
                self._ledger.close()
                return
            self._retained_event_count = self._ledger.count()
            if not self.in_memory and creates_ledger:
                self._identity_key = _load_or_create_identity_key(
                    self.database_path,
                    self._identity_key,
                    self._retained_event_count == 0,
                )
            if (
                not self._identity_key
                or re.fullmatch(
                    r"[0-9a-fA-F]{64}",
                    self._identity_key,
                )
                is None
            ):
                raise ValueError(
                    "Flight Recorder identity key must be 32-byte hexadecimal."
                )
            bind_identity_key = getattr(
                self._ledger,
                "bind_identity_key",
                None,
            )
            if callable(bind_identity_key):
                bind_identity_key(self._identity_key)
            redacted_values = list(
                _privacy_value(
                    self.privacy,
                    "redactedValues",
                    "redacted_values",
                    default=(),
                )
                or ()
            )
            if self._identity_key not in redacted_values:
                redacted_values.append(self._identity_key)
            self.privacy["redactedValues"] = redacted_values
            self._next_retention_check_count = self.retention_events + 1
            if not self.in_memory and creates_ledger:
                database = Path(self.database_path).expanduser()
                if database.exists():
                    _harden_private_path(database)
            self._initialized = True
            self._next_initialization_attempt_at = 0.0
            self._last_error = None
            self._initialization_error = None
        except Exception as exc:
            if creates_ledger and self._ledger is not None:
                try:
                    self._ledger.close()
                except Exception:
                    pass
                self._ledger = None
            _unregister_recorder_owner(self._owner_path)
            self._owner_path = None
            self._initialized = False
            self._note_error(exc)
            self._next_initialization_attempt_at = time.monotonic() + 1.0
            self._initialization_error = self._last_error
        finally:
            with self._initialization_condition:
                self._initializing = False
                self._initialization_condition.notify_all()

    def close(self) -> None:
        if self.current_trace():
            raise FlightRecorderError(
                "Flight Recorder cannot close from inside an active trace."
            )
        try:
            asyncio.get_running_loop()
            running_loop = True
        except RuntimeError:
            running_loop = False
        if running_loop:
            raise FlightRecorderError(
                "Flight Recorder close would block the active "
                "event loop; use 'await recorder.aclose()'."
            )
        with self._initialization_condition:
            if self._closing:
                while self._closing:
                    self._initialization_waiters += 1
                    try:
                        self._initialization_condition.wait()
                    finally:
                        self._initialization_waiters -= 1
                return
            if self._closed:
                return
            self._closing = True
            while (
                self._initializing
                or self._active_trace_operations > 0
                or self._clearing
            ):
                self._initialization_waiters += 1
                try:
                    self._initialization_condition.wait()
                finally:
                    self._initialization_waiters -= 1
            self._closed = True
        try:
            with self._sequence_lock:
                if self._ledger is not None:
                    self._ledger.close()
                self._sequence_by_trace.clear()
                self._sequence_in_flight.clear()
                self._retained_event_count = 0
                self._next_retention_check_count = 0
                _unregister_recorder_owner(self._owner_path)
                self._owner_path = None
        except Exception as exc:
            self._note_error(exc)
        finally:
            with self._initialization_condition:
                self._initialized = False
                self._initializing = False
                self._closing = False
                self._initialization_condition.notify_all()

    async def aclose(self) -> None:
        if self.current_trace():
            raise FlightRecorderError(
                "Flight Recorder cannot close from inside an active trace."
            )
        await asyncio.to_thread(self.close)

    def current_trace(self) -> Optional[Dict[str, Any]]:
        context = self._current_trace_state()
        if not context:
            return None
        return {
            key: value
            for key, value in context.items()
            if key != "_generation"
        }

    def _current_trace_state(self) -> Optional[Dict[str, Any]]:
        context = self._trace_context.get()
        if not context:
            return None
        generation = context.get("_generation")
        if isinstance(generation, dict) and not generation.get(
            "active",
            False,
        ):
            return None
        return context

    def _raise_unhealthy_inspection(self) -> None:
        if not self.enabled:
            raise FlightRecorderUnhealthyError("Flight Recorder is disabled.")
        if self._closed:
            raise FlightRecorderUnhealthyError("Flight Recorder is closed.")
        if self.enabled and self._initialization_error is not None:
            raise FlightRecorderUnhealthyError(
                f"Flight Recorder is unhealthy: {self._initialization_error}"
            )
        if not self._initialized or self._ledger is None:
            raise FlightRecorderUnhealthyError(
                "Flight Recorder is unavailable."
            )

    def with_parent(self, parent_id: Optional[str], operation: Callable[[], Any]) -> Any:
        current = self._current_trace_state()
        if current is None:
            return operation()
        parent_context = {
            **current,
            "parentId": parent_id,
        }
        token = self._trace_context.set(parent_context)
        try:
            result = operation()
        except BaseException:
            self._trace_context.reset(token)
            raise
        if inspect.isawaitable(result):
            self._trace_context.reset(token)

            async def await_result():
                async_token = self._trace_context.set(parent_context)
                try:
                    return await result
                finally:
                    self._trace_context.reset(async_token)

            return await_result()
        self._trace_context.reset(token)
        return result

    @contextmanager
    def trace(self, context: Optional[Mapping[str, Any]] = None) -> Iterator[Dict[str, Any]]:
        context = dict(context or {})
        inherited = self.current_trace()
        trace_id = _private_identifier(
            context.get("traceId")
            or (inherited or {}).get("traceId")
            or str(uuid.uuid4()),
            self.privacy,
            "trace",
            "traceId",
        )
        trace_context = {
            "traceId": trace_id,
            "parentId": context.get(
                "parentId", (inherited or {}).get("parentId")
            ),
        }
        generation = {"active": True}
        trace_context["_generation"] = generation
        for key in ("sessionId", "workspaceId"):
            value = context.get(key, (inherited or {}).get(key))
            if value is not None:
                if key == "workspaceId":
                    value = normalize_flight_workspace_id(
                        _private_identifier(
                            value,
                            self.privacy,
                            "workspace",
                            "workspaceId",
                        )
                    )
                trace_context[key] = value
        token = self._trace_context.set(trace_context)
        try:
            yield {
                key: value
                for key, value in trace_context.items()
                if key != "_generation"
            }
        finally:
            generation["active"] = False
            self._trace_context.reset(token)

    def run_trace(
        self,
        context: Optional[Mapping[str, Any]],
        operation: Callable[[], Any],
    ) -> Any:
        inherited = self.current_trace()
        context_data = dict(context or {})
        inherited_trace_id = (inherited or {}).get("traceId")
        trace_id = (
            inherited_trace_id
            if inherited_trace_id is not None
            else _private_identifier(
                context_data.get("traceId")
                or str(uuid.uuid4()),
                self.privacy,
                "trace",
                "traceId",
            )
        )
        generation = {"active": True}
        trace_state: Dict[str, Any] = {
            "traceId": trace_id,
            "parentId": context_data.get(
                "parentId",
                (inherited or {}).get("parentId"),
            ),
            "_generation": generation,
        }
        session_id = context_data.get(
            "sessionId",
            (inherited or {}).get("sessionId"),
        )
        if session_id is not None:
            if not isinstance(session_id, str):
                session_id = str(session_id)
            trace_state["sessionId"] = (
                normalize_flight_session_id(
                    session_id,
                    self._identity_key,
                    _privacy_value(
                        self.privacy,
                        "redactedValues",
                        "redacted_values",
                        default=(),
                    )
                    or (),
                )
                if self._identity_key
                else session_id
            )
        workspace_id = context_data.get(
            "workspaceId",
            (inherited or {}).get("workspaceId"),
        )
        if workspace_id is not None:
            trace_state["workspaceId"] = normalize_flight_workspace_id(
                _private_identifier(
                    workspace_id,
                    self.privacy,
                    "workspace",
                    "workspaceId",
                )
            )

        with self._initialization_condition:
            if (
                not inherited
                and (self._closed or self._closing or self._clearing)
            ):
                return operation()
            self._active_trace_operations += 1

        finished = False

        def finish_trace() -> None:
            nonlocal finished
            if finished:
                return
            finished = True
            generation["active"] = False
            with self._sequence_lock:
                self._sequence_by_trace.pop(trace_id, None)
            with self._initialization_condition:
                self._active_trace_operations -= 1
                self._initialization_condition.notify_all()

        started = time.monotonic()
        root_token = self._trace_context.set(trace_state)
        try:
            root = self.record(
                {
                    "kind": "trace.started",
                    "source": "runtime",
                    "status": "started",
                    "metadata": {"nested": bool(inherited)},
                }
            )
        finally:
            self._trace_context.reset(root_token)
        operation_state = {
            **trace_state,
            "parentId": root.get("id") if root is not None else None,
        }

        def record_failure(exc: BaseException) -> None:
            if root is None:
                return
            terminal = self.record(
                {
                    "kind": "trace.failed",
                    "source": "runtime",
                    "status": "error",
                    "durationMs": (
                        time.monotonic() - started
                    )
                    * 1000,
                    "metadata": summarize_flight_error(exc),
                    "payload": {"error": exc},
                }
            )
            if terminal is None:
                self._release_start_ownership(root["id"])

        def record_success() -> None:
            if root is None:
                return
            terminal = self.record(
                {
                    "kind": "trace.completed",
                    "source": "runtime",
                    "status": "success",
                    "durationMs": (
                        time.monotonic() - started
                    )
                    * 1000,
                }
            )
            if terminal is None:
                self._release_start_ownership(root["id"])

        operation_token = self._trace_context.set(operation_state)
        try:
            try:
                result = operation()
            except BaseException as exc:
                record_failure(exc)
                raise
        except BaseException:
            finish_trace()
            raise
        finally:
            self._trace_context.reset(operation_token)

        if inspect.isawaitable(result):
            async def await_result():
                token = self._trace_context.set(operation_state)
                try:
                    try:
                        value = await result
                    except BaseException as exc:
                        record_failure(exc)
                        raise
                    record_success()
                    return value
                finally:
                    self._trace_context.reset(token)
                    finish_trace()

            return await_result()

        token = self._trace_context.set(operation_state)
        try:
            record_success()
            return result
        finally:
            self._trace_context.reset(token)
            finish_trace()

    def _last_sequence(self, trace_id: str) -> int:
        latest_sequence = getattr(
            self._ledger,
            "last_sequence",
            None,
        )
        if callable(latest_sequence):
            return int(latest_sequence(trace_id))
        latest = self._ledger.query(
            {"traceId": trace_id, "order": "desc", "limit": 1}
        )
        return latest[0]["sequence"] if latest else 0

    def _release_start_ownership(self, event_id: str) -> None:
        try:
            release = getattr(
                self._ledger,
                "release_event_ownership",
                None,
            )
            if callable(release):
                release(event_id)
        except Exception as exc:
            self._note_error(exc)

    def _enforce_retention(self, force: bool = False) -> None:
        high_water = self.retention_events
        if (
            high_water < 0
            or self._retained_event_count <= high_water
            or (
                not force
                and self._retained_event_count < self._next_retention_check_count
            )
        ):
            return
        batch = max(1, math.ceil(high_water * 0.1))
        target = max(0, high_water - batch) if high_water > 100 else high_water
        prune_runtime = getattr(
            self._ledger,
            "prune_runtime",
            None,
        )
        deleted = (
            prune_runtime(target)
            if callable(prune_runtime)
            else self._ledger.prune(target)
        )
        self._retained_event_count = max(
            0, self._retained_event_count - deleted
        )
        self._next_retention_check_count = (
            self._retained_event_count + batch
            if self._retained_event_count > high_water
            else high_water + 1
        )

    def record(
        self,
        event_input: Optional[Mapping[str, Any]] = None,
        **kwargs: Any,
    ) -> Optional[Dict[str, Any]]:
        if (
            not self.enabled
            or self._closed
            or (
                (self._closing or self._clearing)
                and not self.current_trace()
            )
        ):
            return None
        if not self._initialized or self._ledger is None:
            self.initialize()
            if not self._initialized or self._ledger is None:
                return None
        data = dict(event_input or {})
        data.update(kwargs)
        aliases = {
            "trace_id": "traceId",
            "parent_id": "parentId",
            "session_id": "sessionId",
            "workspace_id": "workspaceId",
            "provider_id": "providerId",
            "agent_name": "agentName",
            "tool_name": "toolName",
            "duration_ms": "durationMs",
        }
        for old, new in aliases.items():
            if old in data and new not in data:
                data[new] = data.pop(old)
        context = self.current_trace() or {}
        trace_id = _private_identifier(
            data.get("traceId")
            or context.get("traceId")
            or str(uuid.uuid4()),
            self.privacy,
            "trace",
            "traceId",
        )
        try:
            with self._sequence_lock:
                if self._clearing and not context:
                    return None
                self._sequence_in_flight.add(trace_id)
                try:
                    conflict_attempt = 0
                    busy_attempt = 0
                    while not self._closed:
                        previous = self._sequence_by_trace.get(trace_id)
                        if previous is None:
                            previous = self._last_sequence(trace_id)
                        sequence = previous + 1
                        event: Dict[str, Any] = {
                            "schema": FLIGHT_EVENT_SCHEMA,
                            "id": _private_identifier(
                                str(uuid.uuid4()),
                                self.privacy,
                                "event",
                                "id",
                            ),
                            "sequence": sequence,
                            "traceId": trace_id,
                            "parentId": _private_identifier(
                                data.get(
                                    "parentId",
                                    context.get("parentId"),
                                ),
                                self.privacy,
                                "event",
                                "parentId",
                            ),
                            "kind": _private_identifier(
                                data["kind"],
                                self.privacy,
                                "kind",
                                "kind",
                            ),
                            "source": _private_identifier(
                                data["source"],
                                self.privacy,
                                "source",
                                "source",
                            ),
                            "status": data.get("status", "info"),
                            "timestamp": data.get("timestamp", _iso_now()),
                            "metadata": sanitize_flight_metadata(
                                data.get("metadata"), self.privacy
                            ),
                        }
                        event["metadata"].pop("ownerPid", None)
                        event["metadata"].pop("ownerId", None)
                        event["metadata"].pop("ownerIncarnation", None)
                        if (
                            data["kind"] == "trace.started"
                            and data["source"] == "runtime"
                        ):
                            event["metadata"]["ownerPid"] = os.getpid()
                            incarnation = _current_process_incarnation()
                            if incarnation:
                                event["metadata"][
                                    "ownerIncarnation"
                                ] = incarnation
                        for key in (
                            "sessionId",
                            "workspaceId",
                            "providerId",
                            "model",
                            "agentName",
                            "toolName",
                            "durationMs",
                        ):
                            value = data.get(key, context.get(key))
                            if key == "model":
                                value = (
                                    normalize_flight_model_id(value)
                                    if sanitize_flight_metadata(
                                        {"model": value},
                                        self.privacy,
                                    ).get("model")
                                    == value
                                    and sanitize_flight_value(
                                        value, self.privacy
                                    ) == value
                                    else None
                                )
                            if value is not None:
                                if key == "sessionId":
                                    value = normalize_flight_session_id(
                                        value,
                                        self._identity_key,
                                        _privacy_value(
                                            self.privacy,
                                            "redactedValues",
                                            "redacted_values",
                                            default=(),
                                        )
                                        or (),
                                    )
                                elif key == "workspaceId":
                                    value = normalize_flight_workspace_id(
                                        _private_identifier(
                                            value,
                                            self.privacy,
                                            "workspace",
                                            "workspaceId",
                                        )
                                    )
                                elif key in {
                                    "providerId",
                                    "agentName",
                                    "toolName",
                                }:
                                    value = _private_identifier(
                                        value,
                                        self.privacy,
                                        {
                                            "providerId": "provider",
                                            "agentName": "agent",
                                            "toolName": "tool",
                                        }[key],
                                        key,
                                    )
                                event[key] = value
                        if _privacy_value(
                            self.privacy, "recordIO", "record_io", default=False
                        ) is True:
                            event["payload"] = sanitize_flight_payload(
                                data.get("payload"), self.privacy
                            )
                        event["contentHash"] = compute_flight_event_hash(event)
                        try:
                            self._ledger.append(event)
                        except sqlite3.IntegrityError as exc:
                            if "trace_id, flight_events.sequence" not in str(exc):
                                raise
                            self._sequence_by_trace.pop(trace_id, None)
                            conflict_attempt += 1
                            time.sleep(min(conflict_attempt / 1000, 0.01))
                            continue
                        except sqlite3.OperationalError as exc:
                            if (
                                busy_attempt >= RUNTIME_BUSY_RETRIES
                                or not re.search(
                                    r"(?:locked|busy)",
                                    str(exc),
                                    re.I,
                                )
                            ):
                                raise
                            busy_attempt += 1
                            time.sleep(
                                min(busy_attempt / 500, 0.025)
                            )
                            continue
                        self._sequence_by_trace[trace_id] = sequence
                        try:
                            self._retained_event_count = self._ledger.count()
                            self._enforce_retention(
                                data["kind"] in {"trace.completed", "trace.failed"}
                            )
                        except Exception as exc:
                            # The append is already durable; preserve its ID and
                            # sequence while surfacing maintenance health.
                            self._note_error(exc)
                        return event
                finally:
                    self._sequence_in_flight.discard(trace_id)
                    if not context or context.get("traceId") != trace_id:
                        self._sequence_by_trace.pop(trace_id, None)
        except Exception as exc:
            self._note_error(exc)
            return None
        return None

    def query(self, query: Optional[Mapping[str, Any]] = None, **filters: Any) -> list[Dict[str, Any]]:
        if not self._initialized or self._ledger is None:
            self._raise_unhealthy_inspection()
            return []
        try:
            normalized_query = _normalize_flight_query(
                query,
                filters,
                self._identity_key,
                self.privacy,
            )
            return self._ledger.query(normalized_query)
        except Exception as exc:
            self._note_error(exc)
            raise

    def count(self) -> int:
        if not self.enabled or self._closed:
            self._raise_unhealthy_inspection()
        if not self._initialized or self._ledger is None:
            self._raise_unhealthy_inspection()
        try:
            return self._ledger.count()
        except Exception as exc:
            self._note_error(exc)
            raise

    def prune(self, keep: int) -> int:
        if not self.enabled or self._closed:
            self._raise_unhealthy_inspection()
        if not self._initialized or self._ledger is None:
            self._raise_unhealthy_inspection()
        try:
            with self._sequence_lock:
                deleted = self._ledger.prune(keep)
                self._retained_event_count = max(
                    0, self._retained_event_count - deleted
                )
                return deleted
        except Exception as exc:
            self._note_error(exc)
            raise

    def export(self, query: Optional[Mapping[str, Any]] = None) -> Optional[Dict[str, Any]]:
        if not self._initialized or self._ledger is None:
            self._raise_unhealthy_inspection()
            return None
        try:
            normalized_query = _normalize_flight_query(
                query,
                identity_key=self._identity_key,
                privacy=self.privacy,
            )
            return self._ledger.export(normalized_query)
        except Exception as exc:
            self._note_error(exc)
            raise

    def export_trace(self, trace_id: str) -> Optional[Dict[str, Any]]:
        return self.export({"traceId": trace_id})

    def import_(self, data: Mapping[str, Any], *, replace: bool = False) -> int:
        if not self._initialized or self._ledger is None:
            self._raise_unhealthy_inspection()
            return 0
        try:
            with self._sequence_lock:
                if self._closing or self._closed:
                    raise FlightRecorderError(
                        "Flight Recorder close is in progress."
                    )
                if self._clearing and not self.current_trace():
                    raise FlightRecorderError(
                        "Flight Recorder clear is in progress."
                    )
                for event in data.get("events", []):
                    for key, prefix in (
                        ("id", "event"),
                        ("kind", "kind"),
                        ("source", "source"),
                        ("traceId", "trace"),
                        ("parentId", "event"),
                        ("providerId", "provider"),
                        ("agentName", "agent"),
                        ("toolName", "tool"),
                    ):
                        value = event.get(key)
                        if (
                            isinstance(value, str)
                            and _private_identifier(
                                value,
                                self.privacy,
                                prefix,
                                key,
                            )
                            != value
                        ):
                            raise FlightRecorderCorruptionError(
                                f"Flight Recorder import {key} violates active privacy policy."
                            )
                    session_id = event.get("sessionId")
                    if (
                        isinstance(session_id, str)
                        and normalize_flight_session_id(
                            session_id,
                            self._identity_key,
                            _privacy_value(
                                self.privacy,
                                "redactedValues",
                                "redacted_values",
                                default=(),
                            )
                            or (),
                        )
                        != session_id
                    ):
                        raise FlightRecorderCorruptionError(
                            "Flight Recorder import sessionId violates "
                            "active privacy policy."
                        )
                    workspace_id = event.get("workspaceId")
                    if (
                        isinstance(workspace_id, str)
                        and normalize_flight_workspace_id(
                            _private_identifier(
                                workspace_id,
                                self.privacy,
                                "workspace",
                                "workspaceId",
                            )
                        )
                        != workspace_id
                    ):
                        raise FlightRecorderCorruptionError(
                            "Flight Recorder import workspaceId violates active privacy policy."
                        )
                    model = event.get("model")
                    if (
                        isinstance(model, str)
                        and (
                            sanitize_flight_metadata(
                                {"model": model},
                                self.privacy,
                            ).get("model")
                            != model
                            or sanitize_flight_value(
                                model,
                                self.privacy,
                            )
                            != model
                        )
                    ):
                        raise FlightRecorderCorruptionError(
                            "Flight Recorder import model violates active privacy policy."
                        )
                    if (
                        sanitize_flight_metadata(
                            event.get("metadata"),
                            self.privacy,
                        )
                        != event.get("metadata")
                    ):
                        raise FlightRecorderCorruptionError(
                            "Flight Recorder import metadata violates active privacy policy."
                        )
                    if "payload" in event:
                        if (
                            _privacy_value(
                                self.privacy,
                                "recordIO",
                                "record_io",
                                default=False,
                            )
                            is not True
                        ):
                            raise FlightRecorderCorruptionError(
                                "Flight Recorder import contains payload IO while recordIO is disabled."
                            )
                        payload_privacy = {
                            **self.privacy,
                            "recordIO": True,
                        }
                        if (
                            sanitize_flight_payload(
                                event["payload"],
                                payload_privacy,
                            )
                            != event["payload"]
                        ):
                            raise FlightRecorderCorruptionError(
                                "Flight Recorder import payload violates active privacy policy."
                            )
                imported = self._ledger.import_(data, replace=replace)
                self._sequence_by_trace.clear()
                self._retained_event_count = self._ledger.count()
                self._next_retention_check_count = self.retention_events + 1
                return imported
        except Exception as exc:
            self._note_error(exc)
            raise

    import_bundle = import_
    import_data = import_

    def clear(self) -> bool:
        if not self._initialized or self._ledger is None:
            self._raise_unhealthy_inspection()
            return False
        if self.current_trace():
            raise FlightRecorderError(
                "Flight Recorder cannot clear from inside an active trace."
            )
        try:
            asyncio.get_running_loop()
            running_loop = True
        except RuntimeError:
            running_loop = False
        if running_loop:
            raise FlightRecorderError(
                "Flight Recorder clear would block the active "
                "event loop; use 'await recorder.aclear()'."
            )
        with self._initialization_condition:
            if self._closing or self._closed:
                raise FlightRecorderError(
                    "Flight Recorder close is in progress."
                )
            if self._clearing:
                while self._clearing:
                    self._initialization_waiters += 1
                    try:
                        self._initialization_condition.wait()
                    finally:
                        self._initialization_waiters -= 1
                if self._last_clear_error is not None:
                    raise self._last_clear_error
                return self._last_clear_result
            self._clearing = True
            self._last_clear_error = None
            while self._active_trace_operations > 0:
                self._initialization_waiters += 1
                try:
                    self._initialization_condition.wait()
                finally:
                    self._initialization_waiters -= 1
        try:
            with self._sequence_lock:
                self._ledger.clear()
                self._sequence_by_trace.clear()
                self._retained_event_count = 0
                self._next_retention_check_count = self.retention_events + 1
                self._last_clear_result = True
                return True
        except Exception as exc:
            self._note_error(exc)
            self._last_clear_error = exc
            raise
        finally:
            with self._initialization_condition:
                self._clearing = False
                self._initialization_condition.notify_all()

    async def aclear(self) -> bool:
        if self.current_trace():
            raise FlightRecorderError(
                "Flight Recorder cannot clear from inside an active trace."
            )
        return await asyncio.to_thread(self.clear)

    def health(self) -> Dict[str, Any]:
        event_count = 0
        if self.enabled and self._initialized and not self._closed:
            try:
                event_count = self.count()
            except Exception as exc:
                self._note_error(exc)
        health = {
            "enabled": self.enabled,
            "initialized": self._initialized,
            "eventCount": event_count,
            "errorCount": self._error_count,
            "databasePath": ":memory:" if self.in_memory else self.database_path,
        }
        if self._last_error is not None:
            health["lastError"] = self._last_error
        return health

    def _mark_forked_child(self) -> None:
        self._owner_path = None
        self._ledger = None
        self._initialized = False
        self._closed = True
        self._closing = False
        self._clearing = False
        self._sequence_by_trace = {}
        self._sequence_in_flight = set()
        self._sequence_lock = threading.RLock()
        self._initialization_condition = threading.Condition(
            threading.RLock()
        )
        self._trace_context = contextvars.ContextVar(
            "openrappter_flight_trace",
            default=None,
        )


_global_lock = threading.RLock()
_global_recorder = FlightRecorder(enabled=False)
_environment_configured = False
_explicit_global = False


def _reset_flight_recorder_after_fork() -> None:
    global _global_lock, _global_recorder
    global _environment_configured, _explicit_global
    _PROCESS_OWNER_PATHS.clear()
    for recorder in list(_RECORDER_INSTANCES):
        recorder._mark_forked_child()
    _global_recorder = FlightRecorder(enabled=False)
    _global_lock = threading.RLock()
    _environment_configured = False
    _explicit_global = False


if hasattr(os, "register_at_fork"):
    os.register_at_fork(after_in_child=_reset_flight_recorder_after_fork)


def get_flight_recorder() -> FlightRecorder:
    return _global_recorder


def set_flight_recorder(recorder: FlightRecorder) -> FlightRecorder:
    global _global_recorder, _explicit_global
    with _global_lock:
        previous = _global_recorder
        _global_recorder = recorder
        _explicit_global = True
        return previous


def ensure_flight_recorder_from_env(
    env: Optional[Mapping[str, str]] = None,
) -> FlightRecorder:
    global _global_recorder, _environment_configured
    with _global_lock:
        if _explicit_global or _environment_configured:
            return _global_recorder
        source = os.environ if env is None else env
        configured = source.get("OPENRAPPTER_FLIGHT_RECORDER")
        under_pytest = "pytest" in sys.modules or "PYTEST_CURRENT_TEST" in source
        enabled = configured == "1" or (configured != "0" and not under_pytest)
        try:
            retention = int(
                source.get(
                    "OPENRAPPTER_FLIGHT_RETENTION",
                    str(DEFAULT_RETENTION_EVENTS),
                )
            )
            if retention < 0:
                raise ValueError
        except ValueError:
            retention = DEFAULT_RETENTION_EVENTS
        max_payload: Optional[int]
        try:
            raw_max = source.get("OPENRAPPTER_FLIGHT_MAX_PAYLOAD")
            max_payload = int(raw_max) if raw_max is not None else None
        except ValueError:
            max_payload = None
        database_override = source.get("OPENRAPPTER_FLIGHT_DB", "").strip()
        recorder = FlightRecorder(
            enabled=enabled,
            database_path=database_override or None,
            retention_events=retention,
            privacy={
                "recordIO": source.get("OPENRAPPTER_FLIGHT_RECORD_IO") == "1",
                "maxPayloadBytes": max_payload,
            },
        )
        recorder.initialize()
        _global_recorder = recorder
        _environment_configured = True
        return recorder


def reset_flight_recorder_environment_for_tests() -> None:
    global _global_recorder, _environment_configured, _explicit_global
    with _global_lock:
        try:
            _global_recorder.close()
        finally:
            _global_recorder = FlightRecorder(enabled=False)
            _environment_configured = False
            _explicit_global = False


def with_flight_trace(
    context: Optional[Mapping[str, Any]],
    operation: Callable[[], Any],
) -> Any:
    return get_flight_recorder().run_trace(context, operation)


__all__ = [
    "DEFAULT_EXCLUDED_PATH_PATTERNS",
    "DEFAULT_REDACTED_KEYS",
    "FLIGHT_EVENT_SCHEMA",
    "FLIGHT_EXPORT_SCHEMA",
    "FlightRecorder",
    "FlightRecorderCorruptionError",
    "FlightRecorderError",
    "FlightRecorderUnhealthyError",
    "SQLiteFlightLedger",
    "compute_flight_event_hash",
    "ensure_flight_recorder_from_env",
    "get_flight_recorder",
    "is_excluded_flight_path",
    "normalize_flight_model_id",
    "normalize_flight_session_id",
    "normalize_flight_workspace_id",
    "reset_flight_recorder_environment_for_tests",
    "sanitize_flight_metadata",
    "sanitize_flight_payload",
    "sanitize_flight_value",
    "set_flight_recorder",
    "summarize_flight_error",
    "verify_flight_event_hash",
    "with_flight_trace",
]
