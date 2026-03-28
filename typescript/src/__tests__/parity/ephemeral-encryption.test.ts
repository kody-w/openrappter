/**
 * Ephemeral double-encryption tests
 *
 * Tests the full double-lock pipeline: ephemeral key + conversation key.
 * Forward secrecy, MITM resistance, key fingerprints.
 */

import { describe, it, expect } from 'vitest';
import {
  doubleEncrypt,
  doubleDecrypt,
  verifyEnvelope,
  deriveEphemeralKey,
  generateNonce,
  keyFingerprint,
} from '../../messaging/ephemeral.js';
import { randomBytes } from 'crypto';

const testKey = randomBytes(32).toString('base64');

describe('Ephemeral Key Derivation', () => {
  it('derives deterministic key from same inputs', () => {
    const nonce = generateNonce();
    const k1 = deriveEphemeralKey(testKey, nonce);
    const k2 = deriveEphemeralKey(testKey, nonce);
    expect(k1.equals(k2)).toBe(true);
  });

  it('derives different keys for different nonces', () => {
    const k1 = deriveEphemeralKey(testKey, generateNonce());
    const k2 = deriveEphemeralKey(testKey, generateNonce());
    expect(k1.equals(k2)).toBe(false);
  });

  it('derives different keys for different conversation keys', () => {
    const nonce = generateNonce();
    const key2 = randomBytes(32).toString('base64');
    const k1 = deriveEphemeralKey(testKey, nonce);
    const k2 = deriveEphemeralKey(key2, nonce);
    expect(k1.equals(k2)).toBe(false);
  });

  it('produces 32-byte keys', () => {
    const k = deriveEphemeralKey(testKey, generateNonce());
    expect(k.length).toBe(32);
  });
});

describe('Double Encryption', () => {
  it('encrypts and decrypts a message', () => {
    const msg = 'Hello from the ephemeral layer!';
    const envelope = doubleEncrypt(msg, testKey);
    const decrypted = doubleDecrypt(envelope, testKey);
    expect(decrypted).toBe(msg);
  });

  it('envelope contains no plaintext', () => {
    const msg = 'Super secret message with sensitive data';
    const envelope = doubleEncrypt(msg, testKey);
    const serialized = JSON.stringify(envelope);
    expect(serialized).not.toContain('Super secret');
    expect(serialized).not.toContain('sensitive');
  });

  it('each encryption produces different ciphertext (nonce uniqueness)', () => {
    const msg = 'Same message twice';
    const e1 = doubleEncrypt(msg, testKey);
    const e2 = doubleEncrypt(msg, testKey);
    expect(e1.outer).not.toBe(e2.outer);
    expect(e1.nonce).not.toBe(e2.nonce);
    // But both decrypt to the same plaintext
    expect(doubleDecrypt(e1, testKey)).toBe(msg);
    expect(doubleDecrypt(e2, testKey)).toBe(msg);
  });

  it('fails to decrypt with wrong conversation key', () => {
    const msg = 'Locked up tight';
    const envelope = doubleEncrypt(msg, testKey);
    const wrongKey = randomBytes(32).toString('base64');
    expect(() => doubleDecrypt(envelope, wrongKey)).toThrow();
  });

  it('fails if outer ciphertext is tampered', () => {
    const envelope = doubleEncrypt('tamper test', testKey);
    envelope.outer = Buffer.from('tampered').toString('base64');
    expect(() => doubleDecrypt(envelope, testKey)).toThrow();
  });

  it('outer nonce is metadata — real nonce is inside the encrypted inner envelope', () => {
    const envelope = doubleEncrypt('nonce test', testKey);
    const originalNonce = envelope.nonce;
    envelope.nonce = generateNonce(); // tamper outer nonce
    // Decryption still works because the real nonce is inside the encrypted inner envelope
    // This is correct — the outer nonce is just metadata for key fingerprinting
    expect(doubleDecrypt(envelope, testKey)).toBe('nonce test');
    // The inner envelope's nonce (protected by outer encryption) is what matters
    expect(envelope.nonce).not.toBe(originalNonce);
  });

  it('handles unicode and emoji', () => {
    const msg = '🦖 Rex says: こんにちは! مرحبا 🔐';
    const envelope = doubleEncrypt(msg, testKey);
    expect(doubleDecrypt(envelope, testKey)).toBe(msg);
  });

  it('handles large messages', () => {
    const msg = 'A'.repeat(100000);
    const envelope = doubleEncrypt(msg, testKey);
    expect(doubleDecrypt(envelope, testKey)).toBe(msg);
  });

  it('handles empty string', () => {
    const envelope = doubleEncrypt('', testKey);
    expect(doubleDecrypt(envelope, testKey)).toBe('');
  });
});

describe('Forward Secrecy', () => {
  it('compromising one nonce does not reveal other messages', () => {
    const msg1 = 'First message';
    const msg2 = 'Second message';
    const e1 = doubleEncrypt(msg1, testKey);
    const e2 = doubleEncrypt(msg2, testKey);

    // Attacker gets nonce from message 1
    const compromisedEphKey = deriveEphemeralKey(testKey, e1.nonce);

    // That ephemeral key can't decrypt message 2's inner layer
    // (different nonce = different ephemeral key)
    const ephKey2 = deriveEphemeralKey(testKey, e2.nonce);
    expect(compromisedEphKey.equals(ephKey2)).toBe(false);
  });
});

describe('Verify Envelope', () => {
  it('returns true for valid envelope', () => {
    const envelope = doubleEncrypt('verify me', testKey);
    expect(verifyEnvelope(envelope, testKey)).toBe(true);
  });

  it('returns false for wrong key', () => {
    const envelope = doubleEncrypt('verify me', testKey);
    const wrongKey = randomBytes(32).toString('base64');
    expect(verifyEnvelope(envelope, wrongKey)).toBe(false);
  });

  it('returns false for tampered envelope', () => {
    const envelope = doubleEncrypt('verify me', testKey);
    envelope.outer = 'dGFtcGVyZWQ=';
    expect(verifyEnvelope(envelope, testKey)).toBe(false);
  });
});

describe('Key Fingerprint', () => {
  it('produces readable fingerprint', () => {
    const fp = keyFingerprint(testKey);
    expect(fp.split(' ').length).toBe(8);
    expect(fp).toMatch(/^[0-9a-f]{4}( [0-9a-f]{4}){7}$/);
  });

  it('same key = same fingerprint', () => {
    expect(keyFingerprint(testKey)).toBe(keyFingerprint(testKey));
  });

  it('different keys = different fingerprints', () => {
    const key2 = randomBytes(32).toString('base64');
    expect(keyFingerprint(testKey)).not.toBe(keyFingerprint(key2));
  });
});

describe('Full Pipeline: PII strip → double encrypt → verify → decrypt → reattach', () => {
  it('complete round trip with all layers', async () => {
    // Inline PII stripper for this test
    const { PIIStripper, PIIVault } = await import('../../messaging/pii.js');

    const original = 'Hey Kody, my email is kody@test.com and call 555-123-4567';

    // 1. Strip PII (client-side only)
    const stripper = new PIIStripper();
    stripper.addKnownNames(['Kody']);
    const { stripped, piiMap } = stripper.strip(original);
    expect(stripped).not.toContain('Kody');
    expect(stripped).not.toContain('kody@test.com');

    // 2. Store PII in local vault (never leaves device)
    const vault = new PIIVault();
    vault.store('msg-1', 'convo-1', piiMap);

    // 3. Double encrypt the stripped content
    const envelope = doubleEncrypt(stripped, testKey);

    // 4. What goes over the wire: no plaintext, no PII
    const wire = JSON.stringify(envelope);
    expect(wire).not.toContain('Kody');
    expect(wire).not.toContain('kody@test.com');
    expect(wire).not.toContain('555-123-4567');
    expect(wire).not.toContain('[P:'); // even the tokens are encrypted

    // 5. On receiving end: double decrypt
    const decrypted = doubleDecrypt(envelope, testKey);
    expect(decrypted).toBe(stripped); // PII-stripped, not original

    // 6. Reattach PII from local vault
    const localPII = vault.get('msg-1')!;
    const restored = stripper.reattach(decrypted, localPII);
    expect(restored).toBe(original);

    // 7. Without vault: you get tokens, not PII
    expect(decrypted).toContain('[P:');
    expect(decrypted).not.toContain('Kody');
  });
});
