"""Exact RAPP/1 §7.10 RAPPID card wire constants and lightweight adapter types."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, Optional

from . import protocol_reference as R

RAPPID_CARD_SCHEMA = R.SPEC
RAPPID_CARD_PROFILE = R.CARD_PROFILE
RAPPID_CARD_TEST_PROFILE = R.CARD_TEST_PROFILE
RAPPID_CARD_RUNTIME_POLICY_SCHEMA = R.CARD_RUNTIME_POLICY_SCHEMA
RAPPID_CARD_AUTHORITY_SCHEMA = R.CARD_AUTHORITY_SCHEMA
RAPPID_CARD_REVOCATIONS_SCHEMA = R.CARD_REVOCATION_SCHEMA
RAPPID_CARD_FILENAME = R.CARD_VIRTUAL_SUFFIX
RAPPID_CARD_VERIFY_STEPS = R.CARD_VERIFY_STEPS
RAPPID_CARD_PAYLOAD_KEYS = frozenset(R.CARD_PAYLOAD_KEYS)
RAPPID_CARD_RUNTIME_POLICY_KEYS = frozenset(R.CARD_RUNTIME_POLICY_KEYS)
RAPPID_CARD_AUTHORITY_KEYS = frozenset(R.CARD_AUTHORITY_VIEW_KEYS)
RAPPID_CARD_REVOCATION_KEYS = frozenset(R.CARD_REVOCATION_VIEW_KEYS)
RAPPID_CARD_CLASSIFICATIONS = R.CARD_CLASSIFICATIONS
RAPPID_CARD_REQUIRED_PARTS = R.CARD_REQUIRED_PARTS
MANDATORY_CARD_SCENARIOS = (
    "valid-test", "valid-production", "expired", "manifest-revoked",
    "key-revoked", "subject-revoked", "wrong-manifest-hash",
    "deep-payload", "oversized-payload", "newline-rappid",
    "newline-manifest-hash", "newline-lclabel", "newline-profile-token",
    "newline-connection-id", "unknown-signing-key", "attacker-key-impersonation",
    "subject-not-yet-effective", "delegation-not-yet-effective",
    "delegation-expired", "delegation-revoked", "forged-revocation-view",
    "stale-revocation-view", "unavailable-revocation-view",
    "rollback-revocation-view", "protocol-incompatible",
    "runtime-incompatible", "unsupported-feature", "feature-superset",
    "classification-violation", "insufficient-scope",
    "missing-engram-part", "continuity-challenge-failure",
    "reconnect-during-hydration", "duplicate-replayed-nonce",
    "physical-payload-reproduction", "test-profile-production",
    "synthetic-key-production", "auto-execute", "endpoint-userinfo",
    "endpoint-empty-query", "endpoint-empty-fragment", "endpoint-space",
    "endpoint-backslash", "endpoint-bad-percent", "endpoint-double-encoding",
    "endpoint-numeric-127-1", "endpoint-numeric-octal",
    "endpoint-numeric-hex", "endpoint-numeric-short-private",
    "endpoint-loopback-literal", "endpoint-private-literal",
    "endpoint-link-local-literal", "endpoint-reserved-literal",
    "endpoint-ipv4-multicast-literal", "endpoint-ipv6-multicast-literal",
    "endpoint-unapproved-origin", "endpoint-redirect-origin",
    "endpoint-private-dns", "fetch-ipv4-multicast", "fetch-ipv6-multicast",
    "fetch-numeric-alias", "secret-endpoint-password", "secret-password",
    "secret-api-key", "secret-cookie", "secret-bearer",
    "secret-private-memory", "secret-unicode-latin-adjacency",
    "secret-unicode-cjk-adjacency",
)


@dataclass(frozen=True)
class CardVectorResult:
    ok: bool
    step: Optional[str]
    reason: str
    result: Optional[Dict[str, Any]]

    def to_wire(self) -> Dict[str, Any]:
        return {
            "ok": self.ok,
            "step": self.step,
            "reason": self.reason,
            "result": self.result,
        }


class RappidCardError(Exception):
    def __init__(self, step: str, message: str) -> None:
        super().__init__(message)
        self.step = step
        self.message = message
