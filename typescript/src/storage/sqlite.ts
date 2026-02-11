/**
 * SQLite storage adapter
 * Uses better-sqlite3 for synchronous operations wrapped in async interface
 */

import { randomUUID } from 'crypto';
import type {
  StorageAdapter,
  Session,
  SessionFilter,
  MemoryChunkRecord,
  MemorySearchQuery,
  CronJobRecord,
  CronLogRecord,
  Device,
  StorageConfig,
  MigrationRecord,
} from './types.js';
import { migrations, getPendingMigrations } from './migrations.js';

// Type definitions for better-sqlite3 (dynamically imported)
interface Database {
  exec(sql: string): void;
  prepare(sql: string): Statement;
  close(): void;
  pragma(pragma: string): unknown;
  transaction<T>(fn: () => T): () => T;
}

interface Statement {
  run(...params: unknown[]): RunResult;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  bind(...params: unknown[]): Statement;
}

interface RunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

type BetterSqlite3 = (filename: string, options?: { readonly?: boolean }) => Database;

export class SQLiteAdapter implements StorageAdapter {
  private db: Database | null = null;
  private config: StorageConfig;
  private betterSqlite3: BetterSqlite3 | null = null;

  constructor(config: StorageConfig) {
    this.config = config;
  }

  async initialize(): Promise<void> {
    // Dynamic import of better-sqlite3
    try {
      const module = await import('better-sqlite3');
      this.betterSqlite3 = module.default as BetterSqlite3;
    } catch {
      throw new Error(
        'better-sqlite3 is required for SQLite storage. Install it with: npm install better-sqlite3'
      );
    }

    const dbPath = this.config.inMemory ? ':memory:' : (this.config.path ?? 'openrappter.db');
    this.db = this.betterSqlite3(dbPath);

    // Enable foreign keys and WAL mode for better performance
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('journal_mode = WAL');

    // Run migrations
    await this.runMigrations();
  }

  async close(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  private ensureDb(): Database {
    if (!this.db) {
      throw new Error('Database not initialized. Call initialize() first.');
    }
    return this.db;
  }

  private async runMigrations(): Promise<void> {
    const db = this.ensureDb();

    // Create migrations table if not exists
    db.exec(`
      CREATE TABLE IF NOT EXISTS migrations (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      )
    `);

    // Get applied migrations
    const applied = db.prepare('SELECT id FROM migrations').all() as { id: number }[];
    const appliedIds = applied.map((m) => m.id);

    // Apply pending migrations
    const pending = getPendingMigrations(appliedIds);
    for (const migration of pending) {
      db.exec(migration.up);
      db.prepare('INSERT INTO migrations (id, name, applied_at) VALUES (?, ?, ?)').run(
        migration.id,
        migration.name,
        new Date().toISOString()
      );
    }
  }

  // Sessions

  async getSession(id: string): Promise<Session | null> {
    const db = this.ensureDb();
    const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | undefined;
    return row ? this.rowToSession(row) : null;
  }

  async saveSession(session: Session): Promise<void> {
    const db = this.ensureDb();
    db.prepare(
      `INSERT OR REPLACE INTO sessions
       (id, channel_id, conversation_id, agent_id, user_id, metadata, messages,
        created_at, updated_at, expires_at, total_tokens, prompt_tokens, completion_tokens)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      session.id,
      session.channelId,
      session.conversationId,
      session.agentId,
      session.userId ?? null,
      JSON.stringify(session.metadata),
      JSON.stringify(session.messages),
      session.createdAt,
      session.updatedAt,
      session.expiresAt ?? null,
      (session as SessionWithTokens).totalTokens ?? 0,
      (session as SessionWithTokens).promptTokens ?? 0,
      (session as SessionWithTokens).completionTokens ?? 0
    );
  }

  async deleteSession(id: string): Promise<void> {
    const db = this.ensureDb();
    db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
  }

  async listSessions(filter?: SessionFilter): Promise<Session[]> {
    const db = this.ensureDb();
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filter?.channelId) {
      conditions.push('channel_id = ?');
      params.push(filter.channelId);
    }
    if (filter?.conversationId) {
      conditions.push('conversation_id = ?');
      params.push(filter.conversationId);
    }
    if (filter?.agentId) {
      conditions.push('agent_id = ?');
      params.push(filter.agentId);
    }
    if (filter?.userId) {
      conditions.push('user_id = ?');
      params.push(filter.userId);
    }
    if (filter?.createdAfter) {
      conditions.push('created_at > ?');
      params.push(filter.createdAfter);
    }
    if (filter?.createdBefore) {
      conditions.push('created_at < ?');
      params.push(filter.createdBefore);
    }

    let sql = 'SELECT * FROM sessions';
    if (conditions.length > 0) {
      sql += ' WHERE ' + conditions.join(' AND ');
    }
    sql += ' ORDER BY updated_at DESC';

    if (filter?.limit) {
      sql += ' LIMIT ?';
      params.push(filter.limit);
    }
    if (filter?.offset) {
      sql += ' OFFSET ?';
      params.push(filter.offset);
    }

    const rows = db.prepare(sql).all(...params) as SessionRow[];
    return rows.map((row) => this.rowToSession(row));
  }

  // Memory chunks

  async getMemoryChunk(id: string): Promise<MemoryChunkRecord | null> {
    const db = this.ensureDb();
    const row = db
      .prepare('SELECT * FROM memory_chunks WHERE id = ?')
      .get(id) as MemoryChunkRow | undefined;
    return row ? this.rowToMemoryChunk(row) : null;
  }

  async saveMemoryChunk(chunk: MemoryChunkRecord): Promise<void> {
    const db = this.ensureDb();
    const embeddingBlob = chunk.embedding ? Buffer.from(new Float32Array(chunk.embedding).buffer) : null;

    db.prepare(
      `INSERT OR REPLACE INTO memory_chunks
       (id, content, source, source_path, embedding, embedding_dims, metadata, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      chunk.id,
      chunk.content,
      chunk.source,
      chunk.sourcePath ?? null,
      embeddingBlob,
      chunk.embedding?.length ?? 0,
      JSON.stringify(chunk.metadata),
      chunk.createdAt,
      chunk.updatedAt
    );
  }

  async deleteMemoryChunk(id: string): Promise<void> {
    const db = this.ensureDb();
    db.prepare('DELETE FROM memory_chunks WHERE id = ?').run(id);
  }

  async searchMemoryChunks(query: MemorySearchQuery): Promise<MemoryChunkRecord[]> {
    const db = this.ensureDb();
    const limit = query.limit ?? 10;
    const results: MemoryChunkRecord[] = [];

    // FTS search if keywords provided
    if (query.keywords && query.keywords.length > 0) {
      const ftsQuery = query.keywords.join(' OR ');
      let sql = `
        SELECT mc.*, bm25(memory_chunks_fts) as rank
        FROM memory_chunks mc
        JOIN memory_chunks_fts fts ON mc.id = fts.id
        WHERE memory_chunks_fts MATCH ?
      `;
      const params: unknown[] = [ftsQuery];

      if (query.sources && query.sources.length > 0) {
        sql += ` AND mc.source IN (${query.sources.map(() => '?').join(',')})`;
        params.push(...query.sources);
      }

      sql += ' ORDER BY rank LIMIT ?';
      params.push(limit);

      const rows = db.prepare(sql).all(...params) as MemoryChunkRow[];
      results.push(...rows.map((row) => this.rowToMemoryChunk(row)));
    }

    // Vector search if embedding provided
    if (query.embedding && query.embedding.length > 0) {
      // For vector search, we fetch candidates and compute similarity in JS
      // This is a simple approach; for production, consider sqlite-vec extension
      let sql = 'SELECT * FROM memory_chunks WHERE embedding IS NOT NULL';
      const params: unknown[] = [];

      if (query.sources && query.sources.length > 0) {
        sql += ` AND source IN (${query.sources.map(() => '?').join(',')})`;
        params.push(...query.sources);
      }

      const rows = db.prepare(sql).all(...params) as MemoryChunkRow[];
      const threshold = query.threshold ?? 0.7;

      const scored = rows
        .map((row) => {
          const chunk = this.rowToMemoryChunk(row);
          if (!chunk.embedding) return null;
          const similarity = this.cosineSimilarity(query.embedding!, chunk.embedding);
          if (similarity < threshold) return null;
          return { chunk, similarity };
        })
        .filter((x): x is { chunk: MemoryChunkRecord; similarity: number } => x !== null)
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, limit);

      // Merge with FTS results if hybrid
      if (query.useHybrid && results.length > 0) {
        const existingIds = new Set(results.map((r) => r.id));
        for (const { chunk } of scored) {
          if (!existingIds.has(chunk.id)) {
            results.push(chunk);
          }
        }
        return results.slice(0, limit);
      }

      return scored.map((s) => s.chunk);
    }

    return results;
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) return 0;
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dotProduct / denom;
  }

  // Cron jobs

  async getCronJob(id: string): Promise<CronJobRecord | null> {
    const db = this.ensureDb();
    const row = db.prepare('SELECT * FROM cron_jobs WHERE id = ?').get(id) as CronJobRow | undefined;
    return row ? this.rowToCronJob(row) : null;
  }

  async saveCronJob(job: CronJobRecord): Promise<void> {
    const db = this.ensureDb();
    db.prepare(
      `INSERT OR REPLACE INTO cron_jobs
       (id, name, schedule, agent_id, message, enabled, last_run, next_run, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      job.id,
      job.name,
      job.schedule,
      job.agentId,
      job.message,
      job.enabled ? 1 : 0,
      job.lastRun ?? null,
      job.nextRun ?? null,
      job.createdAt,
      job.updatedAt
    );
  }

  async deleteCronJob(id: string): Promise<void> {
    const db = this.ensureDb();
    db.prepare('DELETE FROM cron_jobs WHERE id = ?').run(id);
  }

  async listCronJobs(): Promise<CronJobRecord[]> {
    const db = this.ensureDb();
    const rows = db.prepare('SELECT * FROM cron_jobs ORDER BY created_at DESC').all() as CronJobRow[];
    return rows.map((row) => this.rowToCronJob(row));
  }

  async saveCronLog(log: CronLogRecord): Promise<void> {
    const db = this.ensureDb();
    db.prepare(
      `INSERT OR REPLACE INTO cron_logs
       (id, job_id, started_at, completed_at, status, result, error)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      log.id,
      log.jobId,
      log.startedAt,
      log.completedAt ?? null,
      log.status,
      log.result ?? null,
      log.error ?? null
    );
  }

  async getCronLogs(jobId: string, limit = 100): Promise<CronLogRecord[]> {
    const db = this.ensureDb();
    const rows = db
      .prepare('SELECT * FROM cron_logs WHERE job_id = ? ORDER BY started_at DESC LIMIT ?')
      .all(jobId, limit) as CronLogRow[];
    return rows.map((row) => this.rowToCronLog(row));
  }

  // Devices

  async getDevice(id: string): Promise<Device | null> {
    const db = this.ensureDb();
    const row = db.prepare('SELECT * FROM devices WHERE id = ?').get(id) as DeviceRow | undefined;
    return row ? this.rowToDevice(row) : null;
  }

  async saveDevice(device: Device): Promise<void> {
    const db = this.ensureDb();
    db.prepare(
      `INSERT OR REPLACE INTO devices
       (id, name, type, public_key, last_seen, trusted, metadata, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      device.id,
      device.name,
      device.type,
      device.publicKey ?? null,
      device.lastSeen,
      device.trusted ? 1 : 0,
      JSON.stringify(device.metadata),
      device.createdAt,
      device.updatedAt
    );
  }

  async deleteDevice(id: string): Promise<void> {
    const db = this.ensureDb();
    db.prepare('DELETE FROM devices WHERE id = ?').run(id);
  }

  async listDevices(): Promise<Device[]> {
    const db = this.ensureDb();
    const rows = db.prepare('SELECT * FROM devices ORDER BY last_seen DESC').all() as DeviceRow[];
    return rows.map((row) => this.rowToDevice(row));
  }

  // Config

  async getConfig(key: string): Promise<string | null> {
    const db = this.ensureDb();
    const row = db.prepare('SELECT value FROM config WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  async setConfig(key: string, value: string): Promise<void> {
    const db = this.ensureDb();
    db.prepare(
      'INSERT OR REPLACE INTO config (key, value, updated_at) VALUES (?, ?, ?)'
    ).run(key, value, new Date().toISOString());
  }

  async deleteConfig(key: string): Promise<void> {
    const db = this.ensureDb();
    db.prepare('DELETE FROM config WHERE key = ?').run(key);
  }

  async getAllConfig(): Promise<Record<string, string>> {
    const db = this.ensureDb();
    const rows = db.prepare('SELECT key, value FROM config').all() as { key: string; value: string }[];
    return Object.fromEntries(rows.map((row) => [row.key, row.value]));
  }

  // Transactions

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    const db = this.ensureDb();
    const txn = db.transaction(() => fn());
    return txn() as T;
  }

  // Row mappers

  private rowToSession(row: SessionRow): Session {
    return {
      id: row.id,
      channelId: row.channel_id,
      conversationId: row.conversation_id,
      agentId: row.agent_id,
      userId: row.user_id ?? undefined,
      metadata: JSON.parse(row.metadata || '{}'),
      messages: JSON.parse(row.messages || '[]'),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      expiresAt: row.expires_at ?? undefined,
    };
  }

  private rowToMemoryChunk(row: MemoryChunkRow): MemoryChunkRecord {
    let embedding: number[] | undefined;
    if (row.embedding) {
      const buffer = row.embedding as Buffer;
      embedding = Array.from(new Float32Array(buffer.buffer, buffer.byteOffset, buffer.length / 4));
    }

    return {
      id: row.id,
      content: row.content,
      source: row.source as MemoryChunkRecord['source'],
      sourcePath: row.source_path ?? undefined,
      embedding,
      metadata: JSON.parse(row.metadata || '{}'),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private rowToCronJob(row: CronJobRow): CronJobRecord {
    return {
      id: row.id,
      name: row.name,
      schedule: row.schedule,
      agentId: row.agent_id,
      message: row.message,
      enabled: row.enabled === 1,
      lastRun: row.last_run ?? undefined,
      nextRun: row.next_run ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private rowToCronLog(row: CronLogRow): CronLogRecord {
    return {
      id: row.id,
      jobId: row.job_id,
      startedAt: row.started_at,
      completedAt: row.completed_at ?? undefined,
      status: row.status as CronLogRecord['status'],
      result: row.result ?? undefined,
      error: row.error ?? undefined,
    };
  }

  private rowToDevice(row: DeviceRow): Device {
    return {
      id: row.id,
      name: row.name,
      type: row.type as Device['type'],
      publicKey: row.public_key ?? undefined,
      lastSeen: row.last_seen,
      trusted: row.trusted === 1,
      metadata: JSON.parse(row.metadata || '{}'),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

// Row types

interface SessionRow {
  id: string;
  channel_id: string;
  conversation_id: string;
  agent_id: string;
  user_id: string | null;
  metadata: string;
  messages: string;
  created_at: string;
  updated_at: string;
  expires_at: string | null;
  total_tokens?: number;
  prompt_tokens?: number;
  completion_tokens?: number;
}

interface SessionWithTokens extends Session {
  totalTokens?: number;
  promptTokens?: number;
  completionTokens?: number;
}

interface MemoryChunkRow {
  id: string;
  content: string;
  source: string;
  source_path: string | null;
  embedding: Buffer | null;
  embedding_dims: number;
  metadata: string;
  created_at: string;
  updated_at: string;
}

interface CronJobRow {
  id: string;
  name: string;
  schedule: string;
  agent_id: string;
  message: string;
  enabled: number;
  last_run: string | null;
  next_run: string | null;
  created_at: string;
  updated_at: string;
}

interface CronLogRow {
  id: string;
  job_id: string;
  started_at: string;
  completed_at: string | null;
  status: string;
  result: string | null;
  error: string | null;
}

interface DeviceRow {
  id: string;
  name: string;
  type: string;
  public_key: string | null;
  last_seen: string;
  trusted: number;
  metadata: string;
  created_at: string;
  updated_at: string;
}

export function createSQLiteAdapter(config: StorageConfig): SQLiteAdapter {
  return new SQLiteAdapter(config);
}
