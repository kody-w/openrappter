"""Deterministic synthetic fixture deck shared with the TypeScript runtime."""

from __future__ import annotations

import copy
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Tuple

from openrappter.rappids.canonical import canonical_json, sha256_hex

from .contract import (
    challenge_value,
    make_deep_link,
    manifest_hash,
    sign_manifest,
)
from .replay_cache import BoundedReplayCache
from .simulator import simulate_rappid_card
from .types import (
    RAPPID_CARD_PROTOCOL,
    RAPPID_CARD_SCHEMA,
    RAPPID_CARD_TEST_PROFILE,
    CardManifest,
    CardPolicy,
    CardProviders,
    CardSnapshot,
    RappidCardReconnectError,
)

RAPPID_CARD_FIXTURE_NOW = "2035-01-01T12:00:00Z"
FIXTURE_ENDPOINT = "fixture-habitat"
FIXTURE_SIGNING_KEY_ID = "fixture-signing-1"
FIXTURE_CHALLENGE_KEY_ID = "fixture-continuity-1"

_FIXTURE_SIGNING_KEY = bytes.fromhex(
    sha256_hex("rappid-card-test/1:synthetic-signing-key")
)
_FIXTURE_CHALLENGE_KEY = bytes.fromhex(
    sha256_hex("rappid-card-test/1:synthetic-continuity-key")
)
_FIXTURE_RAPPID = (
    "rappid:@openrappter/virtual-debug-card:"
    + sha256_hex("rappid-card-test/1:virtual-debug-card")
)

RAPPID_CARD_FIXTURE_NAMES = [
    "valid",
    "expired",
    "revoked",
    "wrong-hash",
    "unknown-key",
    "incompatible-runtime-protocol",
    "classification-violation",
    "insufficient-scope",
    "missing-part",
    "challenge-failure",
    "reconnect-during-hydration",
    "duplicate-nonce",
    "physical-payload-reproduction",
]

_DESCRIPTIONS: Dict[str, Dict[str, Optional[str]]] = {
    "valid": {
        "label": "Valid card",
        "description": "Signed, current, permitted, content-addressed, and challenge-complete.",
        "expectedState": "awake",
        "expectedError": None,
    },
    "expired": {
        "label": "Expired card",
        "description": "A correctly signed card whose expiry is in the past.",
        "expectedState": "failed",
        "expectedError": "expired",
    },
    "revoked": {
        "label": "Revoked card",
        "description": "A correctly signed card rejected by the injected revocation provider.",
        "expectedState": "failed",
        "expectedError": "revoked",
    },
    "wrong-hash": {
        "label": "Wrong manifest hash",
        "description": "The endpoint returns a card that does not match m= in the link.",
        "expectedState": "failed",
        "expectedError": "manifest_hash_mismatch",
    },
    "unknown-key": {
        "label": "Unknown signing key",
        "description": "The manifest names a key the injected key provider does not know.",
        "expectedState": "failed",
        "expectedError": "unknown_key",
    },
    "incompatible-runtime-protocol": {
        "label": "Incompatible runtime / protocol",
        "description": "A signed card that requires a future link protocol and runtime.",
        "expectedState": "failed",
        "expectedError": "incompatible_protocol",
    },
    "classification-violation": {
        "label": "Classification violation",
        "description": "A signed internal card presented to a public-only simulator.",
        "expectedState": "failed",
        "expectedError": "classification_violation",
    },
    "insufficient-scope": {
        "label": "Insufficient scope",
        "description": "A required part asks for a scope absent from the manifest grant.",
        "expectedState": "failed",
        "expectedError": "insufficient_scope",
    },
    "missing-part": {
        "label": "Missing required part",
        "description": "Verification succeeds, then the content provider cannot hydrate a required hash.",
        "expectedState": "failed",
        "expectedError": "missing_part",
    },
    "challenge-failure": {
        "label": "Continuity challenge failure",
        "description": "All parts hydrate, but the injected challenge response is invalid.",
        "expectedState": "failed",
        "expectedError": "challenge_failed",
    },
    "reconnect-during-hydration": {
        "label": "Reconnect during hydration",
        "description": "The provider reconnects once; the verified state resumes without re-authorizing.",
        "expectedState": "awake",
        "expectedError": None,
    },
    "duplicate-nonce": {
        "label": "Duplicate nonce",
        "description": "The bounded replay cache already contains the signed nonce.",
        "expectedState": "failed",
        "expectedError": "duplicate_nonce",
    },
    "physical-payload-reproduction": {
        "label": "Physical payload reproduction",
        "description": "The exact compact link is rendered as QR and re-entered without changing bytes.",
        "expectedState": "awake",
        "expectedError": None,
    },
}


@dataclass
class RappidCardFixture:
    name: str
    label: str
    description: str
    transport: str
    manifest: CardManifest
    manifest_hash: str
    deep_link: str
    expected_state: str
    expected_error: Optional[str]
    policy: CardPolicy
    providers: CardProviders
    replay_cache: BoundedReplayCache


def _content(
    name: str,
    value: Any,
    scope: str,
    media_type: str = "application/json",
) -> Tuple[Dict[str, Any], bytes]:
    payload = canonical_json(value).encode("utf-8")
    return (
        {
            "name": name,
            "hash": sha256_hex(payload),
            "bytes": len(payload),
            "mediaType": media_type,
            "classification": "public",
            "scope": scope,
            "required": True,
        },
        payload,
    )


def _base_contents() -> List[Tuple[Dict[str, Any], bytes]]:
    return [
        _content(
            "identity",
            {
                "displayName": "Virtual Debug RAPPID",
                "kind": "synthetic-test",
                "rappid": _FIXTURE_RAPPID,
            },
            "identity:read",
        ),
        _content(
            "traits",
            {
                "continuity": 1000,
                "evidenceBound": 1000,
                "localFirst": 1000,
            },
            "traits:read",
        ),
    ]


def _unsigned_base(
    name: str, parts: List[Dict[str, Any]]
) -> CardManifest:
    return {
        "schema": RAPPID_CARD_SCHEMA,
        "profile": RAPPID_CARD_TEST_PROFILE,
        "rappid": _FIXTURE_RAPPID,
        "endpoint": FIXTURE_ENDPOINT,
        "nonce": sha256_hex(f"rappid-card-test/1:nonce:{name}")[:32],
        "issuedAt": "2035-01-01T00:00:00Z",
        "expiresAt": "2035-01-02T00:00:00Z",
        "protocol": RAPPID_CARD_PROTOCOL,
        "runtime": {
            "name": "openrappter",
            "minimum": "1.13.0",
            "maximum": "1.99.0",
        },
        "classification": "public",
        "scopes": ["identity:read", "traits:read"],
        "parts": parts,
        "challenge": {
            "algorithm": "hmac-sha256-test",
            "keyId": FIXTURE_CHALLENGE_KEY_ID,
        },
    }


def _fixture_policy() -> CardPolicy:
    return CardPolicy(
        mode="fixture",
        now=RAPPID_CARD_FIXTURE_NOW,
        runtime_name="openrappter",
        runtime_version="1.13.0",
        protocol=RAPPID_CARD_PROTOCOL,
        max_classification="public",
        granted_scopes=[
            "identity:read",
            "traits:read",
            "skill:hydrate",
            "sonic:hydrate",
            "capability:hydrate",
        ],
    )


def _wrong_hash(value: str) -> str:
    return ("1" if value[0] == "0" else "0") + value[1:]


def build_rappid_card_fixture(name: str) -> RappidCardFixture:
    if name not in RAPPID_CARD_FIXTURE_NAMES:
        raise ValueError(f"unknown RAPPID card fixture: {name}")
    definition = _DESCRIPTIONS[name]
    contents = _base_contents()
    unsigned = _unsigned_base(name, [entry[0] for entry in contents])
    signature_key_id = FIXTURE_SIGNING_KEY_ID
    include_all_content = True
    challenge_fails = False
    reconnect_hash: Optional[str] = None

    if name == "expired":
        unsigned["issuedAt"] = "2034-12-30T00:00:00Z"
        unsigned["expiresAt"] = "2034-12-31T00:00:00Z"
    elif name == "unknown-key":
        signature_key_id = "fixture-unknown-key"
    elif name == "incompatible-runtime-protocol":
        unsigned["protocol"] = "rappid-link/99"
        unsigned["runtime"]["minimum"] = "99.0.0"
        unsigned["runtime"]["maximum"] = "99.9.9"
    elif name == "classification-violation":
        unsigned["classification"] = "internal"
    elif name == "insufficient-scope":
        extra = _content(
            "skill-manifest",
            {"actions": [], "executable": False, "fixture": True},
            "skill:hydrate",
            "application/vnd.rapp.skill+json",
        )
        contents.append(extra)
        unsigned["parts"].append(extra[0])
    elif name == "missing-part":
        extra = _content(
            "sonic-profile",
            {"fixture": True, "playback": "none"},
            "sonic:hydrate",
            "application/vnd.rapp.sonic+json",
        )
        contents.append(extra)
        unsigned["parts"].append(extra[0])
        unsigned["scopes"].append("sonic:hydrate")
        include_all_content = False
    elif name == "challenge-failure":
        challenge_fails = True
    elif name == "reconnect-during-hydration":
        reconnect_hash = contents[0][0]["hash"]

    manifest = sign_manifest(
        unsigned,
        "hmac-sha256-test",
        signature_key_id,
        _FIXTURE_SIGNING_KEY,
    )
    actual_hash = manifest_hash(manifest)
    link_hash = _wrong_hash(actual_hash) if name == "wrong-hash" else actual_hash
    deep_link = make_deep_link(manifest, link_hash)
    content_map: Dict[str, bytes] = {}
    for index, (part, payload) in enumerate(contents):
        if include_all_content or index < len(contents) - 1:
            content_map[part["hash"]] = payload
    key_map = {
        FIXTURE_SIGNING_KEY_ID: _FIXTURE_SIGNING_KEY,
        FIXTURE_CHALLENGE_KEY_ID: _FIXTURE_CHALLENGE_KEY,
    }
    revoked = {actual_hash} if name == "revoked" else set()
    reconnected = False

    def get_manifest(endpoint: str, requested_hash: str) -> Any:
        if endpoint != FIXTURE_ENDPOINT or requested_hash != link_hash:
            return None
        return copy.deepcopy(manifest)

    def get_key(key_id: str, _algorithm: str) -> Optional[bytes]:
        return key_map.get(key_id)

    def is_revoked(requested_hash: str, _key_id: str) -> bool:
        return requested_hash in revoked

    def get_part(hash_value: str) -> Optional[bytes]:
        nonlocal reconnected
        if hash_value == reconnect_hash and not reconnected:
            reconnected = True
            raise RappidCardReconnectError(
                "content provider reconnected during hydration"
            )
        return content_map.get(hash_value)

    def challenge_response(request: Dict[str, Any]) -> str:
        if challenge_fails:
            return "0" * 64
        return challenge_value(request, _FIXTURE_CHALLENGE_KEY)

    providers = CardProviders(
        get_manifest=get_manifest,
        get_key=get_key,
        is_revoked=is_revoked,
        get_part=get_part,
        challenge_response=challenge_response,
    )
    replay_cache = BoundedReplayCache(
        initial=[manifest["nonce"]] if name == "duplicate-nonce" else []
    )
    return RappidCardFixture(
        name=name,
        label=str(definition["label"]),
        description=str(definition["description"]),
        transport=(
            "physical-reproduction"
            if name == "physical-payload-reproduction"
            else "virtual"
        ),
        manifest=manifest,
        manifest_hash=link_hash,
        deep_link=deep_link,
        expected_state=str(definition["expectedState"]),
        expected_error=definition["expectedError"],
        policy=_fixture_policy(),
        providers=providers,
        replay_cache=replay_cache,
    )


def list_rappid_card_fixtures() -> List[Dict[str, Any]]:
    result = []
    for name in RAPPID_CARD_FIXTURE_NAMES:
        fixture = build_rappid_card_fixture(name)
        result.append(
            {
                "name": name,
                "label": fixture.label,
                "description": fixture.description,
                "transport": fixture.transport,
                "expectedState": fixture.expected_state,
                "expectedError": fixture.expected_error,
            }
        )
    return result


def simulate_rappid_card_fixture(name: str, approve: bool) -> CardSnapshot:
    fixture = build_rappid_card_fixture(name)
    return simulate_rappid_card(
        fixture.deep_link,
        approve=approve,
        policy=fixture.policy,
        providers=fixture.providers,
        replay_cache=fixture.replay_cache,
    )


def build_rappid_card_vector_document() -> Dict[str, Any]:
    fixtures = []
    for name in RAPPID_CARD_FIXTURE_NAMES:
        fixture = build_rappid_card_fixture(name)
        fixtures.append(
            {
                "name": name,
                "manifest": fixture.manifest,
                "manifestHash": fixture.manifest_hash,
                "deepLink": fixture.deep_link,
                "preview": simulate_rappid_card_fixture(name, False),
                "approved": simulate_rappid_card_fixture(name, True),
            }
        )
    return {
        "schema": "rappid-card-vectors/1",
        "fixtureNow": RAPPID_CARD_FIXTURE_NOW,
        "fixtures": fixtures,
    }
