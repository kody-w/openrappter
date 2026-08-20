"""The provider is deterministic, or it is not a provider.

Mirrors ``typescript/src/rappids/__tests__/autocomplete.test.ts``.

"Deterministic" has to mean *across runtimes*, not merely "stable if you run it
twice on this laptop". Both suites read ``tests/quantum-rappid-parity.json`` and
are held to the same integers, so a change that quietly re-voices every
organism in one runtime cannot pass here.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "python"))

from openrappter import rappids as R  # noqa: E402
from openrappter.rappids.types import QuantumRappidError  # noqa: E402

VECTOR = json.loads((ROOT / "tests" / "quantum-rappid-parity.json").read_text(encoding="utf-8"))
INPUT = VECTOR["input"]
EXPECT = VECTOR["expect"]

TRAITS_MILLI = {key: R.trait_milli(value) for key, value in sorted(INPUT["traits"].items())}
PARAMS = R.sonic_parameters(INPUT["rappid"], TRAITS_MILLI)
PROMPT = R.build_dna_prompt(INPUT["rappid"], TRAITS_MILLI, PARAMS)


def notes_json(notes):
    return [note.to_json() for note in notes]


def test_canonical_json_matches_the_other_runtime():
    assert R.canonical_json(EXPECT["canonical"]["value"]) == EXPECT["canonical"]["text"]
    assert R.canonical_digest(EXPECT["canonical"]["value"]) == EXPECT["canonical"]["digest"]


def test_canonical_json_escapes_non_ascii_and_sorts_keys():
    assert R.canonical_json({"k": "caf\u00e9"}) == '{"k":"caf\\u00e9"}'
    assert R.canonical_json({"b": {"d": 1, "c": 2}, "a": 3}) == '{"a":3,"b":{"c":2,"d":1}}'


def test_rapp_canonical_form_keeps_frame_values_inside_the_exact_profile():
    # Frames carry exact integers only, and never more than RAPP/1's ceiling.
    with pytest.raises(ValueError, match="exact-integer profile"):
        R.rapp_canonical_json({"n": 2.5})
    with pytest.raises(ValueError, match="exceeds 1 MiB"):
        R.rapp_canonical_json("x" * (1024 * 1024 + 1))


def test_deterministic_stream_produces_the_same_bytes():
    stream = R.DeterministicStream(EXPECT["continuationSeed"])
    assert [stream.next_uint32() for _ in EXPECT["stream"]["uint32"]] == EXPECT["stream"]["uint32"]
    assert [stream.next_below(1000) for _ in EXPECT["stream"]["below1000"]] == (
        EXPECT["stream"]["below1000"]
    )
    assert [
        stream.weighted_index([1, 3, 6]) for _ in EXPECT["stream"]["weightedIndex136"]
    ] == EXPECT["stream"]["weightedIndex136"]


def test_deterministic_stream_stays_in_bounds_and_refuses_nonsense():
    stream = R.DeterministicStream("bound-check")
    for _ in range(200):
        value = stream.next_below(7)
        assert 0 <= value < 7
    with pytest.raises(ValueError, match="positive integer bound"):
        stream.next_below(0)
    with pytest.raises(ValueError, match="must not sum to zero"):
        stream.weighted_index([0, 0])


def test_rappid_hex_matches_the_rapp_construction():
    assert R.rappid_hex(INPUT["tail"]) == EXPECT["rappidHex"]
    assert INPUT["rappid"].endswith(EXPECT["rappidHex"])


def test_traits_convert_to_the_exact_integers_scoring_uses():
    assert TRAITS_MILLI == EXPECT["traitsMilli"]


def test_key_tempo_and_voice_derive_from_the_identity():
    assert PARAMS.to_wire() == EXPECT["musical"]


def test_the_identity_motif_and_its_file_bytes_match():
    assert notes_json(PROMPT) == EXPECT["prompt"]
    midi = R.write_midi(PROMPT, PARAMS)
    assert len(midi) == EXPECT["promptMidi"]["bytes"]
    assert R.sha256_hex(midi) == EXPECT["promptMidi"]["sha256"]


def test_the_motif_moves_only_when_the_identity_does():
    again = R.build_dna_prompt(INPUT["rappid"], TRAITS_MILLI, PARAMS)
    assert notes_json(again) == notes_json(PROMPT)

    other = R.build_dna_prompt(
        "rappid:@openrappter/other:" + "d" * 64, TRAITS_MILLI, PARAMS
    )
    assert notes_json(other) != notes_json(PROMPT)


def test_the_seed_binds_identity_traits_and_the_engram_cursor():
    assert R.continuation_seed(INPUT["rappid"], TRAITS_MILLI, INPUT["engramCursor"]) == (
        EXPECT["continuationSeed"]
    )
    assert R.continuation_seed(INPUT["rappid"], TRAITS_MILLI, None) != (
        EXPECT["continuationSeed"]
    )


def test_the_same_candidate_is_selected_and_scored_identically():
    proposal = R.propose_continuation(
        INPUT["rappid"], TRAITS_MILLI, PARAMS, PROMPT, INPUT["engramCursor"]
    )

    assert proposal.selected_candidate == EXPECT["selectedCandidate"]
    assert proposal.candidate_count == INPUT["candidateCount"]
    assert proposal.scores_micro.to_wire() == EXPECT["scoresMicro"]
    assert notes_json(proposal.continuation) == EXPECT["continuation"]
    assert proposal.midi_sha256 == EXPECT["continuationMidi"]["sha256"]
    assert proposal.midi_bytes == EXPECT["continuationMidi"]["bytes"]
    assert proposal.provider is R.PROVIDER


def test_the_provider_says_what_it_is():
    assert R.PROVIDER["learnedTransformer"] is False
    assert R.PROVIDER["kind"] == "deterministic-rules-and-scoring"
    assert "not a trained transformer" in R.PROVIDER["claim"]
    assert (
        R.PROVIDER["contextPolicy"]["retainedRecentNotes"]
        < R.PROVIDER["contextPolicy"]["trainingOrRuntimeCeilingNotes"]
    )


def test_proposals_are_stable_and_move_only_with_the_cursor():
    first = R.propose_continuation(INPUT["rappid"], TRAITS_MILLI, PARAMS, PROMPT, "0002")
    again = R.propose_continuation(INPUT["rappid"], TRAITS_MILLI, PARAMS, PROMPT, "0002")
    moved = R.propose_continuation(INPUT["rappid"], TRAITS_MILLI, PARAMS, PROMPT, "0003")

    assert again.midi_sha256 == first.midi_sha256
    assert moved.midi_sha256 != first.midi_sha256
    # The prompt never moves, whatever the cursor does.
    assert notes_json(moved.prompt) == notes_json(first.prompt)


def test_the_continuation_is_well_formed_in_the_representation_it_claims():
    proposal = R.propose_continuation(INPUT["rappid"], TRAITS_MILLI, PARAMS, PROMPT, None)

    assert len(proposal.continuation) == 48
    for note in proposal.continuation:
        assert sorted(note.to_json()) == ["delta_onset", "duration", "pitch", "velocity"]
        assert 0 <= note.pitch <= 127
        assert 1 <= note.velocity <= 127
        assert note.delta_onset >= 0
        assert note.duration > 0


def test_continuity_and_standalone_quality_are_scored_separately():
    candidates = R.generate_candidates(
        INPUT["rappid"], TRAITS_MILLI, PARAMS, PROMPT, None, candidate_count=4
    )

    assert len(candidates) == 4
    for candidate in candidates:
        assert candidate.scores_micro.continuation != candidate.scores_micro.sounds_good
        presented = R.present_scores(candidate.scores_micro)
        assert presented["traitFit"] == pytest.approx(
            candidate.scores_micro.trait_fit / 1_000_000
        )
    distinct = {R.canonical_json(notes_json(candidate.notes)) for candidate in candidates}
    assert len(distinct) > 1
    # Cadence is scored, not injected: candidates must not all end on one pitch
    # class, or the cadence term would be a constant that overstates quality.
    cadences = {
        candidate.notes[-1].pitch % 12
        for candidate in R.generate_candidates(
            INPUT["rappid"], TRAITS_MILLI, PARAMS, PROMPT, None, candidate_count=12
        )
    }
    assert len(cadences) > 1


def test_a_prompt_too_short_to_continue_is_refused():
    with pytest.raises(QuantumRappidError, match="at least 9 notes"):
        R.propose_continuation(INPUT["rappid"], TRAITS_MILLI, PARAMS, PROMPT[:4], None)
