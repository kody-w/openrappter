"""Creature stats, derived -- never asserted, never estimated.

Mirrors ``typescript/src/rappids/stats.ts``.

Weight is exact integer bytes over unique verified content addresses. A
``(dimension, sha256)`` pair counts once, so carrying the same asset twice
cannot make an organism heavier, and an unknown size makes the total
*incomplete* rather than approximate: ``None`` is the honest answer and a guess
is not.

Lifecycle stage is derived state. It is a reading of how much verified body an
organism has accumulated, and it never touches the RAPPID -- a Raptor and the
baby it grew from are the same creature with the same identity. Nothing here
infers maturity from file size.
"""

from __future__ import annotations

from typing import Any, Dict, List, Sequence

from .canonical import rapp_canonical_json
from .store import body_frame_to_json
from .types import (
    BodyFrame,
    CreatureStats,
    DimensionState,
    LoadedOrganism,
    VerificationReport,
)

#: A versioned presentation curve over frame height. Height is how the habitat
#: draws the creature: not identity, not a physical fact, and kept away from
#: every integrity path.
SPECIES_HEIGHT_CURVE = {
    "id": "quantum-continuity/1",
    "base_mm": 420,
    "per_frame_mm": 90,
    "max_mm": 2400,
}

#: Frames that record evidence about the organism rather than a new sense. A
#: census frame proves what verified today; counting it as a dimension would
#: inflate the one stat that is supposed to mean "this organism gained a way of
#: being in the world".
CENSUS_DIMENSION = "census"

#: What each stage requires, in the order they are tested. The thresholds are
#: about *verified body*, which is why a compact organism with one rich
#: dimension stays a baby.
STAGE_LADDER = (
    {
        "stage": "raptor",
        "min_frame_height": 8,
        "min_active_dimensions": 4,
        "required_active": ("memory", "skill"),
    },
    {
        "stage": "hatchling",
        "min_frame_height": 2,
        "min_active_dimensions": 2,
        "required_active": (),
    },
    {
        "stage": "baby",
        "min_frame_height": 0,
        "min_active_dimensions": 0,
        "required_active": (),
    },
)


def contiguous_frame_height(frames: Sequence[BodyFrame]) -> int:
    """How deep the accepted, unbroken history goes.

    Contiguous: the first frame that does not continue the chain ends the
    count, because everything after it rests on a link that did not hold.
    """
    height = 0
    parent = None
    for frame in frames:
        if frame.seq != height:
            break
        if frame.prev != parent:
            break
        height += 1
        parent = frame.payload_hash
    return height


def _frame_weight_bytes(frames: Sequence[BodyFrame], height: int) -> int:
    """Bytes an accepted frame contributes: its own canonical body, counted once."""
    counted = set()
    total = 0
    for frame in frames[:height]:
        if frame.frame_hash in counted:
            continue
        counted.add(frame.frame_hash)
        total += len(rapp_canonical_json(body_frame_to_json(frame)).encode("utf-8"))
    return total


def dimension_states(
    organism: LoadedOrganism, report: VerificationReport
) -> List[DimensionState]:
    """Every dimension family the organism carries, declared or witnessed.

    Declared dimensions come from ``rappid.json``; frames can witness families
    that were not declared when the organism was minted, which is exactly what
    growth is. Both are the same organism, so both are listed.
    """
    states: Dict[str, DimensionState] = {}
    verified = {asset.dimension for asset in report.assets if asset.status == "verified"}
    broken = {asset.dimension for asset in report.assets if asset.status != "verified"}
    failed = {
        check.name.split(".", 1)[0] for check in report.checks if check.status == "fail"
    }

    for dimension in organism.document.dimensions:
        path_refs = [ref for ref in dimension.refs.values() if "/" in ref]
        external_refs = [ref for ref in dimension.refs.values() if "/" not in ref]
        has_local_content = dimension.name in verified or bool(path_refs)
        if dimension.name in broken or dimension.name in failed:
            status = "missing"
        elif has_local_content:
            status = "active"
        else:
            status = "linked"
        states[dimension.name] = DimensionState(
            name=dimension.name,
            status=status,
            media_types=list(dimension.media_types),
            unmeasured=bool(external_refs),
        )

    for frame in organism.frames:
        dimension_name = str(frame.payload.get("dimension"))
        if dimension_name in states:
            continue
        states[dimension_name] = DimensionState(
            name=dimension_name,
            status="missing" if dimension_name in broken else "active",
            media_types=[],
            unmeasured=False,
        )

    return [states[name] for name in sorted(states)]


def derive_stats(
    organism: LoadedOrganism,
    report: VerificationReport,
    dimensions: Sequence[DimensionState],
) -> CreatureStats:
    frame_height = contiguous_frame_height(organism.frames)
    unique_verified: Dict[str, int] = {}
    for asset in report.assets:
        if asset.status != "verified":
            continue
        unique_verified[f"{asset.address_space}:{asset.address_hash}"] = asset.expected_bytes
    resident_weight_bytes = sum(unique_verified.values()) + _frame_weight_bytes(
        organism.frames, frame_height
    )

    # Known-but-absent bytes are only *known* if the manifest that recorded
    # them verified. Otherwise there is no attestation behind the number.
    manifest_trusted = not any(
        check.status == "fail" and check.name == "sonic.manifest" for check in report.checks
    )
    linked_unique: Dict[str, int] = {}
    if manifest_trusted:
        for asset in report.assets:
            if asset.status != "missing":
                continue
            # A missing asset has no egg address to count by -- nothing hashed
            # it, because the bytes are not here. Its manifest digest is the
            # only identity it has, and it still must count exactly once.
            content_key = (
                f"{asset.address_space}:{asset.address_hash}"
                if asset.address_hash
                else f"sha256:{asset.expected_sha256}"
            )
            linked_unique[content_key] = asset.expected_bytes
    linked_known = sum(linked_unique.values())

    unmeasured = any(dimension.unmeasured for dimension in dimensions)
    linked_weight_bytes = None if unmeasured else linked_known

    return CreatureStats(
        frame_height=frame_height,
        display_height_mm=min(
            int(SPECIES_HEIGHT_CURVE["max_mm"]),
            int(SPECIES_HEIGHT_CURVE["base_mm"])
            + int(SPECIES_HEIGHT_CURVE["per_frame_mm"]) * frame_height,
        ),
        total_weight_bytes=(
            None if linked_weight_bytes is None else resident_weight_bytes + linked_weight_bytes
        ),
        verified_weight_bytes=resident_weight_bytes,
        resident_weight_bytes=resident_weight_bytes,
        linked_weight_bytes=linked_weight_bytes,
        weight_complete=not unmeasured,
        unique_frames=len({frame.frame_hash for frame in organism.frames[:frame_height]}),
        unique_assets=len(unique_verified),
    )


def derive_stage_from_evidence(
    frame_height: int, dimensions: Sequence[DimensionState]
) -> str:
    """Stage is read off verified body. It never re-mints or renames anything."""
    active = [dimension for dimension in dimensions if dimension.status == "active"]
    active_names = {dimension.name for dimension in active}
    for rung in STAGE_LADDER:
        if frame_height < rung["min_frame_height"]:
            continue
        if len(active) < rung["min_active_dimensions"]:
            continue
        if not all(name in active_names for name in rung["required_active"]):
            continue
        return str(rung["stage"])
    return "baby"


def derive_stage(stats: CreatureStats, dimensions: Sequence[DimensionState]) -> str:
    """Stage from a complete derived stat block."""
    return derive_stage_from_evidence(stats.frame_height, dimensions)


def summarize(organism: LoadedOrganism, report: VerificationReport) -> Dict[str, Any]:
    """The gateway wire shape for one organism. Identical in both runtimes."""
    dimensions = dimension_states(organism, report)
    stats = derive_stats(organism, report, dimensions)
    sonic = organism.sonic
    verified_paths = {
        asset.path for asset in report.assets if asset.status == "verified"
    }

    summary: Dict[str, Any] = {
        "rappid": organism.document.rappid,
        "name": organism.document.name,
        "displayName": organism.document.display_name,
        "species": organism.document.name,
        "lifecycleStage": derive_stage(stats, dimensions),
        "localOnly": organism.document.local_only,
        "parentRappid": organism.document.parent_rappid,
        "stats": stats.to_wire(),
        "traits": dict(organism.traits.traits),
        "dimensions": [dimension.to_wire() for dimension in dimensions],
        "externalEpisode": (
            None
            if organism.document.external_episode is None
            else organism.document.external_episode.to_wire()
        ),
        "verified": report.ok,
        "unmeasuredDimensions": [
            dimension.name for dimension in dimensions if dimension.unmeasured
        ],
    }

    if sonic is not None:
        playback = sonic.device_playback

        def verified_track(path):
            return path is not None and path in verified_paths

        summary["sonic"] = {
            "wakeCall": verified_track(playback.preferred)
            or verified_track(playback.lossless_fallback),
            "midiDna": verified_track(playback.midi_prompt),
            "autocomplete": verified_track(playback.midi_autocomplete),
        }
    return summary
