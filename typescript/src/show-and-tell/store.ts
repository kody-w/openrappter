import { openrappterPath } from '../infra/openrappter-home.js';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  rmSync,
} from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';

import {
  assertPrivateDirectory,
  hardenPrivatePath,
} from '../flight-recorder/permissions.js';
import { sessionElapsedMs } from './clock.js';
import { sanitizeShowAndTellValue } from './privacy.js';
import {
  SHOW_AND_TELL_ANALYSIS_SCHEMA,
  SHOW_AND_TELL_PLAN_SCHEMA,
  SHOW_AND_TELL_SCHEMA,
  type CreateSessionInput,
  type ShowAndTellAnalysis,
  type ShowAndTellArtifact,
  type ShowAndTellArtifactKind,
  type ShowAndTellConsentPurpose,
  type ShowAndTellEvent,
  type ShowAndTellSession,
  type ShowAndTellSkillPlan,
  type ShowAndTellState,
} from './types.js';

interface Database {
  exec(sql: string): void;
  prepare(sql: string): Statement;
  close(): void;
  pragma(pragma: string): unknown;
  transaction<T>(fn: () => T): () => T;
}

interface Statement {
  run(...params: unknown[]): { changes: number };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

export type ShowAndTellDatabaseFactory = (
  filename: string,
  options?: { readonly?: boolean; timeout?: number },
) => Database;

interface SessionRow {
  id: string;
  state: ShowAndTellState;
  title: string;
  intent_hint: string;
  created_at: number;
  started_at: number;
  stopped_at: number | null;
  updated_at: number;
  collector_runtime: 'typescript' | 'python' | null;
  collector_pid: number | null;
  collector_nonce: string | null;
  collector_started_at: number | null;
  collector_heartbeat_at: number | null;
  stop_requested_at: number | null;
  max_duration_ms: number;
  poll_interval_ms: number;
  last_error: string | null;
}

interface EventRow {
  id: string;
  session_id: string;
  sequence: number;
  timestamp: number;
  elapsed_ms: number | null;
  type: string;
  source: string;
  data_json: string;
}

interface AnalysisRow {
  analysis_json: string;
}

interface PlanRow {
  plan_json: string;
}

interface ArtifactRow {
  id: string;
  session_id: string;
  kind: ShowAndTellArtifactKind;
  name: string;
  path: string;
  content_hash: string;
  created_at: number;
}

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const DEFAULT_MAX_DURATION_MS = 8 * 60 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const CONSENT_AUTHORITY = Symbol('show-and-tell-interactive-consent');

export function showAndTellRoot(): string {
  return path.resolve(
    process.env.OPENRAPPTER_SHOW_AND_TELL_DIR ??
      openrappterPath('show-and-tell'),
  );
}

function privateDirectory(directory: string): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`Show-and-Tell path is not a private directory: ${directory}`);
  }
  hardenPrivatePath(directory, true);
  assertPrivateDirectory(directory);
}

function makeSessionId(now = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${stamp}-${randomUUID().slice(0, 8)}`;
}

function parseJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * Adds `show_events.elapsed_ms` to a database created before monotonic
 * timing existed.
 *
 * The column is nullable on purpose: an older row has no honest monotonic
 * value, and inventing one from its wall-clock timestamp would launder a
 * guess into evidence. Readers report those rows as estimated instead.
 *
 * Both runtimes open the same file, so two processes can reach the migration
 * at the same moment. Only SQLite's duplicate-column error is tolerated —
 * that one means the other process won the race and the column now exists.
 */
function migrateEventElapsedColumn(db: Database): void {
  const columns = db.prepare('PRAGMA table_info(show_events)').all() as Array<{
    name?: unknown;
  }>;
  if (columns.some((column) => column.name === 'elapsed_ms')) return;
  try {
    db.exec('ALTER TABLE show_events ADD COLUMN elapsed_ms INTEGER');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/duplicate column name/i.test(message)) throw error;
  }
}

export class ShowAndTellStore {
  readonly root: string;
  readonly databasePath: string;
  private db: Database | null = null;

  constructor(
    root = showAndTellRoot(),
    private readonly databaseFactory?: ShowAndTellDatabaseFactory,
  ) {
    this.root = path.resolve(root);
    this.databasePath = path.join(this.root, 'show-and-tell.db');
  }

  async initialize(): Promise<void> {
    if (this.db) return;
    privateDirectory(this.root);
    if (existsSync(this.databasePath)) {
      const linked = lstatSync(this.databasePath);
      if (linked.isSymbolicLink() || !linked.isFile()) {
        throw new Error('Show-and-Tell database must be a regular file.');
      }
    }
    const BetterSqlite = this.databaseFactory ?? (
      (await import('better-sqlite3')).default as unknown as ShowAndTellDatabaseFactory
    );
    const db = BetterSqlite(this.databasePath, { timeout: 5_000 });
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    db.exec(`
      CREATE TABLE IF NOT EXISTS show_sessions (
        id TEXT PRIMARY KEY,
        schema_version INTEGER NOT NULL DEFAULT 1,
        state TEXT NOT NULL,
        title TEXT NOT NULL,
        intent_hint TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        started_at INTEGER NOT NULL,
        stopped_at INTEGER,
        updated_at INTEGER NOT NULL,
        collector_runtime TEXT,
        collector_pid INTEGER,
        collector_nonce TEXT,
        collector_started_at INTEGER,
        collector_heartbeat_at INTEGER,
        stop_requested_at INTEGER,
        max_duration_ms INTEGER NOT NULL,
        poll_interval_ms INTEGER NOT NULL,
        last_error TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_show_sessions_state
        ON show_sessions(state, updated_at DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_show_one_active_session
        ON show_sessions((1))
        WHERE state IN ('recording', 'stopping');
      CREATE TABLE IF NOT EXISTS show_events (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES show_sessions(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL,
        timestamp INTEGER NOT NULL,
        elapsed_ms INTEGER,
        type TEXT NOT NULL,
        source TEXT NOT NULL,
        data_json TEXT NOT NULL,
        UNIQUE(session_id, sequence)
      );
      CREATE INDEX IF NOT EXISTS idx_show_events_session
        ON show_events(session_id, sequence);
      CREATE TABLE IF NOT EXISTS show_analyses (
        session_id TEXT PRIMARY KEY REFERENCES show_sessions(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL,
        approved INTEGER NOT NULL DEFAULT 0,
        analysis_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS show_plans (
        session_id TEXT PRIMARY KEY REFERENCES show_sessions(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL,
        approved INTEGER NOT NULL DEFAULT 0,
        plan_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS show_artifacts (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES show_sessions(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        path TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS show_consents (
        token_hash TEXT PRIMARY KEY,
        purpose TEXT NOT NULL,
        issued_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
    `);
    migrateEventElapsedColumn(db);
    this.db = db;
    hardenPrivatePath(this.databasePath);
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }

  sessionDir(id: string): string {
    if (!SESSION_ID.test(id) || id.includes('..')) {
      throw new Error(`Invalid Show-and-Tell session id: ${id}`);
    }
    const candidate = path.join(this.root, 'sessions', id);
    const relative = path.relative(path.join(this.root, 'sessions'), candidate);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`Unsafe Show-and-Tell session id: ${id}`);
    }
    return candidate;
  }

  framesDir(id: string): string {
    return path.join(this.sessionDir(id), 'frames');
  }

  private database(): Database {
    if (!this.db) throw new Error('Show-and-Tell store is not initialized.');
    return this.db;
  }

  private immediate<T>(operation: () => T): T {
    const db = this.database();
    let lastError: unknown;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        db.exec('BEGIN IMMEDIATE');
        const result = operation();
        db.exec('COMMIT');
        return result;
      } catch (error) {
        lastError = error;
        try {
          db.exec('ROLLBACK');
        } catch {
          // No transaction was opened.
        }
        const message = error instanceof Error ? error.message : String(error);
        if (!/SQLITE_BUSY|database is locked|busy snapshot/i.test(message)) {
          throw error;
        }
      }
    }
    throw lastError;
  }

  async createConsent(
    authority: symbol,
    purpose: ShowAndTellConsentPurpose,
    ttlMs = 5 * 60 * 1000,
  ): Promise<string> {
    if (authority !== CONSENT_AUTHORITY) {
      throw new Error('Show-and-Tell consent can be issued only by the interactive broker.');
    }
    await this.initialize();
    const token = randomBytes(32).toString('hex');
    const now = Date.now();
    this.database()
      .prepare(
        'INSERT INTO show_consents(token_hash, purpose, issued_at, expires_at) VALUES (?, ?, ?, ?)',
      )
      .run(createHash('sha256').update(token).digest('hex'), purpose, now, now + ttlMs);
    return token;
  }

  async consumeConsent(
    token: unknown,
    purpose: ShowAndTellConsentPurpose,
  ): Promise<boolean> {
    await this.initialize();
    if (typeof token !== 'string' || !/^[0-9a-f]{64}$/i.test(token)) return false;
    const hash = createHash('sha256').update(token).digest('hex');
    const db = this.database();
    return this.immediate(() => {
      const row = db
        .prepare('SELECT purpose, expires_at FROM show_consents WHERE token_hash = ?')
        .get(hash) as { purpose: string; expires_at: number } | undefined;
      db.prepare('DELETE FROM show_consents WHERE token_hash = ?').run(hash);
      return Boolean(
        row && row.purpose === purpose && row.expires_at >= Date.now(),
      );
    });
  }

  async createSession(input: CreateSessionInput = {}): Promise<ShowAndTellSession> {
    await this.initialize();
    const now = Date.now();
    const id = makeSessionId();
    const requestedDuration =
      typeof input.maxDurationMs === 'number' && Number.isFinite(input.maxDurationMs)
        ? input.maxDurationMs
        : DEFAULT_MAX_DURATION_MS;
    const requestedPoll =
      typeof input.pollIntervalMs === 'number' && Number.isFinite(input.pollIntervalMs)
        ? input.pollIntervalMs
        : DEFAULT_POLL_INTERVAL_MS;
    const session: ShowAndTellSession = {
      schema: SHOW_AND_TELL_SCHEMA,
      id,
      state: 'recording',
      title: String(input.title ?? '').trim().slice(0, 160),
      intentHint: String(input.intentHint ?? '').trim().slice(0, 1000),
      captureMode: 'context',
      createdAt: now,
      startedAt: now,
      stoppedAt: null,
      updatedAt: now,
      collectorRuntime: null,
      collectorPid: null,
      collectorNonce: null,
      collectorStartedAt: null,
      collectorHeartbeatAt: null,
      stopRequestedAt: null,
      maxDurationMs: Math.max(
        60_000,
        Math.min(requestedDuration, DEFAULT_MAX_DURATION_MS),
      ),
      pollIntervalMs: Math.max(
        500,
        Math.min(requestedPoll, 60_000),
      ),
      lastError: null,
    };
    this.immediate(() => {
      this.recoverStaleRows(now, 30_000);
      const active = this.database()
        .prepare(`
          SELECT id, state FROM show_sessions
          WHERE state IN ('recording', 'stopping')
          ORDER BY started_at DESC LIMIT 1
        `)
        .get() as { id: string; state: string } | undefined;
      if (active) {
        throw new Error(
          `Show-and-Tell session ${active.id} is already ${active.state}.`,
        );
      }
      this.database()
        .prepare(`
          INSERT INTO show_sessions(
            id, state, title, intent_hint, created_at, started_at, stopped_at,
            updated_at, max_duration_ms, poll_interval_ms
          ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)
        `)
        .run(
          id,
          session.state,
          session.title,
          session.intentHint,
          now,
          now,
          now,
          session.maxDurationMs,
          session.pollIntervalMs,
        );
    });
    try {
      privateDirectory(this.sessionDir(id));
      privateDirectory(this.framesDir(id));
    } catch (error) {
      this.database().prepare('DELETE FROM show_sessions WHERE id = ?').run(id);
      throw error;
    }
    return session;
  }

  async recoverStaleSessions(staleAfterMs = 30_000): Promise<number> {
    await this.initialize();
    return this.recoverStaleRows(Date.now(), staleAfterMs);
  }

  private recoverStaleRows(now: number, staleAfterMs: number): number {
    const result = this.database()
      .prepare(`
        UPDATE show_sessions
        SET state = 'failed', stopped_at = ?, updated_at = ?,
            last_error = 'Collector heartbeat expired before the session was stopped.',
            collector_pid = NULL, collector_nonce = NULL
        WHERE state IN ('recording', 'stopping')
          AND (
            (collector_started_at IS NULL AND started_at < (
              ? - CASE
                WHEN poll_interval_ms * 5 > ? THEN poll_interval_ms * 5
                ELSE ?
              END
            ))
            OR (collector_started_at IS NOT NULL
                AND COALESCE(collector_heartbeat_at, collector_started_at) < (
                  ? - CASE
                    WHEN poll_interval_ms * 5 > ? THEN poll_interval_ms * 5
                    ELSE ?
                  END
                ))
          )
      `)
      .run(
        now,
        now,
        now,
        staleAfterMs,
        staleAfterMs,
        now,
        staleAfterMs,
        staleAfterMs,
      );
    return result.changes;
  }

  async getSession(id: string): Promise<ShowAndTellSession | null> {
    await this.initialize();
    if (!SESSION_ID.test(id)) return null;
    const row = this.database()
      .prepare('SELECT * FROM show_sessions WHERE id = ?')
      .get(id) as SessionRow | undefined;
    return row ? this.toSession(row) : null;
  }

  async activeSession(): Promise<ShowAndTellSession | null> {
    await this.initialize();
    const row = this.database()
      .prepare(`
        SELECT * FROM show_sessions
        WHERE state IN ('recording', 'stopping')
        ORDER BY started_at DESC LIMIT 1
      `)
      .get() as SessionRow | undefined;
    return row ? this.toSession(row) : null;
  }

  async latestSession(): Promise<ShowAndTellSession | null> {
    await this.initialize();
    const row = this.database()
      .prepare('SELECT * FROM show_sessions ORDER BY created_at DESC LIMIT 1')
      .get() as SessionRow | undefined;
    return row ? this.toSession(row) : null;
  }

  async listSessions(limit = 50): Promise<ShowAndTellSession[]> {
    await this.initialize();
    return (
      this.database()
        .prepare('SELECT * FROM show_sessions ORDER BY created_at DESC LIMIT ?')
        .all(Math.max(1, Math.min(limit, 500))) as SessionRow[]
    ).map((row) => this.toSession(row));
  }

  async appendEvent(
    sessionId: string,
    type: string,
    source: string,
    data: Record<string, unknown> = {},
  ): Promise<ShowAndTellEvent> {
    await this.initialize();
    const db = this.database();
    return this.immediate(() => {
      const session = db
        .prepare('SELECT id, started_at FROM show_sessions WHERE id = ?')
        .get(sessionId) as { id: string; started_at: number } | undefined;
      if (!session) throw new Error(`Show-and-Tell session not found: ${sessionId}`);
      const sequenceRow = db
        .prepare(
          'SELECT COALESCE(MAX(sequence), -1) + 1 AS sequence FROM show_events WHERE session_id = ?',
        )
        .get(sessionId) as { sequence: number };
      const timestamp = Date.now();
      const event: ShowAndTellEvent = {
        id: randomUUID(),
        sessionId,
        sequence: sequenceRow.sequence,
        timestamp,
        elapsedMs: sessionElapsedMs(sessionId, session.started_at, timestamp),
        type: String(type).slice(0, 120),
        source: String(source).slice(0, 120),
        data: sanitizeShowAndTellValue(data),
      };
      db.prepare(`
        INSERT INTO show_events(
          id, session_id, sequence, timestamp, elapsed_ms, type, source, data_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        event.id,
        event.sessionId,
        event.sequence,
        event.timestamp,
        event.elapsedMs,
        event.type,
        event.source,
        JSON.stringify(event.data),
      );
      db.prepare('UPDATE show_sessions SET updated_at = ? WHERE id = ?')
        .run(event.timestamp, sessionId);
      return event;
    });
  }

  async events(sessionId: string): Promise<ShowAndTellEvent[]> {
    await this.initialize();
    return (
      this.database()
        .prepare('SELECT * FROM show_events WHERE session_id = ? ORDER BY sequence')
        .all(sessionId) as EventRow[]
    ).map((row) => ({
      id: row.id,
      sessionId: row.session_id,
      sequence: row.sequence,
      timestamp: row.timestamp,
      elapsedMs: typeof row.elapsed_ms === 'number' ? row.elapsed_ms : null,
      type: row.type,
      source: row.source,
      data: parseJsonObject(row.data_json),
    }));
  }

  async attachCollector(
    sessionId: string,
    runtime: 'typescript' | 'python',
    pid: number,
    nonce: string,
  ): Promise<boolean> {
    await this.initialize();
    const now = Date.now();
    const result = this.database()
      .prepare(`
        UPDATE show_sessions
        SET collector_runtime = ?, collector_pid = ?, collector_nonce = ?,
            collector_started_at = ?, collector_heartbeat_at = ?, updated_at = ?
        WHERE id = ? AND state = 'recording'
          AND collector_runtime IS NULL
          AND collector_pid IS NULL
          AND collector_nonce IS NULL
      `)
      .run(runtime, pid, nonce, now, now, now, sessionId);
    return result.changes === 1;
  }

  async heartbeat(sessionId: string, nonce: string): Promise<boolean> {
    await this.initialize();
    const now = Date.now();
    const result = this.database()
      .prepare(`
        UPDATE show_sessions
        SET collector_heartbeat_at = ?, updated_at = ?
        WHERE id = ? AND collector_nonce = ? AND state IN ('recording', 'stopping')
      `)
      .run(now, now, sessionId, nonce);
    return result.changes === 1;
  }

  async requestStop(sessionId: string): Promise<ShowAndTellSession> {
    await this.initialize();
    const now = Date.now();
    const result = this.database()
      .prepare(`
        UPDATE show_sessions
        SET state = 'stopping', stop_requested_at = ?, updated_at = ?
        WHERE id = ? AND state = 'recording'
      `)
      .run(now, now, sessionId);
    const session = await this.getSession(sessionId);
    if (!session) throw new Error(`Show-and-Tell session not found: ${sessionId}`);
    if (result.changes === 0 && session.state !== 'stopping') {
      throw new Error(`Show-and-Tell session ${sessionId} is ${session.state}.`);
    }
    return session;
  }

  async finishSession(
    sessionId: string,
    state: 'stopped' | 'failed',
    options: { nonce?: string; error?: string } = {},
  ): Promise<boolean> {
    await this.initialize();
    const now = Date.now();
    const params: unknown[] = [
      state,
      now,
      now,
      options.error ? String(options.error).slice(0, 500) : null,
      sessionId,
    ];
    let sql = `
      UPDATE show_sessions
      SET state = ?, stopped_at = ?, updated_at = ?, last_error = ?,
          collector_pid = NULL, collector_nonce = NULL
      WHERE id = ? AND state IN ('recording', 'stopping')
    `;
    if (options.nonce) {
      sql += ' AND collector_nonce = ?';
      params.push(options.nonce);
    }
    const result = this.database().prepare(sql).run(...params);
    return result.changes === 1;
  }

  async saveAnalysis(analysis: ShowAndTellAnalysis): Promise<void> {
    await this.initialize();
    if (
      analysis.schema !== SHOW_AND_TELL_ANALYSIS_SCHEMA ||
      analysis.sessionId.length === 0
    ) {
      throw new Error('Invalid Show-and-Tell analysis.');
    }
    this.database()
      .prepare(`
        INSERT INTO show_analyses(
          session_id, revision, approved, analysis_json, updated_at
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET
          revision = excluded.revision,
          approved = excluded.approved,
          analysis_json = excluded.analysis_json,
          updated_at = excluded.updated_at
      `)
      .run(
        analysis.sessionId,
        analysis.revision,
        analysis.approved ? 1 : 0,
        JSON.stringify(sanitizeShowAndTellValue(analysis)),
        analysis.updatedAt,
      );
  }

  async getAnalysis(sessionId: string): Promise<ShowAndTellAnalysis | null> {
    await this.initialize();
    const row = this.database()
      .prepare('SELECT analysis_json FROM show_analyses WHERE session_id = ?')
      .get(sessionId) as AnalysisRow | undefined;
    if (!row) return null;
    try {
      const analysis = JSON.parse(row.analysis_json) as ShowAndTellAnalysis;
      return analysis.schema === SHOW_AND_TELL_ANALYSIS_SCHEMA ? analysis : null;
    } catch {
      return null;
    }
  }

  async savePlan(plan: ShowAndTellSkillPlan): Promise<void> {
    await this.initialize();
    if (
      plan.schema !== SHOW_AND_TELL_PLAN_SCHEMA ||
      plan.sessionId.length === 0
    ) {
      throw new Error('Invalid Show-and-Tell skill plan.');
    }
    this.database()
      .prepare(`
        INSERT INTO show_plans(
          session_id, revision, approved, plan_json, updated_at
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET
          revision = excluded.revision,
          approved = excluded.approved,
          plan_json = excluded.plan_json,
          updated_at = excluded.updated_at
      `)
      .run(
        plan.sessionId,
        plan.revision,
        plan.approved ? 1 : 0,
        JSON.stringify(sanitizeShowAndTellValue(plan)),
        plan.updatedAt,
      );
  }

  async getPlan(sessionId: string): Promise<ShowAndTellSkillPlan | null> {
    await this.initialize();
    const row = this.database()
      .prepare('SELECT plan_json FROM show_plans WHERE session_id = ?')
      .get(sessionId) as PlanRow | undefined;
    if (!row) return null;
    try {
      const plan = JSON.parse(row.plan_json) as ShowAndTellSkillPlan;
      return plan.schema === SHOW_AND_TELL_PLAN_SCHEMA ? plan : null;
    } catch {
      return null;
    }
  }

  async recordArtifact(
    artifact: Omit<ShowAndTellArtifact, 'id' | 'createdAt'>,
  ): Promise<ShowAndTellArtifact> {
    await this.initialize();
    const saved: ShowAndTellArtifact = {
      ...artifact,
      id: randomUUID(),
      createdAt: Date.now(),
    };
    this.database()
      .prepare(`
        DELETE FROM show_artifacts
        WHERE session_id = ? AND kind = ? AND path = ?
      `)
      .run(saved.sessionId, saved.kind, saved.path);
    this.database()
      .prepare(`
        INSERT INTO show_artifacts(
          id, session_id, kind, name, path, content_hash, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        saved.id,
        saved.sessionId,
        saved.kind,
        saved.name,
        saved.path,
        saved.contentHash,
        saved.createdAt,
      );
    return saved;
  }

  async artifacts(sessionId: string): Promise<ShowAndTellArtifact[]> {
    await this.initialize();
    return (
      this.database()
        .prepare('SELECT * FROM show_artifacts WHERE session_id = ? ORDER BY created_at')
        .all(sessionId) as ArtifactRow[]
    ).map((row) => ({
      id: row.id,
      sessionId: row.session_id,
      kind: row.kind,
      name: row.name,
      path: row.path,
      contentHash: row.content_hash,
      createdAt: row.created_at,
    }));
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    await this.initialize();
    const session = await this.getSession(sessionId);
    if (!session) return false;
    if (session.state === 'recording' || session.state === 'stopping') {
      throw new Error('Stop the Show-and-Tell session before deleting it.');
    }
    const directory = this.sessionDir(sessionId);
    if (existsSync(directory)) {
      const stat = lstatSync(directory);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error('Refusing to delete a non-directory Show-and-Tell path.');
      }
    }
    if (existsSync(directory)) {
      rmSync(directory, { recursive: true, force: true });
    }
    const result = this.database()
      .prepare('DELETE FROM show_sessions WHERE id = ?')
      .run(sessionId);
    return result.changes === 1;
  }

  hardenFile(file: string): void {
    chmodSync(file, 0o600);
  }

  private toSession(row: SessionRow): ShowAndTellSession {
    return {
      schema: SHOW_AND_TELL_SCHEMA,
      id: row.id,
      state: row.state,
      title: row.title,
      intentHint: row.intent_hint,
      captureMode: 'context',
      createdAt: row.created_at,
      startedAt: row.started_at,
      stoppedAt: row.stopped_at,
      updatedAt: row.updated_at,
      collectorRuntime: row.collector_runtime,
      collectorPid: row.collector_pid,
      collectorNonce: row.collector_nonce,
      collectorStartedAt: row.collector_started_at,
      collectorHeartbeatAt: row.collector_heartbeat_at,
      stopRequestedAt: row.stop_requested_at,
      maxDurationMs: row.max_duration_ms,
      pollIntervalMs: row.poll_interval_ms,
      lastError: row.last_error,
    };
  }
}

export async function requestInteractiveShowAndTellConsent(
  store: ShowAndTellStore,
  purpose: ShowAndTellConsentPurpose,
  message: string,
): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('Show-and-Tell consent requires an interactive local terminal.');
  }
  const prompt = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const answer = await prompt.question(`${message}\nType YES to continue: `);
    if (answer.trim() !== 'YES') {
      throw new Error('Show-and-Tell action cancelled.');
    }
  } finally {
    prompt.close();
  }
  return store.createConsent(CONSENT_AUTHORITY, purpose);
}
