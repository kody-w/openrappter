import {
  createHash,
  createPublicKey,
  verify as cryptoVerify,
} from 'node:crypto';
import { isIP } from 'node:net';

import {
  rappCanonicalJson,
  rappHb,
} from '../rappids/canonical.js';
import {
  CARD_CALLING,
  CARD_CLASSIFICATIONS,
  CARD_COMPATIBILITY_KEYS,
  CARD_DEBUG,
  CARD_INVENTORY_KEYS,
  CARD_PAYLOAD_KEYS,
  CARD_PROFILE,
  CARD_REQUIRED_PARTS,
  CARD_TEST_PROFILE,
  CARD_VIRTUAL_SUFFIX,
  FRAME_KEYS,
  RAPP_SPEC,
} from './types.js';
import type {
  CardContinuity,
  CardFrame,
  CardInventoryEntry,
  CardPayload,
  JsonValue,
  ParsedCardLink,
} from './types.js';

const HEX64 = /^[0-9a-f]{64}$/;
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const LCLABEL = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const RAPPID =
  /^rappid:@([a-z0-9]+(?:-[a-z0-9]+)*)\/([a-z0-9]+(?:-[a-z0-9]+)*):([0-9a-f]{64})$/;
const PROFILE_TOKEN = /^[a-z0-9]+(?:-[a-z0-9]+)*\/[1-9][0-9]*$/;
const NONCE = /^[A-Za-z0-9_-]{16,64}$/;
const CONNECTION = /^[A-Za-z0-9._-]{1,128}$/;
const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const PERCENT = /%[0-9A-Fa-f]{2}/;
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const JWS_HEADER_KEYS = ['alg', 'b64', 'crit', 'kid'];
const PARENT_KEYS = ['particle', 'rappid'];

const FORBIDDEN_TEXT =
  /(?:(?<![A-Za-z0-9_])(?:password|passwd|api[-_ ]?key|cookie|authorization|private[-_ ]?memory|plaintext[-_ ]?memory|auto[-_ ]?execute)(?![A-Za-z0-9_])|(?<![A-Za-z0-9_])bearer(?:\s|[-_:]))/i;
const FORBIDDEN_KEYS = new Set([
  'password',
  'passwd',
  'api-key',
  'api_key',
  'apikey',
  'cookie',
  'set-cookie',
  'authorization',
  'bearer',
  'private-memory',
  'private_memory',
  'plaintext-memory',
  'auto-execute',
  'auto_execute',
  'instruction',
  'command',
]);
let materialScannersEnabled = true;

export function canonical(value: unknown): string {
  try {
    return rappCanonicalJson(value as JsonValue);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('depth 64')) {
      throw new TypeError('canonical nesting depth exceeds 64');
    }
    if (message.includes('1 MiB')) {
      throw new TypeError('canonical form exceeds 1048576 bytes');
    }
    throw error;
  }
}

export function H(space: string, value: unknown): string {
  return createHash('sha256')
    .update(`${space}\n${canonical(value)}`, 'utf8')
    .digest('hex');
}

export function Hb(space: string, value: Uint8Array): string {
  return rappHb(space, value);
}

export function rappidValid(value: unknown): value is string {
  return typeof value === 'string' && fullMatch(RAPPID, value);
}

export function uint53(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

export function hex64(value: unknown): value is string {
  return typeof value === 'string' && fullMatch(HEX64, value);
}

export function lclabel(value: unknown): value is string {
  return typeof value === 'string' && fullMatch(LCLABEL, value);
}

export function fullMatch(pattern: RegExp, value: string): boolean {
  const match = pattern.exec(value);
  return match !== null && match[0] === value;
}

export function validUtc(value: unknown): Date | null {
  if (typeof value !== 'string' || !fullMatch(UTC, value)) return null;
  const timestamp = Date.parse(value);
  if (
    Number.isNaN(timestamp)
    || new Date(timestamp).toISOString() !== value
  ) {
    return null;
  }
  return new Date(timestamp);
}

function exactKeys(value: unknown, keys: readonly string[]): boolean {
  return (
    value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort())
  );
}

export function verifyFrame(
  frame: unknown,
  head: CardFrame | null = null,
  streamIdOfRecord?: string,
): [boolean, string | null, string] {
  if (!exactKeys(frame, FRAME_KEYS)) {
    return [false, '1', 'key set != 11'];
  }
  const value = frame as CardFrame;
  if (value.spec !== RAPP_SPEC) return [false, '1', 'spec != rapp/1'];
  if (
    typeof value.kind !== 'string'
    || !/^[a-z0-9]+(?:-[a-z0-9]+)*\.[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.kind)
  ) {
    return [false, '1', 'kind grammar'];
  }
  if (typeof value.stream_id !== 'string') return [false, '1', 'stream_id type'];
  if (!uint53(value.seq)) return [false, '1', 'seq not uint53'];
  if (validUtc(value.utc) === null) return [false, '1', 'utc not fixed form'];
  if (value.payload === null || typeof value.payload !== 'object' || Array.isArray(value.payload)) {
    return [false, '1', 'payload not object'];
  }
  if (!hex64(value.payload_hash)) return [false, '1', 'payload_hash not 64hex'];
  if (!hex64(value.frame_hash)) return [false, '1', 'frame_hash not 64hex'];
  for (const [name, pointer] of [['prev', value.prev], ['prev_wave', value.prev_wave]] as const) {
    if (pointer !== null && !hex64(pointer)) return [false, '1', `${name} not null|64hex`];
  }
  if (streamIdOfRecord !== undefined && value.stream_id !== streamIdOfRecord) {
    return [false, '1a', 'stream_id mismatch (cross-stream replay)'];
  }
  if (value.payload_hash !== H('rapp/1:particle', value.payload as unknown as JsonValue)) {
    return [false, '2', 'payload_hash mismatch'];
  }
  const unsignedWave = Object.fromEntries(
    Object.entries(value).filter(([key]) => key !== 'frame_hash' && key !== 'sig'),
  ) as unknown as JsonValue;
  if (value.frame_hash !== H('rapp/1:wave', unsignedWave)) {
    return [false, '3', 'frame_hash mismatch'];
  }
  if (head === null) {
    if (value.seq !== 0 || value.prev !== null) {
      return [false, '4', 'genesis must be seq=0 prev=null'];
    }
  } else {
    if (value.seq !== head.seq + 1) return [false, '4', 'seq not contiguous'];
    if (value.prev !== head.payload_hash) return [false, '4', 'prev != head payload_hash'];
    if (value.utc < head.utc) return [false, '4', 'utc < head utc'];
  }
  const swarm = value.stream_id.startsWith('net:');
  if (swarm && value.seq > 0) {
    if (head !== null && value.prev_wave !== head.frame_hash) {
      return [false, '5', 'prev_wave != head frame_hash'];
    }
  } else if (value.prev_wave !== null) {
    return [false, '5', 'prev_wave must be null off swarm'];
  }
  if (swarm && value.sig === null) return [false, '6', 'swarm frame must be signed'];
  return [true, null, 'ok'];
}

function assertNoDuplicateJsonKeys(raw: string): void {
  let index = 0;
  const skip = () => {
    while (/\s/.test(raw[index] ?? '')) index += 1;
  };
  const parseString = (): string => {
    const start = index++;
    while (index < raw.length) {
      if (raw[index] === '\\') index += 2;
      else if (raw[index++] === '"') return JSON.parse(raw.slice(start, index)) as string;
    }
    throw new Error('unterminated JSON string');
  };
  const parseValue = (): void => {
    skip();
    if (raw[index] === '{') {
      parseObject();
      return;
    }
    if (raw[index] === '[') {
      index += 1;
      skip();
      if (raw[index] === ']') {
        index += 1;
        return;
      }
      for (;;) {
        parseValue();
        skip();
        if (raw[index] === ']') {
          index += 1;
          return;
        }
        if (raw[index++] !== ',') throw new Error('invalid JSON array');
      }
    }
    if (raw[index] === '"') {
      parseString();
      return;
    }
    while (index < raw.length && !/[\s,\]}]/.test(raw[index])) index += 1;
  };
  const parseObject = (): void => {
    index += 1;
    const keys = new Set<string>();
    skip();
    if (raw[index] === '}') {
      index += 1;
      return;
    }
    for (;;) {
      skip();
      if (raw[index] !== '"') throw new Error('invalid object key');
      const key = parseString();
      if (keys.has(key)) throw new Error(`duplicate JSON member ${JSON.stringify(key)}`);
      keys.add(key);
      skip();
      if (raw[index++] !== ':') throw new Error('invalid JSON object');
      parseValue();
      skip();
      if (raw[index] === '}') {
        index += 1;
        return;
      }
      if (raw[index++] !== ',') throw new Error('invalid JSON object');
    }
  };
  parseValue();
}

export function readCardResource(bytes: Uint8Array): CardFrame {
  const raw = Buffer.from(bytes).toString('utf8');
  assertNoDuplicateJsonKeys(raw);
  const value = JSON.parse(raw) as unknown;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('card resource must be a JSON object');
  }
  if (canonical(value as JsonValue) !== raw) {
    throw new Error('card resource bytes are not canonical');
  }
  return value as CardFrame;
}

function canonicalPercentEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function wellFormedPercent(value: string): boolean {
  for (let index = value.indexOf('%'); index >= 0; index = value.indexOf('%', index + 3)) {
    if (!/^[0-9A-Fa-f]{2}$/.test(value.slice(index + 1, index + 3))) return false;
  }
  return true;
}

export function decodedComponentRounds(value: string): string[] {
  const rounds = [value];
  let current = value;
  for (let count = 0; count < 2; count += 1) {
    if (!wellFormedPercent(current)) throw new Error('bad percent encoding');
    let decoded: string;
    try {
      decoded = decodeURIComponent(current);
    } catch {
      throw new Error('URL component is not UTF-8');
    }
    if (decoded === current) break;
    rounds.push(decoded);
    current = decoded;
  }
  return rounds;
}

function ipv4Number(host: string): number | null {
  if (isIP(host) !== 4) return null;
  const octets = host.split('.').map(Number);
  return (
    ((octets[0] << 24) >>> 0)
    + (octets[1] << 16)
    + (octets[2] << 8)
    + octets[3]
  ) >>> 0;
}

function inRange(value: number, base: number, prefix: number): boolean {
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (value & mask) === (base & mask);
}

function ipv6BigInt(address: string): bigint {
  let value = address.toLowerCase();
  let ipv4Tail: number[] | null = null;
  const lastColon = value.lastIndexOf(':');
  const tail = value.slice(lastColon + 1);
  if (tail.includes('.')) {
    ipv4Tail = tail.split('.').map(Number);
    value =
      `${value.slice(0, lastColon)}:`
      + `${((ipv4Tail[0] << 8) | ipv4Tail[1]).toString(16)}:`
      + `${((ipv4Tail[2] << 8) | ipv4Tail[3]).toString(16)}`;
  }
  const [leftRaw, rightRaw = ''] = value.split('::');
  const left = leftRaw ? leftRaw.split(':').filter(Boolean) : [];
  const right = rightRaw ? rightRaw.split(':').filter(Boolean) : [];
  const fill = Array(Math.max(0, 8 - left.length - right.length)).fill('0');
  const groups = [...left, ...fill, ...right];
  if (groups.length !== 8) throw new Error('invalid IPv6 address');
  return groups.reduce(
    (result, group) => (result << 16n) | BigInt(parseInt(group, 16)),
    0n,
  );
}

function ipv6InRange(value: bigint, base: string, prefix: number): boolean {
  const baseValue = ipv6BigInt(base);
  const shift = BigInt(128 - prefix);
  return (value >> shift) === (baseValue >> shift);
}

export function ipIsGlobal(host: string): boolean {
  const version = isIP(host);
  if (version === 0) return false;
  if (version === 6) {
    const value = ipv6BigInt(host);
    if (ipv6InRange(value, '::ffff:0:0', 96)) {
      return ipIsGlobal([
        Number((value >> 24n) & 0xffn),
        Number((value >> 16n) & 0xffn),
        Number((value >> 8n) & 0xffn),
        Number(value & 0xffn),
      ].join('.'));
    }
    const exceptions: Array<[string, number]> = [
      ['2001:1::1', 128],
      ['2001:1::2', 128],
      ['2001:3::', 32],
      ['2001:4:112::', 48],
      ['2001:20::', 28],
      ['2001:30::', 28],
    ];
    if (exceptions.some(([base, prefix]) => ipv6InRange(value, base, prefix))) {
      return true;
    }
    const privateRanges: Array<[string, number]> = [
      ['::1', 128],
      ['::', 128],
      ['64:ff9b:1::', 48],
      ['100::', 64],
      ['2001::', 23],
      ['2001:db8::', 32],
      ['2002::', 16],
      ['3fff::', 20],
      ['fc00::', 7],
      ['fe80::', 10],
    ];
    return !privateRanges.some(([base, prefix]) =>
      ipv6InRange(value, base, prefix));
  }
  const value = ipv4Number(host)!;
  const blocked: Array<[number, number]> = [
    [0x00000000, 8],
    [0x0a000000, 8],
    [0x64400000, 10],
    [0x7f000000, 8],
    [0xa9fe0000, 16],
    [0xac100000, 12],
    [0xc0000200, 24],
    [0xc0a80000, 16],
    [0xc6120000, 15],
    [0xc6336400, 24],
    [0xcb007100, 24],
    [0xf0000000, 4],
  ];
  if (value === 0xc0000009 || value === 0xc000000a) return true;
  if (inRange(value, 0xc0000000, 24)) return false;
  return !blocked.some(([base, prefix]) => inRange(value, base, prefix));
}

export interface CardUrlInfo {
  url: string;
  origin: string;
  host: string;
  literal_ip: string | null;
  decoded_path: string;
  decoded_rounds: string[];
}

export function cardUrlInfo(value: string, suffix?: string): CardUrlInfo {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) {
    throw new Error('HTTPS URL is absent or too long');
  }
  if (!/^[\x00-\x7f]+$/.test(value)) {
    throw new Error('HTTPS URL host/path must use canonical ASCII/percent encoding');
  }
  if ([...value].some((character) => character.charCodeAt(0) <= 0x20 || character.charCodeAt(0) === 0x7f)) {
    throw new Error('HTTPS URL contains whitespace or control characters');
  }
  if (value.includes('\\')) throw new Error('HTTPS URL contains a backslash');
  if (value.includes('?')) throw new Error('HTTPS URL query marker is forbidden, including an empty query');
  if (value.includes('#')) throw new Error('HTTPS URL fragment marker is forbidden, including an empty fragment');
  if (!wellFormedPercent(value)) throw new Error('HTTPS URL contains bad percent encoding');
  const rawAuthority = value.startsWith('https://')
    ? value.slice('https://'.length).split('/')[0]
    : '';
  const rawNumericAlias =
    /^(?:0x[0-9a-f]+|[0-9]+)$/i.test(rawAuthority)
    || (
      rawAuthority.includes('.')
      && rawAuthority.split('.').every((label) =>
        /^(?:0x[0-9a-f]+|[0-9]+)$/i.test(label))
    );
  if (rawNumericAlias && isIP(rawAuthority) === 0) {
    throw new Error('noncanonical numeric-looking HTTPS host is forbidden');
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('HTTPS URL cannot be parsed');
  }
  if (parsed.protocol !== 'https:' || !parsed.hostname) {
    throw new Error('URL must use canonical HTTPS with a host');
  }
  if (parsed.username !== '' || parsed.password !== '' || new URL(value).host.includes('@')) {
    throw new Error('HTTPS URL user-info is forbidden');
  }
  if (parsed.port !== '') throw new Error('HTTPS URL ports are forbidden; use the canonical default origin');
  const parsedHost = parsed.hostname;
  const host =
    parsedHost.startsWith('[') && parsedHost.endsWith(']')
      ? parsedHost.slice(1, -1)
      : parsedHost;
  const numericAlias =
    /^(?:0x[0-9a-f]+|[0-9]+)$/i.test(host)
    || (
      host.includes('.')
      && host.split('.').every((label) =>
        /^(?:0x[0-9a-f]+|[0-9]+)$/i.test(label))
    );
  if (numericAlias && isIP(host) === 0) {
    throw new Error('noncanonical numeric-looking HTTPS host is forbidden');
  }
  if (host !== host.toLowerCase()) throw new Error('HTTPS host must be lowercase');
  const ipVersion = isIP(host);
  let expectedNetloc: string;
  let literal: string | null = null;
  if (ipVersion === 0) {
    const labels = host.split('.');
    if (
      labels.length < 2
      || labels.some((label) => !fullMatch(HOST_LABEL, label))
    ) {
      throw new Error('HTTPS host is not a canonical DNS name');
    }
    expectedNetloc = host;
  } else {
    if (!ipIsGlobal(host)) {
      throw new Error('loopback/private/link-local/reserved IP literals are forbidden');
    }
    literal = host;
    expectedNetloc = ipVersion === 6 ? `[${host}]` : host;
  }
  const authority = value.slice('https://'.length).split('/')[0];
  if (authority !== expectedNetloc) throw new Error('HTTPS authority is not canonical');
  const encodedPath = value.slice(`https://${authority}`.length);
  if (!encodedPath.startsWith('/')) throw new Error('HTTPS URL path must be absolute');
  const rounds = decodedComponentRounds(encodedPath);
  const decodedPath = rounds[1] ?? rounds[0];
  if (PERCENT.test(decodedPath)) throw new Error('double-encoded HTTPS path is forbidden');
  if (canonicalPercentEncode(decodedPath).replaceAll('%2F', '/') !== encodedPath) {
    throw new Error('HTTPS path is not canonically percent-encoded');
  }
  if ([...decodedPath].some((character) => character === '\\' || character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f)) {
    throw new Error('decoded HTTPS path is unsafe');
  }
  const segments = decodedPath.split('/').slice(1);
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new Error('HTTPS path contains an empty or dot segment');
  }
  if (suffix !== undefined && !decodedPath.endsWith(suffix)) {
    throw new Error(`HTTPS path must end ${suffix}`);
  }
  return {
    url: value,
    origin: `https://${expectedNetloc}`,
    host,
    literal_ip: literal,
    decoded_path: decodedPath,
    decoded_rounds: rounds,
  };
}

export function canonicalCardOrigin(value: string): string {
  if (!value.startsWith('https://') || value.slice('https://'.length).includes('/')) {
    throw new Error('card origin must be exactly https://host');
  }
  const info = cardUrlInfo(`${value}/origin`);
  if (info.origin !== value) throw new Error('card origin is not canonical');
  return value;
}

export function forbiddenUrlMaterial(value: unknown): boolean {
  if (!materialScannersEnabled) return false;
  if (typeof value !== 'string') return false;
  try {
    const parsed = new URL(value);
    const candidates = [value, parsed.host, ...decodedComponentRounds(parsed.pathname)];
    return candidates.some((candidate) => FORBIDDEN_TEXT.test(candidate));
  } catch {
    return false;
  }
}

export function forbiddenCardMaterial(value: unknown): boolean {
  if (!materialScannersEnabled) return false;
  if (Array.isArray(value)) return value.some(forbiddenCardMaterial);
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).some(([key, child]) =>
      FORBIDDEN_KEYS.has(key.toLowerCase()) || forbiddenCardMaterial(child));
  }
  return typeof value === 'string' && FORBIDDEN_TEXT.test(value);
}

export function withMaterialScannersDisabledForTest<T>(operation: () => T): T {
  const previous = materialScannersEnabled;
  materialScannersEnabled = false;
  try {
    return operation();
  } finally {
    materialScannersEnabled = previous;
  }
}

export function parseCardLink(uri: string): ParsedCardLink {
  if (typeof uri !== 'string') throw new Error('card URI must be a string');
  if (uri.includes('#')) throw new Error('card URI fragments are forbidden, including an empty fragment');
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    throw new Error('card URI must use rappid://link with no fragment');
  }
  if (parsed.protocol !== 'rappid:' || parsed.host !== 'link') {
    throw new Error('card URI must use rappid://link with no fragment');
  }
  const rawAfterAuthority = uri.slice('rappid://link'.length);
  const queryIndex = rawAfterAuthority.indexOf('?');
  const path = queryIndex < 0 ? rawAfterAuthority : rawAfterAuthority.slice(0, queryIndex);
  const query = queryIndex < 0 ? '' : rawAfterAuthority.slice(queryIndex + 1);
  if (!path.startsWith('/') || path.slice(1).includes('/')) {
    throw new Error('card URI path must contain one percent-encoded RAPPID');
  }
  const encodedRappid = path.slice(1);
  let rappid: string;
  try {
    rappid = decodeURIComponent(encodedRappid);
  } catch {
    throw new Error('malformed card URI encoding');
  }
  if (canonicalPercentEncode(rappid) !== encodedRappid) {
    throw new Error('RAPPID path is not canonically percent-encoded');
  }
  if (!rappidValid(rappid)) throw new Error('card URI path is not a canonical RAPPID');
  const rawPairs = query.split('&').map((pair) => {
    const split = pair.indexOf('=');
    if (split < 0) throw new Error('malformed card URI encoding');
    return [pair.slice(0, split), pair.slice(split + 1)] as const;
  });
  if (
    rawPairs.length !== 3
    || rawPairs.map(([key]) => key).join(',') !== 'm,e,n'
  ) {
    throw new Error('card URI query must be exactly m, e, n in canonical order');
  }
  let manifestHash: string;
  let endpoint: string;
  let nonce: string;
  try {
    manifestHash = decodeURIComponent(rawPairs[0][1]);
    endpoint = decodeURIComponent(rawPairs[1][1]);
    nonce = decodeURIComponent(rawPairs[2][1]);
  } catch {
    throw new Error('malformed card URI encoding');
  }
  if (!hex64(manifestHash)) throw new Error('card URI m is not lowercase 64hex');
  const endpointInfo = cardUrlInfo(endpoint, CARD_VIRTUAL_SUFFIX);
  if (forbiddenUrlMaterial(endpoint)) throw new Error('card URI endpoint contains prohibited material');
  if (!fullMatch(NONCE, nonce)) throw new Error('card URI n must be 16-64 base64url characters');
  const canonicalUri =
    `rappid://link/${canonicalPercentEncode(rappid)}`
    + `?m=${manifestHash}&e=${canonicalPercentEncode(endpoint)}&n=${nonce}`;
  if (uri !== canonicalUri) throw new Error('card URI is not in canonical compact form');
  return {
    rappid,
    manifest_hash: manifestHash,
    endpoint,
    endpoint_origin: endpointInfo.origin,
    nonce,
  };
}

export class CardTrustStore {
  private readonly keys = new Map<string, Buffer>();

  constructor(
    entries: Record<string, Uint8Array>,
    readonly runtimePolicyAuthority: string,
  ) {
    if (Object.keys(entries).length === 0) throw new Error('card trust keys must be a non-empty object');
    for (const [kid, value] of Object.entries(entries)) {
      const spki = Buffer.from(value);
      if (!rappidValid(kid)) throw new Error(`card trust key id is not a RAPPID: ${JSON.stringify(kid)}`);
      if (spki.length !== 44 || !spki.subarray(0, 12).equals(ED25519_SPKI_PREFIX)) {
        throw new Error(`card trust key ${JSON.stringify(kid)} is not an Ed25519 SPKI`);
      }
      if (Hb('rapp/1:rappid', spki) !== kid.split(':').at(-1)) {
        throw new Error(`card trust SPKI does not bind ${JSON.stringify(kid)}`);
      }
      this.keys.set(kid, spki);
    }
    if (!this.keys.has(runtimePolicyAuthority)) {
      throw new Error('runtime policy authority is not a trust anchor');
    }
  }

  spki(kid: string): Buffer | null {
    return this.keys.get(kid) ?? null;
  }
}

function base64urlDecode(value: string): Buffer {
  if (typeof value !== 'string' || value.length === 0 || value.includes('=')) {
    throw new Error('base64url segment must be non-empty and unpadded');
  }
  const raw = Buffer.from(value, 'base64url');
  if (raw.toString('base64url') !== value) throw new Error('non-canonical base64url segment');
  return raw;
}

export function verifyDetachedEdDsa(
  value: JsonValue,
  signature: unknown,
  expectedKid: string,
  trust: CardTrustStore,
): [boolean, string] {
  if (!(trust instanceof CardTrustStore)) return [false, 'a CardTrustStore is required'];
  if (typeof signature !== 'string') return [false, 'signature must be a detached JWS string'];
  const parts = signature.split('.');
  if (parts.length !== 3 || parts[1] !== '') return [false, 'sig must use detached compact serialization'];
  let headerBytes: Buffer;
  let signatureBytes: Buffer;
  let header: unknown;
  try {
    headerBytes = base64urlDecode(parts[0]);
    signatureBytes = base64urlDecode(parts[2]);
    const raw = headerBytes.toString('utf8');
    assertNoDuplicateJsonKeys(raw);
    header = JSON.parse(raw);
  } catch (error) {
    return [false, error instanceof Error ? error.message : String(error)];
  }
  if (!exactKeys(header, JWS_HEADER_KEYS)) return [false, 'JWS protected header key set is not §10'];
  const expected = { alg: 'EdDSA', b64: false, crit: ['b64'], kid: expectedKid };
  if (JSON.stringify(header) !== JSON.stringify(expected)) {
    return [false, 'JWS protected header values do not match the expected key id'];
  }
  if (headerBytes.toString('utf8') !== canonical(expected as unknown as JsonValue)) {
    return [false, 'JWS protected header is not canonical'];
  }
  const spki = trust.spki(expectedKid);
  if (spki === null) return [false, 'unknown signing key'];
  const signingInput = Buffer.concat([
    Buffer.from(parts[0], 'ascii'),
    Buffer.from('.', 'ascii'),
    Buffer.from(canonical(value), 'utf8'),
  ]);
  const publicKey = createPublicKey({ key: spki, format: 'der', type: 'spki' });
  if (!cryptoVerify(null, signingInput, publicKey, signatureBytes)) {
    return [false, 'Ed25519 signature verification failed'];
  }
  return [true, 'ok'];
}

export function verifyFrameEdDsa(
  frame: CardFrame,
  trust: CardTrustStore,
): [boolean, string] {
  const profile = frame.payload.profile;
  const kid = frame.payload.key_id;
  const synthetic = kid.startsWith('rappid:@synthetic/');
  if (profile === CARD_PROFILE && synthetic) {
    return [false, 'synthetic test key refused for production profile'];
  }
  if (profile === CARD_TEST_PROFILE && !synthetic) {
    return [false, 'test profile requires a visibly synthetic key'];
  }
  const unsigned = Object.fromEntries(
    Object.entries(frame).filter(([key]) => key !== 'sig'),
  ) as unknown as JsonValue;
  return verifyDetachedEdDsa(unsigned, frame.sig, kid, trust);
}

export function sortedUniqueStrings(
  values: unknown,
  grammar: RegExp,
): values is string[] {
  return (
    Array.isArray(values)
    && values.every((value) => typeof value === 'string' && fullMatch(grammar, value))
    && JSON.stringify(values) === JSON.stringify([...new Set(values)].sort())
  );
}

export function cardContinuity(
  payload: CardPayload,
  nonce: string,
): CardContinuity {
  return {
    rappid: payload.rappid,
    soul_hash: payload.soul_hash,
    parent: payload.parent,
    engram_root: payload.engram_root,
    reflex_capability_root: payload.reflex_capability_root,
    nonce,
  };
}

export function cardPayloadError(
  payload: unknown,
  frame: CardFrame,
  link: ParsedCardLink,
): string | null {
  if (!exactKeys(payload, CARD_PAYLOAD_KEYS)) {
    return `manifest payload must have exactly ${JSON.stringify([...CARD_PAYLOAD_KEYS].sort())}`;
  }
  const value = payload as CardPayload;
  if (value.profile === CARD_PROFILE) {
    if (frame.kind !== CARD_CALLING) return 'rappid-card/1 requires body.calling-card';
  } else if (value.profile === CARD_TEST_PROFILE) {
    if (frame.kind !== CARD_DEBUG) return 'rappid-card-test/1 requires body.debug-card';
  } else return 'manifest profile is not a registered card profile';
  if (forbiddenCardMaterial(value)) return 'manifest contains secret, private-memory, or auto-execute material';
  if (value.rappid !== frame.stream_id || value.rappid !== link.rappid) {
    return 'manifest rappid, frame stream_id, and URI RAPPID must byte-equal';
  }
  if (!rappidValid(value.rappid)) return 'manifest rappid is not canonical';
  if (!rappidValid(value.key_id)) return 'manifest key_id is not a canonical keyed RAPPID';
  let origin: string;
  try {
    origin = canonicalCardOrigin(value.endpoint_origin);
    cardUrlInfo(value.revocation_url);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  if (origin !== link.endpoint_origin) return 'URI endpoint origin does not match the signed manifest endpoint_origin';
  if (forbiddenUrlMaterial(value.revocation_url)) return 'revocation_url contains prohibited material';
  if (value.parent !== null) {
    if (!exactKeys(value.parent, PARENT_KEYS)) return 'manifest parent must be null or exactly {rappid, particle}';
    if (!rappidValid(value.parent.rappid) || !hex64(value.parent.particle)) {
      return 'manifest parent is not a canonical RAPPID/particle pointer';
    }
    if (value.parent.rappid === value.rappid) return 'manifest rappid cannot be its own parent';
  }
  for (const key of ['soul_hash', 'engram_root', 'reflex_capability_root', 'wake_challenge'] as const) {
    if (!hex64(value[key])) return `manifest ${key} is not lowercase 64hex`;
  }
  if (!exactKeys(value.compatibility, CARD_COMPATIBILITY_KEYS)) {
    return 'compatibility must be exactly {protocol, runtime, features}';
  }
  if (
    !fullMatch(PROFILE_TOKEN, value.compatibility.protocol)
    || !fullMatch(PROFILE_TOKEN, value.compatibility.runtime)
  ) {
    return 'compatibility protocol/runtime is not a versioned token';
  }
  if (!sortedUniqueStrings(value.compatibility.features, PROFILE_TOKEN)) {
    return 'compatibility features must be sorted unique versioned tokens';
  }
  if (!(CARD_CLASSIFICATIONS as readonly string[]).includes(value.classification)) {
    return 'classification is not a registered card classification';
  }
  if (!sortedUniqueStrings(value.requested_scope, LCLABEL)) {
    return 'requested_scope must be sorted unique lclabels';
  }
  const expires = validUtc(value.expires_utc);
  const issued = validUtc(frame.utc);
  if (expires === null || issued === null || expires <= issued) {
    return 'expires_utc must be calendar-valid and later than frame utc';
  }
  if (!Array.isArray(value.inventory)) return 'inventory must be an array';
  const seen: string[] = [];
  const byPart = new Map<string, CardInventoryEntry>();
  for (const entry of value.inventory) {
    if (!exactKeys(entry, CARD_INVENTORY_KEYS)) {
      return 'inventory entries must be exactly {part, space, hash, bytes, required}';
    }
    if (!lclabel(entry.part)) return 'inventory part is not an lclabel';
    if (entry.space !== 'rapp/1:egg' || !hex64(entry.hash)) {
      return 'inventory address must be lowercase 64hex in rapp/1:egg';
    }
    if (!uint53(entry.bytes) || typeof entry.required !== 'boolean') {
      return 'inventory bytes/required types are invalid';
    }
    seen.push(entry.part);
    byPart.set(entry.part, entry);
  }
  if (JSON.stringify(seen) !== JSON.stringify([...seen].sort())) {
    return 'inventory must be sorted by part UTF-8 bytes';
  }
  if (new Set(seen).size !== seen.length) return 'inventory contains duplicate parts';
  if (!CARD_REQUIRED_PARTS.every((part) => byPart.has(part))) {
    return 'inventory omits a required soul, engram, or reflex-capability root';
  }
  if (!CARD_REQUIRED_PARTS.every((part) => byPart.get(part)!.required)) {
    return 'core card inventory parts must be required';
  }
  const roots = {
    soul: value.soul_hash,
    engram: value.engram_root,
    'reflex-capability': value.reflex_capability_root,
  };
  for (const [part, root] of Object.entries(roots)) {
    if (byPart.get(part)!.hash !== root) return `${part} inventory hash does not match its signed manifest root`;
  }
  if (typeof frame.sig !== 'string') return 'card frame must carry a signature';
  return null;
}

export function verifyHydration(
  inventory: CardInventoryEntry[],
  hydrated: Record<string, Uint8Array>,
): [boolean, string] {
  if (hydrated === null || typeof hydrated !== 'object' || Array.isArray(hydrated)) {
    return [false, 'hydrated parts must be an object of part name to octets'];
  }
  if (!Object.keys(hydrated).every(lclabel)) return [false, 'hydrated part names must be lclabels'];
  const permitted = new Map(inventory.map((entry) => [entry.part, entry]));
  const extra = Object.keys(hydrated).filter((part) => !permitted.has(part)).sort();
  if (extra.length) return [false, `hydration attempted unpermitted part ${JSON.stringify(extra[0])}`];
  const missing = inventory.filter((entry) => entry.required && !(entry.part in hydrated)).map((entry) => entry.part).sort();
  if (missing.length) return [false, `required hydration part missing: ${missing[0]}`];
  for (const part of Object.keys(hydrated).sort()) {
    const bytes = hydrated[part];
    const entry = permitted.get(part)!;
    if (!(bytes instanceof Uint8Array)) return [false, `hydrated part ${JSON.stringify(part)} is not bytes`];
    if (bytes.byteLength !== entry.bytes || Hb(entry.space, bytes) !== entry.hash) {
      return [false, `hydrated part ${JSON.stringify(part)} does not match its permitted address`];
    }
  }
  return [true, 'ok'];
}

export {
  CONNECTION,
  LCLABEL,
  NONCE,
  PROFILE_TOKEN,
  exactKeys,
};
