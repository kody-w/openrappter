/**
 * The provider is deterministic, or it is not a provider.
 *
 * "Deterministic" has to mean *across runtimes*, not merely "stable if you run
 * it twice on this laptop". Both suites read `tests/quantum-rappid-parity.json`
 * and are held to the same integers, so a change that quietly re-voices every
 * organism in one runtime cannot pass here.
 *
 * The Python twin is `python/tests/test_quantum_rappid_parity.py`.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DeterministicStream,
  PROVIDER,
  buildDnaPrompt,
  canonicalDigest,
  canonicalJson,
  continuationSeed,
  generateCandidates,
  noteToJson,
  proposeContinuation,
  rappidHex,
  rappCanonicalJson,
  sha256Hex,
  sonicParameters,
  traitMilli,
  writeMidi,
} from '../index.js';
import type { JsonObject, JsonValue, Note } from '../index.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..', '..');
const vector = JSON.parse(
  readFileSync(join(repoRoot, 'tests', 'quantum-rappid-parity.json'), 'utf8'),
) as {
  input: {
    tail: string;
    rappid: string;
    traits: Record<string, number>;
    engramCursor: string;
    candidateCount: number;
    continuationLength: number;
  };
  expect: {
    rappidHex: string;
    traitsMilli: Record<string, number>;
    musical: Record<string, unknown>;
    prompt: Array<Record<string, number>>;
    promptMidi: { bytes: number; sha256: string };
    continuationSeed: string;
    stream: { uint32: number[]; below1000: number[]; weightedIndex136: number[] };
    canonical: { value: JsonValue; text: string; digest: string };
    selectedCandidate: number;
    scoresMicro: Record<string, number>;
    continuation: Array<Record<string, number>>;
    continuationMidi: { bytes: number; sha256: string };
  };
};

const traitsMilli: Record<string, number> = {};
for (const key of Object.keys(vector.input.traits).sort()) {
  traitsMilli[key] = traitMilli(vector.input.traits[key]);
}
const params = sonicParameters(vector.input.rappid, traitsMilli);
const prompt = buildDnaPrompt(vector.input.rappid, traitsMilli, params);

function json(notes: readonly Note[]): Array<Record<string, number>> {
  return notes.map((note) => noteToJson(note) as unknown as Record<string, number>);
}

function readVariableLength(bytes: Buffer, start: number): [number, number] {
  let value = 0;
  let offset = start;
  for (let count = 0; count < 4; count += 1) {
    const byte = bytes[offset];
    if (byte === undefined) throw new Error('truncated MIDI variable-length value');
    offset += 1;
    value = (value << 7) | (byte & 0x7f);
    if ((byte & 0x80) === 0) return [value, offset];
  }
  throw new Error('MIDI variable-length value exceeds four bytes');
}

function parseSingleTrackMidi(bytes: Buffer): void {
  expect(bytes.subarray(0, 4).toString('ascii')).toBe('MThd');
  expect(bytes.readUInt32BE(4)).toBe(6);
  expect(bytes.readUInt16BE(8)).toBe(0);
  expect(bytes.readUInt16BE(10)).toBe(1);
  expect(bytes.subarray(14, 18).toString('ascii')).toBe('MTrk');
  const end = 22 + bytes.readUInt32BE(18);
  expect(end).toBe(bytes.length);

  let offset = 22;
  let runningStatus: number | null = null;
  let ended = false;
  while (offset < end) {
    [, offset] = readVariableLength(bytes, offset);
    let status = bytes[offset];
    if (status === undefined) throw new Error('truncated MIDI event');
    if ((status & 0x80) !== 0) {
      offset += 1;
      if (status < 0xf0) runningStatus = status;
    } else {
      if (runningStatus === null) throw new Error('MIDI data byte has no running status');
      status = runningStatus;
    }
    if (status === 0xff) {
      const kind = bytes[offset];
      if (kind === undefined) throw new Error('truncated MIDI meta event');
      offset += 1;
      const [length, next] = readVariableLength(bytes, offset);
      offset = next + length;
      if (kind === 0x2f) ended = true;
      runningStatus = null;
    } else {
      const family = status & 0xf0;
      offset += family === 0xc0 || family === 0xd0 ? 1 : 2;
    }
    if (offset > end) throw new Error('MIDI event exceeds declared track length');
  }
  expect(offset).toBe(end);
  expect(ended).toBe(true);
}

describe('canonical bytes', () => {
  it('serialises the way Python does, key order and ASCII escapes included', () => {
    expect(canonicalJson(vector.expect.canonical.value)).toBe(vector.expect.canonical.text);
    expect(canonicalDigest(vector.expect.canonical.value)).toBe(vector.expect.canonical.digest);
  });

  it('escapes non-ASCII rather than emitting raw UTF-8', () => {
    expect(canonicalJson({ k: 'café' } as JsonObject)).toBe('{"k":"caf\\u00e9"}');
  });

  it('sorts keys at every depth', () => {
    expect(canonicalJson({ b: { d: 1, c: 2 }, a: 3 } as JsonObject)).toBe('{"a":3,"b":{"c":2,"d":1}}');
  });

  it('keeps RAPP/1 frame values inside the exact profile and size ceiling', () => {
    expect(() => rappCanonicalJson({ n: 2.5 })).toThrow(
      /exact-integer profile/,
    );
    expect(() => rappCanonicalJson('x'.repeat(1024 * 1024 + 1))).toThrow(
      /exceeds 1 MiB/,
    );
  });
});

describe('the deterministic stream', () => {
  it('produces the same bytes as the other runtime', () => {
    const stream = new DeterministicStream(vector.expect.continuationSeed);
    expect(vector.expect.stream.uint32.map(() => stream.nextUint32())).toEqual(
      vector.expect.stream.uint32,
    );
    expect(vector.expect.stream.below1000.map(() => stream.nextBelow(1000))).toEqual(
      vector.expect.stream.below1000,
    );
    expect(vector.expect.stream.weightedIndex136.map(() => stream.weightedIndex([1, 3, 6]))).toEqual(
      vector.expect.stream.weightedIndex136,
    );
  });

  it('stays inside its bound and refuses a nonsensical one', () => {
    const stream = new DeterministicStream('bound-check');
    for (let index = 0; index < 200; index += 1) {
      const value = stream.nextBelow(7);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(7);
    }
    expect(() => stream.nextBelow(0)).toThrow(/positive integer bound/);
    expect(() => stream.weightedIndex([0, 0])).toThrow(/must not sum to zero/);
  });
});

describe('identity-bound MIDI DNA', () => {
  it('derives the public RAPPID hex the way RAPP/1 does', () => {
    expect(rappidHex(vector.input.tail)).toBe(vector.expect.rappidHex);
    expect(vector.input.rappid.endsWith(vector.expect.rappidHex)).toBe(true);
  });

  it('converts traits to the exact integers scoring uses', () => {
    expect(traitsMilli).toEqual(vector.expect.traitsMilli);
  });

  it('derives key, tempo and voice from the identity', () => {
    expect({
      rootPitch: params.rootPitch,
      rootPitchClass: params.rootPitchClass,
      mode: params.mode,
      scale: params.scale,
      bpm: params.bpm,
      program: params.program,
    }).toEqual(vector.expect.musical);
  });

  it('derives the same 16-note motif, and renders the same file bytes', () => {
    expect(json(prompt)).toEqual(vector.expect.prompt);
    const midi = writeMidi(prompt, params);
    parseSingleTrackMidi(midi);
    expect(midi.length).toBe(vector.expect.promptMidi.bytes);
    expect(sha256Hex(midi)).toBe(vector.expect.promptMidi.sha256);
  });

  it('does not move when the organism does anything but change identity', () => {
    const again = buildDnaPrompt(vector.input.rappid, traitsMilli, params);
    expect(json(again)).toEqual(json(prompt));

    const other = buildDnaPrompt(`rappid:@openrappter/other:${'d'.repeat(64)}`, traitsMilli, params);
    expect(json(other)).not.toEqual(json(prompt));
  });
});

describe('the continuation provider', () => {
  it('seeds from identity, traits and the engram cursor', () => {
    expect(continuationSeed(vector.input.rappid, traitsMilli, vector.input.engramCursor)).toBe(
      vector.expect.continuationSeed,
    );
    expect(continuationSeed(vector.input.rappid, traitsMilli, null)).not.toBe(
      vector.expect.continuationSeed,
    );
  });

  it('selects the same candidate and scores it identically', () => {
    const proposal = proposeContinuation({
      rappid: vector.input.rappid,
      traitsMilli,
      params,
      prompt,
      engramCursor: vector.input.engramCursor,
    });

    expect(proposal.selectedCandidate).toBe(vector.expect.selectedCandidate);
    expect(proposal.candidateCount).toBe(vector.input.candidateCount);
    expect(proposal.scoresMicro).toEqual(vector.expect.scoresMicro);
    expect(json(proposal.continuation)).toEqual(vector.expect.continuation);
    parseSingleTrackMidi(writeMidi([...prompt, ...proposal.continuation], params));
    expect(proposal.midiSha256).toBe(vector.expect.continuationMidi.sha256);
    expect(proposal.midiBytes).toBe(vector.expect.continuationMidi.bytes);
    expect(proposal.authoritative).toBe(false);
  });

  it('says what it is, and does not claim to be a transformer', () => {
    expect(PROVIDER.learnedTransformer).toBe(false);
    expect(PROVIDER.kind).toBe('deterministic-rules-and-scoring');
    expect(PROVIDER.claim).toContain('not a trained transformer');
    expect(PROVIDER.contextPolicy.retainedRecentNotes).toBeLessThan(
      PROVIDER.contextPolicy.trainingOrRuntimeCeilingNotes,
    );
  });

  it('is stable across calls and moves only when the cursor moves', () => {
    const first = proposeContinuation({
      rappid: vector.input.rappid,
      traitsMilli,
      params,
      prompt,
      engramCursor: '0002',
    });
    const again = proposeContinuation({
      rappid: vector.input.rappid,
      traitsMilli,
      params,
      prompt,
      engramCursor: '0002',
    });
    const moved = proposeContinuation({
      rappid: vector.input.rappid,
      traitsMilli,
      params,
      prompt,
      engramCursor: '0003',
    });

    expect(again.midiSha256).toBe(first.midiSha256);
    expect(moved.midiSha256).not.toBe(first.midiSha256);
    // The prompt never moves, whatever the cursor does.
    expect(json(moved.prompt)).toEqual(json(first.prompt));
  });

  it('answers in the note representation it claims and stays in range', () => {
    const proposal = proposeContinuation({
      rappid: vector.input.rappid,
      traitsMilli,
      params,
      prompt,
      engramCursor: null,
    });

    expect(proposal.continuation).toHaveLength(48);
    for (const note of proposal.continuation) {
      expect(Object.keys(noteToJson(note)).sort()).toEqual([
        'delta_onset',
        'duration',
        'pitch',
        'velocity',
      ]);
      expect(note.pitch).toBeGreaterThanOrEqual(0);
      expect(note.pitch).toBeLessThanOrEqual(127);
      expect(note.velocity).toBeGreaterThanOrEqual(1);
      expect(note.velocity).toBeLessThanOrEqual(127);
      expect(note.deltaOnset).toBeGreaterThanOrEqual(0);
      expect(note.duration).toBeGreaterThan(0);
    }
  });

  it('scores continuity and standalone quality separately', () => {
    const candidates = generateCandidates({
      rappid: vector.input.rappid,
      traitsMilli,
      params,
      prompt,
      engramCursor: null,
      candidateCount: 4,
    });

    expect(candidates).toHaveLength(4);
    for (const candidate of candidates) {
      expect(candidate.scoresMicro.continuation).not.toBe(candidate.scoresMicro.soundsGood);
      expect(candidate.scores.traitFit).toBeCloseTo(candidate.scoresMicro.traitFit / 1_000_000, 9);
    }
    // Different candidates are genuinely different songs, not one repeated.
    const distinct = new Set(candidates.map((candidate) => canonicalJson(json(candidate.notes))));
    expect(distinct.size).toBeGreaterThan(1);
    const cadences = new Set(
      generateCandidates({
        rappid: vector.input.rappid,
        traitsMilli,
        params,
        prompt,
        engramCursor: null,
        candidateCount: 12,
      }).map((candidate) =>
        candidate.notes[candidate.notes.length - 1].pitch % 12,
      ),
    );
    expect(cadences.size).toBeGreaterThan(1);
  });

  it('refuses a prompt too short to continue', () => {
    expect(() =>
      proposeContinuation({
        rappid: vector.input.rappid,
        traitsMilli,
        params,
        prompt: prompt.slice(0, 4),
        engramCursor: null,
      }),
    ).toThrow(/at least 9 notes/);
  });
});
