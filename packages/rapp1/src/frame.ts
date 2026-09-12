import { AUTHORITY_IDENTITY, kindFamily, type AuthorityIdentity, type StreamFamily } from './authority.js';
import {
  arrayItems, assertOptions, canonicalJson, hashValue, isJsonObject, parseCanonicalJson,
  PARTICLE_DOMAIN, snapshotJson, WAVE_DOMAIN, type JsonObject,
} from './json.js';
import { HEX64, isKind, isUtc, streamFamily } from './identity.js';
import { signFrame, verifyFrameSignature, type FrameSigner, type SignaturePolicy } from './signature.js';

export const FRAME_SPEC = 'rapp/1';
export const UINT53_MAX = 2 ** 53 - 1;
export const FRAME_KEYS = Object.freeze([
  'spec', 'kind', 'stream_id', 'seq', 'utc', 'payload', 'payload_hash', 'frame_hash', 'prev', 'prev_wave', 'sig',
] as const);
const HEAD_KEYS = ['stream_id', 'seq', 'utc', 'payload_hash', 'frame_hash'] as const;

export interface RappFrame<P extends JsonObject = JsonObject> {
  readonly spec: typeof FRAME_SPEC;
  readonly kind: string;
  readonly stream_id: string;
  readonly seq: number;
  readonly utc: string;
  readonly payload: P;
  readonly payload_hash: string;
  readonly frame_hash: string;
  readonly prev: string | null;
  readonly prev_wave: string | null;
  readonly sig: string | null;
}
export type FrameHead = Pick<RappFrame, typeof HEAD_KEYS[number]>;
export interface GenesisAnchor {
  readonly stream_id: string;
  readonly payload_hash: string;
  readonly frame_hash: string;
}
export interface TrustAssessment {
  readonly classification: 'integrity-only';
  readonly promotionGrade: false;
  readonly authority: Readonly<AuthorityIdentity>;
  readonly genesis: 'unbound' | 'trusted';
  readonly persistedHead: 'untracked' | 'matched' | 'advanced';
}
export type VerificationStep = '1' | '1a' | '2' | '3' | '4' | '5' | '6';
export class FrameError extends Error {
  constructor(
    readonly code: string, readonly step: VerificationStep | null, message: string,
    readonly frameIndex: number | null = null,
  ) { super(message); this.name = 'FrameError'; }
}
export type FrameScan = { readonly ok: true; readonly frame: RappFrame; readonly trust: TrustAssessment }
  | { readonly ok: false; readonly error: FrameError };
export interface VerifiedChain {
  readonly ok: true;
  readonly frames: readonly RappFrame[];
  readonly head: FrameHead;
  readonly trust: TrustAssessment;
}
export type ChainScan = VerifiedChain | { readonly ok: false; readonly error: FrameError };
declare const trustBrand: unique symbol;
export interface ChainTrust { readonly [trustBrand]: true }
interface TrustRecord { genesis: GenesisAnchor; persisted: FrameHead | null; requireCommitted: boolean }
const trusts = new WeakMap<object, TrustRecord>();
const verifiedChains = new WeakSet<object>();

export interface ScanOptions {
  streamId: string;
  head: FrameHead | null;
  signatures?: SignaturePolicy;
}
export interface ChainOptions {
  signatures?: SignaturePolicy;
  uniquePayloads?: boolean;
  family?: StreamFamily;
}

function trust(genesis: TrustAssessment['genesis'], persistedHead: TrustAssessment['persistedHead']): TrustAssessment {
  return Object.freeze({ classification: 'integrity-only', promotionGrade: false, authority: AUTHORITY_IDENTITY, genesis, persistedHead });
}
function refuse(code: string, step: VerificationStep | null, message: string): never {
  throw new FrameError(code, step, message);
}
function failure(error: unknown): { ok: false; error: FrameError } {
  return { ok: false, error: error instanceof FrameError ? error
    : new FrameError('canonical', '1', error instanceof Error ? error.message : 'Invalid frame') };
}

export function frameHead(frame: RappFrame): FrameHead {
  return Object.freeze({
    stream_id: frame.stream_id, seq: frame.seq, utc: frame.utc,
    payload_hash: frame.payload_hash, frame_hash: frame.frame_hash,
  });
}

export function validateHead(value: unknown): FrameHead {
  const head = snapshotJson(value);
  assertOptions(head, HEAD_KEYS);
  if (streamFamily(head.stream_id) === null || !Number.isSafeInteger(head.seq) || (head.seq as number) < 0
    || !isUtc(head.utc) || typeof head.frame_hash !== 'string' || !HEX64.test(head.frame_hash)
    || typeof head.payload_hash !== 'string' || !HEX64.test(head.payload_hash)) {
    throw new TypeError('Invalid frame head');
  }
  return head as unknown as FrameHead;
}

export function wavePreimage(frame: RappFrame): JsonObject {
  return {
    spec: frame.spec, kind: frame.kind, stream_id: frame.stream_id, seq: frame.seq, utc: frame.utc,
    payload: frame.payload, payload_hash: frame.payload_hash, prev: frame.prev, prev_wave: frame.prev_wave,
  };
}

export function frameDigest(frame: RappFrame): string {
  return hashValue(WAVE_DOMAIN, wavePreimage(frame));
}

/** Pins are selected by the persistence owner, not discovered from the presented chain. */
export function selectChainTrust(input: {
  genesis: GenesisAnchor; persistedHead: FrameHead | null; requireCommittedHead?: boolean;
}): ChainTrust {
  assertOptions(input, ['genesis', 'persistedHead', 'requireCommittedHead'], ['genesis', 'persistedHead']);
  const genesis = snapshotJson(input.genesis);
  assertOptions(genesis, ['stream_id', 'payload_hash', 'frame_hash']);
  if (streamFamily(genesis.stream_id) === null || typeof genesis.payload_hash !== 'string'
    || !HEX64.test(genesis.payload_hash) || typeof genesis.frame_hash !== 'string' || !HEX64.test(genesis.frame_hash)) {
    throw new TypeError('Invalid trusted genesis');
  }
  const persisted = input.persistedHead === null ? null : validateHead(input.persistedHead);
  if (persisted && (persisted.stream_id !== genesis.stream_id || (persisted.seq === 0
    && (persisted.frame_hash !== genesis.frame_hash || persisted.payload_hash !== genesis.payload_hash)))) {
    throw new TypeError('Head conflicts with trusted genesis');
  }
  if (input.requireCommittedHead !== undefined && typeof input.requireCommittedHead !== 'boolean') {
    throw new TypeError('Invalid committed-head policy');
  }
  const handle = Object.freeze(Object.create(null)) as ChainTrust;
  trusts.set(handle, {
    genesis: genesis as unknown as GenesisAnchor, persisted,
    requireCommitted: input.requireCommittedHead ?? false,
  });
  return handle;
}

function intrinsic(value: unknown, streamId: string): RappFrame {
  const frame = snapshotJson(value);
  try { assertOptions(frame, FRAME_KEYS); } catch { refuse('key-set', '1', 'Frame requires exactly eleven own keys'); }
  if (frame.spec !== FRAME_SPEC) refuse('spec', '1', 'spec must be rapp/1');
  if (!isKind(frame.kind)) refuse('kind', '1', 'Invalid noun.verb kind');
  const family = streamFamily(frame.stream_id);
  if (!family) refuse('stream-id', '1', 'Invalid canonical stream identifier');
  const registered = kindFamily(frame.kind);
  if (!registered) refuse('unregistered-kind', '1', 'Kind is not registered in rev-14');
  if (family !== registered) refuse('kind-family', '1', 'Registry kind/stream family mismatch');
  if (typeof frame.seq !== 'number' || !Number.isSafeInteger(frame.seq) || frame.seq < 0) {
    refuse('seq', '1', 'seq must be uint53');
  }
  if (!isUtc(frame.utc)) refuse('utc', '1', 'Invalid fixed-width calendar timestamp');
  if (!isJsonObject(frame.payload as never)) refuse('payload', '1', 'payload must be a JSON object');
  for (const key of ['payload_hash', 'frame_hash'] as const) {
    if (typeof frame[key] !== 'string' || !HEX64.test(frame[key])) refuse(`${key.replace('_', '-')}-format`, '1', 'Invalid hash');
  }
  for (const key of ['prev', 'prev_wave'] as const) {
    if (frame[key] !== null && (typeof frame[key] !== 'string' || !HEX64.test(frame[key]))) {
      refuse(`${key.replace('_', '-')}-format`, '1', 'Invalid predecessor hash');
    }
  }
  if (frame.sig !== null && typeof frame.sig !== 'string') refuse('signature-format', '1', 'Invalid sig type');
  canonicalJson(frame);
  if (frame.stream_id !== streamId) refuse('stream-binding', '1a', 'Frame belongs to another stream of record');
  if (frame.payload_hash !== hashValue(PARTICLE_DOMAIN, frame.payload)) refuse('payload-hash', '2', 'Particle mismatch');
  const typed = frame as unknown as RappFrame;
  if (frame.frame_hash !== frameDigest(typed)) refuse('frame-hash', '3', 'Wave mismatch');
  return typed;
}

function continuation(frame: RappFrame, head: FrameHead | null, signatures?: SignaturePolicy): void {
  if (head === null) {
    if (frame.seq !== 0 || frame.prev !== null) refuse('genesis', '4', 'Genesis requires seq 0 and prev null');
  } else {
    if (frame.stream_id !== head.stream_id) refuse('stream-binding', '1a', 'Predecessor belongs to another stream');
    if (head.seq === UINT53_MAX || frame.seq !== head.seq + 1) refuse('seq-continuity', '4', 'Non-contiguous sequence');
    if (frame.prev !== head.payload_hash) refuse('prev-continuity', '4', 'prev must link the predecessor particle');
    if (frame.utc < head.utc) refuse('time-regression', '4', 'UTC regressed');
  }
  const swarm = streamFamily(frame.stream_id) === 'swarm';
  if (frame.prev_wave !== (swarm && head !== null ? head.frame_hash : null)) {
    refuse('prev-wave', '5', 'Incorrect wave predecessor');
  }
  if (frame.kind.endsWith('.re-genesis')) {
    refuse('re-genesis-profile', '6', 'Re-genesis requires a dedicated owner-signed registry authorization');
  }
  if (swarm && frame.sig === null) refuse('signature-required', '6', 'Swarm frames must be signed');
  if (frame.sig !== null && !verifyFrameSignature(frame, signatures)) {
    refuse('signature-profile', '6', 'Signature or trusted registry verification failed');
  }
}

export function scanFrame(value: unknown, options: ScanOptions): FrameScan {
  try {
    assertOptions(options, ['streamId', 'head', 'signatures'], ['streamId', 'head']);
    if (typeof options.streamId !== 'string') throw new TypeError('Missing stream of record');
    const head = options.head === null ? null : validateHead(options.head);
    if (head && head.stream_id !== options.streamId) refuse('stream-binding', '1a', 'Wrong predecessor stream');
    const frame = intrinsic(value, options.streamId);
    continuation(frame, head, options.signatures);
    return Object.freeze({ ok: true, frame, trust: trust('unbound', 'untracked') });
  } catch (error) { return failure(error); }
}

/** Stored and transported frames must already be canonical; never whitespace-repair. */
export function scanFrameJson(source: string | Uint8Array, options: ScanOptions): FrameScan {
  try { return scanFrame(parseCanonicalJson(source), options); } catch (error) { return failure(error); }
}

export function buildFrame<P extends JsonObject>(input: {
  kind: string; streamId: string; utc: string; payload: P; head: FrameHead | null;
  signer?: FrameSigner; signatures?: SignaturePolicy;
}): RappFrame<P> {
  assertOptions(input, ['kind', 'streamId', 'utc', 'payload', 'head', 'signer', 'signatures'],
    ['kind', 'streamId', 'utc', 'payload', 'head']);
  const head = input.head === null ? null : validateHead(input.head);
  if (head?.seq === UINT53_MAX) refuse('seq-continuity', '4', 'Sequence ceiling reached');
  const payload = snapshotJson(input.payload);
  if (!isJsonObject(payload)) refuse('payload', '1', 'payload must be an object');
  const draft: RappFrame = {
    spec: FRAME_SPEC, kind: input.kind, stream_id: input.streamId, seq: head === null ? 0 : head.seq + 1,
    utc: input.utc, payload, payload_hash: hashValue(PARTICLE_DOMAIN, payload), frame_hash: '0'.repeat(64),
    prev: head?.payload_hash ?? null,
    prev_wave: streamFamily(input.streamId) === 'swarm' ? head?.frame_hash ?? null : null,
    sig: null,
  };
  const wave = { ...draft, frame_hash: frameDigest(draft) };
  const frame = input.signer === undefined ? wave : { ...wave, sig: signFrame(wave, input.signer) };
  const result = scanFrame(frame, {
    streamId: input.streamId, head, ...(input.signatures === undefined ? {} : { signatures: input.signatures }),
  });
  if (!result.ok) throw result.error;
  return result.frame as RappFrame<P>;
}

export function scanChain(values: readonly unknown[], selection: ChainTrust, options: ChainOptions = {}): ChainScan {
  try {
    const items = arrayItems(values);
    const selected = trusts.get(selection);
    if (!selected) refuse('authority-policy', '1', 'Trust selection was not minted here');
    assertOptions(options, ['signatures', 'uniquePayloads', 'family'], []);
    if (options.uniquePayloads !== undefined && typeof options.uniquePayloads !== 'boolean') throw new TypeError('Invalid uniqueness policy');
    if (options.family !== undefined && !['body', 'memory', 'swarm'].includes(options.family)) throw new TypeError('Invalid family policy');
    if (!items.length) refuse('empty-chain', null, 'A trusted chain cannot be empty');
    const frames = items.map((item, i) => {
      try { return intrinsic(typeof item === 'string' || item instanceof Uint8Array ? parseCanonicalJson(item) : item, selected.genesis.stream_id); }
      catch (error) { const e = failure(error).error; throw new FrameError(e.code, e.step, e.message, i); }
    });
    const sequences = new Map<number, RappFrame>();
    const particles = new Set<string>();
    for (let i = 0; i < frames.length; i++) {
      const frame = frames[i]!;
      try {
        if (options.family !== undefined && streamFamily(frame.stream_id) !== options.family) refuse('kind-family', '1', 'Wrong stream family');
        const predecessor = frame.seq > 0 ? sequences.get(frame.seq - 1) : null;
        if (predecessor === undefined) refuse('seq-continuity', '4', 'Missing earlier predecessor');
        continuation(frame, predecessor ? frameHead(predecessor) : null, options.signatures);
        const previous = sequences.get(frame.seq);
        if (previous) {
          if (previous.frame_hash !== frame.frame_hash && previous.prev === frame.prev) refuse('fork', '4', 'Two valid branches share a sequence and predecessor');
          refuse('duplicate-seq', '4', 'Duplicate sequence');
        }
        if (frame.seq !== i) refuse('seq-continuity', '4', 'Chain is not in append order');
        if (options.uniquePayloads && particles.has(frame.payload_hash)) refuse('duplicate-payload-hash', '4', 'Repeated evidence particle');
        sequences.set(frame.seq, frame);
        particles.add(frame.payload_hash);
      } catch (error) { const e = failure(error).error; throw new FrameError(e.code, e.step, e.message, i); }
    }
    const first = frames[0]!;
    if (first.seq !== 0 || first.frame_hash !== selected.genesis.frame_hash
      || first.payload_hash !== selected.genesis.payload_hash) refuse('untrusted-genesis', '4', 'Genesis is not the selected trust anchor');
    const head = frameHead(frames[frames.length - 1]!);
    let persisted: TrustAssessment['persistedHead'] = 'untracked';
    if (selected.persisted) {
      if (head.seq < selected.persisted.seq) refuse('rollback', '4', 'Presented head is below the persisted head');
      const known = sequences.get(selected.persisted.seq);
      if (!known || canonicalJson(frameHead(known)) !== canonicalJson(selected.persisted)) {
        refuse('known-head-conflict', '4', 'Persisted head was replaced');
      }
      persisted = head.seq === selected.persisted.seq ? 'matched' : 'advanced';
      if (selected.requireCommitted && persisted !== 'matched') refuse('uncommitted-head', '4', 'Head exceeds the committed selection');
    } else if (selected.requireCommitted) refuse('uncommitted-head', '4', 'No committed head was selected');
    const result: VerifiedChain = Object.freeze({
      ok: true, frames: Object.freeze(frames), head, trust: trust('trusted', persisted),
    });
    verifiedChains.add(result);
    return result;
  } catch (error) { return failure(error); }
}

export function isVerifiedChain(value: unknown): value is VerifiedChain {
  return typeof value === 'object' && value !== null && verifiedChains.has(value);
}

export function mergeFrames(chains: readonly VerifiedChain[]): readonly RappFrame[] {
  const result: RappFrame[] = [];
  const seen = new Set<string>();
  for (const chain of arrayItems(chains)) {
    if (!isVerifiedChain(chain)) throw new TypeError('Only scanned chains can be merged');
    for (const frame of chain.frames) {
      if (seen.has(frame.frame_hash)) throw new TypeError('Duplicate frame across merge inputs');
      seen.add(frame.frame_hash);
      result.push(frame);
    }
  }
  return Object.freeze(result.sort((a, b) => a.utc < b.utc ? -1 : a.utc > b.utc ? 1
    : a.frame_hash < b.frame_hash ? -1 : a.frame_hash > b.frame_hash ? 1 : 0));
}
