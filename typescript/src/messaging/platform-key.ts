/**
 * Platform Key — Rappter Co-Signature Verification
 *
 * Three tiers of trust:
 *   1. Public    — encrypted blobs, anyone can host, no verification
 *   2. Community — conversation key holders can read/write (open protocol)
 *   3. Verified  — Rappter platform key co-signs every message (proof of platform presence)
 *
 * The platform key is Rappter's — like a certificate authority.
 * Verified channels prove that Rappter's infrastructure was
 * involved in the transaction. This is the paid tier.
 *
 * Architecture:
 *   Message → PII strip → encrypt(ephemeral) → encrypt(conversation) →
 *   HMAC(conversation) → CO-SIGN(platform) → publish
 *
 * Verification:
 *   fetch → verify(platformSig) → verify(HMAC) → decrypt(conversation) →
 *   decrypt(ephemeral) → reattach PII
 *
 * Without the platform key: you can still encrypt and decrypt (community tier).
 * With the platform key: messages carry a co-signature proving Rappter verified them.
 * This is the fifth lock.
 */

import { generateKeyPairSync, createHash, sign, verify, createPrivateKey, createPublicKey } from 'crypto';

// ── Types ────────────────────────────────────────────────────────────────────

export interface PlatformKeyPair {
  /** Private key (PEM) — kept secret by Rappter */
  privateKey: string;
  /** Public key (PEM) — distributed to all clients for verification */
  publicKey: string;
  /** Key ID — short identifier for key rotation */
  keyId: string;
  /** Created timestamp */
  createdAt: string;
}

export interface PlatformSignature {
  /** The signature (base64) */
  signature: string;
  /** Which platform key signed this */
  keyId: string;
  /** Timestamp of signing */
  signedAt: string;
  /** Tier: 'community' (no platform sig) or 'verified' (platform co-signed) */
  tier: 'community' | 'verified';
}

export interface VerificationResult {
  valid: boolean;
  tier: 'community' | 'verified' | 'unverified';
  keyId?: string;
  error?: string;
}

// ── Platform Key Management ─────────────────────────────────────────────────

/**
 * Generate a new platform key pair (Ed25519 — fast, small signatures).
 * The private key stays with Rappter. The public key is distributed.
 */
export function generatePlatformKeyPair(): PlatformKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');

  const pubPem = publicKey.export({ type: 'spki', format: 'pem' }) as string;
  const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;

  const keyId = createHash('sha256').update(pubPem).digest('hex').slice(0, 12);

  return {
    privateKey: privPem,
    publicKey: pubPem,
    keyId,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Derive a key ID from a public key PEM.
 */
export function keyIdFromPublic(publicKeyPem: string): string {
  return createHash('sha256').update(publicKeyPem).digest('hex').slice(0, 12);
}

// ── Signing (Rappter side) ──────────────────────────────────────────────────

/**
 * Co-sign a message with the platform private key.
 * The payload signed is: conversationId + messageId + encrypted content hash + timestamp
 *
 * This proves Rappter was present when the message was created.
 */
export function platformSign(
  payload: { conversationId: string; messageId: string; encryptedHash: string },
  privateKeyPem: string,
  keyId: string,
): PlatformSignature {
  const signedAt = new Date().toISOString();
  const data = `${payload.conversationId}:${payload.messageId}:${payload.encryptedHash}:${signedAt}`;

  const key = createPrivateKey(privateKeyPem);
  const signature = sign(null, Buffer.from(data), key).toString('base64');

  return {
    signature,
    keyId,
    signedAt,
    tier: 'verified',
  };
}

// ── Verification (client side) ──────────────────────────────────────────────

/**
 * Verify a platform co-signature using the public key.
 * Any client with the public key can verify that Rappter signed this message.
 */
export function platformVerify(
  payload: { conversationId: string; messageId: string; encryptedHash: string },
  platformSig: PlatformSignature,
  publicKeyPem: string,
): VerificationResult {
  if (platformSig.tier === 'community') {
    return { valid: true, tier: 'community' };
  }

  try {
    const data = `${payload.conversationId}:${payload.messageId}:${payload.encryptedHash}:${platformSig.signedAt}`;

    const key = createPublicKey(publicKeyPem);
    const valid = verify(null, Buffer.from(data), key, Buffer.from(platformSig.signature, 'base64'));

    return {
      valid,
      tier: valid ? 'verified' : 'unverified',
      keyId: platformSig.keyId,
      error: valid ? undefined : 'Platform signature verification failed',
    };
  } catch (err) {
    return {
      valid: false,
      tier: 'unverified',
      error: (err as Error).message,
    };
  }
}

/**
 * Hash encrypted content for signing (don't sign the plaintext, sign the ciphertext).
 */
export function hashEncrypted(encrypted: string): string {
  return createHash('sha256').update(encrypted).digest('hex');
}

// ── Community vs Verified helpers ───────────────────────────────────────────

/**
 * Create a community-tier signature (no platform involvement).
 * This is the free/open tier — anyone can use the protocol.
 */
export function communitySig(): PlatformSignature {
  return {
    signature: '',
    keyId: '',
    signedAt: new Date().toISOString(),
    tier: 'community',
  };
}

/**
 * Check if a message is platform-verified.
 */
export function isVerified(sig: PlatformSignature): boolean {
  return sig.tier === 'verified' && sig.signature.length > 0;
}
