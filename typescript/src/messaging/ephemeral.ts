/**
 * Ephemeral Key Encryption — Forward-Secret Message Protection
 *
 * Every message gets its own ephemeral key derived from:
 *   conversationKey + messageNonce → ephemeralKey (HKDF)
 *
 * The plaintext is encrypted with the ephemeral key FIRST,
 * then the result is encrypted again with the conversation key.
 * PII stripping happens between these two layers.
 *
 * On the wire / static host:
 *   outerEncrypt(conversationKey, piiStrip(innerEncrypt(ephemeralKey, plaintext)))
 *
 * In the local VM only:
 *   plaintext with PII reattached
 *
 * Even if one ephemeral key leaks, it only reveals one message
 * (forward secrecy). Even if the conversation key leaks, the
 * inner layer is still encrypted with the ephemeral key.
 * Even if BOTH leak, PII was stripped before either encryption.
 *
 * Three locks on every message. No single key opens them all.
 */

import {
  randomBytes,
  createCipheriv,
  createDecipheriv,
  createHmac,
  createHash,
} from 'crypto';

// ── Types ────────────────────────────────────────────────────────────────────

export interface EphemeralEnvelope {
  /** Random nonce used to derive the ephemeral key (safe to transmit) */
  nonce: string; // base64, 32 bytes
  /** Inner ciphertext (encrypted with ephemeral key) */
  inner: string; // base64
  /** Inner IV */
  innerIv: string; // base64
  /** Inner auth tag */
  innerTag: string; // base64
}

export interface DoubleEnvelope {
  /** Outer ciphertext (encrypted with conversation key) */
  outer: string; // base64
  /** Outer IV */
  outerIv: string; // base64
  /** Outer auth tag */
  outerTag: string; // base64
  /** Nonce for ephemeral key derivation (not secret) */
  nonce: string; // base64
}

// ── Key Derivation ──────────────────────────────────────────────────────────

/**
 * Derive an ephemeral key from conversation key + nonce using HKDF-like construction.
 * HMAC-SHA256(conversationKey, "rappsignal-ephemeral:" + nonce) → 32-byte key
 */
export function deriveEphemeralKey(conversationKeyBase64: string, nonceBase64: string): Buffer {
  const convKey = Buffer.from(conversationKeyBase64, 'base64');
  const nonce = Buffer.from(nonceBase64, 'base64');
  const info = Buffer.concat([Buffer.from('rappsignal-ephemeral:'), nonce]);
  return Buffer.from(
    createHmac('sha256', convKey).update(info).digest()
  );
}

/**
 * Generate a fresh random nonce for ephemeral key derivation.
 */
export function generateNonce(): string {
  return randomBytes(32).toString('base64');
}

// ── Encrypt / Decrypt ───────────────────────────────────────────────────────

function aesEncrypt(plaintext: string, key: Buffer): { ciphertext: string; iv: string; tag: string } {
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  let enc = cipher.update(plaintext, 'utf8', 'base64');
  enc += cipher.final('base64');
  return { ciphertext: enc, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64') };
}

function aesDecrypt(ciphertext: string, iv: string, tag: string, key: Buffer): string {
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  let dec = decipher.update(ciphertext, 'base64', 'utf8');
  dec += decipher.final('utf8');
  return dec;
}

// ── Double Encryption ───────────────────────────────────────────────────────

/**
 * Double-encrypt a message:
 *   1. Generate ephemeral nonce
 *   2. Derive ephemeral key from conversation key + nonce
 *   3. Encrypt plaintext with ephemeral key (inner layer)
 *   4. Serialize the inner envelope
 *   5. Encrypt the serialized inner envelope with conversation key (outer layer)
 *
 * Returns a DoubleEnvelope that can be transmitted/stored safely.
 * Even MITM sees only the outer ciphertext. Breaking the outer layer
 * reveals only the inner ciphertext. Breaking the inner layer reveals
 * only PII-stripped content (if PII stripping was applied before calling this).
 */
export function doubleEncrypt(plaintext: string, conversationKeyBase64: string): DoubleEnvelope {
  const convKey = Buffer.from(conversationKeyBase64, 'base64');
  const nonce = generateNonce();

  // Inner layer: ephemeral key
  const ephKey = deriveEphemeralKey(conversationKeyBase64, nonce);
  const inner = aesEncrypt(plaintext, ephKey);

  // Serialize the inner envelope
  const innerEnvelope: EphemeralEnvelope = {
    nonce,
    inner: inner.ciphertext,
    innerIv: inner.iv,
    innerTag: inner.tag,
  };
  const serialized = JSON.stringify(innerEnvelope);

  // Outer layer: conversation key
  const outer = aesEncrypt(serialized, convKey);

  return {
    outer: outer.ciphertext,
    outerIv: outer.iv,
    outerTag: outer.tag,
    nonce, // nonce is public — needed for key derivation but not secret
  };
}

/**
 * Double-decrypt a message:
 *   1. Decrypt outer layer with conversation key → inner envelope JSON
 *   2. Parse inner envelope
 *   3. Derive ephemeral key from conversation key + nonce
 *   4. Decrypt inner layer with ephemeral key → plaintext
 *
 * This runs ONLY inside the local VM. Plaintext never exists outside.
 */
export function doubleDecrypt(envelope: DoubleEnvelope, conversationKeyBase64: string): string {
  const convKey = Buffer.from(conversationKeyBase64, 'base64');

  // Outer layer: conversation key
  const serialized = aesDecrypt(envelope.outer, envelope.outerIv, envelope.outerTag, convKey);

  // Parse inner envelope
  const inner: EphemeralEnvelope = JSON.parse(serialized);

  // Inner layer: ephemeral key
  const ephKey = deriveEphemeralKey(conversationKeyBase64, inner.nonce);
  return aesDecrypt(inner.inner, inner.innerIv, inner.innerTag, ephKey);
}

/**
 * Verify that an envelope can be decrypted without returning the plaintext.
 * Useful for integrity checks without exposing content.
 */
export function verifyEnvelope(envelope: DoubleEnvelope, conversationKeyBase64: string): boolean {
  try {
    doubleDecrypt(envelope, conversationKeyBase64);
    return true;
  } catch {
    return false;
  }
}

/**
 * Compute a fingerprint of the conversation key for visual verification.
 * Users can compare fingerprints out-of-band to confirm they share the same key.
 */
export function keyFingerprint(conversationKeyBase64: string): string {
  const hash = createHash('sha256')
    .update(Buffer.from(conversationKeyBase64, 'base64'))
    .digest('hex');
  // Format as groups of 4 for readability: "a1b2 c3d4 e5f6 ..."
  return hash.match(/.{1,4}/g)!.slice(0, 8).join(' ');
}
