#!/usr/bin/env python3
"""Frozen stdlib verifier for the rapp-anchor-bootstrap/1 profile."""

from __future__ import annotations

import hashlib
import json
import re
from datetime import datetime
from typing import Dict, List, Optional


HEX64 = re.compile(r"[0-9a-f]{64}")
UTC = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z")
RAPPID = re.compile(
    r"rappid:@[a-z0-9]+(?:-[a-z0-9]+)*/"
    r"[a-z0-9]+(?:-[a-z0-9]+)*:[0-9a-f]{64}"
)
PROFILE_SCHEMA = "rapp-anchor-bootstrap/1"
INDEX_SCHEMA = "rapp-anchor-bootstrap-index/1"
SPEC = "rapp/1"
KIND = "body.pulse"
PARTICLE_DOMAIN = "rapp/1:particle"
WAVE_DOMAIN = "rapp/1:wave"
INTEGER_MIN = -(2**53 - 1)
INTEGER_MAX = 2**53 - 1
MAX_BYTES = 1024 * 1024
MAX_DEPTH = 64
FRAME_KEYS = {
    "spec",
    "kind",
    "stream_id",
    "seq",
    "utc",
    "payload",
    "payload_hash",
    "frame_hash",
    "prev",
    "prev_wave",
    "sig",
}


class BootstrapError(ValueError):
    """The bootstrap profile, verifier artifact, frame, or chain is invalid."""


def sha256(octets: bytes) -> str:
    return hashlib.sha256(octets).hexdigest()


def canonical(value: object) -> str:
    if value is None or isinstance(value, bool):
        return json.dumps(value)
    if isinstance(value, int):
        if not INTEGER_MIN <= value <= INTEGER_MAX:
            raise BootstrapError("integer outside exact interoperable range")
        return json.dumps(value)
    if isinstance(value, float):
        raise BootstrapError("bootstrap profile forbids floating-point JSON")
    if isinstance(value, str):
        try:
            value.encode("utf-8")
        except UnicodeEncodeError as error:
            raise BootstrapError("unpaired Unicode surrogate") from error
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, list):
        return "[" + ",".join(canonical(item) for item in value) + "]"
    if isinstance(value, dict):
        if not all(isinstance(key, str) for key in value):
            raise BootstrapError("JSON object keys must be strings")
        keys = sorted(value, key=lambda key: key.encode("utf-16-be"))
        return (
            "{"
            + ",".join(
                json.dumps(key, ensure_ascii=False) + ":" + canonical(value[key])
                for key in keys
            )
            + "}"
        )
    raise BootstrapError(f"unsupported JSON value: {type(value).__name__}")


def H(domain: str, value: object) -> str:
    return sha256(domain.encode("ascii") + b"\n" + canonical(value).encode("utf-8"))


def strict_json(
    octets: bytes,
    *,
    maximum_bytes: int = MAX_BYTES,
    maximum_depth: int = MAX_DEPTH,
) -> object:
    if not isinstance(octets, bytes) or len(octets) > maximum_bytes:
        raise BootstrapError("JSON input exceeds bootstrap byte limit")
    try:
        octets.decode("utf-8")
    except UnicodeDecodeError as error:
        raise BootstrapError("JSON input is not valid UTF-8") from error

    def pairs(values: list) -> dict:
        result = {}
        for key, value in values:
            if key in result:
                raise BootstrapError(f"duplicate JSON member: {key}")
            result[key] = value
        return result

    def integer(token: str) -> int:
        value = int(token)
        if not INTEGER_MIN <= value <= INTEGER_MAX:
            raise BootstrapError("integer outside exact interoperable range")
        return value

    def reject_float(_token: str) -> float:
        raise BootstrapError("bootstrap profile forbids floating-point JSON")

    def reject_constant(token: str) -> object:
        raise BootstrapError(f"invalid JSON number constant: {token}")

    try:
        value = json.loads(
            octets,
            object_pairs_hook=pairs,
            parse_int=integer,
            parse_float=reject_float,
            parse_constant=reject_constant,
        )
    except BootstrapError:
        raise
    except (UnicodeError, ValueError, json.JSONDecodeError) as error:
        raise BootstrapError(f"invalid JSON: {error}") from error
    stack = [(value, 1)]
    while stack:
        current, depth = stack.pop()
        if depth > maximum_depth:
            raise BootstrapError("JSON nesting depth exceeds bootstrap limit")
        if isinstance(current, dict):
            stack.extend((item, depth + 1) for item in current.values())
        elif isinstance(current, list):
            stack.extend((item, depth + 1) for item in current)
    if len(canonical(value).encode("utf-8")) > maximum_bytes:
        raise BootstrapError("canonical JSON exceeds bootstrap byte limit")
    return value


def _require_exact(value: object, expected: object, label: str) -> None:
    if value != expected:
        raise BootstrapError(f"bootstrap {label} mismatch")


def verify_profile(profile_octets: bytes, verifier_octets: bytes) -> dict:
    profile = strict_json(profile_octets)
    if not isinstance(profile, dict) or set(profile) != {
        "schema",
        "version",
        "authority",
        "canonicalization",
        "hash_domains",
        "frame",
        "chaining",
        "limits",
        "verifier",
    }:
        raise BootstrapError("bootstrap profile has an unexpected shape")
    _require_exact(profile["schema"], PROFILE_SCHEMA, "schema")
    _require_exact(profile["version"], 1, "version")
    _require_exact(
        profile["authority"],
        {
            "canonical_repository": "https://github.com/kody-w/rapp-1",
            "protected_ref": "refs/heads/main",
            "chain_path": "anchor/chain.jsonl",
            "index_path": "anchor/index.json",
            "frame_path_template": "anchor/frames/{frame_hash}.json",
            "stream_id": (
                "rappid:@kody-w/rapp-1-anchor:"
                "a4298c417789ecff68b7be3df4d8b90d397c43f972eaf839977db16dbe02acc6"
            ),
            "genesis_frame_hash": (
                "a5aa6e6ba81d6b97b80ce46bc20905428d5679bb18309d176356bd194cdd005a"
            ),
            "genesis_payload_hash": (
                "7d9c87b7d58ba07b22b68e8b07c0d50714fcc377c627ea9c60bec3bc6518df29"
            ),
        },
        "authority",
    )
    _require_exact(
        profile["canonicalization"],
        {
            "standard": "RFC 8785 JCS",
            "encoding": "UTF-8",
            "input": "I-JSON exact-integer subset",
            "integer_min": INTEGER_MIN,
            "integer_max": INTEGER_MAX,
            "object_key_order": "UTF-16 code units",
            "unicode_normalization": "none",
            "floating_point": "refused",
        },
        "canonicalization",
    )
    _require_exact(
        profile["hash_domains"],
        {"particle": PARTICLE_DOMAIN, "wave": WAVE_DOMAIN},
        "hash domains",
    )
    _require_exact(
        profile["frame"],
        {
            "spec": SPEC,
            "kind": KIND,
            "keys": [
                "spec",
                "kind",
                "stream_id",
                "seq",
                "utc",
                "payload",
                "payload_hash",
                "frame_hash",
                "prev",
                "prev_wave",
                "sig",
            ],
            "sig": None,
            "prev_wave": None,
        },
        "frame profile",
    )
    _require_exact(
        profile["chaining"],
        {
            "genesis_seq": 0,
            "genesis_prev": None,
            "successor_seq": "predecessor.seq + 1",
            "successor_prev": "predecessor.payload_hash",
            "utc": "calendar-valid YYYY-MM-DDTHH:MM:SS.mmmZ, nondecreasing",
        },
        "chaining",
    )
    _require_exact(
        profile["limits"],
        {
            "canonical_frame_bytes": MAX_BYTES,
            "json_input_bytes": MAX_BYTES,
            "json_nesting_depth": MAX_DEPTH,
        },
        "limits",
    )
    verifier = profile["verifier"]
    if not isinstance(verifier, dict) or set(verifier) != {
        "path",
        "sha256",
        "bytes",
    }:
        raise BootstrapError("bootstrap verifier pin has an unexpected shape")
    _require_exact(verifier["path"], "anchor/bootstrap_verify.py", "verifier path")
    if (
        not isinstance(verifier["sha256"], str)
        or not HEX64.fullmatch(verifier["sha256"])
        or verifier["sha256"] != sha256(verifier_octets)
    ):
        raise BootstrapError("bootstrap verifier SHA-256 mismatch")
    if verifier["bytes"] != len(verifier_octets):
        raise BootstrapError("bootstrap verifier byte length mismatch")
    return profile


def verify_bootstrap_index(
    index_octets: bytes,
    profile_octets: bytes,
    verifier_octets: bytes,
) -> dict:
    index = strict_json(index_octets)
    if not isinstance(index, dict) or set(index) != {
        "schema",
        "profile_path",
        "profile_sha256",
        "profile_bytes",
        "verifier_path",
        "verifier_sha256",
        "verifier_bytes",
    }:
        raise BootstrapError("bootstrap index has an unexpected shape")
    _require_exact(index["schema"], INDEX_SCHEMA, "index schema")
    profile_hash = sha256(profile_octets)
    if index["profile_sha256"] != profile_hash:
        raise BootstrapError("bootstrap profile SHA-256 mismatch")
    _require_exact(index["profile_bytes"], len(profile_octets), "profile bytes")
    expected_path = f"anchor/bootstrap/sha256-{profile_hash}.json"
    _require_exact(index["profile_path"], expected_path, "content-addressed profile path")
    _require_exact(index["verifier_path"], "anchor/bootstrap_verify.py", "index verifier path")
    verifier_hash = sha256(verifier_octets)
    _require_exact(index["verifier_sha256"], verifier_hash, "index verifier SHA-256")
    _require_exact(index["verifier_bytes"], len(verifier_octets), "index verifier bytes")
    verify_profile(profile_octets, verifier_octets)
    return index


def utc_valid(value: object) -> bool:
    if not isinstance(value, str) or not UTC.fullmatch(value):
        return False
    try:
        datetime.strptime(value, "%Y-%m-%dT%H:%M:%S.%fZ")
    except ValueError:
        return False
    return True


def _intrinsic_frame(frame: object, profile: dict) -> dict:
    if not isinstance(frame, dict) or set(frame) != FRAME_KEYS:
        raise BootstrapError("anchor frame key set is not the exact eleven-key envelope")
    authority = profile["authority"]
    if frame["spec"] != SPEC or frame["kind"] != KIND:
        raise BootstrapError("anchor frame spec/kind profile mismatch")
    if frame["stream_id"] != authority["stream_id"] or not RAPPID.fullmatch(
        frame["stream_id"]
    ):
        raise BootstrapError("anchor frame stream_id mismatch")
    if (
        not isinstance(frame["seq"], int)
        or isinstance(frame["seq"], bool)
        or not 0 <= frame["seq"] <= INTEGER_MAX
    ):
        raise BootstrapError("anchor frame seq is not uint53")
    if not utc_valid(frame["utc"]):
        raise BootstrapError("anchor frame utc is not fixed calendar-valid form")
    if not isinstance(frame["payload"], dict):
        raise BootstrapError("anchor frame payload is not an object")
    for key in ("payload_hash", "frame_hash"):
        if not isinstance(frame[key], str) or not HEX64.fullmatch(frame[key]):
            raise BootstrapError(f"anchor frame {key} is not 64 lowercase hex")
    if frame["seq"] == 0:
        if frame["prev"] is not None:
            raise BootstrapError("anchor genesis prev must be null")
    elif not isinstance(frame["prev"], str) or not HEX64.fullmatch(frame["prev"]):
        raise BootstrapError("anchor successor prev must be 64 lowercase hex")
    if frame["prev_wave"] is not None or frame["sig"] is not None:
        raise BootstrapError("unsigned body.pulse anchor requires null prev_wave and sig")
    if frame["payload_hash"] != H(PARTICLE_DOMAIN, frame["payload"]):
        raise BootstrapError("anchor particle mismatch")
    preimage = {
        key: value
        for key, value in frame.items()
        if key not in ("frame_hash", "sig")
    }
    if frame["frame_hash"] != H(WAVE_DOMAIN, preimage):
        raise BootstrapError("anchor wave mismatch")
    if len(canonical(frame).encode("utf-8")) > profile["limits"][
        "canonical_frame_bytes"
    ]:
        raise BootstrapError("anchor frame exceeds canonical-byte limit")
    return frame


def parse_chain(chain_octets: bytes, profile: dict) -> List[dict]:
    if not isinstance(chain_octets, bytes) or not chain_octets.endswith(b"\n"):
        raise BootstrapError("anchor chain must be non-empty JSONL ending in LF")
    if b"\r" in chain_octets:
        raise BootstrapError("anchor chain must use LF line endings")
    try:
        chain_octets.decode("utf-8")
    except UnicodeDecodeError as error:
        raise BootstrapError("anchor chain is not valid UTF-8") from error
    frames = []
    for line_number, line in enumerate(chain_octets.splitlines(), 1):
        if not line:
            raise BootstrapError(f"blank anchor chain line at {line_number}")
        try:
            frame = strict_json(
                line,
                maximum_bytes=profile["limits"]["json_input_bytes"],
                maximum_depth=profile["limits"]["json_nesting_depth"],
            )
            frames.append(_intrinsic_frame(frame, profile))
        except BootstrapError as error:
            raise BootstrapError(f"anchor line {line_number}: {error}") from error
    return frames


def verify_chain(chain_octets: bytes, profile: dict) -> List[dict]:
    frames = parse_chain(chain_octets, profile)
    seen_seq = {}
    children = {}
    for line_number, frame in enumerate(frames, 1):
        if frame["seq"] in seen_seq:
            raise BootstrapError(
                f"duplicate seq/fork at lines {seen_seq[frame['seq']]} and {line_number}"
            )
        if frame["prev"] is not None and frame["prev"] in children:
            raise BootstrapError(
                f"fork at lines {children[frame['prev']]} and {line_number}"
            )
        seen_seq[frame["seq"]] = line_number
        if frame["prev"] is not None:
            children[frame["prev"]] = line_number
    genesis = frames[0]
    authority = profile["authority"]
    if (
        genesis["seq"] != 0
        or genesis["frame_hash"] != authority["genesis_frame_hash"]
        or genesis["payload_hash"] != authority["genesis_payload_hash"]
    ):
        raise BootstrapError("anchor genesis does not match the bootstrap pin")
    head = genesis
    for line_number, frame in enumerate(frames[1:], 2):
        if frame["seq"] != head["seq"] + 1:
            raise BootstrapError(f"anchor line {line_number}: seq is not contiguous")
        if frame["prev"] != head["payload_hash"]:
            raise BootstrapError(f"anchor line {line_number}: prev does not match predecessor")
        if frame["utc"] < head["utc"]:
            raise BootstrapError(f"anchor line {line_number}: utc moved backward")
        head = frame
    return frames


def verify_frame_object(
    object_octets: bytes,
    expected_frame_hash: str,
    profile: dict,
) -> dict:
    if not isinstance(expected_frame_hash, str) or not HEX64.fullmatch(
        expected_frame_hash
    ):
        raise BootstrapError("requested frame hash is not 64 lowercase hex")
    if object_octets.endswith((b"\n", b"\r")):
        raise BootstrapError("frame object must omit the JSONL line terminator")
    frame = _intrinsic_frame(
        strict_json(
            object_octets,
            maximum_bytes=profile["limits"]["json_input_bytes"],
            maximum_depth=profile["limits"]["json_nesting_depth"],
        ),
        profile,
    )
    if frame["frame_hash"] != expected_frame_hash:
        raise BootstrapError("frame object content does not match requested hash")
    return frame
