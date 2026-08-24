/**
 * Trait-conditioned MIDI autocomplete — a proposal engine, honestly labelled.
 *
 * This is a deterministic candidate generator and scorer. It is NOT a trained
 * transformer, and it does not pretend to be one: it generates a fixed number
 * of continuations from a seeded stream, scores continuity with the prompt
 * separately from standalone musical quality, and selects by trait fit. The
 * representation (`NOTE(pitch, delta_onset, duration, velocity)`), the 16-note
 * prompt, the multi-candidate shape and the two-score split are the ideas this
 * borrows from <https://simedw.com/2026/08/20/midi-autocomplete/>. A learned
 * on-device model can replace this provider without touching the identity
 * motif, because the seam is the provider, not the RAPPID.
 *
 * Whatever it produces is a *proposal*. It becomes organism state only when a
 * verified body frame appends it.
 *
 * ── Why every number below is an integer ──────────────────────────────────
 *
 * Selection must land on the same candidate in TypeScript and Python. Float
 * arithmetic agrees between the two almost always, and "almost always" is a
 * bug that appears once a year on one machine. So traits arrive as
 * thousandths, scores are computed in millionths, and floats appear only when
 * a score is rendered for a human.
 *
 * Mirrored by `python/openrappter/rappids/autocomplete.py`. The order of draws
 * from the stream is part of the contract: change it in one runtime and the
 * two organisms stop agreeing about their own song.
 */

import {
  AUTOCOMPLETE_DOMAIN,
  DeterministicStream,
  canonicalJson,
  domainDigest,
  idiv,
  microToFloat,
  roundHalfUp,
  sha256Hex,
} from './canonical.js';
import { STEP, clampInt, nearestScalePitch, writeMidi } from './midi.js';
import { QuantumRappidError } from './types.js';
import type {
  CandidateScores,
  CandidateScoresMicro,
  ContinuationCandidate,
  ContinuationProposal,
  JsonObject,
  MusicalParameters,
  Note,
  ProviderClaim,
} from './types.js';

const MICRO = 1_000_000;

/** Article-derived context policy, carried so the claim stays checkable. */
export const PROVIDER: ProviderClaim = {
  name: 'quantum-rappid-local-candidate-generator',
  kind: 'deterministic-rules-and-scoring',
  learnedTransformer: false,
  claim:
    'Deterministic local candidate generator and scorer. It applies the '
    + 'representation and evaluation lessons of the MIDI-autocomplete article; '
    + 'it is not a trained transformer.',
  contextPolicy: {
    trainingOrRuntimeCeilingNotes: 512,
    retainedRecentNotes: 384,
  },
  source: 'https://simedw.com/2026/08/20/midi-autocomplete/',
};

export const DEFAULT_CANDIDATE_COUNT = 12;
export const DEFAULT_CONTINUATION_LENGTH = 48;

const INTERVAL_OPTIONS = [-7, -5, -4, -3, -2, 1, 2, 3, 4, 5, 7, 12];
const ONSET_OPTIONS = [STEP, STEP * 2, STEP * 3, STEP * 4];
const DURATION_OPTIONS = [STEP * 2, STEP * 3, STEP * 4, STEP * 6];
const LOW_PITCH = 48;
const HIGH_PITCH = 86;

function trait(traitsMilli: Record<string, number>, name: string): number {
  const value = traitsMilli[name];
  if (value === undefined) {
    throw new QuantumRappidError('missing-trait', `traits are missing ${JSON.stringify(name)}`);
  }
  return value;
}

export function contourIntervals(notes: readonly Note[]): number[] {
  const intervals: number[] = [];
  for (let index = 1; index < notes.length; index += 1) {
    intervals.push(notes[index].pitch - notes[index - 1].pitch);
  }
  return intervals;
}

/**
 * The seed for one organism's proposals.
 *
 * Identity and stable traits fix the motif; the engram cursor is what may move
 * it. Passing a cursor lets a creature's proposals evolve as its memory does,
 * without any of it touching the RAPPID.
 */
export function continuationSeed(
  rappid: string,
  traitsMilli: Record<string, number>,
  engramCursor: string | null,
): string {
  const material = canonicalJson({
    rappid,
    traits: sortedTraits(traitsMilli),
    engram: engramCursor,
  });
  return domainDigest(AUTOCOMPLETE_DOMAIN, material);
}

function sortedTraits(traitsMilli: Record<string, number>): JsonObject {
  const out: JsonObject = {};
  for (const key of Object.keys(traitsMilli).sort()) out[key] = traitsMilli[key];
  return out;
}

/**
 * One candidate continuation.
 *
 * Each step proposes every interval the mode allows, scores them against the
 * prompt's opening motif and the organism's traits, and picks from a short
 * list whose length is itself trait-conditioned: an evidence-bound creature
 * chooses from two candidates, a loose one from five.
 */
export function generateCandidate(
  prompt: readonly Note[],
  traitsMilli: Record<string, number>,
  params: MusicalParameters,
  seed: string,
  length = DEFAULT_CONTINUATION_LENGTH,
): Note[] {
  if (prompt.length < 9) {
    throw new QuantumRappidError(
      'short-prompt',
      `a continuation needs a prompt of at least 9 notes, got ${prompt.length}`,
    );
  }
  if (length < 4) {
    throw new QuantumRappidError('short-continuation', 'a continuation needs at least 4 notes');
  }

  const stream = new DeterministicStream(seed);
  const motif = contourIntervals(prompt.slice(0, 8));
  const continuity = trait(traitsMilli, 'continuity');
  const curiosityTrait = trait(traitsMilli, 'curiosity');
  const evidenceBound = trait(traitsMilli, 'evidence_bound');
  const resilience = trait(traitsMilli, 'resilience');
  const playfulness = trait(traitsMilli, 'playfulness');
  const autonomy = trait(traitsMilli, 'autonomy');
  const poolSize = Math.max(2, roundHalfUp((5000 - 3 * evidenceBound) / 1000));

  const notes: Note[] = [];
  let previous = prompt[prompt.length - 1].pitch;

  for (let index = 0; index < length; index += 1) {
    const motifInterval = motif[index % motif.length];
    const proposals: Array<{ score: number; pitch: number; order: number }> = [];

    INTERVAL_OPTIONS.forEach((interval, order) => {
      const pitch = nearestScalePitch(previous + interval, params.rootPitch, params.scale);
      if (pitch < LOW_PITCH || pitch > HIGH_PITCH) return;
      const continuityFit = 1000 - Math.min(1000, idiv(Math.abs(interval - motifInterval) * 1000, 12));
      const curiosityFit = Math.min(1000, idiv(Math.abs(interval) * 1000, 9));
      const anchored = [0, 4, 7, 11].includes(((pitch - params.rootPitch) % 12 + 12) % 12);
      const anchor = anchored ? 1000 : 350;
      const recovery = 1000 - Math.min(1000, idiv(Math.abs(pitch - (params.rootPitch + 18)) * 1000, 24));
      const repetition = notes.length > 0 && pitch === notes[notes.length - 1].pitch ? 550_000 : 0;
      // The jitter is drawn per surviving proposal, in interval order. That is
      // part of the contract both runtimes implement.
      const jitter = stream.nextBelow(320_000);
      const score =
        idiv(continuityFit * continuity * 19, 10)
        + idiv(curiosityFit * curiosityTrait * 9, 10)
        + idiv(anchor * evidenceBound * 12, 10)
        + idiv(recovery * resilience * 8, 10)
        - repetition
        + jitter;
      proposals.push({ score, pitch, order });
    });

    if (proposals.length === 0) {
      throw new QuantumRappidError(
        'no-proposal',
        `no in-range pitch available from ${previous}; the mode and range are inconsistent`,
      );
    }
    proposals.sort((left, right) => right.score - left.score || left.pitch - right.pitch || left.order - right.order);
    const pitch = proposals[stream.nextBelow(Math.min(poolSize, proposals.length))].pitch;

    const deltaOnset = ONSET_OPTIONS[
      stream.weightedIndex([1000 + 2 * playfulness, 5000, 2000 + playfulness, 2000])
    ];
    const duration = stream.pick(DURATION_OPTIONS);
    const velocityMilli =
      65_000
      + 28 * autonomy
      + (stream.nextBelow(17_001) - 9000)
      + (index % 8 === 0 ? 8000 : 0);
    notes.push({
      pitch,
      deltaOnset,
      duration,
      velocity: clampInt(roundHalfUp(velocityMilli / 1000), 48, 112),
    });
    previous = pitch;
  }

  // Cadence is evaluated, never injected. Forcing the same final tonic into
  // every candidate turns cadence into a constant score and overstates quality.
  return notes;
}

/**
 * Continuity and standalone quality, scored separately and then blended.
 *
 * Keeping them apart is the point: a continuation can echo the prompt
 * perfectly and still be dull, or be lovely and have nothing to do with the
 * creature. Only the blend is trait-weighted, so the two raw numbers stay
 * readable.
 */
export function scoreCandidate(
  prompt: readonly Note[],
  continuation: readonly Note[],
  traitsMilli: Record<string, number>,
  params: MusicalParameters,
): CandidateScoresMicro {
  const motif = contourIntervals(prompt.slice(0, 8));
  const intervals = contourIntervals([prompt[prompt.length - 1], ...continuation]);
  let errorSum = 0;
  intervals.forEach((interval, index) => {
    errorSum += Math.min(12, Math.abs(interval - motif[index % motif.length]));
  });
  const continuityErrorMicro = idiv(errorSum * MICRO, intervals.length * 12);

  let repeated = 0;
  for (let index = 1; index < continuation.length; index += 1) {
    if (continuation[index].pitch === continuation[index - 1].pitch) repeated += 1;
  }
  const repeatedMicro = idiv(repeated * MICRO, Math.max(1, continuation.length - 1));

  const pitches = continuation.map((note) => note.pitch);
  const pitchRange = Math.max(...pitches) - Math.min(...pitches);
  const pitchClasses = new Set(pitches.map((pitch) => ((pitch % 12) + 12) % 12));
  const diversityMicro = idiv(pitchClasses.size * MICRO, 12);
  const rootClass = ((params.rootPitch % 12) + 12) % 12;
  const cadenceMicro =
    ((continuation[continuation.length - 1].pitch % 12) + 12) % 12 === rootClass ? MICRO : 0;
  const rangeMicro = MICRO - Math.min(MICRO, idiv(Math.abs(pitchRange - 24) * MICRO, 24));

  const continuationMicro = idiv(
    (MICRO - continuityErrorMicro) * 52 + cadenceMicro * 26 + (MICRO - repeatedMicro) * 22,
    100,
  );
  const soundsGoodMicro = idiv(rangeMicro * 42 + diversityMicro * 38 + cadenceMicro * 20, 100);

  const continuityTrait = trait(traitsMilli, 'continuity');
  const explore = idiv(trait(traitsMilli, 'curiosity') + trait(traitsMilli, 'playfulness'), 2);
  const traitFitMicro = idiv(
    continuationMicro * continuityTrait + soundsGoodMicro * explore,
    continuityTrait + explore,
  );

  return {
    continuation: continuationMicro,
    soundsGood: soundsGoodMicro,
    traitFit: traitFitMicro,
    pitchRange,
    repeatedNoteRatio: repeatedMicro,
    pitchClassDiversity: diversityMicro,
  };
}

/** Millionths rendered for a human. Never compared, never stored as truth. */
export function presentScores(scores: CandidateScoresMicro): CandidateScores {
  return {
    continuation: microToFloat(scores.continuation),
    soundsGood: microToFloat(scores.soundsGood),
    traitFit: microToFloat(scores.traitFit),
    pitchRange: scores.pitchRange,
    repeatedNoteRatio: microToFloat(scores.repeatedNoteRatio),
    pitchClassDiversity: microToFloat(scores.pitchClassDiversity),
  };
}

export interface ContinuationRequest {
  rappid: string;
  traitsMilli: Record<string, number>;
  params: MusicalParameters;
  prompt: Note[];
  engramCursor: string | null;
  candidateCount?: number;
  continuationLength?: number;
}

export function generateCandidates(request: ContinuationRequest): ContinuationCandidate[] {
  const count = request.candidateCount ?? DEFAULT_CANDIDATE_COUNT;
  if (!Number.isInteger(count) || count < 1) {
    throw new QuantumRappidError('bad-candidate-count', 'candidateCount must be a positive integer');
  }
  const base = continuationSeed(request.rappid, request.traitsMilli, request.engramCursor);
  const candidates: ContinuationCandidate[] = [];
  for (let index = 0; index < count; index += 1) {
    const notes = generateCandidate(
      request.prompt,
      request.traitsMilli,
      request.params,
      `${base}:${index}`,
      request.continuationLength ?? DEFAULT_CONTINUATION_LENGTH,
    );
    const scoresMicro = scoreCandidate(request.prompt, notes, request.traitsMilli, request.params);
    candidates.push({ index, notes, scoresMicro, scores: presentScores(scoresMicro) });
  }
  return candidates;
}

/**
 * The proposal: candidates, the selection, and the exact bytes it would render.
 *
 * Selection is by trait fit, then continuity, then candidate index — a total
 * order over integers, so both runtimes select the same candidate for the same
 * organism every time.
 */
export function proposeContinuation(request: ContinuationRequest): ContinuationProposal {
  const candidates = generateCandidates(request);
  const selected = candidates.reduce((best, candidate) => {
    if (candidate.scoresMicro.traitFit !== best.scoresMicro.traitFit) {
      return candidate.scoresMicro.traitFit > best.scoresMicro.traitFit ? candidate : best;
    }
    if (candidate.scoresMicro.continuation !== best.scoresMicro.continuation) {
      return candidate.scoresMicro.continuation > best.scoresMicro.continuation ? candidate : best;
    }
    return best;
  });

  const midi = writeMidi([...request.prompt, ...selected.notes], request.params);
  return {
    rappid: request.rappid,
    provider: PROVIDER,
    musical: request.params,
    prompt: [...request.prompt],
    selectedCandidate: selected.index,
    candidateCount: candidates.length,
    continuation: selected.notes,
    scoresMicro: selected.scoresMicro,
    scores: selected.scores,
    midiSha256: sha256Hex(midi),
    midiBytes: midi.length,
    authoritative: false,
  };
}
