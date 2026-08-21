"""Exact PR9 RAPPID card wire constants and lightweight adapter types."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, Optional

from . import pr9_reference as R

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
