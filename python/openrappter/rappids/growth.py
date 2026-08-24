"""Growth: append a verified body frame, never mint a second identity.

Mirrors ``typescript/src/rappids/growth.ts``.

A proposal is not organism state. It is a preview with a content-addressed id,
and the id is what makes approval mean something: ``grow_organism``
re-derives the proposal from the organism itself and refuses anything whose id
does not match, so an approved preview cannot be swapped for a different
payload between the preview and the append.

Appending never touches the RAPPID. A creature that grows from baby to Raptor
is the same creature the whole way -- only a true child gets a new identity,
and it gets an explicit parent pointer with it.
"""

from __future__ import annotations

from datetime import datetime, timezone
from dataclasses import replace
from typing import Any, Dict, List, Optional, Sequence, Tuple

from .autocomplete import propose_continuation
from .canonical import (
    PROPOSAL_DOMAIN,
    RAPP_EGG_DOMAIN,
    canonical_json,
    domain_digest,
    rapp_hb,
)
from .midi import build_dna_prompt, sonic_parameters, write_midi
from .stats import (
    contiguous_frame_height,
    derive_stage,
    derive_stage_from_evidence,
    derive_stats,
    dimension_states,
    summarize,
)
from .store import (
    FRAME_TIME_PATTERN,
    append_body_frame,
    build_dimension_frame,
    format_frame_time,
    media_ref,
    write_dimension_asset,
)
from .types import (
    AssetRecord,
    AssetVerification,
    BodyFrame,
    ContinuationProposal,
    DimensionState,
    GrowthProposal,
    LoadedOrganism,
    MusicalParameters,
    Note,
    QuantumRappidError,
    VerificationReport,
)
from .verify import assert_verified, verify_organism

#: Growth requests this runtime knows how to answer. Anything else is refused.
GROWABLE_DIMENSIONS = ("sonic", "stats")

#: The instant a prediction is drafted against. Frame timestamps are
#: fixed-width, so any value of the right shape produces a frame of the same
#: canonical length -- which is what lets a preview quote exact bytes for a
#: frame that has not been written yet.
PREDICTION_INSTANT = "1970-01-01T00:00:00.000Z"

#: The lifecycle ladder as a frame records it: a name and its ordinal.
STAGE_ORDINAL = {"baby": 0, "hatchling": 1, "raptor": 2}

#: Families a stats-only preview may propose, in the order it prefers them.
PROPOSABLE_DIMENSIONS = ("memory", "skill", "sonic", "device", "visual", "capability")


class PendingGrowth:
    """A proposal plus the bytes it would write, held together until approval."""

    def __init__(
        self,
        proposal: GrowthProposal,
        frame_kind: str,
        payloads: Sequence[Tuple[str, str, bytes]],
        continuation: Optional[ContinuationProposal],
    ) -> None:
        self.proposal = proposal
        self.frame_kind = frame_kind
        #: ``(dimension, path, bytes)`` for every file the append would write.
        self.payloads = list(payloads)
        self.continuation = continuation


def sonic_context(organism: LoadedOrganism) -> Tuple[MusicalParameters, List[Note]]:
    """The prompt and key an organism sings in, recorded if it has a profile."""
    params = (
        organism.sonic.musical
        if organism.sonic is not None
        else sonic_parameters(organism.document.rappid, organism.traits.birth_traits_milli)
    )
    prompt = (
        list(organism.sonic.prompt)
        if organism.sonic is not None
        else build_dna_prompt(
            organism.document.rappid, organism.traits.birth_traits_milli, params
        )
    )
    return params, prompt


def _proposal_id(body: Dict[str, Any]) -> str:
    return domain_digest(PROPOSAL_DOMAIN, canonical_json(body))


def _pending_verification(
    dimension: str, asset: AssetRecord, payload: bytes
) -> AssetVerification:
    """A verified asset record for bytes that are in hand but not yet on disk."""
    return AssetVerification(
        dimension=dimension,
        path=asset.path,
        status="verified",
        address_space=RAPP_EGG_DOMAIN,
        address_hash=rapp_hb(RAPP_EGG_DOMAIN, payload),
        expected_bytes=asset.bytes,
        actual_bytes=asset.bytes,
        expected_sha256=asset.sha256,
        actual_sha256=asset.sha256,
        media_type=asset.media_type,
    )


def projected_stage(
    organism: LoadedOrganism,
    dimension: str,
    report: Optional[VerificationReport] = None,
) -> Dict[str, Any]:
    """The stage this frame would record, read off the body it would create.

    The dimension being appended counts as active because the frame is what
    makes it active; everything else is the organism's current evidence.
    """
    if report is None:
        report = verify_organism(organism)
    dimensions: List[DimensionState] = []
    seen = False
    for entry in dimension_states(organism, report):
        if entry.name == dimension:
            seen = True
            dimensions.append(replace(entry, status="active"))
        else:
            dimensions.append(entry)
    if not seen:
        dimensions.append(
            DimensionState(name=dimension, status="active", media_types=[], unmeasured=False)
        )
    name = derive_stage_from_evidence(
        contiguous_frame_height(organism.frames) + 1, dimensions
    )
    return {"name": name, "ordinal": STAGE_ORDINAL[name]}


def _draft_frame(
    organism: LoadedOrganism,
    dimension: str,
    version: int,
    media: Dict[str, Any],
    created_at: str,
    report: VerificationReport,
) -> BodyFrame:
    """Build the frame a proposal would append.

    ``created_at`` is an input rather than a clock read, because the frame hash
    covers it: a proposal id that changed every second could never be approved.
    """
    seq = len(organism.frames)
    return build_dimension_frame(
        rappid=organism.document.rappid,
        seq=seq,
        utc=created_at,
        prev=None if seq == 0 else organism.frames[seq - 1].payload_hash,
        dimension=dimension,
        version=version,
        stage=projected_stage(organism, dimension, report),
        traits=dict(organism.traits.traits_milli),
        media=media,
    )


def _predict(
    organism: LoadedOrganism,
    report: VerificationReport,
    frame: BodyFrame,
    payloads: Sequence[Tuple[AssetRecord, bytes]],
):
    """What the organism would look like after this frame, without writing it.

    The prediction runs the real derivation over a copy rather than a parallel
    "estimate" path: a preview computed differently from the thing it previews
    is how a habitat starts lying to its operator.
    """
    dimension = str(frame.payload.get("dimension"))
    projected = LoadedOrganism(
        directory=organism.directory,
        document=organism.document,
        traits=organism.traits,
        sonic=organism.sonic,
        frames=[*organism.frames, frame],
    )
    projected_report = VerificationReport(
        rappid=report.rappid,
        ok=report.ok,
        checks=report.checks,
        assets=[
            *report.assets,
            *[
                _pending_verification(dimension, asset, payload)
                for asset, payload in payloads
            ],
        ],
        verified_addresses=sorted(
            {
                *report.verified_addresses,
                *[
                    f"{RAPP_EGG_DOMAIN}:{rapp_hb(RAPP_EGG_DOMAIN, payload)}"
                    for _asset, payload in payloads
                ],
            }
        ),
    )
    dimensions = dimension_states(projected, projected_report)
    stats = derive_stats(projected, projected_report, dimensions)
    return stats, derive_stage(stats, dimensions)


def build_growth_proposal(
    organism: LoadedOrganism, dimension: str, report: Optional[VerificationReport] = None
) -> PendingGrowth:
    """One growth proposal for a dimension.

    The proposal id covers everything that would be written -- dimension, kind,
    evidence and the exact content addresses of every byte -- so approving an
    id approves a specific append and nothing else.
    """
    if dimension not in GROWABLE_DIMENSIONS:
        raise QuantumRappidError(
            "ungrowable-dimension",
            f"no growth path for dimension {dimension!r}; "
            f"known: {', '.join(GROWABLE_DIMENSIONS)}",
        )
    if report is None:
        report = verify_organism(organism)

    rappid = organism.document.rappid
    payloads: List[Tuple[str, str, bytes]] = []
    continuation: Optional[ContinuationProposal] = None
    assets: List[AssetRecord] = []
    appendable = dimension == "sonic"

    if dimension == "sonic":
        params, prompt = sonic_context(organism)
        cursor = (
            organism.document.external_episode.cursor
            if organism.document.external_episode is not None
            else None
        )
        continuation = propose_continuation(
            rappid, organism.traits.traits_milli, params, prompt, cursor
        )
        payload = write_midi([*prompt, *continuation.continuation], params)
        path = f"assets/autocomplete-{continuation.midi_sha256[:12]}.mid"
        assets = [
            AssetRecord(
                path=path,
                bytes=len(payload),
                sha256=continuation.midi_sha256,
                media_type="application/x-midi",
                duration_seconds=None,
            )
        ]
        payloads.append(("sonic", path, payload))
        frame_dimension = "sonic"
        title = "A trait-conditioned continuation of the identity motif"
        summary = (
            f"{len(continuation.continuation)} notes continuing the {len(prompt)}-note MIDI DNA, "
            f"selected from {continuation.candidate_count} deterministic candidates."
        )
        evidence = [
            f"provider: {continuation.provider['name']} "
            f"({continuation.provider['kind']}, not a trained transformer)",
            f"selected candidate {continuation.selected_candidate} of {continuation.candidate_count}",
            f"continuation score {continuation.scores_micro.continuation} / 1000000",
            f"standalone score {continuation.scores_micro.sounds_good} / 1000000",
            f"rendered midi sha256 {continuation.midi_sha256}",
        ]
    else:
        carried = {entry.name for entry in organism.document.dimensions} | {
            str(entry.payload.get("dimension")) for entry in organism.frames
        }
        frame_dimension = next(
            (name for name in PROPOSABLE_DIMENSIONS if name not in carried), "capability"
        )
        title = f"A proposed {frame_dimension} dimension"
        summary = (
            "A lineage- and trait-conditioned preview. It carries no data yet and "
            "cannot be appended."
        )
        evidence = [
            *[f"verified {address}" for address in report.verified_addresses],
            f"checks passed: {sum(1 for check in report.checks if check.status == 'pass')}",
        ]

    version = 1 + sum(
        1
        for candidate in organism.frames
        if str(candidate.payload.get("dimension")) == frame_dimension
    )
    media: Dict[str, Any] = {}
    pending_assets: List[Tuple[AssetRecord, bytes]] = []
    for index, (_dimension, _path, payload_bytes) in enumerate(payloads):
        asset = assets[index]
        role = "midi-autocomplete" if frame_dimension == "sonic" else f"asset-{index + 1}"
        media[role] = media_ref(payload_bytes, asset.media_type)
        pending_assets.append((asset, payload_bytes))

    # Fixed, not a clock read: a preview must predict the same organism twice.
    frame = _draft_frame(
        organism, frame_dimension, version, media, PREDICTION_INSTANT, report
    )
    stats, stage = _predict(organism, report, frame, pending_assets)

    proposal_id = _proposal_id(
        {
            "rappid": rappid,
            "dimension": frame_dimension,
            "kind": "body.dimension",
            "version": version,
            "title": title,
            "summary": summary,
            "evidence": list(evidence),
            "media": media,
            "seq": frame.seq,
            "prev": frame.prev,
        }
    )

    return PendingGrowth(
        proposal=GrowthProposal(
            id=proposal_id,
            rappid=rappid,
            dimension=frame_dimension,
            title=title,
            summary=summary,
            predicted_stats=stats,
            predicted_stage=stage,
            evidence=list(evidence),
            assets=assets,
            appendable=appendable,
        ),
        frame_kind="body.dimension",
        payloads=payloads,
        continuation=continuation,
    )


def grow_organism(
    organism: LoadedOrganism, proposal_id: str, created_at: Optional[str] = None
) -> Dict[str, Any]:
    """Append an approved proposal.

    Order matters: verify first, write the bytes, then append the frame that
    points at them. A frame that names an asset which is not on disk would be a
    lie the next verification catches -- but it is better not to write it.
    """
    report = assert_verified(organism)
    matches = [
        pending
        for pending in (
            build_growth_proposal(organism, dimension, report)
            for dimension in GROWABLE_DIMENSIONS
        )
        if pending.proposal.id == proposal_id
    ]
    if not matches:
        raise QuantumRappidError(
            "unknown-proposal",
            f"proposal {proposal_id} does not match any growth this organism can currently "
            "produce; preview it again and approve the new id",
        )
    pending = matches[0]
    if not pending.proposal.appendable:
        raise QuantumRappidError(
            "proposal-not-appendable",
            "this autocomplete result is a preview only; attach real verified "
            "dimension data first",
        )
    stamp = created_at if created_at is not None else format_frame_time(datetime.now(timezone.utc))
    if not FRAME_TIME_PATTERN.fullmatch(stamp):
        raise QuantumRappidError(
            "frame-time",
            f"created_at {stamp} is not YYYY-MM-DDTHH:MM:SS.mmmZ",
        )

    written = [
        write_dimension_asset(organism, dimension, path, payload)
        for dimension, path, payload in pending.payloads
    ]
    version = 1 + sum(
        1
        for candidate in organism.frames
        if str(candidate.payload.get("dimension")) == pending.proposal.dimension
    )
    media: Dict[str, Any] = {}
    for index, (_dimension, _path, payload_bytes) in enumerate(pending.payloads):
        role = (
            "midi-autocomplete"
            if pending.proposal.dimension == "sonic"
            else f"asset-{index + 1}"
        )
        media[role] = media_ref(payload_bytes, written[index].media_type)
    frame = _draft_frame(
        organism, pending.proposal.dimension, version, media, stamp, report
    )
    frame_path = append_body_frame(organism, frame)
    verification = verify_organism(organism)

    return {
        "rappid": organism.document.rappid,
        "appended": frame.to_wire(),
        "framePath": frame_path,
        "writtenAssets": [asset.to_wire() for asset in written],
        "summary": summarize(organism, verification),
        "verification": verification.to_wire(),
    }
