"""Quantum RAPPIDs -- the operations a habitat, an agent or a gateway performs.

Mirrors ``typescript/src/rappids/index.ts``.

One canonical RAPP/1 identity, many independently verifiable dimensions,
append-only growth, and nothing here that mints a second identity for an
organism that merely grew.

Playback is a *data* handoff: ``read_asset_payload`` returns verified bytes and
their content address, and the caller plays them in process. Nothing in this
subsystem shells out to a player, so a habitat cannot be talked into executing
a path that arrived in a manifest.
"""

from __future__ import annotations

import base64
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

from .autocomplete import (
    DEFAULT_CANDIDATE_COUNT,
    DEFAULT_CONTINUATION_LENGTH,
    PROVIDER,
    contour_intervals,
    continuation_seed,
    generate_candidate,
    generate_candidates,
    present_scores,
    propose_continuation,
    score_candidate,
)
from .canonical import (
    AUTOCOMPLETE_DOMAIN,
    PROPOSAL_DOMAIN,
    RAPP_EGG_DOMAIN,
    RAPP_PARTICLE_DOMAIN,
    RAPP_WAVE_DOMAIN,
    DeterministicStream,
    canonical_digest,
    canonical_json,
    domain_digest,
    idiv,
    micro_to_float,
    rapp_canonical_json,
    rapp_h,
    rapp_hb,
    round_half_up,
    sha256_hex,
    trait_milli,
)
from .growth import (
    GROWABLE_DIMENSIONS,
    PendingGrowth,
    build_growth_proposal,
    grow_organism,
    projected_stage,
    sonic_context,
)
from .identity import (
    directory_hex,
    format_rappid,
    identity_drift,
    is_rappid,
    parse_rappid,
    rappid_hex,
    validate_parent_pointer,
)
from .midi import (
    PPQ,
    STEP,
    build_dna_prompt,
    midi_duration_ticks,
    nearest_scale_pitch,
    note_from_json,
    note_to_json,
    sonic_parameters,
    ticks_to_milliseconds,
    variable_length,
    write_midi,
)
from .stats import (
    CENSUS_DIMENSION,
    SPECIES_HEIGHT_CURVE,
    STAGE_LADDER,
    contiguous_frame_height,
    derive_stage,
    derive_stage_from_evidence,
    derive_stats,
    dimension_states,
    summarize,
)
from .store import (
    BODY_FRAME_SCHEMA,
    FRAME_TIME_PATTERN,
    OBJECTS_DIRECTORY,
    append_body_frame,
    asset_bytes,
    body_frame_digest,
    body_frame_to_json,
    build_dimension_frame,
    format_frame_time,
    list_organism_directories,
    load_organism,
    load_organism_by_rappid,
    load_organisms,
    media_ref,
    rappids_home,
    read_rapp_object,
    resolve_within,
    store_rapp_object,
    write_dimension_asset,
)
from .types import (
    AssetRecord,
    AssetVerification,
    BodyFrame,
    ContinuationProposal,
    CreatureStats,
    DimensionState,
    GrowthProposal,
    LoadedOrganism,
    Note,
    PlaybackManifest,
    PlaybackTrack,
    QuantumRappidError,
    SonicProfile,
    VerificationCheck,
    VerificationReport,
)
from .verify import assert_verified, is_verified, verify_organism

__all__ = [
    "AUTOCOMPLETE_DOMAIN",
    "BODY_FRAME_SCHEMA",
    "CENSUS_DIMENSION",
    "DEFAULT_CANDIDATE_COUNT",
    "DEFAULT_CONTINUATION_LENGTH",
    "FRAME_TIME_PATTERN",
    "GROWABLE_DIMENSIONS",
    "OBJECTS_DIRECTORY",
    "PPQ",
    "PROPOSAL_DOMAIN",
    "PROVIDER",
    "RAPP_EGG_DOMAIN",
    "RAPP_PARTICLE_DOMAIN",
    "RAPP_WAVE_DOMAIN",
    "SPECIES_HEIGHT_CURVE",
    "STAGE_LADDER",
    "STEP",
    "AssetRecord",
    "AssetVerification",
    "BodyFrame",
    "ContinuationProposal",
    "CreatureStats",
    "DeterministicStream",
    "DimensionState",
    "GrowthProposal",
    "LoadedOrganism",
    "Note",
    "PendingGrowth",
    "PlaybackManifest",
    "PlaybackTrack",
    "QuantumRappidError",
    "SonicProfile",
    "VerificationCheck",
    "VerificationReport",
    "append_body_frame",
    "assert_verified",
    "asset_bytes",
    "attach_skill_dimension",
    "body_frame_digest",
    "body_frame_to_json",
    "build_dna_prompt",
    "build_dimension_frame",
    "build_growth_proposal",
    "build_playback_manifest",
    "canonical_digest",
    "canonical_json",
    "complete_rappid",
    "contiguous_frame_height",
    "continuation_seed",
    "contour_intervals",
    "derive_stage",
    "derive_stage_from_evidence",
    "derive_stats",
    "dimension_states",
    "directory_hex",
    "domain_digest",
    "format_frame_time",
    "format_rappid",
    "generate_candidate",
    "generate_candidates",
    "grow_organism",
    "grow_rappid",
    "identity_drift",
    "idiv",
    "inspect_organism",
    "is_rappid",
    "is_verified",
    "list_organism_directories",
    "list_organism_summaries",
    "load_organism",
    "load_organism_by_rappid",
    "load_organisms",
    "media_ref",
    "micro_to_float",
    "midi_duration_ticks",
    "nearest_scale_pitch",
    "note_from_json",
    "note_to_json",
    "parse_rappid",
    "playback_manifest",
    "present_scores",
    "propose_continuation",
    "propose_growth",
    "projected_stage",
    "rapp_canonical_json",
    "rapp_h",
    "rapp_hb",
    "rappid_hex",
    "rappids_home",
    "read_asset_payload",
    "read_rapp_object",
    "resolve_within",
    "round_half_up",
    "score_candidate",
    "sha256_hex",
    "sonic_context",
    "sonic_parameters",
    "store_rapp_object",
    "summarize",
    "ticks_to_milliseconds",
    "trait_milli",
    "validate_parent_pointer",
    "variable_length",
    "verify_organism",
    "verify_rappid",
    "write_dimension_asset",
    "write_midi",
]


def list_organism_summaries(root: Optional[str] = None) -> List[Dict[str, Any]]:
    """Every organism in the habitat, summarised for the wire."""
    return [
        summarize(organism, verify_organism(organism))
        for organism in load_organisms(root if root is not None else rappids_home())
    ]


def _organism_for(rappid: str, root: Optional[str]) -> LoadedOrganism:
    return load_organism_by_rappid(rappid, root if root is not None else rappids_home())


def build_playback_manifest(
    organism: LoadedOrganism, verification: Optional[VerificationReport] = None
) -> PlaybackManifest:
    """What this organism can be played back as, and from which exact bytes.

    Device capability comes from the organism's own device dimension rather
    than from what happens to be installed: a habitat that claims playback it
    cannot do is the same class of error as a creature that claims weight it
    cannot produce.
    """
    if verification is None:
        verification = verify_organism(organism)
    device = next(
        (
            dimension
            for dimension in organism.document.dimensions
            if dimension.name == "device"
        ),
        None,
    )
    device_media_types = list(device.media_types) if device is not None else []
    sonic = organism.sonic
    if sonic is None:
        return PlaybackManifest(
            rappid=organism.document.rappid,
            device_media_types=device_media_types,
            preferred=None,
            lossless_fallback=None,
            tracks=[],
        )

    tracks: List[PlaybackTrack] = []
    for role, key in (
        ("preferred", "preferred"),
        ("lossless-fallback", "lossless_fallback"),
        ("midi-dna", "midi_prompt"),
        ("midi-autocomplete", "midi_autocomplete"),
    ):
        path = getattr(sonic.device_playback, key)
        if path is None:
            continue
        asset = next((entry for entry in sonic.assets if entry.path == path), None)
        if asset is None:
            continue
        verified = any(
            entry.dimension == sonic.dimension
            and entry.path == path
            and entry.status == "verified"
            for entry in verification.assets
        )
        tracks.append(
            PlaybackTrack(
                role=role,
                path=path,
                media_type=asset.media_type,
                bytes=asset.bytes,
                sha256=asset.sha256,
                duration_seconds=asset.duration_seconds,
                verified=verified,
            )
        )

    return PlaybackManifest(
        rappid=organism.document.rappid,
        device_media_types=device_media_types,
        preferred=next((track for track in tracks if track.role == "preferred"), None),
        lossless_fallback=next(
            (track for track in tracks if track.role == "lossless-fallback"), None
        ),
        tracks=tracks,
        requires_user_gesture=sonic.device_playback.requires_user_gesture,
        stop_control_required=sonic.device_playback.stop_control_required,
    )


def inspect_organism(rappid: str, root: Optional[str] = None) -> Dict[str, Any]:
    organism = _organism_for(rappid, root)
    verification = verify_organism(organism)
    return {
        "summary": summarize(organism, verification),
        "verification": verification.to_wire(),
        "directory": organism.directory,
        "bornAt": organism.document.born_at,
        "kernelVersion": organism.document.kernel_version,
        "frames": [frame.to_wire() for frame in organism.frames],
        "playback": build_playback_manifest(organism, verification).to_wire(),
    }


def verify_rappid(rappid: str, root: Optional[str] = None) -> VerificationReport:
    return verify_organism(_organism_for(rappid, root))


def complete_rappid(
    rappid: str,
    root: Optional[str] = None,
    candidate_count: int = DEFAULT_CANDIDATE_COUNT,
    continuation_length: int = DEFAULT_CONTINUATION_LENGTH,
    engram_cursor: Optional[str] = None,
    use_organism_cursor: bool = True,
) -> Dict[str, Any]:
    """Propose a continuation of the organism's identity motif.

    Nothing is written. The result is explicitly non-authoritative until a
    growth frame appends it.
    """
    organism = _organism_for(rappid, root)
    params, prompt = sonic_context(organism)
    cursor = engram_cursor
    if cursor is None and use_organism_cursor:
        cursor = (
            organism.document.external_episode.cursor
            if organism.document.external_episode is not None
            else None
        )
    proposal = propose_continuation(
        organism.document.rappid,
        organism.traits.traits_milli,
        params,
        prompt,
        cursor,
        candidate_count,
        continuation_length,
    )
    midi = write_midi([*prompt, *proposal.continuation], params)
    return {
        "rappid": proposal.rappid,
        "provider": proposal.provider,
        "musical": params.to_wire(),
        "prompt": [note.to_wire() for note in proposal.prompt],
        "selectedCandidate": proposal.selected_candidate,
        "candidateCount": proposal.candidate_count,
        "continuation": [note.to_wire() for note in proposal.continuation],
        "scoresMicro": proposal.scores_micro.to_wire(),
        "scores": present_scores(proposal.scores_micro),
        "midiSha256": proposal.midi_sha256,
        "midiBytes": proposal.midi_bytes,
        "midiBase64": base64.b64encode(midi).decode("ascii"),
        # A proposal is a proposal until a verified frame appends it.
        "authoritative": False,
    }


def propose_growth(rappid: str, dimension: str, root: Optional[str] = None) -> GrowthProposal:
    return build_growth_proposal(_organism_for(rappid, root), dimension).proposal


def grow_rappid(
    rappid: str,
    proposal_id: str,
    root: Optional[str] = None,
    created_at: Optional[str] = None,
) -> Dict[str, Any]:
    return grow_organism(_organism_for(rappid, root), proposal_id, created_at)


def playback_manifest(rappid: str, root: Optional[str] = None) -> PlaybackManifest:
    organism = _organism_for(rappid, root)
    return build_playback_manifest(organism, verify_organism(organism))


#: Friendly names the habitat uses for the tracks it offers.
ASSET_ALIASES = {
    "wake-call": "preferred",
    "wake-call-lossless": "lossless_fallback",
    "midi-dna": "midi_prompt",
    "midi-autocomplete": "midi_autocomplete",
}


def _resolve_asset(sonic: SonicProfile, key: str) -> AssetRecord:
    alias = ASSET_ALIASES.get(key)
    path = key if alias is None else getattr(sonic.device_playback, alias)
    if path is None:
        raise QuantumRappidError("unknown-asset", f"this organism offers no {key!r} track")
    asset = next((entry for entry in sonic.assets if entry.path == path), None)
    if asset is None:
        raise QuantumRappidError(
            "unknown-asset", f"{path} is not recorded in the sonic manifest"
        )
    return asset


def read_asset_payload(
    rappid: str, key: str, root: Optional[str] = None
) -> Dict[str, Any]:
    """Verified bytes for one asset, base64 for the wire.

    The digest is re-checked at read time rather than trusted from the earlier
    verification pass: a file can change between the two, and handing a player
    bytes that no longer match their content address is exactly the failure the
    manifest exists to prevent.
    """
    organism = _organism_for(rappid, root)
    if organism.sonic is None:
        raise QuantumRappidError("no-sonic-dimension", f"{rappid} carries no sonic dimension")
    asset = _resolve_asset(organism.sonic, key)
    payload = asset_bytes(organism, organism.sonic.dimension, asset.path)
    digest = sha256_hex(payload)
    if len(payload) != asset.bytes or digest != asset.sha256:
        raise QuantumRappidError(
            "asset-tampered",
            f"{asset.path} does not match its content address: manifest says {asset.bytes} "
            f"bytes / {asset.sha256}, disk has {len(payload)} bytes / {digest}",
        )
    return {
        "mediaType": asset.media_type,
        "base64": base64.b64encode(payload).decode("ascii"),
        "sha256": digest,
        "bytes": len(payload),
        "path": asset.path,
    }


def attach_skill_dimension(
    rappid: str,
    artifact_path: str,
    content_hash: str,
    artifact_root: str,
    name: str,
    session_id: str,
    root: Optional[str] = None,
    created_at: Optional[str] = None,
) -> Dict[str, Any]:
    """Record an approved skill as a verified skill dimension.

    ``name`` and ``session_id`` are the recorder's own labels for the artifact
    and are carried by the caller's contract; nothing here derives identity or
    integrity from them, because both are re-derived from the bytes instead.
    """
    organism = _organism_for(rappid, root)
    report = assert_verified(organism)
    root_path = Path(artifact_root).resolve()
    skill_path = Path(artifact_path).resolve()
    relative = os.path.relpath(str(skill_path), str(root_path))
    if relative.startswith("..") or relative == "" or os.path.isabs(relative):
        raise QuantumRappidError(
            "skill-path",
            "the recorded skill is outside the private OpenRappter skills directory",
        )
    if not skill_path.is_file() or skill_path.is_symlink():
        raise QuantumRappidError("skill-path", "the recorded skill is not a regular file")
    manifest_path = (skill_path.parent / "manifest.json").resolve()
    manifest_relative = os.path.relpath(str(manifest_path), str(root_path))
    if manifest_relative.startswith("..") or os.path.isabs(manifest_relative):
        raise QuantumRappidError(
            "skill-manifest",
            "the recorded skill manifest escapes the private skills directory",
        )
    if not manifest_path.is_file() or manifest_path.is_symlink():
        raise QuantumRappidError("skill-manifest", "the recorded skill manifest is missing")
    skill_bytes = skill_path.read_bytes()
    manifest_bytes = manifest_path.read_bytes()
    combined_hash = sha256_hex(skill_bytes + b"\x00" + manifest_bytes)
    if combined_hash != content_hash:
        raise QuantumRappidError(
            "skill-integrity",
            f"recorded skill hash {combined_hash} does not match {content_hash}",
        )
    skill_asset = write_dimension_asset(
        organism, "skill", f"assets/{content_hash[:16]}.skill.md", skill_bytes
    )
    manifest_asset = write_dimension_asset(
        organism, "skill", f"assets/{content_hash[:16]}.manifest.json", manifest_bytes
    )
    version = 1 + sum(
        1 for frame in organism.frames if str(frame.payload.get("dimension")) == "skill"
    )
    frame = build_dimension_frame(
        rappid=rappid,
        seq=len(organism.frames),
        utc=created_at if created_at is not None else format_frame_time(
            datetime.now(timezone.utc)
        ),
        prev=organism.frames[-1].payload_hash if organism.frames else None,
        dimension="skill",
        version=version,
        stage=projected_stage(organism, "skill", report),
        traits=dict(organism.traits.traits_milli),
        media={
            "skill": media_ref(skill_bytes, skill_asset.media_type),
            "manifest": media_ref(manifest_bytes, manifest_asset.media_type),
        },
    )
    frame_path = append_body_frame(organism, frame)
    after = verify_organism(organism)
    return {
        "rappid": rappid,
        "appended": frame.to_wire(),
        "framePath": frame_path,
        "writtenAssets": [skill_asset.to_wire(), manifest_asset.to_wire()],
        "summary": summarize(organism, after),
        "verification": after.to_wire(),
    }
