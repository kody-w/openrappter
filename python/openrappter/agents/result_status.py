"""Shared agent-result classifier.

An agent reports failure in one of two ways:
  1. by raising, or
  2. by *returning* a structured envelope ``{"status": "error", ...}``.

Case 2 is just as much a failure as case 1 — the same principle as a nonzero
shell exit being an error in both runtimes. Every composition layer (chain,
graph, broadcast, CLI, brainstem) classifies through this function so the two
runtimes cannot drift apart.

Accepts either the raw JSON string an agent returned from ``execute()`` or an
already-parsed envelope dict.

Mirrors typescript/src/agents/result-status.ts
"""

import json
from typing import Any


def agent_result_is_error(result: Any) -> bool:
    envelope = result

    if isinstance(envelope, str):
        try:
            envelope = json.loads(envelope)
        except (TypeError, ValueError):
            return False

    if not isinstance(envelope, dict):
        return False

    status = envelope.get("status")
    return isinstance(status, str) and status.lower() == "error"


def agent_result_error_message(result: Any, fallback: str = "agent returned an error envelope") -> str:
    """Human-readable reason for a failed agent result.

    Composition layers report a failed step's reason the same way whether the
    agent raised (str(exc)) or returned an error envelope. Reads ``message``,
    then ``error``, then falls back.

    Mirrors typescript/src/agents/result-status.ts
    """
    envelope = result

    if isinstance(envelope, str):
        try:
            envelope = json.loads(envelope)
        except (TypeError, ValueError):
            return fallback

    if not isinstance(envelope, dict):
        return fallback

    for key in ("message", "error"):
        value = envelope.get(key)
        if isinstance(value, str) and value:
            return value

    return fallback
