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
  LEGACY_BODY_DIMENSION_PROFILE,
  bodyFrameProblems,
  bodyFrameToJson,
  buildLegacyDimensionFrame,
  verifyLegacyBodyDimensionFrame,
} from '../rappids/store.js';
import type { BodyFrame, JsonObject, JsonValue } from '../rappids/types.js';
import {
  ACCEPTED_RAPP_PROTOCOL_AUTHORITY,
  RAPP_ACCEPTED_BODY_PULSE_PROFILE,
  RAPP_FRAME_KEYS,
  RAPP_UINT53_MAX,
  RappFrameError,
  buildRappFrame,
  createRappFrameProfile,
  hashLegacyRappBodyFrame,
  isRappFrameUtc,
  rappFrameDigest,
  rappFrameToJson,
  rappFrameWavePreimage,
  selectRappChainTrustPolicy,
  verifyRappFrame,
  verifyRappFrameChain,
  verifyRappFrameJson,
  type RappFrame,
  type RappFrameHead,
} from './index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const AUTHORITY_FIXTURE_PATH = resolve(HERE, '__fixtures__/rev13-authority.json');
const NUMBER_FIXTURE_PATH = resolve(HERE, '__fixtures__/rfc8785-number-vectors.json');

interface AuthorityFixture {
  authority: {
    repository: string;
    checkpoint_commit: string;
    revision: string;
    status: string;
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

interface NumberFixture {
  accepted: Array<{ token: string; canonical: string }>;
  rejected: string[];
}

const authority = parseRappJson(
  readFileSync(AUTHORITY_FIXTURE_PATH, 'utf8'),
) as unknown as AuthorityFixture;
const numberVectors = parseRappJson(
  readFileSync(NUMBER_FIXTURE_PATH, 'utf8'),
) as unknown as NumberFixture;

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function rewave<TPayload extends JsonObject, TKind extends string>(
  frame: RappFrame<TPayload, TKind>,
): RappFrame<TPayload, TKind> {
  return { ...frame, frame_hash: rappFrameDigest(frame) };
}

describe('accepted rev-13 authority', () => {
  it('pins the verified accepted checkpoint, not a rev-14 draft', () => {
    expect(authority.authority).toEqual({
      repository: 'https://github.com/kody-w/rapp-1',
      checkpoint_commit: '85b0b04cc0d39702278e7ee2a8ada3467ca9a045',
      revision: 'rev-13',
      status: 'accepted',
    });
    expect(ACCEPTED_RAPP_PROTOCOL_AUTHORITY).toMatchObject({
      status: 'accepted',
      revision: 'rev-13',
      frameHash: 'bbcee75ebbbf82d11d8ffd666fdda34c8233642de6d6e4f45910d43a24a001e3',
      payloadHash: '78a89c06509b5100494b9c7e0f551acdc6209fd90aded734321f3580b0f07051',
      checkpointCommit: authority.authority.checkpoint_commit,
    });
    expect(Object.isFrozen(ACCEPTED_RAPP_PROTOCOL_AUTHORITY)).toBe(true);
    expect(ACCEPTED_RAPP_PROTOCOL_AUTHORITY.identity()).toEqual({
      revision: 'rev-13',
      frame_hash: authority.expected.frame_hash,
      payload_hash: authority.expected.payload_hash,
    });
  });

  it('derives the registered kind/family map from the accepted checkpoint', () => {
    const payload = authority.frame.payload as Record<string, unknown>;
    const families = payload.kind_families as Record<
      string,
      { kinds: string[] }
    >;
    const expected = Object.fromEntries(
      Object.entries(families).flatMap(([family, value]) =>
        value.kinds.map((kind) => [kind, family]),
      ),
    );
    expect(ACCEPTED_RAPP_PROTOCOL_AUTHORITY.kindFamilies).toEqual(expected);
    expect(ACCEPTED_RAPP_PROTOCOL_AUTHORITY.registeredKinds())
      .toEqual(payload.registered_kinds);
    expect(ACCEPTED_RAPP_PROTOCOL_AUTHORITY.registeredKinds())
      .not.toContain('body.dimension');
  });

  it('verifies the real rev-13 head, canonical bytes, and exact envelope', () => {
    expect(Object.keys(authority.frame).sort()).toEqual(authority.expected.frame_keys);
    expect(Object.keys(authority.frame)).toHaveLength(11);
    expect([...RAPP_FRAME_KEYS].sort()).toEqual(authority.expected.frame_keys);
    const wave = rappFrameWavePreimage(authority.frame);
    expect(Object.keys(wave)).toHaveLength(9);
    expect(wave).not.toHaveProperty('frame_hash');
    expect(wave).not.toHaveProperty('sig');

    const canonicalFrame = rappCanonicalJson(rappFrameToJson(authority.frame));
    const canonicalPayload = rappCanonicalJson(authority.frame.payload);
    const canonicalWave = rappCanonicalJson(wave);
    expect(Buffer.byteLength(canonicalFrame)).toBe(authority.expected.frame_canonical_bytes);
    expect(sha256(canonicalFrame)).toBe(authority.expected.frame_canonical_sha256);
    expect(Buffer.byteLength(canonicalPayload)).toBe(authority.expected.payload_canonical_bytes);
    expect(sha256(canonicalPayload)).toBe(authority.expected.payload_canonical_sha256);
    expect(Buffer.byteLength(canonicalWave)).toBe(authority.expected.wave_canonical_bytes);
    expect(sha256(canonicalWave)).toBe(authority.expected.wave_canonical_sha256);
    expect(rappH(RAPP_PARTICLE_DOMAIN, authority.frame.payload))
      .toBe(authority.expected.payload_hash);
    expect(rappFrameDigest(authority.frame)).toBe(authority.expected.frame_hash);

    expect(verifyRappFrame(
      authority.frame,
      RAPP_ACCEPTED_BODY_PULSE_PROFILE,
      {
        head: authority.predecessor,
        streamIdOfRecord: authority.frame.stream_id,
      },
    )).toMatchObject({
      ok: true,
      trust: {
        classification: 'integrity-only',
        promotionGrade: false,
        authority: { revision: 'rev-13' },
      },
    });
  });

  it('rebuilds the accepted checkpoint byte-for-byte', () => {
    const rebuilt = buildRappFrame({
      kind: 'body.pulse',
      streamId: authority.frame.stream_id,
      utc: authority.frame.utc,
      payload: authority.frame.payload,
      head: authority.predecessor,
    }, RAPP_ACCEPTED_BODY_PULSE_PROFILE);
    expect(rebuilt).toEqual(authority.frame);
  });
});

describe('RFC 8785 binary64 canonicalization', () => {
  it('matches the committed accepted number vectors', () => {
    for (const vector of numberVectors.accepted) {
      const value = parseRappJson(vector.token);
      expect(rappCanonicalJson(value), vector.token).toBe(vector.canonical);
    }
  });

  it('accepts fractions, exponent spellings, negative zero, and exact large binary64 integers', () => {
    expect(rappCanonicalJson(0.1)).toBe('0.1');
    expect(rappCanonicalJson(1.5)).toBe('1.5');
    expect(rappCanonicalJson(parseRappJson('1e0'))).toBe('1');
    expect(rappCanonicalJson(-0)).toBe('0');
    expect(Number.isSafeInteger(9007199254740992)).toBe(false);
    expect(rappCanonicalJson(9007199254740992)).toBe('9007199254740992');
  });

  it('refuses decimal tokens that change mathematical value through binary64', () => {
    for (const token of numberVectors.rejected) {
      expect(() => parseRappJson(token), token).toThrow(
        /finite binary64|binary64 round-trip/,
      );
    }
    expect(() => rappCanonicalJson(Number.NaN)).toThrow(/finite binary64/);
    expect(() => rappCanonicalJson(Number.POSITIVE_INFINITY)).toThrow(/finite binary64/);
  });

  it('keeps uint53 as a frame-sequence rule only', () => {
    const frame = clone(authority.frame);
    frame.seq = RAPP_UINT53_MAX + 1;
    expect(verifyRappFrame(
      frame,
      RAPP_ACCEPTED_BODY_PULSE_PROFILE,
      {
        head: authority.predecessor,
        streamIdOfRecord: authority.frame.stream_id,
      },
    )).toMatchObject({ ok: false, error: { step: '1', code: 'seq' } });
  });
});

describe('registry-bound kind and family validation', () => {
  it('does not let a caller register body.dimension through a profile', () => {
    expect(() => createRappFrameProfile({
      name: 'forged',
      kind: 'body.dimension',
    })).toThrow(/not registered by accepted authority rev-13/);
  });

  it('does not accept a caller-constructed arbitrary allowlist profile', () => {
    const forged = {
      name: 'forged',
      kind: 'body.pulse',
      family: 'body',
      authority: ACCEPTED_RAPP_PROTOCOL_AUTHORITY,
      mode: 'authority',
      signature: 'unsigned-local',
      uniquePayloads: false,
    };
    expect(verifyRappFrame(
      authority.frame,
      forged as never,
      {
        head: authority.predecessor,
        streamIdOfRecord: authority.frame.stream_id,
      },
    )).toMatchObject({ ok: false, error: { code: 'profile' } });
  });

  it('refuses a registered memory kind carried on a body stream', () => {
    const profile = createRappFrameProfile<JsonObject, 'memory.chat-turn'>({
      name: 'memory-turn',
      kind: 'memory.chat-turn',
    });
    const frame = hashLegacyRappBodyFrame({
      kind: 'memory.chat-turn',
      streamId: authority.frame.stream_id,
      seq: 0,
      utc: '2026-08-30T20:00:00.000Z',
      payload: { message: 'wrong family' },
      prev: null,
    });
    expect(verifyRappFrame(frame, profile, {
      head: null,
      streamIdOfRecord: authority.frame.stream_id,
    })).toMatchObject({
      ok: false,
      error: { step: '1', code: 'kind-family' },
    });
  });
});

describe('ordered intrinsic verification', () => {
  const verify = (frame: unknown) => verifyRappFrame(
    frame,
    RAPP_ACCEPTED_BODY_PULSE_PROFILE,
    {
      head: authority.predecessor,
      streamIdOfRecord: authority.frame.stream_id,
    },
  );

  it.each([
    ['extra key', (frame: Record<string, unknown>) => { frame.extra = null; }, '1', 'key-set'],
    ['missing key', (frame: Record<string, unknown>) => { delete frame.prev_wave; }, '1', 'key-set'],
    ['kind', (frame: Record<string, unknown>) => { frame.kind = 'memory.chat-turn'; }, '1', 'kind-family'],
    ['invalid utc', (frame: Record<string, unknown>) => { frame.utc = '2026-02-30T00:00:00.000Z'; }, '1', 'utc'],
    ['payload', (frame: Record<string, unknown>) => {
      (frame.payload as Record<string, unknown>).revision = 'tampered';
    }, '2', 'payload-hash'],
    ['frame hash', (frame: Record<string, unknown>) => { frame.frame_hash = '0'.repeat(64); }, '3', 'frame-hash'],
    ['sig', (frame: Record<string, unknown>) => { frame.sig = 'unsigned-profile-bypass'; }, '6', 'signature-profile'],
  ])('rejects %s tamper at step %s', (_label, mutate, step, code) => {
    const frame = clone(authority.frame) as unknown as Record<string, unknown>;
    mutate(frame);
    expect(verify(frame)).toMatchObject({ ok: false, error: { step, code } });
  });

  it('checks stream binding before the stale wave hash', () => {
    const frame = clone(authority.frame);
    frame.stream_id = `rappid:@kody-w/another:${'b'.repeat(64)}`;
    expect(verify(frame)).toMatchObject({
      ok: false,
      error: { step: '1a', code: 'stream-binding' },
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
      frame.utc = '2026-01-01T00:00:00.000Z';
    }, 'time-regression'],
  ])('rejects a hash-valid %s reparenting attempt', (_label, mutate, code) => {
    const frame = clone(authority.frame);
    mutate(frame);
    expect(verify(rewave(frame))).toMatchObject({
      ok: false,
      error: { step: '4', code },
    });
  });

  it('refuses duplicate wire members before JSON.parse erases them', () => {
    const wire = JSON.stringify(authority.frame).replace(
      '{"spec":"rapp/1",',
      '{"spec":"rapp/1","spec":"rapp/1",',
    );
    expect(verifyRappFrameJson(
      wire,
      RAPP_ACCEPTED_BODY_PULSE_PROFILE,
      {
        head: authority.predecessor,
        streamIdOfRecord: authority.frame.stream_id,
      },
    )).toMatchObject({ ok: false, error: { step: '1', code: 'canonical' } });
  });
});

describe('trusted chain policy and duplicate ordering', () => {
  const streamId = `rappid:@example/evidence:${'c'.repeat(64)}`;
  const genesis = buildRappFrame({
    kind: 'body.pulse',
    streamId,
    utc: '2026-08-30T20:00:00.000Z',
    payload: { event: 'genesis' },
    head: null,
  }, RAPP_ACCEPTED_BODY_PULSE_PROFILE);
  const child = buildRappFrame({
    kind: 'body.pulse',
    streamId,
    utc: '2026-08-30T20:00:01.000Z',
    payload: { event: 'child' },
    head: genesis,
  }, RAPP_ACCEPTED_BODY_PULSE_PROFILE);
  const alternateChild = buildRappFrame({
    kind: 'body.pulse',
    streamId,
    utc: '2026-08-30T20:00:02.000Z',
    payload: { event: 'alternate' },
    head: genesis,
  }, RAPP_ACCEPTED_BODY_PULSE_PROFILE);
  const replacementGenesis = buildRappFrame({
    kind: 'body.pulse',
    streamId,
    utc: '2026-08-30T20:00:03.000Z',
    payload: { event: 'replacement-genesis' },
    head: null,
  }, RAPP_ACCEPTED_BODY_PULSE_PROFILE);
  const policy = selectRappChainTrustPolicy({
    trustedGenesis: {
      streamId,
      frameHash: genesis.frame_hash,
      payloadHash: genesis.payload_hash,
    },
  });

  it('requires and reports a selected trusted genesis with non-promotion trust', () => {
    expect(verifyRappFrameChain(
      [genesis, child],
      RAPP_ACCEPTED_BODY_PULSE_PROFILE,
      policy,
    )).toMatchObject({
      ok: true,
      head: child,
      trust: {
        classification: 'integrity-only',
        promotionGrade: false,
        genesis: 'trusted',
        persistedHead: 'untracked',
      },
    });
    expect(Object.isFrozen(policy)).toBe(true);
  });

  it('refuses an unselected caller-authored trust object', () => {
    expect(verifyRappFrameChain(
      [genesis],
      RAPP_ACCEPTED_BODY_PULSE_PROFILE,
      {
        authority: ACCEPTED_RAPP_PROTOCOL_AUTHORITY,
        trustedGenesis: policy.trustedGenesis,
        persistedHead: null,
      } as never,
    )).toMatchObject({
      ok: false,
      error: { code: 'authority-policy', step: '1' },
    });
  });

  it('refuses a replacement genesis unless policy selects it', () => {
    expect(verifyRappFrameChain(
      [replacementGenesis],
      RAPP_ACCEPTED_BODY_PULSE_PROFILE,
      policy,
    )).toMatchObject({ ok: false, error: { code: 'untrusted-genesis' } });
    const replacementPolicy = selectRappChainTrustPolicy({
      trustedGenesis: {
        streamId,
        frameHash: replacementGenesis.frame_hash,
        payloadHash: replacementGenesis.payload_hash,
      },
    });
    expect(verifyRappFrameChain(
      [replacementGenesis],
      RAPP_ACCEPTED_BODY_PULSE_PROFILE,
      replacementPolicy,
    )).toMatchObject({ ok: true, trust: { genesis: 'trusted' } });
  });

  it('refuses an in-chain unauthorized re-genesis', () => {
    expect(verifyRappFrameChain(
      [genesis, replacementGenesis],
      RAPP_ACCEPTED_BODY_PULSE_PROFILE,
      policy,
    )).toMatchObject({
      ok: false,
      error: { code: 'unauthorized-re-genesis', frameIndex: 1 },
    });
  });

  it('refuses rollback below a persisted highest head', () => {
    const persisted = selectRappChainTrustPolicy({
      trustedGenesis: policy.trustedGenesis,
      persistedHead: {
        streamId,
        seq: child.seq,
        frameHash: child.frame_hash,
      },
    });
    expect(verifyRappFrameChain(
      [genesis],
      RAPP_ACCEPTED_BODY_PULSE_PROFILE,
      persisted,
    )).toMatchObject({ ok: false, error: { code: 'rollback' } });
  });

  it('refuses a conflicting frame at the persisted head sequence', () => {
    const persisted = selectRappChainTrustPolicy({
      trustedGenesis: policy.trustedGenesis,
      persistedHead: {
        streamId,
        seq: child.seq,
        frameHash: child.frame_hash,
      },
    });
    expect(verifyRappFrameChain(
      [genesis, alternateChild],
      RAPP_ACCEPTED_BODY_PULSE_PROFILE,
      persisted,
    )).toMatchObject({ ok: false, error: { code: 'known-head-conflict' } });
    expect(verifyRappFrameChain(
      [genesis, child],
      RAPP_ACCEPTED_BODY_PULSE_PROFILE,
      persisted,
    )).toMatchObject({
      ok: true,
      trust: { persistedHead: 'matched', promotionGrade: false },
    });
  });

  it('accepts deterministic advancement above a matching persisted head', () => {
    const persistedGenesis = selectRappChainTrustPolicy({
      trustedGenesis: policy.trustedGenesis,
      persistedHead: {
        streamId,
        seq: genesis.seq,
        frameHash: genesis.frame_hash,
      },
    });
    expect(verifyRappFrameChain(
      [genesis, child],
      RAPP_ACCEPTED_BODY_PULSE_PROFILE,
      persistedGenesis,
    )).toMatchObject({
      ok: true,
      trust: { persistedHead: 'advanced', promotionGrade: false },
    });
  });

  it('reports an intrinsic step-3 error before duplicate/fork indexing', () => {
    const corruptDuplicate = {
      ...child,
      frame_hash: '0'.repeat(64),
    };
    expect(verifyRappFrameChain(
      [genesis, corruptDuplicate],
      RAPP_ACCEPTED_BODY_PULSE_PROFILE,
      policy,
    )).toMatchObject({
      ok: false,
      error: { step: '3', code: 'frame-hash', frameIndex: 1 },
    });
  });

  it('calls only two distinct valid children a fork', () => {
    expect(verifyRappFrameChain(
      [genesis, child, alternateChild],
      RAPP_ACCEPTED_BODY_PULSE_PROFILE,
      policy,
    )).toMatchObject({ ok: false, error: { code: 'fork', frameIndex: 2 } });
    expect(verifyRappFrameChain(
      [genesis, child, child],
      RAPP_ACCEPTED_BODY_PULSE_PROFILE,
      policy,
    )).toMatchObject({
      ok: false,
      error: { code: 'duplicate-seq', frameIndex: 2 },
    });
  });

  it('does not misclassify a hash-valid wrong-sequence child as a fork', () => {
    const wrongParent = hashLegacyRappBodyFrame({
      kind: 'body.pulse',
      streamId,
      seq: 2,
      utc: '2026-08-30T20:00:03.000Z',
      payload: { event: 'wrong-parent' },
      prev: genesis.payload_hash,
    });
    expect(verifyRappFrameChain(
      [genesis, child, wrongParent],
      RAPP_ACCEPTED_BODY_PULSE_PROFILE,
      policy,
    )).toMatchObject({
      ok: false,
      error: { code: 'prev-continuity', step: '4', frameIndex: 2 },
    });
  });
});

describe('canonical and time bounds', () => {
  it('uses UTF-16 key ordering and rejects unpaired surrogates', () => {
    const supplementary = '\u{10000}';
    const bmpPrivateUse = '\ue000';
    expect(rappCanonicalJson({
      [bmpPrivateUse]: 1,
      [supplementary]: 2,
    })).toBe(`{"${supplementary}":2,"${bmpPrivateUse}":1}`);
    expect(() => rappCanonicalJson('\ud800')).toThrow(/unpaired surrogate/);
    expect(() => rappCanonicalJson({ ['\udc00']: 1 })).toThrow(/unpaired surrogate/);
  });

  it('enforces duplicate, depth, and 1 MiB bounds', () => {
    expect(() => parseRappJson('{"a":1,"a":2}')).toThrow(/duplicate JSON member/);
    let accepted: JsonValue = 0;
    for (let index = 0; index < 63; index += 1) accepted = [accepted];
    expect(() => rappCanonicalJson(accepted)).not.toThrow();
    expect(() => rappCanonicalJson([accepted])).toThrow(/depth 64/);
    expect(() => rappCanonicalJson('x'.repeat(RAPP_MAX_CANONICAL_BYTES + 1)))
      .toThrow(/exceeds 1 MiB/);
  });

  it('accepts only exact calendar-valid millisecond UTC', () => {
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

describe('body.dimension compatibility policy', () => {
  const rappid = `rappid:@example/organism:${'d'.repeat(64)}`;
  const frame = buildLegacyDimensionFrame({
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

  it('reads historical body.dimension only as explicit legacy integrity', () => {
    expect(frame.kind).toBe('body.dimension');
    expect(Object.keys(bodyFrameToJson(frame))).toHaveLength(11);
    expect(bodyFrameProblems(frame, null, rappid)).toEqual([]);
    expect(verifyLegacyBodyDimensionFrame(frame, null, rappid)).toMatchObject({
      ok: true,
      trust: {
        classification: 'legacy-integrity-only',
        promotionGrade: false,
        authority: null,
      },
    });
  });

  it('does not allow the legacy profile to emit a currently conforming frame', () => {
    expect(() => buildRappFrame({
      kind: 'body.dimension',
      streamId: rappid,
      utc: frame.utc,
      payload: frame.payload,
      head: null,
    }, LEGACY_BODY_DIMENSION_PROFILE)).toThrow(RappFrameError);
  });

  it('continues to report historical payload integrity failures', () => {
    const malformed = clone(frame) as BodyFrame;
    delete (malformed.payload as Partial<BodyFrame['payload']>).sources;
    malformed.payload_hash = rappH(RAPP_PARTICLE_DOMAIN, malformed.payload);
    malformed.frame_hash = rappFrameDigest(malformed);
    expect(bodyFrameProblems(malformed, null, rappid))
      .toContain('body.dimension payload does not have its exact key set');
  });
});
