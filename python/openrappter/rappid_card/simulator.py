"""Pure reducer plus authenticated-trust RAPPID card simulation driver."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Dict, Optional

from openrappter.rappids.canonical import sha256_hex

from .contract import (
    canonical_document_hash,
    classification_rank,
    compare_semver,
    endpoint_origin,
    manifest_hash,
    parse_deep_link,
    parse_manifest_json,
    validate_authorization,
    validate_manifest,
    validate_policy,
    validate_revocations,
    verify_authorization_signature,
    verify_challenge,
    verify_manifest_signature,
    verify_policy_signature,
    verify_revocations_signature,
)
from .types import (
    MAX_AUDIT_EVENTS,
    RAPPID_CARD_PRODUCTION_PROFILE,
    RAPPID_CARD_PROTOCOL,
    RAPPID_CARD_RUNTIME_NAME,
    RAPPID_CARD_RUNTIME_VERSION,
    RAPPID_CARD_TEST_PROFILE,
    CardManifest,
    CardProviders,
    CardSnapshot,
    CardStateStore,
    RappidCardError,
    RappidCardReconnectError,
)


def initial_card_snapshot() -> CardSnapshot:
    return {
        "state": "idle",
        "outcome": "pending",
        "error": None,
        "manifestHash": None,
        "deepLink": None,
        "preview": None,
        "hydrated": [],
        "audit": [],
    }


def reduce_card_state(
    snapshot: CardSnapshot, transition: Dict[str, Any]
) -> CardSnapshot:
    """Pure state transition. Providers are never called from this function."""
    prior_audit = snapshot["audit"]
    sequence = prior_audit[-1]["seq"] + 1 if prior_audit else 1
    audit = [
        *prior_audit,
        {
            "seq": sequence,
            "state": transition["state"],
            "event": transition["event"],
            "detail": transition["detail"],
        },
    ][-MAX_AUDIT_EVENTS:]
    result = {**snapshot, "state": transition["state"], "audit": audit}
    for key in (
        "outcome",
        "error",
        "manifestHash",
        "deepLink",
        "preview",
        "hydrated",
    ):
        if key in transition:
            result[key] = transition[key]
    return result


def _fail(snapshot: CardSnapshot, error: RappidCardError) -> CardSnapshot:
    return reduce_card_state(
        snapshot,
        {
            "state": "failed",
            "event": "card.failed",
            "detail": error.code,
            "outcome": "failed",
            "error": {"code": error.code, "message": error.message},
        },
    )


def _preview_for(
    manifest: CardManifest, trust: Dict[str, Any]
) -> Dict[str, Any]:
    policy = trust["policy"]
    authorization = trust["authorization"]
    revocations = trust["revocations"]
    return {
        "rappid": manifest["rappid"],
        "profile": manifest["profile"],
        "policyId": policy["policyId"],
        "authorizationId": authorization["authorizationId"],
        "endpoint": manifest["endpoint"],
        "origin": trust["origin"],
        "issuerKeyId": manifest["signature"]["keyId"],
        "classification": manifest["classification"],
        "scopes": list(manifest["scopes"]),
        "policySequence": policy["sequence"],
        "authorizationSequence": authorization["sequence"],
        "revocationSequence": revocations["sequence"],
        "parts": [
            {
                "name": part["name"],
                "hash": part["hash"],
                "bytes": part["bytes"],
                "mediaType": part["mediaType"],
                "required": part["required"],
            }
            for part in manifest["parts"]
        ],
    }


def _parse_time(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def _assert_current(
    not_before: str,
    not_after: str,
    now: datetime,
    code_prefix: str,
) -> None:
    if _parse_time(not_before) > now:
        raise RappidCardError(
            f"{code_prefix}_not_yet_valid",
            f"{code_prefix.replace('_', ' ')} has not reached its validity window",
        )
    if _parse_time(not_after) <= now:
        raise RappidCardError(
            f"{code_prefix}_expired",
            f"{code_prefix.replace('_', ' ')} has expired",
        )


def _assert_runtime(runtime: Dict[str, str], code: str) -> None:
    if (
        runtime["name"] != RAPPID_CARD_RUNTIME_NAME
        or compare_semver(
            RAPPID_CARD_RUNTIME_VERSION, runtime["minimum"]
        )
        < 0
        or compare_semver(
            RAPPID_CARD_RUNTIME_VERSION, runtime["maximum"]
        )
        > 0
    ):
        raise RappidCardError(
            code,
            f"requires {runtime['name']} {runtime['minimum']}..{runtime['maximum']}",
        )


def _expected_algorithm(allow_test_profile: bool) -> str:
    return "ed25519-test" if allow_test_profile else "ed25519"


def _assert_profile(
    manifest: CardManifest, allow_test_profile: bool
) -> str:
    if (
        not allow_test_profile
        and manifest["profile"] == RAPPID_CARD_TEST_PROFILE
    ):
        raise RappidCardError(
            "test_profile_forbidden",
            "production mode refuses the test profile",
        )
    profile = (
        RAPPID_CARD_TEST_PROFILE
        if allow_test_profile
        else RAPPID_CARD_PRODUCTION_PROFILE
    )
    algorithm = _expected_algorithm(allow_test_profile)
    if manifest["profile"] != profile:
        raise RappidCardError(
            "fixture_profile_required"
            if allow_test_profile
            else "profile_forbidden",
            "fixture mode accepts only the synthetic test profile"
            if allow_test_profile
            else "production mode requires the production profile",
        )
    if (
        manifest["signature"]["algorithm"] != algorithm
        or manifest["challenge"]["algorithm"] != algorithm
    ):
        raise RappidCardError(
            "fixture_signature_required"
            if allow_test_profile
            else "test_signature_forbidden",
            "fixture mode requires Ed25519 test signatures"
            if allow_test_profile
            else "production mode refuses synthetic test signatures",
        )
    return algorithm


def _verified_trust(
    manifest: CardManifest,
    link_hash: str,
    providers: CardProviders,
    allow_test_profile: bool,
    now: datetime,
    preflight: Dict[str, Any],
) -> Dict[str, Any]:
    _assert_profile(manifest, allow_test_profile)
    _assert_current(
        manifest["issuedAt"], manifest["expiresAt"], now, "card"
    )
    if manifest["protocol"] != RAPPID_CARD_PROTOCOL:
        raise RappidCardError(
            "incompatible_protocol",
            f"card requires {manifest['protocol']}; runtime provides "
            f"{RAPPID_CARD_PROTOCOL}",
        )
    _assert_runtime(manifest["runtime"], "incompatible_runtime")
    policy = preflight["policy"]
    authority_key = preflight["authorityKey"]
    origin = preflight["origin"]
    if policy["policyId"] != manifest["policyId"]:
        raise RappidCardError(
            "policy_mismatch", "signed policy id does not match the card"
        )
    if manifest["profile"] not in policy["allowedProfiles"]:
        raise RappidCardError(
            "profile_forbidden",
            "signed habitat policy does not allow this card profile",
        )
    if policy["protocol"] != manifest["protocol"]:
        raise RappidCardError(
            "policy_protocol_mismatch",
            "signed habitat policy does not authorize this protocol",
        )
    raw_authorization = providers.get_authorization(
        manifest["policyId"],
        manifest["signature"]["keyId"],
        manifest["rappid"],
    )
    if raw_authorization is None:
        raise RappidCardError(
            "unknown_key",
            f"no signed authorization binds "
            f"{manifest['signature']['keyId']} to {manifest['rappid']}",
        )
    authorization = validate_authorization(raw_authorization)
    if (
        authorization["signature"]["keyId"]
        != policy["signature"]["keyId"]
        or authorization["signature"]["algorithm"]
        != policy["signature"]["algorithm"]
        or not verify_authorization_signature(
            authorization, authority_key
        )
    ):
        raise RappidCardError(
            "authorization_signature_invalid",
            "signer authorization verification failed",
        )
    if (
        authorization["policyId"] != policy["policyId"]
        or authorization["subjectRappid"] != manifest["rappid"]
        or authorization["signerKeyId"]
        != manifest["signature"]["keyId"]
        or authorization["signerAlgorithm"]
        != manifest["signature"]["algorithm"]
    ):
        raise RappidCardError(
            "signer_subject_unauthorized",
            "signed authorization does not bind this signer to this RAPPID",
        )
    _assert_current(
        authorization["notBefore"],
        authorization["notAfter"],
        now,
        "authorization",
    )
    if origin not in authorization["approvedOrigins"]:
        raise RappidCardError(
            "signer_origin_unauthorized",
            f"signer authorization does not permit endpoint origin {origin}",
        )
    if not verify_manifest_signature(
        manifest, authorization["signerPublicKey"]
    ):
        raise RappidCardError(
            "signature_invalid", "card signature verification failed"
        )

    if (
        classification_rank(manifest["classification"])
        > classification_rank(policy["maxClassification"])
        or classification_rank(manifest["classification"])
        > classification_rank(authorization["maxClassification"])
    ):
        raise RappidCardError(
            "classification_violation",
            f"card classification {manifest['classification']} exceeds signed authority",
        )
    policy_scopes = set(policy["grantedScopes"])
    authorization_scopes = set(authorization["grantedScopes"])
    for part in manifest["parts"]:
        if (
            classification_rank(part["classification"])
            > classification_rank(manifest["classification"])
            or classification_rank(part["classification"])
            > classification_rank(policy["maxClassification"])
            or classification_rank(part["classification"])
            > classification_rank(authorization["maxClassification"])
        ):
            raise RappidCardError(
                "classification_violation",
                f"part {part['name']} exceeds the permitted classification",
            )
        if (
            part["scope"] not in manifest["scopes"]
            or part["scope"] not in policy_scopes
            or part["scope"] not in authorization_scopes
        ):
            raise RappidCardError(
                "insufficient_scope",
                f"part {part['name']} requires {part['scope']}",
            )

    raw_revocations = providers.get_revocations(policy["policyId"])
    if raw_revocations is None:
        raise RappidCardError(
            "revocation_view_missing",
            "signed revocation view is unavailable",
        )
    revocations = validate_revocations(raw_revocations)
    if (
        revocations["policyId"] != policy["policyId"]
        or revocations["signature"]["keyId"]
        != policy["signature"]["keyId"]
        or revocations["signature"]["algorithm"]
        != policy["signature"]["algorithm"]
        or not verify_revocations_signature(
            revocations, authority_key
        )
    ):
        raise RappidCardError(
            "revocation_signature_invalid",
            "signed revocation view verification failed",
        )
    _assert_current(
        revocations["issuedAt"],
        revocations["expiresAt"],
        now,
        "revocation_view",
    )
    if (
        link_hash in revocations["revokedManifestHashes"]
        or manifest["signature"]["keyId"]
        in revocations["revokedSignerKeyIds"]
        or authorization["authorizationId"]
        in revocations["revokedAuthorizationIds"]
    ):
        raise RappidCardError(
            "revoked", "card, signer, or signer authorization is revoked"
        )
    return {
        "policy": policy,
        "authorization": authorization,
        "revocations": revocations,
        "origin": origin,
        "state": {
            "policyId": policy["policyId"],
            "policySequence": policy["sequence"],
            "policyHash": canonical_document_hash(policy),
            "authorizationId": authorization["authorizationId"],
            "authorizationSequence": authorization["sequence"],
            "authorizationHash": canonical_document_hash(authorization),
            "revocationSequence": revocations["sequence"],
            "revocationHash": canonical_document_hash(revocations),
            "nonce": manifest["nonce"],
            "manifestHash": link_hash,
        },
    }


def _verified_policy_for_endpoint(
    endpoint: str,
    providers: CardProviders,
    state_store: CardStateStore,
    allow_test_profile: bool,
    now: datetime,
) -> Dict[str, Any]:
    algorithm = _expected_algorithm(allow_test_profile)
    origin = endpoint_origin(endpoint)
    raw_policy = providers.get_policy_for_origin(origin)
    if raw_policy is None:
        raise RappidCardError(
            "policy_not_found",
            f"no signed habitat policy is configured for endpoint origin {origin}",
        )
    policy = validate_policy(raw_policy)
    if policy["signature"]["algorithm"] != algorithm:
        raise RappidCardError(
            (
                "test_signature_forbidden"
                if not allow_test_profile
                and policy["signature"]["algorithm"] == "ed25519-test"
                else "policy_signature_invalid"
            ),
            (
                "production mode refuses synthetic test signatures"
                if not allow_test_profile
                and policy["signature"]["algorithm"] == "ed25519-test"
                else "signed policy uses the wrong trust profile"
            ),
        )
    authority_key = providers.get_authority_key(
        policy["signature"]["keyId"],
        policy["signature"]["algorithm"],
    )
    if authority_key is None:
        raise RappidCardError(
            "unknown_authority",
            f"policy authority {policy['signature']['keyId']} is unknown",
        )
    if not verify_policy_signature(policy, authority_key):
        raise RappidCardError(
            "policy_signature_invalid",
            "signed habitat policy verification failed",
        )
    _assert_current(
        policy["issuedAt"], policy["expiresAt"], now, "policy"
    )
    if policy["protocol"] != RAPPID_CARD_PROTOCOL:
        raise RappidCardError(
            "policy_protocol_mismatch",
            "signed habitat policy does not authorize this protocol",
        )
    _assert_runtime(policy["runtime"], "policy_runtime_mismatch")
    if origin not in policy["approvedOrigins"]:
        raise RappidCardError(
            "origin_not_approved",
            f"endpoint origin {origin} is not approved by signed policy",
        )
    state_store.record_policy(
        policy["policyId"],
        policy["sequence"],
        canonical_document_hash(policy),
    )
    return {
        "policy": policy,
        "authorityKey": authority_key,
        "origin": origin,
    }


def _hydrate_part(
    manifest: CardManifest,
    index: int,
    providers: CardProviders,
    maximum_reconnects: int,
    on_reconnect: Any,
) -> Optional[Dict[str, Any]]:
    part = manifest["parts"][index]
    reconnects = 0
    while True:
        try:
            content = providers.get_part(part["hash"])
            if content is None:
                if not part["required"]:
                    return None
                raise RappidCardError(
                    "missing_part",
                    f"required part {part['name']} is unavailable",
                )
            if len(content) != part["bytes"]:
                raise RappidCardError(
                    "part_size_mismatch",
                    f"part {part['name']} does not match its declared byte count",
                )
            if sha256_hex(content) != part["hash"]:
                raise RappidCardError(
                    "part_hash_mismatch",
                    f"part {part['name']} does not match its content address",
                )
            return {
                "name": part["name"],
                "hash": part["hash"],
                "bytes": part["bytes"],
                "mediaType": part["mediaType"],
            }
        except RappidCardReconnectError:
            if reconnects >= maximum_reconnects:
                raise
            reconnects += 1
            on_reconnect()


def _simulate_rappid_card(
    deep_link: str,
    *,
    approve: bool,
    providers: CardProviders,
    state_store: CardStateStore,
    allow_test_profile: bool,
    now: datetime,
    max_reconnects: int = 1,
) -> CardSnapshot:
    snapshot = initial_card_snapshot()
    try:
        link = parse_deep_link(deep_link)
        snapshot = reduce_card_state(
            snapshot,
            {
                "state": "parsed",
                "event": "link.parsed",
                "detail": link["endpoint"],
                "manifestHash": link["manifestHash"],
                "deepLink": link["deepLink"],
            },
        )
        preflight = _verified_policy_for_endpoint(
            link["endpoint"],
            providers,
            state_store,
            allow_test_profile,
            now,
        )
        raw = providers.get_manifest(
            link["endpoint"], link["manifestHash"]
        )
        if raw is None:
            raise RappidCardError(
                "manifest_not_found", "manifest provider returned no card"
            )
        manifest = (
            parse_manifest_json(raw)
            if isinstance(raw, str)
            else validate_manifest(raw)
        )
        if manifest_hash(manifest) != link["manifestHash"]:
            raise RappidCardError(
                "manifest_hash_mismatch",
                "manifest hash does not match deep link",
            )
        if (
            manifest["rappid"] != link["rappid"]
            or manifest["endpoint"] != link["endpoint"]
            or manifest["nonce"] != link["nonce"]
        ):
            raise RappidCardError(
                "link_manifest_mismatch",
                "manifest identity, endpoint, or nonce does not match deep link",
            )
        trust = _verified_trust(
            manifest,
            link["manifestHash"],
            providers,
            allow_test_profile,
            now,
            preflight,
        )
        state_store.record(trust["state"], False)
        snapshot = reduce_card_state(
            snapshot,
            {
                "state": "verified",
                "event": "card.verified",
                "detail": trust["authorization"]["authorizationId"],
            },
        )
        snapshot = reduce_card_state(
            snapshot,
            {
                "state": "preview",
                "event": "preview.ready",
                "detail": f"{len(manifest['parts'])} content-addressed parts",
                "preview": _preview_for(manifest, trust),
            },
        )
        if not approve:
            return snapshot
        snapshot = reduce_card_state(
            snapshot,
            {
                "state": "approved",
                "event": "approval.explicit",
                "detail": "developer approved hydration",
            },
        )
        state_store.record(trust["state"], True)
        snapshot = reduce_card_state(
            snapshot,
            {
                "state": "hydrating",
                "event": "hydration.started",
                "detail": f"{len(manifest['parts'])} permitted parts",
            },
        )
        hydrated = []
        for index, manifest_part in enumerate(manifest["parts"]):

            def reconnect(part_name: str = manifest_part["name"]) -> None:
                nonlocal snapshot
                snapshot = reduce_card_state(
                    snapshot,
                    {
                        "state": "hydrating",
                        "event": "hydration.reconnected",
                        "detail": part_name,
                    },
                )

            part = _hydrate_part(
                manifest,
                index,
                providers,
                max_reconnects,
                reconnect,
            )
            if part is not None:
                hydrated.append(part)
            snapshot = reduce_card_state(
                snapshot,
                {
                    "state": "hydrating",
                    "event": "part.hydrated",
                    "detail": manifest_part["name"],
                    "hydrated": list(hydrated),
                },
            )
        snapshot = reduce_card_state(
            snapshot,
            {
                "state": "challenging",
                "event": "challenge.started",
                "detail": manifest["challenge"]["keyId"],
            },
        )
        request = {
            "algorithm": manifest["challenge"]["algorithm"],
            "keyId": manifest["challenge"]["keyId"],
            "manifestHash": link["manifestHash"],
            "nonce": manifest["nonce"],
            "partHashes": [part["hash"] for part in hydrated],
        }
        response = providers.challenge_response(request)
        if not verify_challenge(
            response,
            request,
            trust["authorization"]["signerPublicKey"],
        ):
            raise RappidCardError(
                "challenge_failed",
                "continuity challenge verification failed",
            )
        return reduce_card_state(
            snapshot,
            {
                "state": "awake",
                "event": "card.awake",
                "detail": f"{len(hydrated)} verified parts",
                "outcome": "awake",
                "error": None,
            },
        )
    except RappidCardError as error:
        return _fail(snapshot, error)
    except Exception as error:
        return _fail(snapshot, RappidCardError("provider_error", str(error)))


def simulate_rappid_card(
    deep_link: str,
    *,
    approve: bool,
    providers: CardProviders,
    state_store: CardStateStore,
    max_reconnects: int = 1,
) -> CardSnapshot:
    from .sqlite_state_store import SqliteCardStateStore

    if not isinstance(state_store, SqliteCardStateStore):
        return _fail(
            initial_card_snapshot(),
            RappidCardError(
                "durable_state_required",
                "production mode requires the transactional SQLite card state store",
            ),
        )
    return _simulate_rappid_card(
        deep_link,
        approve=approve,
        providers=providers,
        state_store=state_store,
        allow_test_profile=False,
        now=datetime.now(timezone.utc),
        max_reconnects=max_reconnects,
    )


def simulate_rappid_card_fixture_mode(
    deep_link: str,
    *,
    approve: bool,
    providers: CardProviders,
    state_store: CardStateStore,
    fixture_now: str = "2035-01-01T12:00:00Z",
    max_reconnects: int = 1,
) -> CardSnapshot:
    return _simulate_rappid_card(
        deep_link,
        approve=approve,
        providers=providers,
        state_store=state_store,
        allow_test_profile=True,
        now=_parse_time(fixture_now),
        max_reconnects=max_reconnects,
    )
