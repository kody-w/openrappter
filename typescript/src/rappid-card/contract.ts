import {
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify,
} from 'node:crypto';

import { canonicalJson, sha256Hex } from '../rappids/canonical.js';
import type { JsonValue } from '../rappids/types.js';
import {
  RAPPID_CARD_AUTHORIZATION_SCHEMA,
  RAPPID_CARD_POLICY_SCHEMA,
  RAPPID_CARD_PRODUCTION_PROFILE,
  RAPPID_CARD_REVOCATIONS_SCHEMA,
  RAPPID_CARD_SCHEMA,
  RAPPID_CARD_TEST_PROFILE,
  RappidCardError,
} from './types.js';
import type {
  CardAlgorithm,
  CardClassification,
  CardMediaType,
  CardPartName,
  CardProfile,
  CardScope,
  ParsedRappidCardLink,
  RappidCardAuthorization,
  RappidCardManifest,
  RappidCardPolicy,
  RappidCardRevocations,
  RappidCardSignature,
} from './types.js';

export const CARD_SIGNATURE_DOMAIN = 'rappid-card/1:signature';
export const CARD_POLICY_SIGNATURE_DOMAIN = 'rappid-card/1:policy';
export const CARD_AUTHORIZATION_SIGNATURE_DOMAIN = 'rappid-card/1:authorization';
export const CARD_REVOCATIONS_SIGNATURE_DOMAIN = 'rappid-card/1:revocations';
export const CARD_CHALLENGE_DOMAIN = 'rappid-card/1:continuity';

const HEX_32 = /^[0-9a-f]{32}$/;
const HEX_64 = /^[0-9a-f]{64}$/;
const BASE64URL_32 = /^[A-Za-z0-9_-]{43}$/;
const BASE64URL_64 = /^[A-Za-z0-9_-]{86}$/;
const ENDPOINT_PATH = /^\/[A-Za-z0-9._~/-]*$/;
const KEY_ID = /^[a-z][a-z0-9._-]{0,63}$/;
const POLICY_ID = /^[a-z][a-z0-9._-]{0,63}$/;
const AUTHORIZATION_ID = /^[a-z][a-z0-9._-]{0,63}$/;
const RAPPID =
  /^rappid:@[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?\/[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?:[0-9a-f]{64}$/;
const PROTOCOL = /^rappid-link\/[1-9][0-9]*$/;
const SEMVER = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const RFC3339_UTC =
  /^(?:[0-9]{4})-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]Z$/;
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

const PROFILES = new Set<CardProfile>([
  RAPPID_CARD_TEST_PROFILE,
  RAPPID_CARD_PRODUCTION_PROFILE,
]);
const CLASSIFICATIONS = new Set<CardClassification>([
  'public',
  'internal',
  'restricted',
]);
const SCOPES = new Set<CardScope>([
  'identity:read',
  'traits:read',
  'skill:hydrate',
  'sonic:hydrate',
  'capability:hydrate',
]);
const PART_NAMES = new Set<CardPartName>([
  'identity',
  'traits',
  'skill-manifest',
  'sonic-profile',
  'capability-manifest',
]);
const MEDIA_TYPES = new Set<CardMediaType>([
  'application/json',
  'text/plain',
  'application/vnd.rapp.skill+json',
  'application/vnd.rapp.sonic+json',
  'application/vnd.rapp.capability+json',
]);
const ALGORITHMS = new Set<CardAlgorithm>([
  'ed25519-test',
  'ed25519',
]);

type JsonRecord = Record<string, unknown>;
type Unsigned<T extends { signature: RappidCardSignature }> = Omit<T, 'signature'>;

function objectAt(value: unknown, path: string): JsonRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new RappidCardError('schema_invalid', `${path} must be an object`);
  }
  return value as JsonRecord;
}

function closedObject(
  value: unknown,
  path: string,
  required: readonly string[],
): JsonRecord {
  const object = objectAt(value, path);
  const keys = Object.keys(object).sort();
  const expected = [...required].sort();
  if (
    keys.length !== expected.length
    || keys.some((key, index) => key !== expected[index])
  ) {
    const unexpected = keys.filter((key) => !expected.includes(key));
    const missing = expected.filter((key) => !keys.includes(key));
    const detail = [
      unexpected.length ? `unexpected ${unexpected.join(', ')}` : '',
      missing.length ? `missing ${missing.join(', ')}` : '',
    ].filter(Boolean).join('; ');
    throw new RappidCardError(
      'schema_invalid',
      `${path} is closed${detail ? `: ${detail}` : ''}`,
    );
  }
  return object;
}

function stringAt(
  object: JsonRecord,
  key: string,
  path: string,
  pattern?: RegExp,
): string {
  const value = object[key];
  if (typeof value !== 'string' || (pattern && !pattern.test(value))) {
    throw new RappidCardError('schema_invalid', `${path}.${key} is invalid`);
  }
  return value;
}

function integerAt(object: JsonRecord, key: string, path: string): number {
  const value = object[key];
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new RappidCardError('schema_invalid', `${path}.${key} is invalid`);
  }
  return value as number;
}

function enumAt<T extends string>(
  object: JsonRecord,
  key: string,
  path: string,
  values: Set<T>,
): T {
  const value = stringAt(object, key, path);
  if (!values.has(value as T)) {
    throw new RappidCardError('schema_invalid', `${path}.${key} is invalid`);
  }
  return value as T;
}

function stringArrayAt<T extends string>(
  object: JsonRecord,
  key: string,
  path: string,
  options: {
    values?: Set<T>;
    pattern?: RegExp;
    minimum?: number;
    maximum?: number;
  } = {},
): T[] {
  const value = object[key];
  const minimum = options.minimum ?? 0;
  const maximum = options.maximum ?? 64;
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    throw new RappidCardError(
      'schema_invalid',
      `${path}.${key} must contain ${minimum}..${maximum} items`,
    );
  }
  const result = value.map((item, index) => {
    if (
      typeof item !== 'string'
      || (options.values && !options.values.has(item as T))
      || (options.pattern && !options.pattern.test(item))
    ) {
      throw new RappidCardError(
        'schema_invalid',
        `${path}.${key}[${index}] is invalid`,
      );
    }
    return item as T;
  });
  if (new Set(result).size !== result.length) {
    throw new RappidCardError('schema_invalid', `${path}.${key} must be unique`);
  }
  return result;
}

function validateSignature(value: unknown, path: string): RappidCardSignature {
  const object = closedObject(value, path, ['algorithm', 'keyId', 'value']);
  return {
    algorithm: enumAt(object, 'algorithm', path, ALGORITHMS),
    keyId: stringAt(object, 'keyId', path, KEY_ID),
    value: stringAt(object, 'value', path, BASE64URL_64),
  };
}

function validateAuthenticator(
  value: unknown,
  path: string,
): { algorithm: CardAlgorithm; keyId: string } {
  const object = closedObject(value, path, ['algorithm', 'keyId']);
  return {
    algorithm: enumAt(object, 'algorithm', path, ALGORITHMS),
    keyId: stringAt(object, 'keyId', path, KEY_ID),
  };
}

function validateTimestamp(value: string, path: string): void {
  const timestamp = Date.parse(value);
  if (
    !RFC3339_UTC.test(value)
    || Number.isNaN(timestamp)
    || new Date(timestamp).toISOString().replace('.000Z', 'Z') !== value
  ) {
    throw new RappidCardError('schema_invalid', `${path} must be UTC RFC3339 seconds`);
  }
}

function validateWindow(start: string, end: string, path: string): void {
  validateTimestamp(start, `${path}.start`);
  validateTimestamp(end, `${path}.end`);
  if (Date.parse(end) <= Date.parse(start)) {
    throw new RappidCardError('schema_invalid', `${path} end must be later than start`);
  }
}

function validateRuntime(value: unknown, path: string): RappidCardManifest['runtime'] {
  const runtime = closedObject(value, path, ['name', 'minimum', 'maximum']);
  const result = {
    name: stringAt(runtime, 'name', path, /^[a-z][a-z0-9-]{0,31}$/),
    minimum: stringAt(runtime, 'minimum', path, SEMVER),
    maximum: stringAt(runtime, 'maximum', path, SEMVER),
  };
  if (compareSemver(result.minimum, result.maximum) > 0) {
    throw new RappidCardError(
      'schema_invalid',
      `${path}.minimum must not exceed maximum`,
    );
  }
  return result;
}

export function validateOrigin(value: string, path = 'origin'): string {
  if (value.length > 200 || value.includes('%')) {
    throw new RappidCardError('schema_invalid', `${path} is invalid`);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new RappidCardError('schema_invalid', `${path} is invalid`);
  }
  if (
    url.protocol !== 'https:'
    || url.username !== ''
    || url.password !== ''
    || url.pathname !== '/'
    || url.search !== ''
    || url.hash !== ''
    || url.origin !== value
  ) {
    throw new RappidCardError('schema_invalid', `${path} is invalid`);
  }
  return value;
}

export function validateEndpoint(value: string, path = 'card.endpoint'): string {
  if (value.length > 256 || value.includes('%')) {
    throw new RappidCardError('endpoint_invalid', `${path} is not a canonical HTTPS URL`);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new RappidCardError('endpoint_invalid', `${path} is not a canonical HTTPS URL`);
  }
  if (
    url.username !== ''
    || url.password !== ''
    || url.search !== ''
    || url.hash !== ''
  ) {
    throw new RappidCardError(
      'endpoint_secret_forbidden',
      `${path} must not contain userinfo, query parameters, or fragments`,
    );
  }
  if (
    url.protocol !== 'https:'
    || !ENDPOINT_PATH.test(url.pathname)
    || url.href !== value
  ) {
    throw new RappidCardError('endpoint_invalid', `${path} is not a canonical HTTPS URL`);
  }
  return value;
}

export function endpointOrigin(endpoint: string): string {
  return new URL(validateEndpoint(endpoint)).origin;
}

function approvedOriginsAt(
  object: JsonRecord,
  key: string,
  path: string,
): string[] {
  return stringArrayAt<string>(object, key, path, {
    minimum: 1,
    maximum: 16,
  }).map((origin, index) => validateOrigin(origin, `${path}.${key}[${index}]`));
}

function assertNoDuplicateJsonKeys(raw: string): void {
  let index = 0;
  const whitespace = () => {
    while (/\s/.test(raw[index] ?? '')) index += 1;
  };
  const string = (): string => {
    const start = index;
    index += 1;
    while (index < raw.length) {
      if (raw[index] === '\\') {
        index += 2;
        continue;
      }
      if (raw[index] === '"') {
        index += 1;
        return JSON.parse(raw.slice(start, index)) as string;
      }
      index += 1;
    }
    throw new SyntaxError('unterminated JSON string');
  };
  const value = (): void => {
    whitespace();
    if (raw[index] === '{') {
      object();
      return;
    }
    if (raw[index] === '[') {
      index += 1;
      whitespace();
      if (raw[index] === ']') {
        index += 1;
        return;
      }
      for (;;) {
        value();
        whitespace();
        if (raw[index] === ']') {
          index += 1;
          return;
        }
        if (raw[index] !== ',') throw new SyntaxError('invalid JSON array');
        index += 1;
      }
    }
    if (raw[index] === '"') {
      string();
      return;
    }
    while (index < raw.length && !/[\s,\]}]/.test(raw[index])) index += 1;
  };
  const object = (): void => {
    index += 1;
    const keys = new Set<string>();
    whitespace();
    if (raw[index] === '}') {
      index += 1;
      return;
    }
    for (;;) {
      whitespace();
      if (raw[index] !== '"') throw new SyntaxError('invalid JSON object key');
      const key = string();
      if (keys.has(key)) {
        throw new RappidCardError('json_invalid', `duplicate JSON object key: ${key}`);
      }
      keys.add(key);
      whitespace();
      if (raw[index] !== ':') throw new SyntaxError('invalid JSON object');
      index += 1;
      value();
      whitespace();
      if (raw[index] === '}') {
        index += 1;
        return;
      }
      if (raw[index] !== ',') throw new SyntaxError('invalid JSON object');
      index += 1;
    }
  };
  try {
    value();
  } catch (error) {
    if (error instanceof RappidCardError) throw error;
  }
}

export function parseManifestJson(raw: string): RappidCardManifest {
  if (Buffer.byteLength(raw, 'utf8') > 128 * 1024) {
    throw new RappidCardError('schema_invalid', 'card manifest exceeds 128 KiB');
  }
  try {
    assertNoDuplicateJsonKeys(raw);
    return validateManifest(JSON.parse(raw) as unknown);
  } catch (error) {
    if (error instanceof RappidCardError) throw error;
    throw new RappidCardError(
      'json_invalid',
      error instanceof Error ? error.message : String(error),
    );
  }
}

export function validateManifest(value: unknown): RappidCardManifest {
  const manifest = closedObject(value, 'card', [
    'schema',
    'profile',
    'policyId',
    'rappid',
    'endpoint',
    'nonce',
    'issuedAt',
    'expiresAt',
    'protocol',
    'runtime',
    'classification',
    'scopes',
    'parts',
    'challenge',
    'signature',
  ]);
  if (stringAt(manifest, 'schema', 'card') !== RAPPID_CARD_SCHEMA) {
    throw new RappidCardError('schema_invalid', 'card.schema is invalid');
  }
  const profile = enumAt(manifest, 'profile', 'card', PROFILES);
  const policyId = stringAt(manifest, 'policyId', 'card', POLICY_ID);
  const rappid = stringAt(manifest, 'rappid', 'card', RAPPID);
  const endpoint = validateEndpoint(stringAt(manifest, 'endpoint', 'card'));
  const nonce = stringAt(manifest, 'nonce', 'card', HEX_32);
  const issuedAt = stringAt(manifest, 'issuedAt', 'card');
  const expiresAt = stringAt(manifest, 'expiresAt', 'card');
  validateWindow(issuedAt, expiresAt, 'card.validity');
  const protocol = stringAt(manifest, 'protocol', 'card', PROTOCOL);
  const runtime = validateRuntime(manifest.runtime, 'card.runtime');
  const classification = enumAt(manifest, 'classification', 'card', CLASSIFICATIONS);
  const scopes = stringArrayAt(manifest, 'scopes', 'card', {
    values: SCOPES,
    minimum: 1,
    maximum: 6,
  });
  if (!Array.isArray(manifest.parts) || manifest.parts.length < 1 || manifest.parts.length > 6) {
    throw new RappidCardError('schema_invalid', 'card.parts must contain 1..6 items');
  }
  const parts = manifest.parts.map((part, index) => {
    const path = `card.parts[${index}]`;
    const object = closedObject(part, path, [
      'name',
      'hash',
      'bytes',
      'mediaType',
      'classification',
      'scope',
      'required',
    ]);
    const bytes = object.bytes;
    if (!Number.isSafeInteger(bytes) || (bytes as number) < 1 || (bytes as number) > 65536) {
      throw new RappidCardError('schema_invalid', `${path}.bytes is invalid`);
    }
    if (typeof object.required !== 'boolean') {
      throw new RappidCardError('schema_invalid', `${path}.required is invalid`);
    }
    return {
      name: enumAt(object, 'name', path, PART_NAMES),
      hash: stringAt(object, 'hash', path, HEX_64),
      bytes: bytes as number,
      mediaType: enumAt(object, 'mediaType', path, MEDIA_TYPES),
      classification: enumAt(object, 'classification', path, CLASSIFICATIONS),
      scope: enumAt(object, 'scope', path, SCOPES),
      required: object.required,
    };
  });
  if (new Set(parts.map((part) => part.name)).size !== parts.length) {
    throw new RappidCardError('schema_invalid', 'card.parts names must be unique');
  }
  if (new Set(parts.map((part) => part.hash)).size !== parts.length) {
    throw new RappidCardError('schema_invalid', 'card.parts hashes must be unique');
  }
  const challenge = validateAuthenticator(manifest.challenge, 'card.challenge');
  const signature = validateSignature(manifest.signature, 'card.signature');
  if (
    challenge.algorithm !== signature.algorithm
    || challenge.keyId !== signature.keyId
  ) {
    throw new RappidCardError(
      'schema_invalid',
      'card challenge must use the authorized signing key',
    );
  }
  return {
    schema: RAPPID_CARD_SCHEMA,
    profile,
    policyId,
    rappid,
    endpoint,
    nonce,
    issuedAt,
    expiresAt,
    protocol,
    runtime,
    classification,
    scopes,
    parts,
    challenge,
    signature,
  };
}

export function validatePolicy(value: unknown): RappidCardPolicy {
  const policy = closedObject(value, 'policy', [
    'schema',
    'policyId',
    'sequence',
    'issuedAt',
    'expiresAt',
    'allowedProfiles',
    'protocol',
    'runtime',
    'maxClassification',
    'grantedScopes',
    'approvedOrigins',
    'signature',
  ]);
  if (stringAt(policy, 'schema', 'policy') !== RAPPID_CARD_POLICY_SCHEMA) {
    throw new RappidCardError('schema_invalid', 'policy.schema is invalid');
  }
  const issuedAt = stringAt(policy, 'issuedAt', 'policy');
  const expiresAt = stringAt(policy, 'expiresAt', 'policy');
  validateWindow(issuedAt, expiresAt, 'policy.validity');
  return {
    schema: RAPPID_CARD_POLICY_SCHEMA,
    policyId: stringAt(policy, 'policyId', 'policy', POLICY_ID),
    sequence: integerAt(policy, 'sequence', 'policy'),
    issuedAt,
    expiresAt,
    allowedProfiles: stringArrayAt(policy, 'allowedProfiles', 'policy', {
      values: PROFILES,
      minimum: 1,
      maximum: 2,
    }),
    protocol: stringAt(policy, 'protocol', 'policy', PROTOCOL),
    runtime: validateRuntime(policy.runtime, 'policy.runtime'),
    maxClassification: enumAt(
      policy,
      'maxClassification',
      'policy',
      CLASSIFICATIONS,
    ),
    grantedScopes: stringArrayAt(policy, 'grantedScopes', 'policy', {
      values: SCOPES,
      minimum: 1,
      maximum: 6,
    }),
    approvedOrigins: approvedOriginsAt(policy, 'approvedOrigins', 'policy'),
    signature: validateSignature(policy.signature, 'policy.signature'),
  };
}

export function validateAuthorization(value: unknown): RappidCardAuthorization {
  const authorization = closedObject(value, 'authorization', [
    'schema',
    'authorizationId',
    'policyId',
    'sequence',
    'subjectRappid',
    'signerKeyId',
    'signerAlgorithm',
    'signerPublicKey',
    'notBefore',
    'notAfter',
    'maxClassification',
    'grantedScopes',
    'approvedOrigins',
    'signature',
  ]);
  if (
    stringAt(authorization, 'schema', 'authorization')
    !== RAPPID_CARD_AUTHORIZATION_SCHEMA
  ) {
    throw new RappidCardError('schema_invalid', 'authorization.schema is invalid');
  }
  const notBefore = stringAt(authorization, 'notBefore', 'authorization');
  const notAfter = stringAt(authorization, 'notAfter', 'authorization');
  validateWindow(notBefore, notAfter, 'authorization.validity');
  return {
    schema: RAPPID_CARD_AUTHORIZATION_SCHEMA,
    authorizationId: stringAt(
      authorization,
      'authorizationId',
      'authorization',
      AUTHORIZATION_ID,
    ),
    policyId: stringAt(authorization, 'policyId', 'authorization', POLICY_ID),
    sequence: integerAt(authorization, 'sequence', 'authorization'),
    subjectRappid: stringAt(authorization, 'subjectRappid', 'authorization', RAPPID),
    signerKeyId: stringAt(authorization, 'signerKeyId', 'authorization', KEY_ID),
    signerAlgorithm: enumAt(
      authorization,
      'signerAlgorithm',
      'authorization',
      ALGORITHMS,
    ),
    signerPublicKey: stringAt(
      authorization,
      'signerPublicKey',
      'authorization',
      BASE64URL_32,
    ),
    notBefore,
    notAfter,
    maxClassification: enumAt(
      authorization,
      'maxClassification',
      'authorization',
      CLASSIFICATIONS,
    ),
    grantedScopes: stringArrayAt(
      authorization,
      'grantedScopes',
      'authorization',
      { values: SCOPES, minimum: 1, maximum: 6 },
    ),
    approvedOrigins: approvedOriginsAt(
      authorization,
      'approvedOrigins',
      'authorization',
    ),
    signature: validateSignature(authorization.signature, 'authorization.signature'),
  };
}

export function validateRevocations(value: unknown): RappidCardRevocations {
  const revocations = closedObject(value, 'revocations', [
    'schema',
    'policyId',
    'sequence',
    'issuedAt',
    'expiresAt',
    'revokedManifestHashes',
    'revokedSignerKeyIds',
    'revokedAuthorizationIds',
    'signature',
  ]);
  if (
    stringAt(revocations, 'schema', 'revocations')
    !== RAPPID_CARD_REVOCATIONS_SCHEMA
  ) {
    throw new RappidCardError('schema_invalid', 'revocations.schema is invalid');
  }
  const issuedAt = stringAt(revocations, 'issuedAt', 'revocations');
  const expiresAt = stringAt(revocations, 'expiresAt', 'revocations');
  validateWindow(issuedAt, expiresAt, 'revocations.validity');
  return {
    schema: RAPPID_CARD_REVOCATIONS_SCHEMA,
    policyId: stringAt(revocations, 'policyId', 'revocations', POLICY_ID),
    sequence: integerAt(revocations, 'sequence', 'revocations'),
    issuedAt,
    expiresAt,
    revokedManifestHashes: stringArrayAt(
      revocations,
      'revokedManifestHashes',
      'revocations',
      { pattern: HEX_64, maximum: 1024 },
    ),
    revokedSignerKeyIds: stringArrayAt(
      revocations,
      'revokedSignerKeyIds',
      'revocations',
      { pattern: KEY_ID, maximum: 1024 },
    ),
    revokedAuthorizationIds: stringArrayAt(
      revocations,
      'revokedAuthorizationIds',
      'revocations',
      { pattern: AUTHORIZATION_ID, maximum: 1024 },
    ),
    signature: validateSignature(revocations.signature, 'revocations.signature'),
  };
}

function privateKeyFromSeed(seed: Uint8Array) {
  if (seed.byteLength !== 32) {
    throw new RappidCardError('key_invalid', 'Ed25519 private seed must be 32 bytes');
  }
  return createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, Buffer.from(seed)]),
    format: 'der',
    type: 'pkcs8',
  });
}

function publicKeyFromRaw(raw: string) {
  if (!BASE64URL_32.test(raw)) {
    throw new RappidCardError('key_invalid', 'Ed25519 public key is invalid');
  }
  return createPublicKey({
    key: { kty: 'OKP', crv: 'Ed25519', x: raw },
    format: 'jwk',
  });
}

export function ed25519PublicKey(seed: Uint8Array): string {
  const key = createPublicKey(privateKeyFromSeed(seed)).export({ format: 'jwk' });
  if (typeof key.x !== 'string' || !BASE64URL_32.test(key.x)) {
    throw new RappidCardError('key_invalid', 'could not derive Ed25519 public key');
  }
  return key.x;
}

function signCanonical(
  domain: string,
  value: JsonValue,
  seed: Uint8Array,
): string {
  return cryptoSign(
    null,
    Buffer.from(`${domain}\n${canonicalJson(value)}`, 'utf8'),
    privateKeyFromSeed(seed),
  ).toString('base64url');
}

function verifyCanonical(
  domain: string,
  value: JsonValue,
  signature: string,
  publicKey: string,
): boolean {
  if (!BASE64URL_64.test(signature)) return false;
  return cryptoVerify(
    null,
    Buffer.from(`${domain}\n${canonicalJson(value)}`, 'utf8'),
    publicKeyFromRaw(publicKey),
    Buffer.from(signature, 'base64url'),
  );
}

export function unsignedDocument<T extends { signature: RappidCardSignature }>(
  document: T,
): Unsigned<T> {
  const { signature: _signature, ...unsigned } = document;
  return unsigned;
}

export const unsignedManifest = unsignedDocument;

function signDocument<T extends { signature: RappidCardSignature }>(
  document: Unsigned<T>,
  domain: string,
  signature: {
    algorithm: CardAlgorithm;
    keyId: string;
    privateKey: Uint8Array;
  },
): T {
  return {
    ...document,
    signature: {
      algorithm: signature.algorithm,
      keyId: signature.keyId,
      value: signCanonical(
        domain,
        document as unknown as JsonValue,
        signature.privateKey,
      ),
    },
  } as T;
}

export function signManifest(
  manifest: Omit<RappidCardManifest, 'signature'>,
  signature: {
    algorithm: CardAlgorithm;
    keyId: string;
    privateKey: Uint8Array;
  },
): RappidCardManifest {
  return validateManifest(
    signDocument<RappidCardManifest>(manifest, CARD_SIGNATURE_DOMAIN, signature),
  );
}

export function signPolicy(
  policy: Omit<RappidCardPolicy, 'signature'>,
  signature: {
    algorithm: CardAlgorithm;
    keyId: string;
    privateKey: Uint8Array;
  },
): RappidCardPolicy {
  return validatePolicy(
    signDocument<RappidCardPolicy>(policy, CARD_POLICY_SIGNATURE_DOMAIN, signature),
  );
}

export function signAuthorization(
  authorization: Omit<RappidCardAuthorization, 'signature'>,
  signature: {
    algorithm: CardAlgorithm;
    keyId: string;
    privateKey: Uint8Array;
  },
): RappidCardAuthorization {
  return validateAuthorization(
    signDocument<RappidCardAuthorization>(
      authorization,
      CARD_AUTHORIZATION_SIGNATURE_DOMAIN,
      signature,
    ),
  );
}

export function signRevocations(
  revocations: Omit<RappidCardRevocations, 'signature'>,
  signature: {
    algorithm: CardAlgorithm;
    keyId: string;
    privateKey: Uint8Array;
  },
): RappidCardRevocations {
  return validateRevocations(
    signDocument<RappidCardRevocations>(
      revocations,
      CARD_REVOCATIONS_SIGNATURE_DOMAIN,
      signature,
    ),
  );
}

export function verifyManifestSignature(
  manifest: RappidCardManifest,
  publicKey: string,
): boolean {
  return verifyCanonical(
    CARD_SIGNATURE_DOMAIN,
    unsignedDocument(manifest) as unknown as JsonValue,
    manifest.signature.value,
    publicKey,
  );
}

export function verifyPolicySignature(
  policy: RappidCardPolicy,
  publicKey: string,
): boolean {
  return verifyCanonical(
    CARD_POLICY_SIGNATURE_DOMAIN,
    unsignedDocument(policy) as unknown as JsonValue,
    policy.signature.value,
    publicKey,
  );
}

export function verifyAuthorizationSignature(
  authorization: RappidCardAuthorization,
  publicKey: string,
): boolean {
  return verifyCanonical(
    CARD_AUTHORIZATION_SIGNATURE_DOMAIN,
    unsignedDocument(authorization) as unknown as JsonValue,
    authorization.signature.value,
    publicKey,
  );
}

export function verifyRevocationsSignature(
  revocations: RappidCardRevocations,
  publicKey: string,
): boolean {
  return verifyCanonical(
    CARD_REVOCATIONS_SIGNATURE_DOMAIN,
    unsignedDocument(revocations) as unknown as JsonValue,
    revocations.signature.value,
    publicKey,
  );
}

export function challengeValue(
  request: {
    manifestHash: string;
    nonce: string;
    partHashes: readonly string[];
  },
  privateKey: Uint8Array,
): string {
  const value = {
    manifestHash: request.manifestHash,
    nonce: request.nonce,
    partHashes: [...request.partHashes].sort(),
  };
  return signCanonical(
    CARD_CHALLENGE_DOMAIN,
    value as unknown as JsonValue,
    privateKey,
  );
}

export function verifyChallenge(
  response: string,
  request: {
    manifestHash: string;
    nonce: string;
    partHashes: readonly string[];
  },
  publicKey: string,
): boolean {
  const value = {
    manifestHash: request.manifestHash,
    nonce: request.nonce,
    partHashes: [...request.partHashes].sort(),
  };
  return verifyCanonical(
    CARD_CHALLENGE_DOMAIN,
    value as unknown as JsonValue,
    response,
    publicKey,
  );
}

export function canonicalManifest(manifest: RappidCardManifest): string {
  return canonicalJson(manifest as unknown as JsonValue);
}

export function canonicalDocumentHash(value: unknown): string {
  return sha256Hex(
    Buffer.from(canonicalJson(value as JsonValue), 'utf8'),
  );
}

export function manifestHash(manifest: RappidCardManifest): string {
  return canonicalDocumentHash(manifest);
}

export function makeDeepLink(
  manifest: RappidCardManifest,
  hash = manifestHash(manifest),
): string {
  return `rappid://link/${manifest.rappid}?m=${hash}&e=${encodeURIComponent(manifest.endpoint)}&n=${manifest.nonce}`;
}

export function parseDeepLink(value: string): ParsedRappidCardLink {
  if (value.length > 2048 || !value.startsWith('rappid://link/')) {
    throw new RappidCardError('link_invalid', 'deep link must use rappid://link/');
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new RappidCardError('link_invalid', 'deep link is not a valid URI');
  }
  if (url.protocol !== 'rappid:' || url.host !== 'link' || url.hash !== '') {
    throw new RappidCardError('link_invalid', 'deep link authority or fragment is invalid');
  }
  const keys = [...url.searchParams.keys()];
  if (
    keys.length !== 3
    || new Set(keys).size !== 3
    || !['m', 'e', 'n'].every((key) => keys.includes(key))
  ) {
    throw new RappidCardError('link_invalid', 'deep link must contain exactly m, e, and n');
  }
  let rappid: string;
  try {
    rappid = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
  } catch {
    throw new RappidCardError('link_invalid', 'deep link fields are invalid');
  }
  const manifestHashValue = url.searchParams.get('m') ?? '';
  const endpoint = url.searchParams.get('e') ?? '';
  const nonce = url.searchParams.get('n') ?? '';
  if (!RAPPID.test(rappid) || !HEX_64.test(manifestHashValue) || !HEX_32.test(nonce)) {
    throw new RappidCardError('link_invalid', 'deep link fields are invalid');
  }
  validateEndpoint(endpoint, 'deep link endpoint');
  const exact =
    `rappid://link/${rappid}?m=${manifestHashValue}`
    + `&e=${encodeURIComponent(endpoint)}&n=${nonce}`;
  if (value !== exact) {
    throw new RappidCardError('link_invalid', 'deep link is not in canonical compact form');
  }
  return {
    rappid,
    manifestHash: manifestHashValue,
    endpoint,
    nonce,
    deepLink: exact,
  };
}

export function compareSemver(left: string, right: string): number {
  const a = left.match(SEMVER);
  const b = right.match(SEMVER);
  if (!a || !b) throw new RappidCardError('schema_invalid', 'invalid semantic version');
  for (let index = 1; index <= 3; index += 1) {
    const delta = Number(a[index]) - Number(b[index]);
    if (delta !== 0) return delta < 0 ? -1 : 1;
  }
  return 0;
}

export function classificationRank(value: CardClassification): number {
  return ['public', 'internal', 'restricted'].indexOf(value);
}
