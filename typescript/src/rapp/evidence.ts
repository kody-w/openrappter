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
  rappChainTrustAuthority,
  verifyRappFrame,
  verifyRappFrameChain,
  type RappChainTrustPolicy,
  type RappFrameChainVerification,
  type RappFrameHead,
  type RappFrameProfile,
  type RappFrameVerification,
} from './frame.js';

import {
  OPENRAPPTER_EVIDENCE_SCHEMA, OPENRAPPTER_EVIDENCE_FRAME_KIND,
  evidencePayloadProblem,
  type OpenRappterEvidencePayload, type OpenRappterEvidenceFrame,
} from './evidence-schema.js';
export {
  OPENRAPPTER_EVIDENCE_SCHEMA, OPENRAPPTER_EVIDENCE_FRAME_KIND,
  type RappRevisionIdentity, type OpenRappterEvidencePayload, type OpenRappterEvidenceFrame,
} from './evidence-schema.js';

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
