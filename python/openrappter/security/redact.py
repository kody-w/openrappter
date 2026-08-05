"""Recursively replace secret values so a structure is safe to print or persist.

The TypeScript side is protected at two levels: `GatewayLogFields` forbids
nested values, and every call site passes a literal object of scalars, so the
compiler actually enforces flatness. Python has neither. `Dict[str, Any]`
permits any shape and nothing checks it, which makes the runtime guard the
only line of defence rather than a second one.

Mirrors typescript/src/security/redact.ts. Kept in step by
tests/test_redact.py, which runs the same cases through both runtimes.
"""

from __future__ import annotations

from typing import Any

from openrappter.security.secret_keys import is_secret_key

REDACTED = "***REDACTED***"

# Structures below this depth are replaced wholesale rather than emitted.
MAX_REDACT_DEPTH = 10

TOO_DEEP = "[nested too deep to redact]"


def redact_secrets(value: Any, placeholder: str = REDACTED, depth: int = 0) -> Any:
    """Return ``value`` with anything under a secret-looking name replaced."""
    # Scalars carry no keys of their own; the caller already judged the key
    # that pointed here, so they are safe to return at any depth.
    if not isinstance(value, (dict, list, tuple)):
        return value

    # Past the limit we can no longer inspect keys. Returning the structure
    # unread would let a secret nested deeper than the limit through
    # untouched, so the structure itself is what has to go.
    if depth > MAX_REDACT_DEPTH:
        return TOO_DEEP

    if isinstance(value, (list, tuple)):
        return [redact_secrets(item, placeholder, depth + 1) for item in value]

    safe: dict[str, Any] = {}
    for key, item in value.items():
        if is_secret_key(str(key)):
            # A secret name covers everything beneath it, not just a string.
            # `api_key: {"raw": ...}` and `api_key: [...]` are still the key.
            empty = item is None or (isinstance(item, str) and item == "")
            safe[key] = item if empty else placeholder
            continue
        safe[key] = redact_secrets(item, placeholder, depth + 1)
    return safe
