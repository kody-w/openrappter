import { AUTHORITY_IDENTITY, type AuthorityIdentity } from './authority.js';
import {
  arrayItems, assertOptions, canonicalJson, hashValue, PARTICLE_DOMAIN, snapshotJson, type JsonObject,
} from './json.js';
import { HEX64, isKind } from './identity.js';
import {
  buildFrame, isVerifiedChain, type FrameHead, type RappFrame, type VerifiedChain,
} from './frame.js';

// This normative payload token is hashed and must never be product-renamed.
export const EVIDENCE_SCHEMA = 'openrappter-evidence/1';
export interface EvidencePayload extends JsonObject {
  schema: typeof EVIDENCE_SCHEMA;
  event_kind: string;
  subject: string;
  data_hash: string;
  reference_hashes: string[];
  protocol_revision: AuthorityIdentity;
}

export function validateEvidencePayload(value: unknown): EvidencePayload {
  const payload = snapshotJson(value);
  assertOptions(payload, ['schema', 'event_kind', 'subject', 'data_hash', 'reference_hashes', 'protocol_revision']);
  if (payload.schema !== EVIDENCE_SCHEMA || !isKind(payload.event_kind)
    || typeof payload.subject !== 'string' || payload.subject.length === 0
    || typeof payload.data_hash !== 'string' || !HEX64.test(payload.data_hash)
    || !Array.isArray(payload.reference_hashes)
    || canonicalJson(payload.protocol_revision) !== canonicalJson(AUTHORITY_IDENTITY)) {
    throw new TypeError('Invalid evidence payload or authority');
  }
  let previous = '';
  for (const hash of payload.reference_hashes) {
    if (typeof hash !== 'string' || !HEX64.test(hash) || hash <= previous) {
      throw new TypeError('Evidence references must be sorted unique lowercase hashes');
    }
    previous = hash;
  }
  return payload as unknown as EvidencePayload;
}

export function buildEvidencePayload(input: {
  eventKind: string; subject: string; dataHash: string; referenceHashes: readonly string[];
}): EvidencePayload {
  assertOptions(input, ['eventKind', 'subject', 'dataHash', 'referenceHashes']);
  return validateEvidencePayload({
    schema: EVIDENCE_SCHEMA, event_kind: input.eventKind, subject: input.subject,
    data_hash: input.dataHash, reference_hashes: input.referenceHashes, protocol_revision: AUTHORITY_IDENTITY,
  });
}

export function buildEvidenceFrame(input: {
  streamId: string; utc: string; head: FrameHead | null;
  eventKind: string; subject: string; dataHash: string; referenceHashes: readonly string[];
}): RappFrame<EvidencePayload> {
  assertOptions(input, ['streamId', 'utc', 'head', 'eventKind', 'subject', 'dataHash', 'referenceHashes']);
  return buildFrame({
    kind: 'body.pulse', streamId: input.streamId, utc: input.utc, head: input.head,
    payload: buildEvidencePayload({
      eventKind: input.eventKind, subject: input.subject, dataHash: input.dataHash,
      referenceHashes: input.referenceHashes,
    }),
  });
}

declare const evidenceContextBrand: unique symbol;
export interface EvidenceContext { readonly [evidenceContextBrand]: true }
interface EvidenceIndex {
  body: VerifiedChain;
  source: VerifiedChain;
  bodyFrames: Map<string, RappFrame>;
  sourceFrames: Map<string, RappFrame>;
}
const evidenceContexts = new WeakMap<object, EvidenceIndex>();

/** Reuses validated indexes for one exact pair of immutable, scanned chains. */
export function prepareEvidenceContext(body: VerifiedChain, source: VerifiedChain): EvidenceContext {
  if (!isVerifiedChain(body) || !isVerifiedChain(source) || body.trust.persistedHead !== 'matched' || source.trust.persistedHead !== 'matched') {
    throw new TypeError('Evidence requires scanned committed chains');
  }
  const seen = new Set<string>();
  for (const frame of body.frames) {
    if (frame.payload.schema !== EVIDENCE_SCHEMA) continue;
    validateEvidencePayload(frame.payload);
    if (seen.has(frame.payload_hash)) throw new TypeError('Replayed evidence particle');
    seen.add(frame.payload_hash);
  }
  const token = Object.freeze(Object.create(null)) as EvidenceContext;
  evidenceContexts.set(token, {
    body, source, bodyFrames: new Map(body.frames.map((frame) => [frame.frame_hash, frame])),
    sourceFrames: new Map(source.frames.map((frame) => [frame.frame_hash, frame])),
  });
  return token;
}

/** Binds the exact source occurrence; integrity does not certify factual truth. */
export function verifyEvidenceLink(input: {
  body: VerifiedChain; source: VerifiedChain; sourceFrameHash: string; evidenceFrameHash: string;
  subject: string; eventKind: string; data: JsonObject; requiredReferences?: readonly string[];
}, context?: EvidenceContext): RappFrame<EvidencePayload> {
  assertOptions(input, ['body', 'source', 'sourceFrameHash', 'evidenceFrameHash', 'subject', 'eventKind', 'data', 'requiredReferences'],
    ['body', 'source', 'sourceFrameHash', 'evidenceFrameHash', 'subject', 'eventKind', 'data']);
  if (!isVerifiedChain(input.body) || !isVerifiedChain(input.source)
    || input.body.trust.persistedHead !== 'matched' || input.source.trust.persistedHead !== 'matched') {
    throw new TypeError('Evidence requires scanned committed chains');
  }
  const selection = context ?? prepareEvidenceContext(input.body, input.source);
  const index = evidenceContexts.get(selection);
  if (!index || index.body !== input.body || index.source !== input.source) throw new TypeError('Evidence context belongs to different chains');
  const source = index.sourceFrames.get(input.sourceFrameHash);
  const evidence = index.bodyFrames.get(input.evidenceFrameHash);
  if (!source || !evidence || evidence.kind !== 'body.pulse'
    || !source.stream_id.startsWith(`${evidence.stream_id}:`) || evidence.utc < source.utc) {
    throw new TypeError('Evidence and source must be present and owned by the same producer');
  }
  const payload = validateEvidencePayload(evidence.payload);
  if (payload.subject !== input.subject || payload.event_kind !== input.eventKind
    || payload.data_hash !== hashValue(PARTICLE_DOMAIN, input.data)) throw new TypeError('Evidence data binding mismatch');
  if (source.payload.subject !== input.subject || canonicalJson(source.payload.data) !== canonicalJson(input.data)
    || canonicalJson(source.payload.protocol_revision) !== canonicalJson(AUTHORITY_IDENTITY)) {
    throw new TypeError('Source payload does not bind the claimed subject, data and authority');
  }
  const required = arrayItems(input.requiredReferences ?? [], 256);
  for (const hash of required) {
    if (typeof hash !== 'string' || !HEX64.test(hash)) throw new TypeError('Required evidence reference is not a hash');
  }
  for (const hash of [source.payload_hash, source.frame_hash, ...required as string[]]) {
    if (!payload.reference_hashes.includes(hash)) throw new TypeError('Evidence is missing an exact occurrence reference');
  }
  return evidence as RappFrame<EvidencePayload>;
}
