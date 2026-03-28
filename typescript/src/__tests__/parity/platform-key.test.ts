/**
 * Platform Key — Rappter co-signature verification tests
 *
 * Tests the three-tier trust model:
 *   Community (open) → Verified (platform co-signed) → Unverified (tampered)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  generatePlatformKeyPair,
  platformSign,
  platformVerify,
  hashEncrypted,
  communitySig,
  isVerified,
  keyIdFromPublic,
} from '../../messaging/platform-key.js';

describe('Platform Key — Certificate Authority for AI Agents', () => {
  let keyPair: ReturnType<typeof generatePlatformKeyPair>;

  beforeEach(() => {
    keyPair = generatePlatformKeyPair();
  });

  describe('key generation', () => {
    it('generates Ed25519 key pair', () => {
      expect(keyPair.privateKey).toContain('PRIVATE KEY');
      expect(keyPair.publicKey).toContain('PUBLIC KEY');
      expect(keyPair.keyId).toBeTruthy();
      expect(keyPair.keyId.length).toBe(12);
    });

    it('generates unique keys each time', () => {
      const kp2 = generatePlatformKeyPair();
      expect(kp2.keyId).not.toBe(keyPair.keyId);
      expect(kp2.privateKey).not.toBe(keyPair.privateKey);
    });

    it('keyId is derivable from public key', () => {
      const derived = keyIdFromPublic(keyPair.publicKey);
      expect(derived).toBe(keyPair.keyId);
    });
  });

  describe('signing (Rappter side)', () => {
    it('signs a message payload', () => {
      const payload = {
        conversationId: 'conv-123',
        messageId: 'msg-456',
        encryptedHash: hashEncrypted('some-encrypted-content'),
      };
      const sig = platformSign(payload, keyPair.privateKey, keyPair.keyId);
      expect(sig.signature).toBeTruthy();
      expect(sig.keyId).toBe(keyPair.keyId);
      expect(sig.tier).toBe('verified');
      expect(sig.signedAt).toBeTruthy();
    });

    it('same payload produces different signatures (timestamp varies)', async () => {
      const payload = {
        conversationId: 'conv-123',
        messageId: 'msg-456',
        encryptedHash: 'abc',
      };
      const sig1 = platformSign(payload, keyPair.privateKey, keyPair.keyId);
      await new Promise(r => setTimeout(r, 10));
      const sig2 = platformSign(payload, keyPair.privateKey, keyPair.keyId);
      // Different timestamps = different signatures
      expect(sig1.signedAt).not.toBe(sig2.signedAt);
    });
  });

  describe('verification (client side)', () => {
    it('verifies a valid platform signature', () => {
      const payload = {
        conversationId: 'conv-123',
        messageId: 'msg-456',
        encryptedHash: hashEncrypted('encrypted-blob'),
      };
      const sig = platformSign(payload, keyPair.privateKey, keyPair.keyId);
      const result = platformVerify(payload, sig, keyPair.publicKey);
      expect(result.valid).toBe(true);
      expect(result.tier).toBe('verified');
      expect(result.keyId).toBe(keyPair.keyId);
    });

    it('rejects tampered payload', () => {
      const payload = {
        conversationId: 'conv-123',
        messageId: 'msg-456',
        encryptedHash: hashEncrypted('original'),
      };
      const sig = platformSign(payload, keyPair.privateKey, keyPair.keyId);

      // Tamper with the payload
      const tampered = { ...payload, messageId: 'msg-EVIL' };
      const result = platformVerify(tampered, sig, keyPair.publicKey);
      expect(result.valid).toBe(false);
      expect(result.tier).toBe('unverified');
    });

    it('rejects signature from wrong key', () => {
      const payload = {
        conversationId: 'conv-123',
        messageId: 'msg-456',
        encryptedHash: 'abc',
      };
      const sig = platformSign(payload, keyPair.privateKey, keyPair.keyId);

      // Verify with a different key pair
      const otherKey = generatePlatformKeyPair();
      const result = platformVerify(payload, sig, otherKey.publicKey);
      expect(result.valid).toBe(false);
      expect(result.tier).toBe('unverified');
    });

    it('community tier always passes (no platform involvement)', () => {
      const payload = {
        conversationId: 'conv-123',
        messageId: 'msg-456',
        encryptedHash: 'abc',
      };
      const sig = communitySig();
      const result = platformVerify(payload, sig, keyPair.publicKey);
      expect(result.valid).toBe(true);
      expect(result.tier).toBe('community');
    });
  });

  describe('tier helpers', () => {
    it('isVerified returns true for platform-signed', () => {
      const payload = {
        conversationId: 'c',
        messageId: 'm',
        encryptedHash: 'h',
      };
      const sig = platformSign(payload, keyPair.privateKey, keyPair.keyId);
      expect(isVerified(sig)).toBe(true);
    });

    it('isVerified returns false for community tier', () => {
      expect(isVerified(communitySig())).toBe(false);
    });
  });

  describe('hash utility', () => {
    it('produces consistent hash for same content', () => {
      const h1 = hashEncrypted('test-content');
      const h2 = hashEncrypted('test-content');
      expect(h1).toBe(h2);
      expect(h1.length).toBe(64); // SHA-256 hex
    });

    it('produces different hash for different content', () => {
      expect(hashEncrypted('a')).not.toBe(hashEncrypted('b'));
    });
  });

  describe('five-lock architecture', () => {
    it('full pipeline: PII strip → ephemeral encrypt → conversation encrypt → HMAC → platform sign', async () => {
      const { PIIStripper } = await import('../../messaging/pii.js');
      const { doubleEncrypt } = await import('../../messaging/ephemeral.js');
      const { signBlob } = await import('../../messaging/edge-sync.js');
      const { randomBytes } = await import('crypto');

      const convKey = randomBytes(32).toString('base64');

      // Lock 1: PII strip
      const stripper = new PIIStripper();
      stripper.addKnownNames(['Kody']);
      const { stripped } = stripper.strip('Hey Kody, email kody@test.com');
      expect(stripped).not.toContain('Kody');

      // Lock 2 + 3: Double encrypt (ephemeral + conversation)
      const envelope = doubleEncrypt(stripped, convKey);
      expect(envelope.outer).not.toContain('Kody');

      // Lock 4: HMAC
      const blob = {
        id: 'msg-1',
        conversationId: 'conv-1',
        encrypted: envelope.outer,
        iv: envelope.outerIv,
        authTag: envelope.outerTag,
        senderHint: 'Rex',
        timestamp: new Date().toISOString(),
        status: 'instant',
      };
      const hmac = signBlob(blob, convKey);
      expect(hmac.length).toBe(64);

      // Lock 5: Platform co-signature
      const encHash = hashEncrypted(envelope.outer);
      const platformSig = platformSign(
        { conversationId: 'conv-1', messageId: 'msg-1', encryptedHash: encHash },
        keyPair.privateKey,
        keyPair.keyId,
      );
      expect(platformSig.tier).toBe('verified');

      // Verify all five locks
      const verifyResult = platformVerify(
        { conversationId: 'conv-1', messageId: 'msg-1', encryptedHash: encHash },
        platformSig,
        keyPair.publicKey,
      );
      expect(verifyResult.valid).toBe(true);
      expect(verifyResult.tier).toBe('verified');
    });
  });
});
