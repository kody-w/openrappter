"""Where organisms live, and the only code that reads or writes them.

Mirrors ``typescript/src/rappids/store.ts``.

The habitat is ``~/.rapp/twins/<hex>/``, beside the twin vault and outside any
repository, for the reason the twin vault spells out: a creature that lands
inside a working tree is one ``git add -A`` away from being published.
``RAPP_RAPPIDS_HOME`` relocates it, read at call time so tests and ``reset``
cannot be left pointing at a directory that was current at import.

Two rules are enforced here rather than documented:

1. **Append-only.** A body frame is written to a new numbered file with
   ``O_EXCL``; a frame that already exists is never reopened, so history cannot
   be rewritten by this module even by mistake.
2. **Inside the organism.** Every asset path from a manifest is resolved and
   then checked to still be under the organism directory. A manifest is data,
   and data that names ``../../.ssh/id_rsa`` must not be followed.
"""

from __future__ import annotations

import json
import os
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence

from .canonical import (
    RAPP_EGG_DOMAIN,
    RAPP_PARTICLE_DOMAIN,
    RAPP_WAVE_DOMAIN,
    rapp_h,
    rapp_hb,
    sha256_hex,
    trait_milli,
)
from .identity import is_rappid, parse_rappid, validate_parent_pointer
from .midi import note_from_json
from .types import (
    AssetRecord,
    BodyFrame,
    DevicePlayback,
    DimensionRecord,
    ExternalEpisodeRef,
    LoadedOrganism,
    MusicalParameters,
    QuantumRappidError,
    RappidDocument,
    SonicProfile,
    TraitsDocument,
)

RAPPID_DOCUMENT = "rappid.json"
TRAITS_DOCUMENT = "traits.json"
SONIC_PROFILE = "sonic/sonic-profile.json"
SONIC_PROFILE_SIDECAR = "sonic/sonic-profile.sha256"
FRAMES_DIRECTORY = "frames"
OBJECTS_DIRECTORY = "objects/rapp-1-egg"
BODY_FRAME_SCHEMA = "rapp/1"

#: Frame timestamps are RFC 3339 UTC to the millisecond, and only that. One
#: fixed width keeps a frame's canonical bytes -- and therefore the weight it
#: contributes -- the same length whenever it was written, so a growth preview
#: can state exact bytes instead of an estimate that drifts by a timestamp.
FRAME_TIME_PATTERN = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$")

_HEX64 = re.compile(r"^[0-9a-f]{64}$")
_LABEL = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
_MEDIA_TYPE = re.compile(r"^[a-z0-9][a-z0-9!#$&^_.+-]*/[a-z0-9][a-z0-9!#$&^_.+-]*$")
_MEMORY_STREAM = re.compile(
    r"^rappid:@[a-z0-9]+(?:-[a-z0-9]+)*/[a-z0-9]+(?:-[a-z0-9]+)*"
    r":[0-9a-f]{64}:[a-z0-9]+(?:-[a-z0-9]+)*$"
)
_SWARM_STREAM = re.compile(r"^net:[a-z0-9]+(?:-[a-z0-9]+)*$")

#: The exact key sets RAPP/1 pins for a body frame and its dimension payload.
FRAME_KEYS = (
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
)
DIMENSION_PAYLOAD_KEYS = (
    "rappid",
    "dimension",
    "version",
    "stage",
    "traits",
    "traits_hash",
    "media",
    "sources",
)

MEDIA_TYPES = {
    ".mid": "application/x-midi",
    ".midi": "application/x-midi",
    ".wav": "audio/wav",
    ".m4a": "audio/mp4",
    ".json": "application/json",
    ".md": "text/markdown",
}


def rappids_home() -> str:
    """The habitat directory: ``$RAPP_RAPPIDS_HOME``, else ``~/.rapp/twins``."""
    override = os.environ.get("RAPP_RAPPIDS_HOME")
    if override and override.strip():
        return override
    return str(Path.home() / ".rapp" / "twins")


def format_frame_time(instant: datetime) -> str:
    """A datetime as the one frame-timestamp format: UTC, to the millisecond."""
    moment = instant if instant.tzinfo is not None else instant.replace(tzinfo=timezone.utc)
    moment = moment.astimezone(timezone.utc)
    return f"{moment:%Y-%m-%dT%H:%M:%S}.{moment.microsecond // 1000:03d}Z"


def media_type_for_path(path: str) -> str:
    extension = os.path.splitext(path)[1].lower()
    media_type = MEDIA_TYPES.get(extension)
    if media_type is None:
        raise QuantumRappidError(
            "unknown-media-type", f"no media type is registered for {path}"
        )
    return media_type


def resolve_within(base: str, relative: str) -> str:
    """Resolve ``relative`` under ``base``, refusing anything that escapes it."""
    root = Path(base).resolve()
    target = (root / relative).resolve()
    if target != root and root not in target.parents:
        raise QuantumRappidError(
            "path-escape", f"{relative!r} resolves outside the organism directory"
        )
    return str(target)


def _read_json(path: str) -> Dict[str, Any]:
    try:
        text = Path(path).read_text(encoding="utf-8")
    except OSError as error:
        raise QuantumRappidError("unreadable", f"cannot read {path}: {error}") from error
    try:
        value = json.loads(text)
    except json.JSONDecodeError as error:
        raise QuantumRappidError("invalid-json", f"{path} is not JSON: {error}") from error
    if not isinstance(value, dict):
        raise QuantumRappidError("invalid-json", f"{path} must contain a JSON object")
    return value


def _require_string(value: Any, where: str) -> str:
    if not isinstance(value, str) or not value:
        raise QuantumRappidError("invalid-field", f"{where} must be a non-empty string")
    return value


def _optional_string(value: Any, where: str) -> Optional[str]:
    if value is None:
        return None
    return _require_string(value, where)


def _require_object(value: Any, where: str) -> Dict[str, Any]:
    if not isinstance(value, dict):
        raise QuantumRappidError("invalid-field", f"{where} must be an object")
    return value


def _require_array(value: Any, where: str) -> List[Any]:
    if not isinstance(value, list):
        raise QuantumRappidError("invalid-field", f"{where} must be an array")
    return value


def _require_integer(value: Any, where: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool):
        raise QuantumRappidError("invalid-field", f"{where} must be an integer")
    return value


def _parse_external_episode(raw: Any, cursor: Optional[str]) -> Optional[ExternalEpisodeRef]:
    if raw is None:
        return None
    value = _require_object(raw, "external_episode")
    return ExternalEpisodeRef(
        source=_require_string(value.get("source"), "external_episode.source"),
        session_guid=_require_string(
            value.get("session_guid"), "external_episode.session_guid"
        ),
        memory_key=_require_string(value.get("memory_key"), "external_episode.memory_key"),
        cursor=cursor,
    )


def _parse_dimension(name: str, raw: Any) -> DimensionRecord:
    if _LABEL.fullmatch(name) is None:
        raise QuantumRappidError(
            "invalid-dimension",
            f"quantum dimension name is not an lclabel: {name!r}",
        )
    """A dimension record, with its refs and playback types pulled out.

    Dimension bodies are open by design -- the whole premise is that new
    dimensions arrive later -- so every string value is treated as a content
    ref and every string in ``playback`` as a media type, rather than
    hard-coding the three families that happen to exist today.
    """
    value = _require_object(raw, f"quantum.dimensions.{name}")
    refs: Dict[str, str] = {}
    media_types: List[str] = []
    for key in sorted(value):
        entry = value[key]
        if key == "status":
            continue
        if isinstance(entry, str):
            refs[key] = entry
        elif isinstance(entry, list) and key == "playback":
            media_types.extend(item for item in entry if isinstance(item, str))
    return DimensionRecord(
        name=name,
        status=_require_string(value.get("status"), f"quantum.dimensions.{name}.status"),
        refs=refs,
        media_types=media_types,
    )


def parse_rappid_document(raw: Dict[str, Any], source: str) -> RappidDocument:
    rappid = _require_string(raw.get("rappid"), f"{source}.rappid")
    if not is_rappid(rappid):
        raise QuantumRappidError(
            "invalid-rappid", f"{source}.rappid is not a RAPPID: {rappid}"
        )
    parent = _optional_string(raw.get("parent_rappid"), f"{source}.parent_rappid")
    validate_parent_pointer(rappid, parent)

    quantum = _require_object(raw.get("quantum"), f"{source}.quantum")
    dimensions_raw = _require_object(quantum.get("dimensions"), f"{source}.quantum.dimensions")
    dimensions = [_parse_dimension(name, dimensions_raw[name]) for name in sorted(dimensions_raw)]
    memory = next((entry for entry in dimensions if entry.name == "memory"), None)
    cursor = memory.refs.get("latest_cursor") if memory is not None else None

    name = _require_string(raw.get("name"), f"{source}.name")
    return RappidDocument(
        schema=_require_string(raw.get("schema"), f"{source}.schema"),
        rappid=rappid,
        kind=_require_string(raw.get("kind"), f"{source}.kind"),
        name=name,
        display_name=_optional_string(raw.get("display_name"), f"{source}.display_name") or name,
        url=_optional_string(raw.get("url"), f"{source}.url"),
        parent_rappid=parent,
        born_at=_require_string(raw.get("born_at"), f"{source}.born_at"),
        kernel_version=_optional_string(raw.get("kernel_version"), f"{source}.kernel_version"),
        external_episode=_parse_external_episode(raw.get("external_episode"), cursor),
        quantum_schema=_require_string(quantum.get("schema"), f"{source}.quantum.schema"),
        dimensions=dimensions,
        local_only=raw.get("_local_only") is True,
    )


def parse_traits_document(raw: Dict[str, Any], source: str) -> TraitsDocument:
    traits_raw = _require_object(raw.get("traits"), f"{source}.traits")
    # An absent `birth_traits` is a document written before the snapshot
    # existed, and its live traits are the best record of birth it has. A
    # present-but-malformed one is an error, not a reason to fall back.
    birth_raw = (
        traits_raw
        if "birth_traits" not in raw
        else _require_object(raw["birth_traits"], f"{source}.birth_traits")
    )
    traits: Dict[str, float] = {}
    traits_milli: Dict[str, int] = {}
    for key in sorted(traits_raw):
        value = traits_raw[key]
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not 0 <= value <= 1:
            raise QuantumRappidError(
                "invalid-trait",
                f"{source}.traits.{key} must be a number between 0 and 1, got {value!r}",
            )
        # The parsed number is carried as it was written. Coercing 1 to 1.0
        # here would put a different number on the wire than the other runtime
        # reads out of the same file.
        traits[key] = value
        traits_milli[key] = trait_milli(value)
    if not traits:
        raise QuantumRappidError("invalid-trait", f"{source}.traits is empty")
    birth_traits: Dict[str, float] = {}
    birth_traits_milli: Dict[str, int] = {}
    for key in sorted(birth_raw):
        value = birth_raw[key]
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not 0 <= value <= 1:
            raise QuantumRappidError(
                "invalid-trait",
                f"{source}.birth_traits.{key} must be a number between 0 and 1",
            )
        birth_traits[key] = value
        birth_traits_milli[key] = trait_milli(value)
    return TraitsDocument(
        schema=_require_string(raw.get("schema"), f"{source}.schema"),
        rappid=_require_string(raw.get("rappid"), f"{source}.rappid"),
        birth_traits=birth_traits,
        birth_traits_milli=birth_traits_milli,
        traits=traits,
        traits_milli=traits_milli,
    )


def _parse_asset(raw: Any, where: str) -> AssetRecord:
    value = _require_object(raw, where)
    duration = value.get("duration_seconds")
    if duration is not None and (isinstance(duration, bool) or not isinstance(duration, (int, float))):
        raise QuantumRappidError(
            "invalid-field", f"{where}.duration_seconds must be a number or null"
        )
    sha256 = _require_string(value.get("sha256"), f"{where}.sha256")
    if not _HEX64.fullmatch(sha256):
        raise QuantumRappidError("invalid-field", f"{where}.sha256 is not a sha-256 digest")
    return AssetRecord(
        path=_require_string(value.get("path"), f"{where}.path"),
        bytes=_require_integer(value.get("bytes"), f"{where}.bytes"),
        sha256=sha256,
        media_type=_require_string(value.get("media_type"), f"{where}.media_type"),
        duration_seconds=None if duration is None else float(duration),
    )


def _parse_program(value: Dict[str, Any], where: str) -> int:
    """The General MIDI program, whichever way this manifest spells it.

    A profile written today records ``program_zero_based`` alongside the
    one-based GM number a musician would quote; an earlier one recorded a bare
    ``program``. Reading all three keeps a rendered voice stable across a
    dimension that renamed its own field, and the zero-based value is the one
    that goes on the wire because that is what a MIDI program-change byte is.
    """
    if "program" in value:
        return _require_integer(value.get("program"), f"{where}.program")
    if "program_zero_based" in value:
        return _require_integer(value.get("program_zero_based"), f"{where}.program_zero_based")
    if "program_gm_one_based" in value:
        return (
            _require_integer(
                value.get("program_gm_one_based"), f"{where}.program_gm_one_based"
            )
            - 1
        )
    raise QuantumRappidError(
        "invalid-field",
        f"{where} records no MIDI program "
        "(program, program_zero_based or program_gm_one_based)",
    )


def _parse_musical_parameters(raw: Any, where: str) -> MusicalParameters:
    value = _require_object(raw, where)
    scale = [
        _require_integer(entry, f"{where}.scale[{index}]")
        for index, entry in enumerate(_require_array(value.get("scale"), f"{where}.scale"))
    ]
    root_pitch = _require_integer(value.get("root_pitch"), f"{where}.root_pitch")
    return MusicalParameters(
        root_pitch=root_pitch,
        root_pitch_class=(
            root_pitch % 12
            if "root_pitch_class" not in value
            else _require_integer(value.get("root_pitch_class"), f"{where}.root_pitch_class")
        ),
        mode=_require_string(value.get("mode"), f"{where}.mode"),
        scale=scale,
        bpm=_require_integer(value.get("bpm"), f"{where}.bpm"),
        program=_parse_program(value, where),
    )


def _parse_device_playback(raw: Any, source: str) -> DevicePlayback:
    """Playback roles, normalised across manifest revisions.

    The sonic dimension has already moved its MIDI refs from two top-level keys
    into a ``midi_data`` group. Both spellings are read here so a manifest
    written by an older organism keeps playing, and unknown keys are ignored
    rather than rejected -- a dimension is allowed to grow new fields.
    """
    if raw is None:
        return DevicePlayback()
    value = _require_object(raw, source)
    midi_group = value.get("midi_data")
    midi_group = {} if midi_group is None else _require_object(midi_group, f"{source}.midi_data")

    def ref(entry: Any, where: str) -> Optional[str]:
        return None if entry is None else _require_string(entry, where)

    return DevicePlayback(
        preferred=ref(value.get("preferred"), f"{source}.preferred"),
        lossless_fallback=ref(value.get("lossless_fallback"), f"{source}.lossless_fallback"),
        midi_prompt=(
            ref(value.get("midi_prompt"), f"{source}.midi_prompt")
            or ref(midi_group.get("prompt"), f"{source}.midi_data.prompt")
        ),
        midi_autocomplete=(
            ref(value.get("midi_autocomplete"), f"{source}.midi_autocomplete")
            or ref(midi_group.get("autocomplete"), f"{source}.midi_data.autocomplete")
        ),
        requires_user_gesture=value.get("requires_user_gesture") is True,
        stop_control_required=value.get("stop_control_required") is True,
    )


def parse_sonic_profile(
    raw: Dict[str, Any],
    source: str,
    file_sha256: str,
    sidecar_sha256: Optional[str],
) -> SonicProfile:
    identity = _require_object(raw.get("identity"), f"{source}.identity")
    traits_raw = _require_object(raw.get("traits"), f"{source}.traits")
    traits: Dict[str, float] = {}
    for key in sorted(traits_raw):
        value = traits_raw[key]
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise QuantumRappidError("invalid-trait", f"{source}.traits.{key} must be a number")
        traits[key] = value

    stats = (
        None
        if "creature_stats" not in raw
        else _require_object(raw["creature_stats"], f"{source}.creature_stats")
    )
    device_playback = _parse_device_playback(
        raw.get("device_playback"), f"{source}.device_playback"
    )

    return SonicProfile(
        schema=_require_string(raw.get("schema"), f"{source}.schema"),
        rappid=_require_string(raw.get("rappid"), f"{source}.rappid"),
        dimension=_require_string(raw.get("dimension"), f"{source}.dimension"),
        manifest_sha256=_optional_string(
            raw.get("manifest_sha256"), f"{source}.manifest_sha256"
        ),
        sidecar_sha256=sidecar_sha256,
        file_sha256=file_sha256,
        identity_seed_sha256=_optional_string(
            identity.get("identity_seed_sha256"), f"{source}.identity.identity_seed_sha256"
        ),
        evolution_seed_sha256=_optional_string(
            identity.get("evolution_seed_sha256"), f"{source}.identity.evolution_seed_sha256"
        ),
        traits=traits,
        musical=_parse_musical_parameters(
            raw.get("musical_parameters"), f"{source}.musical_parameters"
        ),
        prompt=[
            note_from_json(
                _require_object(entry, f"{source}.prompt[{index}]"), f"{source}.prompt[{index}]"
            )
            for index, entry in enumerate(_require_array(raw.get("prompt"), f"{source}.prompt"))
        ],
        assets=[
            _parse_asset(entry, f"{source}.assets[{index}]")
            for index, entry in enumerate(_require_array(raw.get("assets"), f"{source}.assets"))
        ],
        device_playback=device_playback,
        recorded_stage=(
            None
            if stats is None
            else _optional_string(
                stats.get("lifecycle_stage"), f"{source}.creature_stats.lifecycle_stage"
            )
        ),
        raw=raw,
    )


def asset_to_json(asset: AssetRecord) -> Dict[str, Any]:
    return asset.to_json()


def media_ref(payload: bytes, media_type: str) -> Dict[str, Any]:
    """A RAPP/1 egg reference: the space, the address, the type and the size."""
    if not _MEDIA_TYPE.fullmatch(media_type):
        raise QuantumRappidError("media-type", f"invalid RAPP/1 media type: {media_type}")
    return {
        "space": RAPP_EGG_DOMAIN,
        "hash": rapp_hb(RAPP_EGG_DOMAIN, payload),
        "media_type": media_type,
        "bytes": len(payload),
    }


def body_frame_to_json(frame: BodyFrame) -> Dict[str, Any]:
    return frame.to_wire()


def body_frame_body(frame: BodyFrame) -> Dict[str, Any]:
    """The nine-key RAPP/1 wave preimage (``frame_hash`` and ``sig`` removed)."""
    value = body_frame_to_json(frame)
    del value["frame_hash"]
    del value["sig"]
    return value


def body_frame_digest(frame: BodyFrame) -> str:
    return rapp_h(RAPP_WAVE_DOMAIN, body_frame_body(frame))


def build_dimension_frame(
    rappid: str,
    seq: int,
    utc: str,
    prev: Optional[str],
    dimension: str,
    version: int,
    stage: Dict[str, Any],
    traits: Dict[str, Any],
    media: Dict[str, Any],
    sources: Optional[Sequence[Any]] = None,
) -> BodyFrame:
    """One ``body.dimension`` frame, hashed the way RAPP/1 says to hash it."""
    payload: Dict[str, Any] = {
        "rappid": rappid,
        "dimension": dimension,
        "version": version,
        "stage": {"name": stage["name"], "ordinal": stage["ordinal"]},
        "traits": traits,
        "traits_hash": rapp_h(RAPP_PARTICLE_DOMAIN, traits),
        "media": media,
        "sources": list(sources) if sources is not None else [],
    }
    draft = BodyFrame(
        spec=BODY_FRAME_SCHEMA,
        kind="body.dimension",
        stream_id=rappid,
        seq=seq,
        utc=utc,
        payload=payload,
        payload_hash=rapp_h(RAPP_PARTICLE_DOMAIN, payload),
        frame_hash="0" * 64,
        prev=prev,
        prev_wave=None,
        sig=None,
    )
    return BodyFrame(
        spec=draft.spec,
        kind=draft.kind,
        stream_id=draft.stream_id,
        seq=draft.seq,
        utc=draft.utc,
        payload=draft.payload,
        payload_hash=draft.payload_hash,
        frame_hash=body_frame_digest(draft),
        prev=draft.prev,
        prev_wave=None,
        sig=None,
    )


def parse_body_frame(raw: Dict[str, Any], source: str) -> BodyFrame:
    if sorted(raw) != sorted(FRAME_KEYS):
        raise QuantumRappidError(
            "frame-shape", f"{source} is not the exact eleven-key RAPP/1 envelope"
        )
    utc = _require_string(raw.get("utc"), f"{source}.utc")
    if not FRAME_TIME_PATTERN.fullmatch(utc):
        raise QuantumRappidError(
            "invalid-field", f"{source}.utc must be YYYY-MM-DDTHH:MM:SS.mmmZ"
        )
    payload = _require_object(raw.get("payload"), f"{source}.payload")
    kind = _require_string(raw.get("kind"), f"{source}.kind")
    if kind != "body.dimension":
        raise QuantumRappidError("frame-kind", f"{source}.kind is not body.dimension")
    if raw.get("prev_wave") is not None:
        raise QuantumRappidError(
            "frame-wire", f"{source}.prev_wave must be null on a body stream"
        )
    if raw.get("sig") is not None:
        raise QuantumRappidError(
            "frame-signature", f"{source}.sig must be null for this local body profile"
        )
    return BodyFrame(
        spec=_require_string(raw.get("spec"), f"{source}.spec"),
        kind="body.dimension",
        stream_id=_require_string(raw.get("stream_id"), f"{source}.stream_id"),
        seq=_require_integer(raw.get("seq"), f"{source}.seq"),
        utc=utc,
        payload=payload,
        payload_hash=_require_string(raw.get("payload_hash"), f"{source}.payload_hash"),
        frame_hash=_require_string(raw.get("frame_hash"), f"{source}.frame_hash"),
        prev=_optional_string(raw.get("prev"), f"{source}.prev"),
        prev_wave=None,
        sig=None,
    )


def _is_uint(value: Any) -> bool:
    return (
        isinstance(value, int)
        and not isinstance(value, bool)
        and 0 <= value <= 2**53 - 1
    )


def _is_fixed_width_utc(value: str) -> bool:
    if not FRAME_TIME_PATTERN.fullmatch(value):
        return False
    try:
        moment = datetime.strptime(value, "%Y-%m-%dT%H:%M:%S.%fZ").replace(
            tzinfo=timezone.utc
        )
    except ValueError:
        return False
    return format_frame_time(moment) == value


def body_frame_problems(
    frame: BodyFrame, head: Optional[BodyFrame], stream_id: str
) -> List[str]:
    """Everything RAPP/1 requires of one frame, checked against its predecessor."""
    problems: List[str] = []
    if frame.spec != "rapp/1":
        problems.append("spec is not rapp/1")
    if frame.kind != "body.dimension":
        problems.append("kind is not body.dimension")
    if frame.stream_id != stream_id:
        problems.append("stream_id does not match the organism")
    if frame.payload.get("rappid") != stream_id:
        problems.append("payload.rappid does not match stream_id")
    if not _is_uint(frame.seq):
        problems.append("seq is not a uint53")
    if not _is_fixed_width_utc(frame.utc):
        problems.append("utc is not a valid fixed-width RFC 3339 timestamp")
    if not _HEX64.fullmatch(frame.payload_hash):
        problems.append("payload_hash is not 64hex")
    if not _HEX64.fullmatch(frame.frame_hash):
        problems.append("frame_hash is not 64hex")
    if frame.prev is not None and not _HEX64.fullmatch(frame.prev):
        problems.append("prev is not null or 64hex")
    if sorted(frame.payload) != sorted(DIMENSION_PAYLOAD_KEYS):
        problems.append("body.dimension payload does not have its exact key set")
    dimension = frame.payload.get("dimension")
    if not isinstance(dimension, str) or not _LABEL.fullmatch(dimension):
        problems.append("dimension is not an lclabel")
    version = frame.payload.get("version")
    if not _is_uint(version) or version < 1:
        problems.append("dimension version is not a uint53 >= 1")
    stage = frame.payload.get("stage")
    if (
        not isinstance(stage, dict)
        or sorted(stage) != ["name", "ordinal"]
        or not isinstance(stage.get("name"), str)
        or not _LABEL.fullmatch(str(stage.get("name")))
        or not _is_uint(stage.get("ordinal"))
    ):
        problems.append("stage is not exactly {name:lclabel, ordinal:uint53}")
    if not isinstance(frame.payload.get("traits"), dict):
        problems.append("traits is not an object")
    media = frame.payload.get("media")
    if not isinstance(media, dict):
        problems.append("media is not an object")
    else:
        for role, value in media.items():
            if not _LABEL.fullmatch(role):
                problems.append(f"media role {role} is not an lclabel")
                continue
            if not isinstance(value, dict):
                problems.append(f"media.{role} is not an object")
                continue
            if sorted(value) != ["bytes", "hash", "media_type", "space"]:
                problems.append(f"media.{role} does not have its exact key set")
            if value.get("space") != RAPP_EGG_DOMAIN:
                problems.append(f"media.{role}.space is not {RAPP_EGG_DOMAIN}")
            reference = value.get("hash")
            if not isinstance(reference, str) or not _HEX64.fullmatch(reference):
                problems.append(f"media.{role}.hash is not 64hex")
            media_type = value.get("media_type")
            if not isinstance(media_type, str) or not _MEDIA_TYPE.fullmatch(media_type):
                problems.append(f"media.{role}.media_type is invalid")
            if not _is_uint(value.get("bytes")):
                problems.append(f"media.{role}.bytes is not a uint53")
    sources = frame.payload.get("sources")
    if not isinstance(sources, list):
        problems.append("sources is not an array")
    else:
        source_order: List[str] = []
        for index, value in enumerate(sources):
            if not isinstance(value, dict):
                problems.append(f"sources[{index}] is not an object")
                continue
            if sorted(value) != ["particle", "stream_id"]:
                problems.append(f"sources[{index}] does not have its exact key set")
            source_stream = value.get("stream_id")
            valid_stream = isinstance(source_stream, str) and (
                is_rappid(source_stream)
                or _MEMORY_STREAM.fullmatch(source_stream) is not None
                or _SWARM_STREAM.fullmatch(source_stream) is not None
            )
            if not valid_stream:
                problems.append(f"sources[{index}].stream_id is invalid")
            particle = value.get("particle")
            if not isinstance(particle, str) or not _HEX64.fullmatch(particle):
                problems.append(f"sources[{index}].particle is not 64hex")
            if isinstance(source_stream, str) and isinstance(particle, str):
                source_order.append(f"{source_stream}\0{particle}")
        if source_order != sorted(set(source_order)):
            problems.append("sources is not sorted and de-duplicated")
    expected_seq = 0 if head is None else head.seq + 1
    expected_prev = None if head is None else head.payload_hash
    if frame.seq != expected_seq:
        problems.append(f"seq {frame.seq} does not continue {expected_seq}")
    if frame.prev != expected_prev:
        problems.append("prev does not link the predecessor particle")
    if frame.prev_wave is not None:
        problems.append("prev_wave is not null on a body stream")
    if frame.payload_hash != rapp_h(RAPP_PARTICLE_DOMAIN, frame.payload):
        problems.append("payload_hash does not cover the payload")
    if frame.frame_hash != body_frame_digest(frame):
        problems.append("frame_hash does not cover the wave preimage")
    if frame.payload.get("traits_hash") != rapp_h(
        RAPP_PARTICLE_DOMAIN, frame.payload.get("traits")
    ):
        problems.append("traits_hash does not cover traits")
    return problems


def _frame_file_name(seq: int) -> str:
    return f"{seq:06d}.json"


def load_frames(directory: str) -> List[BodyFrame]:
    frames_dir = Path(directory) / FRAMES_DIRECTORY
    if not frames_dir.is_dir():
        return []
    files = sorted(entry.name for entry in frames_dir.iterdir() if entry.name.endswith(".json"))
    return [
        parse_body_frame(_read_json(str(frames_dir / file)), f"{FRAMES_DIRECTORY}/{file}")
        for file in files
    ]


def load_organism(directory: str) -> LoadedOrganism:
    root = str(Path(directory).resolve())
    document = parse_rappid_document(
        _read_json(str(Path(root) / RAPPID_DOCUMENT)), RAPPID_DOCUMENT
    )
    traits = parse_traits_document(
        _read_json(str(Path(root) / TRAITS_DOCUMENT)), TRAITS_DOCUMENT
    )
    return LoadedOrganism(
        directory=root,
        document=document,
        traits=traits,
        sonic=load_sonic_profile(root),
        frames=load_frames(root),
    )


def read_sidecar_digest(path: str) -> Optional[str]:
    """``<sha256>  <filename>`` -- the format ``shasum -a 256`` writes."""
    target = Path(path)
    if not target.is_file():
        return None
    first = target.read_text(encoding="utf-8").split("\n")[0].strip()
    digest = first.split()[0] if first else ""
    if not _HEX64.fullmatch(digest):
        raise QuantumRappidError(
            "invalid-sidecar", f"{target.name} does not start with a sha-256 digest"
        )
    return digest


def load_sonic_profile(root: str) -> Optional[SonicProfile]:
    """The sonic profile, with the evidence that proves it has not been edited.

    Two revisions of the manifest are in the wild: one embeds
    ``manifest_sha256`` over its own canonical JSON, the next writes a
    ``sha256sum``-style sidecar over the file bytes. Both are read, because
    refusing to load an organism whose dimension grew a new integrity spelling
    would be the loader deciding it knows better than the creature.
    """
    profile_path = Path(root) / SONIC_PROFILE
    if not profile_path.is_file():
        return None
    payload = profile_path.read_bytes()
    try:
        parsed = json.loads(payload.decode("utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError) as error:
        raise QuantumRappidError(
            "invalid-json", f"{SONIC_PROFILE} is not JSON: {error}"
        ) from error
    if not isinstance(parsed, dict):
        raise QuantumRappidError("invalid-json", f"{SONIC_PROFILE} must contain a JSON object")
    return parse_sonic_profile(
        parsed,
        SONIC_PROFILE,
        sha256_hex(payload),
        read_sidecar_digest(str(Path(root) / SONIC_PROFILE_SIDECAR)),
    )


def list_organism_directories(root: Optional[str] = None) -> List[str]:
    """Every organism directory in a habitat, in a stable order."""
    base = Path(root if root is not None else rappids_home())
    if not base.is_dir():
        return []
    directories: List[str] = []
    for entry in base.iterdir():
        if not entry.is_dir() or entry.name.startswith("."):
            continue
        manifest = entry / RAPPID_DOCUMENT
        if not manifest.is_file():
            continue
        try:
            raw = _read_json(str(manifest))
        except QuantumRappidError:
            # A directory that cannot be read as a manifest is not an organism
            # in this habitat; the loader says nothing about it either way.
            continue
        quantum = raw.get("quantum")
        if (
            raw.get("kind") == "quantum-rappid"
            and isinstance(quantum, dict)
            and quantum.get("schema") == "quantum-rappid/1.0"
        ):
            directories.append(str(entry))
    return sorted(directories)


def load_organisms(root: Optional[str] = None) -> List[LoadedOrganism]:
    return [load_organism(directory) for directory in list_organism_directories(root)]


def load_organism_by_rappid(rappid: str, root: Optional[str] = None) -> LoadedOrganism:
    parse_rappid(rappid)
    base = root if root is not None else rappids_home()
    for directory in list_organism_directories(base):
        organism = load_organism(directory)
        if organism.document.rappid == rappid:
            return organism
    raise QuantumRappidError("not-found", f"no organism in {base} carries {rappid}")


def dimension_root(organism: LoadedOrganism, dimension: str) -> str:
    """The directory a dimension's manifest paths are relative to."""
    return resolve_within(organism.directory, dimension)


def asset_bytes(organism: LoadedOrganism, dimension: str, path: str) -> bytes:
    return Path(resolve_within(dimension_root(organism, dimension), path)).read_bytes()


def asset_exists(organism: LoadedOrganism, dimension: str, path: str) -> bool:
    return Path(resolve_within(dimension_root(organism, dimension), path)).is_file()


def object_path(organism: LoadedOrganism, hash_hex: str) -> str:
    if not _HEX64.fullmatch(hash_hex):
        raise QuantumRappidError("object-hash", f"invalid RAPP/1 object hash: {hash_hex}")
    return resolve_within(organism.directory, f"{OBJECTS_DIRECTORY}/{hash_hex}")


def read_rapp_object(organism: LoadedOrganism, hash_hex: str) -> Optional[bytes]:
    """The bytes behind a RAPP/1 egg address, or None when they are not here."""
    target = Path(object_path(organism, hash_hex))
    return target.read_bytes() if target.is_file() else None


def store_rapp_object(organism: LoadedOrganism, payload: bytes) -> str:
    """Put bytes in the organism's local egg store, addressed by their hash.

    Content addressing makes this idempotent. A name that already holds
    *different* bytes is a collision that must never be papered over, so it
    raises rather than overwrites.
    """
    hash_hex = rapp_hb(RAPP_EGG_DOMAIN, payload)
    target = Path(object_path(organism, hash_hex))
    if target.exists():
        if rapp_hb(RAPP_EGG_DOMAIN, target.read_bytes()) != hash_hex:
            raise QuantumRappidError(
                "object-collision", f"RAPP/1 object {hash_hex} exists with different bytes"
            )
        return hash_hex
    target.parent.mkdir(parents=True, exist_ok=True)
    handle = os.open(str(target), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        os.write(handle, payload)
    finally:
        os.close(handle)
    return hash_hex


def write_dimension_asset(
    organism: LoadedOrganism, dimension: str, path: str, payload: bytes
) -> AssetRecord:
    """Write a content-addressed asset into a dimension.

    Content addressing makes this idempotent: the same bytes always land on the
    same name, so re-running growth cannot fork an organism into two copies of
    one asset. A name that already holds *different* bytes is a collision that
    must never be papered over, so it raises rather than overwrites.
    """
    target = Path(resolve_within(dimension_root(organism, dimension), path))
    digest = sha256_hex(payload)
    store_rapp_object(organism, payload)
    if target.exists():
        if sha256_hex(target.read_bytes()) != digest:
            raise QuantumRappidError(
                "asset-collision", f"{dimension}/{path} already exists with different bytes"
            )
    else:
        target.parent.mkdir(parents=True, exist_ok=True)
        handle = os.open(str(target), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            os.write(handle, payload)
        finally:
            os.close(handle)
    return AssetRecord(
        path=path,
        bytes=len(payload),
        sha256=digest,
        media_type=media_type_for_path(path),
        duration_seconds=None,
    )


def append_body_frame(organism: LoadedOrganism, frame: BodyFrame) -> str:
    """Append one body frame. The only writer of organism history.

    ``O_EXCL`` is the whole guarantee: the file is created or the call fails. A
    frame whose sequence already exists means two writers raced or history is
    being rewritten, and both deserve an error rather than a silent overwrite.
    """
    if not FRAME_TIME_PATTERN.fullmatch(frame.utc):
        raise QuantumRappidError(
            "frame-time", f"frame utc {frame.utc} is not YYYY-MM-DDTHH:MM:SS.mmmZ"
        )
    head = organism.frames[-1] if organism.frames else None
    problems = body_frame_problems(frame, head, organism.document.rappid)
    if problems:
        raise QuantumRappidError(
            "frame-invalid", f"RAPP/1 frame refused: {'; '.join(problems)}"
        )

    frames_dir = Path(organism.directory) / FRAMES_DIRECTORY
    frames_dir.mkdir(parents=True, exist_ok=True)
    target = frames_dir / _frame_file_name(frame.seq)
    temporary = frames_dir / f"{target.name}.partial"
    payload = json.dumps(body_frame_to_json(frame), indent=2) + "\n"
    # Create-exclusive on the temp file too: a leftover `.partial` from a killed
    # process is evidence, not scratch space to reuse.
    handle = os.open(str(temporary), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        os.write(handle, payload.encode("utf-8"))
    finally:
        os.close(handle)
    if target.exists():
        raise QuantumRappidError(
            "frame-exists", f"{target.name} already exists; history is append-only"
        )
    os.replace(str(temporary), str(target))
    organism.frames.append(frame)
    return str(target)
