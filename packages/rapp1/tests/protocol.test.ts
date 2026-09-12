import { createHash, generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  AUTHORITY_IDENTITY, EVIDENCE_SCHEMA, FRAME_KEYS, HEX64, IDENTITY_DOMAIN, MAX_CANONICAL_BYTES,
  PARTICLE_DOMAIN, RAPP1_AUTHORITY, UINT53_MAX, WAVE_DOMAIN, arrayItems, buildEvidenceFrame,
  buildEvidencePayload, buildFrame, canonicalJson, createFrameSigner, frameDigest, frameHead,
  hashBytes, hashValue, identityFromTail, isBodyStream, isSelectedAuthority, isUtc, isVerifiedChain,
  keyedIdentity, kindFamily, mergeFrames, mintIdentity, parseCanonicalJson, parseJson, scanChain,
  scanFrame, scanFrameJson, selectChainTrust, selectSignaturePolicy, sha256, snapshotJson,
  streamFamily, validateEvidencePayload, verifyEvidenceLink, wavePreimage,
  type FrameHead, type JsonObject, type RappFrame, type VerifiedChain,
} from '../src/index.js';

const fixture = JSON.parse(readFileSync(new URL('../fixtures/rev14-authority.json', import.meta.url), 'utf8'));
const numbers = JSON.parse(readFileSync(new URL('../fixtures/rfc8785-number-vectors.json', import.meta.url), 'utf8'));
const BODY = `rappid:@alice/worker:${'a'.repeat(64)}`;
const MEMORY = `${BODY}:work`;
const UTC = '2026-09-11T12:00:00.000Z';
const nextUtc = '2026-09-11T12:00:00.001Z';
const body = (payload: JsonObject = { hello: 'world' }, head: FrameHead | null = null, utc = UTC) =>
  buildFrame({ kind: 'body.pulse', streamId: BODY, utc, payload, head });
function checked(frames: RappFrame[], persisted = frames.at(-1)!): VerifiedChain {
  const first = frames[0]!;
  const result = scanChain(frames, selectChainTrust({
    genesis: { stream_id: first.stream_id, frame_hash: first.frame_hash, payload_hash: first.payload_hash },
    persistedHead: frameHead(persisted), requireCommittedHead: true,
  }));
  if (!result.ok) throw result.error;
  return result;
}
function rewritten(frame: RappFrame, patch: object): RappFrame {
  const draft = { ...frame, ...patch };
  return { ...draft, frame_hash: frameDigest(draft) };
}
const independentHash = (domain: string, text: string) =>
  createHash('sha256').update(`${domain}\n${text}`).digest('hex');

describe('accepted rev-14 checkpoint, not a runtime import', () => {
  it('pins every authority and byte-level acceptance hash', () => {
    expect(RAPP1_AUTHORITY.checkpointCommit).toBe('caf6ef276cafa92aa744499af90dc1a28559941a');
    expect(AUTHORITY_IDENTITY).toEqual({
      revision: 'rev-14',
      frame_hash: '59629adab4e26d156f3d66ecfb766e08705919ea1d2adc92ba0ad2b17337dfc2',
      payload_hash: 'c7549bbd3e133b833930e24e008817ea295734b870f41706455d3f45821aba3a',
    });
    const expected = fixture.expected;
    const frame = fixture.frame as RappFrame;
    for (const [prefix, value] of [
      ['frame', frame], ['payload', frame.payload], ['wave', wavePreimage(frame)],
    ] as const) {
      const bytes = canonicalJson(value);
      expect(Buffer.byteLength(bytes)).toBe(expected[`${prefix}_canonical_bytes`]);
      expect(sha256(bytes)).toBe(expected[`${prefix}_canonical_sha256`]);
    }
    expect(expected.frame_canonical_sha256).toBe('894ecc2cfdf0418d54da5ece283978a83561febbb1701e07421036da99fb4b68');
    expect(expected.payload_canonical_sha256).toBe('180947cb6657c357e146888080b757c01beb20ae66cd9aee549517289ed17b22');
    expect(expected.wave_canonical_sha256).toBe('37ddd302ac4df88a06452f330f3dcddcf390c1f6d47cc83c11f2655d217b6248');
    expect(independentHash(PARTICLE_DOMAIN, canonicalJson(frame.payload))).toBe(AUTHORITY_IDENTITY.payload_hash);
    expect(independentHash(WAVE_DOMAIN, canonicalJson(wavePreimage(frame)))).toBe(AUTHORITY_IDENTITY.frame_hash);
    expect(sha256(fixture.frame.payload.normative.text)).toBe(RAPP1_AUTHORITY.normativeSha256);
    expect(Object.keys(frame).sort()).toEqual([...FRAME_KEYS].sort());
    const result = scanFrameJson(canonicalJson(frame), { streamId: frame.stream_id, head: fixture.predecessor });
    expect(result).toMatchObject({ ok: true, trust: { classification: 'integrity-only', promotionGrade: false, genesis: 'unbound' } });
    expect(buildFrame({
      kind: frame.kind, streamId: frame.stream_id, utc: frame.utc,
      payload: frame.payload, head: fixture.predecessor,
    })).toEqual(frame);
  });

  it('uses only exact registered kinds and immutable module-owned authority', () => {
    expect(Object.keys(RAPP1_AUTHORITY.kindFamilies)).toEqual(fixture.frame.payload.registered_kinds);
    for (const [family, value] of Object.entries(fixture.frame.payload.kind_families) as [string, { kinds: string[] }][]) {
      for (const kind of value.kinds) expect(kindFamily(kind)).toBe(family);
    }
    expect(Object.isFrozen(RAPP1_AUTHORITY.kindFamilies)).toBe(true);
    expect(Object.getPrototypeOf(RAPP1_AUTHORITY.kindFamilies)).toBeNull();
    for (const kind of ['body.dimension', 'body.constructor', '__proto__', 'constructor', 'task.created']) {
      expect(kindFamily(kind)).toBeNull();
    }
    expect(isSelectedAuthority(RAPP1_AUTHORITY)).toBe(true);
    expect(isSelectedAuthority({ ...RAPP1_AUTHORITY })).toBe(false);
  });
});

describe('RFC 8785 and strict input domain', () => {
  it.each(numbers.accepted)('accepts $token as $canonical', ({ token, canonical }) => {
    expect(canonicalJson(parseJson(token))).toBe(canonical);
  });
  it.each(numbers.rejected)('refuses lossy numeric token %s', (token) => {
    expect(() => parseJson(token)).toThrow();
  });
  it.each(['1e400', '1e-400', '2e-324', '0.10000000000000001', '333333333.33333329',
    '{"x":1,"x":2}', '{"x":1,"\\u0078":1}', '{"__proto__":0,"__proto__":1}',
    '"\\ud800"', '"\\udfff"', '{', '[1,]', '{"a":1,}', '+1', '01', '1.', 'true false', '\ufeff{}',
    '//comment\n{}', 'NaN', 'Infinity', '"control\n"', '["\\ud800",{}]'])('refuses hostile JSON %s', (text) => {
    expect(() => parseJson(text)).toThrow();
  });
  it('uses UTF-16 ordering, raw Unicode, ECMAScript numbers and no normalization', () => {
    expect(canonicalJson({ '\ufb33': 1, '😀': 2, '€': 3, '\r': 4 })).toBe('{"\\r":4,"€":3,"😀":2,"דּ":1}');
    expect(canonicalJson({ x: -0, s: '€\b\t\n\f\r"\\' })).toBe('{"s":"€\\b\\t\\n\\f\\r\\"\\\\","x":0}');
    expect(hashValue(PARTICLE_DOMAIN, { name: 'é' })).not.toBe(hashValue(PARTICLE_DOMAIN, { name: 'e\u0301' }));
    expect(canonicalJson(parseJson('{"__proto__":{"polluted":true},"constructor":1}')))
      .toBe('{"__proto__":{"polluted":true},"constructor":1}');
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
    expect(canonicalJson(parseJson('0e999999999999999999999999'))).toBe('0');
  });
  it('refuses invalid UTF-8, BOM and noncanonical storage bytes', () => {
    expect(() => parseJson(Uint8Array.from([0xc0, 0xaf]))).toThrow();
    expect(() => parseJson(Uint8Array.from([0xef, 0xbb, 0xbf, 123, 125]))).toThrow();
    for (const value of [' {"a":1}', '{"a":1}\n', '{"b":2,"a":1}', '1.0', '"\\u0061"']) {
      expect(() => parseCanonicalJson(value)).toThrow();
    }
    expect(parseCanonicalJson(Buffer.from('{"a":1}'))).toEqual({ a: 1 });
  });
  it('enforces size and depth at parse, snapshot and emission', () => {
    expect(() => parseJson(' '.repeat(MAX_CANONICAL_BYTES) + '{}')).toThrow();
    expect(() => canonicalJson({ value: 'a'.repeat(MAX_CANONICAL_BYTES) })).toThrow();
    expect(() => parseJson('['.repeat(64) + '0' + ']'.repeat(64))).toThrow();
    expect(canonicalJson(parseJson('['.repeat(63) + '0' + ']'.repeat(63)))).toHaveLength(127);
    let deep: unknown = null;
    for (let i = 0; i < 65; i++) deep = { deep };
    expect(() => snapshotJson(deep)).toThrow();
  });
  it('does not invoke accessors, proxies, toJSON or exotic objects', () => {
    let invoked = 0;
    const getter = Object.defineProperty({}, 'x', { enumerable: true, get() { invoked++; return 1; } });
    const proxy = new Proxy({}, { ownKeys() { invoked++; return []; } });
    const arrayGetter = Object.defineProperty([], '0', { enumerable: true, get() { invoked++; return 1; } });
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    const shared = { x: 1 };
    const nonenum = Object.defineProperty({}, 'x', { value: 1 });
    const sparse = new Array(3);
    const extra = Object.assign([1], { ignored: 2 });
    for (const hostile of [getter, proxy, arrayGetter, cycle, nonenum, sparse, extra, new Date(), new Map(),
      new Uint8Array(1), Object.create({ x: 1 }), { toJSON() { invoked++; return {}; } },
      { x: undefined }, { x: NaN }, { x: Infinity }, { x: 1n }, { [Symbol('x')]: 1 }]) {
      expect(() => canonicalJson(hostile)).toThrow();
    }
    expect(invoked).toBe(0);
    expect(snapshotJson({ a: shared, b: shared })).toEqual({ a: { x: 1 }, b: { x: 1 } });
    expect(() => arrayItems(extra)).toThrow();
  });
  it('uses exact ASCII hash domains and raw UUID octets', () => {
    const bytes = Buffer.from('00112233445546778899aabbccddeeff', 'hex');
    expect(hashBytes(IDENTITY_DOMAIN, bytes)).toBe(createHash('sha256').update(`${IDENTITY_DOMAIN}\n`).update(bytes).digest('hex'));
    expect(hashValue(PARTICLE_DOMAIN, { a: 1 })).not.toBe(hashValue(WAVE_DOMAIN, { a: 1 }));
    expect(() => hashValue('rapp/1:particle\nother', {})).toThrow();
    expect(() => hashValue('é', {})).toThrow();
  });
});

describe('frame envelope, binding, ordering and trust', () => {
  it('emits an immutable eleven-key scanned frame', () => {
    const payload = { greeting: 'Hello', nested: { work: true } };
    const frame = body(payload);
    payload.nested.work = false;
    expect(frame.payload.nested).toEqual({ work: true });
    expect(Object.isFrozen(frame)).toBe(true);
    expect(Object.keys(wavePreimage(frame))).toHaveLength(9);
    expect(wavePreimage(frame)).not.toHaveProperty('sig');
    expect(wavePreimage(frame)).not.toHaveProperty('frame_hash');
    expect(scanFrameJson(canonicalJson(frame), { head: null, streamId: BODY }).ok).toBe(true);
    expect(frame.payload_hash).toBe(independentHash(PARTICLE_DOMAIN, '{"greeting":"Hello","nested":{"work":true}}'));
  });
  it.each([
    ['spec', 'rapp-frame/2.0', 'spec'], ['kind', 'new.event', 'unregistered-kind'],
    ['kind', 'memory.save', 'kind-family'], ['seq', -1, 'seq'], ['seq', 1.5, 'seq'],
    ['seq', UINT53_MAX + 1, 'seq'], ['utc', '2026-02-30T00:00:00.000Z', 'utc'],
    ['utc', '2026-09-11T12:00:00Z', 'utc'], ['payload', [], 'payload'], ['payload', null, 'payload'],
    ['payload_hash', 'F'.repeat(64), 'payload-hash-format'], ['frame_hash', 'f', 'frame-hash-format'],
    ['prev', false, 'prev-format'], ['prev_wave', 3, 'prev-wave-format'], ['sig', 4, 'signature-format'],
  ])('rejects %s=%s (%s)', (key, value, code) => {
    expect(scanFrame({ ...body(), [key]: value }, { head: null, streamId: BODY })).toMatchObject({ ok: false, error: { code } });
  });
  it.each([
    '0000-01-01T00:00:00.000Z', '2026-13-01T00:00:00.000Z', '2026-01-01T24:00:00.000Z',
    '2026-01-01T00:00:60.000Z', '2100-02-29T00:00:00.000Z', '2026-01-01t00:00:00.000z',
    '2026-01-01T00:00:00.000+00:00',
  ])('refuses invalid UTC %s', (value) => expect(isUtc(value)).toBe(false));
  it('accepts leap years and byte-exact timestamp limits', () => {
    for (const time of ['2000-02-29T00:00:00.000Z', '0001-01-01T00:00:00.000Z', '9999-12-31T23:59:59.999Z']) {
      expect(isUtc(time)).toBe(true);
    }
  });
  it('refuses missing, extra, accessor and inherited fields without executing code', () => {
    for (const key of FRAME_KEYS) {
      const frame = { ...body() };
      delete (frame as Record<string, unknown>)[key];
      expect(scanFrame(frame, { head: null, streamId: BODY }).ok).toBe(false);
    }
    expect(scanFrame({ ...body(), extra: null }, { head: null, streamId: BODY }).ok).toBe(false);
    let calls = 0;
    const frame = Object.defineProperty({ ...body() }, 'payload', { get() { calls++; return {}; } });
    expect(scanFrame(frame, { head: null, streamId: BODY }).ok).toBe(false);
    expect(scanFrame(body(), Object.create({ head: null, streamId: BODY })).ok).toBe(false);
    expect(calls).toBe(0);
  });
  it('binds the stream before checking content hashes and refuses unsigned/signature tricks', () => {
    const frame = body();
    expect(scanFrame({ ...frame, payload_hash: '0'.repeat(64) }, { head: null, streamId: `${BODY}:work` }))
      .toMatchObject({ ok: false, error: { code: 'stream-binding', step: '1a' } });
    expect(scanFrame({ ...frame, payload: { altered: true } }, { head: null, streamId: BODY }))
      .toMatchObject({ ok: false, error: { code: 'payload-hash', step: '2' } });
    expect(scanFrame({ ...frame, utc: nextUtc }, { head: null, streamId: BODY }))
      .toMatchObject({ ok: false, error: { code: 'frame-hash', step: '3' } });
    expect(scanFrame({ ...frame, sig: 'a..b' }, { head: null, streamId: BODY }))
      .toMatchObject({ ok: false, error: { code: 'signature-profile', step: '6' } });
  });
  it('enforces exact predecessor particle and wave, sequence ceiling and monotonic time', () => {
    const first = body();
    const second = body({ done: true }, frameHead(first), nextUtc);
    expect(second.prev).toBe(first.payload_hash);
    expect(second.prev_wave).toBeNull();
    for (const [patch, code] of [
      [{ prev: first.frame_hash }, 'prev-continuity'], [{ seq: 3 }, 'seq-continuity'],
      [{ utc: '2026-09-10T00:00:00.000Z' }, 'time-regression'], [{ prev_wave: first.frame_hash }, 'prev-wave'],
    ] as const) {
      expect(scanFrame(rewritten(second, patch), { head: frameHead(first), streamId: BODY }))
        .toMatchObject({ ok: false, error: { code } });
    }
    expect(() => body({}, { ...frameHead(first), seq: UINT53_MAX })).toThrow();
    expect(scanFrame(second, { head: null, streamId: BODY }).ok).toBe(false);
    expect(() => buildFrame({ kind: 'body.re-genesis', streamId: BODY, utc: UTC, payload: {}, head: null })).toThrow();
  });
  it('accepts repeated ordinary particles but not forks, reordered or truncated chains', () => {
    const a = body({ unchanged: true });
    const b = body({ unchanged: true }, frameHead(a));
    const c = body({ next: true }, frameHead(b), nextUtc);
    const select = selectChainTrust({
      genesis: { stream_id: BODY, payload_hash: a.payload_hash, frame_hash: a.frame_hash }, persistedHead: frameHead(b),
    });
    expect(scanChain([a, b, c], select)).toMatchObject({ ok: true, trust: { persistedHead: 'advanced' } });
    expect(scanChain([a, b], select)).toMatchObject({ ok: true, trust: { persistedHead: 'matched' } });
    expect(scanChain([a], select)).toMatchObject({ ok: false, error: { code: 'rollback' } });
    expect(scanChain([a, b], select, { uniquePayloads: true })).toMatchObject({ ok: false, error: { code: 'duplicate-payload-hash' } });
    const fork = body({ branch: true }, frameHead(a));
    expect(scanChain([a, b, fork], select)).toMatchObject({ ok: false, error: { code: 'fork' } });
    expect(scanChain([a, b, b], select)).toMatchObject({ ok: false, error: { code: 'duplicate-seq' } });
    for (const bad of [[], [b], [a, c, b], [b, a, c], [a, fork]]) expect(scanChain(bad, select).ok).toBe(false);
    expect(scanChain([a, b], { ...select }).ok).toBe(false);
    expect(isVerifiedChain({ ...checked([a, b]) })).toBe(false);
    expect(isVerifiedChain(checked([a, b]))).toBe(true);
  });
  it('requires exact committed-head selection and independent genesis pins', () => {
    const a = body();
    const b = body({ b: true }, frameHead(a));
    const trusted = selectChainTrust({
      genesis: { stream_id: BODY, payload_hash: a.payload_hash, frame_hash: a.frame_hash },
      persistedHead: frameHead(a), requireCommittedHead: true,
    });
    expect(scanChain([a, b], trusted)).toMatchObject({ ok: false, error: { code: 'uncommitted-head' } });
    const other = body({ impostor: true });
    const untracked = selectChainTrust({
      genesis: { stream_id: BODY, payload_hash: other.payload_hash, frame_hash: other.frame_hash }, persistedHead: null,
    });
    expect(scanChain([a], untracked)).toMatchObject({ ok: false, error: { code: 'untrusted-genesis' } });
  });
  it('mints independent identities and refuses legacy/traversal grammar', () => {
    expect(mintIdentity('alice', 'worker')).not.toBe(mintIdentity('alice', 'worker'));
    for (const stream of [
      `rappid:alice:${'a'.repeat(64)}`, `rappid:@Alice/worker:${'a'.repeat(64)}`,
      `rappid:@alice/a--b:${'a'.repeat(64)}`, `rappid:@alice/../x:${'a'.repeat(64)}`,
      `rappid:@${'a'.repeat(40)}/worker:${'a'.repeat(64)}`, `${BODY}:${'a'.repeat(65)}`,
      `net:${'a'.repeat(65)}`, `${BODY}:instance:extra`,
    ]) expect(streamFamily(stream)).toBeNull();
    expect(isBodyStream(identityFromTail('a', 'b', '1'.repeat(64)))).toBe(true);
    expect(streamFamily(MEMORY)).toBe('memory');
    expect(streamFamily('net:team')).toBe('swarm');
  });
  it('merges only scanned chains in normative UTC then wave order', () => {
    const a = body();
    const m = buildFrame({ kind: 'memory.save', streamId: MEMORY, head: null, utc: UTC, payload: {} });
    expect(mergeFrames([checked([a]), checked([m])]).map((x) => x.frame_hash))
      .toEqual([a.frame_hash, m.frame_hash].sort());
    expect(() => mergeFrames([checked([a]), checked([a])])).toThrow();
  });
});

describe('detached unencoded JWS and registry trust', () => {
  it.each(['ed25519', 'ec'] as const)('verifies %s keys and exact signed swarm links', (type) => {
    const pair = type === 'ed25519' ? generateKeyPairSync('ed25519')
      : generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const kid = keyedIdentity('alice', 'key', pair.publicKey);
    const signer = createFrameSigner({ kid, privateKey: pair.privateKey });
    const entry = { kid, spki_der_b64: pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
      revoked_utc: null, superseded_utc: null };
    const signatures = selectSignaturePolicy([entry]);
    const first = buildFrame({ kind: 'swarm.telemetry', streamId: 'net:work', utc: UTC, head: null, payload: {}, signer, signatures });
    const second = buildFrame({
      kind: 'swarm.echo', streamId: first.stream_id, utc: nextUtc, head: frameHead(first), payload: { answer: true }, signer, signatures,
    });
    expect(second.prev_wave).toBe(first.frame_hash);
    expect(first.sig).toMatch(/^[\w-]+\.\.[\w-]+$/);
    expect(scanFrame(second, { streamId: second.stream_id, head: frameHead(first), signatures }).ok).toBe(true);
    expect(scanFrame(second, { streamId: second.stream_id, head: frameHead(first) }).ok).toBe(false);
    expect(scanFrame({ ...first, sig: null }, { streamId: first.stream_id, head: null, signatures }))
      .toMatchObject({ ok: false, error: { code: 'signature-required' } });
    const revoked = selectSignaturePolicy([{ ...entry, revoked_utc: nextUtc }]);
    expect(scanFrame(first, { streamId: first.stream_id, head: null, signatures: revoked }).ok).toBe(true);
    expect(scanFrame(second, { streamId: second.stream_id, head: frameHead(first), signatures: revoked }).ok).toBe(false);
    const superseded = selectSignaturePolicy([{ ...entry, superseded_utc: UTC }]);
    expect(scanFrame(first, { streamId: first.stream_id, head: null, signatures: superseded }).ok).toBe(false);
    for (const sig of [first.sig! + '=', first.sig!.replace('..', '.x.'), '', 'none..', second.sig!]) {
      expect(scanFrame({ ...first, sig }, { streamId: first.stream_id, head: null, signatures }).ok).toBe(false);
    }
    expect(() => selectSignaturePolicy([{ ...entry, kid: BODY }])).toThrow();
    expect(() => selectSignaturePolicy([entry, entry])).toThrow();
    const header = parseJson(Buffer.from(first.sig!.split('..')[0]!, 'base64url'));
    expect(header).toEqual({ alg: type === 'ed25519' ? 'EdDSA' : 'ES256', b64: false, crit: ['b64'], kid });
    if (type === 'ed25519') {
      const repeated = buildFrame({ kind: first.kind, streamId: first.stream_id, utc: UTC, head: null, payload: {}, signer, signatures });
      expect(repeated.sig).toBe(first.sig);
    }
  });
  it('cannot accidentally emit an unsigned swarm or approve a fake signer', () => {
    expect(() => buildFrame({ kind: 'swarm.guidance', streamId: 'net:work', utc: UTC, head: null, payload: {} })).toThrow();
    expect(() => buildFrame({ kind: 'body.pulse', streamId: BODY, utc: UTC, head: null, payload: {}, signer: {} as never })).toThrow();
  });
});

describe('normative evidence particles and source occurrences', () => {
  it('binds source data, selected authority, particle and wave on full scanned chains', () => {
    const data = { title: 'Prepare report', status: 'queued' };
    const source = buildFrame({
      kind: 'memory.save', streamId: MEMORY, utc: UTC, head: null,
      payload: { subject: 'task:one', data, protocol_revision: AUTHORITY_IDENTITY },
    });
    const references = [source.frame_hash, source.payload_hash].sort();
    const evidence = buildEvidenceFrame({
      streamId: BODY, utc: UTC, head: null, eventKind: 'task.changed', subject: 'task:one',
      dataHash: hashValue(PARTICLE_DOMAIN, data), referenceHashes: references,
    });
    expect(evidence.payload.schema).toBe('openrappter-evidence/1');
    const input = {
      body: checked([evidence]), source: checked([source]), sourceFrameHash: source.frame_hash,
      evidenceFrameHash: evidence.frame_hash, subject: 'task:one', eventKind: 'task.changed', data,
    };
    expect(verifyEvidenceLink(input)).toEqual(evidence);
    expect(() => verifyEvidenceLink({ ...input, data: { status: 'succeeded' } })).toThrow();
    expect(() => verifyEvidenceLink({ ...input, sourceFrameHash: '0'.repeat(64) })).toThrow();
    expect(() => verifyEvidenceLink({ ...input, body: { ...input.body } })).toThrow();
    const replay = buildEvidenceFrame({
      streamId: BODY, utc: nextUtc, head: frameHead(evidence), eventKind: 'task.changed', subject: 'task:one',
      dataHash: hashValue(PARTICLE_DOMAIN, data), referenceHashes: references,
    });
    expect(() => verifyEvidenceLink({ ...input, body: checked([evidence, replay]) })).toThrow();
    for (const patch of [
      { schema: 'rapp-work-evidence/1' }, { extra: true }, { event_kind: 'new' },
      { protocol_revision: { ...AUTHORITY_IDENTITY, revision: 'rev-13' } }, { subject: '' },
      { reference_hashes: [references[1], references[0]] }, { reference_hashes: [references[0], references[0]] },
    ]) expect(() => validateEvidencePayload({ ...evidence.payload, ...patch })).toThrow();
  });
  it('refuses malformed evidence at construction rather than silently repairing it', () => {
    expect(() => buildEvidencePayload({ eventKind: 'task.changed', subject: 'a', dataHash: 'x', referenceHashes: [] })).toThrow();
    const payload = buildEvidencePayload({ eventKind: 'task.changed', subject: 'a', dataHash: 'a'.repeat(64), referenceHashes: [] });
    expect(Object.isFrozen(payload.reference_hashes)).toBe(true);
    expect(payload.schema).toBe(EVIDENCE_SCHEMA);
    expect(HEX64.test(hashValue(PARTICLE_DOMAIN, payload))).toBe(true);
  });
});
