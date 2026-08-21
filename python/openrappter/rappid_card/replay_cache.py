"""Fixture-only bounded trust sequence and nonce state."""

from __future__ import annotations

from collections import OrderedDict
from typing import Any, Dict, Iterable, List

from .types import CardStateStore, MAX_REPLAY_NONCES, RappidCardError


class BoundedCardStateStore(CardStateStore):
    def __init__(
        self, limit: int = MAX_REPLAY_NONCES, initial_nonces: Iterable[str] = ()
    ) -> None:
        if not isinstance(limit, int) or isinstance(limit, bool) or limit < 1:
            raise ValueError("state store limit must be a positive integer")
        self.limit = limit
        self._policy_states: Dict[str, Any] = {}
        self._authorization_states: Dict[str, Any] = {}
        self._revocation_states: Dict[str, Any] = {}
        self._nonces: "OrderedDict[str, bool]" = OrderedDict()
        for nonce in initial_nonces:
            self._add_nonce(nonce)

    def record_policy(
        self, policy_id: str, sequence: int, document_hash: str
    ) -> None:
        current = self._policy_states.get(policy_id)
        if sequence < (current["sequence"] if current else -1):
            raise RappidCardError(
                "policy_rollback", "signed policy sequence moved backwards"
            )
        if (
            current
            and sequence == current["sequence"]
            and document_hash != current["hash"]
        ):
            raise RappidCardError(
                "policy_equivocation",
                "signed policy changed without advancing its sequence",
            )
        self._policy_states[policy_id] = {
            "sequence": sequence,
            "hash": document_hash,
        }

    def record(
        self, trust_state: Dict[str, Any], claim_nonce: bool
    ) -> None:
        policy_id = trust_state["policyId"]
        authorization_key = (
            f"{policy_id}\0{trust_state['authorizationId']}"
        )
        policy_state = self._policy_states.get(policy_id)
        authorization_state = self._authorization_states.get(authorization_key)
        revocation_state = self._revocation_states.get(policy_id)
        if trust_state["policySequence"] < (
            policy_state["sequence"] if policy_state else -1
        ):
            raise RappidCardError(
                "policy_rollback", "signed policy sequence moved backwards"
            )
        if (
            policy_state
            and trust_state["policySequence"] == policy_state["sequence"]
            and trust_state["policyHash"] != policy_state["hash"]
        ):
            raise RappidCardError(
                "policy_equivocation",
                "signed policy changed without advancing its sequence",
            )
        if trust_state["authorizationSequence"] < (
            authorization_state["sequence"] if authorization_state else -1
        ):
            raise RappidCardError(
                "authorization_rollback",
                "signed authorization sequence moved backwards",
            )
        if (
            authorization_state
            and trust_state["authorizationSequence"]
            == authorization_state["sequence"]
            and trust_state["authorizationHash"]
            != authorization_state["hash"]
        ):
            raise RappidCardError(
                "authorization_equivocation",
                "signed authorization changed without advancing its sequence",
            )
        if trust_state["revocationSequence"] < (
            revocation_state["sequence"] if revocation_state else -1
        ):
            raise RappidCardError(
                "revocation_rollback",
                "signed revocation sequence moved backwards",
            )
        if (
            revocation_state
            and trust_state["revocationSequence"]
            == revocation_state["sequence"]
            and trust_state["revocationHash"] != revocation_state["hash"]
        ):
            raise RappidCardError(
                "revocation_equivocation",
                "signed revocation view changed without advancing its sequence",
            )
        if trust_state["nonce"] in self._nonces:
            raise RappidCardError(
                "duplicate_nonce", "card nonce has already been accepted"
            )
        self._policy_states[policy_id] = {
            "sequence": trust_state["policySequence"],
            "hash": trust_state["policyHash"],
        }
        self._authorization_states[authorization_key] = {
            "sequence": trust_state["authorizationSequence"],
            "hash": trust_state["authorizationHash"],
        }
        self._revocation_states[policy_id] = {
            "sequence": trust_state["revocationSequence"],
            "hash": trust_state["revocationHash"],
        }
        if claim_nonce:
            self._add_nonce(trust_state["nonce"])

    def values(self) -> List[str]:
        return list(self._nonces)

    def _add_nonce(self, nonce: str) -> None:
        self._nonces.pop(nonce, None)
        self._nonces[nonce] = True
        while len(self._nonces) > self.limit:
            self._nonces.popitem(last=False)
