"""The one canonical identity.

Mirrors ``typescript/src/rappids/identity.ts``. A Quantum RAPPID is named
exactly once. Dimensions, traits, media hashes, weights, heights and lifecycle
stages are all downstream of that name and none of them may produce a new one
-- growth appends, it does not re-mint. The only thing that gets a fresh
RAPPID is a true child, and a child says so with an explicit parent pointer.

``rappid_hex`` is the construction ``typescript/src/identity/name.ts`` already
defines (RAPP/1 5 domain separation over the mint-once tail). It is repeated
here rather than re-invented so both runtimes derive the same public value
from the same secret, and it never reveals anything about the tail.
"""

from __future__ import annotations

import hashlib
import re
from typing import List, Optional, Sequence, Tuple

from .types import QuantumRappidError, RappidParts

#: Domain-separated per RAPP/1 5. Must not collide with allele/egg/wave/particle.
RAPPID_DOMAIN = "rapp/1:rappid"

#: ``rappid:@owner/name:<64 hex>`` -- the address form used on disk.
RAPPID_PATTERN = re.compile(
    r"^rappid:@([a-z0-9][a-z0-9-]*)/([a-z0-9][a-z0-9-]*):([0-9a-f]{64})$"
)

_HEX64 = re.compile(r"^[0-9a-f]{64}$")


def rappid_hex(tail: str) -> str:
    """The public rappid for a tail. Safe to display; reveals nothing about it."""
    return hashlib.sha256(f"{RAPPID_DOMAIN}\n{tail}".encode("utf-8")).hexdigest()


def is_rappid(value: object) -> bool:
    return isinstance(value, str) and RAPPID_PATTERN.fullmatch(value) is not None


def parse_rappid(value: str) -> RappidParts:
    match = RAPPID_PATTERN.fullmatch(value) if isinstance(value, str) else None
    if match is None:
        raise QuantumRappidError(
            "invalid-rappid",
            f"not a RAPPID: {value!r} (expected rappid:@owner/name:<64 hex>)",
        )
    return RappidParts(owner=match.group(1), name=match.group(2), hex=match.group(3))


def format_rappid(parts: RappidParts) -> str:
    value = f"rappid:@{parts.owner}/{parts.name}:{parts.hex}"
    # Round-trip rather than trust the caller: a malformed owner or name would
    # otherwise become a permanent identity that nothing can parse back.
    parse_rappid(value)
    return value


def directory_hex(directory_name: str) -> Optional[str]:
    """The identity a habitat directory claims, from its own name.

    A directory is a filing decision, not an identity, so anything that is not
    a bare 64-hex name returns None instead of a guess.
    """
    return directory_name if _HEX64.fullmatch(directory_name) else None


def identity_drift(
    expected: str, claims: Sequence[Tuple[str, Optional[str]]]
) -> List[Tuple[str, Optional[str]]]:
    """Every place a document repeats the RAPPID, checked against the first one.

    Drift here is the failure that matters most: one file re-minted, or two
    organisms merged by hand, produce an object that still *looks* like one
    creature while carrying two identities. Callers get the mismatching sources
    rather than a boolean so the report can name the file that drifted.
    """
    return [claim for claim in claims if claim[1] != expected]


def validate_parent_pointer(rappid: str, parent: Optional[str]) -> None:
    """A parent pointer is only meaningful for a true child.

    None means "this organism was minted, not born". A value must be a RAPPID
    and must not be the organism itself: self-parenthood is the shape a
    re-minting bug takes when it tries to look like lineage.
    """
    if parent is None:
        return
    if not is_rappid(parent):
        raise QuantumRappidError("invalid-parent", f"parent_rappid is not a RAPPID: {parent!r}")
    if parent == rappid:
        raise QuantumRappidError(
            "self-parent",
            f"{rappid} points at itself as its parent; growth appends to an organism, "
            "it never re-mints one",
        )
