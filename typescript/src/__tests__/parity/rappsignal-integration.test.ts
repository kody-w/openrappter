/**
 * RappterSignal Integration Test — Full Wired Pipeline
 *
 * Tests the complete end-to-end flow with all layers wired together:
 *   twin.send → PII strip → double encrypt → store → HMAC sign →
 *   edge publish → verify → decrypt → PII reattach
 *
 * This is NOT an isolation test. Every layer is wired and executing.
 */

import { describe, it, expect } from 'vitest';
import { EncryptedMessageStore } from '../../messaging/store.js';
import { PIIStripper, PIIVault } from '../../messaging/pii.js';
import { EdgePublisher, verifyBlob, verifyChannel } from '../../messaging/edge-sync.js';
import { doubleDecrypt, keyFingerprint } from '../../messaging/ephemeral.js';

describe('RappterSignal Integration — Full Pipeline', () => {
  it('twin.send → PII strip → double encrypt → store → sign → publish → verify → decrypt → reattach', () => {
    // ── Setup (what the gateway does on startup) ──
    const store = new EncryptedMessageStore({ doubleEncrypt: true });
    const stripper = new PIIStripper();
    const vault = new PIIVault();

    // Create a conversation
    const convo = store.createConversation({
      name: 'RappterSignal Integration',
      participants: ['Kody', 'Rex', 'Nova'],
    });
    stripper.addKnownNames(['Kody', 'Rex', 'Nova']);

    // ── Simulate twin.send (what twin-methods.ts does) ──
    const originalMessage = 'Hey Kody, email me at kody@wildfeuer.com or call 555-867-5309. Rex says hi!';

    // Step 1: PII strip
    const { stripped, piiMap, piiCount } = stripper.strip(originalMessage);
    expect(stripped).not.toContain('Kody');
    expect(stripped).not.toContain('kody@wildfeuer.com');
    expect(stripped).not.toContain('555-867-5309');
    expect(stripped).not.toContain('Rex');
    expect(piiCount).toBeGreaterThan(0);

    // Step 2: Store (internally double-encrypts)
    const msg = store.addMessage(convo.id, {
      sender: 'Nova',
      senderEmoji: '🌟',
      content: stripped,
      status: 'instant',
      metadata: { piiStripped: true, piiCount },
    });

    // Step 3: Store PII locally
    vault.store(msg.id, convo.id, piiMap);

    // ── Verify encryption at rest ──
    const exported = store.export(convo.id);
    const blob = exported.messages[0];

    // The blob has a nonce (double encryption active)
    expect(blob.nonce).toBeTruthy();

    // The encrypted content contains no PII and no plaintext
    expect(blob.encrypted).not.toContain('Kody');
    expect(blob.encrypted).not.toContain('wildfeuer');
    expect(blob.encrypted).not.toContain('Rex');
    expect(blob.encrypted).not.toContain('[P:'); // even tokens are encrypted

    // Sender hint is safe metadata
    expect(blob.senderHint).toBe('Nova');

    // ── Edge publish with HMAC signing ──
    const publisher = new EdgePublisher({ outputDir: '/tmp/rappsignal-test' });
    const channelFile = publisher.publish(exported, convo.key);

    // Channel-level signature
    expect(channelFile.signature).toBeTruthy();
    expect(verifyChannel(channelFile.messages, channelFile.signature, convo.key)).toBe(true);

    // Per-message HMAC
    for (const signedMsg of channelFile.messages) {
      expect(signedMsg.hmac).toBeTruthy();
      expect(verifyBlob(signedMsg, convo.key)).toBe(true);
    }

    // Head hash for incremental sync
    expect(channelFile.channel.headHash.length).toBe(16);

    // ── Simulate edge pull — import on a fresh store ──
    const store2 = new EncryptedMessageStore({ doubleEncrypt: true });
    const imported = store2.importConversation(exported, convo.key);
    expect(imported.messageCount).toBe(1);

    // ── Decrypt and read ──
    const messages = store2.getMessages(imported.id);
    expect(messages.length).toBe(1);
    expect(messages[0].sender).toBe('Nova');
    expect(messages[0].senderEmoji).toBe('🌟');

    // Content is PII-stripped (no PII even after decryption)
    expect(messages[0].content).not.toContain('Kody');
    expect(messages[0].content).not.toContain('kody@wildfeuer.com');
    expect(messages[0].content).toContain('[P:'); // tokens visible

    // ── Reattach PII from local vault (client-side only) ──
    const localPII = vault.get(msg.id)!;
    expect(localPII).toBeDefined();
    const restored = stripper.reattach(messages[0].content, localPII);
    expect(restored).toBe(originalMessage);

    // ── Without vault, you only get tokens ──
    expect(messages[0].content).not.toBe(originalMessage);
  });

  it('multi-message conversation with mixed PII', () => {
    const store = new EncryptedMessageStore({ doubleEncrypt: true });
    const stripper = new PIIStripper();
    const vault = new PIIVault();

    const convo = store.createConversation({
      name: 'Multi-Message Test',
      participants: ['Alice', 'Bob'],
    });
    stripper.addKnownNames(['Alice', 'Bob']);

    // Message 1: has PII
    const { stripped: s1, piiMap: p1 } = stripper.strip('Hey Alice, my number is 555-111-2222');
    const m1 = store.addMessage(convo.id, { sender: 'Bob', content: s1 });
    vault.store(m1.id, convo.id, p1);

    // Message 2: no PII
    const { stripped: s2, piiMap: p2, piiCount: pc2 } = stripper.strip('What time is the meeting?');
    const m2 = store.addMessage(convo.id, { sender: 'Alice', content: s2 });
    if (pc2 > 0) vault.store(m2.id, convo.id, p2);

    // Message 3: has PII
    const { stripped: s3, piiMap: p3 } = stripper.strip('Send it to alice@company.com');
    const m3 = store.addMessage(convo.id, { sender: 'Alice', content: s3 });
    vault.store(m3.id, convo.id, p3);

    // Read all messages
    const messages = store.getMessages(convo.id);
    expect(messages.length).toBe(3);

    // All decrypted, PII still stripped
    expect(messages[0].content).not.toContain('555-111-2222');
    expect(messages[1].content).toBe('What time is the meeting?'); // no PII to strip
    expect(messages[2].content).not.toContain('alice@company.com');

    // Reattach
    const r1 = stripper.reattach(messages[0].content, vault.get(m1.id)!);
    expect(r1).toContain('555-111-2222');

    const r3 = stripper.reattach(messages[2].content, vault.get(m3.id)!);
    expect(r3).toContain('alice@company.com');

    // Export encrypted blobs are clean (participant names in metadata are public, that's OK)
    const exported = store.export(convo.id);
    expect(exported.conversation.messageCount).toBe(3);
    // Check that the encrypted message blobs don't contain PII
    for (const blob of exported.messages) {
      expect(blob.encrypted).not.toContain('555-111-2222');
      expect(blob.encrypted).not.toContain('alice@company.com');
    }
  });

  it('key fingerprints match across stores', () => {
    const store1 = new EncryptedMessageStore();
    const convo = store1.createConversation({ name: 'FP Test', participants: [] });

    const fp1 = keyFingerprint(convo.key);
    const fp2 = keyFingerprint(convo.key);
    expect(fp1).toBe(fp2);
    expect(fp1.split(' ').length).toBe(8);

    // Different key gives different fingerprint
    const store2 = new EncryptedMessageStore();
    const convo2 = store2.createConversation({ name: 'FP2', participants: [] });
    expect(keyFingerprint(convo2.key)).not.toBe(fp1);
  });

  it('tampered edge file is detected', () => {
    const store = new EncryptedMessageStore({ doubleEncrypt: true });
    const convo = store.createConversation({ name: 'Tamper Test', participants: [] });
    store.addMessage(convo.id, { sender: 'Rex', content: 'secure' });

    const exported = store.export(convo.id);
    const publisher = new EdgePublisher({ outputDir: '/tmp/tamper-test' });
    const channelFile = publisher.publish(exported, convo.key);

    // Tamper with a message — individual HMAC fails
    channelFile.messages[0].senderHint = 'EVIL';
    expect(verifyBlob(channelFile.messages[0], convo.key)).toBe(false);

    // Channel signature still matches old HMACs (signature was computed pre-tamper)
    // But verifying individual blobs catches the tamper
    let allValid = true;
    for (const m of channelFile.messages) {
      if (!verifyBlob(m, convo.key)) { allValid = false; break; }
    }
    expect(allValid).toBe(false);
  });

  it('backward compat: single encryption still works', () => {
    const store = new EncryptedMessageStore({ doubleEncrypt: false });
    const convo = store.createConversation({ name: 'Legacy', participants: [] });
    store.addMessage(convo.id, { sender: 'Rex', content: 'old school' });

    const messages = store.getMessages(convo.id);
    expect(messages[0].content).toBe('old school');

    // No nonce in export (single encryption)
    const exported = store.export(convo.id);
    expect(exported.messages[0].nonce).toBeUndefined();
  });
});
