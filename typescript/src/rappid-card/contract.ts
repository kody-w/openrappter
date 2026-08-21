import { createHmac, timingSafeEqual } from 'node:crypto';

import { canonicalJson, sha256Hex } from '../rappids/canonical.js';
import type { JsonValue } from '../rappids/types.js';
import {
  RAPPID_CARD_PRODUCTION_PROFILE,
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
  RappidCardManifest,
} from './types.js';

export const CARD_SIGNATURE_DOMAIN = 'rappid-card/1:signature';
export const CARD_CHALLENGE_DOMAIN = 'rappid-card/1:continuity';

const HEX_32 = /^[0-9a-f]{32}$/;
const HEX_64 = /^[0-9a-f]{64}$/;
const ENDPOINT = /^[a-z][a-z0-9.-]{0,63}$/;
const KEY_ID = /^[a-z][a-z0-9._-]{0,63}$/;
const RAPPID =
  /^rappid:@[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?\/[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?:[0-9a-f]{64}$/;
const PROTOCOL = /^rappid-link\/[1-9][0-9]*$/;
const SEMVER = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const RFC3339_UTC =
  /^(?:[0-9]{4})-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]Z$/;

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
  'hmac-sha256-test',
  'hmac-sha256',
]);

type JsonRecord = Record<string, unknown>;

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
    throw new RappidCardError(
      'schema_invalid',
      `${path}.${key} is invalid`,
    );
  }
  return value;
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

function validateAuthenticator(
  value: unknown,
  path: string,
  signature: boolean,
): { algorithm: CardAlgorithm; keyId: string; value?: string } {
  const object = closedObject(
    value,
    path,
    signature ? ['algorithm', 'keyId', 'value'] : ['algorithm', 'keyId'],
  );
  const result: {
    algorithm: CardAlgorithm;
    keyId: string;
    value?: string;
  } = {
    algorithm: enumAt(object, 'algorithm', path, ALGORITHMS),
    keyId: stringAt(object, 'keyId', path, KEY_ID),
  };
  if (signature) result.value = stringAt(object, 'value', path, HEX_64);
  return result;
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
        throw new RappidCardError(
          'json_invalid',
          `duplicate JSON object key: ${key}`,
        );
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
    // JSON.parse below owns ordinary syntax diagnostics.
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
  const rappid = stringAt(manifest, 'rappid', 'card', RAPPID);
  const endpoint = stringAt(manifest, 'endpoint', 'card', ENDPOINT);
  const nonce = stringAt(manifest, 'nonce', 'card', HEX_32);
  const issuedAt = stringAt(manifest, 'issuedAt', 'card');
  const expiresAt = stringAt(manifest, 'expiresAt', 'card');
  validateTimestamp(issuedAt, 'card.issuedAt');
  validateTimestamp(expiresAt, 'card.expiresAt');
  if (Date.parse(expiresAt) <= Date.parse(issuedAt)) {
    throw new RappidCardError(
      'schema_invalid',
      'card.expiresAt must be later than card.issuedAt',
    );
  }
  const protocol = stringAt(manifest, 'protocol', 'card', PROTOCOL);
  const runtime = closedObject(
    manifest.runtime,
    'card.runtime',
    ['name', 'minimum', 'maximum'],
  );
  const runtimeValue = {
    name: stringAt(runtime, 'name', 'card.runtime', /^[a-z][a-z0-9-]{0,31}$/),
    minimum: stringAt(runtime, 'minimum', 'card.runtime', SEMVER),
    maximum: stringAt(runtime, 'maximum', 'card.runtime', SEMVER),
  };
  if (compareSemver(runtimeValue.minimum, runtimeValue.maximum) > 0) {
    throw new RappidCardError(
      'schema_invalid',
      'card.runtime.minimum must not exceed maximum',
    );
  }
  const classification = enumAt(
    manifest,
    'classification',
    'card',
    CLASSIFICATIONS,
  );
  if (!Array.isArray(manifest.scopes) || manifest.scopes.length < 1 || manifest.scopes.length > 6) {
    throw new RappidCardError('schema_invalid', 'card.scopes must contain 1..6 items');
  }
  const scopes = manifest.scopes.map((scope, index) => {
    if (typeof scope !== 'string' || !SCOPES.has(scope as CardScope)) {
      throw new RappidCardError('schema_invalid', `card.scopes[${index}] is invalid`);
    }
    return scope as CardScope;
  });
  if (new Set(scopes).size !== scopes.length) {
    throw new RappidCardError('schema_invalid', 'card.scopes must be unique');
  }
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
  const challenge = validateAuthenticator(manifest.challenge, 'card.challenge', false);
  const signature = validateAuthenticator(manifest.signature, 'card.signature', true);
  return {
    schema: RAPPID_CARD_SCHEMA,
    profile,
    rappid,
    endpoint,
    nonce,
    issuedAt,
    expiresAt,
    protocol,
    runtime: runtimeValue,
    classification,
    scopes,
    parts,
    challenge,
    signature: {
      algorithm: signature.algorithm,
      keyId: signature.keyId,
      value: signature.value!,
    },
  };
}

export function unsignedManifest(
  manifest: RappidCardManifest,
): Omit<RappidCardManifest, 'signature'> {
  const {
    signature: _signature,
    ...unsigned
  } = manifest;
  return unsigned;
}

export function canonicalManifest(manifest: RappidCardManifest): string {
  return canonicalJson(manifest as unknown as JsonValue);
}

export function manifestHash(manifest: RappidCardManifest): string {
  return sha256Hex(Buffer.from(canonicalManifest(manifest), 'utf8'));
}

function hmacHex(key: Uint8Array, message: string): string {
  return createHmac('sha256', key).update(message, 'utf8').digest('hex');
}

export function signatureValue(
  manifest: Omit<RappidCardManifest, 'signature'>,
  key: Uint8Array,
): string {
  return hmacHex(
    key,
    `${CARD_SIGNATURE_DOMAIN}\n${canonicalJson(manifest as unknown as JsonValue)}`,
  );
}

export function signManifest(
  manifest: Omit<RappidCardManifest, 'signature'>,
  signature: {
    algorithm: CardAlgorithm;
    keyId: string;
    key: Uint8Array;
  },
): RappidCardManifest {
  return validateManifest({
    ...manifest,
    signature: {
      algorithm: signature.algorithm,
      keyId: signature.keyId,
      value: signatureValue(manifest, signature.key),
    },
  });
}

export function verifySignature(
  manifest: RappidCardManifest,
  key: Uint8Array,
): boolean {
  const actual = Buffer.from(manifest.signature.value, 'hex');
  const expected = Buffer.from(signatureValue(unsignedManifest(manifest), key), 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function challengeValue(
  request: {
    manifestHash: string;
    nonce: string;
    partHashes: readonly string[];
  },
  key: Uint8Array,
): string {
  const hashes = [...request.partHashes].sort().join(',');
  return hmacHex(
    key,
    `${CARD_CHALLENGE_DOMAIN}\n${request.manifestHash}\n${request.nonce}\n${hashes}`,
  );
}

export function verifyChallenge(
  response: string,
  request: {
    manifestHash: string;
    nonce: string;
    partHashes: readonly string[];
  },
  key: Uint8Array,
): boolean {
  if (!HEX_64.test(response)) return false;
  const actual = Buffer.from(response, 'hex');
  const expected = Buffer.from(challengeValue(request, key), 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function makeDeepLink(
  manifest: RappidCardManifest,
  hash = manifestHash(manifest),
): string {
  return `rappid://link/${manifest.rappid}?m=${hash}&e=${manifest.endpoint}&n=${manifest.nonce}`;
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
  if (!RAPPID.test(rappid) || !HEX_64.test(manifestHashValue) || !ENDPOINT.test(endpoint) || !HEX_32.test(nonce)) {
    throw new RappidCardError('link_invalid', 'deep link fields are invalid');
  }
  const exact = `rappid://link/${rappid}?m=${manifestHashValue}&e=${endpoint}&n=${nonce}`;
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
