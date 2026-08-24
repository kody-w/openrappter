"""The shapes a Quantum RAPPID is made of.

Mirrors ``typescript/src/rappids/types.ts``. One canonical RAPP/1 identity,
many independently verifiable dimensions. Nothing here derives identity from a
trait, a media hash, a weight, a height or a lifecycle stage -- those are all
projections of an organism whose RAPPID was minted once and never re-minted.

Wire shapes (summary, stats, proposals, reports) are emitted as camelCase
dicts by the ``to_wire`` helpers, because the gateway and the habitat UI read
the *same* JSON from either runtime.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional


class QuantumRappidError(Exception):
    """Every failure this subsystem raises. Never swallowed, never defaulted away."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass(frozen=True)
class RappidParts:
    owner: str
    name: str
    hex: str


@dataclass(frozen=True)
class ExternalEpisodeRef:
    source: str
    session_guid: str
    memory_key: str
    cursor: Optional[str]

    def to_wire(self) -> Dict[str, Any]:
        return {
            "source": self.source,
            "sessionGuid": self.session_guid,
            "memoryKey": self.memory_key,
            "cursor": self.cursor,
        }


@dataclass(frozen=True)
class DimensionRecord:
    name: str
    status: str
    refs: Dict[str, str]
    media_types: List[str]


@dataclass(frozen=True)
class RappidDocument:
    schema: str
    rappid: str
    kind: str
    name: str
    display_name: str
    url: Optional[str]
    parent_rappid: Optional[str]
    born_at: str
    kernel_version: Optional[str]
    external_episode: Optional[ExternalEpisodeRef]
    quantum_schema: str
    dimensions: List[DimensionRecord]
    local_only: bool


@dataclass(frozen=True)
class TraitsDocument:
    schema: str
    rappid: str
    #: Immutable identity-conditioning snapshot recorded at birth.
    birth_traits: Dict[str, float]
    birth_traits_milli: Dict[str, int]
    #: Trait name -> 0.0..1.0. Presentation value; scoring uses ``traits_milli``.
    traits: Dict[str, float]
    #: Trait name -> 0..1000 integers. The only form the providers score with.
    traits_milli: Dict[str, int]


@dataclass(frozen=True)
class Note:
    """``NOTE(pitch, delta_onset, duration, velocity)`` -- the whole note event."""

    pitch: int
    delta_onset: int
    duration: int
    velocity: int

    def to_json(self) -> Dict[str, int]:
        return {
            "pitch": self.pitch,
            "delta_onset": self.delta_onset,
            "duration": self.duration,
            "velocity": self.velocity,
        }

    def to_wire(self) -> Dict[str, int]:
        """The gateway form. On disk a note is snake_case; on the wire it is not."""
        return {
            "pitch": self.pitch,
            "deltaOnset": self.delta_onset,
            "duration": self.duration,
            "velocity": self.velocity,
        }


@dataclass(frozen=True)
class MusicalParameters:
    root_pitch: int
    root_pitch_class: int
    mode: str
    scale: List[int]
    bpm: int
    program: int

    def to_wire(self) -> Dict[str, Any]:
        return {
            "rootPitch": self.root_pitch,
            "rootPitchClass": self.root_pitch_class,
            "mode": self.mode,
            "scale": list(self.scale),
            "bpm": self.bpm,
            "program": self.program,
        }


@dataclass(frozen=True)
class AssetRecord:
    """One content-addressed file carried by a dimension."""

    path: str
    bytes: int
    sha256: str
    media_type: str
    duration_seconds: Optional[float] = None

    def to_json(self) -> Dict[str, Any]:
        value: Dict[str, Any] = {
            "path": self.path,
            "bytes": self.bytes,
            "sha256": self.sha256,
            "media_type": self.media_type,
        }
        if self.duration_seconds is not None:
            value["duration_seconds"] = self.duration_seconds
        return value

    def to_wire(self) -> Dict[str, Any]:
        return {
            "path": self.path,
            "bytes": self.bytes,
            "sha256": self.sha256,
            "mediaType": self.media_type,
            "durationSeconds": self.duration_seconds,
        }


@dataclass(frozen=True)
class DevicePlayback:
    """How a habitat is allowed to play this organism.

    The roles are normalised because manifests nest them differently as the
    sonic dimension evolves (``midi_prompt`` at the top level in one revision,
    a ``midi_data`` group in the next). The two policy flags are the organism's
    own statement about playback and are honoured rather than second-guessed: a
    creature that says it must not sound without a user gesture must not be
    autoplayed by anything reading this.
    """

    preferred: Optional[str] = None
    lossless_fallback: Optional[str] = None
    midi_prompt: Optional[str] = None
    midi_autocomplete: Optional[str] = None
    requires_user_gesture: bool = False
    stop_control_required: bool = False


@dataclass(frozen=True)
class SonicProfile:
    schema: str
    rappid: str
    dimension: str
    #: Recorded inside the profile, when that revision embeds it.
    manifest_sha256: Optional[str]
    #: Recorded beside it as ``sonic-profile.sha256``, sha256sum style.
    sidecar_sha256: Optional[str]
    #: sha256 of the profile file exactly as it was read.
    file_sha256: str
    identity_seed_sha256: Optional[str]
    evolution_seed_sha256: Optional[str]
    traits: Dict[str, float]
    musical: MusicalParameters
    prompt: List[Note]
    assets: List[AssetRecord]
    device_playback: DevicePlayback
    recorded_stage: Optional[str]
    #: The raw document, kept for manifest re-hashing. Never mutated.
    raw: Dict[str, Any]


@dataclass(frozen=True)
class BodyFrame:
    """The exact eleven-key RAPP/1 frame."""

    spec: str
    kind: str
    stream_id: str
    seq: int
    utc: str
    payload: Dict[str, Any]
    payload_hash: str
    frame_hash: str
    prev: Optional[str]
    prev_wave: None
    sig: None

    def to_wire(self) -> Dict[str, Any]:
        return {
            "spec": self.spec,
            "kind": self.kind,
            "stream_id": self.stream_id,
            "seq": self.seq,
            "utc": self.utc,
            "payload": self.payload,
            "payload_hash": self.payload_hash,
            "frame_hash": self.frame_hash,
            "prev": self.prev,
            "prev_wave": self.prev_wave,
            "sig": self.sig,
        }


@dataclass
class LoadedOrganism:
    directory: str
    document: RappidDocument
    traits: TraitsDocument
    sonic: Optional[SonicProfile]
    frames: List[BodyFrame] = field(default_factory=list)


@dataclass(frozen=True)
class VerificationCheck:
    name: str
    status: str  # "pass" | "fail"
    detail: str

    def to_wire(self) -> Dict[str, Any]:
        return {"name": self.name, "status": self.status, "detail": self.detail}


@dataclass(frozen=True)
class AssetVerification:
    dimension: str
    path: str
    status: str  # "verified" | "missing" | "byte-mismatch" | "hash-mismatch"
    #: The RAPP/1 space the address lives in, and the address itself.
    address_space: str
    address_hash: str
    expected_bytes: int
    actual_bytes: Optional[int]
    expected_sha256: str
    actual_sha256: Optional[str]
    media_type: str

    def to_wire(self) -> Dict[str, Any]:
        return {
            "dimension": self.dimension,
            "path": self.path,
            "status": self.status,
            "addressSpace": self.address_space,
            "addressHash": self.address_hash,
            "expectedBytes": self.expected_bytes,
            "actualBytes": self.actual_bytes,
            "expectedSha256": self.expected_sha256,
            "actualSha256": self.actual_sha256,
            "mediaType": self.media_type,
        }


@dataclass(frozen=True)
class VerificationReport:
    rappid: str
    ok: bool
    checks: List[VerificationCheck]
    assets: List[AssetVerification]
    #: ``(dimension, sha256)`` pairs that verified, each counted exactly once.
    verified_addresses: List[str]

    def to_wire(self) -> Dict[str, Any]:
        return {
            "rappid": self.rappid,
            "ok": self.ok,
            "checks": [check.to_wire() for check in self.checks],
            "assets": [asset.to_wire() for asset in self.assets],
            "verifiedAddresses": list(self.verified_addresses),
        }


@dataclass(frozen=True)
class CreatureStats:
    frame_height: int
    display_height_mm: int
    #: None when any carried dimension has an unknown size. Never estimated.
    total_weight_bytes: Optional[int]
    verified_weight_bytes: int
    resident_weight_bytes: int
    linked_weight_bytes: Optional[int]
    weight_complete: bool
    unique_frames: int
    unique_assets: int

    def to_wire(self) -> Dict[str, Any]:
        return {
            "frameHeight": self.frame_height,
            "displayHeightMm": self.display_height_mm,
            "totalWeightBytes": self.total_weight_bytes,
            "verifiedWeightBytes": self.verified_weight_bytes,
            "residentWeightBytes": self.resident_weight_bytes,
            "linkedWeightBytes": self.linked_weight_bytes,
            "weightComplete": self.weight_complete,
            "uniqueFrames": self.unique_frames,
            "uniqueAssets": self.unique_assets,
        }


@dataclass(frozen=True)
class DimensionState:
    name: str
    status: str  # "active" | "linked" | "missing"
    media_types: List[str]
    #: True when this dimension points at content whose size is not known here.
    unmeasured: bool

    def to_wire(self) -> Dict[str, Any]:
        value: Dict[str, Any] = {"name": self.name, "status": self.status}
        if self.media_types:
            value["mediaTypes"] = list(self.media_types)
        return value


@dataclass(frozen=True)
class CandidateScoresMicro:
    """Scores as exact integers in millionths; floats are presentation only."""

    continuation: int
    sounds_good: int
    trait_fit: int
    pitch_range: int
    repeated_note_ratio: int
    pitch_class_diversity: int

    def to_wire(self) -> Dict[str, int]:
        return {
            "continuation": self.continuation,
            "soundsGood": self.sounds_good,
            "traitFit": self.trait_fit,
            "pitchRange": self.pitch_range,
            "repeatedNoteRatio": self.repeated_note_ratio,
            "pitchClassDiversity": self.pitch_class_diversity,
        }


@dataclass(frozen=True)
class ContinuationCandidate:
    index: int
    notes: List[Note]
    scores_micro: CandidateScoresMicro


@dataclass(frozen=True)
class ContinuationProposal:
    rappid: str
    provider: Dict[str, Any]
    musical: MusicalParameters
    prompt: List[Note]
    selected_candidate: int
    candidate_count: int
    continuation: List[Note]
    scores_micro: CandidateScoresMicro
    midi_sha256: str
    midi_bytes: int


@dataclass(frozen=True)
class GrowthProposal:
    id: str
    rappid: str
    dimension: str
    title: str
    summary: str
    predicted_stats: CreatureStats
    predicted_stage: str
    evidence: List[str]
    assets: List[AssetRecord]
    appendable: bool = True

    def to_wire(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "rappid": self.rappid,
            "dimension": self.dimension,
            "title": self.title,
            "summary": self.summary,
            "predictedStats": self.predicted_stats.to_wire(),
            "predictedStage": self.predicted_stage,
            "evidence": list(self.evidence),
            "assets": [asset.to_wire() for asset in self.assets],
            # Growth is a proposal until a verified frame appends it.
            "authoritative": False,
            "appendable": self.appendable,
        }


@dataclass(frozen=True)
class PlaybackTrack:
    role: str
    path: str
    media_type: str
    bytes: int
    sha256: str
    duration_seconds: Optional[float]
    verified: bool

    def to_wire(self) -> Dict[str, Any]:
        return {
            "role": self.role,
            "path": self.path,
            "mediaType": self.media_type,
            "bytes": self.bytes,
            "sha256": self.sha256,
            "durationSeconds": self.duration_seconds,
            "verified": self.verified,
        }


@dataclass(frozen=True)
class PlaybackManifest:
    rappid: str
    device_media_types: List[str]
    preferred: Optional[PlaybackTrack]
    lossless_fallback: Optional[PlaybackTrack]
    tracks: List[PlaybackTrack]
    #: The organism's own playback policy, carried rather than interpreted.
    requires_user_gesture: bool = False
    stop_control_required: bool = False

    def to_wire(self) -> Dict[str, Any]:
        return {
            "rappid": self.rappid,
            "deviceMediaTypes": list(self.device_media_types),
            "preferred": None if self.preferred is None else self.preferred.to_wire(),
            "losslessFallback": (
                None if self.lossless_fallback is None else self.lossless_fallback.to_wire()
            ),
            "tracks": [track.to_wire() for track in self.tracks],
            "requiresUserGesture": self.requires_user_gesture,
            "stopControlRequired": self.stop_control_required,
            # Playback hands back bytes. Nothing here shells out to a player.
            "playbackMode": "in-process-bytes",
        }
