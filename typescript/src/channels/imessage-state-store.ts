import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import type { AssistantConversationMessage } from '../agents/Assistant.js';
import type { IncomingMessage } from './types.js';

export const IMESSAGE_STATE_SCHEMA_VERSION = 1;
export const IMESSAGE_DEFAULT_STALE_AFTER_MS = 30 * 60 * 1000;

export type IMessageInboundStatus =
  | 'queued'
  | 'stale_pending'
  | 'processing'
  | 'retry_wait'
  | 'response_ready'
  | 'delivering'
  | 'completed'
  | 'ambiguous'
  | 'dead_letter';

export type IMessageOutboxStatus =
  | 'ready'
  | 'preparing'
  | 'sending'
  | 'retry_wait'
  | 'confirmed'
  | 'ambiguous'
  | 'dead_letter';

export interface StoredIMessageInbound {
  messageId: string;
  rowId: number | null;
  conversationKey: string;
  chatGuid: string;
  replyTarget: string;
  sender: string;
  content: string;
  receivedAt: string;
  status: IMessageInboundStatus;
  attempts: number;
  nextAttemptAt: string | null;
  errorCode: string | null;
  responseContent: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface StoredIMessageOutboxChunk {
  id: string;
  inboundId: string;
  conversationKey: string;
  chatGuid: string;
  target: string;
  content: string;
  chunkIndex: number;
  status: IMessageOutboxStatus;
  attempts: number;
  nextAttemptAt: string | null;
  preSendRowId: number | null;
  confirmedRowId: number | null;
  errorCode: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface IMessageConversationRecord {
  conversationKey: string;
  updatedAt: string;
  messages: AssistantConversationMessage[];
}

export interface IMessagePersistentHealth {
  lastConnectedAt?: string;
  lastConnectionErrorCode?: string;
  consecutiveConnectionFailures: number;
  lastPollAttemptAt?: string;
  lastPollSuccessAt?: string;
  lastPollErrorCode?: string;
  consecutivePollFailures: number;
  lastDatabaseMaxRowId?: number;
  lastModelSuccessAt?: string;
  lastModelErrorCode?: string;
  consecutiveModelFailures: number;
  lastSendSuccessAt?: string;
  lastSendErrorCode?: string;
  consecutiveSendFailures: number;
}

export interface IMessageQueueMetrics {
  cursor: number | null;
  inbound: Record<IMessageInboundStatus, number>;
  outbox: Record<IMessageOutboxStatus, number>;
  oldestReadyAt: string | null;
}

export interface IMessageIngestResult {
  cursor: number;
  inserted: boolean;
  status: IMessageInboundStatus | 'ignored' | 'duplicate';
}

export interface CompleteInboundOptions {
  messages?: readonly AssistantConversationMessage[];
  clearConversation?: boolean;
  errorCode?: string;
}

export interface IMessageDurableIngestStore {
  prepareAppleCursor(
    maxRowId: number,
    databaseIdentity?: string,
  ): Promise<number>;
  ingestAppleRow(
    rowId: number,
    message: IncomingMessage | null,
  ): Promise<IMessageIngestResult>;
  recordPollSuccess(databaseMaxRowId: number): Promise<void>;
  recordPollFailure(errorCode: string): Promise<void>;
}

interface DatabaseStatement {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

interface Database {
  exec(sql: string): void;
  prepare(sql: string): DatabaseStatement;
  pragma(sql: string): unknown;
  transaction<T>(operation: () => T): () => T;
  close(): void;
}

type DatabaseConstructor = new (
  filename: string,
  options?: { readonly?: boolean },
) => Database;

interface LegacyCursorState {
  version?: unknown;
  appleRowId?: unknown;
}

interface LegacyConversationState {
  version?: unknown;
  conversations?: unknown;
  deliveries?: unknown;
}

interface LegacyConversation {
  updatedAt?: unknown;
  messages?: unknown;
}

interface LegacyDelivery {
  status?: unknown;
  updatedAt?: unknown;
  conversationKey?: unknown;
  reply?: unknown;
}

interface LegacyReply {
  target?: unknown;
  content?: unknown;
  replyTo?: unknown;
}

interface InboundRow {
  message_id: string;
  row_id: number | null;
  conversation_key: string;
  chat_guid: string;
  reply_target: string;
  sender: string;
  content: string;
  received_at: string;
  status: IMessageInboundStatus;
  attempts: number;
  next_attempt_at: string | null;
  error_code: string | null;
  response_content: string | null;
  created_at: string;
  updated_at: string;
}

interface OutboxRow {
  id: string;
  inbound_id: string;
  conversation_key: string;
  chat_guid: string;
  target: string;
  content: string;
  chunk_index: number;
  status: IMessageOutboxStatus;
  attempts: number;
  next_attempt_at: string | null;
  pre_send_row_id: number | null;
  confirmed_row_id: number | null;
  error_code: string | null;
  created_at: string;
  updated_at: string;
}

interface ConversationRow {
  conversation_key: string;
  updated_at: string;
  messages_json: string;
}

interface CountRow {
  status: string;
  count: number;
}

interface ValueRow {
  value: string;
}

interface IdRow {
  id: string;
}

interface IMessageStateStoreOptions {
  homeDirectory?: string;
  databasePath?: string;
  legacyCursorPath?: string;
  legacyConversationPath?: string;
  staleAfterMs?: number;
  now?: () => number;
  databaseConstructor?: DatabaseConstructor;
  migrateLegacy?: boolean;
}

const INBOUND_STATUSES: IMessageInboundStatus[] = [
  'queued',
  'stale_pending',
  'processing',
  'retry_wait',
  'response_ready',
  'delivering',
  'completed',
  'ambiguous',
  'dead_letter',
];

const OUTBOX_STATUSES: IMessageOutboxStatus[] = [
  'ready',
  'preparing',
  'sending',
  'retry_wait',
  'confirmed',
  'ambiguous',
  'dead_letter',
];

const DEFAULT_HEALTH: IMessagePersistentHealth = {
  consecutiveConnectionFailures: 0,
  consecutivePollFailures: 0,
  consecutiveModelFailures: 0,
  consecutiveSendFailures: 0,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseMessages(value: unknown): AssistantConversationMessage[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (message): message is AssistantConversationMessage =>
        isRecord(message)
        && (message.role === 'user' || message.role === 'assistant')
        && typeof message.content === 'string',
    )
    .slice(-40)
    .map(message => ({ role: message.role, content: message.content }));
}

function conversationKeyFromMessage(message: IncomingMessage): {
  conversationKey: string;
  chatGuid: string;
  replyTarget: string;
} {
  const chatGuid = message.metadata?.canonicalChatGuid;
  const replyTarget = message.metadata?.replyTarget;
  if (
    typeof chatGuid !== 'string'
    || !chatGuid
    || typeof replyTarget !== 'string'
    || !replyTarget
  ) {
    throw new Error('iMessage metadata is missing a safe reply target');
  }
  return {
    conversationKey: `imessage:${chatGuid}`,
    chatGuid,
    replyTarget,
  };
}

function validIsoTimestamp(value: string, fallback: string): string {
  return Number.isFinite(Date.parse(value)) ? value : fallback;
}

function chunkLegacyReply(content: string): string[] {
  const characters = Array.from(content);
  if (characters.length === 0) return [''];
  const chunks: string[] = [];
  for (let index = 0; index < characters.length; index += 3_000) {
    chunks.push(characters.slice(index, index + 3_000).join(''));
  }
  return chunks;
}

function safeJsonParse<T>(content: string, description: string): T {
  try {
    return JSON.parse(content) as T;
  } catch {
    throw new Error(`Invalid ${description}`);
  }
}

function inboundFromRow(row: InboundRow): StoredIMessageInbound {
  return {
    messageId: row.message_id,
    rowId: row.row_id,
    conversationKey: row.conversation_key,
    chatGuid: row.chat_guid,
    replyTarget: row.reply_target,
    sender: row.sender,
    content: row.content,
    receivedAt: row.received_at,
    status: row.status,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    errorCode: row.error_code,
    responseContent: row.response_content,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function outboxFromRow(row: OutboxRow): StoredIMessageOutboxChunk {
  return {
    id: row.id,
    inboundId: row.inbound_id,
    conversationKey: row.conversation_key,
    chatGuid: row.chat_guid,
    target: row.target,
    content: row.content,
    chunkIndex: row.chunk_index,
    status: row.status,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    preSendRowId: row.pre_send_row_id,
    confirmedRowId: row.confirmed_row_id,
    errorCode: row.error_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class IMessageStateStore implements IMessageDurableIngestStore {
  readonly databasePath: string;
  private readonly homeDirectory: string;
  private readonly legacyCursorPath: string;
  private readonly legacyConversationPath: string;
  private readonly staleAfterMs: number;
  private readonly now: () => number;
  private readonly injectedDatabaseConstructor?: DatabaseConstructor;
  private readonly migrateLegacy: boolean;
  private database: Database | null = null;

  constructor(options: IMessageStateStoreOptions = {}) {
    this.homeDirectory = options.homeDirectory ?? os.homedir();
    const stateDirectory = path.join(this.homeDirectory, '.openrappter');
    this.databasePath =
      options.databasePath ?? path.join(stateDirectory, 'imessage.sqlite');
    this.legacyCursorPath =
      options.legacyCursorPath ?? path.join(stateDirectory, 'imessage-state.json');
    this.legacyConversationPath =
      options.legacyConversationPath
      ?? path.join(stateDirectory, 'imessage-conversations.json');
    this.staleAfterMs =
      Number.isFinite(options.staleAfterMs) && (options.staleAfterMs ?? -1) >= 0
        ? Math.floor(options.staleAfterMs!)
        : IMESSAGE_DEFAULT_STALE_AFTER_MS;
    this.now = options.now ?? Date.now;
    this.injectedDatabaseConstructor = options.databaseConstructor;
    this.migrateLegacy =
      options.migrateLegacy ?? this.databasePath !== ':memory:';
  }

  async initialize(): Promise<void> {
    if (this.database) return;

    if (this.databasePath !== ':memory:') {
      const directory = path.dirname(this.databasePath);
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      await fs.chmod(directory, 0o700);
    }

    const DatabaseClass =
      this.injectedDatabaseConstructor
      ?? (await import('better-sqlite3')).default as unknown as DatabaseConstructor;
    this.database = new DatabaseClass(this.databasePath);
    const database = this.requireDatabase();
    database.pragma('foreign_keys = ON');
    database.pragma('busy_timeout = 5000');
    if (this.databasePath !== ':memory:') {
      database.pragma('journal_mode = WAL');
      database.pragma('synchronous = FULL');
    }
    this.createSchema();
    if (this.migrateLegacy) {
      await this.migrateLegacyState();
    }
    this.recoverInterruptedWork();
    await this.secureDatabaseFiles();
  }

  async close(): Promise<void> {
    if (!this.database) return;
    this.database.close();
    this.database = null;
  }

  async prepareAppleCursor(
    maxRowId: number,
    databaseIdentity?: string,
  ): Promise<number> {
    if (!Number.isSafeInteger(maxRowId) || maxRowId < 0) {
      throw new Error('Invalid iMessage database cursor');
    }

    const database = this.requireDatabase();
    const operation = database.transaction(() => {
      const current = this.readCursor();
      const previousIdentity = this.readMeta('apple_database_identity');
      const identityChanged =
        Boolean(databaseIdentity)
        && previousIdentity !== null
        && previousIdentity !== databaseIdentity;
      if (current === null || current > maxRowId || identityChanged) {
        if (current !== null && (current > maxRowId || identityChanged)) {
          database.prepare(`
            UPDATE imessage_inbound
            SET row_id = NULL,
                updated_at = ?
            WHERE row_id IS NOT NULL
          `).run(this.timestamp());
          const generation = Number(this.readMeta('database_generation') ?? 1);
          this.writeMeta(
            'database_generation',
            String(Number.isSafeInteger(generation) ? generation + 1 : 2),
          );
        }
        this.writeMeta('apple_row_id', String(maxRowId));
      }
      if (databaseIdentity && previousIdentity !== databaseIdentity) {
        this.writeMeta('apple_database_identity', databaseIdentity);
      }
      return current === null || current > maxRowId || identityChanged
        ? maxRowId
        : current;
    });
    const cursor = operation();
    await this.secureDatabaseFiles();
    return cursor;
  }

  async getAppleCursor(): Promise<number | null> {
    return this.readCursor();
  }

  async ingestAppleRow(
    rowId: number,
    message: IncomingMessage | null,
  ): Promise<IMessageIngestResult> {
    if (!Number.isSafeInteger(rowId) || rowId < 0) {
      throw new Error('Invalid iMessage database row');
    }

    const now = this.timestamp();
    const messageDetails = message ? conversationKeyFromMessage(message) : null;
    const database = this.requireDatabase();
    const operation = database.transaction(() => {
      const current = this.readCursor() ?? 0;
      let inserted = false;
      let status: IMessageInboundStatus | 'ignored' | 'duplicate' =
        message ? 'duplicate' : 'ignored';

      if (message && messageDetails) {
        const existing = database.prepare(
          'SELECT message_id AS id FROM imessage_inbound WHERE message_id = ?',
        ).get(message.id) as IdRow | undefined;
        const receivedAt = validIsoTimestamp(message.timestamp, now);
        const receivedTimestamp = Date.parse(receivedAt);
        const stale =
          Number.isFinite(receivedTimestamp)
          && receivedTimestamp < this.now() - this.staleAfterMs;
        const candidateStatus: IMessageInboundStatus =
          stale ? 'stale_pending' : 'queued';

        const result = database.prepare(`
          INSERT INTO imessage_inbound (
            message_id, row_id, conversation_key, chat_guid, reply_target,
            sender, content, received_at, status, attempts, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
          ON CONFLICT(message_id) DO UPDATE SET
            row_id = COALESCE(imessage_inbound.row_id, excluded.row_id),
            conversation_key = CASE
              WHEN imessage_inbound.conversation_key = ''
              THEN excluded.conversation_key
              ELSE imessage_inbound.conversation_key
            END,
            chat_guid = CASE
              WHEN imessage_inbound.chat_guid = ''
              THEN excluded.chat_guid
              ELSE imessage_inbound.chat_guid
            END,
            reply_target = CASE
              WHEN imessage_inbound.reply_target = ''
              THEN excluded.reply_target
              ELSE imessage_inbound.reply_target
            END,
            sender = CASE
              WHEN imessage_inbound.sender = ''
              THEN excluded.sender
              ELSE imessage_inbound.sender
            END,
            content = CASE
              WHEN imessage_inbound.content = ''
              THEN excluded.content
              ELSE imessage_inbound.content
            END,
            received_at = CASE
              WHEN imessage_inbound.content = ''
              THEN excluded.received_at
              ELSE imessage_inbound.received_at
            END,
            updated_at = excluded.updated_at
        `).run(
          message.id,
          rowId,
          messageDetails.conversationKey,
          messageDetails.chatGuid,
          messageDetails.replyTarget,
          message.sender,
          message.content,
          receivedAt,
          candidateStatus,
          now,
          now,
        );
        inserted = !existing && result.changes > 0;
        const stored = database.prepare(
          'SELECT status FROM imessage_inbound WHERE message_id = ?',
        ).get(message.id) as { status: IMessageInboundStatus };
        status = stored.status;
      }

      if (rowId > current) {
        this.writeMeta('apple_row_id', String(rowId));
      }

      return {
        cursor: Math.max(current, rowId),
        inserted,
        status: rowId <= current && !message ? 'duplicate' : status,
      };
    });

    const result = operation();
    await this.secureDatabaseFiles();
    return result;
  }

  async listConversations(): Promise<IMessageConversationRecord[]> {
    const rows = this.requireDatabase()
      .prepare(`
        SELECT conversation_key, updated_at, messages_json
        FROM imessage_conversations
        ORDER BY updated_at DESC
      `)
      .all() as ConversationRow[];
    return rows.map(row => ({
      conversationKey: row.conversation_key,
      updatedAt: row.updated_at,
      messages: parseMessages(
        safeJsonParse<unknown>(row.messages_json, 'iMessage conversation data'),
      ),
    }));
  }

  async getInbound(messageId: string): Promise<StoredIMessageInbound | null> {
    const row = this.requireDatabase()
      .prepare('SELECT * FROM imessage_inbound WHERE message_id = ?')
      .get(messageId) as InboundRow | undefined;
    return row ? inboundFromRow(row) : null;
  }

  async getOutbox(id: string): Promise<StoredIMessageOutboxChunk | null> {
    const row = this.requireDatabase()
      .prepare('SELECT * FROM imessage_outbox WHERE id = ?')
      .get(id) as OutboxRow | undefined;
    return row ? outboxFromRow(row) : null;
  }

  async getStaleCount(conversationKey?: string): Promise<number> {
    const row = conversationKey
      ? this.requireDatabase().prepare(`
          SELECT COUNT(*) AS count
          FROM imessage_inbound
          WHERE status = 'stale_pending'
            AND conversation_key = ?
        `).get(conversationKey) as { count: number }
      : this.requireDatabase().prepare(`
          SELECT COUNT(*) AS count
          FROM imessage_inbound
          WHERE status = 'stale_pending'
        `).get() as { count: number };
    return Number(row.count);
  }

  async claimReadyInbound(
    now: string,
    limit = 8,
  ): Promise<StoredIMessageInbound[]> {
    const boundedLimit = Math.max(1, Math.min(32, Math.floor(limit)));
    const database = this.requireDatabase();
    const operation = database.transaction(() => {
      const rows = database.prepare(`
        SELECT candidate.*
        FROM imessage_inbound candidate
        WHERE candidate.status IN ('queued', 'retry_wait')
          AND (
            candidate.next_attempt_at IS NULL
            OR candidate.next_attempt_at <= ?
          )
          AND NOT EXISTS (
            SELECT 1
            FROM imessage_inbound earlier
            WHERE earlier.conversation_key = candidate.conversation_key
              AND earlier._rowid_ < candidate._rowid_
              AND earlier.status NOT IN (
                'completed', 'ambiguous', 'dead_letter', 'stale_pending'
              )
          )
        ORDER BY candidate._rowid_
        LIMIT ?
      `).all(now, boundedLimit) as InboundRow[];

      const update = database.prepare(`
        UPDATE imessage_inbound
        SET status = 'processing',
            attempts = attempts + 1,
            next_attempt_at = NULL,
            updated_at = ?
        WHERE message_id = ?
          AND status IN ('queued', 'retry_wait')
      `);
      const claimed: InboundRow[] = [];
      const claimedConversations = new Set<string>();
      for (const row of rows) {
        if (claimedConversations.has(row.conversation_key)) continue;
        const result = update.run(now, row.message_id);
        if (result.changes === 1) {
          claimedConversations.add(row.conversation_key);
          claimed.push({
            ...row,
            status: 'processing',
            attempts: row.attempts + 1,
            next_attempt_at: null,
            updated_at: now,
          });
        }
      }
      return claimed.map(inboundFromRow);
    });
    const jobs = operation();
    await this.secureDatabaseFiles();
    return jobs;
  }

  async completeInboundWithReply(
    messageId: string,
    replyChunks: readonly string[],
    options: CompleteInboundOptions = {},
  ): Promise<void> {
    if (replyChunks.length === 0 || replyChunks.some(chunk => !chunk)) {
      throw new Error('iMessage reply must contain at least one non-empty chunk');
    }

    const database = this.requireDatabase();
    const now = this.timestamp();
    const operation = database.transaction(() => {
      const inbound = database.prepare(
        'SELECT * FROM imessage_inbound WHERE message_id = ?',
      ).get(messageId) as InboundRow | undefined;
      if (!inbound) throw new Error('iMessage inbound job is missing');
      if (!['processing', 'response_ready'].includes(inbound.status)) {
        throw new Error('iMessage inbound job is not ready for a response');
      }

      if (options.clearConversation) {
        database.prepare(
          'DELETE FROM imessage_conversations WHERE conversation_key = ?',
        ).run(inbound.conversation_key);
      } else if (options.messages) {
        const messages = parseMessages(options.messages);
        database.prepare(`
          INSERT INTO imessage_conversations (
            conversation_key, updated_at, messages_json
          ) VALUES (?, ?, ?)
          ON CONFLICT(conversation_key) DO UPDATE SET
            updated_at = excluded.updated_at,
            messages_json = excluded.messages_json
        `).run(inbound.conversation_key, now, JSON.stringify(messages));
      }

      database.prepare(`
        UPDATE imessage_inbound
        SET status = 'response_ready',
            response_content = ?,
            error_code = ?,
            updated_at = ?
        WHERE message_id = ?
      `).run(
        replyChunks.join(''),
        options.errorCode ?? null,
        now,
        messageId,
      );

      const insertChunk = database.prepare(`
        INSERT INTO imessage_outbox (
          id, inbound_id, conversation_key, chat_guid, target, content,
          chunk_index, status, attempts, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'ready', 0, ?, ?)
        ON CONFLICT(inbound_id, chunk_index) DO NOTHING
      `);
      replyChunks.forEach((content, chunkIndex) => {
        insertChunk.run(
          `${messageId}:${chunkIndex}`,
          messageId,
          inbound.conversation_key,
          inbound.chat_guid,
          inbound.reply_target,
          content,
          chunkIndex,
          now,
          now,
        );
      });
    });
    operation();
    await this.secureDatabaseFiles();
  }

  async retryInbound(
    messageId: string,
    errorCode: string,
    nextAttemptAt: string,
  ): Promise<void> {
    const now = this.timestamp();
    const result = this.requireDatabase().prepare(`
      UPDATE imessage_inbound
      SET status = 'retry_wait',
          next_attempt_at = ?,
          error_code = ?,
          updated_at = ?
      WHERE message_id = ?
        AND status = 'processing'
    `).run(nextAttemptAt, errorCode, now, messageId);
    if (result.changes !== 1) {
      throw new Error('iMessage inbound job could not be scheduled for retry');
    }
    await this.secureDatabaseFiles();
  }

  async deadLetterInbound(messageId: string, errorCode: string): Promise<void> {
    const now = this.timestamp();
    const result = this.requireDatabase().prepare(`
      UPDATE imessage_inbound
      SET status = 'dead_letter',
          next_attempt_at = NULL,
          error_code = ?,
          updated_at = ?
      WHERE message_id = ?
        AND status IN ('processing', 'retry_wait', 'queued')
    `).run(errorCode, now, messageId);
    if (result.changes !== 1) {
      throw new Error('iMessage inbound job could not be dead-lettered');
    }
    await this.secureDatabaseFiles();
  }

  async resumeStale(conversationKey: string): Promise<number> {
    const now = this.timestamp();
    const result = this.requireDatabase().prepare(`
      UPDATE imessage_inbound
      SET status = 'queued',
          next_attempt_at = NULL,
          error_code = NULL,
          updated_at = ?
      WHERE conversation_key = ?
        AND status = 'stale_pending'
    `).run(now, conversationKey);
    await this.secureDatabaseFiles();
    return result.changes;
  }

  async clearConversation(conversationKey: string): Promise<void> {
    this.requireDatabase()
      .prepare('DELETE FROM imessage_conversations WHERE conversation_key = ?')
      .run(conversationKey);
    await this.secureDatabaseFiles();
  }

  async getConversationMessageCount(conversationKey: string): Promise<number> {
    const row = this.requireDatabase().prepare(`
      SELECT messages_json
      FROM imessage_conversations
      WHERE conversation_key = ?
    `).get(conversationKey) as { messages_json: string } | undefined;
    if (!row) return 0;
    return parseMessages(
      safeJsonParse<unknown>(row.messages_json, 'iMessage conversation data'),
    ).length;
  }

  async claimReadyOutbox(
    now: string,
    limit = 8,
  ): Promise<StoredIMessageOutboxChunk[]> {
    const boundedLimit = Math.max(1, Math.min(32, Math.floor(limit)));
    const database = this.requireDatabase();
    const operation = database.transaction(() => {
      const rows = database.prepare(`
        SELECT chunk.*
        FROM imessage_outbox chunk
        JOIN imessage_inbound inbound ON inbound.message_id = chunk.inbound_id
        WHERE chunk.status IN ('ready', 'retry_wait')
          AND (
            chunk.next_attempt_at IS NULL
            OR chunk.next_attempt_at <= ?
          )
          AND NOT EXISTS (
            SELECT 1
            FROM imessage_outbox earlier_chunk
            WHERE earlier_chunk.inbound_id = chunk.inbound_id
              AND earlier_chunk.chunk_index < chunk.chunk_index
              AND earlier_chunk.status != 'confirmed'
          )
          AND NOT EXISTS (
            SELECT 1
            FROM imessage_inbound earlier_inbound
            WHERE earlier_inbound.conversation_key = inbound.conversation_key
              AND earlier_inbound._rowid_ < inbound._rowid_
              AND earlier_inbound.status NOT IN (
                'completed', 'ambiguous', 'dead_letter', 'stale_pending'
              )
          )
        ORDER BY inbound._rowid_, chunk.chunk_index
        LIMIT ?
      `).all(now, boundedLimit) as OutboxRow[];

      const update = database.prepare(`
        UPDATE imessage_outbox
        SET status = 'preparing',
            attempts = attempts + 1,
            next_attempt_at = NULL,
            updated_at = ?
        WHERE id = ?
          AND status IN ('ready', 'retry_wait')
      `);
      const claimed: OutboxRow[] = [];
      const claimedConversations = new Set<string>();
      for (const row of rows) {
        if (claimedConversations.has(row.conversation_key)) continue;
        const result = update.run(now, row.id);
        if (result.changes === 1) {
          claimedConversations.add(row.conversation_key);
          claimed.push({
            ...row,
            status: 'preparing',
            attempts: row.attempts + 1,
            next_attempt_at: null,
            updated_at: now,
          });
        }
      }
      return claimed.map(outboxFromRow);
    });
    const chunks = operation();
    await this.secureDatabaseFiles();
    return chunks;
  }

  async markOutboxSending(id: string, preSendRowId: number): Promise<void> {
    if (!Number.isSafeInteger(preSendRowId) || preSendRowId < 0) {
      throw new Error('Invalid iMessage pre-send cursor');
    }
    const now = this.timestamp();
    const result = this.requireDatabase().prepare(`
      UPDATE imessage_outbox
      SET status = 'sending',
          pre_send_row_id = ?,
          updated_at = ?
      WHERE id = ?
        AND status = 'preparing'
    `).run(preSendRowId, now, id);
    if (result.changes !== 1) {
      throw new Error('iMessage outbox chunk is not prepared for sending');
    }
    await this.secureDatabaseFiles();
  }

  async listSendingOutbox(): Promise<StoredIMessageOutboxChunk[]> {
    const rows = this.requireDatabase().prepare(`
      SELECT *
      FROM imessage_outbox
      WHERE status = 'sending'
      ORDER BY created_at, chunk_index
    `).all() as OutboxRow[];
    return rows.map(outboxFromRow);
  }

  async listPersistedReplyTargets(): Promise<string[]> {
    const rows = this.requireDatabase().prepare(`
      SELECT DISTINCT reply_target AS value
      FROM imessage_inbound
      WHERE reply_target != ''
      UNION
      SELECT DISTINCT target AS value
      FROM imessage_outbox
      WHERE target != ''
    `).all() as ValueRow[];
    return rows.map(row => row.value);
  }

  async confirmOutbox(id: string, confirmedRowId: number): Promise<void> {
    if (!Number.isSafeInteger(confirmedRowId) || confirmedRowId < 0) {
      throw new Error('Invalid iMessage confirmation row');
    }
    await this.finishOutbox(id, 'confirmed', null, confirmedRowId);
  }

  async retryOutbox(
    id: string,
    errorCode: string,
    nextAttemptAt: string,
  ): Promise<void> {
    const now = this.timestamp();
    const result = this.requireDatabase().prepare(`
      UPDATE imessage_outbox
      SET status = 'retry_wait',
          next_attempt_at = ?,
          error_code = ?,
          pre_send_row_id = NULL,
          updated_at = ?
      WHERE id = ?
        AND status = 'preparing'
    `).run(nextAttemptAt, errorCode, now, id);
    if (result.changes !== 1) {
      throw new Error('iMessage outbox chunk could not be scheduled for retry');
    }
    await this.secureDatabaseFiles();
  }

  async markOutboxAmbiguous(id: string, errorCode: string): Promise<void> {
    await this.finishOutbox(id, 'ambiguous', errorCode, null);
  }

  async deadLetterOutbox(id: string, errorCode: string): Promise<void> {
    await this.finishOutbox(id, 'dead_letter', errorCode, null);
  }

  async retryLatestAmbiguous(conversationKey: string): Promise<string | null> {
    const database = this.requireDatabase();
    const now = this.timestamp();
    const operation = database.transaction(() => {
      const row = database.prepare(`
        SELECT id, inbound_id
        FROM imessage_outbox
        WHERE conversation_key = ?
          AND status = 'ambiguous'
        ORDER BY updated_at DESC
        LIMIT 1
      `).get(conversationKey) as { id: string; inbound_id: string } | undefined;
      if (!row) return null;

      database.prepare(`
        UPDATE imessage_outbox
        SET status = 'ready',
            next_attempt_at = NULL,
            pre_send_row_id = NULL,
            confirmed_row_id = NULL,
            error_code = NULL,
            updated_at = ?
        WHERE id = ?
      `).run(now, row.id);
      database.prepare(`
        UPDATE imessage_outbox
        SET status = 'ready',
            next_attempt_at = NULL,
            pre_send_row_id = NULL,
            confirmed_row_id = NULL,
            error_code = NULL,
            updated_at = ?
        WHERE inbound_id = ?
          AND status = 'dead_letter'
          AND error_code = 'preceding_chunk_ambiguous'
      `).run(now, row.inbound_id);
      database.prepare(`
        UPDATE imessage_inbound
        SET status = 'response_ready',
            error_code = NULL,
            updated_at = ?
        WHERE message_id = ?
      `).run(now, row.inbound_id);
      return row.id;
    });
    const id = operation();
    await this.secureDatabaseFiles();
    return id;
  }

  async quarantineUnauthorizedTarget(target: string): Promise<number> {
    const database = this.requireDatabase();
    const now = this.timestamp();
    const operation = database.transaction(() => {
      const inboundRows = database.prepare(`
        SELECT DISTINCT inbound_id AS id
        FROM imessage_outbox
        WHERE target = ?
          AND status IN ('ready', 'preparing', 'sending', 'retry_wait')
      `).all(target) as IdRow[];
      if (inboundRows.length === 0) return 0;

      database.prepare(`
        UPDATE imessage_outbox
        SET status = CASE
              WHEN status = 'sending' THEN 'ambiguous'
              ELSE 'dead_letter'
            END,
            next_attempt_at = NULL,
            error_code = 'target_no_longer_allowed',
            updated_at = ?
        WHERE target = ?
          AND status IN ('ready', 'preparing', 'sending', 'retry_wait')
      `).run(now, target);

      const updateInbound = database.prepare(`
        UPDATE imessage_inbound
        SET status = CASE
              WHEN EXISTS (
                SELECT 1
                FROM imessage_outbox
                WHERE inbound_id = imessage_inbound.message_id
                  AND status = 'ambiguous'
              ) THEN 'ambiguous'
              ELSE 'dead_letter'
            END,
            error_code = 'target_no_longer_allowed',
            updated_at = ?
        WHERE message_id = ?
      `);
      inboundRows.forEach(row => updateInbound.run(now, row.id));
      return inboundRows.length;
    });
    const count = operation();
    await this.secureDatabaseFiles();
    return count;
  }

  async getMetrics(): Promise<IMessageQueueMetrics> {
    const database = this.requireDatabase();
    const inbound = Object.fromEntries(
      INBOUND_STATUSES.map(status => [status, 0]),
    ) as Record<IMessageInboundStatus, number>;
    const outbox = Object.fromEntries(
      OUTBOX_STATUSES.map(status => [status, 0]),
    ) as Record<IMessageOutboxStatus, number>;

    for (const row of database.prepare(`
      SELECT status, COUNT(*) AS count
      FROM imessage_inbound
      GROUP BY status
    `).all() as CountRow[]) {
      if (INBOUND_STATUSES.includes(row.status as IMessageInboundStatus)) {
        inbound[row.status as IMessageInboundStatus] = Number(row.count);
      }
    }
    for (const row of database.prepare(`
      SELECT status, COUNT(*) AS count
      FROM imessage_outbox
      GROUP BY status
    `).all() as CountRow[]) {
      if (OUTBOX_STATUSES.includes(row.status as IMessageOutboxStatus)) {
        outbox[row.status as IMessageOutboxStatus] = Number(row.count);
      }
    }
    const oldest = database.prepare(`
      SELECT MIN(received_at) AS value
      FROM imessage_inbound
      WHERE status IN (
        'queued', 'processing', 'retry_wait', 'response_ready', 'delivering'
      )
    `).get() as { value: string | null };

    return {
      cursor: this.readCursor(),
      inbound,
      outbox,
      oldestReadyAt: oldest.value,
    };
  }

  async getHealth(): Promise<IMessagePersistentHealth> {
    const row = this.requireDatabase()
      .prepare("SELECT value FROM imessage_meta WHERE key = 'health'")
      .get() as ValueRow | undefined;
    if (!row) return { ...DEFAULT_HEALTH };
    const parsed = safeJsonParse<unknown>(row.value, 'iMessage health state');
    if (!isRecord(parsed)) {
      throw new Error('Invalid iMessage health state');
    }
    return {
      ...DEFAULT_HEALTH,
      ...parsed,
    };
  }

  async patchHealth(
    patch: Partial<IMessagePersistentHealth>,
  ): Promise<IMessagePersistentHealth> {
    const database = this.requireDatabase();
    const operation = database.transaction(() => {
      const row = database.prepare(
        "SELECT value FROM imessage_meta WHERE key = 'health'",
      ).get() as ValueRow | undefined;
      const current = row
        ? safeJsonParse<IMessagePersistentHealth>(
            row.value,
            'iMessage health state',
          )
        : DEFAULT_HEALTH;
      const next = { ...DEFAULT_HEALTH, ...current, ...patch };
      this.writeMeta('health', JSON.stringify(next));
      return next;
    });
    const health = operation();
    await this.secureDatabaseFiles();
    return health;
  }

  async recordPollSuccess(databaseMaxRowId: number): Promise<void> {
    const health = await this.getHealth();
    await this.patchHealth({
      lastPollAttemptAt: this.timestamp(),
      lastPollSuccessAt: this.timestamp(),
      lastPollErrorCode: undefined,
      consecutivePollFailures: 0,
      lastDatabaseMaxRowId: databaseMaxRowId,
      consecutiveConnectionFailures: health.consecutiveConnectionFailures,
    });
  }

  async recordPollFailure(errorCode: string): Promise<void> {
    const health = await this.getHealth();
    await this.patchHealth({
      lastPollAttemptAt: this.timestamp(),
      lastPollErrorCode: errorCode,
      consecutivePollFailures: health.consecutivePollFailures + 1,
    });
  }

  private createSchema(): void {
    this.requireDatabase().exec(`
      CREATE TABLE IF NOT EXISTS imessage_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS imessage_conversations (
        conversation_key TEXT PRIMARY KEY,
        updated_at TEXT NOT NULL,
        messages_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS imessage_inbound (
        message_id TEXT PRIMARY KEY,
        row_id INTEGER UNIQUE,
        conversation_key TEXT NOT NULL,
        chat_guid TEXT NOT NULL,
        reply_target TEXT NOT NULL,
        sender TEXT NOT NULL,
        content TEXT NOT NULL,
        received_at TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN (
          'queued', 'stale_pending', 'processing', 'retry_wait',
          'response_ready', 'delivering', 'completed', 'ambiguous',
          'dead_letter'
        )),
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT,
        error_code TEXT,
        response_content TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS imessage_inbound_ready
        ON imessage_inbound(status, next_attempt_at, row_id);
      CREATE INDEX IF NOT EXISTS imessage_inbound_conversation
        ON imessage_inbound(conversation_key, row_id);

      CREATE TABLE IF NOT EXISTS imessage_outbox (
        id TEXT PRIMARY KEY,
        inbound_id TEXT NOT NULL REFERENCES imessage_inbound(message_id),
        conversation_key TEXT NOT NULL,
        chat_guid TEXT NOT NULL,
        target TEXT NOT NULL,
        content TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN (
          'ready', 'preparing', 'sending', 'retry_wait', 'confirmed',
          'ambiguous', 'dead_letter'
        )),
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT,
        pre_send_row_id INTEGER,
        confirmed_row_id INTEGER,
        error_code TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(inbound_id, chunk_index)
      );

      CREATE INDEX IF NOT EXISTS imessage_outbox_ready
        ON imessage_outbox(status, next_attempt_at, created_at);
      CREATE INDEX IF NOT EXISTS imessage_outbox_inbound
        ON imessage_outbox(inbound_id, chunk_index);
    `);
    this.writeMeta(
      'schema_version',
      String(IMESSAGE_STATE_SCHEMA_VERSION),
    );
  }

  private async migrateLegacyState(): Promise<void> {
    if (this.readMeta('legacy_migrated') === '1') return;

    const [cursorContent, conversationContent] = await Promise.all([
      this.readOptionalFile(this.legacyCursorPath),
      this.readOptionalFile(this.legacyConversationPath),
    ]);
    const cursorState = cursorContent
      ? safeJsonParse<LegacyCursorState>(
          cursorContent,
          'legacy iMessage cursor state',
        )
      : null;
    const conversationState = conversationContent
      ? safeJsonParse<LegacyConversationState>(
          conversationContent,
          'legacy iMessage conversation state',
        )
      : null;

    const database = this.requireDatabase();
    const operation = database.transaction(() => {
      if (
        cursorState
        && cursorState.version === 1
        && Number.isSafeInteger(cursorState.appleRowId)
        && Number(cursorState.appleRowId) >= 0
        && this.readCursor() === null
      ) {
        this.writeMeta('apple_row_id', String(cursorState.appleRowId));
      }

      if (conversationState?.version === 1) {
        this.migrateLegacyConversations(conversationState);
        this.migrateLegacyDeliveries(conversationState);
      }
      this.writeMeta('legacy_migrated', '1');
    });
    operation();
    await this.secureDatabaseFiles();
  }

  private migrateLegacyConversations(state: LegacyConversationState): void {
    if (!isRecord(state.conversations)) return;
    const database = this.requireDatabase();
    const insert = database.prepare(`
      INSERT INTO imessage_conversations (
        conversation_key, updated_at, messages_json
      ) VALUES (?, ?, ?)
      ON CONFLICT(conversation_key) DO NOTHING
    `);
    const now = this.timestamp();
    for (const [conversationKey, raw] of Object.entries(state.conversations)) {
      const entry = raw as LegacyConversation;
      if (
        !conversationKey
        || !isRecord(entry)
        || typeof entry.updatedAt !== 'string'
      ) {
        continue;
      }
      insert.run(
        conversationKey,
        validIsoTimestamp(entry.updatedAt, now),
        JSON.stringify(parseMessages(entry.messages)),
      );
    }
  }

  private migrateLegacyDeliveries(state: LegacyConversationState): void {
    if (!isRecord(state.deliveries)) return;
    const database = this.requireDatabase();
    const insertInbound = database.prepare(`
      INSERT INTO imessage_inbound (
        message_id, row_id, conversation_key, chat_guid, reply_target,
        sender, content, received_at, status, attempts, response_content,
        created_at, updated_at
      ) VALUES (?, NULL, ?, ?, ?, ?, '', ?, ?, 0, ?, ?, ?)
      ON CONFLICT(message_id) DO NOTHING
    `);
    const insertOutbox = database.prepare(`
      INSERT INTO imessage_outbox (
        id, inbound_id, conversation_key, chat_guid, target, content,
        chunk_index, status, attempts, error_code, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
      ON CONFLICT(inbound_id, chunk_index) DO NOTHING
    `);
    const now = this.timestamp();

    for (const [messageId, raw] of Object.entries(state.deliveries)) {
      const delivery = raw as LegacyDelivery;
      if (
        !messageId
        || !isRecord(delivery)
        || !['ready', 'sending', 'sent'].includes(String(delivery.status))
        || typeof delivery.conversationKey !== 'string'
        || !delivery.conversationKey
        || !isRecord(delivery.reply)
      ) {
        continue;
      }
      const reply = delivery.reply as LegacyReply;
      if (
        typeof reply.target !== 'string'
        || !reply.target
        || typeof reply.content !== 'string'
        || typeof reply.replyTo !== 'string'
      ) {
        continue;
      }
      const updatedAt =
        typeof delivery.updatedAt === 'string'
          ? validIsoTimestamp(delivery.updatedAt, now)
          : now;
      const chatGuid = delivery.conversationKey.replace(/^imessage:/, '');
      const inboundStatus: IMessageInboundStatus =
        delivery.status === 'sent'
          ? 'completed'
          : delivery.status === 'sending'
            ? 'ambiguous'
            : 'response_ready';
      const outboxStatus: IMessageOutboxStatus =
        delivery.status === 'sent'
          ? 'confirmed'
          : delivery.status === 'sending'
            ? 'ambiguous'
            : 'ready';
      const errorCode =
        delivery.status === 'sending' ? 'legacy_send_ambiguous' : null;

      insertInbound.run(
        messageId,
        delivery.conversationKey,
        chatGuid,
        reply.target,
        reply.target,
        updatedAt,
        inboundStatus,
        reply.content,
        updatedAt,
        updatedAt,
      );
      const replyChunks =
        delivery.status === 'sending'
          ? [reply.content]
          : chunkLegacyReply(reply.content);
      replyChunks.forEach((content, chunkIndex) => {
        insertOutbox.run(
          `${messageId}:${chunkIndex}`,
          messageId,
          delivery.conversationKey,
          chatGuid,
          reply.target,
          content,
          chunkIndex,
          outboxStatus,
          errorCode,
          updatedAt,
          updatedAt,
        );
      });
    }
  }

  private recoverInterruptedWork(): void {
    const database = this.requireDatabase();
    const now = this.timestamp();
    const operation = database.transaction(() => {
      database.prepare(`
        UPDATE imessage_inbound
        SET status = 'retry_wait',
            next_attempt_at = ?,
            error_code = 'process_interrupted',
            updated_at = ?
        WHERE status = 'processing'
      `).run(now, now);
      database.prepare(`
        UPDATE imessage_outbox
        SET status = 'ready',
            next_attempt_at = NULL,
            error_code = 'process_interrupted_before_send',
            updated_at = ?
        WHERE status = 'preparing'
      `).run(now);
    });
    operation();
  }

  private async finishOutbox(
    id: string,
    status: 'confirmed' | 'ambiguous' | 'dead_letter',
    errorCode: string | null,
    confirmedRowId: number | null,
  ): Promise<void> {
    const database = this.requireDatabase();
    const now = this.timestamp();
    const operation = database.transaction(() => {
      const chunk = database.prepare(
        'SELECT inbound_id FROM imessage_outbox WHERE id = ?',
      ).get(id) as { inbound_id: string } | undefined;
      if (!chunk) throw new Error('iMessage outbox chunk is missing');

      const result = database.prepare(`
        UPDATE imessage_outbox
        SET status = ?,
            next_attempt_at = NULL,
            confirmed_row_id = ?,
            error_code = ?,
            updated_at = ?
        WHERE id = ?
          AND status IN ('preparing', 'sending', 'retry_wait')
      `).run(status, confirmedRowId, errorCode, now, id);
      if (result.changes !== 1) {
        throw new Error('iMessage outbox chunk could not be finalized');
      }

      if (status === 'ambiguous' || status === 'dead_letter') {
        database.prepare(`
          UPDATE imessage_outbox
          SET status = CASE
                WHEN status = 'sending' THEN 'ambiguous'
                ELSE 'dead_letter'
              END,
              next_attempt_at = NULL,
              error_code = CASE
                WHEN status = 'sending' THEN 'sibling_send_ambiguous'
                ELSE ?
              END,
              updated_at = ?
          WHERE inbound_id = ?
            AND id != ?
            AND status IN ('ready', 'preparing', 'sending', 'retry_wait')
        `).run(
          status === 'ambiguous'
            ? 'preceding_chunk_ambiguous'
            : 'preceding_chunk_dead_letter',
          now,
          chunk.inbound_id,
          id,
        );
      }

      const remaining = database.prepare(`
        SELECT id
        FROM imessage_outbox
        WHERE inbound_id = ?
          AND status NOT IN ('confirmed', 'ambiguous', 'dead_letter')
        LIMIT 1
      `).get(chunk.inbound_id) as IdRow | undefined;
      if (remaining) {
        database.prepare(`
          UPDATE imessage_inbound
          SET status = 'delivering',
              updated_at = ?
          WHERE message_id = ?
        `).run(now, chunk.inbound_id);
        return;
      }

      const terminalRows = database.prepare(`
        SELECT status, COUNT(*) AS count
        FROM imessage_outbox
        WHERE inbound_id = ?
        GROUP BY status
      `).all(chunk.inbound_id) as CountRow[];
      const terminalCounts = Object.fromEntries(
        terminalRows.map(row => [row.status, Number(row.count)]),
      );
      const inboundStatus: IMessageInboundStatus =
        (terminalCounts.ambiguous ?? 0) > 0
          ? 'ambiguous'
          : (terminalCounts.dead_letter ?? 0) > 0
            ? 'dead_letter'
            : 'completed';
      database.prepare(`
        UPDATE imessage_inbound
        SET status = ?,
            updated_at = ?
        WHERE message_id = ?
      `).run(inboundStatus, now, chunk.inbound_id);
    });
    operation();
    await this.secureDatabaseFiles();
  }

  private readCursor(): number | null {
    const raw = this.readMeta('apple_row_id');
    if (raw === null) return null;
    const cursor = Number(raw);
    if (!Number.isSafeInteger(cursor) || cursor < 0) {
      throw new Error('Invalid iMessage database cursor');
    }
    return cursor;
  }

  private readMeta(key: string): string | null {
    const row = this.requireDatabase()
      .prepare('SELECT value FROM imessage_meta WHERE key = ?')
      .get(key) as ValueRow | undefined;
    return row?.value ?? null;
  }

  private writeMeta(key: string, value: string): void {
    this.requireDatabase().prepare(`
      INSERT INTO imessage_meta (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at
    `).run(key, value, this.timestamp());
  }

  private timestamp(): string {
    const value = this.now();
    return new Date(Number.isFinite(value) ? value : Date.now()).toISOString();
  }

  private requireDatabase(): Database {
    if (!this.database) {
      throw new Error('iMessage state store is not initialized');
    }
    return this.database;
  }

  private async readOptionalFile(filePath: string): Promise<string | null> {
    try {
      return await fs.readFile(filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  private async secureDatabaseFiles(): Promise<void> {
    if (this.databasePath === ':memory:') return;
    const candidates = [
      this.databasePath,
      `${this.databasePath}-wal`,
      `${this.databasePath}-shm`,
    ];
    await Promise.all(
      candidates.map(async candidate => {
        try {
          await fs.chmod(candidate, 0o600);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }),
    );
  }
}
