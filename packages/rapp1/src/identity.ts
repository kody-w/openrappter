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
  if (value.startsWith('net:') && isLabel(value.slice(4))) return 'swarm';
  return null;
}

export function isKind(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parts = value.split('.');
  return parts.length === 2 && isLabel(parts[0]) && isLabel(parts[1]);
}

export function isUtc(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)) return false;
  const year = Number(value.slice(0, 4));
  if (year < 1) return false;
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

export function keyedIdentity(owner: string, slug: string, publicKey: KeyObject): string {
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  return identityFromTail(owner, slug, hashBytes(IDENTITY_DOMAIN, spki));
}
