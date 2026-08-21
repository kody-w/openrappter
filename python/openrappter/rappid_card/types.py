"""Closed wire types for the virtual RAPPID Debug Card."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable, Dict, List, Optional

RAPPID_CARD_SCHEMA = "rappid-card/1"
RAPPID_CARD_TEST_PROFILE = "rappid-card-test/1"
RAPPID_CARD_PRODUCTION_PROFILE = "rappid-card-production/1"
RAPPID_CARD_PROTOCOL = "rappid-link/1"
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


@dataclass(frozen=True)
class CardPolicy:
    mode: str
    now: str
    runtime_name: str
    runtime_version: str
    protocol: str
    max_classification: str
    granted_scopes: List[str]


@dataclass
class CardProviders:
    get_manifest: Callable[[str, str], Any]
    get_key: Callable[[str, str], Optional[bytes]]
    is_revoked: Callable[[str, str], bool]
    get_part: Callable[[str], Optional[bytes]]
    challenge_response: Callable[[Dict[str, Any]], str]
