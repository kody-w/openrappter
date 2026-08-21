"""Strict card parsing, canonical hashing, compact links, and authenticators."""

from __future__ import annotations

import hashlib
import hmac
import json
import re
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, List, Optional, Tuple
from urllib.parse import parse_qsl, unquote, urlsplit

from openrappter.rappids.canonical import canonical_json, sha256_hex

from .types import (
    RAPPID_CARD_PRODUCTION_PROFILE,
    RAPPID_CARD_SCHEMA,
    RAPPID_CARD_TEST_PROFILE,
    CardManifest,
    RappidCardError,
)

CARD_SIGNATURE_DOMAIN = "rappid-card/1:signature"
CARD_CHALLENGE_DOMAIN = "rappid-card/1:continuity"

HEX_32 = re.compile(r"^[0-9a-f]{32}$")
HEX_64 = re.compile(r"^[0-9a-f]{64}$")
ENDPOINT = re.compile(r"^[a-z][a-z0-9.-]{0,63}$")
KEY_ID = re.compile(r"^[a-z][a-z0-9._-]{0,63}$")
RAPPID = re.compile(
    r"^rappid:@[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?"
    r"/[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?:[0-9a-f]{64}$"
)
PROTOCOL = re.compile(r"^rappid-link/[1-9][0-9]*$")
SEMVER = re.compile(r"^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$")
RFC3339_UTC = re.compile(
    r"^[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])"
    r"T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]Z$"
)

PROFILES = {RAPPID_CARD_TEST_PROFILE, RAPPID_CARD_PRODUCTION_PROFILE}
CLASSIFICATIONS = {"public", "internal", "restricted"}
SCOPES = {
    "identity:read",
    "traits:read",
    "skill:hydrate",
    "sonic:hydrate",
    "capability:hydrate",
}
PART_NAMES = {
    "identity",
    "traits",
    "skill-manifest",
    "sonic-profile",
    "capability-manifest",
}
MEDIA_TYPES = {
    "application/json",
    "text/plain",
    "application/vnd.rapp.skill+json",
    "application/vnd.rapp.sonic+json",
    "application/vnd.rapp.capability+json",
}
ALGORITHMS = {"hmac-sha256-test", "hmac-sha256"}


def _object_at(value: Any, path: str) -> Dict[str, Any]:
    if not isinstance(value, dict):
        raise RappidCardError("schema_invalid", f"{path} must be an object")
    if not all(isinstance(key, str) for key in value):
        raise RappidCardError("schema_invalid", f"{path} keys must be strings")
    return value


def _closed_object(
    value: Any, path: str, required: Iterable[str]
) -> Dict[str, Any]:
    obj = _object_at(value, path)
    expected = sorted(required)
    keys = sorted(obj)
    if keys != expected:
        unexpected = [key for key in keys if key not in expected]
        missing = [key for key in expected if key not in keys]
        details = []
        if unexpected:
            details.append(f"unexpected {', '.join(unexpected)}")
        if missing:
            details.append(f"missing {', '.join(missing)}")
        suffix = f": {'; '.join(details)}" if details else ""
        raise RappidCardError("schema_invalid", f"{path} is closed{suffix}")
    return obj


def _string_at(
    obj: Dict[str, Any],
    key: str,
    path: str,
    pattern: Optional[re.Pattern[str]] = None,
) -> str:
    value = obj.get(key)
    if not isinstance(value, str) or (pattern is not None and not pattern.fullmatch(value)):
        raise RappidCardError("schema_invalid", f"{path}.{key} is invalid")
    return value


def _enum_at(
    obj: Dict[str, Any],
    key: str,
    path: str,
    values: set[str],
) -> str:
    value = _string_at(obj, key, path)
    if value not in values:
        raise RappidCardError("schema_invalid", f"{path}.{key} is invalid")
    return value


def _validate_timestamp(value: str, path: str) -> None:
    if not RFC3339_UTC.fullmatch(value):
        raise RappidCardError("schema_invalid", f"{path} must be UTC RFC3339 seconds")
    try:
        parsed = datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ").replace(
            tzinfo=timezone.utc
        )
    except ValueError as error:
        raise RappidCardError(
            "schema_invalid", f"{path} must be UTC RFC3339 seconds"
        ) from error
    if parsed.strftime("%Y-%m-%dT%H:%M:%SZ") != value:
        raise RappidCardError("schema_invalid", f"{path} must be UTC RFC3339 seconds")


def _validate_authenticator(
    value: Any, path: str, signature: bool
) -> Dict[str, str]:
    obj = _closed_object(
        value,
        path,
        ["algorithm", "keyId", "value"]
        if signature
        else ["algorithm", "keyId"],
    )
    result = {
        "algorithm": _enum_at(obj, "algorithm", path, ALGORITHMS),
        "keyId": _string_at(obj, "keyId", path, KEY_ID),
    }
    if signature:
        result["value"] = _string_at(obj, "value", path, HEX_64)
    return result


def _reject_duplicate_keys(pairs: List[Tuple[str, Any]]) -> Dict[str, Any]:
    result: Dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise RappidCardError(
                "json_invalid", f"duplicate JSON object key: {key}"
            )
        result[key] = value
    return result


def parse_manifest_json(raw: str) -> CardManifest:
    if len(raw.encode("utf-8")) > 128 * 1024:
        raise RappidCardError("schema_invalid", "card manifest exceeds 128 KiB")
    try:
        value = json.loads(raw, object_pairs_hook=_reject_duplicate_keys)
    except RappidCardError:
        raise
    except (TypeError, ValueError, json.JSONDecodeError) as error:
        raise RappidCardError("json_invalid", str(error)) from error
    return validate_manifest(value)


def validate_manifest(value: Any) -> CardManifest:
    manifest = _closed_object(
        value,
        "card",
        [
            "schema",
            "profile",
            "rappid",
            "endpoint",
            "nonce",
            "issuedAt",
            "expiresAt",
            "protocol",
            "runtime",
            "classification",
            "scopes",
            "parts",
            "challenge",
            "signature",
        ],
    )
    if _string_at(manifest, "schema", "card") != RAPPID_CARD_SCHEMA:
        raise RappidCardError("schema_invalid", "card.schema is invalid")
    profile = _enum_at(manifest, "profile", "card", PROFILES)
    rappid = _string_at(manifest, "rappid", "card", RAPPID)
    endpoint = _string_at(manifest, "endpoint", "card", ENDPOINT)
    nonce = _string_at(manifest, "nonce", "card", HEX_32)
    issued_at = _string_at(manifest, "issuedAt", "card")
    expires_at = _string_at(manifest, "expiresAt", "card")
    _validate_timestamp(issued_at, "card.issuedAt")
    _validate_timestamp(expires_at, "card.expiresAt")
    if expires_at <= issued_at:
        raise RappidCardError(
            "schema_invalid", "card.expiresAt must be later than card.issuedAt"
        )
    protocol = _string_at(manifest, "protocol", "card", PROTOCOL)
    runtime = _closed_object(
        manifest["runtime"],
        "card.runtime",
        ["name", "minimum", "maximum"],
    )
    runtime_value = {
        "name": _string_at(
            runtime, "name", "card.runtime", re.compile(r"^[a-z][a-z0-9-]{0,31}$")
        ),
        "minimum": _string_at(runtime, "minimum", "card.runtime", SEMVER),
        "maximum": _string_at(runtime, "maximum", "card.runtime", SEMVER),
    }
    if compare_semver(runtime_value["minimum"], runtime_value["maximum"]) > 0:
        raise RappidCardError(
            "schema_invalid",
            "card.runtime.minimum must not exceed maximum",
        )
    classification = _enum_at(
        manifest, "classification", "card", CLASSIFICATIONS
    )
    scopes_value = manifest.get("scopes")
    if (
        not isinstance(scopes_value, list)
        or not 1 <= len(scopes_value) <= 6
    ):
        raise RappidCardError(
            "schema_invalid", "card.scopes must contain 1..6 items"
        )
    scopes: List[str] = []
    for index, scope in enumerate(scopes_value):
        if not isinstance(scope, str) or scope not in SCOPES:
            raise RappidCardError(
                "schema_invalid", f"card.scopes[{index}] is invalid"
            )
        scopes.append(scope)
    if len(set(scopes)) != len(scopes):
        raise RappidCardError("schema_invalid", "card.scopes must be unique")
    parts_value = manifest.get("parts")
    if (
        not isinstance(parts_value, list)
        or not 1 <= len(parts_value) <= 6
    ):
        raise RappidCardError(
            "schema_invalid", "card.parts must contain 1..6 items"
        )
    parts = []
    for index, part in enumerate(parts_value):
        path = f"card.parts[{index}]"
        obj = _closed_object(
            part,
            path,
            [
                "name",
                "hash",
                "bytes",
                "mediaType",
                "classification",
                "scope",
                "required",
            ],
        )
        byte_count = obj.get("bytes")
        if (
            not isinstance(byte_count, int)
            or isinstance(byte_count, bool)
            or not 1 <= byte_count <= 65536
        ):
            raise RappidCardError("schema_invalid", f"{path}.bytes is invalid")
        if not isinstance(obj.get("required"), bool):
            raise RappidCardError("schema_invalid", f"{path}.required is invalid")
        parts.append(
            {
                "name": _enum_at(obj, "name", path, PART_NAMES),
                "hash": _string_at(obj, "hash", path, HEX_64),
                "bytes": byte_count,
                "mediaType": _enum_at(obj, "mediaType", path, MEDIA_TYPES),
                "classification": _enum_at(
                    obj, "classification", path, CLASSIFICATIONS
                ),
                "scope": _enum_at(obj, "scope", path, SCOPES),
                "required": obj["required"],
            }
        )
    if len({part["name"] for part in parts}) != len(parts):
        raise RappidCardError(
            "schema_invalid", "card.parts names must be unique"
        )
    if len({part["hash"] for part in parts}) != len(parts):
        raise RappidCardError(
            "schema_invalid", "card.parts hashes must be unique"
        )
    challenge = _validate_authenticator(
        manifest["challenge"], "card.challenge", False
    )
    signature = _validate_authenticator(
        manifest["signature"], "card.signature", True
    )
    return {
        "schema": RAPPID_CARD_SCHEMA,
        "profile": profile,
        "rappid": rappid,
        "endpoint": endpoint,
        "nonce": nonce,
        "issuedAt": issued_at,
        "expiresAt": expires_at,
        "protocol": protocol,
        "runtime": runtime_value,
        "classification": classification,
        "scopes": scopes,
        "parts": parts,
        "challenge": challenge,
        "signature": signature,
    }


def unsigned_manifest(manifest: CardManifest) -> CardManifest:
    return {key: value for key, value in manifest.items() if key != "signature"}


def canonical_manifest(manifest: CardManifest) -> str:
    return canonical_json(manifest)


def manifest_hash(manifest: CardManifest) -> str:
    return sha256_hex(canonical_manifest(manifest))


def _hmac_hex(key: bytes, message: str) -> str:
    return hmac.new(key, message.encode("utf-8"), hashlib.sha256).hexdigest()


def signature_value(manifest: CardManifest, key: bytes) -> str:
    return _hmac_hex(
        key,
        f"{CARD_SIGNATURE_DOMAIN}\n{canonical_json(manifest)}",
    )


def sign_manifest(
    manifest: CardManifest,
    algorithm: str,
    key_id: str,
    key: bytes,
) -> CardManifest:
    signed = {
        **manifest,
        "signature": {
            "algorithm": algorithm,
            "keyId": key_id,
            "value": signature_value(manifest, key),
        },
    }
    return validate_manifest(signed)


def verify_signature(manifest: CardManifest, key: bytes) -> bool:
    return hmac.compare_digest(
        manifest["signature"]["value"],
        signature_value(unsigned_manifest(manifest), key),
    )


def challenge_value(request: Dict[str, Any], key: bytes) -> str:
    hashes = ",".join(sorted(request["partHashes"]))
    return _hmac_hex(
        key,
        f"{CARD_CHALLENGE_DOMAIN}\n{request['manifestHash']}\n"
        f"{request['nonce']}\n{hashes}",
    )


def verify_challenge(
    response: str, request: Dict[str, Any], key: bytes
) -> bool:
    return bool(HEX_64.fullmatch(response)) and hmac.compare_digest(
        response, challenge_value(request, key)
    )


def make_deep_link(manifest: CardManifest, hash_value: Optional[str] = None) -> str:
    digest = hash_value if hash_value is not None else manifest_hash(manifest)
    return (
        f"rappid://link/{manifest['rappid']}?m={digest}"
        f"&e={manifest['endpoint']}&n={manifest['nonce']}"
    )


def parse_deep_link(value: str) -> Dict[str, str]:
    if len(value) > 2048 or not value.startswith("rappid://link/"):
        raise RappidCardError(
            "link_invalid", "deep link must use rappid://link/"
        )
    parsed = urlsplit(value)
    if parsed.scheme != "rappid" or parsed.netloc != "link" or parsed.fragment:
        raise RappidCardError(
            "link_invalid", "deep link authority or fragment is invalid"
        )
    pairs = parse_qsl(parsed.query, keep_blank_values=True, strict_parsing=True)
    keys = [key for key, _value in pairs]
    if (
        len(pairs) != 3
        or len(set(keys)) != 3
        or any(key not in keys for key in ("m", "e", "n"))
    ):
        raise RappidCardError(
            "link_invalid", "deep link must contain exactly m, e, and n"
        )
    params = dict(pairs)
    rappid = unquote(parsed.path.lstrip("/"))
    digest = params["m"]
    endpoint = params["e"]
    nonce = params["n"]
    if (
        not RAPPID.fullmatch(rappid)
        or not HEX_64.fullmatch(digest)
        or not ENDPOINT.fullmatch(endpoint)
        or not HEX_32.fullmatch(nonce)
    ):
        raise RappidCardError("link_invalid", "deep link fields are invalid")
    exact = f"rappid://link/{rappid}?m={digest}&e={endpoint}&n={nonce}"
    if value != exact:
        raise RappidCardError(
            "link_invalid", "deep link is not in canonical compact form"
        )
    return {
        "rappid": rappid,
        "manifestHash": digest,
        "endpoint": endpoint,
        "nonce": nonce,
        "deepLink": exact,
    }


def compare_semver(left: str, right: str) -> int:
    left_match = SEMVER.fullmatch(left)
    right_match = SEMVER.fullmatch(right)
    if left_match is None or right_match is None:
        raise RappidCardError("schema_invalid", "invalid semantic version")
    for left_value, right_value in zip(left_match.groups(), right_match.groups()):
        delta = int(left_value) - int(right_value)
        if delta:
            return -1 if delta < 0 else 1
    return 0


def classification_rank(value: str) -> int:
    return ["public", "internal", "restricted"].index(value)
