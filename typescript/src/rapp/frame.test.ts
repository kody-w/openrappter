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
  RAPP_ACCEPTED_BODY_STREAM_PROFILE,
  RAPP_ACCEPTED_MEMORY_STREAM_PROFILE,
  RAPP_FRAME_KEYS,
  RAPP_UINT53_MAX,
  RappFrameError,
  buildOpenRappterEvidencePayload,
  buildRappFrame,
  createRappFrameProfile,
  createRappSwarmStreamProfile,
  hashLegacyRappBodyFrame,
  isRappFrameUtc,
  isSelectedProtocolAuthority,
  protocolAuthorityDetails,
  protocolAuthorityFamilyForKind,
  protocolAuthorityRegisteredKinds,
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
  it('survives post-import collection and iteration intrinsic poisoning', () => {
    const mutations: Array<{
      target: object;
      key: PropertyKey;
      descriptor: PropertyDescriptor | undefined;
    }> = [];
    const poison = (target: object, key: PropertyKey): void => {
      mutations[mutations.length] = {
        target,
        key,
        descriptor: Object.getOwnPropertyDescriptor(target, key),
      };
      Object.defineProperty(target, key, {
        value() {
          throw new Error(`poisoned ${String(key)}`);
        },
        configurable: true,
        writable: true,
      });
    };

    let family: string | null = 'body';
    let resolved: ProtocolAuthority | null = ACCEPTED_RAPP_PROTOCOL_AUTHORITY;
    let profileError: Error | null = null;
    let verified: ReturnType<typeof verifyRappFrame> | null = null;
    let chain: ReturnType<typeof verifyRappFrameChain> | null = null;
    let evidenceRevision: string | null = null;
    let registered: readonly string[] = [];
    try {
      poison(Map.prototype, 'has');
      poison(Map.prototype, 'get');
      poison(Map.prototype, 'keys');
      poison(WeakMap.prototype, 'has');
      poison(WeakMap.prototype, 'get');
      poison(WeakSet.prototype, 'has');
      poison(Object, 'hasOwn');
      poison(Array.prototype, 'map');
      poison(Array.prototype, 'filter');
      poison(Array.prototype, 'some');
      poison(Array.prototype, 'sort');
      poison(Array.prototype, 'join');
      poison(Array.prototype, 'includes');
      poison(Array.prototype, 'find');
      poison(Array.prototype, 'findIndex');
      poison(Array.prototype, 'push');
      poison(Array.prototype, 'splice');
      poison(Array.prototype, 'reverse');
      poison(Array.prototype, Symbol.iterator);

      family = protocolAuthorityFamilyForKind(
        ACCEPTED_RAPP_PROTOCOL_AUTHORITY,
        'body.dimension',
      );
      resolved = resolveProtocolAuthority('constructor');
      registered = protocolAuthorityRegisteredKinds(
        ACCEPTED_RAPP_PROTOCOL_AUTHORITY,
      );
      profileError = captureError(() => createRappFrameProfile({
        name: 'poisoned-forgery',
        kind: 'body.dimension',
      }));
      verified = verifyRappFrame(
        authority.frame,
        RAPP_ACCEPTED_BODY_PULSE_PROFILE,
        {
          head: authority.predecessor,
          streamIdOfRecord: authority.frame.stream_id,
        },
      );
      const streamId = `rappid:@example/intrinsics:${'9'.repeat(64)}`;
      const genesis = buildRappFrame({
        kind: 'body.pulse',
        streamId,
        utc: '2026-08-30T20:00:00.000Z',
        payload: { event: 'intrinsics' },
        head: null,
      }, RAPP_ACCEPTED_BODY_PULSE_PROFILE);
      const policy = selectRappChainTrustPolicy({
        trustedGenesis: {
          streamId,
          frameHash: genesis.frame_hash,
          payloadHash: genesis.payload_hash,
        },
      });
      chain = verifyRappFrameChain(
        [genesis],
        RAPP_ACCEPTED_BODY_STREAM_PROFILE,
        policy,
      );
      evidenceRevision = buildOpenRappterEvidencePayload({
        eventKind: 'install.verified',
        subject: 'release:test',
        dataHash: 'a'.repeat(64),
      }).protocol_revision.revision;
    } finally {
      for (let index = mutations.length - 1; index >= 0; index -= 1) {
        const mutation = mutations[index];
        if (mutation.descriptor === undefined) {
          delete (mutation.target as Record<PropertyKey, unknown>)[mutation.key];
        } else {
          Object.defineProperty(mutation.target, mutation.key, mutation.descriptor);
        }
      }
    }

    expect(family).toBeNull();
    expect(resolved).toBeNull();
    expect(registered).toContain('body.pulse');
    expect(registered).not.toContain('body.dimension');
    expect(profileError?.message).toMatch(/not registered/);
    expect(verified).toMatchObject({ ok: true });
    expect(chain).toMatchObject({ ok: true });
    expect(evidenceRevision).toBe('rev-14');
  });

  it('does not expose private registries to numeric Array prototype setters', () => {
    const indices = ['0', '1', '2', '14', '50', '100'];
    const descriptors = Object.create(null) as Record<string, PropertyDescriptor | undefined>;
    let captured = 0;
    const methodDescriptors = {
      push: Object.getOwnPropertyDescriptor(Array.prototype, 'push'),
      splice: Object.getOwnPropertyDescriptor(Array.prototype, 'splice'),
      iterator: Object.getOwnPropertyDescriptor(Array.prototype, Symbol.iterator),
    };
    let chainResult: ReturnType<typeof verifyRappFrameChain> | null = null;
    let evidenceRevision: string | null = null;
    let unregisteredError: Error | null = null;
    try {
      for (let index = 0; index < indices.length; index += 1) {
        const key = indices[index];
        descriptors[key] = Object.getOwnPropertyDescriptor(Array.prototype, key);
        Object.defineProperty(Array.prototype, key, {
          configurable: true,
          set(_value: unknown) {
            captured += 1;
            Object.defineProperty(this, key, {
              value: { forged: true },
              configurable: true,
              enumerable: true,
              writable: true,
            });
          },
        });
      }
      Object.defineProperty(Array.prototype, 'push', {
        configurable: true,
        value() { throw new Error('poisoned push'); },
      });
      Object.defineProperty(Array.prototype, 'splice', {
        configurable: true,
        value() { throw new Error('poisoned splice'); },
      });
      Object.defineProperty(Array.prototype, Symbol.iterator, {
        configurable: true,
        value() { throw new Error('poisoned iterator'); },
      });

      const profile = createRappFrameProfile<JsonObject, 'body.pulse'>({
        name: 'numeric-setter-safe',
        kind: 'body.pulse',
      });
      const streamId = `rappid:@example/numeric-setter:${'7'.repeat(64)}`;
      const genesis = buildRappFrame({
        kind: 'body.pulse',
        streamId,
        utc: '2026-08-30T20:00:00.000Z',
        payload: { event: 'numeric-setter-safe' },
        head: null,
      }, profile);
      const policy = selectRappChainTrustPolicy({
        trustedGenesis: {
          streamId,
          frameHash: genesis.frame_hash,
          payloadHash: genesis.payload_hash,
        },
      });
      chainResult = verifyRappFrameChain(
        [genesis],
        RAPP_ACCEPTED_BODY_STREAM_PROFILE,
        policy,
      );
      evidenceRevision = buildOpenRappterEvidencePayload({
        eventKind: 'install.verified',
        subject: 'release:numeric-setter',
        dataHash: 'a'.repeat(64),
      }).protocol_revision.revision;
      unregisteredError = captureError(() => createRappFrameProfile({
        name: 'still-unregistered',
        kind: 'body.dimension',
      }));
    } finally {
      const restoreMethod = (
        key: PropertyKey,
        descriptor: PropertyDescriptor | undefined,
      ): void => {
        if (descriptor === undefined) {
          delete (Array.prototype as unknown as Record<PropertyKey, unknown>)[key];
        }
        else Object.defineProperty(Array.prototype, key, descriptor);
      };
      restoreMethod('push', methodDescriptors.push);
      restoreMethod('splice', methodDescriptors.splice);
      restoreMethod(Symbol.iterator, methodDescriptors.iterator);
      for (let index = 0; index < indices.length; index += 1) {
        const key = indices[index];
        const descriptor = descriptors[key];
        if (descriptor === undefined) {
          delete (Array.prototype as unknown as Record<string, unknown>)[key];
        } else {
          Object.defineProperty(Array.prototype, key, descriptor);
        }
      }
    }
    expect(captured).toBe(0);
    expect(chainResult).toMatchObject({ ok: true });
    expect(evidenceRevision).toBe('rev-14');
    expect(unregisteredError?.message).toMatch(/not registered/);
  });

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

describe('registered mixed kinds and re-genesis refusal', () => {
  const bodyStream = `rappid:@example/mixed:${'8'.repeat(64)}`;
  const twinProfile = createRappFrameProfile<JsonObject, 'body.twin-pulse'>({
    name: 'body-twin-pulse',
    kind: 'body.twin-pulse',
  });
  const pulse = buildRappFrame({
    kind: 'body.pulse',
    streamId: bodyStream,
    utc: '2026-08-30T20:00:00.000Z',
    payload: { event: 'pulse' },
    head: null,
  }, RAPP_ACCEPTED_BODY_PULSE_PROFILE);
  const twinPulse = buildRappFrame({
    kind: 'body.twin-pulse',
    streamId: bodyStream,
    utc: '2026-08-30T20:00:01.000Z',
    payload: { event: 'twin-pulse' },
    head: pulse,
  }, twinProfile);
  const policy = selectRappChainTrustPolicy({
    trustedGenesis: {
      streamId: bodyStream,
      frameHash: pulse.frame_hash,
      payloadHash: pulse.payload_hash,
    },
  });

  it('resolves the selected authority profile independently for each frame', () => {
    expect(verifyRappFrameChain(
      [pulse, twinPulse],
      RAPP_ACCEPTED_BODY_STREAM_PROFILE,
      policy,
    )).toMatchObject({
      ok: true,
      head: { kind: 'body.twin-pulse' },
      trust: { genesis: 'trusted', promotionGrade: false },
    });
  });

  it('keeps the evidence/single-kind profile restricted to body.pulse', () => {
    expect(verifyRappFrameChain(
      [pulse, twinPulse],
      RAPP_ACCEPTED_BODY_PULSE_PROFILE,
      policy,
    )).toMatchObject({
      ok: false,
      error: { code: 'profile-kind', step: '1', frameIndex: 1 },
    });
  });

  it('verifies a memory.chat-turn -> memory.save chain by per-frame authority policy', () => {
    const memoryStream = `${bodyStream}:session`;
    const chatTurnProfile = createRappFrameProfile<JsonObject, 'memory.chat-turn'>({
      name: 'memory-chat-turn',
      kind: 'memory.chat-turn',
    });
    const saveProfile = createRappFrameProfile<JsonObject, 'memory.save'>({
      name: 'memory-save',
      kind: 'memory.save',
    });
    const chatTurn = buildRappFrame({
      kind: 'memory.chat-turn',
      streamId: memoryStream,
      utc: '2026-08-30T20:00:00.000Z',
      payload: { message: 'remember this' },
      head: null,
    }, chatTurnProfile);
    const save = buildRappFrame({
      kind: 'memory.save',
      streamId: memoryStream,
      utc: '2026-08-30T20:00:01.000Z',
      payload: { key: 'fact', value: 'remember this' },
      head: chatTurn,
    }, saveProfile);
    const memoryPolicy = selectRappChainTrustPolicy({
      trustedGenesis: {
        streamId: memoryStream,
        frameHash: chatTurn.frame_hash,
        payloadHash: chatTurn.payload_hash,
      },
    });
    expect(verifyRappFrameChain(
      [chatTurn, save],
      RAPP_ACCEPTED_MEMORY_STREAM_PROFILE,
      memoryPolicy,
    )).toMatchObject({
      ok: true,
      head: { kind: 'memory.save' },
    });
  });

  it('requires explicit signature verification for generic swarm streams', () => {
    expect(() => createRappSwarmStreamProfile(undefined as never))
      .toThrow(/signature verifier/);
    const swarmStream = 'net:signed-test';
    const echoUnsigned = hashLegacyRappBodyFrame({
      kind: 'swarm.echo',
      streamId: swarmStream,
      seq: 0,
      utc: '2026-08-30T20:00:00.000Z',
      payload: { message: 'echo' },
      prev: null,
    });
    const echo = { ...echoUnsigned, sig: 'valid-signature' };
    const telemetryDraft = hashLegacyRappBodyFrame({
      kind: 'swarm.telemetry',
      streamId: swarmStream,
      seq: 1,
      utc: '2026-08-30T20:00:01.000Z',
      payload: { status: 'ok' },
      prev: echo.payload_hash,
    });
    const telemetry = rewave({
      ...telemetryDraft,
      prev_wave: echo.frame_hash,
      sig: 'valid-signature',
    });
    const swarmPolicy = selectRappChainTrustPolicy({
      trustedGenesis: {
        streamId: swarmStream,
        frameHash: echo.frame_hash,
        payloadHash: echo.payload_hash,
      },
    });
    const swarmProfile = createRappSwarmStreamProfile(
      (frame) => frame.sig === 'valid-signature',
    );
    expect(verifyRappFrameChain(
      [echo, telemetry],
      swarmProfile,
      swarmPolicy,
    )).toMatchObject({
      ok: true,
      head: { kind: 'swarm.telemetry' },
    });
  });

  it.each([
    ['body.re-genesis', bodyStream],
    ['memory.re-genesis', `${bodyStream}:session`],
    ['swarm.re-genesis', 'net:re-genesis-test'],
  ] as const)('refuses unsigned generic %s build and verification', (kind, streamId) => {
    const profile = createRappFrameProfile<JsonObject, typeof kind>({
      name: kind,
      kind,
    });
    const frame = hashLegacyRappBodyFrame({
      kind,
      streamId,
      seq: 0,
      utc: '2026-08-30T20:00:00.000Z',
      payload: {
        migrated_from: {
          stream_id: bodyStream,
          terminal_hash: 'a'.repeat(64),
        },
      },
      prev: null,
    });
    expect(verifyRappFrame(frame, profile, {
      head: null,
      streamIdOfRecord: streamId,
    })).toMatchObject({
      ok: false,
      error: { code: 're-genesis-profile', step: '6' },
    });
    const reGenesisPolicy = selectRappChainTrustPolicy({
      trustedGenesis: {
        streamId,
        frameHash: frame.frame_hash,
        payloadHash: frame.payload_hash,
      },
    });
    expect(verifyRappFrameChain(
      [frame],
      profile,
      reGenesisPolicy,
    )).toMatchObject({
      ok: false,
      error: { code: 're-genesis-profile', step: '6', frameIndex: 0 },
    });
    expect(() => buildRappFrame({
      kind,
      streamId,
      utc: frame.utc,
      payload: frame.payload,
      head: null,
    }, profile)).toThrow(/generic unsigned builders/);
  });
});

describe('hostile programmatic frame snapshot', () => {
  const verify = (frame: unknown) => verifyRappFrame(
    frame,
    RAPP_ACCEPTED_BODY_PULSE_PROFILE,
    {
      head: authority.predecessor,
      streamIdOfRecord: authority.frame.stream_id,
    },
  );

  it.each([
    ['kind', 'body.pulse', 'body.dimension'],
    ['payload_hash', authority.frame.payload_hash, '0'.repeat(64)],
    ['seq', authority.frame.seq, authority.frame.seq + 1],
    ['payload', authority.frame.payload, { forged: true }],
  ])('refuses a Proxy that flips %s after repeated reads', (property, first, later) => {
    let reads = 0;
    const proxy = new Proxy(
      clone(authority.frame) as unknown as Record<string, unknown>,
      {
        get(target, key, receiver) {
          if (key === property) {
            reads += 1;
            return reads === 1 ? first : later;
          }
          return Reflect.get(target, key, receiver);
        },
      },
    );
    expect(verify(proxy)).toMatchObject({
      ok: false,
      error: { step: '1', code: 'key-set' },
    });
    expect(reads).toBe(0);
  });

  it('rejects accessors without invoking getter side effects or shape mutation', () => {
    const frame = clone(authority.frame) as unknown as Record<string, unknown>;
    let sideEffects = 0;
    Object.defineProperty(frame, 'kind', {
      enumerable: true,
      configurable: true,
      get() {
        sideEffects += 1;
        frame.extra = true;
        return sideEffects === 1 ? 'body.pulse' : 'body.dimension';
      },
    });
    expect(verify(frame)).toMatchObject({
      ok: false,
      error: { step: '1', code: 'key-set' },
    });
    expect(sideEffects).toBe(0);
    expect(Object.hasOwn(frame, 'extra')).toBe(false);
  });

  it('rejects Proxy ownKeys/descriptor inconsistencies before traps can race', () => {
    let ownKeyCalls = 0;
    let descriptorCalls = 0;
    const proxy = new Proxy(
      clone(authority.frame) as unknown as Record<string, unknown>,
      {
        ownKeys(target) {
          ownKeyCalls += 1;
          return Reflect.ownKeys(target);
        },
        getOwnPropertyDescriptor(target, key) {
          descriptorCalls += 1;
          if (descriptorCalls > 1 && key === 'kind') return undefined;
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
      },
    );
    expect(verify(proxy)).toMatchObject({
      ok: false,
      error: { step: '1', code: 'key-set' },
    });
    expect(ownKeyCalls).toBe(0);
    expect(descriptorCalls).toBe(0);
  });

  it('rejects a nested payload Proxy without reading or mutating it', () => {
    let reads = 0;
    const payload = new Proxy(clone(authority.frame.payload), {
      get(target, key, receiver) {
        reads += 1;
        return Reflect.get(target, key, receiver);
      },
    });
    const frame = { ...clone(authority.frame), payload };
    expect(verify(frame)).toMatchObject({
      ok: false,
      error: { step: '1', code: 'key-set' },
    });
    expect(reads).toBe(0);
  });

  it('rejects symbol keys, array holes/non-index properties, and inherited frame fields', () => {
    const withSymbol =
      clone(authority.frame) as unknown as Record<PropertyKey, unknown>;
    withSymbol[Symbol('hidden')] = true;
    expect(verify(withSymbol)).toMatchObject({ ok: false, error: { code: 'key-set' } });

    const withHole = clone(authority.frame);
    (withHole.payload as Record<string, unknown>).hole = new Array(2);
    expect(verify(withHole)).toMatchObject({ ok: false, error: { code: 'key-set' } });

    const withArrayProperty = clone(authority.frame);
    const array = [1, 2] as number[] & { extra?: number };
    array.extra = 3;
    (withArrayProperty.payload as Record<string, unknown>).array = array;
    expect(verify(withArrayProperty)).toMatchObject({
      ok: false,
      error: { code: 'key-set' },
    });

    const own = clone(authority.frame) as unknown as Record<string, unknown>;
    const inherited = Object.create({ spec: own.spec }) as Record<string, unknown>;
    for (const [key, value] of Object.entries(own)) {
      if (key !== 'spec') inherited[key] = value;
    }
    expect(verify(inherited)).toMatchObject({
      ok: false,
      error: { code: 'key-set' },
    });
  });

  it('returns one immutable snapshot unaffected by later source mutation', () => {
    const source = clone(authority.frame);
    const verified = verify(source);
    expect(verified.ok).toBe(true);
    if (!verified.ok) throw verified.error;
    (source as unknown as { kind: string }).kind = 'body.dimension';
    source.seq += 1;
    (source.payload as Record<string, unknown>).revision = 'forged';
    expect(verified.frame.kind).toBe('body.pulse');
    expect(verified.frame.seq).toBe(authority.frame.seq);
    expect(verified.frame.payload).toEqual(authority.frame.payload);
    expect(verified.frame).not.toBe(source);
    expect(Object.isFrozen(verified.frame)).toBe(true);
    expect(Object.isFrozen(verified.frame.payload)).toBe(true);
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

  it('returns typed refusal for length-flipping chain Proxies', () => {
    let lengthReads = 0;
    const proxy = new Proxy([genesis], {
      get(target, property, receiver) {
        if (property === 'length') {
          lengthReads += 1;
          return lengthReads === 1 ? 1 : 2;
        }
        return Reflect.get(target, property, receiver);
      },
    });
    let result: ReturnType<typeof verifyRappFrameChain> | undefined;
    expect(() => {
      result = verifyRappFrameChain(
        proxy,
        RAPP_ACCEPTED_BODY_STREAM_PROFILE,
        policy,
      );
    }).not.toThrow();
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'key-set', step: '1' },
    });
    expect(lengthReads).toBe(0);
  });

  it('returns typed refusal for throwing getters and malformed chain arrays', () => {
    let getterCalls = 0;
    const accessor = [genesis];
    Object.defineProperty(accessor, '0', {
      enumerable: true,
      configurable: true,
      get() {
        getterCalls += 1;
        throw new Error('must not execute');
      },
    });
    expect(verifyRappFrameChain(
      accessor,
      RAPP_ACCEPTED_BODY_STREAM_PROFILE,
      policy,
    )).toMatchObject({ ok: false, error: { code: 'key-set', step: '1' } });
    expect(getterCalls).toBe(0);

    const hole = new Array(1);
    expect(verifyRappFrameChain(
      hole,
      RAPP_ACCEPTED_BODY_STREAM_PROFILE,
      policy,
    )).toMatchObject({ ok: false, error: { code: 'key-set', step: '1' } });

    const extra = [genesis] as unknown[] & { extra?: boolean };
    extra.extra = true;
    expect(verifyRappFrameChain(
      extra,
      RAPP_ACCEPTED_BODY_STREAM_PROFILE,
      policy,
    )).toMatchObject({ ok: false, error: { code: 'key-set', step: '1' } });

    const symbol = [genesis] as unknown[] & Record<PropertyKey, unknown>;
    symbol[Symbol('hidden')] = true;
    expect(verifyRappFrameChain(
      symbol,
      RAPP_ACCEPTED_BODY_STREAM_PROFILE,
      policy,
    )).toMatchObject({ ok: false, error: { code: 'key-set', step: '1' } });
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
