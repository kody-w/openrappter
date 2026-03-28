/**
 * EdgeSync + PII stripping tests
 *
 * Tests the full privacy pipeline: PII strip → encrypt → HMAC sign → publish → pull → verify → decrypt → PII reattach
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { PIIStripper, PIIVault } from '../../messaging/pii.js';
import { EncryptedMessageStore } from '../../messaging/store.js';
import { EdgePublisher, signBlob, verifyBlob, signChannel, verifyChannel } from '../../messaging/edge-sync.js';
import type { SignedBlob } from '../../messaging/edge-sync.js';

describe('PIIStripper', () => {
  let stripper: PIIStripper;

  beforeEach(() => {
    stripper = new PIIStripper();
  });

  it('strips email addresses', () => {
    const result = stripper.strip('Contact me at kody@test.com please');
    expect(result.stripped).not.toContain('kody@test.com');
    expect(result.stripped).toContain('[P:');
    expect(result.piiCount).toBe(1);
    expect(Object.values(result.piiMap)).toContain('kody@test.com');
  });

  it('strips phone numbers', () => {
    const result = stripper.strip('Call me at 555-123-4567');
    expect(result.stripped).not.toContain('555-123-4567');
    expect(result.piiCount).toBe(1);
  });

  it('strips iCloud addresses', () => {
    const result = stripper.strip('Send it to rappter1@icloud.com');
    expect(result.stripped).not.toContain('rappter1@icloud.com');
    expect(result.piiCount).toBe(1);
  });

  it('strips SSN patterns', () => {
    const result = stripper.strip('My SSN is 123-45-6789');
    expect(result.stripped).not.toContain('123-45-6789');
    expect(result.piiCount).toBe(1);
  });

  it('strips IP addresses', () => {
    const result = stripper.strip('Server at 192.168.1.100');
    expect(result.stripped).not.toContain('192.168.1.100');
    expect(result.piiCount).toBe(1);
  });

  it('strips multiple PII types in one message', () => {
    const result = stripper.strip('Hey, email kody@test.com or call 555-123-4567');
    expect(result.piiCount).toBe(2);
    expect(result.stripped).not.toContain('kody@test.com');
    expect(result.stripped).not.toContain('555-123-4567');
  });

  it('strips known names', () => {
    stripper.addKnownNames(['Kody', 'Rex', 'Nova']);
    const result = stripper.strip('Hey Kody, Rex says hi to Nova');
    expect(result.stripped).not.toContain('Kody');
    expect(result.stripped).not.toContain('Rex');
    expect(result.stripped).not.toContain('Nova');
    expect(result.piiCount).toBe(3);
  });

  it('name stripping is case-insensitive', () => {
    stripper.addKnownNames(['Kody']);
    const result = stripper.strip('hey KODY, how are you kody?');
    expect(result.stripped).not.toMatch(/kody/i);
  });

  it('deduplicates same PII value', () => {
    const result = stripper.strip('Email kody@test.com and also kody@test.com');
    expect(result.piiCount).toBe(1); // same value = same token
    // Both occurrences replaced with same token
    const token = Object.keys(result.piiMap)[0];
    expect(result.stripped.split(`[${token}]`).length - 1).toBe(2);
  });

  it('returns unchanged text when no PII found', () => {
    const result = stripper.strip('Hello world, how are you?');
    expect(result.stripped).toBe('Hello world, how are you?');
    expect(result.piiCount).toBe(0);
  });

  it('supports custom patterns', () => {
    stripper.addPattern('employee_id', /EMP-\d{5}/g);
    const result = stripper.strip('Employee EMP-12345 reported the issue');
    expect(result.stripped).not.toContain('EMP-12345');
    expect(result.piiCount).toBe(1);
  });

  it('reattaches PII correctly', () => {
    stripper.addKnownNames(['Kody']);
    const original = 'Hey Kody, email me at kody@test.com';
    const { stripped, piiMap } = stripper.strip(original);
    const restored = stripper.reattach(stripped, piiMap);
    expect(restored).toBe(original);
  });

  it('reattach is idempotent with empty map', () => {
    const text = 'No PII here';
    expect(stripper.reattach(text, {})).toBe(text);
  });
});

describe('PIIVault', () => {
  let vault: PIIVault;

  beforeEach(() => {
    vault = new PIIVault();
  });

  it('stores and retrieves PII maps', () => {
    vault.store('msg-1', 'convo-1', { 'P:1': 'Kody', 'P:2': 'kody@test.com' });
    const map = vault.get('msg-1');
    expect(map).toEqual({ 'P:1': 'Kody', 'P:2': 'kody@test.com' });
  });

  it('returns undefined for unknown message', () => {
    expect(vault.get('nonexistent')).toBeUndefined();
  });

  it('gets all entries for a conversation', () => {
    vault.store('msg-1', 'convo-1', { 'P:1': 'A' });
    vault.store('msg-2', 'convo-1', { 'P:1': 'B' });
    vault.store('msg-3', 'convo-2', { 'P:1': 'C' });
    expect(vault.getForConversation('convo-1').length).toBe(2);
    expect(vault.getForConversation('convo-2').length).toBe(1);
  });

  it('removes entries', () => {
    vault.store('msg-1', 'convo-1', { 'P:1': 'A' });
    vault.remove('msg-1');
    expect(vault.get('msg-1')).toBeUndefined();
  });

  it('clears by conversation', () => {
    vault.store('msg-1', 'convo-1', { 'P:1': 'A' });
    vault.store('msg-2', 'convo-2', { 'P:1': 'B' });
    vault.clear('convo-1');
    expect(vault.size()).toBe(1);
    expect(vault.get('msg-2')).toBeDefined();
  });

  it('exports and imports', () => {
    vault.store('msg-1', 'convo-1', { 'P:1': 'Kody' });
    const exported = vault.export();
    const vault2 = new PIIVault();
    vault2.import(exported);
    expect(vault2.get('msg-1')).toEqual({ 'P:1': 'Kody' });
  });
});

describe('HMAC Signing', () => {
  let store: EncryptedMessageStore;
  let convoKey: string;
  let convoId: string;

  beforeEach(() => {
    store = new EncryptedMessageStore();
    const convo = store.createConversation({ name: 'Signed', participants: ['Rex'] });
    convoKey = convo.key;
    convoId = convo.id;
  });

  it('signs a blob deterministically', () => {
    store.addMessage(convoId, { sender: 'Rex', content: 'hello' });
    const exported = store.export(convoId);
    const blob = exported.messages[0];

    const sig1 = signBlob(blob, convoKey);
    const sig2 = signBlob(blob, convoKey);
    expect(sig1).toBe(sig2);
    expect(sig1.length).toBe(64); // SHA-256 hex
  });

  it('verifies valid blob', () => {
    store.addMessage(convoId, { sender: 'Rex', content: 'hello' });
    const exported = store.export(convoId);
    const blob = exported.messages[0];
    const hmac = signBlob(blob, convoKey);
    const signed: SignedBlob = { ...blob, hmac };
    expect(verifyBlob(signed, convoKey)).toBe(true);
  });

  it('rejects tampered blob', () => {
    store.addMessage(convoId, { sender: 'Rex', content: 'hello' });
    const exported = store.export(convoId);
    const blob = exported.messages[0];
    const hmac = signBlob(blob, convoKey);
    const tampered: SignedBlob = { ...blob, hmac, senderHint: 'EVIL' };
    expect(verifyBlob(tampered, convoKey)).toBe(false);
  });

  it('rejects blob with wrong key', () => {
    store.addMessage(convoId, { sender: 'Rex', content: 'hello' });
    const exported = store.export(convoId);
    const blob = exported.messages[0];
    const hmac = signBlob(blob, convoKey);
    const signed: SignedBlob = { ...blob, hmac };
    const wrongKey = Buffer.from('x'.repeat(64), 'hex').toString('base64');
    expect(verifyBlob(signed, wrongKey)).toBe(false);
  });

  it('signs and verifies channel', () => {
    store.addMessage(convoId, { sender: 'Rex', content: 'one' });
    store.addMessage(convoId, { sender: 'Nova', content: 'two' });
    const exported = store.export(convoId);
    const signed: SignedBlob[] = exported.messages.map(b => ({
      ...b,
      hmac: signBlob(b, convoKey),
    }));
    const channelSig = signChannel(signed, convoKey);
    expect(verifyChannel(signed, channelSig, convoKey)).toBe(true);
  });

  it('detects tampered channel (message removed)', () => {
    store.addMessage(convoId, { sender: 'Rex', content: 'one' });
    store.addMessage(convoId, { sender: 'Nova', content: 'two' });
    const exported = store.export(convoId);
    const signed: SignedBlob[] = exported.messages.map(b => ({
      ...b,
      hmac: signBlob(b, convoKey),
    }));
    const channelSig = signChannel(signed, convoKey);
    // Remove a message
    signed.pop();
    expect(verifyChannel(signed, channelSig, convoKey)).toBe(false);
  });
});

describe('EdgePublisher', () => {
  it('publishes a signed channel file', () => {
    const store = new EncryptedMessageStore();
    const convo = store.createConversation({ name: 'Edge Test', participants: ['Rex', 'Nova'] });
    store.addMessage(convo.id, { sender: 'Rex', content: 'hello edge' });
    store.addMessage(convo.id, { sender: 'Nova', content: 'hello back' });

    const exported = store.export(convo.id);
    const publisher = new EdgePublisher({ outputDir: '/tmp/edge-test' });
    const channelFile = publisher.publish(exported, convo.key);

    expect(channelFile._type).toBe('openrappter-edge-channel');
    expect(channelFile.version).toBe(1);
    expect(channelFile.signature).toBeTruthy();
    expect(channelFile.messages.length).toBe(2);
    expect(channelFile.messages[0].hmac).toBeTruthy();
    expect(channelFile.channel.headHash.length).toBe(16);

    // Verify the channel
    expect(verifyChannel(channelFile.messages, channelFile.signature, convo.key)).toBe(true);
  });

  it('generates manifest from channels', () => {
    const store = new EncryptedMessageStore();
    const c1 = store.createConversation({ name: 'Chan1', participants: ['Rex'] });
    const c2 = store.createConversation({ name: 'Chan2', participants: ['Nova'] });
    store.addMessage(c1.id, { sender: 'Rex', content: 'a' });
    store.addMessage(c2.id, { sender: 'Nova', content: 'b' });

    const publisher = new EdgePublisher({ outputDir: '/tmp/edge-test' });
    const ch1 = publisher.publish(store.export(c1.id), c1.key);
    const ch2 = publisher.publish(store.export(c2.id), c2.key);

    const manifest = publisher.generateManifest([ch1, ch2]);
    expect(manifest._type).toBe('openrappter-edge-manifest');
    expect(manifest.channels.length).toBe(2);
    expect(manifest.channels[0].name).toBe('Chan1');
    expect(manifest.channels[1].name).toBe('Chan2');
    expect(manifest.publishedAt).toBeTruthy();
  });
});

describe('Full Pipeline: strip → encrypt → sign → publish → verify → decrypt → reattach', () => {
  it('round-trips a message through the full privacy pipeline', () => {
    // 1. Original message with PII
    const original = 'Hey Kody, email me at kody@test.com or call 555-123-4567';

    // 2. Strip PII (client-side, before encryption)
    const stripper = new PIIStripper();
    stripper.addKnownNames(['Kody']);
    const { stripped, piiMap } = stripper.strip(original);
    expect(stripped).not.toContain('Kody');
    expect(stripped).not.toContain('kody@test.com');
    expect(stripped).not.toContain('555-123-4567');

    // 3. Store PII locally (never leaves device)
    const vault = new PIIVault();

    // 4. Encrypt the stripped text
    const store = new EncryptedMessageStore();
    const convo = store.createConversation({ name: 'Private', participants: ['Rex'] });
    const msg = store.addMessage(convo.id, { sender: 'Rex', content: stripped });
    vault.store(msg.id, convo.id, piiMap);

    // 5. Export + sign for edge publishing
    const exported = store.export(convo.id);
    const publisher = new EdgePublisher({ outputDir: '/tmp/test' });
    const channelFile = publisher.publish(exported, convo.key);

    // 6. Verify: the published blob contains NO PII
    const publishedBlob = channelFile.messages[0];
    expect(publishedBlob.encrypted).not.toContain('Kody');
    expect(publishedBlob.encrypted).not.toContain('kody@test.com');
    expect(publishedBlob.senderHint).toBe('Rex'); // safe metadata

    // 7. Verify HMAC
    expect(verifyBlob(publishedBlob, convo.key)).toBe(true);
    expect(verifyChannel(channelFile.messages, channelFile.signature, convo.key)).toBe(true);

    // 8. On the receiving edge: decrypt
    const store2 = new EncryptedMessageStore();
    store2.importConversation({
      _type: 'openrappter-twin-channel',
      version: 1,
      conversation: exported.conversation,
      messages: exported.messages,
    }, convo.key);
    const decrypted = store2.getMessages(convo.id);
    expect(decrypted[0].content).toBe(stripped); // Still PII-stripped

    // 9. Reattach PII from local vault (client-side only)
    const localPII = vault.get(msg.id)!;
    const restored = stripper.reattach(decrypted[0].content, localPII);
    expect(restored).toBe(original); // Full message recovered

    // 10. Without the vault, you only get the stripped version
    const withoutVault = decrypted[0].content;
    expect(withoutVault).toContain('[P:');
    expect(withoutVault).not.toContain('Kody');
  });
});
