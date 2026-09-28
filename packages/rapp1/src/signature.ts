import { createHash, createPublicKey, sign, verify, type KeyObject } from 'node:crypto';
import {
  arrayItems, assertOptions, canonicalJson, hashBytes, IDENTITY_DOMAIN, parseCanonicalJson,
  snapshotJson, type JsonObject,
} from './json.js';
import { isBodyStream, isUtc } from './identity.js';
import type { RappFrame } from './frame.js';

export interface RegistryKey extends JsonObject {
  kid: string;
  spki_der_b64: string;
  revoked_utc: string | null;
  superseded_utc: string | null;
}

declare const signatureBrand: unique symbol;
export interface SignaturePolicy { readonly [signatureBrand]: true }
declare const signerBrand: unique symbol;
export interface FrameSigner { readonly [signerBrand]: true }

interface KeyRecord { key: KeyObject; alg: 'EdDSA' | 'ES256'; revoked: string | null; superseded: string | null }
const policies = new WeakMap<object, ReadonlyMap<string, KeyRecord>>();
const signers = new WeakMap<object, { kid: string; alg: 'EdDSA' | 'ES256'; key: KeyObject }>();

// §10: Ed25519 is the cofactorless RFC 8032 §5.1.7 check with S < L, encode([S]B - [k]A) == R; a public key
// that decodes is not refused for its order. Only public values are involved, so plain BigInt arithmetic is used.
const P = 2n ** 255n - 19n;
const L = 2n ** 252n + 27742317777372353535851937790883648493n;
const mod = (a: bigint): bigint => { const r = a % P; return r < 0n ? r + P : r; };
function power(base: bigint, exponent: bigint): bigint {
  let result = 1n;
  for (let b = mod(base), e = exponent; e > 0n; e >>= 1n, b = b * b % P) if (e & 1n) result = result * b % P;
  return result;
}
const D = mod(-121665n * power(121666n, P - 2n));
const SQRT_M1 = power(2n, (P - 1n) / 4n);
type Point = readonly [bigint, bigint, bigint, bigint];
function add([x1, y1, z1, t1]: Point, [x2, y2, z2, t2]: Point): Point {
  const a = mod((y1 - x1) * (y2 - x2)), b = mod((y1 + x1) * (y2 + x2));
  const c = 2n * D % P * t1 % P * t2 % P, d = 2n * z1 * z2 % P;
  const e = mod(b - a), f = mod(d - c), g = mod(d + c), h = mod(b + a);
  return [e * f % P, g * h % P, f * g % P, e * h % P];
}
function multiply(point: Point, scalar: bigint): Point {
  let result: Point = [0n, 1n, 1n, 0n];
  for (let addend = point, k = scalar; k > 0n; k >>= 1n, addend = add(addend, addend)) if (k & 1n) result = add(result, addend);
  return result;
}
const littleEndian = (bytes: Uint8Array): bigint => BigInt(`0x${Buffer.from(bytes).reverse().toString('hex') || '0'}`);
function decodePoint(bytes: Uint8Array): Point | null {
  const y = littleEndian(bytes) & (2n ** 255n - 1n);
  const sign = BigInt(bytes[31]! >> 7);
  if (y >= P) return null;
  const u = mod(y * y - 1n), v = mod(D * y * y + 1n);
  let x = u * power(v, 3n) % P * power(u * power(v, 7n), (P - 5n) / 8n) % P;
  if (mod(v * x * x - u) !== 0n) {
    if (mod(v * x * x + u) !== 0n) return null;
    x = x * SQRT_M1 % P;
  }
  if (x === 0n && sign === 1n) return null;
  if ((x & 1n) !== sign) x = P - x;
  return [x, y, 1n, x * y % P];
}
function encodePoint([x, y, z]: Point): Buffer {
  const inverse = power(z, P - 2n);
  const bytes = Buffer.from((y * inverse % P).toString(16).padStart(64, '0'), 'hex').reverse();
  bytes[31] = bytes[31]! | Number((x * inverse % P) & 1n) << 7;
  return bytes;
}
const BASE = decodePoint(Buffer.from('58'.padEnd(64, '6'), 'hex'))!;
function verifyEd25519(key: KeyObject, message: Uint8Array, signature: Uint8Array): boolean {
  const publicKey = key.export({ type: 'spki', format: 'der' }).subarray(12);
  const a = decodePoint(publicKey);
  const s = littleEndian(signature.subarray(32));
  if (!a || s >= L) return false;
  // OpenSSL evaluates the same cofactorless equation and only refuses more (small-order inputs), so its
  // acceptance is final; the exact arithmetic runs only for a signature it refuses.
  if (verify(null, message, key, signature)) return true;
  const k = littleEndian(createHash('sha512').update(signature.subarray(0, 32)).update(publicKey).update(message).digest()) % L;
  const [x, y, z, t] = multiply(a, k);
  return encodePoint(add(multiply(BASE, s), [mod(-x), y, z, mod(-t)])).equals(signature.subarray(0, 32));
}

function algorithm(key: KeyObject): 'EdDSA' | 'ES256' {
  if (key.asymmetricKeyType === 'ed25519') return 'EdDSA';
  if (key.asymmetricKeyType === 'ec' && key.asymmetricKeyDetails?.namedCurve === 'prime256v1') return 'ES256';
  throw new TypeError('Only Ed25519 and P-256 keys are accepted');
}

function assertKeyIdentity(kid: unknown, spki: Buffer): asserts kid is string {
  if (!isBodyStream(kid) || hashBytes(IDENTITY_DOMAIN, spki) !== kid.slice(kid.lastIndexOf(':') + 1)) {
    throw new TypeError('Registry key does not match the keyed identity');
  }
}

/** Call only with an authenticated host-selected registry, never frame-supplied keys. */
export function selectSignaturePolicy(registry: readonly RegistryKey[]): SignaturePolicy {
  const keys = new Map<string, KeyRecord>();
  for (const item of arrayItems(registry)) {
    const entry = snapshotJson(item);
    assertOptions(entry, ['kid', 'spki_der_b64', 'revoked_utc', 'superseded_utc']);
    if (typeof entry.spki_der_b64 !== 'string') throw new TypeError('Invalid registry SPKI');
    const spki = Buffer.from(entry.spki_der_b64, 'base64');
    if (spki.toString('base64') !== entry.spki_der_b64) throw new TypeError('Non-canonical SPKI encoding');
    assertKeyIdentity(entry.kid, spki);
    for (const time of [entry.revoked_utc, entry.superseded_utc]) {
      if (time !== null && !isUtc(time)) throw new TypeError('Invalid registry lifecycle timestamp');
    }
    if (keys.has(entry.kid)) throw new TypeError('Duplicate registry identity');
    const key = createPublicKey({ key: spki, type: 'spki', format: 'der' });
    if (!key.export({ format: 'der', type: 'spki' }).equals(spki)) throw new TypeError('Non-canonical SPKI DER');
    keys.set(entry.kid, {
      key, alg: algorithm(key), revoked: entry.revoked_utc as string | null,
      superseded: entry.superseded_utc as string | null,
    });
  }
  const handle = Object.freeze(Object.create(null)) as SignaturePolicy;
  policies.set(handle, keys);
  return handle;
}

export function createFrameSigner(input: { kid: string; privateKey: KeyObject }): FrameSigner {
  assertOptions(input, ['kid', 'privateKey']);
  if (input.privateKey.type !== 'private') throw new TypeError('A private signing key is required');
  const publicKey = createPublicKey(input.privateKey);
  assertKeyIdentity(input.kid, publicKey.export({ type: 'spki', format: 'der' }));
  const handle = Object.freeze(Object.create(null)) as FrameSigner;
  signers.set(handle, { kid: input.kid, alg: algorithm(publicKey), key: input.privateKey });
  return handle;
}

function signingInput(frame: RappFrame, header: string): Buffer {
  const { sig: _sig, ...preimage } = frame;
  return Buffer.from(`${header}.${canonicalJson(preimage)}`);
}

export function signFrame(frame: RappFrame, signer: FrameSigner): string {
  const selected = signers.get(signer);
  if (!selected) throw new TypeError('Signing handle was not minted here');
  const header = Buffer.from(canonicalJson({
    alg: selected.alg, b64: false, crit: ['b64'], kid: selected.kid,
  })).toString('base64url');
  const bytes = sign(selected.alg === 'EdDSA' ? null : 'sha256', signingInput(frame, header),
    { key: selected.key, dsaEncoding: 'ieee-p1363' });
  return `${header}..${bytes.toString('base64url')}`;
}

export interface DetachedJws {
  readonly header: { readonly alg: 'EdDSA' | 'ES256'; readonly b64: false; readonly crit: readonly string[]; readonly kid: string };
  readonly protectedHeader: string;
  readonly signature: Buffer;
}

/** The §10 detached compact form and protected-header profile only; no key lookup or cryptography. */
export function parseDetachedJws(sig: unknown): DetachedJws {
  const match = typeof sig === 'string' ? /^([A-Za-z0-9_-]+)\.\.([A-Za-z0-9_-]+)$/.exec(sig) : null;
  if (!match) throw new TypeError('Not a detached compact JWS');
  const headerBytes = Buffer.from(match[1]!, 'base64url');
  const signature = Buffer.from(match[2]!, 'base64url');
  if (headerBytes.toString('base64url') !== match[1] || signature.toString('base64url') !== match[2]) {
    throw new TypeError('JWS parts must be canonical unpadded base64url');
  }
  if (signature.length !== 64) throw new TypeError('JWS signature must be exactly 64 octets');
  const header = parseCanonicalJson(headerBytes);
  assertOptions(header, ['alg', 'b64', 'crit', 'kid']);
  if ((header.alg !== 'EdDSA' && header.alg !== 'ES256') || header.b64 !== false
    || canonicalJson(header.crit) !== '["b64"]' || !isBodyStream(header.kid)) {
    throw new TypeError('JWS protected header violates the profile');
  }
  return Object.freeze({ header: header as unknown as DetachedJws['header'], protectedHeader: match[1]!, signature });
}

export function verifyFrameSignature(frame: RappFrame, policy: SignaturePolicy | undefined): boolean {
  const registry = policy && policies.get(policy);
  if (!registry || typeof frame.sig !== 'string') return false;
  try {
    const { header, protectedHeader, signature } = parseDetachedJws(frame.sig);
    const selected = registry.get(header.kid);
    if (!selected || header.alg !== selected.alg
      || (selected.revoked !== null && frame.utc >= selected.revoked)
      || (selected.superseded !== null && frame.utc >= selected.superseded)) return false;
    const input = signingInput(frame, protectedHeader);
    if (selected.alg === 'EdDSA') return verifyEd25519(selected.key, input, signature);
    return verify('sha256', input, { key: selected.key, dsaEncoding: 'ieee-p1363' }, signature);
  } catch {
    return false;
  }
}
