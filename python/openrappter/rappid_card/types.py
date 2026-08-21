"""Closed wire and provider types for the virtual RAPPID Debug Card."""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Any, Callable, Dict, Optional

RAPPID_CARD_SCHEMA = "rappid-card/1"
RAPPID_CARD_POLICY_SCHEMA = "rappid-card-policy/1"
RAPPID_CARD_AUTHORIZATION_SCHEMA = "rappid-card-authorization/1"
RAPPID_CARD_REVOCATIONS_SCHEMA = "rappid-card-revocations/1"
RAPPID_CARD_TEST_PROFILE = "rappid-card-test/1"
RAPPID_CARD_PRODUCTION_PROFILE = "rappid-card-production/1"
RAPPID_CARD_PROTOCOL = "rappid-link/1"
RAPPID_CARD_RUNTIME_NAME = "openrappter"
RAPPID_CARD_RUNTIME_VERSION = "1.13.0"
RAPPID_CARD_FILENAME = ".rappid-card.json"
MAX_AUDIT_EVENTS = 64
MAX_REPLAY_NONCES = 128

CardManifest = Dict[str, Any]
CardSnapshot = Dict[str, Any]


class RappidCardError(Exception):
    """A stable, wire-visible card failure."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


class RappidCardReconnectError(Exception):
    """The injected content provider reconnected during one hydration."""


@dataclass
class CardProviders:
    get_manifest: Callable[[str, str], Any]
    get_policy_for_origin: Callable[[str], Any]
    get_authorization: Callable[[str, str, str], Any]
    get_revocations: Callable[[str], Any]
    get_authority_key: Callable[[str, str], Optional[str]]
    get_part: Callable[[str], Optional[bytes]]
    challenge_response: Callable[[Dict[str, Any]], str]


class CardStateStore(ABC):
    @abstractmethod
    def record_policy(
        self, policy_id: str, sequence: int, document_hash: str
    ) -> None:
        raise NotImplementedError

    @abstractmethod
    def record(
        self, trust_state: Dict[str, Any], claim_nonce: bool
    ) -> None:
        raise NotImplementedError


class DurableCardStateStore(CardStateStore):
    @abstractmethod
    def close(self) -> None:
        raise NotImplementedError
