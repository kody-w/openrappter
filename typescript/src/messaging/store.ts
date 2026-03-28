/**
 * EncryptedMessageStore — AES-256-GCM encrypted conversation storage.
 *
 * Messages are encrypted at rest. Per-conversation keys mean only
 * participants with the key can read content. Encrypted blobs are
 * safe to publish publicly — no plaintext ever leaves the store.
 *
 * Backed by SQLite (via better-sqlite3) for persistence.
 * Falls back to in-memory Map when SQLite is unavailable.
 */

import { randomBytes, createCipheriv, createDecipheriv, createHash } from 'crypto';

// ── Types ────────────────────────────────────────────────────────────────────

export interface TwinMessage {
  id: string;
  conversationId: string;
  sender: string;
  senderEmoji?: string;
  content: string;
  timestamp: string;
  /** Delivery status: instant (in twin) → syncing (to iMessage) → delivered */
  status: 'instant' | 'syncing' | 'delivered' | 'failed';
  /** Optional metadata (persona info, iMessage rowid, etc.) */
  metadata?: Record<string, unknown>;
}

export interface EncryptedBlob {
  id: string;
  conversationId: string;
  encrypted: string; // base64
  iv: string; // base64
  authTag: string; // base64
  senderHint: string; // unencrypted — safe to expose
  senderEmoji?: string;
  timestamp: string;
  status: string;
}

export interface Conversation {
  id: string;
  name: string;
  participants: string[];
  key: string; // base64 AES-256 key
  createdAt: string;
  lastMessageAt?: string;
  messageCount: number;
}

export interface ConversationExport {
  _type: 'openrappter-twin-channel';
  version: number;
  conversation: {
    id: string;
    name: string;
    participants: string[];
    messageCount: number;
  };
  messages: EncryptedBlob[];
}

export interface StoreOptions {
  /** Path to SQLite database. Omit for in-memory only. */
  dbPath?: string;
}

// ── Encryption helpers ───────────────────────────────────────────────────────

function generateKey(): Buffer {
  return randomBytes(32);
}

function encrypt(plaintext: string, key: Buffer): { encrypted: string; iv: string; authTag: string } {
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  let enc = cipher.update(plaintext, 'utf8', 'base64');
  enc += cipher.final('base64');
  return {
    encrypted: enc,
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
  };
}

function decrypt(encrypted: string, iv: string, authTag: string, key: Buffer): string {
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(authTag, 'base64'));
  let dec = decipher.update(encrypted, 'base64', 'utf8');
  dec += decipher.final('utf8');
  return dec;
}

function keyHash(key: Buffer): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

function generateId(): string {
  return randomBytes(12).toString('hex');
}

// ── Store ────────────────────────────────────────────────────────────────────

export class EncryptedMessageStore {
  private conversations = new Map<string, Conversation>();
  private messages = new Map<string, EncryptedBlob[]>(); // conversationId → blobs
  private keys = new Map<string, Buffer>(); // conversationId → key
  private db: any = null;
  private dbPath?: string;

  constructor(options?: StoreOptions) {
    this.dbPath = options?.dbPath;
  }

  async init(): Promise<void> {
    if (this.dbPath) {
      try {
        const Database = (await import('better-sqlite3')).default;
        this.db = new Database(this.dbPath);
        this.db.pragma('journal_mode = WAL');
        this.createTables();
        this.loadFromDb();
      } catch {
        // SQLite unavailable — use in-memory
        this.db = null;
      }
    }
  }

  private createTables(): void {
    if (!this.db) return;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS twin_conversations (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        participants TEXT NOT NULL,
        key_hash TEXT NOT NULL,
        encrypted_key TEXT NOT NULL,
        iv TEXT NOT NULL,
        auth_tag TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_message_at TEXT,
        message_count INTEGER DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS twin_messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        encrypted TEXT NOT NULL,
        iv TEXT NOT NULL,
        auth_tag TEXT NOT NULL,
        sender_hint TEXT NOT NULL,
        sender_emoji TEXT,
        timestamp TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'instant',
        FOREIGN KEY (conversation_id) REFERENCES twin_conversations(id)
      );
      CREATE INDEX IF NOT EXISTS idx_twin_messages_convo ON twin_messages(conversation_id, timestamp);
    `);
  }

  private loadFromDb(): void {
    if (!this.db) return;
    // Load conversations (keys stay encrypted in DB — we need the master key to unlock)
    // For now, conversations loaded in-memory are the source of truth
  }

  // ── Conversations ────────────────────────────────────────────────────────

  createConversation(options: {
    name: string;
    participants: string[];
    key?: string; // base64 — provide to join existing conversation
  }): Conversation {
    const id = generateId();
    const key = options.key ? Buffer.from(options.key, 'base64') : generateKey();

    const convo: Conversation = {
      id,
      name: options.name,
      participants: options.participants,
      key: key.toString('base64'),
      createdAt: new Date().toISOString(),
      messageCount: 0,
    };

    this.conversations.set(id, convo);
    this.keys.set(id, key);
    this.messages.set(id, []);

    // Persist to SQLite
    if (this.db) {
      // Encrypt the key itself with a derived store key (the key hash acts as identifier)
      const storeKey = generateKey(); // In production, derive from a master passphrase
      const encKey = encrypt(key.toString('base64'), storeKey);
      this.db.prepare(`
        INSERT INTO twin_conversations (id, name, participants, key_hash, encrypted_key, iv, auth_tag, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(id, options.name, JSON.stringify(options.participants), keyHash(key), encKey.encrypted, encKey.iv, encKey.authTag, convo.createdAt);
    }

    return convo;
  }

  getConversation(id: string): Conversation | undefined {
    return this.conversations.get(id);
  }

  listConversations(): Conversation[] {
    return Array.from(this.conversations.values());
  }

  // ── Messages ─────────────────────────────────────────────────────────────

  addMessage(conversationId: string, message: {
    sender: string;
    senderEmoji?: string;
    content: string;
    status?: TwinMessage['status'];
    metadata?: Record<string, unknown>;
  }): TwinMessage {
    const key = this.keys.get(conversationId);
    if (!key) throw new Error(`No key for conversation ${conversationId}`);

    const id = generateId();
    const timestamp = new Date().toISOString();
    const status = message.status || 'instant';

    // Encrypt the content + metadata
    const plaintext = JSON.stringify({
      content: message.content,
      metadata: message.metadata,
    });
    const { encrypted, iv, authTag } = encrypt(plaintext, key);

    const blob: EncryptedBlob = {
      id,
      conversationId,
      encrypted,
      iv,
      authTag,
      senderHint: message.sender,
      senderEmoji: message.senderEmoji,
      timestamp,
      status,
    };

    // Store
    const convoMessages = this.messages.get(conversationId) || [];
    convoMessages.push(blob);
    this.messages.set(conversationId, convoMessages);

    // Update conversation
    const convo = this.conversations.get(conversationId);
    if (convo) {
      convo.messageCount++;
      convo.lastMessageAt = timestamp;
    }

    // Persist
    if (this.db) {
      this.db.prepare(`
        INSERT INTO twin_messages (id, conversation_id, encrypted, iv, auth_tag, sender_hint, sender_emoji, timestamp, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, conversationId, encrypted, iv, authTag, message.sender, message.senderEmoji || '', timestamp, status);
      this.db.prepare(`
        UPDATE twin_conversations SET message_count = message_count + 1, last_message_at = ? WHERE id = ?
      `).run(timestamp, conversationId);
    }

    return {
      id,
      conversationId,
      sender: message.sender,
      senderEmoji: message.senderEmoji,
      content: message.content,
      timestamp,
      status,
      metadata: message.metadata,
    };
  }

  getMessages(conversationId: string, options?: { limit?: number; after?: string }): TwinMessage[] {
    const key = this.keys.get(conversationId);
    if (!key) throw new Error(`No key for conversation ${conversationId}`);

    let blobs = this.messages.get(conversationId) || [];

    if (options?.after) {
      const afterTime = new Date(options.after).getTime();
      blobs = blobs.filter(b => new Date(b.timestamp).getTime() > afterTime);
    }

    if (options?.limit) {
      blobs = blobs.slice(-options.limit);
    }

    return blobs.map(blob => {
      const plaintext = decrypt(blob.encrypted, blob.iv, blob.authTag, key);
      const { content, metadata } = JSON.parse(plaintext);
      return {
        id: blob.id,
        conversationId: blob.conversationId,
        sender: blob.senderHint,
        senderEmoji: blob.senderEmoji,
        content,
        timestamp: blob.timestamp,
        status: blob.status as TwinMessage['status'],
        metadata,
      };
    });
  }

  updateStatus(messageId: string, conversationId: string, status: TwinMessage['status']): void {
    const blobs = this.messages.get(conversationId);
    if (!blobs) return;
    const blob = blobs.find(b => b.id === messageId);
    if (blob) {
      blob.status = status;
      if (this.db) {
        this.db.prepare('UPDATE twin_messages SET status = ? WHERE id = ?').run(status, messageId);
      }
    }
  }

  // ── Export / Import ──────────────────────────────────────────────────────

  export(conversationId: string): ConversationExport {
    const convo = this.conversations.get(conversationId);
    if (!convo) throw new Error(`Conversation not found: ${conversationId}`);

    const blobs = this.messages.get(conversationId) || [];

    return {
      _type: 'openrappter-twin-channel',
      version: 1,
      conversation: {
        id: convo.id,
        name: convo.name,
        participants: convo.participants,
        messageCount: convo.messageCount,
      },
      messages: blobs,
    };
  }

  importConversation(data: ConversationExport, key: string): Conversation {
    const keyBuf = Buffer.from(key, 'base64');

    // Verify key works by trying to decrypt first message
    if (data.messages.length > 0) {
      const first = data.messages[0];
      try {
        decrypt(first.encrypted, first.iv, first.authTag, keyBuf);
      } catch {
        throw new Error('Invalid key — cannot decrypt messages');
      }
    }

    const convo: Conversation = {
      id: data.conversation.id,
      name: data.conversation.name,
      participants: data.conversation.participants,
      key: key,
      createdAt: new Date().toISOString(),
      messageCount: data.messages.length,
      lastMessageAt: data.messages[data.messages.length - 1]?.timestamp,
    };

    this.conversations.set(convo.id, convo);
    this.keys.set(convo.id, keyBuf);
    this.messages.set(convo.id, data.messages);

    return convo;
  }

  // ── Key exchange ─────────────────────────────────────────────────────────

  getKey(conversationId: string): string | undefined {
    return this.conversations.get(conversationId)?.key;
  }

  /** Generate an egg.json for sharing conversation access */
  generateEgg(conversationId: string): Record<string, unknown> {
    const convo = this.conversations.get(conversationId);
    if (!convo) throw new Error(`Conversation not found: ${conversationId}`);

    return {
      _type: 'openrappter-twin-key',
      conversationId: convo.id,
      name: convo.name,
      participants: convo.participants,
      key: convo.key,
      hint: 'Import this into an OpenRappter instance to join the conversation.',
    };
  }

  // ── Cleanup ──────────────────────────────────────────────────────────────

  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}
