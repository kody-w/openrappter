"""The rendered file has to be a MIDI file, not merely the right length.

An adversarial review found the writer declaring a fourteen-byte track name as
fifteen bytes. Both runtimes agreed on those bytes, so every hash matched and
the parity vector passed while the file itself was malformed: a strict parser
reads the extra byte as part of the title and then finds the tempo event one
byte out of place. Byte-for-byte agreement between two runtimes proves they
agree; it does not prove either one is right.

So these tests parse what the writer produced rather than hashing it, with a
decoder written from the SMF specification instead of from the writer. A writer
that starts lying about a length has nowhere to hide in here.
"""

from __future__ import annotations

import json
import struct
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "python"))

from openrappter import rappids as R  # noqa: E402
from openrappter.rappids.types import Note  # noqa: E402

VECTOR = json.loads(
    (ROOT / "tests" / "quantum-rappid-parity.json").read_text(encoding="utf-8")
)
TRACK_NAME = b"Quantum RAPPID"


def _variable_length(payload, offset):
    """Decode one MIDI variable-length quantity, returning it and the offset."""
    value = 0
    for _ in range(4):
        byte = payload[offset]
        offset += 1
        value = (value << 7) | (byte & 0x7F)
        if not byte & 0x80:
            return value, offset
    raise AssertionError("variable-length quantity ran past four bytes")


def parse_smf(payload):
    """A standard MIDI file, decoded from the specification and nothing else."""
    assert payload[:4] == b"MThd", "file does not start with an MThd chunk"
    header_length, fmt, tracks, division = struct.unpack(">IHHH", payload[4:14])
    assert header_length == 6
    assert payload[14:18] == b"MTrk", "no MTrk chunk follows the header"
    (declared,) = struct.unpack(">I", payload[18:22])
    body = payload[22:]
    assert declared == len(body), (
        f"MTrk declares {declared} bytes but the file carries {len(body)}"
    )

    events = []
    offset = 0
    tick = 0
    end_of_track_at = None
    while offset < len(body):
        delta, offset = _variable_length(body, offset)
        tick += delta
        status = body[offset]
        offset += 1
        assert status & 0x80, f"running status is not emitted, got {status:#04x}"
        if status == 0xFF:
            meta_type = body[offset]
            offset += 1
            length, offset = _variable_length(body, offset)
            data = body[offset:offset + length]
            assert len(data) == length, "a meta event runs past the end of the track"
            offset += length
            events.append(
                {"tick": tick, "event": "meta", "type": meta_type, "data": data}
            )
            if meta_type == 0x2F:
                end_of_track_at = offset
        elif status & 0xF0 in (0x80, 0x90):
            pitch, velocity = body[offset], body[offset + 1]
            offset += 2
            events.append(
                {
                    "tick": tick,
                    "event": "note-on" if status & 0xF0 == 0x90 else "note-off",
                    "channel": status & 0x0F,
                    "pitch": pitch,
                    "velocity": velocity,
                }
            )
        elif status & 0xF0 == 0xC0:
            events.append(
                {
                    "tick": tick,
                    "event": "program",
                    "channel": status & 0x0F,
                    "program": body[offset],
                }
            )
            offset += 1
        else:
            raise AssertionError(f"unexpected status byte {status:#04x}")

    assert end_of_track_at == len(body), "the end-of-track meta is not the last event"
    return {"format": fmt, "tracks": tracks, "division": division, "events": events}


@pytest.fixture
def rendering():
    traits_milli = {
        key: R.trait_milli(value)
        for key, value in sorted(VECTOR["input"]["traits"].items())
    }
    params = R.sonic_parameters(VECTOR["input"]["rappid"], traits_milli)
    prompt = R.build_dna_prompt(VECTOR["input"]["rappid"], traits_milli, params)
    return params, prompt, R.write_midi(prompt, params)


def test_the_rendered_file_parses_as_a_single_track_smf(rendering):
    params, _prompt, payload = rendering
    parsed = parse_smf(payload)

    assert parsed["format"] == 0
    assert parsed["tracks"] == 1
    assert parsed["division"] == R.PPQ
    programs = [event for event in parsed["events"] if event["event"] == "program"]
    # Both voices are addressed: the melody and the octave echo beneath it.
    assert [(event["channel"], event["program"]) for event in programs] == [
        (0, params.program),
        (1, params.program),
    ]
    tempo = next(
        event
        for event in parsed["events"]
        if event["event"] == "meta" and event["type"] == 0x51
    )
    assert int.from_bytes(tempo["data"], "big") == R.round_half_up(
        60_000_000 / params.bpm
    )


def test_the_track_name_meta_declares_its_true_length(rendering):
    _params, _prompt, payload = rendering
    name = next(
        event
        for event in parse_smf(payload)["events"]
        if event["event"] == "meta" and event["type"] == 0x03
    )

    # The regression: a hard-coded 0x0f declared fifteen bytes for this
    # fourteen-byte name, and everything after it decoded one byte late.
    assert name["data"] == TRACK_NAME
    assert len(TRACK_NAME) == 14
    assert payload[payload.index(TRACK_NAME) - 1] == len(TRACK_NAME)


def test_every_note_is_closed_and_no_voice_retriggers_itself(rendering):
    _params, _prompt, payload = rendering
    open_notes = {}
    for event in parse_smf(payload)["events"]:
        if event["event"] == "note-on":
            key = (event["channel"], event["pitch"])
            assert key not in open_notes, (
                f"channel {event['channel']} retriggers pitch {event['pitch']} "
                "while it is still sounding"
            )
            assert 1 <= event["velocity"] <= 127
            open_notes[key] = event["tick"]
        elif event["event"] == "note-off":
            key = (event["channel"], event["pitch"])
            assert key in open_notes, "a note-off closes a note that never opened"
            assert event["tick"] > open_notes.pop(key), "a note ends before it starts"
    assert not open_notes, f"{len(open_notes)} notes are never released"


def test_a_repeated_pitch_is_clipped_rather_than_overlapped():
    params = R.sonic_parameters(VECTOR["input"]["rappid"], {"autonomy": 880})
    # Three deliberate collisions: the same pitch struck again while the
    # previous strike is still ringing.
    notes = [
        Note(pitch=params.root_pitch, delta_onset=0, duration=R.STEP * 8, velocity=90),
        Note(
            pitch=params.root_pitch,
            delta_onset=R.STEP,
            duration=R.STEP * 8,
            velocity=90,
        ),
        Note(
            pitch=params.root_pitch,
            delta_onset=R.STEP,
            duration=R.STEP * 8,
            velocity=90,
        ),
    ]
    parsed = parse_smf(R.write_midi(notes, params))

    open_notes = set()
    for event in parsed["events"]:
        if event["event"] == "note-on":
            key = (event["channel"], event["pitch"])
            assert key not in open_notes, "a clipped span still overlaps its successor"
            open_notes.add(key)
        elif event["event"] == "note-off":
            open_notes.discard((event["channel"], event["pitch"]))
    assert not open_notes
    assert len([e for e in parsed["events"] if e["event"] == "note-on"]) == 3


def test_the_parity_vector_pins_the_corrected_bytes(rendering):
    _params, _prompt, payload = rendering

    # The vector and the writer must agree, and the agreed bytes must be the
    # corrected ones: a vector regenerated from the old writer would still match
    # itself, which is exactly how the malformed length survived.
    assert len(payload) == VECTOR["expect"]["promptMidi"]["bytes"]
    assert R.sha256_hex(payload) == VECTOR["expect"]["promptMidi"]["sha256"]
    assert parse_smf(payload)["events"][0]["data"] == TRACK_NAME
