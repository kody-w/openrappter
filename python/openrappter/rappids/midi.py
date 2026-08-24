"""MIDI DNA: the stable identity motif, and the bytes it renders to.

Mirrors ``typescript/src/rappids/midi.ts``.

``NOTE(pitch, delta_onset, duration, velocity)`` is the whole note event, the
representation described at <https://simedw.com/2026/08/20/midi-autocomplete/>.
Everything here is a pure function of the RAPPID and the organism's stable
traits, so the same creature produces the same 16-note prompt on any device,
offline, forever -- and *only* the prompt. Identity is never derived from the
motif; the motif is derived from the identity.

The derivation and the file writer are checked against a live organism: the
prompt recorded in ``sonic/sonic-profile.json`` and the exact bytes of
``sonic/assets/dna-prompt.mid`` are both reproduced from the RAPPID and
``traits.json`` alone.
"""

from __future__ import annotations

import hashlib
import struct
from typing import Any, Dict, List, Mapping, Sequence

from .canonical import (
    DeterministicStream,
    canonical_json,
    idiv,
    round_half_up,
    sha256_hex,
)
from .types import MusicalParameters, Note, QuantumRappidError

#: Pulses per quarter note, and the sixteenth-note grid built on it.
PPQ = 480
STEP = PPQ // 4

MODES = (
    {"name": "ionian", "scale": (0, 2, 4, 5, 7, 9, 11)},
    {"name": "dorian", "scale": (0, 2, 3, 5, 7, 9, 10)},
    {"name": "lydian", "scale": (0, 2, 4, 6, 7, 9, 11)},
    {"name": "mixolydian", "scale": (0, 2, 4, 5, 7, 9, 10)},
    {"name": "major-pentatonic", "scale": (0, 2, 4, 7, 9)},
)
PROGRAMS = (4, 11, 80, 81, 89)
CORE_DEGREES = (0, 2, 4, 1, 3, 5, 4, 2)
ONSET_CHOICES = (STEP * 2, STEP * 2, STEP * 3, STEP * 4)
DURATION_CHOICES = (STEP * 2, STEP * 3, STEP * 4)


def clamp_int(value: int, low: int, high: int) -> int:
    return max(low, min(high, value))


def nearest_scale_pitch(value: int, root: int, scale: Sequence[int]) -> int:
    """The nearest pitch in the mode, ties broken downward so it is total."""
    candidates = [
        root + octave * 12 + degree for octave in range(-1, 4) for degree in scale
    ]
    return min(candidates, key=lambda pitch: (abs(pitch - value), pitch))


def _sorted_traits(traits_milli: Mapping[str, int]) -> Dict[str, int]:
    return {key: traits_milli[key] for key in sorted(traits_milli)}


def _identity_stream(
    rappid: str, birth_traits_milli: Mapping[str, int], purpose: str
) -> DeterministicStream:
    return DeterministicStream(
        sha256_hex(
            canonical_json(
                {
                    "rappid": rappid,
                    "birth_traits_milli": _sorted_traits(birth_traits_milli),
                    "purpose": purpose,
                }
            )
        )
    )


def sonic_parameters(
    rappid: str, birth_traits_milli: Mapping[str, int]
) -> MusicalParameters:
    """Key, tempo and voice, frozen from identity plus the birth trait snapshot."""
    stream = _identity_stream(rappid, birth_traits_milli, "parameters")
    # The draw order is the contract: root pitch class, mode, register, tempo,
    # voice. Reordering it in one runtime re-voices every organism in the other.
    root_pitch_class = stream.next_below(12)
    mode = MODES[stream.next_below(len(MODES))]
    root_pitch = (
        48 + root_pitch_class if stream.next_below(2) == 0 else 60 + root_pitch_class
    )
    bpm = 96 + stream.next_below(25)
    program = PROGRAMS[stream.next_below(len(PROGRAMS))]
    return MusicalParameters(
        root_pitch=root_pitch,
        root_pitch_class=root_pitch_class,
        mode=str(mode["name"]),
        scale=list(mode["scale"]),
        bpm=bpm,
        program=program,
    )


def build_dna_prompt(
    rappid: str, birth_traits_milli: Mapping[str, int], params: MusicalParameters
) -> List[Note]:
    """The 16-note identity motif: an 8-note call and birth-frozen response.

    Call and response are the whole point of the shape -- the response is the
    call reversed, then bent by the traits that have a musical meaning, so a
    curious creature answers itself with wider colour while a continuity-bound
    one answers itself almost literally.
    """
    identity = hashlib.sha256(
        canonical_json(
            {
                "rappid": rappid,
                "birth_traits_milli": _sorted_traits(birth_traits_milli),
                "purpose": "midi-dna",
            }
        ).encode("utf-8")
    ).digest()
    degrees = [
        clamp_int(degree + ((identity[index] % 3) - 1), 0, len(params.scale) - 1)
        for index, degree in enumerate(CORE_DEGREES)
    ]
    contour = [params.root_pitch + 12 + params.scale[degree] for degree in degrees]

    response = []
    for index, pitch in enumerate(reversed(contour)):
        octave_echo = 12 if index in (1, 5) and identity[index] & 0x1 else 0
        colour = 2 if index in (3, 7) and identity[index] & 0x2 else 0
        response.append(
            nearest_scale_pitch(pitch + octave_echo + colour, params.root_pitch, params.scale)
        )

    notes: List[Note] = []
    for index, pitch in enumerate(contour + response):
        delta_onset = 0 if index == 0 else ONSET_CHOICES[identity[16 + index] % 4]
        if index in (4, 12) and identity[8 + index] & 0x1:
            delta_onset = STEP
        velocity = 70 + (identity[len(identity) - 1 - index] % 24)
        if index in (0, 8, 15):
            velocity = min(108, velocity + 10)
        notes.append(
            Note(
                pitch=pitch,
                delta_onset=delta_onset,
                duration=DURATION_CHOICES[identity[index] % 3],
                velocity=velocity,
            )
        )
    return notes


def variable_length(value: int) -> bytes:
    """MIDI variable-length quantity."""
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        raise ValueError("variable-length quantities are non-negative integers")
    buffer = value & 0x7F
    out = bytearray()
    while value >> 7:
        value >>= 7
        buffer <<= 8
        buffer |= (value & 0x7F) | 0x80
    while True:
        out.append(buffer & 0xFF)
        if buffer & 0x80:
            buffer >>= 8
        else:
            break
    return bytes(out)


def write_midi(notes: Sequence[Note], params: MusicalParameters) -> bytes:
    """A single-track SMF, byte-for-byte reproducible.

    The octave echo under notes 8 and 16 is deliberate and inherited: it is
    what the organism's own sonic dimension was rendered with, so this writer
    reproduces ``dna-prompt.mid`` exactly rather than producing a second,
    subtly different rendering of the same motif.
    """
    if not notes:
        raise QuantumRappidError("empty-midi", "refusing to render a MIDI file with no notes")
    spans: List[Dict[str, int]] = []
    onset = 0
    for index, note in enumerate(notes):
        onset += note.delta_onset
        spans.append(
            {
                "onset": onset,
                "end": onset + note.duration,
                "pitch": note.pitch,
                "velocity": note.velocity,
                "channel": 0,
            }
        )
        if index in (7, 15) and index + 1 < len(notes):
            spans.append(
                {
                    "onset": onset,
                    "end": onset + note.duration,
                    "pitch": clamp_int(note.pitch - 12, 36, 96),
                    "velocity": max(34, note.velocity - 28),
                    "channel": 1,
                }
            )

    # One voice cannot hold the same pitch twice at once. Trimming the earlier
    # span keeps note-on/note-off strictly paired, which is what makes the file
    # play the same way in every sequencer rather than only in a forgiving one.
    for channel in (0, 1):
        for pitch in range(128):
            matching = sorted(
                (
                    span
                    for span in spans
                    if span["channel"] == channel and span["pitch"] == pitch
                ),
                key=lambda span: span["onset"],
            )
            for index in range(1, len(matching)):
                previous = matching[index - 1]
                current = matching[index]
                if previous["end"] >= current["onset"]:
                    previous["end"] = max(previous["onset"] + 1, current["onset"] - 1)

    events = []
    for span in spans:
        events.append(
            (
                span["onset"],
                1,
                bytes((0x90 | span["channel"], span["pitch"], span["velocity"])),
            )
        )
        events.append(
            (span["end"], 0, bytes((0x80 | span["channel"], span["pitch"], 0)))
        )
    events.sort(key=lambda item: (item[0], item[1]))

    tempo = round_half_up(60_000_000 / params.bpm)
    track = bytearray()
    track_name = b"Quantum RAPPID"
    # The meta length is the byte length of the name, derived and never
    # written by hand: a literal 0x0f claimed fifteen bytes for a fourteen-byte
    # name, so a strict parser swallowed the first byte of the tempo event as
    # part of the title and every event after it landed one byte out.
    track += b"\x00\xff\x03" + bytes((len(track_name),)) + track_name
    track += b"\x00\xff\x51\x03" + tempo.to_bytes(3, "big")
    track += b"\x00" + bytes((0xC0, params.program))
    track += b"\x00" + bytes((0xC1, params.program))
    current = 0
    for tick, _kind, payload in events:
        track += variable_length(tick - current) + payload
        current = tick
    track += b"\x00\xff\x2f\x00"

    header = b"MThd" + struct.pack(">IHHH", 6, 0, 1, PPQ)
    return header + b"MTrk" + struct.pack(">I", len(track)) + bytes(track)


def midi_duration_ticks(notes: Sequence[Note]) -> int:
    """Total ticks a note list occupies, for playback without rendering it."""
    onset = 0
    end = 0
    for note in notes:
        onset += note.delta_onset
        end = max(end, onset + note.duration)
    return end


def ticks_to_milliseconds(ticks: int, bpm: int) -> int:
    """Ticks to whole milliseconds, so playback timing stays integer."""
    return idiv(ticks * 60_000, bpm * PPQ)


def note_from_json(value: Dict[str, Any], where: str) -> Note:
    """The on-disk note form is snake_case; this is the only place that knows."""
    fields = {}
    for key in ("pitch", "delta_onset", "duration", "velocity"):
        raw = value.get(key)
        if not isinstance(raw, int) or isinstance(raw, bool):
            raise QuantumRappidError(
                "invalid-note",
                f"{where}: note field {key} must be an integer, got {raw!r}",
            )
        fields[key] = raw
    return Note(**fields)


def note_to_json(note: Note) -> Dict[str, int]:
    return note.to_json()
