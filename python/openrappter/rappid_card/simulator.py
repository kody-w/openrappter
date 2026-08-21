"""Adapter over PR9's exact ordered eleven-step verifier."""

from __future__ import annotations

from typing import Any, Dict, Optional

from .pr9_interim import verify_card_link as _verify_card_link
from .types import CardVectorResult


def verify_card_link(
    uri: str,
    frame: Dict[str, Any],
    trust: Any,
    now_utc: str,
    runtime_policy: Dict[str, Any],
    authority_view: Dict[str, Any],
    revocation_view: Optional[Dict[str, Any]],
    state: Any,
    connection_id: str,
    fetch_trace: Any,
    hydrated: Dict[str, bytes],
    continuity: Dict[str, Any],
    head: Optional[Dict[str, Any]] = None,
) -> CardVectorResult:
    ok, step, reason, result = _verify_card_link(
        uri,
        frame,
        trust,
        now_utc,
        runtime_policy,
        authority_view,
        revocation_view,
        state,
        connection_id,
        fetch_trace,
        hydrated,
        continuity,
        head=head,
    )
    return CardVectorResult(ok, step, reason, result)


__all__ = ["verify_card_link"]
