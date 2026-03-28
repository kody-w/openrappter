/**
 * EncryptedMessageStore tests
 *
 * Tests encryption, conversation lifecycle, message CRUD,
 * export/import, key exchange, and status tracking.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { EncryptedMessageStore } from '../../messaging/store.js';

describe('EncryptedMessageStore', () => {
  let store: EncryptedMessageStore;

  beforeEach(() => {
    store = new EncryptedMessageStore(); // in-memory, no SQLite
  });

  describe('conversations', () => {
    it('creates a conversation with generated key', () => {
      const convo = store.createConversation({
        name: 'Test Chat',
        participants: ['Rex', 'Nova'],
      });
      expect(convo.id).toBeTruthy();
      expect(convo.name).toBe('Test Chat');
      expect(convo.participants).toEqual(['Rex', 'Nova']);
      expect(convo.key).toBeTruthy();
      expect(Buffer.from(convo.key, 'base64').length).toBe(32); // AES-256
      expect(convo.messageCount).toBe(0);
    });

    it('creates a conversation with provided key', () => {
      const key = Buffer.from('a'.repeat(64), 'hex').toString('base64');
      const convo = store.createConversation({
        name: 'Keyed Chat',
        participants: ['Alice'],
        key,
      });
      expect(convo.key).toBe(key);
    });

    it('lists conversations', () => {
      store.createConversation({ name: 'A', participants: ['Rex'] });
      store.createConversation({ name: 'B', participants: ['Nova'] });
      const list = store.listConversations();
      expect(list.length).toBe(2);
      expect(list.map(c => c.name)).toContain('A');
      expect(list.map(c => c.name)).toContain('B');
    });

    it('gets conversation by id', () => {
      const convo = store.createConversation({ name: 'Find Me', participants: [] });
      expect(store.getConversation(convo.id)?.name).toBe('Find Me');
      expect(store.getConversation('nonexistent')).toBeUndefined();
    });
  });

  describe('messages', () => {
    it('adds and retrieves messages', () => {
      const convo = store.createConversation({ name: 'Chat', participants: ['Rex'] });
      const msg = store.addMessage(convo.id, {
        sender: 'Rex',
        senderEmoji: '🦕',
        content: 'Hello from Rex!',
      });

      expect(msg.id).toBeTruthy();
      expect(msg.sender).toBe('Rex');
      expect(msg.content).toBe('Hello from Rex!');
      expect(msg.status).toBe('instant');

      const messages = store.getMessages(convo.id);
      expect(messages.length).toBe(1);
      expect(messages[0].content).toBe('Hello from Rex!');
      expect(messages[0].senderEmoji).toBe('🦕');
    });

    it('encrypts content at rest', () => {
      const convo = store.createConversation({ name: 'Secret', participants: ['Rex'] });
      store.addMessage(convo.id, { sender: 'Rex', content: 'Top secret message' });

      // Access raw encrypted blobs via export
      const exported = store.export(convo.id);
      const blob = exported.messages[0];
      expect(blob.encrypted).toBeTruthy();
      expect(blob.encrypted).not.toContain('Top secret');
      expect(blob.senderHint).toBe('Rex'); // sender hint is not encrypted
    });

    it('decryption fails with wrong key', () => {
      const convo = store.createConversation({ name: 'A', participants: [] });
      store.addMessage(convo.id, { sender: 'Rex', content: 'secret' });

      const exported = store.export(convo.id);

      // Try importing with wrong key
      const wrongKey = Buffer.from('b'.repeat(64), 'hex').toString('base64');
      expect(() => {
        store.importConversation(exported, wrongKey);
      }).toThrow('Invalid key');
    });

    it('supports multiple messages in order', () => {
      const convo = store.createConversation({ name: 'Chat', participants: ['Rex', 'Nova'] });
      store.addMessage(convo.id, { sender: 'Rex', content: 'First' });
      store.addMessage(convo.id, { sender: 'Nova', content: 'Second' });
      store.addMessage(convo.id, { sender: 'Rex', content: 'Third' });

      const messages = store.getMessages(convo.id);
      expect(messages.length).toBe(3);
      expect(messages.map(m => m.content)).toEqual(['First', 'Second', 'Third']);
      expect(messages.map(m => m.sender)).toEqual(['Rex', 'Nova', 'Rex']);
    });

    it('updates message count on conversation', () => {
      const convo = store.createConversation({ name: 'Chat', participants: [] });
      store.addMessage(convo.id, { sender: 'Rex', content: 'one' });
      store.addMessage(convo.id, { sender: 'Rex', content: 'two' });
      expect(store.getConversation(convo.id)?.messageCount).toBe(2);
    });

    it('supports limit option', () => {
      const convo = store.createConversation({ name: 'Chat', participants: [] });
      for (let i = 0; i < 10; i++) {
        store.addMessage(convo.id, { sender: 'Rex', content: `msg ${i}` });
      }
      const last3 = store.getMessages(convo.id, { limit: 3 });
      expect(last3.length).toBe(3);
      expect(last3[0].content).toBe('msg 7');
      expect(last3[2].content).toBe('msg 9');
    });

    it('stores metadata encrypted', () => {
      const convo = store.createConversation({ name: 'Meta', participants: [] });
      store.addMessage(convo.id, {
        sender: 'Rex',
        content: 'hello',
        metadata: { imessageRowId: 12345, persona: 'Rex' },
      });
      const messages = store.getMessages(convo.id);
      expect(messages[0].metadata).toEqual({ imessageRowId: 12345, persona: 'Rex' });
    });

    it('throws when adding to unknown conversation', () => {
      expect(() => {
        store.addMessage('nonexistent', { sender: 'Rex', content: 'hello' });
      }).toThrow('No key for conversation');
    });
  });

  describe('status tracking', () => {
    it('updates message status', () => {
      const convo = store.createConversation({ name: 'Chat', participants: [] });
      const msg = store.addMessage(convo.id, { sender: 'Rex', content: 'hello' });
      expect(msg.status).toBe('instant');

      store.updateStatus(msg.id, convo.id, 'syncing');
      const messages = store.getMessages(convo.id);
      expect(messages[0].status).toBe('syncing');

      store.updateStatus(msg.id, convo.id, 'delivered');
      const updated = store.getMessages(convo.id);
      expect(updated[0].status).toBe('delivered');
    });
  });

  describe('export / import', () => {
    it('exports conversation as encrypted blobs', () => {
      const convo = store.createConversation({ name: 'Export Test', participants: ['Rex', 'Nova'] });
      store.addMessage(convo.id, { sender: 'Rex', content: 'Hello' });
      store.addMessage(convo.id, { sender: 'Nova', content: 'World' });

      const exported = store.export(convo.id);
      expect(exported._type).toBe('openrappter-twin-channel');
      expect(exported.version).toBe(1);
      expect(exported.conversation.name).toBe('Export Test');
      expect(exported.conversation.messageCount).toBe(2);
      expect(exported.messages.length).toBe(2);
      // Content is encrypted
      expect(exported.messages[0].encrypted).toBeTruthy();
      expect(exported.messages[0].senderHint).toBe('Rex');
    });

    it('imports conversation with correct key', () => {
      const convo = store.createConversation({ name: 'Portable', participants: ['Rex'] });
      store.addMessage(convo.id, { sender: 'Rex', content: 'portable msg' });

      const exported = store.export(convo.id);
      const key = convo.key;

      // Import into a fresh store
      const store2 = new EncryptedMessageStore();
      const imported = store2.importConversation(exported, key);
      expect(imported.name).toBe('Portable');
      expect(imported.messageCount).toBe(1);

      const messages = store2.getMessages(imported.id);
      expect(messages.length).toBe(1);
      expect(messages[0].content).toBe('portable msg');
    });

    it('export throws for unknown conversation', () => {
      expect(() => store.export('nope')).toThrow('Conversation not found');
    });
  });

  describe('key exchange', () => {
    it('generates egg for sharing', () => {
      const convo = store.createConversation({ name: 'Egg Test', participants: ['Rex'] });
      const egg = store.generateEgg(convo.id);
      expect(egg._type).toBe('openrappter-twin-key');
      expect(egg.conversationId).toBe(convo.id);
      expect(egg.key).toBe(convo.key);
      expect(egg.name).toBe('Egg Test');
    });

    it('egg key works for importing exported conversation', () => {
      const convo = store.createConversation({ name: 'Full Loop', participants: ['Rex'] });
      store.addMessage(convo.id, { sender: 'Rex', content: 'encrypted' });

      const egg = store.generateEgg(convo.id);
      const exported = store.export(convo.id);

      const store2 = new EncryptedMessageStore();
      const imported = store2.importConversation(exported, egg.key as string);
      const msgs = store2.getMessages(imported.id);
      expect(msgs[0].content).toBe('encrypted');
    });

    it('getKey returns key for conversation', () => {
      const convo = store.createConversation({ name: 'Key', participants: [] });
      expect(store.getKey(convo.id)).toBe(convo.key);
      expect(store.getKey('unknown')).toBeUndefined();
    });
  });
});
