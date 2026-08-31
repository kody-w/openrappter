import type { JsonObject } from '../rappids/types.js';
import { rappCanonicalJson } from '../rappids/canonical.js';
import {
  ACCEPTED_RAPP_PROTOCOL_AUTHORITY,
  ProtocolAuthority,
} from './authority.js';
import {
  RappFrameError,
  assertRappFrame,
  assertRappFrameChain,
  buildRappFrame,
  createRappFrameProfile,
  isRappFrameKind,
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

function evidencePayloadProblem(
  payload: JsonObject,
  authority: ProtocolAuthority,
): string | null {
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
  if (revision.revision !== authority.revision) {
    return `evidence protocol revision is not selected authority ${authority.revision}`;
  }
  if (revision.frame_hash !== authority.frameHash) {
    return 'evidence protocol frame_hash does not name the selected authority';
  }
  if (revision.payload_hash !== authority.payloadHash) {
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
  return createRappFrameProfile({
    name: `${OPENRAPPTER_EVIDENCE_SCHEMA}:${authority.revision}`,
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
  const authority = input.authority ?? ACCEPTED_RAPP_PROTOCOL_AUTHORITY;
  const payload: OpenRappterEvidencePayload = {
    schema: OPENRAPPTER_EVIDENCE_SCHEMA,
    event_kind: input.eventKind,
    subject: input.subject,
    data_hash: input.dataHash,
    reference_hashes: [...(input.referenceHashes ?? [])],
    protocol_revision: { ...authority.identity() },
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
  const authority = input.authority ?? ACCEPTED_RAPP_PROTOCOL_AUTHORITY;
  const profile = createOpenRappterEvidenceProfile(authority);
  return buildRappFrame({
    kind: OPENRAPPTER_EVIDENCE_FRAME_KIND,
    streamId: input.streamId,
    utc: input.utc,
    payload: buildOpenRappterEvidencePayload({ ...input, authority }),
    head: input.head,
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
  return verifyRappFrame(
    value,
    createOpenRappterEvidenceProfile(
      options.authority ?? ACCEPTED_RAPP_PROTOCOL_AUTHORITY,
    ),
    options,
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
  return assertRappFrame(
    value,
    createOpenRappterEvidenceProfile(
      options.authority ?? ACCEPTED_RAPP_PROTOCOL_AUTHORITY,
    ),
    options,
  );
}

export function verifyRappEvidenceChain(
  values: readonly unknown[],
  policy: RappChainTrustPolicy,
): RappFrameChainVerification<OpenRappterEvidenceFrame> {
  return verifyRappFrameChain(
    values,
    createOpenRappterEvidenceProfile(policy.authority),
    policy,
  );
}

export function assertRappEvidenceChain(
  values: readonly unknown[],
  policy: RappChainTrustPolicy,
): readonly OpenRappterEvidenceFrame[] {
  return assertRappFrameChain(
    values,
    createOpenRappterEvidenceProfile(policy.authority),
    policy,
  );
}
