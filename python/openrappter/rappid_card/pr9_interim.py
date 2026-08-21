"""Isolated interim fixes over the byte-identical PR9 reference copy.

Delete this module and re-vendor `pr9_reference.py` when the protocol follow-up
lands. OpenRappter imports the patched module; the original copy remains intact
for provenance and diffing.
"""

from __future__ import annotations

import ipaddress
import json
import re
import urllib.parse
from typing import Any

from . import pr9_reference as R

MAX_CANONICAL_DEPTH = 64
MAX_CANONICAL_BYTES = 1024 * 1024


def canonical(value: Any, depth: int = 1, root: bool = True) -> str:
    try:
        if depth > MAX_CANONICAL_DEPTH:
            raise ValueError("RAPP/1 value exceeds depth 64")
        if value is None or isinstance(value, bool):
            rendered = json.dumps(value)
        elif isinstance(value, int):
            rendered = json.dumps(value)
        elif isinstance(value, float):
            raise ValueError(
                "floats require full-JCS number serialization; use ints/strings"
            )
        elif isinstance(value, str):
            rendered = json.dumps(value, ensure_ascii=False)
        elif isinstance(value, list):
            rendered = "[" + ",".join(
                canonical(item, depth + 1, False) for item in value
            ) + "]"
        elif isinstance(value, dict):
            if not all(isinstance(key, str) for key in value):
                raise ValueError("canonical JSON object keys must be strings")
            keys = sorted(value)
            rendered = "{" + ",".join(
                json.dumps(key, ensure_ascii=False)
                + ":"
                + canonical(value[key], depth + 1, False)
                for key in keys
            ) + "}"
        else:
            raise ValueError(f"non-I-JSON value: {type(value)}")
    except RecursionError as error:
        raise ValueError("RAPP/1 value exceeds depth 64") from error
    if root and len(rendered.encode("utf-8")) > MAX_CANONICAL_BYTES:
        raise ValueError("RAPP/1 canonical form exceeds 1 MiB")
    return rendered


def H(space: str, value: Any) -> str:
    import hashlib

    return hashlib.sha256(
        space.encode() + b"\x0a" + canonical(value).encode("utf-8")
    ).hexdigest()


def rappid_valid(value: Any) -> bool:
    return isinstance(value, str) and R._RAPPID.fullmatch(value) is not None


def lclabel(value: Any) -> bool:
    return isinstance(value, str) and R._LCLABEL.fullmatch(value) is not None


def sorted_unique_strings(values: Any, grammar: re.Pattern[str]) -> bool:
    return (
        isinstance(values, list)
        and all(
            isinstance(value, str) and grammar.fullmatch(value)
            for value in values
        )
        and values == sorted(set(values))
    )


_original_card_url_info = R._card_url_info


def card_url_info(value: str, suffix: str | None = None):
    try:
        host = urllib.parse.urlsplit(value).hostname or ""
    except ValueError:
        host = ""
    labels = host.lower().split(".")
    numeric_alias = (
        bool(re.fullmatch(r"(?:0x[0-9a-f]+|[0-9]+)", host.lower()))
        or (
            len(labels) > 1
            and all(
                re.fullmatch(r"(?:0x[0-9a-f]+|[0-9]+)", label) is not None
                for label in labels
            )
        )
    )
    if numeric_alias:
        try:
            ipaddress.ip_address(host)
        except ValueError as error:
            raise ValueError("legacy numeric IP host aliases are forbidden") from error
    return _original_card_url_info(value, suffix)


R._HEX64 = re.compile(r"^[0-9a-f]{64}\Z")
R._UTC = re.compile(
    r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\Z"
)
R._LCLABEL = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*\Z")
R._RAPPID = re.compile(
    r"^rappid:@([a-z0-9]+(?:-[a-z0-9]+)*)/"
    r"([a-z0-9]+(?:-[a-z0-9]+)*):([0-9a-f]{64})\Z"
)
R._CARD_PROFILE_TOKEN = re.compile(
    r"^[a-z0-9]+(?:-[a-z0-9]+)*/[1-9][0-9]*\Z"
)
R._CARD_NONCE = re.compile(r"^[A-Za-z0-9_-]{16,64}\Z")
R._CARD_CONNECTION = re.compile(r"^[A-Za-z0-9._-]{1,128}\Z")
R._FORBIDDEN_CARD_TEXT = re.compile(
    r"(?i)(?:(?<![A-Za-z0-9_])(?:password|passwd|api[-_ ]?key|cookie|"
    r"authorization|private[-_ ]?memory|plaintext[-_ ]?memory|"
    r"auto[-_ ]?execute)(?![A-Za-z0-9_])|"
    r"(?<![A-Za-z0-9_])bearer(?:\s|[-_:]))"
)
R.canonical = canonical
R.H = H
R.rappid_valid = rappid_valid
R._lclabel = lclabel
R._sorted_unique_strings = sorted_unique_strings
R._card_url_info = card_url_info

# Re-export the patched module as the one runtime authority.
for _name in dir(R):
    if not _name.startswith("__"):
        globals()[_name] = getattr(R, _name)
