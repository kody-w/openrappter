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
  assertRappFrameChain,
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
].sort().join('\0');
const REVISION_KEYS = ['revision', 'frame_hash', 'payload_hash'].sort().join('\0');
const EVIDENCE_PAYLOAD_OPTION_KEYS = new Set([
  'eventKind',
  'subject',
  'dataHash',
  'referenceHashes',
  'authority',
]);
const EVIDENCE_FRAME_INPUT_KEYS = new Set([
  'streamId',
  'utc',
  'eventKind',
  'subject',
  'dataHash',
  'referenceHashes',
  'head',
  'authority',
]);
const EVIDENCE_VERIFY_OPTION_KEYS = new Set([
  'head',
  'streamIdOfRecord',
  'authority',
]);

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
  allowed: ReadonlySet<string>,
  required: readonly string[],
  label: string,
): asserts value is Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError(`${label} must be a plain object`);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.has(key)) {
      throw new TypeError(`${label} contains unsupported own key ${String(key)}`);
    }
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) {
      throw new TypeError(`${label} is missing own key ${key}`);
    }
  }
}

function evidenceOwn(value: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(value, key) ? value[key] : undefined;
}

function evidencePayloadProblem(
  payload: JsonObject,
  authority: ProtocolAuthority,
): string | null {
  const authorityIdentity = protocolAuthorityIdentity(authority);
  if (Object.keys(payload).sort().join('\0') !== PAYLOAD_KEYS) {
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
  for (const [index, hash] of payload.reference_hashes.entries()) {
    if (typeof hash !== 'string' || !HEX64.test(hash)) {
      return `evidence reference_hashes[${index}] is not 64 lowercase hex`;
    }
    references.push(hash);
  }
  if (
    references.join('\0')
    !== [...new Set(references)].sort().join('\0')
  ) {
    return 'evidence reference_hashes must be sorted and de-duplicated';
  }

  const revision = payload.protocol_revision;
  if (!isRecord(revision) || Object.keys(revision).sort().join('\0') !== REVISION_KEYS) {
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

export function createOpenRappterEvidenceProfile(
  authority: ProtocolAuthority = ACCEPTED_RAPP_PROTOCOL_AUTHORITY,
): Readonly<RappFrameProfile<
  OpenRappterEvidencePayload,
  typeof OPENRAPPTER_EVIDENCE_FRAME_KIND
>> {
  if (!isSelectedProtocolAuthority(authority)) {
    throw new TypeError('evidence profiles require an immutable selected ProtocolAuthority');
  }
  const authorityIdentity = protocolAuthorityIdentity(authority);
  return createRappFrameProfile({
    name: `${OPENRAPPTER_EVIDENCE_SCHEMA}:${authorityIdentity.revision}`,
    kind: OPENRAPPTER_EVIDENCE_FRAME_KIND,
    authority,
    signature: 'unsigned-local',
    uniquePayloads: true,
    validatePayload: (payload) => validateEvidencePayload(payload, authority),
  });
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
        || referenceHashes.some((value) => typeof value !== 'string')
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
  const payload: OpenRappterEvidencePayload = {
    schema: OPENRAPPTER_EVIDENCE_SCHEMA,
    event_kind: eventKind,
    subject,
    data_hash: dataHash,
    reference_hashes: [...(referenceHashes ?? [])],
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
  return verifyRappFrame(
    value,
    createOpenRappterEvidenceProfile(
      rawAuthority === undefined
        ? ACCEPTED_RAPP_PROTOCOL_AUTHORITY
        : rawAuthority as ProtocolAuthority,
    ),
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
  const authority = rappChainTrustAuthority(policy);
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
  const authority = rappChainTrustAuthority(policy);
  return assertRappFrameChain(
    values,
    createOpenRappterEvidenceProfile(authority),
    policy,
  );
}
