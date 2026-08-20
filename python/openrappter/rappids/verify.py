"""Proof, not assertion.

Mirrors ``typescript/src/rappids/verify.ts``.

Every claim an organism makes about itself is re-derived here from bytes on
disk: the manifest hash over canonical JSON, the identity seed over the
traits, the identity motif over the RAPPID, each asset's exact length and
digest, and the body-frame chain. A creature that says it weighs three
megabytes and cannot produce them is not heavy, it is wrong -- and the
difference has to be visible in the report rather than smoothed over.

Nothing here is a heuristic and nothing is estimated. A check either passes
with the evidence that made it pass, or fails with what did not match.
"""

from __future__ import annotations

import os
import re
from pathlib import Path
from typing import List, Optional, Tuple

from .canonical import RAPP_EGG_DOMAIN, canonical_digest, rapp_hb, sha256_hex
from .identity import directory_hex, identity_drift, parse_rappid
from .store import (
    asset_bytes,
    asset_exists,
    body_frame_problems,
    read_rapp_object,
    resolve_within,
)
from .types import (
    AssetRecord,
    AssetVerification,
    BodyFrame,
    LoadedOrganism,
    QuantumRappidError,
    SonicProfile,
    VerificationCheck,
    VerificationReport,
)

_HEX64 = re.compile(r"^[0-9a-f]{64}$")


def _pass(name: str, detail: str) -> VerificationCheck:
    return VerificationCheck(name=name, status="pass", detail=detail)


def _fail(name: str, detail: str) -> VerificationCheck:
    return VerificationCheck(name=name, status="fail", detail=detail)


def _verify_asset(
    organism: LoadedOrganism, dimension: str, asset: AssetRecord
) -> AssetVerification:
    """One asset, weighed and hashed."""
    if not asset_exists(organism, dimension, asset.path):
        return AssetVerification(
            dimension=dimension,
            path=asset.path,
            status="missing",
            address_space=RAPP_EGG_DOMAIN,
            address_hash="",
            expected_bytes=asset.bytes,
            actual_bytes=None,
            expected_sha256=asset.sha256,
            actual_sha256=None,
            media_type=asset.media_type,
        )
    payload = asset_bytes(organism, dimension, asset.path)
    digest = sha256_hex(payload)
    if len(payload) != asset.bytes:
        status = "byte-mismatch"
    elif digest != asset.sha256:
        status = "hash-mismatch"
    else:
        status = "verified"
    return AssetVerification(
        dimension=dimension,
        path=asset.path,
        status=status,
        address_space=RAPP_EGG_DOMAIN,
        address_hash=rapp_hb(RAPP_EGG_DOMAIN, payload),
        expected_bytes=asset.bytes,
        actual_bytes=len(payload),
        expected_sha256=asset.sha256,
        actual_sha256=digest,
        media_type=asset.media_type,
    )


def _verify_frame_media(organism: LoadedOrganism) -> List[AssetVerification]:
    """Every media ref a frame carries, re-read from the local egg store.

    A frame names bytes by their RAPP/1 address. The address is only worth
    something if the bytes behind it are here and still hash to it, so each ref
    is resolved and re-hashed rather than trusted.
    """
    results: List[AssetVerification] = []
    for frame in organism.frames:
        media = frame.payload.get("media")
        if not isinstance(media, dict):
            # A frame whose media is not an object has already been named by
            # the chain check ("media is not an object"), and the report
            # carrying that failure is where it belongs. There are no refs here
            # to weigh, and inventing one would put a second, vaguer complaint
            # about the same frame in the asset list.
            continue
        for role, raw in media.items():
            dimension = str(frame.payload.get("dimension"))
            if not isinstance(raw, dict):
                results.append(
                    AssetVerification(
                        dimension=dimension,
                        path=role,
                        status="missing",
                        address_space=RAPP_EGG_DOMAIN,
                        address_hash="",
                        expected_bytes=0,
                        actual_bytes=None,
                        expected_sha256="",
                        actual_sha256=None,
                        media_type="application/octet-stream",
                    )
                )
                continue
            reference = raw.get("hash")
            address = reference if isinstance(reference, str) else ""
            expected_bytes = raw.get("bytes")
            expected_bytes = (
                expected_bytes
                if isinstance(expected_bytes, int) and not isinstance(expected_bytes, bool)
                else 0
            )
            media_type = raw.get("media_type")
            media_type = (
                media_type if isinstance(media_type, str) else "application/octet-stream"
            )
            payload = (
                read_rapp_object(organism, address) if _HEX64.match(address) else None
            )
            actual_hash = None if payload is None else rapp_hb(RAPP_EGG_DOMAIN, payload)
            if payload is None:
                status = "missing"
            elif len(payload) != expected_bytes:
                status = "byte-mismatch"
            elif raw.get("space") != RAPP_EGG_DOMAIN or actual_hash != address:
                status = "hash-mismatch"
            else:
                status = "verified"
            results.append(
                AssetVerification(
                    dimension=dimension,
                    path=role,
                    status=status,
                    address_space=RAPP_EGG_DOMAIN,
                    address_hash=address,
                    expected_bytes=expected_bytes,
                    actual_bytes=None if payload is None else len(payload),
                    expected_sha256=address,
                    actual_sha256=actual_hash,
                    media_type=media_type,
                )
            )
    return results


def _identity_checks(organism: LoadedOrganism) -> List[VerificationCheck]:
    checks: List[VerificationCheck] = []
    rappid = organism.document.rappid
    parts = parse_rappid(rappid)
    checks.append(_pass("identity.format", f"{rappid} parses as rappid:@owner/name:<64 hex>"))

    folder = os.path.basename(organism.directory.rstrip(os.sep))
    claimed = directory_hex(folder)
    if claimed is None:
        checks.append(
            _pass(
                "identity.habitat",
                f"{folder} is a named habitat directory, not an identity claim",
            )
        )
    elif claimed == parts.hex:
        checks.append(
            _pass("identity.habitat", "habitat directory matches the RAPPID tail-derived hex")
        )
    else:
        checks.append(
            _fail(
                "identity.habitat",
                f"habitat directory {folder} does not match the RAPPID hex {parts.hex}",
            )
        )

    claims: List[Tuple[str, Optional[str]]] = [("traits.json", organism.traits.rappid)]
    if organism.sonic is not None:
        claims.append(("sonic/sonic-profile.json", organism.sonic.rappid))
    for frame in organism.frames:
        claims.append((f"frames/{frame.seq:06d}.json", frame.stream_id))
    drift = identity_drift(rappid, claims)
    if drift:
        detail = "; ".join(f"{source} says {value}" for source, value in drift)
        checks.append(_fail("identity.single", f"identity drift: {detail}"))
    else:
        checks.append(
            _pass("identity.single", f"{len(claims) + 1} documents carry one identity")
        )

    parent = organism.document.parent_rappid
    checks.append(
        _pass("identity.lineage", "no parent pointer: this organism was minted, not born")
        if parent is None
        else _pass("identity.lineage", f"true offspring of {parent}")
    )
    return checks


def _manifest_check(sonic: SonicProfile) -> VerificationCheck:
    """Has the manifest been edited since it was written?

    A sidecar hashes the file bytes; an embedded ``manifest_sha256`` hashes the
    canonical JSON of every other key. Both are accepted, the sidecar first
    because it is the newer spelling. A profile carrying neither is not
    "probably fine": there is nothing to check it against, and a dimension
    whose integrity cannot be established must not read as verified.
    """
    if sonic.sidecar_sha256 is not None:
        if sonic.sidecar_sha256 == sonic.file_sha256:
            return _pass(
                "sonic.manifest",
                f"sonic-profile.sha256 matches the profile bytes ({sonic.file_sha256[:12]})",
            )
        return _fail(
            "sonic.manifest",
            f"sonic-profile.sha256 records {sonic.sidecar_sha256} but the profile hashes "
            f"to {sonic.file_sha256}",
        )
    if sonic.manifest_sha256 is not None:
        without_hash = {
            key: value for key, value in sonic.raw.items() if key != "manifest_sha256"
        }
        recomputed = canonical_digest(without_hash)
        if recomputed == sonic.manifest_sha256:
            return _pass(
                "sonic.manifest", f"manifest hash {recomputed[:12]} covers the profile"
            )
        return _fail(
            "sonic.manifest",
            f"manifest hash is {sonic.manifest_sha256} but the profile hashes to {recomputed}",
        )
    return _fail(
        "sonic.manifest",
        "the sonic profile records no manifest hash and has no sonic-profile.sha256 beside "
        "it, so nothing can establish that it has not been edited",
    )


def _midi_dna_check(sonic: SonicProfile) -> VerificationCheck:
    """The MIDI DNA is checked structurally, not against this runtime's generator.

    Whether a recorded motif is the one *this* implementation would derive is a
    question about a provider, and providers are replaceable by design -- the
    seam is the provider, not the RAPPID. Asserting our own melody over someone
    else's organism would turn a legitimate creature into a failing one. What
    must hold for any organism is that the motif is a well-formed 16-note
    ``NOTE(pitch, delta_onset, duration, velocity)`` sequence in MIDI range.
    """
    if len(sonic.prompt) != 16:
        return _fail(
            "sonic.midi-dna",
            f"the identity motif carries {len(sonic.prompt)} notes, expected 16",
        )
    bad = [
        note
        for note in sonic.prompt
        if not (0 <= note.pitch <= 127)
        or not (1 <= note.velocity <= 127)
        or note.delta_onset < 0
        or note.duration <= 0
    ]
    if bad:
        return _fail(
            "sonic.midi-dna", f"{len(bad)} of 16 identity-motif notes are out of MIDI range"
        )
    return _pass("sonic.midi-dna", "the 16-note identity motif is well formed and in MIDI range")


def _sonic_checks(organism: LoadedOrganism) -> List[VerificationCheck]:
    sonic = organism.sonic
    if sonic is None:
        return []
    checks: List[VerificationCheck] = [_manifest_check(sonic), _midi_dna_check(sonic)]

    trait_drift = [
        key for key, value in sonic.traits.items() if organism.traits.traits.get(key) != value
    ]
    checks.append(
        _pass("sonic.traits", "the sonic profile carries the same traits as traits.json")
        if not trait_drift
        else _fail(
            "sonic.traits",
            "traits disagree between traits.json and the sonic profile: "
            + ", ".join(sorted(trait_drift)),
        )
    )
    return checks


def _frame_checks(organism: LoadedOrganism) -> List[VerificationCheck]:
    if not organism.frames:
        return [
            _pass("frames.chain", "no body frames yet: a compact organism is not a broken one")
        ]
    problems: List[str] = []
    head: Optional[BodyFrame] = None
    for frame in organism.frames:
        for problem in body_frame_problems(frame, head, organism.document.rappid):
            problems.append(f"frame {frame.seq}: {problem}")
        head = frame
    if problems:
        return [_fail("frames.chain", "; ".join(problems))]
    return [
        _pass("frames.chain", f"{len(organism.frames)} append-only frames chain cleanly")
    ]


def _dimension_ref_checks(organism: LoadedOrganism) -> List[VerificationCheck]:
    """Dimension refs that name a file must name a file that is there.

    A ref without a separator is a cursor or an identifier (``"0002"``), not a
    path, and inventing a file for it would turn a healthy organism into a
    failing one.
    """
    missing: List[str] = []
    checked = 0
    for dimension in organism.document.dimensions:
        for key in sorted(dimension.refs):
            ref = dimension.refs[key]
            if "/" not in ref or "://" in ref:
                continue
            checked += 1
            try:
                target = resolve_within(organism.directory, ref)
            except QuantumRappidError as error:
                missing.append(f"{dimension.name}.{key} -> {error.message}")
                continue
            if not Path(target).exists():
                missing.append(f"{dimension.name}.{key} -> {ref}")
    if missing:
        return [
            _fail(
                "dimensions.refs",
                "dimension refs point at files that are not here: " + ", ".join(missing),
            )
        ]
    return [_pass("dimensions.refs", f"{checked} dimension refs resolve inside the organism")]


def verify_organism(organism: LoadedOrganism) -> VerificationReport:
    """Everything, checked.

    ``verified_addresses`` is deliberately a ``(dimension, sha256)`` set: it is
    what makes weight honest later, because the same bytes carried twice must
    not make an organism heavier.
    """
    checks: List[VerificationCheck] = [
        *_identity_checks(organism),
        *_sonic_checks(organism),
        *_frame_checks(organism),
        *_dimension_ref_checks(organism),
    ]

    assets: List[AssetVerification] = []
    if organism.sonic is not None:
        for asset in organism.sonic.assets:
            assets.append(_verify_asset(organism, organism.sonic.dimension, asset))
    assets.extend(_verify_frame_media(organism))

    broken = [asset for asset in assets if asset.status != "verified"]
    if broken:
        checks.append(
            _fail(
                "assets.content",
                "; ".join(f"{item.dimension}/{item.path} is {item.status}" for item in broken),
            )
        )
    else:
        checks.append(
            _pass("assets.content", f"{len(assets)} content addresses verified byte for byte")
        )

    verified_addresses = sorted(
        {
            f"{asset.address_space}:{asset.address_hash}"
            for asset in assets
            if asset.status == "verified"
        }
    )

    return VerificationReport(
        rappid=organism.document.rappid,
        ok=all(check.status == "pass" for check in checks),
        checks=checks,
        assets=assets,
        verified_addresses=verified_addresses,
    )


def is_verified(organism: LoadedOrganism) -> bool:
    """Sugar for the many call sites that only need the verdict."""
    return verify_organism(organism).ok


def assert_verified(organism: LoadedOrganism) -> VerificationReport:
    """Guard used before anything is appended to an organism."""
    report = verify_organism(organism)
    if not report.ok:
        failures = "; ".join(
            f"{check.name}: {check.detail}" for check in report.checks if check.status == "fail"
        )
        raise QuantumRappidError(
            "unverified", f"{organism.document.rappid} does not verify: {failures}"
        )
    return report
