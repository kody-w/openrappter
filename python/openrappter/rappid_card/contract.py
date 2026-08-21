"""Strict card/trust parsing, canonical links, and Ed25519 attestations."""

from __future__ import annotations

import base64
import json
import re
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, List, Optional, Tuple
from urllib.parse import parse_qsl, quote, unquote, urlsplit

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import (
    Ed25519PrivateKey,
    Ed25519PublicKey,
)

from openrappter.rappids.canonical import canonical_json, sha256_hex

from .types import (
    RAPPID_CARD_AUTHORIZATION_SCHEMA,
    RAPPID_CARD_POLICY_SCHEMA,
    RAPPID_CARD_PRODUCTION_PROFILE,
    RAPPID_CARD_REVOCATIONS_SCHEMA,
    RAPPID_CARD_SCHEMA,
    RAPPID_CARD_TEST_PROFILE,
    CardManifest,
    RappidCardError,
)

CARD_SIGNATURE_DOMAIN = "rappid-card/1:signature"
CARD_POLICY_SIGNATURE_DOMAIN = "rappid-card/1:policy"
CARD_AUTHORIZATION_SIGNATURE_DOMAIN = "rappid-card/1:authorization"
CARD_REVOCATIONS_SIGNATURE_DOMAIN = "rappid-card/1:revocations"
CARD_CHALLENGE_DOMAIN = "rappid-card/1:continuity"

HEX_32 = re.compile(r"^[0-9a-f]{32}$")
HEX_64 = re.compile(r"^[0-9a-f]{64}$")
BASE64URL_32 = re.compile(r"^[A-Za-z0-9_-]{43}$")
BASE64URL_64 = re.compile(r"^[A-Za-z0-9_-]{86}$")
ENDPOINT_PATH = re.compile(r"^/[A-Za-z0-9._~/-]*$")
HOST = re.compile(r"^[a-z0-9.-]+$")
KEY_ID = re.compile(r"^[a-z][a-z0-9._-]{0,63}$")
POLICY_ID = re.compile(r"^[a-z][a-z0-9._-]{0,63}$")
AUTHORIZATION_ID = re.compile(r"^[a-z][a-z0-9._-]{0,63}$")
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
ALGORITHMS = {"ed25519-test", "ed25519"}


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
    if not isinstance(value, str) or (
        pattern is not None and not pattern.fullmatch(value)
    ):
        raise RappidCardError("schema_invalid", f"{path}.{key} is invalid")
    return value


def _integer_at(obj: Dict[str, Any], key: str, path: str) -> int:
    value = obj.get(key)
    if (
        not isinstance(value, int)
        or isinstance(value, bool)
        or value < 0
        or value > 2**53 - 1
    ):
        raise RappidCardError("schema_invalid", f"{path}.{key} is invalid")
    return value


def _enum_at(
    obj: Dict[str, Any], key: str, path: str, values: set[str]
) -> str:
    value = _string_at(obj, key, path)
    if value not in values:
        raise RappidCardError("schema_invalid", f"{path}.{key} is invalid")
    return value


def _string_array_at(
    obj: Dict[str, Any],
    key: str,
    path: str,
    *,
    values: Optional[set[str]] = None,
    pattern: Optional[re.Pattern[str]] = None,
    minimum: int = 0,
    maximum: int = 64,
) -> List[str]:
    raw = obj.get(key)
    if not isinstance(raw, list) or not minimum <= len(raw) <= maximum:
        raise RappidCardError(
            "schema_invalid",
            f"{path}.{key} must contain {minimum}..{maximum} items",
        )
    result = []
    for index, item in enumerate(raw):
        if (
            not isinstance(item, str)
            or (values is not None and item not in values)
            or (pattern is not None and not pattern.fullmatch(item))
        ):
            raise RappidCardError(
                "schema_invalid", f"{path}.{key}[{index}] is invalid"
            )
        result.append(item)
    if len(set(result)) != len(result):
        raise RappidCardError("schema_invalid", f"{path}.{key} must be unique")
    return result


def _validate_signature(value: Any, path: str) -> Dict[str, str]:
    obj = _closed_object(value, path, ["algorithm", "keyId", "value"])
    return {
        "algorithm": _enum_at(obj, "algorithm", path, ALGORITHMS),
        "keyId": _string_at(obj, "keyId", path, KEY_ID),
        "value": _string_at(obj, "value", path, BASE64URL_64),
    }


def _validate_authenticator(value: Any, path: str) -> Dict[str, str]:
    obj = _closed_object(value, path, ["algorithm", "keyId"])
    return {
        "algorithm": _enum_at(obj, "algorithm", path, ALGORITHMS),
        "keyId": _string_at(obj, "keyId", path, KEY_ID),
    }


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


def _validate_window(start: str, end: str, path: str) -> None:
    _validate_timestamp(start, f"{path}.start")
    _validate_timestamp(end, f"{path}.end")
    if end <= start:
        raise RappidCardError("schema_invalid", f"{path} end must be later than start")


def _validate_runtime(value: Any, path: str) -> Dict[str, str]:
    runtime = _closed_object(value, path, ["name", "minimum", "maximum"])
    result = {
        "name": _string_at(
            runtime, "name", path, re.compile(r"^[a-z][a-z0-9-]{0,31}$")
        ),
        "minimum": _string_at(runtime, "minimum", path, SEMVER),
        "maximum": _string_at(runtime, "maximum", path, SEMVER),
    }
    if compare_semver(result["minimum"], result["maximum"]) > 0:
        raise RappidCardError(
            "schema_invalid", f"{path}.minimum must not exceed maximum"
        )
    return result


def _canonical_url_parts(value: str) -> Tuple[Any, str, str]:
    try:
        parsed = urlsplit(value)
        port = parsed.port
    except ValueError as error:
        raise RappidCardError(
            "endpoint_invalid", "URL is not canonical"
        ) from error
    hostname = parsed.hostname
    if (
        hostname is None
        or not HOST.fullmatch(hostname)
        or parsed.scheme != "https"
    ):
        raise RappidCardError("endpoint_invalid", "URL is not canonical")
    origin = f"https://{hostname}"
    if port is not None and port != 443:
        origin += f":{port}"
    return parsed, origin, hostname


def validate_origin(value: str, path: str = "origin") -> str:
    if len(value) > 200 or "%" in value:
        raise RappidCardError("schema_invalid", f"{path} is invalid")
    try:
        parsed, origin, _hostname = _canonical_url_parts(value)
    except RappidCardError as error:
        raise RappidCardError("schema_invalid", f"{path} is invalid") from error
    if (
        parsed.username is not None
        or parsed.password is not None
        or parsed.path not in ("", "/")
        or parsed.query
        or parsed.fragment
        or origin != value
    ):
        raise RappidCardError("schema_invalid", f"{path} is invalid")
    return value


def validate_endpoint(value: str, path: str = "card.endpoint") -> str:
    if len(value) > 256 or "%" in value:
        raise RappidCardError(
            "endpoint_invalid", f"{path} is not a canonical HTTPS URL"
        )
    try:
        parsed, origin, _hostname = _canonical_url_parts(value)
    except RappidCardError as error:
        raise RappidCardError(
            "endpoint_invalid", f"{path} is not a canonical HTTPS URL"
        ) from error
    if (
        parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
    ):
        raise RappidCardError(
            "endpoint_secret_forbidden",
            f"{path} must not contain userinfo, query parameters, or fragments",
        )
    path_value = parsed.path or "/"
    canonical = origin + path_value
    if not ENDPOINT_PATH.fullmatch(path_value) or canonical != value:
        raise RappidCardError(
            "endpoint_invalid", f"{path} is not a canonical HTTPS URL"
        )
    return value


def endpoint_origin(endpoint: str) -> str:
    _parsed, origin, _hostname = _canonical_url_parts(
        validate_endpoint(endpoint)
    )
    return origin


def _approved_origins_at(
    obj: Dict[str, Any], key: str, path: str
) -> List[str]:
    return [
        validate_origin(origin, f"{path}.{key}[{index}]")
        for index, origin in enumerate(
            _string_array_at(obj, key, path, minimum=1, maximum=16)
        )
    ]


def _reject_duplicate_keys(pairs: List[Tuple[str, Any]]) -> Dict[str, Any]:
    result: Dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise RappidCardError("json_invalid", f"duplicate JSON object key: {key}")
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
            "policyId",
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
    policy_id = _string_at(manifest, "policyId", "card", POLICY_ID)
    rappid = _string_at(manifest, "rappid", "card", RAPPID)
    endpoint = validate_endpoint(_string_at(manifest, "endpoint", "card"))
    nonce = _string_at(manifest, "nonce", "card", HEX_32)
    issued_at = _string_at(manifest, "issuedAt", "card")
    expires_at = _string_at(manifest, "expiresAt", "card")
    _validate_window(issued_at, expires_at, "card.validity")
    protocol = _string_at(manifest, "protocol", "card", PROTOCOL)
    runtime = _validate_runtime(manifest["runtime"], "card.runtime")
    classification = _enum_at(
        manifest, "classification", "card", CLASSIFICATIONS
    )
    scopes = _string_array_at(
        manifest,
        "scopes",
        "card",
        values=SCOPES,
        minimum=1,
        maximum=6,
    )
    parts_value = manifest.get("parts")
    if not isinstance(parts_value, list) or not 1 <= len(parts_value) <= 6:
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
        raise RappidCardError("schema_invalid", "card.parts names must be unique")
    if len({part["hash"] for part in parts}) != len(parts):
        raise RappidCardError("schema_invalid", "card.parts hashes must be unique")
    challenge = _validate_authenticator(manifest["challenge"], "card.challenge")
    signature = _validate_signature(manifest["signature"], "card.signature")
    if (
        challenge["algorithm"] != signature["algorithm"]
        or challenge["keyId"] != signature["keyId"]
    ):
        raise RappidCardError(
            "schema_invalid",
            "card challenge must use the authorized signing key",
        )
    return {
        "schema": RAPPID_CARD_SCHEMA,
        "profile": profile,
        "policyId": policy_id,
        "rappid": rappid,
        "endpoint": endpoint,
        "nonce": nonce,
        "issuedAt": issued_at,
        "expiresAt": expires_at,
        "protocol": protocol,
        "runtime": runtime,
        "classification": classification,
        "scopes": scopes,
        "parts": parts,
        "challenge": challenge,
        "signature": signature,
    }


def validate_policy(value: Any) -> Dict[str, Any]:
    policy = _closed_object(
        value,
        "policy",
        [
            "schema",
            "policyId",
            "sequence",
            "issuedAt",
            "expiresAt",
            "allowedProfiles",
            "protocol",
            "runtime",
            "maxClassification",
            "grantedScopes",
            "approvedOrigins",
            "signature",
        ],
    )
    if _string_at(policy, "schema", "policy") != RAPPID_CARD_POLICY_SCHEMA:
        raise RappidCardError("schema_invalid", "policy.schema is invalid")
    issued_at = _string_at(policy, "issuedAt", "policy")
    expires_at = _string_at(policy, "expiresAt", "policy")
    _validate_window(issued_at, expires_at, "policy.validity")
    return {
        "schema": RAPPID_CARD_POLICY_SCHEMA,
        "policyId": _string_at(policy, "policyId", "policy", POLICY_ID),
        "sequence": _integer_at(policy, "sequence", "policy"),
        "issuedAt": issued_at,
        "expiresAt": expires_at,
        "allowedProfiles": _string_array_at(
            policy,
            "allowedProfiles",
            "policy",
            values=PROFILES,
            minimum=1,
            maximum=2,
        ),
        "protocol": _string_at(policy, "protocol", "policy", PROTOCOL),
        "runtime": _validate_runtime(policy["runtime"], "policy.runtime"),
        "maxClassification": _enum_at(
            policy, "maxClassification", "policy", CLASSIFICATIONS
        ),
        "grantedScopes": _string_array_at(
            policy,
            "grantedScopes",
            "policy",
            values=SCOPES,
            minimum=1,
            maximum=6,
        ),
        "approvedOrigins": _approved_origins_at(
            policy, "approvedOrigins", "policy"
        ),
        "signature": _validate_signature(policy["signature"], "policy.signature"),
    }


def validate_authorization(value: Any) -> Dict[str, Any]:
    authorization = _closed_object(
        value,
        "authorization",
        [
            "schema",
            "authorizationId",
            "policyId",
            "sequence",
            "subjectRappid",
            "signerKeyId",
            "signerAlgorithm",
            "signerPublicKey",
            "notBefore",
            "notAfter",
            "maxClassification",
            "grantedScopes",
            "approvedOrigins",
            "signature",
        ],
    )
    if (
        _string_at(authorization, "schema", "authorization")
        != RAPPID_CARD_AUTHORIZATION_SCHEMA
    ):
        raise RappidCardError("schema_invalid", "authorization.schema is invalid")
    not_before = _string_at(authorization, "notBefore", "authorization")
    not_after = _string_at(authorization, "notAfter", "authorization")
    _validate_window(not_before, not_after, "authorization.validity")
    return {
        "schema": RAPPID_CARD_AUTHORIZATION_SCHEMA,
        "authorizationId": _string_at(
            authorization,
            "authorizationId",
            "authorization",
            AUTHORIZATION_ID,
        ),
        "policyId": _string_at(
            authorization, "policyId", "authorization", POLICY_ID
        ),
        "sequence": _integer_at(authorization, "sequence", "authorization"),
        "subjectRappid": _string_at(
            authorization, "subjectRappid", "authorization", RAPPID
        ),
        "signerKeyId": _string_at(
            authorization, "signerKeyId", "authorization", KEY_ID
        ),
        "signerAlgorithm": _enum_at(
            authorization, "signerAlgorithm", "authorization", ALGORITHMS
        ),
        "signerPublicKey": _string_at(
            authorization, "signerPublicKey", "authorization", BASE64URL_32
        ),
        "notBefore": not_before,
        "notAfter": not_after,
        "maxClassification": _enum_at(
            authorization,
            "maxClassification",
            "authorization",
            CLASSIFICATIONS,
        ),
        "grantedScopes": _string_array_at(
            authorization,
            "grantedScopes",
            "authorization",
            values=SCOPES,
            minimum=1,
            maximum=6,
        ),
        "approvedOrigins": _approved_origins_at(
            authorization, "approvedOrigins", "authorization"
        ),
        "signature": _validate_signature(
            authorization["signature"], "authorization.signature"
        ),
    }


def validate_revocations(value: Any) -> Dict[str, Any]:
    revocations = _closed_object(
        value,
        "revocations",
        [
            "schema",
            "policyId",
            "sequence",
            "issuedAt",
            "expiresAt",
            "revokedManifestHashes",
            "revokedSignerKeyIds",
            "revokedAuthorizationIds",
            "signature",
        ],
    )
    if (
        _string_at(revocations, "schema", "revocations")
        != RAPPID_CARD_REVOCATIONS_SCHEMA
    ):
        raise RappidCardError("schema_invalid", "revocations.schema is invalid")
    issued_at = _string_at(revocations, "issuedAt", "revocations")
    expires_at = _string_at(revocations, "expiresAt", "revocations")
    _validate_window(issued_at, expires_at, "revocations.validity")
    return {
        "schema": RAPPID_CARD_REVOCATIONS_SCHEMA,
        "policyId": _string_at(
            revocations, "policyId", "revocations", POLICY_ID
        ),
        "sequence": _integer_at(revocations, "sequence", "revocations"),
        "issuedAt": issued_at,
        "expiresAt": expires_at,
        "revokedManifestHashes": _string_array_at(
            revocations,
            "revokedManifestHashes",
            "revocations",
            pattern=HEX_64,
            maximum=1024,
        ),
        "revokedSignerKeyIds": _string_array_at(
            revocations,
            "revokedSignerKeyIds",
            "revocations",
            pattern=KEY_ID,
            maximum=1024,
        ),
        "revokedAuthorizationIds": _string_array_at(
            revocations,
            "revokedAuthorizationIds",
            "revocations",
            pattern=AUTHORIZATION_ID,
            maximum=1024,
        ),
        "signature": _validate_signature(
            revocations["signature"], "revocations.signature"
        ),
    }


def _b64url_encode(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")


def _b64url_decode(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def _private_key(seed: bytes) -> Ed25519PrivateKey:
    if len(seed) != 32:
        raise RappidCardError(
            "key_invalid", "Ed25519 private seed must be 32 bytes"
        )
    return Ed25519PrivateKey.from_private_bytes(seed)


def _public_key(raw: str) -> Ed25519PublicKey:
    if not BASE64URL_32.fullmatch(raw):
        raise RappidCardError("key_invalid", "Ed25519 public key is invalid")
    return Ed25519PublicKey.from_public_bytes(_b64url_decode(raw))


def ed25519_public_key(seed: bytes) -> str:
    public = _private_key(seed).public_key().public_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PublicFormat.Raw,
    )
    return _b64url_encode(public)


def _sign_canonical(domain: str, value: Any, seed: bytes) -> str:
    message = f"{domain}\n{canonical_json(value)}".encode("utf-8")
    return _b64url_encode(_private_key(seed).sign(message))


def _verify_canonical(
    domain: str, value: Any, signature: str, public_key: str
) -> bool:
    if not BASE64URL_64.fullmatch(signature):
        return False
    message = f"{domain}\n{canonical_json(value)}".encode("utf-8")
    try:
        _public_key(public_key).verify(_b64url_decode(signature), message)
    except (InvalidSignature, ValueError, RappidCardError):
        return False
    return True


def unsigned_document(document: Dict[str, Any]) -> Dict[str, Any]:
    return {key: value for key, value in document.items() if key != "signature"}


unsigned_manifest = unsigned_document


def _sign_document(
    document: Dict[str, Any],
    domain: str,
    algorithm: str,
    key_id: str,
    private_key: bytes,
) -> Dict[str, Any]:
    return {
        **document,
        "signature": {
            "algorithm": algorithm,
            "keyId": key_id,
            "value": _sign_canonical(domain, document, private_key),
        },
    }


def sign_manifest(
    manifest: CardManifest,
    algorithm: str,
    key_id: str,
    private_key: bytes,
) -> CardManifest:
    return validate_manifest(
        _sign_document(
            manifest,
            CARD_SIGNATURE_DOMAIN,
            algorithm,
            key_id,
            private_key,
        )
    )


def sign_policy(
    policy: Dict[str, Any],
    algorithm: str,
    key_id: str,
    private_key: bytes,
) -> Dict[str, Any]:
    return validate_policy(
        _sign_document(
            policy,
            CARD_POLICY_SIGNATURE_DOMAIN,
            algorithm,
            key_id,
            private_key,
        )
    )


def sign_authorization(
    authorization: Dict[str, Any],
    algorithm: str,
    key_id: str,
    private_key: bytes,
) -> Dict[str, Any]:
    return validate_authorization(
        _sign_document(
            authorization,
            CARD_AUTHORIZATION_SIGNATURE_DOMAIN,
            algorithm,
            key_id,
            private_key,
        )
    )


def sign_revocations(
    revocations: Dict[str, Any],
    algorithm: str,
    key_id: str,
    private_key: bytes,
) -> Dict[str, Any]:
    return validate_revocations(
        _sign_document(
            revocations,
            CARD_REVOCATIONS_SIGNATURE_DOMAIN,
            algorithm,
            key_id,
            private_key,
        )
    )


def signature_value(manifest: CardManifest, private_key: bytes) -> str:
    return _sign_canonical(CARD_SIGNATURE_DOMAIN, manifest, private_key)


def verify_manifest_signature(
    manifest: CardManifest, public_key: str
) -> bool:
    return _verify_canonical(
        CARD_SIGNATURE_DOMAIN,
        unsigned_document(manifest),
        manifest["signature"]["value"],
        public_key,
    )


verify_signature = verify_manifest_signature


def verify_policy_signature(policy: Dict[str, Any], public_key: str) -> bool:
    return _verify_canonical(
        CARD_POLICY_SIGNATURE_DOMAIN,
        unsigned_document(policy),
        policy["signature"]["value"],
        public_key,
    )


def verify_authorization_signature(
    authorization: Dict[str, Any], public_key: str
) -> bool:
    return _verify_canonical(
        CARD_AUTHORIZATION_SIGNATURE_DOMAIN,
        unsigned_document(authorization),
        authorization["signature"]["value"],
        public_key,
    )


def verify_revocations_signature(
    revocations: Dict[str, Any], public_key: str
) -> bool:
    return _verify_canonical(
        CARD_REVOCATIONS_SIGNATURE_DOMAIN,
        unsigned_document(revocations),
        revocations["signature"]["value"],
        public_key,
    )


def challenge_value(request: Dict[str, Any], private_key: bytes) -> str:
    value = {
        "manifestHash": request["manifestHash"],
        "nonce": request["nonce"],
        "partHashes": sorted(request["partHashes"]),
    }
    return _sign_canonical(CARD_CHALLENGE_DOMAIN, value, private_key)


def verify_challenge(
    response: str, request: Dict[str, Any], public_key: str
) -> bool:
    value = {
        "manifestHash": request["manifestHash"],
        "nonce": request["nonce"],
        "partHashes": sorted(request["partHashes"]),
    }
    return _verify_canonical(
        CARD_CHALLENGE_DOMAIN, value, response, public_key
    )


def canonical_manifest(manifest: CardManifest) -> str:
    return canonical_json(manifest)


def canonical_document_hash(value: Any) -> str:
    return sha256_hex(canonical_json(value))


def manifest_hash(manifest: CardManifest) -> str:
    return canonical_document_hash(manifest)


def make_deep_link(
    manifest: CardManifest, hash_value: Optional[str] = None
) -> str:
    digest = hash_value if hash_value is not None else manifest_hash(manifest)
    return (
        f"rappid://link/{manifest['rappid']}?m={digest}"
        f"&e={quote(manifest['endpoint'], safe='')}&n={manifest['nonce']}"
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
        or not HEX_32.fullmatch(nonce)
    ):
        raise RappidCardError("link_invalid", "deep link fields are invalid")
    validate_endpoint(endpoint, "deep link endpoint")
    exact = (
        f"rappid://link/{rappid}?m={digest}"
        f"&e={quote(endpoint, safe='')}&n={nonce}"
    )
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
