"""Pure reducer plus injected-effect RAPPID card simulation driver."""

from __future__ import annotations

from datetime import datetime
from typing import Any, Dict, Optional

from openrappter.rappids.canonical import sha256_hex

from .contract import (
    classification_rank,
    compare_semver,
    manifest_hash,
    parse_deep_link,
    parse_manifest_json,
    validate_manifest,
    verify_challenge,
    verify_signature,
)
from .replay_cache import BoundedReplayCache
from .types import (
    MAX_AUDIT_EVENTS,
    RAPPID_CARD_PRODUCTION_PROFILE,
    RAPPID_CARD_TEST_PROFILE,
    CardManifest,
    CardPolicy,
    CardProviders,
    CardSnapshot,
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


def _preview_for(manifest: CardManifest) -> Dict[str, Any]:
    return {
        "rappid": manifest["rappid"],
        "profile": manifest["profile"],
        "endpoint": manifest["endpoint"],
        "issuerKeyId": manifest["signature"]["keyId"],
        "classification": manifest["classification"],
        "scopes": list(manifest["scopes"]),
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


def _verify_mode(manifest: CardManifest, mode: str) -> None:
    if mode == "production":
        if manifest["profile"] == RAPPID_CARD_TEST_PROFILE:
            raise RappidCardError(
                "test_profile_forbidden",
                "production mode refuses the test profile",
            )
        if (
            manifest["signature"]["algorithm"] == "hmac-sha256-test"
            or manifest["challenge"]["algorithm"] == "hmac-sha256-test"
        ):
            raise RappidCardError(
                "test_signature_forbidden",
                "production mode refuses synthetic test authenticators",
            )
        if manifest["profile"] != RAPPID_CARD_PRODUCTION_PROFILE:
            raise RappidCardError(
                "profile_forbidden",
                "production mode requires the production profile",
            )
        return
    if (
        manifest["profile"] != RAPPID_CARD_TEST_PROFILE
        or manifest["signature"]["algorithm"] != "hmac-sha256-test"
        or manifest["challenge"]["algorithm"] != "hmac-sha256-test"
    ):
        raise RappidCardError(
            "fixture_profile_required",
            "fixture mode accepts only the synthetic test profile and authenticators",
        )


def _parse_time(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def _verify_policy(
    manifest: CardManifest, policy: CardPolicy
) -> None:
    _verify_mode(manifest, policy.mode)
    try:
        now = _parse_time(policy.now)
    except ValueError as error:
        raise RappidCardError(
            "policy_invalid", "policy.now must be RFC3339"
        ) from error
    if _parse_time(manifest["issuedAt"]) > now:
        raise RappidCardError("not_yet_valid", "card has not reached issuedAt")
    if _parse_time(manifest["expiresAt"]) <= now:
        raise RappidCardError("expired", "card has expired")
    if manifest["protocol"] != policy.protocol:
        raise RappidCardError(
            "incompatible_protocol",
            f"card requires {manifest['protocol']}; runtime provides {policy.protocol}",
        )
    runtime = manifest["runtime"]
    if (
        runtime["name"] != policy.runtime_name
        or compare_semver(policy.runtime_version, runtime["minimum"]) < 0
        or compare_semver(policy.runtime_version, runtime["maximum"]) > 0
    ):
        raise RappidCardError(
            "incompatible_runtime",
            f"card requires {runtime['name']} {runtime['minimum']}..{runtime['maximum']}",
        )
    if classification_rank(manifest["classification"]) > classification_rank(
        policy.max_classification
    ):
        raise RappidCardError(
            "classification_violation",
            f"card classification {manifest['classification']} exceeds "
            f"{policy.max_classification}",
        )
    granted = set(policy.granted_scopes)
    for part in manifest["parts"]:
        if (
            classification_rank(part["classification"])
            > classification_rank(manifest["classification"])
            or classification_rank(part["classification"])
            > classification_rank(policy.max_classification)
        ):
            raise RappidCardError(
                "classification_violation",
                f"part {part['name']} exceeds the permitted classification",
            )
        if (
            part["scope"] not in manifest["scopes"]
            or part["scope"] not in granted
        ):
            raise RappidCardError(
                "insufficient_scope",
                f"part {part['name']} requires {part['scope']}",
            )


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


def simulate_rappid_card(
    deep_link: str,
    *,
    approve: bool,
    policy: CardPolicy,
    providers: CardProviders,
    replay_cache: Optional[BoundedReplayCache] = None,
    max_reconnects: int = 1,
) -> CardSnapshot:
    snapshot = initial_card_snapshot()
    replay = replay_cache if replay_cache is not None else BoundedReplayCache()
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
        raw = providers.get_manifest(link["endpoint"], link["manifestHash"])
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
        _verify_policy(manifest, policy)
        if providers.is_revoked(
            link["manifestHash"], manifest["signature"]["keyId"]
        ):
            raise RappidCardError(
                "revoked", "card or signing key is revoked"
            )
        signature_key = providers.get_key(
            manifest["signature"]["keyId"],
            manifest["signature"]["algorithm"],
        )
        if signature_key is None:
            raise RappidCardError(
                "unknown_key",
                f"signing key {manifest['signature']['keyId']} is unknown",
            )
        if not verify_signature(manifest, signature_key):
            raise RappidCardError(
                "signature_invalid", "card signature verification failed"
            )
        if replay.has(manifest["nonce"]):
            raise RappidCardError(
                "duplicate_nonce", "card nonce has already been accepted"
            )
        snapshot = reduce_card_state(
            snapshot,
            {
                "state": "verified",
                "event": "card.verified",
                "detail": manifest["signature"]["keyId"],
            },
        )
        snapshot = reduce_card_state(
            snapshot,
            {
                "state": "preview",
                "event": "preview.ready",
                "detail": f"{len(manifest['parts'])} content-addressed parts",
                "preview": _preview_for(manifest),
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
        if replay.has(manifest["nonce"]):
            raise RappidCardError(
                "duplicate_nonce", "card nonce has already been accepted"
            )
        replay.add(manifest["nonce"])
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
        challenge_key = providers.get_key(
            manifest["challenge"]["keyId"],
            manifest["challenge"]["algorithm"],
        )
        if challenge_key is None:
            raise RappidCardError(
                "unknown_challenge_key",
                f"challenge key {manifest['challenge']['keyId']} is unknown",
            )
        request = {
            "algorithm": manifest["challenge"]["algorithm"],
            "keyId": manifest["challenge"]["keyId"],
            "manifestHash": link["manifestHash"],
            "nonce": manifest["nonce"],
            "partHashes": [part["hash"] for part in hydrated],
        }
        response = providers.challenge_response(request)
        if not verify_challenge(response, request, challenge_key):
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
