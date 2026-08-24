"""Trait-conditioned MIDI autocomplete -- a proposal engine, honestly labelled.

Mirrors ``typescript/src/rappids/autocomplete.ts``, including the order of
draws from the stream: change it in one runtime and the two organisms stop
agreeing about their own song.

This is a deterministic candidate generator and scorer. It is NOT a trained
transformer, and it does not pretend to be one: it generates a fixed number of
continuations from a seeded stream, scores continuity with the prompt
separately from standalone musical quality, and selects by trait fit. The
representation, the 16-note prompt, the multi-candidate shape and the two-score
split are the ideas borrowed from
<https://simedw.com/2026/08/20/midi-autocomplete/>. A learned on-device model
can replace this provider without touching the identity motif, because the
seam is the provider, not the RAPPID.

Whatever it produces is a *proposal*. It becomes organism state only when a
verified body frame appends it.

Every number below is an integer on purpose: selection must land on the same
candidate in both runtimes, and float arithmetic agrees between them almost
always -- which is a bug that shows up once a year on one machine.
"""

from __future__ import annotations

from typing import Dict, List, Mapping, Optional, Sequence

from .canonical import (
    AUTOCOMPLETE_DOMAIN,
    DeterministicStream,
    canonical_json,
    domain_digest,
    idiv,
    micro_to_float,
    round_half_up,
    sha256_hex,
)
from .midi import STEP, clamp_int, nearest_scale_pitch, write_midi
from .types import (
    CandidateScoresMicro,
    ContinuationCandidate,
    ContinuationProposal,
    MusicalParameters,
    Note,
    QuantumRappidError,
)

MICRO = 1_000_000

#: The provider's own claim about itself, carried so it stays checkable.
PROVIDER = {
    "name": "quantum-rappid-local-candidate-generator",
    "kind": "deterministic-rules-and-scoring",
    "learnedTransformer": False,
    "claim": (
        "Deterministic local candidate generator and scorer. It applies the "
        "representation and evaluation lessons of the MIDI-autocomplete article; "
        "it is not a trained transformer."
    ),
    "contextPolicy": {
        "trainingOrRuntimeCeilingNotes": 512,
        "retainedRecentNotes": 384,
    },
    "source": "https://simedw.com/2026/08/20/midi-autocomplete/",
}

DEFAULT_CANDIDATE_COUNT = 12
DEFAULT_CONTINUATION_LENGTH = 48

INTERVAL_OPTIONS = (-7, -5, -4, -3, -2, 1, 2, 3, 4, 5, 7, 12)
ONSET_OPTIONS = (STEP, STEP * 2, STEP * 3, STEP * 4)
DURATION_OPTIONS = (STEP * 2, STEP * 3, STEP * 4, STEP * 6)
LOW_PITCH = 48
HIGH_PITCH = 86


def _trait(traits_milli: Mapping[str, int], name: str) -> int:
    if name not in traits_milli:
        raise QuantumRappidError("missing-trait", f"traits are missing {name!r}")
    return traits_milli[name]


def contour_intervals(notes: Sequence[Note]) -> List[int]:
    return [notes[index].pitch - notes[index - 1].pitch for index in range(1, len(notes))]


def continuation_seed(
    rappid: str, traits_milli: Mapping[str, int], engram_cursor: Optional[str]
) -> str:
    """The seed for one organism's proposals.

    Identity and stable traits fix the motif; the engram cursor is what may
    move it. Passing a cursor lets a creature's proposals evolve as its memory
    does, without any of it touching the RAPPID.
    """
    material = canonical_json(
        {
            "rappid": rappid,
            "traits": {key: traits_milli[key] for key in sorted(traits_milli)},
            "engram": engram_cursor,
        }
    )
    return domain_digest(AUTOCOMPLETE_DOMAIN, material)


def generate_candidate(
    prompt: Sequence[Note],
    traits_milli: Mapping[str, int],
    params: MusicalParameters,
    seed: str,
    length: int = DEFAULT_CONTINUATION_LENGTH,
) -> List[Note]:
    """One candidate continuation.

    Each step proposes every interval the mode allows, scores them against the
    prompt's opening motif and the organism's traits, and picks from a short
    list whose length is itself trait-conditioned: an evidence-bound creature
    chooses from two candidates, a loose one from five.
    """
    if len(prompt) < 9:
        raise QuantumRappidError(
            "short-prompt",
            f"a continuation needs a prompt of at least 9 notes, got {len(prompt)}",
        )
    if length < 4:
        raise QuantumRappidError("short-continuation", "a continuation needs at least 4 notes")

    stream = DeterministicStream(seed)
    motif = contour_intervals(prompt[:8])
    continuity = _trait(traits_milli, "continuity")
    curiosity_trait = _trait(traits_milli, "curiosity")
    evidence_bound = _trait(traits_milli, "evidence_bound")
    resilience = _trait(traits_milli, "resilience")
    playfulness = _trait(traits_milli, "playfulness")
    autonomy = _trait(traits_milli, "autonomy")
    pool_size = max(2, round_half_up((5000 - 3 * evidence_bound) / 1000))

    notes: List[Note] = []
    previous = prompt[-1].pitch

    for index in range(length):
        motif_interval = motif[index % len(motif)]
        proposals = []
        for order, interval in enumerate(INTERVAL_OPTIONS):
            pitch = nearest_scale_pitch(previous + interval, params.root_pitch, params.scale)
            if pitch < LOW_PITCH or pitch > HIGH_PITCH:
                continue
            continuity_fit = 1000 - min(1000, idiv(abs(interval - motif_interval) * 1000, 12))
            curiosity_fit = min(1000, idiv(abs(interval) * 1000, 9))
            anchor = 1000 if (pitch - params.root_pitch) % 12 in (0, 4, 7, 11) else 350
            recovery = 1000 - min(
                1000, idiv(abs(pitch - (params.root_pitch + 18)) * 1000, 24)
            )
            repetition = 550_000 if notes and pitch == notes[-1].pitch else 0
            # The jitter is drawn per surviving proposal, in interval order.
            # That is part of the contract both runtimes implement.
            jitter = stream.next_below(320_000)
            score = (
                idiv(continuity_fit * continuity * 19, 10)
                + idiv(curiosity_fit * curiosity_trait * 9, 10)
                + idiv(anchor * evidence_bound * 12, 10)
                + idiv(recovery * resilience * 8, 10)
                - repetition
                + jitter
            )
            proposals.append((score, pitch, order))

        if not proposals:
            raise QuantumRappidError(
                "no-proposal",
                f"no in-range pitch available from {previous}; the mode and range are inconsistent",
            )
        proposals.sort(key=lambda item: (-item[0], item[1], item[2]))
        pitch = proposals[stream.next_below(min(pool_size, len(proposals)))][1]

        delta_onset = ONSET_OPTIONS[
            stream.weighted_index(
                [1000 + 2 * playfulness, 5000, 2000 + playfulness, 2000]
            )
        ]
        duration = stream.pick(DURATION_OPTIONS)
        velocity_milli = (
            65_000
            + 28 * autonomy
            + (stream.next_below(17_001) - 9000)
            + (8000 if index % 8 == 0 else 0)
        )
        notes.append(
            Note(
                pitch=pitch,
                delta_onset=delta_onset,
                duration=duration,
                velocity=clamp_int(round_half_up(velocity_milli / 1000), 48, 112),
            )
        )
        previous = pitch

    # Cadence is evaluated, never injected. Forcing the same final tonic into
    # every candidate turns cadence into a constant score and overstates
    # quality.
    return notes


def score_candidate(
    prompt: Sequence[Note],
    continuation: Sequence[Note],
    traits_milli: Mapping[str, int],
    params: MusicalParameters,
) -> CandidateScoresMicro:
    """Continuity and standalone quality, scored separately and then blended.

    Keeping them apart is the point: a continuation can echo the prompt
    perfectly and still be dull, or be lovely and have nothing to do with the
    creature. Only the blend is trait-weighted, so the two raw numbers stay
    readable.
    """
    motif = contour_intervals(prompt[:8])
    intervals = contour_intervals([prompt[-1], *continuation])
    error_sum = sum(
        min(12, abs(interval - motif[index % len(motif)]))
        for index, interval in enumerate(intervals)
    )
    continuity_error_micro = idiv(error_sum * MICRO, len(intervals) * 12)

    repeated = sum(
        1
        for index in range(1, len(continuation))
        if continuation[index].pitch == continuation[index - 1].pitch
    )
    repeated_micro = idiv(repeated * MICRO, max(1, len(continuation) - 1))

    pitches = [note.pitch for note in continuation]
    pitch_range = max(pitches) - min(pitches)
    diversity_micro = idiv(len({pitch % 12 for pitch in pitches}) * MICRO, 12)
    root_class = params.root_pitch % 12
    cadence_micro = MICRO if continuation[-1].pitch % 12 == root_class else 0
    range_micro = MICRO - min(MICRO, idiv(abs(pitch_range - 24) * MICRO, 24))

    continuation_micro = idiv(
        (MICRO - continuity_error_micro) * 52
        + cadence_micro * 26
        + (MICRO - repeated_micro) * 22,
        100,
    )
    sounds_good_micro = idiv(
        range_micro * 42 + diversity_micro * 38 + cadence_micro * 20, 100
    )

    continuity_trait = _trait(traits_milli, "continuity")
    explore = idiv(_trait(traits_milli, "curiosity") + _trait(traits_milli, "playfulness"), 2)
    trait_fit_micro = idiv(
        continuation_micro * continuity_trait + sounds_good_micro * explore,
        continuity_trait + explore,
    )

    return CandidateScoresMicro(
        continuation=continuation_micro,
        sounds_good=sounds_good_micro,
        trait_fit=trait_fit_micro,
        pitch_range=pitch_range,
        repeated_note_ratio=repeated_micro,
        pitch_class_diversity=diversity_micro,
    )


def present_scores(scores: CandidateScoresMicro) -> Dict[str, float]:
    """Millionths rendered for a human. Never compared, never stored as truth."""
    return {
        "continuation": micro_to_float(scores.continuation),
        "soundsGood": micro_to_float(scores.sounds_good),
        "traitFit": micro_to_float(scores.trait_fit),
        "pitchRange": scores.pitch_range,
        "repeatedNoteRatio": micro_to_float(scores.repeated_note_ratio),
        "pitchClassDiversity": micro_to_float(scores.pitch_class_diversity),
    }


def generate_candidates(
    rappid: str,
    traits_milli: Mapping[str, int],
    params: MusicalParameters,
    prompt: Sequence[Note],
    engram_cursor: Optional[str],
    candidate_count: int = DEFAULT_CANDIDATE_COUNT,
    continuation_length: int = DEFAULT_CONTINUATION_LENGTH,
) -> List[ContinuationCandidate]:
    if not isinstance(candidate_count, int) or candidate_count < 1:
        raise QuantumRappidError(
            "bad-candidate-count", "candidate_count must be a positive integer"
        )
    base = continuation_seed(rappid, traits_milli, engram_cursor)
    candidates: List[ContinuationCandidate] = []
    for index in range(candidate_count):
        notes = generate_candidate(
            prompt, traits_milli, params, f"{base}:{index}", continuation_length
        )
        candidates.append(
            ContinuationCandidate(
                index=index,
                notes=notes,
                scores_micro=score_candidate(prompt, notes, traits_milli, params),
            )
        )
    return candidates


def propose_continuation(
    rappid: str,
    traits_milli: Mapping[str, int],
    params: MusicalParameters,
    prompt: Sequence[Note],
    engram_cursor: Optional[str],
    candidate_count: int = DEFAULT_CANDIDATE_COUNT,
    continuation_length: int = DEFAULT_CONTINUATION_LENGTH,
) -> ContinuationProposal:
    """Candidates, the selection, and the exact bytes it would render.

    Selection is by trait fit, then continuity, then candidate index -- a total
    order over integers, so both runtimes select the same candidate for the
    same organism every time.
    """
    candidates = generate_candidates(
        rappid,
        traits_milli,
        params,
        prompt,
        engram_cursor,
        candidate_count,
        continuation_length,
    )
    selected = min(
        candidates,
        key=lambda candidate: (
            -candidate.scores_micro.trait_fit,
            -candidate.scores_micro.continuation,
            candidate.index,
        ),
    )
    midi = write_midi([*prompt, *selected.notes], params)
    return ContinuationProposal(
        rappid=rappid,
        provider=PROVIDER,
        musical=params,
        prompt=list(prompt),
        selected_candidate=selected.index,
        candidate_count=len(candidates),
        continuation=selected.notes,
        scores_micro=selected.scores_micro,
        midi_sha256=sha256_hex(midi),
        midi_bytes=len(midi),
    )
