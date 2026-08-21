"""Adapter over PR9's exact ordered eleven-step verifier."""

from __future__ import annotations

from typing import Any, Dict, Optional

from .pr9_reference import verify_card_link as _verify_card_link
from .types import CardVectorResult
from .pr9_reference import CardStateBackend


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


class _OfflineInspectionState(CardStateBackend):
    def claim_nonce(self, nonce, connection_id, utc):
        return True, "offline"

    def mark_awake(self, nonce, connection_id, utc):
        return True, "offline"

    def accept_sequence(self, namespace, authority, seq, view_hash):
        return True, "offline"


def inspect_card_offline(
    *,
    uri,
    frame,
    trust,
    now_utc,
    runtime_policy,
    authority_view,
    revocation_view,
    connection_id,
    fetch_trace,
    hydrated,
    continuity,
    supplied_state_path=None,
):
    _ = supplied_state_path
    verdict = verify_card_link(
        uri,
        frame,
        trust,
        now_utc,
        runtime_policy,
        authority_view,
        revocation_view,
        _OfflineInspectionState(),
        connection_id,
        fetch_trace,
        hydrated,
        continuity,
    )
    if verdict.ok:
        return {
            "status": "historical-valid",
            "awake": False,
            "cryptographic_policy_ok": True,
            "verdict": {
                "ok": True,
                "step": None,
                "reason": "historical-valid",
                "result": None,
            },
        }
    return {
        "status": "historical-invalid",
        "awake": False,
        "cryptographic_policy_ok": False,
        "verdict": {
            "ok": verdict.ok,
            "step": verdict.step,
            "reason": verdict.reason,
            "result": None,
        },
    }


__all__.append("inspect_card_offline")
