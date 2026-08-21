"""Deterministic signed-trust fixture deck shared with TypeScript."""

from __future__ import annotations

import copy
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Tuple

from openrappter.rappids.canonical import canonical_json, sha256_hex

from .contract import (
    challenge_value,
    ed25519_public_key,
    make_deep_link,
    manifest_hash,
    sign_authorization,
    sign_manifest,
    sign_policy,
    sign_revocations,
)
from .replay_cache import BoundedCardStateStore
from .simulator import simulate_rappid_card_fixture_mode
from .types import (
    RAPPID_CARD_AUTHORIZATION_SCHEMA,
    RAPPID_CARD_POLICY_SCHEMA,
    RAPPID_CARD_PROTOCOL,
    RAPPID_CARD_REVOCATIONS_SCHEMA,
    RAPPID_CARD_SCHEMA,
    RAPPID_CARD_TEST_PROFILE,
    CardManifest,
    CardProviders,
    CardSnapshot,
    RappidCardReconnectError,
)

RAPPID_CARD_FIXTURE_NOW = "2035-01-01T12:00:00Z"
FIXTURE_ENDPOINT = "https://fixture.openrappter.test/rappid-card"
FIXTURE_ORIGIN = "https://fixture.openrappter.test"
FIXTURE_POLICY_ID = "fixture-policy-1"
FIXTURE_AUTHORIZATION_ID = "fixture-authorization-1"
FIXTURE_AUTHORITY_KEY_ID = "fixture-authority-1"
FIXTURE_SIGNING_KEY_ID = "fixture-signer-1"
FIXTURE_CHALLENGE_KEY_ID = FIXTURE_SIGNING_KEY_ID

_FIXTURE_AUTHORITY_SEED = bytes.fromhex(
    sha256_hex("rappid-card-test/1:synthetic-authority-seed")
)
_FIXTURE_SIGNER_SEED = bytes.fromhex(
    sha256_hex("rappid-card-test/1:synthetic-signer-seed")
)
_FIXTURE_AUTHORITY_PUBLIC_KEY = ed25519_public_key(
    _FIXTURE_AUTHORITY_SEED
)
_FIXTURE_SIGNER_PUBLIC_KEY = ed25519_public_key(_FIXTURE_SIGNER_SEED)
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
        "description": "Authorized signer, current policy, monotonic revocations, approved origin, and valid challenge.",
        "expectedState": "awake",
        "expectedError": None,
    },
    "expired": {
        "label": "Expired card",
        "description": "A correctly signed and authorized card whose expiry is in the past.",
        "expectedState": "failed",
        "expectedError": "card_expired",
    },
    "revoked": {
        "label": "Revoked card",
        "description": "A signed monotonic revocation view rejects the manifest hash.",
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
        "description": "No signed authorization binds the named signer to the subject RAPPID.",
        "expectedState": "failed",
        "expectedError": "unknown_key",
    },
    "incompatible-runtime-protocol": {
        "label": "Incompatible runtime / protocol",
        "description": "An authorized card requires a future link protocol and runtime.",
        "expectedState": "failed",
        "expectedError": "incompatible_protocol",
    },
    "classification-violation": {
        "label": "Classification violation",
        "description": "The card exceeds signed policy and signer classification authority.",
        "expectedState": "failed",
        "expectedError": "classification_violation",
    },
    "insufficient-scope": {
        "label": "Insufficient scope",
        "description": "A required part asks for a scope absent from the signed card grant.",
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
        "description": "All parts hydrate, but the authorized signer challenge is invalid.",
        "expectedState": "failed",
        "expectedError": "challenge_failed",
    },
    "reconnect-during-hydration": {
        "label": "Reconnect during hydration",
        "description": "The provider reconnects once; verified authorization resumes without weakening trust.",
        "expectedState": "awake",
        "expectedError": None,
    },
    "duplicate-nonce": {
        "label": "Duplicate nonce",
        "description": "The transactional replay store already contains the signed nonce.",
        "expectedState": "failed",
        "expectedError": "duplicate_nonce",
    },
    "physical-payload-reproduction": {
        "label": "Physical payload reproduction",
        "description": "The exact approved-origin HTTPS endpoint survives QR/deep-link reproduction.",
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
    policy: Dict[str, Any]
    authorization: Dict[str, Any]
    revocations: Dict[str, Any]
    expected_state: str
    expected_error: Optional[str]
    providers: CardProviders
    state_store: BoundedCardStateStore


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
        "policyId": FIXTURE_POLICY_ID,
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
            "algorithm": "ed25519-test",
            "keyId": FIXTURE_SIGNING_KEY_ID,
        },
    }


def sign_fixture_manifest(
    manifest: CardManifest, key_id: str = FIXTURE_SIGNING_KEY_ID
) -> CardManifest:
    return sign_manifest(
        manifest,
        "ed25519-test",
        key_id,
        _FIXTURE_SIGNER_SEED,
    )


def sign_fixture_policy(policy: Dict[str, Any]) -> Dict[str, Any]:
    return sign_policy(
        policy,
        "ed25519-test",
        FIXTURE_AUTHORITY_KEY_ID,
        _FIXTURE_AUTHORITY_SEED,
    )


def sign_fixture_authorization(
    authorization: Dict[str, Any]
) -> Dict[str, Any]:
    return sign_authorization(
        authorization,
        "ed25519-test",
        FIXTURE_AUTHORITY_KEY_ID,
        _FIXTURE_AUTHORITY_SEED,
    )


def sign_fixture_revocations(
    revocations: Dict[str, Any]
) -> Dict[str, Any]:
    return sign_revocations(
        revocations,
        "ed25519-test",
        FIXTURE_AUTHORITY_KEY_ID,
        _FIXTURE_AUTHORITY_SEED,
    )


def _fixture_policy() -> Dict[str, Any]:
    return sign_fixture_policy(
        {
            "schema": RAPPID_CARD_POLICY_SCHEMA,
            "policyId": FIXTURE_POLICY_ID,
            "sequence": 7,
            "issuedAt": "2034-12-01T00:00:00Z",
            "expiresAt": "2036-01-01T00:00:00Z",
            "allowedProfiles": [RAPPID_CARD_TEST_PROFILE],
            "protocol": RAPPID_CARD_PROTOCOL,
            "runtime": {
                "name": "openrappter",
                "minimum": "1.13.0",
                "maximum": "1.99.0",
            },
            "maxClassification": "public",
            "grantedScopes": [
                "identity:read",
                "traits:read",
                "skill:hydrate",
                "sonic:hydrate",
                "capability:hydrate",
            ],
            "approvedOrigins": [FIXTURE_ORIGIN],
        }
    )


def _fixture_authorization() -> Dict[str, Any]:
    return sign_fixture_authorization(
        {
            "schema": RAPPID_CARD_AUTHORIZATION_SCHEMA,
            "authorizationId": FIXTURE_AUTHORIZATION_ID,
            "policyId": FIXTURE_POLICY_ID,
            "sequence": 3,
            "subjectRappid": _FIXTURE_RAPPID,
            "signerKeyId": FIXTURE_SIGNING_KEY_ID,
            "signerAlgorithm": "ed25519-test",
            "signerPublicKey": _FIXTURE_SIGNER_PUBLIC_KEY,
            "notBefore": "2034-12-01T00:00:00Z",
            "notAfter": "2036-01-01T00:00:00Z",
            "maxClassification": "public",
            "grantedScopes": [
                "identity:read",
                "traits:read",
                "skill:hydrate",
                "sonic:hydrate",
                "capability:hydrate",
            ],
            "approvedOrigins": [FIXTURE_ORIGIN],
        }
    )


def _fixture_revocations(
    revoked_manifest_hashes: Optional[List[str]] = None,
) -> Dict[str, Any]:
    return sign_fixture_revocations(
        {
            "schema": RAPPID_CARD_REVOCATIONS_SCHEMA,
            "policyId": FIXTURE_POLICY_ID,
            "sequence": 11,
            "issuedAt": "2035-01-01T00:00:00Z",
            "expiresAt": "2036-01-01T00:00:00Z",
            "revokedManifestHashes": revoked_manifest_hashes or [],
            "revokedSignerKeyIds": [],
            "revokedAuthorizationIds": [],
        }
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
        unsigned["challenge"]["keyId"] = signature_key_id
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

    manifest = sign_fixture_manifest(unsigned, signature_key_id)
    actual_hash = manifest_hash(manifest)
    link_hash = _wrong_hash(actual_hash) if name == "wrong-hash" else actual_hash
    deep_link = make_deep_link(manifest, link_hash)
    policy = _fixture_policy()
    authorization = _fixture_authorization()
    revocations = _fixture_revocations(
        [actual_hash] if name == "revoked" else []
    )
    content_map: Dict[str, bytes] = {}
    for index, (part, payload) in enumerate(contents):
        if include_all_content or index < len(contents) - 1:
            content_map[part["hash"]] = payload
    reconnected = False

    def get_manifest(endpoint: str, requested_hash: str) -> Any:
        if endpoint != FIXTURE_ENDPOINT or requested_hash != link_hash:
            return None
        return copy.deepcopy(manifest)

    def get_policy_for_origin(origin: str) -> Any:
        return (
            copy.deepcopy(policy)
            if origin == FIXTURE_ORIGIN
            else None
        )

    def get_authorization(
        policy_id: str, signer_key_id: str, subject_rappid: str
    ) -> Any:
        if (
            policy_id == FIXTURE_POLICY_ID
            and signer_key_id == FIXTURE_SIGNING_KEY_ID
            and subject_rappid == _FIXTURE_RAPPID
        ):
            return copy.deepcopy(authorization)
        return None

    def get_revocations(policy_id: str) -> Any:
        return (
            copy.deepcopy(revocations)
            if policy_id == FIXTURE_POLICY_ID
            else None
        )

    def get_authority_key(
        key_id: str, algorithm: str
    ) -> Optional[str]:
        if (
            key_id == FIXTURE_AUTHORITY_KEY_ID
            and algorithm == "ed25519-test"
        ):
            return _FIXTURE_AUTHORITY_PUBLIC_KEY
        return None

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
            return "0" * 86
        return challenge_value(request, _FIXTURE_SIGNER_SEED)

    providers = CardProviders(
        get_manifest=get_manifest,
        get_policy_for_origin=get_policy_for_origin,
        get_authorization=get_authorization,
        get_revocations=get_revocations,
        get_authority_key=get_authority_key,
        get_part=get_part,
        challenge_response=challenge_response,
    )
    state_store = BoundedCardStateStore(
        initial_nonces=[manifest["nonce"]]
        if name == "duplicate-nonce"
        else []
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
        policy=policy,
        authorization=authorization,
        revocations=revocations,
        expected_state=str(definition["expectedState"]),
        expected_error=definition["expectedError"],
        providers=providers,
        state_store=state_store,
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
    return simulate_rappid_card_fixture_mode(
        fixture.deep_link,
        approve=approve,
        providers=fixture.providers,
        state_store=fixture.state_store,
        fixture_now=RAPPID_CARD_FIXTURE_NOW,
    )


def simulate_rappid_card_fixture_input(
    fixture: RappidCardFixture, approve: bool
) -> CardSnapshot:
    return simulate_rappid_card_fixture_mode(
        fixture.deep_link,
        approve=approve,
        providers=fixture.providers,
        state_store=fixture.state_store,
        fixture_now=RAPPID_CARD_FIXTURE_NOW,
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
                "policy": fixture.policy,
                "authorization": fixture.authorization,
                "revocations": fixture.revocations,
                "preview": simulate_rappid_card_fixture(name, False),
                "approved": simulate_rappid_card_fixture(name, True),
            }
        )
    return {
        "schema": "rappid-card-vectors/2",
        "fixtureNow": RAPPID_CARD_FIXTURE_NOW,
        "fixtures": fixtures,
    }
