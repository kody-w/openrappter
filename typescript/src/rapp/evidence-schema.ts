import type { JsonObject } from '../rappids/types.js';
import type { RappFrame } from './frame.js';
import { protocolAuthorityIdentity, type ProtocolAuthority } from './authority.js';
import { isRappFrameKind } from './wire.js';

export const OPENRAPPTER_EVIDENCE_SCHEMA = 'openrappter-evidence/1' as const;
export const OPENRAPPTER_EVIDENCE_FRAME_KIND = 'body.pulse' as const;

export interface RappRevisionIdentity extends JsonObject {
  revision: string;
  frame_hash: string;
  payload_hash: string;
}

export interface OpenRappterEvidencePayload extends JsonObject {
  schema: typeof OPENRAPPTER_EVIDENCE_SCHEMA;
  event_kind: string;
  subject: string;
  data_hash: string;
  reference_hashes: string[];
  protocol_revision: RappRevisionIdentity;
}

export type OpenRappterEvidenceFrame = RappFrame<OpenRappterEvidencePayload, typeof OPENRAPPTER_EVIDENCE_FRAME_KIND>;

const HEX64 = /^[0-9a-f]{64}$/;
const PAYLOAD_KEYS = ['schema', 'event_kind', 'subject', 'data_hash', 'reference_hashes', 'protocol_revision'] as const;
const REVISION_KEYS = ['revision', 'frame_hash', 'payload_hash'] as const;
const SAFE_OWN_KEYS = Reflect.ownKeys;
const SAFE_DEFINE_PROPERTY = Object.defineProperty;

function hasExactOwnKeys(value: object, expected: readonly string[]): boolean {
  const keys = SAFE_OWN_KEYS(value);
  if (keys.length !== expected.length) return false;
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (typeof key !== 'string') return false;
    let found = false;
    for (let expectedIndex = 0; expectedIndex < expected.length; expectedIndex += 1) {
      if (expected[expectedIndex] === key) { found = true; break; }
    }
    if (!found) return false;
  }
  return true;
}

export function evidencePayloadProblem(payload: JsonObject, authority: ProtocolAuthority): string | null {
  const authorityIdentity = protocolAuthorityIdentity(authority);
  if (!hasExactOwnKeys(payload, PAYLOAD_KEYS)) return 'openrappter evidence payload does not have its exact key set';
  if (payload.schema !== OPENRAPPTER_EVIDENCE_SCHEMA) return `evidence schema is not ${OPENRAPPTER_EVIDENCE_SCHEMA}`;
  if (!isRappFrameKind(payload.event_kind)) return 'evidence event_kind does not match the RAPP noun.verb grammar';
  if (typeof payload.subject !== 'string' || payload.subject.length === 0) return 'evidence subject must be a non-empty string';
  if (typeof payload.data_hash !== 'string' || !HEX64.test(payload.data_hash)) return 'evidence data_hash is not 64 lowercase hex';
  if (!Array.isArray(payload.reference_hashes)) return 'evidence reference_hashes is not an array';
  const references: string[] = [];
  for (let index = 0; index < payload.reference_hashes.length; index += 1) {
    const hash = payload.reference_hashes[index];
    if (typeof hash !== 'string' || !HEX64.test(hash)) return `evidence reference_hashes[${index}] is not 64 lowercase hex`;
    SAFE_DEFINE_PROPERTY(references, String(index), {
      value: hash, configurable: true, enumerable: true, writable: true,
    });
    if (index > 0 && references[index - 1] >= hash) return 'evidence reference_hashes must be sorted and de-duplicated';
  }
  const revision = payload.protocol_revision;
  if (
    !revision || typeof revision !== 'object' || Array.isArray(revision)
    || (Object.getPrototypeOf(revision) !== Object.prototype && Object.getPrototypeOf(revision) !== null)
    || !hasExactOwnKeys(revision, REVISION_KEYS)
  ) return 'evidence protocol_revision does not have its exact key set';
  if (revision.revision !== authorityIdentity.revision) return `evidence protocol revision is not selected authority ${authorityIdentity.revision}`;
  if (revision.frame_hash !== authorityIdentity.frame_hash) return 'evidence protocol frame_hash does not name the selected authority';
  if (revision.payload_hash !== authorityIdentity.payload_hash) return 'evidence protocol payload_hash does not name the selected authority';
  return null;
}
