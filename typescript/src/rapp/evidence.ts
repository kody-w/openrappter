import type { JsonObject } from '../rappids/types.js';
import { rappCanonicalJson } from '../rappids/canonical.js';
import {
  ACCEPTED_RAPP_PROTOCOL_AUTHORITY,
  isSelectedProtocolAuthority,
  protocolAuthorityIdentity,
  type ProtocolAuthority,
} from './authority.js';
import {
  RappFrameError,
  buildRappFrame,
  createRappFrameProfile,
  isRappFrameKind,
  rappChainTrustAuthority,
  verifyRappFrame,
  verifyRappFrameChain,
  type RappChainTrustPolicy,
  type RappFrame,
  type RappFrameChainVerification,
  type RappFrameHead,
  type RappFrameProfile,
  type RappFrameVerification,
} from './frame.js';

export const OPENRAPPTER_EVIDENCE_SCHEMA = 'openrappter-evidence/1' as const;
export const OPENRAPPTER_EVIDENCE_FRAME_KIND = 'body.pulse' as const;

export interface RappRevisionIdentity extends JsonObject {
  revision: string;
  frame_hash: string;
  payload_hash: string;
}

/**
 * Application payload carried by a RAPP/1 body.pulse frame.
 *
 * This object is evidence data, not another frame or private envelope.
 */
export interface OpenRappterEvidencePayload extends JsonObject {
  schema: typeof OPENRAPPTER_EVIDENCE_SCHEMA;
  event_kind: string;
  subject: string;
  data_hash: string;
  reference_hashes: string[];
  protocol_revision: RappRevisionIdentity;
}

export type OpenRappterEvidenceFrame = RappFrame<
  OpenRappterEvidencePayload,
  typeof OPENRAPPTER_EVIDENCE_FRAME_KIND
>;

export interface BuildRappEvidenceFrameInput {
  streamId: string;
  utc: string;
  eventKind: string;
  subject: string;
  dataHash: string;
  referenceHashes?: readonly string[];
  head: RappFrameHead | null;
  authority?: ProtocolAuthority;
}

const HEX64 = /^[0-9a-f]{64}$/;
const PAYLOAD_KEYS = [
  'schema',
  'event_kind',
  'subject',
  'data_hash',
  'reference_hashes',
  'protocol_revision',
] as const;
const REVISION_KEYS = ['revision', 'frame_hash', 'payload_hash'] as const;
const EVIDENCE_PAYLOAD_OPTION_KEYS = [
  'eventKind',
  'subject',
  'dataHash',
  'referenceHashes',
  'authority',
] as const;
const EVIDENCE_FRAME_INPUT_KEYS = [
  'streamId',
  'utc',
  'eventKind',
  'subject',
  'dataHash',
  'referenceHashes',
  'head',
  'authority',
] as const;
const EVIDENCE_VERIFY_OPTION_KEYS = [
  'head',
  'streamIdOfRecord',
  'authority',
] as const;
const SAFE_OWN_KEYS = Reflect.ownKeys;
const SAFE_GET_OWN_PROPERTY_DESCRIPTOR = Object.getOwnPropertyDescriptor;
const SAFE_HAS_OWN = Object.hasOwn;
const SAFE_DEFINE_PROPERTY = Object.defineProperty;

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && (
      Object.getPrototypeOf(value) === Object.prototype
      || Object.getPrototypeOf(value) === null
    )
  );
}

function evidenceOptionMap(
  value: unknown,
  allowed: readonly string[],
  required: readonly string[],
  label: string,
): asserts value is Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError(`${label} must be a plain object`);
  const keys = SAFE_OWN_KEYS(value);
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    let supported = false;
    if (typeof key === 'string') {
      for (let allowedIndex = 0; allowedIndex < allowed.length; allowedIndex += 1) {
        if (allowed[allowedIndex] === key) {
          supported = true;
          break;
        }
      }
    }
    if (!supported) {
      throw new TypeError(`${label} contains unsupported own key ${String(key)}`);
    }
    const descriptor = SAFE_GET_OWN_PROPERTY_DESCRIPTOR(value, key as string);
    if (descriptor === undefined || !SAFE_HAS_OWN(descriptor, 'value')) {
      throw new TypeError(`${label}.${String(key)} must be an own data property`);
    }
  }
  for (let index = 0; index < required.length; index += 1) {
    const key = required[index];
    if (SAFE_GET_OWN_PROPERTY_DESCRIPTOR(value, key) === undefined) {
      throw new TypeError(`${label} is missing own key ${key}`);
    }
  }
}

function evidenceOwn(value: Record<string, unknown>, key: string): unknown {
  const descriptor = SAFE_GET_OWN_PROPERTY_DESCRIPTOR(value, key);
  return descriptor !== undefined && SAFE_HAS_OWN(descriptor, 'value')
    ? descriptor.value
    : undefined;
}

function safeArraySet<TValue>(
  values: TValue[],
  index: number,
  value: TValue,
): void {
  SAFE_DEFINE_PROPERTY(values, String(index), {
    value,
    configurable: true,
    enumerable: true,
    writable: true,
  });
}

function hasExactOwnKeys(
  value: object,
  expected: readonly string[],
): boolean {
  const keys = SAFE_OWN_KEYS(value);
  if (keys.length !== expected.length) return false;
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (typeof key !== 'string') return false;
    let found = false;
    for (let expectedIndex = 0; expectedIndex < expected.length; expectedIndex += 1) {
      if (expected[expectedIndex] === key) {
        found = true;
        break;
      }
    }
    if (!found) return false;
  }
  return true;
}

function evidencePayloadProblem(
  payload: JsonObject,
  authority: ProtocolAuthority,
): string | null {
  const authorityIdentity = protocolAuthorityIdentity(authority);
  if (!hasExactOwnKeys(payload, PAYLOAD_KEYS)) {
    return 'openrappter evidence payload does not have its exact key set';
  }
  if (payload.schema !== OPENRAPPTER_EVIDENCE_SCHEMA) {
    return `evidence schema is not ${OPENRAPPTER_EVIDENCE_SCHEMA}`;
  }
  if (!isRappFrameKind(payload.event_kind)) {
    return 'evidence event_kind does not match the RAPP noun.verb grammar';
  }
  if (typeof payload.subject !== 'string' || payload.subject.length === 0) {
    return 'evidence subject must be a non-empty string';
  }
  if (typeof payload.data_hash !== 'string' || !HEX64.test(payload.data_hash)) {
    return 'evidence data_hash is not 64 lowercase hex';
  }
  if (!Array.isArray(payload.reference_hashes)) {
    return 'evidence reference_hashes is not an array';
  }
  const references: string[] = [];
  for (let index = 0; index < payload.reference_hashes.length; index += 1) {
    const hash = payload.reference_hashes[index];
    if (typeof hash !== 'string' || !HEX64.test(hash)) {
      return `evidence reference_hashes[${index}] is not 64 lowercase hex`;
    }
    safeArraySet(references, index, hash);
    if (index > 0 && references[index - 1] >= hash) {
      return 'evidence reference_hashes must be sorted and de-duplicated';
    }
  }

  const revision = payload.protocol_revision;
  if (!isRecord(revision) || !hasExactOwnKeys(revision, REVISION_KEYS)) {
    return 'evidence protocol_revision does not have its exact key set';
  }
  if (revision.revision !== authorityIdentity.revision) {
    return `evidence protocol revision is not selected authority ${authorityIdentity.revision}`;
  }
  if (revision.frame_hash !== authorityIdentity.frame_hash) {
    return 'evidence protocol frame_hash does not name the selected authority';
  }
  if (revision.payload_hash !== authorityIdentity.payload_hash) {
    return 'evidence protocol payload_hash does not name the selected authority';
  }
  return null;
}

function validateEvidencePayload(
  payload: JsonObject,
  authority: ProtocolAuthority,
):
  | { ok: true; payload: OpenRappterEvidencePayload }
  | { ok: false; error: string } {
  const error = evidencePayloadProblem(payload, authority);
  return error === null
    ? { ok: true, payload: payload as OpenRappterEvidencePayload }
    : { ok: false, error };
}

interface EvidenceProfileNode {
  authority: ProtocolAuthority;
  profile: Readonly<RappFrameProfile<
    OpenRappterEvidencePayload,
    typeof OPENRAPPTER_EVIDENCE_FRAME_KIND
  >>;
  next: EvidenceProfileNode | null;
}
let evidenceProfiles: EvidenceProfileNode | null = null;

export function createOpenRappterEvidenceProfile(
  authority: ProtocolAuthority = ACCEPTED_RAPP_PROTOCOL_AUTHORITY,
): Readonly<RappFrameProfile<
  OpenRappterEvidencePayload,
  typeof OPENRAPPTER_EVIDENCE_FRAME_KIND
>> {
  if (!isSelectedProtocolAuthority(authority)) {
    throw new TypeError('evidence profiles require an immutable selected ProtocolAuthority');
  }
  let cached = evidenceProfiles;
  while (cached !== null) {
    if (cached.authority === authority) return cached.profile;
    cached = cached.next;
  }
  const authorityIdentity = protocolAuthorityIdentity(authority);
  const profile = createRappFrameProfile({
    name: `${OPENRAPPTER_EVIDENCE_SCHEMA}:${authorityIdentity.revision}`,
    kind: OPENRAPPTER_EVIDENCE_FRAME_KIND,
    authority,
    signature: 'unsigned-local',
    uniquePayloads: true,
    validatePayload: (payload) => validateEvidencePayload(payload, authority),
  });
  const node = Object.create(null) as EvidenceProfileNode;
  SAFE_DEFINE_PROPERTY(node, 'authority', { value: authority, enumerable: true });
  SAFE_DEFINE_PROPERTY(node, 'profile', { value: profile, enumerable: true });
  SAFE_DEFINE_PROPERTY(node, 'next', { value: evidenceProfiles, enumerable: true });
  evidenceProfiles = Object.freeze(node);
  return profile;
}

export const OPENRAPPTER_EVIDENCE_PROFILE =
  createOpenRappterEvidenceProfile();

export function buildOpenRappterEvidencePayload(input: {
  eventKind: string;
  subject: string;
  dataHash: string;
  referenceHashes?: readonly string[];
  authority?: ProtocolAuthority;
}): OpenRappterEvidencePayload {
  evidenceOptionMap(
    input,
    EVIDENCE_PAYLOAD_OPTION_KEYS,
    ['eventKind', 'subject', 'dataHash'],
    'evidence payload input',
  );
  const eventKind = evidenceOwn(input, 'eventKind');
  const subject = evidenceOwn(input, 'subject');
  const dataHash = evidenceOwn(input, 'dataHash');
  const referenceHashes = evidenceOwn(input, 'referenceHashes');
  const rawAuthority = evidenceOwn(input, 'authority');
  if (
    typeof eventKind !== 'string'
    || typeof subject !== 'string'
    || typeof dataHash !== 'string'
    || (
      referenceHashes !== undefined
      && (
        !Array.isArray(referenceHashes)
        || (() => {
          for (let index = 0; index < referenceHashes.length; index += 1) {
            if (typeof referenceHashes[index] !== 'string') return true;
          }
          return false;
        })()
      )
    )
  ) {
    throw new TypeError('evidence payload input has invalid own properties');
  }
  const authority =
    rawAuthority === undefined
      ? ACCEPTED_RAPP_PROTOCOL_AUTHORITY
      : rawAuthority as ProtocolAuthority;
  if (!isSelectedProtocolAuthority(authority)) {
    throw new TypeError('evidence payloads require an immutable selected ProtocolAuthority');
  }
  const references: string[] = [];
  if (referenceHashes !== undefined) {
    for (let index = 0; index < referenceHashes.length; index += 1) {
      safeArraySet(references, index, referenceHashes[index] as string);
    }
  }
  const payload: OpenRappterEvidencePayload = {
    schema: OPENRAPPTER_EVIDENCE_SCHEMA,
    event_kind: eventKind,
    subject,
    data_hash: dataHash,
    reference_hashes: references,
    protocol_revision: { ...protocolAuthorityIdentity(authority) },
  };
  const problem = evidencePayloadProblem(payload, authority);
  if (problem !== null) {
    throw new RappFrameError('payload-profile', '1', problem);
  }
  try {
    rappCanonicalJson(payload);
  } catch (error) {
    throw new RappFrameError(
      'canonical',
      '1',
      error instanceof Error ? error.message : 'evidence payload is outside the RAPP/1 canonical domain',
    );
  }
  Object.freeze(payload.reference_hashes);
  Object.freeze(payload.protocol_revision);
  return Object.freeze(payload);
}

export function buildRappEvidenceFrame(
  input: BuildRappEvidenceFrameInput,
): OpenRappterEvidenceFrame {
  evidenceOptionMap(
    input,
    EVIDENCE_FRAME_INPUT_KEYS,
    ['streamId', 'utc', 'eventKind', 'subject', 'dataHash', 'head'],
    'evidence frame input',
  );
  const rawAuthority = evidenceOwn(input, 'authority');
  const authority =
    rawAuthority === undefined
      ? ACCEPTED_RAPP_PROTOCOL_AUTHORITY
      : rawAuthority as ProtocolAuthority;
  const profile = createOpenRappterEvidenceProfile(authority);
  return buildRappFrame({
    kind: OPENRAPPTER_EVIDENCE_FRAME_KIND,
    streamId: evidenceOwn(input, 'streamId') as string,
    utc: evidenceOwn(input, 'utc') as string,
    payload: buildOpenRappterEvidencePayload({
      eventKind: evidenceOwn(input, 'eventKind') as string,
      subject: evidenceOwn(input, 'subject') as string,
      dataHash: evidenceOwn(input, 'dataHash') as string,
      referenceHashes: evidenceOwn(input, 'referenceHashes') as string[] | undefined,
      authority,
    }),
    head: evidenceOwn(input, 'head') as RappFrameHead | null,
  }, profile);
}

export function verifyRappEvidenceFrame(
  value: unknown,
  options: {
    head: RappFrameHead | null;
    streamIdOfRecord: string;
    authority?: ProtocolAuthority;
  },
): RappFrameVerification<OpenRappterEvidenceFrame> {
  try {
    evidenceOptionMap(
      options,
      EVIDENCE_VERIFY_OPTION_KEYS,
      ['head', 'streamIdOfRecord'],
      'evidence verification options',
    );
  } catch (error) {
    return {
      ok: false,
      error: new RappFrameError(
        'profile',
        '1',
        error instanceof Error ? error.message : 'evidence verification options are invalid',
      ),
    };
  }
  const rawAuthority = evidenceOwn(options, 'authority');
  let profile: Readonly<RappFrameProfile<
    OpenRappterEvidencePayload,
    typeof OPENRAPPTER_EVIDENCE_FRAME_KIND
  >>;
  try {
    profile = createOpenRappterEvidenceProfile(
      rawAuthority === undefined
        ? ACCEPTED_RAPP_PROTOCOL_AUTHORITY
        : rawAuthority as ProtocolAuthority,
    );
  } catch (error) {
    return {
      ok: false,
      error: new RappFrameError(
        'authority-policy',
        '1',
        error instanceof Error ? error.message : 'evidence authority is invalid',
      ),
    };
  }
  return verifyRappFrame(
    value,
    profile,
    {
      head: evidenceOwn(options, 'head') as RappFrameHead | null,
      streamIdOfRecord: evidenceOwn(options, 'streamIdOfRecord') as string,
    },
  );
}

export function assertRappEvidenceFrame(
  value: unknown,
  options: {
    head: RappFrameHead | null;
    streamIdOfRecord: string;
    authority?: ProtocolAuthority;
  },
): OpenRappterEvidenceFrame {
  const result = verifyRappEvidenceFrame(value, options);
  if (!result.ok) throw result.error;
  return result.frame;
}

export function verifyRappEvidenceChain(
  values: readonly unknown[],
  policy: RappChainTrustPolicy,
): RappFrameChainVerification<OpenRappterEvidenceFrame> {
  let authority: ProtocolAuthority;
  try {
    authority = rappChainTrustAuthority(policy);
  } catch (error) {
    return {
      ok: false,
      error: new RappFrameError(
        'authority-policy',
        '1',
        error instanceof Error ? error.message : 'evidence trust policy is invalid',
      ),
    };
  }
  return verifyRappFrameChain(
    values,
    createOpenRappterEvidenceProfile(authority),
    policy,
  );
}

export function assertRappEvidenceChain(
  values: readonly unknown[],
  policy: RappChainTrustPolicy,
): readonly OpenRappterEvidenceFrame[] {
  const result = verifyRappEvidenceChain(values, policy);
  if (!result.ok) throw result.error;
  return result.frames;
}
