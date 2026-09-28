import { randomUUID, type KeyObject } from 'node:crypto';
import { hashBytes, IDENTITY_DOMAIN } from './json.js';
import type { StreamFamily } from './authority.js';

export const HEX64 = /^[0-9a-f]{64}$/;
const LABEL = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const BODY = /^rappid:@([a-z0-9]+(?:-[a-z0-9]+)*)\/([a-z0-9]+(?:-[a-z0-9]+)*):([0-9a-f]{64})$/;
declare const bodyStreamBrand: unique symbol;
export type BodyStreamId = string & { readonly [bodyStreamBrand]: true };

export function isLabel(value: unknown, max = 64): value is string {
  return typeof value === 'string' && value.length <= max && LABEL.test(value);
}

export function isBodyStream(value: unknown): value is BodyStreamId {
  if (typeof value !== 'string') return false;
  const match = BODY.exec(value);
  return match !== null && match[1]!.length <= 39 && match[2]!.length <= 100;
}

export function streamFamily(value: unknown): StreamFamily | null {
  if (typeof value !== 'string') return null;
  if (isBodyStream(value)) return 'body';
  const last = value.lastIndexOf(':');
  if (isBodyStream(value.slice(0, last)) && isLabel(value.slice(last + 1))) return 'memory';
  if (value.startsWith('net:') && isLabel(value.slice(4), Infinity)) return 'swarm';
  return null;
}

export function isKind(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parts = value.split('.');
  return parts.length === 2 && isLabel(parts[0]) && isLabel(parts[1]);
}

export function isUtc(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

export function identityFromTail(owner: string, slug: string, tail: string): string {
  if (!isLabel(owner, 39) || !isLabel(slug, 100) || !HEX64.test(tail)) {
    throw new TypeError('Non-conforming identity components');
  }
  return `rappid:@${owner}/${slug}:${tail}`;
}

/** RFC 9562 UUIDv4 octets, not the textual UUID and never a name-derived hash. */
export function mintIdentity(owner: string, slug: string): string {
  const octets = Buffer.from(randomUUID().replaceAll('-', ''), 'hex');
  return identityFromTail(owner, slug, hashBytes(IDENTITY_DOMAIN, octets));
}

// RFC 8032 §5.1.3: the 32 octets decode to a point (y < p, x recoverable, no x = 0 with sign 1).
const P = 2n ** 255n - 19n;
function power(base: bigint, exponent: bigint): bigint {
  let result = 1n;
  for (let b = base % P, e = exponent; e > 0n; e >>= 1n, b = b * b % P) if (e & 1n) result = result * b % P;
  return result;
}
function ed25519PointDecodes(key: Uint8Array): boolean {
  const y = BigInt(`0x${Buffer.from(key).reverse().toString('hex')}`) & (2n ** 255n - 1n);
  if (y >= P) return false;
  const d = (P - 121665n) * power(121666n, P - 2n) % P;
  const u = (y * y - 1n + P) % P, v = (d * y * y + 1n) % P;
  const x = u * power(v, 3n) % P * power(u * power(v, 7n) % P, (P - 5n) / 8n) % P;
  const vxx = v * x % P * x % P;
  if (vxx !== u && (vxx + u) % P !== 0n) return false;
  return !(u === 0n && key[31]! >> 7 === 1);
}

/** Only a §10 key: Ed25519 whose point decodes, or P-256 whose SPKI carries the uncompressed point. */
export function keyedIdentity(owner: string, slug: string, publicKey: KeyObject): string {
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const p256 = publicKey.asymmetricKeyType === 'ec' && publicKey.asymmetricKeyDetails?.namedCurve === 'prime256v1';
  if (!((publicKey.asymmetricKeyType === 'ed25519' && ed25519PointDecodes(spki.subarray(12)))
    || (p256 && spki.length === 91 && spki[26] === 0x04))) {
    throw new TypeError('A keyed identity requires a decodable Ed25519 key or a P-256 key with an uncompressed point');
  }
  return identityFromTail(owner, slug, hashBytes(IDENTITY_DOMAIN, spki));
}
