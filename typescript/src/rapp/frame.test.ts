import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  RAPP_MAX_CANONICAL_BYTES,
  RAPP_PARTICLE_DOMAIN,
  parseRappJson,
  rappCanonicalJson,
  rappH,
} from '../rappids/canonical.js';
import {
  bodyFrameProblems,
  bodyFrameToJson,
  buildDimensionFrame,
} from '../rappids/store.js';
import type {
  BodyFrame,
  JsonObject,
  JsonValue,
} from '../rappids/types.js';
import {
  RAPP_FRAME_KEYS,
  RAPP_REV14_BODY_PULSE_PROFILE,
  RAPP_UINT53_MAX,
  RappFrameError,
  buildRappFrame,
  isRappFrameUtc,
  rappFrameDigest,
  rappFrameToJson,
  rappFrameWavePreimage,
  verifyRappFrame,
  verifyRappFrameChain,
  verifyRappFrameJson,
  type RappFrame,
  type RappFrameHead,
} from './index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = resolve(HERE, '__fixtures__/rev14-authority.json');

interface AuthorityFixture {
  authority: {
    repository: string;
    commit: string;
    revision: string;
  };
  expected: {
    frame_keys: string[];
    frame_canonical_bytes: number;
    frame_canonical_sha256: string;
    payload_canonical_bytes: number;
    payload_canonical_sha256: string;
    wave_canonical_bytes: number;
    wave_canonical_sha256: string;
    payload_hash: string;
    frame_hash: string;
  };
  predecessor: RappFrameHead;
  frame: RappFrame<JsonObject, 'body.pulse'>;
}

const authority = parseRappJson(
  readFileSync(FIXTURE_PATH, 'utf8'),
) as unknown as AuthorityFixture;

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function rewave(frame: RappFrame<JsonObject, 'body.pulse'>):
RappFrame<JsonObject, 'body.pulse'> {
  return { ...frame, frame_hash: rappFrameDigest(frame) };
}

describe('rev-14 authority parity', () => {
  it('verifies the real rev-14 head with exact keys, canonical bytes, and hashes', () => {
    expect(authority.authority).toEqual({
      repository: 'https://github.com/kody-w/rapp-1',
      commit: 'ef4545080e76db421d6b60421b125d9946e36005',
      revision: 'rev-14',
    });
    expect(authority.frame.frame_hash)
      .toBe('aa9af1c34eefab67d08c6fe814206d635d6a20f48a3ebbe30d0724b218d0afd9');
    expect(Object.keys(authority.frame).sort()).toEqual(authority.expected.frame_keys);
    expect(Object.keys(authority.frame)).toHaveLength(11);
    expect([...RAPP_FRAME_KEYS].sort()).toEqual(authority.expected.frame_keys);

    const canonicalFrame = rappCanonicalJson(rappFrameToJson(authority.frame));
    const canonicalPayload = rappCanonicalJson(authority.frame.payload);
    const wavePreimage = rappFrameWavePreimage(authority.frame);
    const canonicalWave = rappCanonicalJson(wavePreimage);
    expect(Object.keys(wavePreimage)).toHaveLength(9);
    expect(wavePreimage).not.toHaveProperty('frame_hash');
    expect(wavePreimage).not.toHaveProperty('sig');
    expect(Buffer.byteLength(canonicalFrame, 'utf8'))
      .toBe(authority.expected.frame_canonical_bytes);
    expect(sha256(canonicalFrame)).toBe(authority.expected.frame_canonical_sha256);
    expect(Buffer.byteLength(canonicalPayload, 'utf8'))
      .toBe(authority.expected.payload_canonical_bytes);
    expect(sha256(canonicalPayload)).toBe(authority.expected.payload_canonical_sha256);
    expect(Buffer.byteLength(canonicalWave, 'utf8'))
      .toBe(authority.expected.wave_canonical_bytes);
    expect(sha256(canonicalWave)).toBe(authority.expected.wave_canonical_sha256);
    expect(rappH(RAPP_PARTICLE_DOMAIN, authority.frame.payload))
      .toBe(authority.expected.payload_hash);
    expect(rappFrameDigest(authority.frame)).toBe(authority.expected.frame_hash);

    expect(verifyRappFrame(
      authority.frame,
      RAPP_REV14_BODY_PULSE_PROFILE,
      {
        head: authority.predecessor,
        streamIdOfRecord: authority.frame.stream_id,
      },
    )).toMatchObject({ ok: true });
  });

  it('rebuilds the authority head byte-for-byte from its predecessor and payload', () => {
    const rebuilt = buildRappFrame({
      kind: 'body.pulse',
      streamId: authority.frame.stream_id,
      utc: authority.frame.utc,
      payload: authority.frame.payload,
      head: authority.predecessor,
    }, RAPP_REV14_BODY_PULSE_PROFILE);

    expect(rebuilt).toEqual(authority.frame);
    expect(rappCanonicalJson(rappFrameToJson(rebuilt)))
      .toBe(rappCanonicalJson(rappFrameToJson(authority.frame)));
  });
});

describe('RAPP/1 verification order and mutation refusal', () => {
  const verify = (frame: unknown) => verifyRappFrame(
    frame,
    RAPP_REV14_BODY_PULSE_PROFILE,
    {
      head: authority.predecessor,
      streamIdOfRecord: authority.frame.stream_id,
    },
  );

  it.each([
    ['extra key', (frame: Record<string, unknown>) => { frame.extra = null; }, '1', 'key-set'],
    ['missing key', (frame: Record<string, unknown>) => { delete frame.prev_wave; }, '1', 'key-set'],
    ['kind', (frame: Record<string, unknown>) => { frame.kind = 'body.twin-pulse'; }, '1', 'unregistered-kind'],
    ['invalid utc', (frame: Record<string, unknown>) => { frame.utc = '2026-02-30T00:00:00.000Z'; }, '1', 'utc'],
    ['payload', (frame: Record<string, unknown>) => {
      (frame.payload as Record<string, unknown>).revision = 'rev-tampered';
    }, '2', 'payload-hash'],
    ['frame hash', (frame: Record<string, unknown>) => { frame.frame_hash = '0'.repeat(64); }, '3', 'frame-hash'],
    ['sig', (frame: Record<string, unknown>) => { frame.sig = 'not-a-local-signature'; }, '6', 'signature-profile'],
  ])('rejects %s tamper at step %s', (_label, mutate, step, code) => {
    const frame = clone(authority.frame) as unknown as Record<string, unknown>;
    mutate(frame);
    const result = verify(frame);
    expect(result).toMatchObject({ ok: false, error: { step, code } });
  });

  it('checks stream binding before the stale wave hash', () => {
    const frame = clone(authority.frame);
    frame.stream_id = `rappid:@kody-w/another:${'b'.repeat(64)}`;
    const result = verify(frame);
    expect(result).toMatchObject({
      ok: false,
      error: { step: '1a', code: 'stream-binding' },
    });
  });

  it('refuses a predecessor from another stream instead of reparenting', () => {
    const result = verifyRappFrame(
      authority.frame,
      RAPP_REV14_BODY_PULSE_PROFILE,
      {
        head: {
          ...authority.predecessor,
          stream_id: `rappid:@kody-w/another:${'b'.repeat(64)}`,
        },
        streamIdOfRecord: authority.frame.stream_id,
      },
    );
    expect(result).toMatchObject({
      ok: false,
      error: { step: '1a', code: 'stream-binding' },
    });
  });

  it('refuses duplicate wire members before JSON.parse can erase them', () => {
    const wire = JSON.stringify(authority.frame).replace(
      '{"spec":"rapp/1",',
      '{"spec":"rapp/1","spec":"rapp/1",',
    );
    expect(verifyRappFrameJson(
      wire,
      RAPP_REV14_BODY_PULSE_PROFILE,
      {
        head: authority.predecessor,
        streamIdOfRecord: authority.frame.stream_id,
      },
    )).toMatchObject({
      ok: false,
      error: { step: '1', code: 'canonical' },
    });
  });

  it.each([
    ['prev', (frame: RappFrame<JsonObject, 'body.pulse'>) => {
      frame.prev = '0'.repeat(64);
    }, 'prev-continuity'],
    ['seq', (frame: RappFrame<JsonObject, 'body.pulse'>) => {
      frame.seq += 1;
    }, 'seq-continuity'],
    ['time', (frame: RappFrame<JsonObject, 'body.pulse'>) => {
      frame.utc = '2026-08-30T18:48:18.784Z';
    }, 'time-regression'],
  ])('rejects a hash-valid %s reparenting attempt at step 4', (_label, mutate, code) => {
    const frame = clone(authority.frame);
    mutate(frame);
    const result = verify(rewave(frame));
    expect(result).toMatchObject({ ok: false, error: { step: '4', code } });
  });

  it('rejects a hash-valid body prev_wave at step 5', () => {
    const frame = clone(authority.frame);
    frame.prev_wave = authority.predecessor.frame_hash;
    const result = verify(rewave(frame));
    expect(result).toMatchObject({
      ok: false,
      error: { step: '5', code: 'prev-wave' },
    });
  });

  it('does not mutate or poison a valid frame after refusing a tampered copy', () => {
    const tampered = clone(authority.frame);
    tampered.payload_hash = '0'.repeat(64);
    expect(verify(tampered)).toMatchObject({
      ok: false,
      error: { step: '2', code: 'payload-hash' },
    });
    expect(verify(authority.frame)).toMatchObject({ ok: true });
    expect(authority.frame.payload_hash).toBe(authority.expected.payload_hash);
  });

  it('rejects unsafe sequence values before hashing', () => {
    const frame = clone(authority.frame) as RappFrame<JsonObject, 'body.pulse'>;
    frame.seq = RAPP_UINT53_MAX + 1;
    expect(verify(frame)).toMatchObject({
      ok: false,
      error: { step: '1', code: 'seq' },
    });
  });

  it('refuses append past uint53 instead of wrapping or re-genesis by itself', () => {
    expect(() => buildRappFrame({
      kind: 'body.pulse',
      streamId: authority.frame.stream_id,
      utc: authority.frame.utc,
      payload: { event: 'overflow' },
      head: { ...authority.predecessor, seq: RAPP_UINT53_MAX },
    }, RAPP_REV14_BODY_PULSE_PROFILE)).toThrow(RappFrameError);
  });
});

describe('canonical and time bounds', () => {
  it('uses UTF-16 key ordering for valid supplementary-plane keys', () => {
    const supplementary = '\u{10000}';
    const bmpPrivateUse = '\ue000';
    expect(rappCanonicalJson({
      [bmpPrivateUse]: 1,
      [supplementary]: 2,
    })).toBe(`{"${supplementary}":2,"${bmpPrivateUse}":1}`);
  });

  it('rejects unpaired surrogates in values and keys', () => {
    expect(() => rappCanonicalJson('\ud800')).toThrow(/unpaired surrogate/);
    expect(() => rappCanonicalJson({ ['\udc00']: 1 })).toThrow(/unpaired surrogate/);
  });

  it('refuses duplicate members and lossy number tokens before JSON parsing', () => {
    expect(() => parseRappJson('{"a":1,"a":2}')).toThrow(/duplicate JSON member/);
    expect(() => parseRappJson('{"n":9007199254740993}')).toThrow(/precision/);
    expect(() => parseRappJson('{"n":1e0}')).toThrow(/exact-integer profile/);
    expect(() => parseRappJson('{"n":0.1}')).toThrow(/exact-integer profile/);
  });

  it('enforces the exact-integer, depth, and 1 MiB ceilings', () => {
    expect(() => rappCanonicalJson({ number: 0.1 })).toThrow(/exact-integer profile/);

    let accepted: JsonValue = 0;
    for (let index = 0; index < 63; index += 1) accepted = [accepted];
    expect(() => rappCanonicalJson(accepted)).not.toThrow();

    let refused: JsonValue = accepted;
    refused = [refused];
    expect(() => rappCanonicalJson(refused)).toThrow(/depth 64/);
    expect(() => rappCanonicalJson('x'.repeat(RAPP_MAX_CANONICAL_BYTES + 1)))
      .toThrow(/exceeds 1 MiB/);
    expect(() => buildRappFrame({
      kind: 'body.pulse',
      streamId: authority.frame.stream_id,
      utc: authority.frame.utc,
      payload: { data: 'x'.repeat(RAPP_MAX_CANONICAL_BYTES) },
      head: null,
    }, RAPP_REV14_BODY_PULSE_PROFILE)).toThrow(RappFrameError);
  });

  it('accepts only exact, calendar-valid millisecond UTC', () => {
    expect(isRappFrameUtc('2028-02-29T23:59:59.999Z')).toBe(true);
    for (const invalid of [
      '0000-01-01T00:00:00.000Z',
      '2027-02-29T00:00:00.000Z',
      '2026-04-31T00:00:00.000Z',
      '2026-01-01T24:00:00.000Z',
      '2026-01-01T23:59:60.000Z',
      '2026-01-01T00:00:00Z',
      '2026-01-01T00:00:00.000+00:00',
    ]) {
      expect(isRappFrameUtc(invalid), invalid).toBe(false);
    }
  });
});

describe('chain ambiguity refusal', () => {
  const streamId = `rappid:@example/evidence:${'c'.repeat(64)}`;
  const genesis = buildRappFrame({
    kind: 'body.pulse',
    streamId,
    utc: '2026-08-30T20:00:00.000Z',
    payload: { event: 'genesis' },
    head: null,
  }, RAPP_REV14_BODY_PULSE_PROFILE);
  const firstChild = buildRappFrame({
    kind: 'body.pulse',
    streamId,
    utc: '2026-08-30T20:00:01.000Z',
    payload: { event: 'first' },
    head: genesis,
  }, RAPP_REV14_BODY_PULSE_PROFILE);
  const forkChild = buildRappFrame({
    kind: 'body.pulse',
    streamId,
    utc: '2026-08-30T20:00:02.000Z',
    payload: { event: 'fork' },
    head: genesis,
  }, RAPP_REV14_BODY_PULSE_PROFILE);
  const replayedPayload = buildRappFrame({
    kind: 'body.pulse',
    streamId,
    utc: '2026-08-30T20:00:03.000Z',
    payload: genesis.payload,
    head: genesis,
  }, RAPP_REV14_BODY_PULSE_PROFILE);

  it('refuses duplicate frames instead of treating replay as append', () => {
    expect(verifyRappFrameChain(
      [genesis, firstChild, firstChild],
      RAPP_REV14_BODY_PULSE_PROFILE,
      streamId,
    )).toMatchObject({
      ok: false,
      error: { code: 'duplicate-seq', frameIndex: 2 },
    });
  });

  it('refuses both-children ambiguity as a fork', () => {
    expect(verifyRappFrameChain(
      [genesis, firstChild, forkChild],
      RAPP_REV14_BODY_PULSE_PROFILE,
      streamId,
    )).toMatchObject({
      ok: false,
      error: { code: 'fork', frameIndex: 2 },
    });
  });

  it('refuses replaying an already-addressed evidence payload as a new event', () => {
    expect(verifyRappFrameChain(
      [genesis, replayedPayload],
      RAPP_REV14_BODY_PULSE_PROFILE,
      streamId,
    )).toMatchObject({
      ok: false,
      error: { code: 'duplicate-payload-hash', frameIndex: 1 },
    });
  });
});

describe('body.dimension compatibility', () => {
  it('retains the existing builder, exact envelope, and profile verification', () => {
    const rappid = `rappid:@example/organism:${'d'.repeat(64)}`;
    const frame = buildDimensionFrame({
      rappid,
      seq: 0,
      utc: '2026-08-30T21:00:00.000Z',
      prev: null,
      dimension: 'memory',
      version: 1,
      stage: { name: 'baby', ordinal: 0 },
      traits: { evidence_bound: 1000 },
      media: {},
    });

    expect(frame.kind).toBe('body.dimension');
    expect(Object.keys(bodyFrameToJson(frame))).toHaveLength(11);
    expect(bodyFrameProblems(frame, null, rappid)).toEqual([]);
    expect(frame.payload_hash).toBe(
      rappH(RAPP_PARTICLE_DOMAIN, frame.payload),
    );
    expect(frame.frame_hash).toBe(rappFrameDigest(frame));
    expect(frame.prev_wave).toBeNull();
    expect(frame.sig).toBeNull();
  });

  it('continues to report body.dimension payload-profile failures', () => {
    const rappid = `rappid:@example/organism:${'e'.repeat(64)}`;
    const frame = buildDimensionFrame({
      rappid,
      seq: 0,
      utc: '2026-08-30T21:00:00.000Z',
      prev: null,
      dimension: 'memory',
      version: 1,
      stage: { name: 'baby', ordinal: 0 },
      traits: {},
      media: {},
    });
    const malformed = clone(frame) as BodyFrame;
    delete (malformed.payload as Partial<BodyFrame['payload']>).sources;
    malformed.payload_hash = rappH(RAPP_PARTICLE_DOMAIN, malformed.payload);
    malformed.frame_hash = rappFrameDigest(malformed);

    expect(bodyFrameProblems(malformed, null, rappid))
      .toContain('body.dimension payload does not have its exact key set');
  });
});
