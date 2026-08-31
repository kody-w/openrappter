import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

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
  ProtocolAuthority,
  RAPP_ACCEPTED_BODY_PULSE_PROFILE,
  RAPP_FRAME_KEYS,
  RAPP_UINT53_MAX,
  RappFrameError,
  buildOpenRappterEvidencePayload,
  buildRappFrame,
  createRappFrameProfile,
  hashLegacyRappBodyFrame,
  isRappFrameUtc,
  isSelectedProtocolAuthority,
  protocolAuthorityDetails,
  protocolAuthorityFamilyForKind,
  rappFrameDigest,
  rappFrameToJson,
  rappFrameWavePreimage,
  resolveProtocolAuthority,
  selectRappChainTrustPolicy,
  verifyRappFrame,
  verifyRappFrameChain,
  verifyRappFrameJson,
  type RappFrame,
  type RappFrameHead,
} from './index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const AUTHORITY_FIXTURE_PATH = resolve(HERE, '__fixtures__/rev14-authority.json');
const REV13_FIXTURE_PATH = resolve(HERE, '__fixtures__/rev13-authority.json');
const NUMBER_FIXTURE_PATH = resolve(HERE, '__fixtures__/rfc8785-number-vectors.json');

interface AuthorityFixture {
  authority: {
    repository: string;
    checkpoint_commit: string;
    revision: string;
    status: string;
    normative_sha256?: string;
    bootstrap_profile_sha256?: string;
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
const historicalRev13 = parseRappJson(
  readFileSync(REV13_FIXTURE_PATH, 'utf8'),
) as unknown as AuthorityFixture;
const numberVectors = parseRappJson(
  readFileSync(NUMBER_FIXTURE_PATH, 'utf8'),
) as unknown as NumberFixture;

const POLLUTION_KEYS = [
  'body.dimension',
  'rev-forged',
  'authority',
  'trustedGenesis',
  'frameHash',
  'payloadHash',
  'name',
  'kind',
  'eventKind',
  'subject',
  'dataHash',
  '__proto__',
  'constructor',
] as const;
const ORIGINAL_PROTOTYPE_DESCRIPTORS = new Map(
  POLLUTION_KEYS.map((key) => [key, Object.getOwnPropertyDescriptor(Object.prototype, key)]),
);

function restoreObjectPrototype(): void {
  for (const key of POLLUTION_KEYS) {
    const descriptor = ORIGINAL_PROTOTYPE_DESCRIPTORS.get(key);
    if (descriptor === undefined) delete (Object.prototype as Record<string, unknown>)[key];
    else Object.defineProperty(Object.prototype, key, descriptor);
  }
}

function polluteObjectPrototype(key: string, value: unknown): void {
  Object.defineProperty(Object.prototype, key, {
    value,
    configurable: true,
    enumerable: true,
    writable: true,
  });
}

afterEach(() => restoreObjectPrototype());

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function captureError(action: () => unknown): Error | null {
  try {
    action();
    return null;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

function rewave<TPayload extends JsonObject, TKind extends string>(
  frame: RappFrame<TPayload, TKind>,
): RappFrame<TPayload, TKind> {
  return { ...frame, frame_hash: rappFrameDigest(frame) };
}

describe('accepted rev-14 authority', () => {
  it('pins the owner-ratified protected-main checkpoint', () => {
    expect(authority.authority).toEqual({
      repository: 'https://github.com/kody-w/rapp-1',
      checkpoint_commit: 'caf6ef276cafa92aa744499af90dc1a28559941a',
      revision: 'rev-14',
      status: 'accepted',
      normative_sha256: 'd345235be5bc698d78c5893285abd09f2e62a398f781123d1de8da313a01c7de',
      bootstrap_profile_sha256: '1666e44acf532f854d4bf74868c9af9f9b362055692189ac858a7c8b52dcd5bb',
    });
    expect(ACCEPTED_RAPP_PROTOCOL_AUTHORITY).toMatchObject({
      status: 'accepted',
      revision: 'rev-14',
      frameHash: '59629adab4e26d156f3d66ecfb766e08705919ea1d2adc92ba0ad2b17337dfc2',
      payloadHash: 'c7549bbd3e133b833930e24e008817ea295734b870f41706455d3f45821aba3a',
      checkpointCommit: authority.authority.checkpoint_commit,
      normativeSha256: authority.authority.normative_sha256,
      bootstrapProfileSha256: authority.authority.bootstrap_profile_sha256,
    });
    expect(Object.isFrozen(ACCEPTED_RAPP_PROTOCOL_AUTHORITY)).toBe(true);
    expect(Object.getPrototypeOf(ACCEPTED_RAPP_PROTOCOL_AUTHORITY.kindFamilies))
      .toBeNull();
    expect(ACCEPTED_RAPP_PROTOCOL_AUTHORITY.identity()).toEqual({
      revision: 'rev-14',
      frame_hash: authority.expected.frame_hash,
      payload_hash: authority.expected.payload_hash,
    });
  });

  it('preserves accepted rev-13 historical resolution', () => {
    const resolved = resolveProtocolAuthority('rev-13');
    expect(resolved).toBe(ProtocolAuthority.acceptedRev13);
    expect(resolved).toMatchObject({
      revision: historicalRev13.authority.revision,
      frameHash: historicalRev13.expected.frame_hash,
      payloadHash: historicalRev13.expected.payload_hash,
      checkpointCommit: historicalRev13.authority.checkpoint_commit,
      bootstrapProfileSha256: null,
    });
    expect(resolveProtocolAuthority('rev-14'))
      .toBe(ACCEPTED_RAPP_PROTOCOL_AUTHORITY);
    expect(resolveProtocolAuthority('rev-999')).toBeNull();
    if (resolved === null) throw new Error('rev-13 authority did not resolve');
    const historicalProfile = createRappFrameProfile<JsonObject, 'body.pulse'>({
      name: 'historical-rev-13',
      kind: 'body.pulse',
      authority: resolved,
    });
    expect(verifyRappFrame(
      historicalRev13.frame,
      historicalProfile,
      {
        head: historicalRev13.predecessor,
        streamIdOfRecord: historicalRev13.frame.stream_id,
      },
    )).toMatchObject({
      ok: true,
      trust: { authority: { revision: 'rev-13' } },
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

  it('verifies the real ratified rev-14 head, canonical bytes, and exact envelope', () => {
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
        authority: { revision: 'rev-14' },
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

  it('normalizes a 1 MiB-bounded compensated exponent in linear time', () => {
    const zeroCount = 1_000_000;
    const token = `0.${'0'.repeat(zeroCount)}1e${zeroCount + 1}`;
    expect(Buffer.byteLength(token)).toBeLessThan(RAPP_MAX_CANONICAL_BYTES);
    const started = performance.now();
    const value = parseRappJson(token);
    const elapsed = performance.now() - started;
    expect(value).toBe(1);
    expect(rappCanonicalJson(value)).toBe('1');
    expect(elapsed).toBeLessThan(3_000);
  }, 10_000);
});

describe('registry-bound kind and family validation', () => {
  it('ignores Object.prototype pollution across authority, genesis, and option maps', () => {
    let family: string | null = null;
    let protoFamily: string | null = null;
    let constructorFamily: string | null = null;
    let resolved: ProtocolAuthority | null = null;
    let constructorAuthority: ProtocolAuthority | null = null;
    let profileError: Error | null = null;
    let inheritedProfileError: Error | null = null;
    let trustError: Error | null = null;
    let evidenceInputError: Error | null = null;
    let protoKeyError: Error | null = null;
    let constructorKeyError: Error | null = null;
    try {
      polluteObjectPrototype('body.dimension', 'body');
      polluteObjectPrototype('rev-forged', ACCEPTED_RAPP_PROTOCOL_AUTHORITY);
      polluteObjectPrototype('authority', ACCEPTED_RAPP_PROTOCOL_AUTHORITY);
      polluteObjectPrototype('trustedGenesis', {
        streamId: authority.frame.stream_id,
        frameHash: authority.frame.frame_hash,
        payloadHash: authority.frame.payload_hash,
      });
      polluteObjectPrototype('frameHash', authority.frame.frame_hash);
      polluteObjectPrototype('payloadHash', authority.frame.payload_hash);
      polluteObjectPrototype('name', 'inherited-profile');
      polluteObjectPrototype('kind', 'body.pulse');
      polluteObjectPrototype('eventKind', 'install.verified');
      polluteObjectPrototype('subject', 'release:forged');
      polluteObjectPrototype('dataHash', 'f'.repeat(64));
      polluteObjectPrototype('__proto__', { 'body.dimension': 'body' });
      polluteObjectPrototype('constructor', { 'body.dimension': 'body' });

      family = protocolAuthorityFamilyForKind(
        ACCEPTED_RAPP_PROTOCOL_AUTHORITY,
        'body.dimension',
      );
      protoFamily = protocolAuthorityFamilyForKind(
        ACCEPTED_RAPP_PROTOCOL_AUTHORITY,
        '__proto__',
      );
      constructorFamily = protocolAuthorityFamilyForKind(
        ACCEPTED_RAPP_PROTOCOL_AUTHORITY,
        'constructor',
      );
      resolved = resolveProtocolAuthority('rev-forged');
      constructorAuthority = resolveProtocolAuthority('constructor');
      profileError = captureError(() => createRappFrameProfile({
        name: 'polluted-kind',
        kind: 'body.dimension',
      }));
      inheritedProfileError = captureError(() =>
        createRappFrameProfile({} as never),
      );
      trustError = captureError(() =>
        selectRappChainTrustPolicy({} as never),
      );
      evidenceInputError = captureError(() =>
        buildOpenRappterEvidencePayload({} as never),
      );
      const protoOptions = Object.assign(Object.create(null), {
        name: 'proto-own',
        kind: 'body.pulse',
      });
      Object.defineProperty(protoOptions, '__proto__', {
        value: 'polluted',
        configurable: true,
        enumerable: true,
      });
      protoKeyError = captureError(() =>
        createRappFrameProfile(protoOptions),
      );
      const constructorOptions = Object.assign(Object.create(null), {
        name: 'constructor-own',
        kind: 'body.pulse',
        constructor: 'polluted',
      });
      constructorKeyError = captureError(() =>
        createRappFrameProfile(constructorOptions),
      );
    } finally {
      restoreObjectPrototype();
    }

    expect(family).toBeNull();
    expect(protoFamily).toBeNull();
    expect(constructorFamily).toBeNull();
    expect(resolved).toBeNull();
    expect(constructorAuthority).toBeNull();
    expect(profileError?.message).toMatch(/not registered/);
    expect(inheritedProfileError?.message).toMatch(/missing own key/);
    expect(trustError?.message).toMatch(/missing own key/);
    expect(evidenceInputError?.message).toMatch(/missing own key/);
    expect(protoKeyError?.message).toMatch(/unsupported own key __proto__/);
    expect(constructorKeyError?.message).toMatch(/unsupported own key constructor/);
    expect(createRappFrameProfile({
      name: 'genuine-after-cleanup',
      kind: 'body.pulse',
    })).toMatchObject({ family: 'body' });
  });

  it('rejects direct emitted-JavaScript ProtocolAuthority constructor forgery', () => {
    const ForgedConstructor = ProtocolAuthority as unknown as new (
      input: Record<string, unknown>,
    ) => ProtocolAuthority;
    expect(() => new ForgedConstructor({
      revision: 'forged',
      frameHash: 'a'.repeat(64),
      payloadHash: 'b'.repeat(64),
      repository: 'https://example.invalid',
      checkpointCommit: 'c'.repeat(40),
      normativeSha256: 'd'.repeat(64),
      bootstrapProfileSha256: null,
      kindFamilies: { 'body.dimension': 'body' },
    })).toThrow(/module-owned accepted checkpoint/);
  });

  it('rejects prototype forgery that passes instanceof but lacks capability', () => {
    const forged = Object.create(ProtocolAuthority.prototype) as ProtocolAuthority;
    expect(forged).toBeInstanceOf(ProtocolAuthority);
    expect(() => createRappFrameProfile({
      name: 'forged',
      kind: 'body.dimension',
      authority: forged,
    })).toThrow(/selected ProtocolAuthority/);
  });

  it('freezes prototype methods/getters and accepted-object prototype chains', () => {
    expect(Object.isFrozen(ProtocolAuthority.prototype)).toBe(true);
    expect(Object.isFrozen(ProtocolAuthority)).toBe(true);
    expect(() => Object.defineProperty(
      ProtocolAuthority.prototype,
      'familyForKind',
      { value: () => 'body' },
    )).toThrow();
    expect(() => Object.defineProperty(
      ProtocolAuthority.prototype,
      'revision',
      { get: () => 'forged' },
    )).toThrow();
    expect(() => Object.setPrototypeOf(
      ACCEPTED_RAPP_PROTOCOL_AUTHORITY,
      { familyForKind: () => 'body' },
    )).toThrow();
    expect(() => Object.setPrototypeOf(
      ProtocolAuthority.prototype,
      {},
    )).toThrow();

    expect(protocolAuthorityFamilyForKind(
      ACCEPTED_RAPP_PROTOCOL_AUTHORITY,
      'body.pulse',
    )).toBe('body');
    expect(() => createRappFrameProfile({
      name: 'still-forged',
      kind: 'body.dimension',
    })).toThrow(/not registered/);
  });

  it('rejects Proxy wrappers even when they forge methods and getters', () => {
    const proxy = new Proxy(ACCEPTED_RAPP_PROTOCOL_AUTHORITY, {
      get(target, property, receiver) {
        if (property === 'familyForKind') return () => 'body';
        if (property === 'revision') return 'forged';
        if (property === 'kindFamilies') return { 'body.dimension': 'body' };
        return Reflect.get(target, property, receiver);
      },
    });
    expect(isSelectedProtocolAuthority(proxy)).toBe(false);
    expect(() => protocolAuthorityDetails(proxy)).toThrow(/module-owned accepted/);
    expect(() => createRappFrameProfile({
      name: 'proxy-forged',
      kind: 'body.dimension',
      authority: proxy,
    })).toThrow(/selected ProtocolAuthority/);
    expect(() => selectRappChainTrustPolicy({
      authority: proxy,
      trustedGenesis: {
        streamId: authority.frame.stream_id,
        frameHash: authority.frame.frame_hash,
        payloadHash: authority.frame.payload_hash,
      },
    })).toThrow(/selected ProtocolAuthority/);
  });

  it('does not let a caller register body.dimension through a profile', () => {
    expect(() => createRappFrameProfile({
      name: 'forged',
      kind: 'body.dimension',
    })).toThrow(/not registered by accepted authority rev-14/);
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

  it('rejects Proxy wrappers around a genuine selected frame profile', () => {
    const proxy = new Proxy(RAPP_ACCEPTED_BODY_PULSE_PROFILE, {
      get(target, property, receiver) {
        if (property === 'kind') return 'body.dimension';
        if (property === 'family') return 'body';
        return Reflect.get(target, property, receiver);
      },
    });
    expect(verifyRappFrame(
      authority.frame,
      proxy,
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
    expect(Object.getPrototypeOf(policy.trustedGenesis)).toBeNull();
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

  it('rejects Proxy wrappers around a genuine selected trust policy', () => {
    const proxy = new Proxy(policy, {
      get(target, property, receiver) {
        if (property === 'trustedGenesis') {
          return {
            ...target.trustedGenesis,
            frameHash: replacementGenesis.frame_hash,
            payloadHash: replacementGenesis.payload_hash,
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });
    expect(verifyRappFrameChain(
      [replacementGenesis],
      RAPP_ACCEPTED_BODY_PULSE_PROFILE,
      proxy,
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

  it.each([
    ['time regression', (frame: RappFrame<JsonObject, 'body.pulse'>) => rewave({
      ...frame,
      utc: '2026-01-01T00:00:00.000Z',
    }), '4', 'time-regression'],
    ['bad prev_wave', (frame: RappFrame<JsonObject, 'body.pulse'>) => rewave({
      ...frame,
      prev_wave: genesis.frame_hash,
    }), '5', 'prev-wave'],
    ['bad signature', (frame: RappFrame<JsonObject, 'body.pulse'>) => ({
      ...frame,
      sig: 'not-verified',
    }), '6', 'signature-profile'],
  ])('validates a fork candidate %s before indexing it', (_label, mutate, step, code) => {
    const invalidCandidate = mutate(alternateChild);
    expect(verifyRappFrameChain(
      [genesis, child, invalidCandidate],
      RAPP_ACCEPTED_BODY_PULSE_PROFILE,
      policy,
    )).toMatchObject({
      ok: false,
      error: { step, code, frameIndex: 2 },
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
      error: { code: 'seq-continuity', step: '4', frameIndex: 2 },
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
