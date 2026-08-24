"""A real organism on disk, built the way a habitat would build one.

Mirrors ``typescript/src/rappids/__tests__/fixture.ts``.

The live organism at ``~/.rapp/twins/<hex>/`` is the evidence this subsystem
was designed against, and the tests deliberately do not read it: it is a
working creature that is still being grown, its manifest has already changed
shape twice, and a suite that asserts against a moving organism fails for
reasons that have nothing to do with the code under test. So the *shape* is
copied here and the bytes are generated, which also means every test can
tamper freely.

Scratch data stays inside the repo under ``.test-scratch/`` (gitignored), the
convention the TypeScript integration suites already use.
"""

from __future__ import annotations

import json
import os
import shutil
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional

from openrappter import rappids as R

ROOT = Path(__file__).resolve().parents[2]
SCRATCH_ROOT = ROOT / ".test-scratch"

TEST_TRAITS: Dict[str, float] = {
    "autonomy": 0.88,
    "continuity": 0.97,
    "curiosity": 0.84,
    "dimensionality": 0.92,
    "evidence_bound": 0.98,
    # Written as an integer to keep the fixture file itself byte-identical to
    # the TypeScript fixture. Canonical hashing also normalises parsed `1.0`
    # to this same JSON number spelling.
    "local_first": 1,
    "playfulness": 0.72,
    "resilience": 0.94,
    "warmth": 0.76,
}


@dataclass
class ExtraDimension:
    name: str
    status: str
    refs: Dict[str, str] = field(default_factory=dict)
    playback: Optional[List[str]] = None
    #: Files written under the organism, keyed by path relative to it.
    files: Dict[str, str] = field(default_factory=dict)


@dataclass
class OrganismFixture:
    habitat: str
    directory: str
    rappid: str
    hex: str
    traits: Dict[str, float]
    prompt_midi_bytes: int
    autocomplete_midi_bytes: int


def make_habitat(label: str) -> str:
    """A scratch habitat inside the repo, never in the system temp directory."""
    habitat = SCRATCH_ROOT / f"rappids-{label}-{os.getpid()}-{uuid.uuid4().hex[:6]}"
    habitat.mkdir(parents=True, exist_ok=True)
    return str(habitat)


def remove_habitat(habitat: str) -> None:
    shutil.rmtree(habitat, ignore_errors=True)


def _write_json(path: Path, value: Any) -> None:
    path.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")


def build_organism(
    habitat: str,
    tail: str = "test-tail",
    owner: str = "openrappter",
    name: str = "parity-organism",
    display_name: str = "Parity",
    traits: Optional[Dict[str, float]] = None,
    parent_rappid: Optional[str] = None,
    extra_dimensions: Optional[List[ExtraDimension]] = None,
    traits_rappid: Optional[str] = None,
    with_sonic: bool = True,
) -> OrganismFixture:
    """Write one organism: identity, traits, a sonic dimension and its assets.

    The sonic manifest embeds ``manifest_sha256`` over its own canonical JSON,
    which is the spelling a tampering test can break by editing one number.
    """
    traits = dict(TEST_TRAITS if traits is None else traits)
    hexid = R.rappid_hex(tail)
    rappid = f"rappid:@{owner}/{name}:{hexid}"
    directory = Path(habitat) / hexid
    directory.mkdir(parents=True, exist_ok=True)

    traits_milli = {key: R.trait_milli(traits[key]) for key in sorted(traits)}
    dimensions: Dict[str, Any] = {
        "memory": {"status": "awake", "latest_cursor": "0002"},
        "device": {"status": "local", "playback": ["audio/midi"]},
    }

    prompt_midi_bytes = 0
    autocomplete_midi_bytes = 0

    if with_sonic:
        params = R.sonic_parameters(rappid, traits_milli)
        prompt = R.build_dna_prompt(rappid, traits_milli, params)
        continuation = R.propose_continuation(rappid, traits_milli, params, prompt, "0002")
        prompt_midi = R.write_midi(prompt, params)
        autocomplete_midi = R.write_midi([*prompt, *continuation.continuation], params)
        prompt_midi_bytes = len(prompt_midi)
        autocomplete_midi_bytes = len(autocomplete_midi)

        assets_dir = directory / "sonic" / "assets"
        assets_dir.mkdir(parents=True, exist_ok=True)
        (assets_dir / "dna-prompt.mid").write_bytes(prompt_midi)
        (assets_dir / "autocomplete.mid").write_bytes(autocomplete_midi)

        profile: Dict[str, Any] = {
            "schema": "quantum-rappid-sonic/1.0",
            "rappid": rappid,
            "dimension": "sonic",
            "identity": {
                "identity_seed_sha256": R.canonical_digest(
                    {"rappid": rappid, "traits": traits_milli}
                ),
                "evolution_seed_sha256": R.canonical_digest(
                    {"rappid": rappid, "traits": traits_milli, "engram": "0002"}
                ),
                "invariant": "Canonical RAPPID identity and 16-note MIDI DNA stay stable.",
            },
            "traits": traits,
            "musical_parameters": {
                "root_pitch": params.root_pitch,
                "root_pitch_class": params.root_pitch_class,
                "mode": params.mode,
                "scale": list(params.scale),
                "bpm": params.bpm,
                "program_zero_based": params.program,
                "program_gm_one_based": params.program + 1,
            },
            "note_representation": ["pitch", "delta_onset", "duration", "velocity"],
            "prompt": [note.to_json() for note in prompt],
            "assets": [
                {
                    "path": "assets/dna-prompt.mid",
                    "bytes": len(prompt_midi),
                    "sha256": R.sha256_hex(prompt_midi),
                    "media_type": "audio/midi",
                },
                {
                    "path": "assets/autocomplete.mid",
                    "bytes": len(autocomplete_midi),
                    "sha256": R.sha256_hex(autocomplete_midi),
                    "media_type": "audio/midi",
                },
            ],
            "device_playback": {
                "midi_data": {
                    "prompt": "assets/dna-prompt.mid",
                    "autocomplete": "assets/autocomplete.mid",
                    "playback_requirement": "MIDI synth or native sequencer",
                },
                "requires_user_gesture": True,
                "stop_control_required": True,
            },
            "creature_stats": {"lifecycle_stage": "baby"},
        }
        profile["manifest_sha256"] = R.canonical_digest(profile)
        _write_json(directory / "sonic" / "sonic-profile.json", profile)

        dimensions["sonic"] = {
            "status": "active",
            "profile": "sonic/sonic-profile.json",
            "midi_dna": "sonic/assets/dna-prompt.mid",
            "autocomplete": "sonic/assets/autocomplete.mid",
        }

    for extra in extra_dimensions or []:
        record: Dict[str, Any] = {"status": extra.status}
        record.update(extra.refs)
        if extra.playback is not None:
            record["playback"] = list(extra.playback)
        dimensions[extra.name] = record
        for path, contents in extra.files.items():
            target = directory / path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(contents, encoding="utf-8")

    _write_json(
        directory / "rappid.json",
        {
            "schema": "rapp-rappid/2.0",
            "rappid": rappid,
            "kind": "quantum-rappid",
            "name": name,
            "display_name": display_name,
            "url": f"local://quantum-rappids/{hexid}/",
            "parent_rappid": parent_rappid,
            "born_at": "2026-08-20T19:50:33Z",
            "kernel_version": "0.6.16",
            "external_episode": {
                "source": "copilot-cli",
                "session_guid": "e479d694-8712-4e77-aa22-2ec4d4e57089",
                "memory_key": (
                    "rappid-capture/1/copilot-cli/sessions/"
                    "e479d694-8712-4e77-aa22-2ec4d4e57089"
                ),
            },
            "quantum": {
                "schema": "quantum-rappid/1.0",
                "invariant": "One canonical identity, many independently renderable dimensions.",
                "dimensions": dimensions,
            },
            "_local_only": True,
        },
    )

    _write_json(
        directory / "traits.json",
        {
            "schema": "quantum-rappid-traits/1.0",
            "rappid": traits_rappid or rappid,
            "birth_traits": traits,
            "traits": traits,
        },
    )

    return OrganismFixture(
        habitat=habitat,
        directory=str(directory),
        rappid=rappid,
        hex=hexid,
        traits=traits,
        prompt_midi_bytes=prompt_midi_bytes,
        autocomplete_midi_bytes=autocomplete_midi_bytes,
    )
