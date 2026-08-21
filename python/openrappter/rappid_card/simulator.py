"""Adapter over PR9's exact ordered eleven-step verifier."""

from __future__ import annotations

from typing import Any, Dict, Optional

from .pr9_reference import verify_card_link as _verify_card_link
from .types import CardVectorResult
from .pr9_reference import CARD_VERIFY_STEPS, CardStateBackend


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
):
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
    signature_index = CARD_VERIFY_STEPS.index("signature")
    failure_index = (
        len(CARD_VERIFY_STEPS)
        if verdict.step is None
        else CARD_VERIFY_STEPS.index(verdict.step)
    )
    cryptographic_policy_ok = verdict.ok or failure_index > signature_index
    return {
        "status": "historical-unproven",
        "awake": False,
        "cryptographic_policy_ok": cryptographic_policy_ok,
        "anti_rollback_checked": False,
        "replay_checked": False,
        "verdict": (
            {
                "ok": False,
                "step": None,
                "reason": "historical-unproven",
                "result": None,
            }
            if verdict.ok
            else {
                "ok": verdict.ok,
                "step": verdict.step,
                "reason": verdict.reason,
                "result": None,
            }
        ),
    }


__all__.append("inspect_card_offline")
