import { createPublicKey, sign, verify, type KeyObject } from 'node:crypto';
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

export function verifyFrameSignature(frame: RappFrame, policy: SignaturePolicy | undefined): boolean {
  const registry = policy && policies.get(policy);
  if (!registry || typeof frame.sig !== 'string') return false;
  try {
    const match = /^([A-Za-z0-9_-]+)\.\.([A-Za-z0-9_-]+)$/.exec(frame.sig);
    if (!match) return false;
    const headerBytes = Buffer.from(match[1]!, 'base64url');
    const signature = Buffer.from(match[2]!, 'base64url');
    if (headerBytes.toString('base64url') !== match[1] || signature.toString('base64url') !== match[2]
      || signature.length !== 64) return false;
    const header = parseCanonicalJson(headerBytes);
    assertOptions(header, ['alg', 'b64', 'crit', 'kid']);
    if (header.b64 !== false || canonicalJson(header.crit) !== '["b64"]' || !isBodyStream(header.kid)) return false;
    const selected = registry.get(header.kid);
    if (!selected || header.alg !== selected.alg
      || (selected.revoked !== null && frame.utc >= selected.revoked)
      || (selected.superseded !== null && frame.utc >= selected.superseded)) return false;
    return verify(selected.alg === 'EdDSA' ? null : 'sha256', signingInput(frame, match[1]!),
      { key: selected.key, dsaEncoding: 'ieee-p1363' }, signature);
  } catch {
    return false;
  }
}
