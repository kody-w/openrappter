import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import type {
  FlightAppendReceipt,
  FlightEvent,
  FlightEventQuery,
  FlightEventStatus,
  FlightExport,
  FlightLedger,
} from "./types.js";
import { FLIGHT_EVENT_SCHEMA } from "./types.js";
import {
  computeFlightEventHash,
  normalizeFlightModelId,
  normalizeFlightWorkspaceId,
  verifyFlightEventHash,
} from "./integrity.js";
import { isDeepStrictEqual } from "node:util";
import {
  sanitizeFlightMetadata,
  sanitizeFlightPayload,
  sanitizeFlightValue,
} from "./redaction.js";
import {
  assertPrivateDirectory,
  hardenPrivatePath,
} from "./permissions.js";
import { processMatchesIncarnation } from "./process-owner.js";
import path from "node:path";

const EXPORT_SCHEMA = "openrappter-flight-export/1.0" as const;
const BUSY_TIMEOUT_MS = 5_000;
const RUNTIME_BUSY_TIMEOUT_MS = 25;
const MAX_BUSY_RETRIES = 4;
const MAX_QUERY_LIMIT = 10_000;
const MAX_QUERY_OFFSET = 1_000_000;
const MAX_KIND_FILTERS = 100;

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
}

interface RunResult {
  changes: number;
}

type BetterSqlite3 = (
  filename: string,
  options?: { readonly?: boolean; timeout?: number },
) => Database;

interface FlightEventRow {
  id: string;
  sequence: number;
  trace_id: string;
  timestamp: string;
  timestamp_ms: number;
  kind: string;
  source: string;
  status: string;
  session_id: string | null;
  workspace_id: string | null;
  provider_id: string | null;
  agent_name: string | null;
  tool_name: string | null;
  event_json: string;
}

interface PruneEventRow extends FlightEventRow {
  row_id: number;
}

interface MigrationEventRow extends FlightEventRow {
  row_id: number;
}

interface RetentionTrace {
  traceId: string;
  rowCount: number;
  lifecycle: "active" | "completed" | "atomic" | "malformed";
  lifecycleDepth: number;
  sawLifecycleStart: boolean;
  malformedLifecycle: boolean;
  lifecycleStarts: Map<
    string,
    { pid: number | null; incarnation?: string }
  >;
  latestTimestamp: number;
  latestRowId: number;
}

interface SerializedEvent {
  event: FlightEvent;
  json: string;
}

const EVENT_KEYS = new Set([
  "schema",
  "id",
  "sequence",
  "kind",
  "source",
  "status",
  "traceId",
  "parentId",
  "sessionId",
  "workspaceId",
  "providerId",
  "model",
  "agentName",
  "toolName",
  "timestamp",
  "durationMs",
  "metadata",
  "payload",
  "contentHash",
]);

const QUERY_KEYS = new Set([
  "traceId",
  "sessionId",
  "workspaceId",
  "kind",
  "source",
  "providerId",
  "agentName",
  "toolName",
  "status",
  "since",
  "until",
  "order",
  "limit",
  "offset",
]);

const EVENT_STATUSES = new Set<FlightEventStatus>([
  "started",
  "success",
  "error",
  "decision",
  "info",
]);

export class SQLiteFlightLedger implements FlightLedger {
  private db: Database | null = null;
  private readonly databasePath: string;
  private readonly inMemory: boolean;
  private state: "created" | "initialized" | "closed" = "created";
  private initializing: Promise<void> | null = null;

  constructor(options: { databasePath?: string; inMemory?: boolean } = {}) {
    this.databasePath = options.databasePath ?? "openrappter-flight.db";
    this.inMemory = options.inMemory ?? false;
  }

  async initialize(): Promise<void> {
    if (this.state === "closed") {
      throw new Error("Flight ledger is closed and cannot be initialized.");
    }
    if (this.state === "initialized") return;
    if (this.initializing) return this.initializing;
    const operation = this.initializeOnce();
    this.initializing = operation;
    try {
      await operation;
    } finally {
      if (this.initializing === operation) {
        this.initializing = null;
      }
    }
  }

  private async initializeOnce(): Promise<void> {
    if (this.state === "closed") {
      throw new Error("Flight ledger is closed and cannot be initialized.");
    }
    if (this.state === "initialized") {
      return;
    }

    let BetterSqlite: BetterSqlite3;
    try {
      const module = await import("better-sqlite3");
      BetterSqlite = module.default as unknown as BetterSqlite3;
    } catch {
      throw new Error(
        "better-sqlite3 is required for the flight ledger. Install it with: npm install better-sqlite3",
      );
    }

    const preparedFiles = this.inMemory
      ? undefined
      : (
          assertPrivateDirectory(path.dirname(this.databasePath)),
          preparePrivateDatabaseFiles(this.databasePath)
        );

    const db = BetterSqlite(this.inMemory ? ":memory:" : this.databasePath, {
      timeout: BUSY_TIMEOUT_MS,
    });

    try {
      await retrySqliteBusy(() => {
        if (preparedFiles) verifyPrivateDatabaseFiles(preparedFiles);
        db.pragma("foreign_keys = ON");
        db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
        db.pragma("secure_delete = ON");
        if (!this.inMemory) {
          db.pragma("journal_mode = WAL");
          db.pragma("synchronous = FULL");
          verifyPrivateDatabaseFiles(preparedFiles!);
        }
        db.exec(`
          CREATE TABLE IF NOT EXISTS flight_events (
            id TEXT PRIMARY KEY,
            sequence INTEGER NOT NULL,
            trace_id TEXT NOT NULL,
            timestamp TEXT NOT NULL,
            timestamp_ms INTEGER NOT NULL,
            kind TEXT NOT NULL,
            source TEXT NOT NULL,
            status TEXT NOT NULL,
            session_id TEXT,
            workspace_id TEXT,
            provider_id TEXT,
            agent_name TEXT,
            tool_name TEXT,
            event_json TEXT NOT NULL,
            UNIQUE (trace_id, sequence)
          );
          CREATE TABLE IF NOT EXISTS flight_metadata (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
          );
        `);

        migrateTimestampColumn(db);

        db.exec(`
          CREATE INDEX IF NOT EXISTS idx_flight_events_sequence_timestamp_ms
            ON flight_events(sequence, timestamp_ms);
          CREATE INDEX IF NOT EXISTS idx_flight_events_trace
            ON flight_events(trace_id);
          CREATE INDEX IF NOT EXISTS idx_flight_events_session
            ON flight_events(session_id);
          CREATE INDEX IF NOT EXISTS idx_flight_events_workspace
            ON flight_events(workspace_id);
          CREATE INDEX IF NOT EXISTS idx_flight_events_kind
            ON flight_events(kind);
          CREATE INDEX IF NOT EXISTS idx_flight_events_source
            ON flight_events(source);
          CREATE INDEX IF NOT EXISTS idx_flight_events_provider
            ON flight_events(provider_id);
          CREATE INDEX IF NOT EXISTS idx_flight_events_agent
            ON flight_events(agent_name);
          CREATE INDEX IF NOT EXISTS idx_flight_events_tool
            ON flight_events(tool_name);
          CREATE INDEX IF NOT EXISTS idx_flight_events_status
            ON flight_events(status);
          CREATE INDEX IF NOT EXISTS idx_flight_events_timestamp_ms
            ON flight_events(timestamp_ms);
        `);
        if (!this.inMemory) {
          verifyPrivateDatabaseFiles(preparedFiles!);
          materializeAndHardenDatabaseFiles(db, this.databasePath);
          verifyPrivateDatabaseFiles(preparedFiles!);
        }
      });
    } catch (error) {
      db.close();
      throw error;
    }

    if (this.isClosed()) {
      db.close();
      return;
    }
    this.db = db;
    this.state = "initialized";
  }

  async close(): Promise<void> {
    if (this.state === "closed") {
      return;
    }
    this.state = "closed";
    if (this.initializing) {
      await this.initializing;
    }
    this.db?.close();
    this.db = null;
  }

  async append(event: FlightEvent): Promise<FlightAppendReceipt | void> {
    const db = this.ensureDb();
    const serialized = serializeEvent(event, "event");
    const statement = db.prepare(insertSql(false));
    db.pragma(`busy_timeout = ${RUNTIME_BUSY_TIMEOUT_MS}`);
    try {
      return db.transaction(() => {
        const inserted = statement.run(...eventParameters(serialized));
        if (inserted.changes === 0) return undefined;
        const row = db
          .prepare(`
            SELECT rowid AS row_id, *
            FROM flight_events
            WHERE id = ?
          `)
          .get(event.id) as PruneEventRow | undefined;
        const stored = row ? rowToEvent(row) : undefined;
        if (
          !stored ||
          stored.id !== event.id ||
          stored.traceId !== event.traceId ||
          stored.kind !== event.kind ||
          stored.sequence !== event.sequence ||
          stored.contentHash !== event.contentHash
        ) {
          throw new Error(
            `Flight event "${event.id}" was not queryable by exact immutable identity inside its append transaction.`,
          );
        }
        return {
          eventId: stored.id,
          traceId: stored.traceId,
          kind: stored.kind,
          sequence: stored.sequence,
          contentHash: stored.contentHash,
        };
      })();
    } finally {
      db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
    }
  }

  async query(query: FlightEventQuery = {}): Promise<FlightEvent[]> {
    return selectEvents(this.ensureDb(), query, true);
  }

  async count(): Promise<number> {
    const db = this.ensureDb();
    const row = db
      .prepare("SELECT COUNT(*) AS count FROM flight_events")
      .get() as {
      count: number;
    };
    return row.count;
  }

  async lastSequence(traceId: string): Promise<number> {
    assertString(traceId, "traceId");
    const row = this.ensureDb()
      .prepare(`
        SELECT rowid AS row_id, *
        FROM flight_events
        WHERE trace_id = ?
        ORDER BY sequence DESC, rowid DESC
        LIMIT 1
      `)
      .get(traceId) as PruneEventRow | undefined;
    return row ? rowToEvent(row).sequence : 0;
  }

  async bindIdentityKey(identityKey: string): Promise<void> {
    if (!/^[0-9a-f]{64}$/i.test(identityKey)) {
      throw new Error(
        "Flight Recorder identity key must be 32-byte hexadecimal.",
      );
    }
    const fingerprint = createHash("sha256")
      .update(`openrappter-flight-identity/1:${identityKey.toLowerCase()}`)
      .digest("hex");
    const db = this.ensureDb();
    await retrySqliteBusy(() =>
      db.transaction(() => {
        const row = db
          .prepare(
            "SELECT value FROM flight_metadata WHERE key = 'identity-key-fingerprint'",
          )
          .get() as { value?: string } | undefined;
        if (row?.value !== undefined && row.value !== fingerprint) {
          throw new Error(
            "Flight Recorder identity key does not match the ledger fingerprint.",
          );
        }
        if (row?.value === undefined) {
          db.prepare(
            "INSERT INTO flight_metadata (key, value) VALUES ('identity-key-fingerprint', ?)",
          ).run(fingerprint);
        }
      })(),
    );
  }

  /**
   * `keep` is a target bound, not a hard bound: preserving active traces and
   * replayable completed traces may retain more rows than requested.
   */
  async prune(keep: number): Promise<number> {
    const db = this.ensureDb();
    assertNonNegativeInteger(keep, "keep");

    const deleted = await retrySqliteBusy(() => pruneOnce(db, keep));
    if (deleted > 0) {
      await purgeDeletedPages(db, false);
    }
    return deleted;
  }

  async pruneRuntime(keep: number): Promise<number> {
    const db = this.ensureDb();
    assertNonNegativeInteger(keep, "keep");
    db.pragma(`busy_timeout = ${RUNTIME_BUSY_TIMEOUT_MS}`);
    try {
      const deleted = pruneOnce(db, keep);
      if (deleted > 0) purgeDeletedPagesOnce(db, false);
      return deleted;
    } finally {
      db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
    }
  }

  async export(query?: FlightEventQuery): Promise<FlightExport> {
    const db = this.ensureDb();
    return retrySqliteBusy(() =>
      db.transaction(() => {
        const events = selectEvents(db, query ?? {}, false).map(
          exportableEvent,
        );
        return {
          schema: EXPORT_SCHEMA,
          exportedAt: new Date().toISOString(),
          events,
        };
      })(),
    );
  }

  async import(
    data: FlightExport,
    options: { replace?: boolean } = {},
  ): Promise<number> {
    const db = this.ensureDb();
    const serializedEvents = validateExport(data);

    const imported = await retrySqliteBusy(() =>
      db.transaction(() => {
        const existingRows = db
          .prepare("SELECT * FROM flight_events")
          .all() as FlightEventRow[];
        const snapshot = buildImportSnapshot(existingRows);
        const persistedEvents: SerializedEvent[] = [];
        for (const event of serializedEvents) {
          const existing = snapshot.existingById.get(event.event.id);
          if (existing && options.replace !== true) {
            if (
              exportableEvent(existing).contentHash !==
              event.event.contentHash
            ) {
              throw new Error(
                `Flight event ID "${event.event.id}" conflicts with existing content.`,
              );
            }
            continue;
          }
          assertLiveTraceImportSafe(snapshot, event);
          const persisted =
            options.replace === true
              ? preserveLiveOwnership(snapshot, event)
              : event;
          persistedEvents.push(persisted);
        }
        if (options.replace === true) {
          const deleteEvent = db.prepare(
            "DELETE FROM flight_events WHERE id = ?",
          );
          for (const event of persistedEvents) {
            deleteEvent.run(event.event.id);
          }
        }
        const statement = db.prepare(insertSql(false));
        let imported = 0;
        for (const event of persistedEvents) {
          imported += statement.run(...eventParameters(event)).changes;
        }
        return imported;
      })(),
    );
    if (options.replace === true && imported > 0) {
      await purgeDeletedPages(db, false);
    }
    return imported;
  }

  async clear(): Promise<void> {
    const db = this.ensureDb();
    await retrySqliteBusy(() =>
      db.transaction(() => {
        const rows = db
          .prepare(`
            SELECT rowid AS row_id, *
            FROM flight_events
            ORDER BY trace_id, sequence, rowid
          `)
          .all() as PruneEventRow[];
        if (
          buildRetentionTraces(rows).some(
            (trace) => trace.lifecycle === "active",
          )
        ) {
          throw new Error(
            "Flight ledger cannot clear while active traces exist.",
          );
        }
        db.prepare("DELETE FROM flight_events").run();
      })(),
    );
    await purgeDeletedPages(db, true);
  }

  async releaseEventOwnership(eventId: string): Promise<void> {
    const db = this.ensureDb();
    db.pragma(`busy_timeout = ${RUNTIME_BUSY_TIMEOUT_MS}`);
    try {
      db.transaction(() => {
        const row = db
          .prepare(`
            SELECT rowid AS row_id, *
            FROM flight_events
            WHERE id = ?
          `)
          .get(eventId) as PruneEventRow | undefined;
        if (!row) return;
        const event = rowToEvent(row);
        if (
          !Object.hasOwn(event.metadata, "ownerPid") &&
          !Object.hasOwn(event.metadata, "ownerId") &&
          !Object.hasOwn(event.metadata, "ownerIncarnation")
        ) {
          return;
        }
        const metadata = { ...event.metadata };
        delete metadata.ownerPid;
        delete metadata.ownerId;
        delete metadata.ownerIncarnation;
        const body = { ...event, metadata } as Omit<
          FlightEvent,
          "contentHash"
        > &
          Partial<FlightEvent>;
        delete body.contentHash;
        const released = {
          ...body,
          contentHash: computeFlightEventHash(body),
        };
        db.prepare("UPDATE flight_events SET event_json = ? WHERE id = ?")
          .run(JSON.stringify(released), eventId);
      })();
    } finally {
      db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
    }
  }

  private ensureDb(): Database {
    if (this.state === "closed") {
      throw new Error("Flight ledger is closed.");
    }
    if (this.state !== "initialized" || !this.db) {
      throw new Error(
        "Flight ledger is not initialized. Call initialize() first.",
      );
    }
    return this.db;
  }

  private isClosed(): boolean {
    return this.state === "closed";
  }
}

function pruneOnce(db: Database, keep: number): number {
  return db.transaction(() => {
    const { count: before } = db
      .prepare("SELECT COUNT(*) AS count FROM flight_events")
      .get() as { count: number };
    if (before <= keep) return 0;

    const rows = db
      .prepare(`
        SELECT rowid AS row_id, *
        FROM flight_events
        ORDER BY trace_id, sequence, rowid
      `)
      .all() as PruneEventRow[];
    const traces = buildRetentionTraces(rows);
    const active = traces.filter((trace) => trace.lifecycle === "active");
    const candidates = traces
      .filter((trace) => trace.lifecycle !== "active")
      .sort(compareRetentionTraces);
    const retainedTraceIds = new Set(active.map((trace) => trace.traceId));
    let retainedRows = active.reduce(
      (total, trace) => total + trace.rowCount,
      0,
    );
    const newestCompleted =
      keep > 0
        ? candidates.find((trace) => trace.lifecycle === "completed")
        : undefined;
    if (newestCompleted) {
      retainedTraceIds.add(newestCompleted.traceId);
      retainedRows += newestCompleted.rowCount;
    }
    for (const trace of candidates) {
      if (retainedTraceIds.has(trace.traceId)) continue;
      if (retainedRows + trace.rowCount > keep) break;
      retainedTraceIds.add(trace.traceId);
      retainedRows += trace.rowCount;
    }
    if (
      keep > 0 &&
      active.length === 0 &&
      retainedTraceIds.size === 0 &&
      candidates[0]
    ) {
      retainedTraceIds.add(candidates[0].traceId);
    }

    const deleteTrace = db.prepare(
      "DELETE FROM flight_events WHERE trace_id = ?",
    );
    let deleted = 0;
    for (const trace of traces) {
      if (!retainedTraceIds.has(trace.traceId)) {
        deleted += deleteTrace.run(trace.traceId).changes;
      }
    }
    return deleted;
  })();
}

async function purgeDeletedPages(
  db: Database,
  vacuum: boolean,
): Promise<void> {
  await retrySqliteBusy(() => {
    assertCheckpointComplete(db.pragma("wal_checkpoint(TRUNCATE)"));
    if (vacuum) {
      db.exec("VACUUM");
      assertCheckpointComplete(db.pragma("wal_checkpoint(TRUNCATE)"));
    }
  });
}

function purgeDeletedPagesOnce(db: Database, vacuum: boolean): void {
  assertCheckpointComplete(db.pragma("wal_checkpoint(TRUNCATE)"));
  if (vacuum) {
    db.exec("VACUUM");
    assertCheckpointComplete(db.pragma("wal_checkpoint(TRUNCATE)"));
  }
}

function assertCheckpointComplete(result: unknown): void {
  const first = Array.isArray(result) ? result[0] : result;
  const busy =
    typeof first === "object" && first !== null
      ? Number(
          (first as Record<string, unknown>).busy ??
            Object.values(first as Record<string, unknown>)[0],
        )
      : Number.NaN;
  if (busy !== 0) {
    const error = new Error("SQLITE_BUSY: WAL checkpoint did not complete");
    (error as Error & { code: string }).code = "SQLITE_BUSY";
    throw error;
  }
}

function selectEvents(
  db: Database,
  query: FlightEventQuery,
  publicQuery: boolean,
): FlightEvent[] {
  assertOnlyKeys(
    query as Record<string, unknown>,
    QUERY_KEYS,
    "flight event query",
  );
  for (const [label, value] of [
    ["traceId", query.traceId],
    ["sessionId", query.sessionId],
    ["workspaceId", query.workspaceId],
    ["source", query.source],
    ["providerId", query.providerId],
    ["agentName", query.agentName],
    ["toolName", query.toolName],
    ["status", query.status],
  ] as const) {
    if (value !== undefined) assertString(value, label);
  }

  let kindFilter: Set<string> | undefined;
  if (query.kind !== undefined) {
    const kinds = Array.isArray(query.kind) ? query.kind : [query.kind];
    if (kinds.length > MAX_KIND_FILTERS) {
      throw new Error(
        `kind filter may contain at most ${MAX_KIND_FILTERS} values.`,
      );
    }
    for (const kind of kinds) assertString(kind, "kind");
    kindFilter = new Set(kinds);
  }

  const sinceMs =
    query.since === undefined
      ? undefined
      : isoTimestampToMs(query.since, "since");
  const untilMs =
    query.until === undefined
      ? undefined
      : isoTimestampToMs(query.until, "until");

  let limit: number | undefined;
  let offset: number;
  if (publicQuery) {
    limit = boundedInteger(
      query.limit,
      "limit",
      MAX_QUERY_LIMIT,
      MAX_QUERY_LIMIT,
    );
    offset = boundedInteger(query.offset, "offset", MAX_QUERY_OFFSET, 0);
  } else {
    if (query.limit !== undefined) {
      assertNonNegativeInteger(query.limit, "limit");
      limit = query.limit;
    }
    if (query.offset !== undefined) {
      assertNonNegativeInteger(query.offset, "offset");
    }
    offset = query.offset ?? 0;
  }

  const order = query.order ?? "asc";
  if (order !== "asc" && order !== "desc") {
    throw new Error('order must be "asc" or "desc".');
  }

  const validated = (
    db
      .prepare("SELECT rowid AS row_id, * FROM flight_events")
      .all() as PruneEventRow[]
  ).map((row) => ({ row, event: rowToEvent(row) }));

  const filtered = validated.filter(({ row, event }) => {
    if (query.traceId !== undefined && event.traceId !== query.traceId)
      return false;
    if (query.sessionId !== undefined && event.sessionId !== query.sessionId)
      return false;
    if (
      query.workspaceId !== undefined &&
      event.workspaceId !== query.workspaceId
    )
      return false;
    if (query.source !== undefined && event.source !== query.source)
      return false;
    if (
      query.providerId !== undefined &&
      event.providerId !== query.providerId
    )
      return false;
    if (query.agentName !== undefined && event.agentName !== query.agentName)
      return false;
    if (query.toolName !== undefined && event.toolName !== query.toolName)
      return false;
    if (query.status !== undefined && event.status !== query.status)
      return false;
    if (kindFilter !== undefined && !kindFilter.has(event.kind)) return false;
    if (sinceMs !== undefined && row.timestamp_ms < sinceMs) return false;
    if (untilMs !== undefined && row.timestamp_ms > untilMs) return false;
    return true;
  });

  const multiplier = order === "asc" ? 1 : -1;
  filtered.sort((left, right) => {
    const fields =
      query.traceId === undefined
        ? [
            left.row.timestamp_ms - right.row.timestamp_ms,
            left.row.row_id - right.row.row_id,
          ]
        : [
            left.event.sequence - right.event.sequence,
            left.row.timestamp_ms - right.row.timestamp_ms,
            left.row.row_id - right.row.row_id,
          ];
    return (fields.find((value) => value !== 0) ?? 0) * multiplier;
  });

  if (limit === 0) return [];
  return filtered
    .slice(offset, limit === undefined ? undefined : offset + limit)
    .map(({ event }) => event);
}

function hardenDatabaseFiles(databasePath: string): void {
  for (const candidate of [
    databasePath,
    `${databasePath}-wal`,
    `${databasePath}-shm`,
  ]) {
    if (existsSync(candidate)) {
      hardenPrivatePath(candidate);
    }
  }
}

interface PrivateFileIdentity {
  path: string;
  dev: number;
  ino: number;
}

function preparePrivateDatabaseFiles(
  databasePath: string,
): PrivateFileIdentity[] {
  const identities: PrivateFileIdentity[] = [];
  for (const candidate of [
    databasePath,
    `${databasePath}-wal`,
    `${databasePath}-shm`,
  ]) {
    try {
      const existing = lstatSync(candidate);
      if (existing.isSymbolicLink() || !existing.isFile()) {
        throw new Error(
          `Flight Recorder storage must be a regular file: ${candidate}`,
        );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const descriptor = openSync(
      candidate,
      constants.O_CREAT |
        constants.O_RDWR |
        (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    try {
      const opened = fstatSync(descriptor);
      const linked = lstatSync(candidate);
      if (
        !opened.isFile() ||
        linked.isSymbolicLink() ||
        !linked.isFile() ||
        opened.dev !== linked.dev ||
        opened.ino !== linked.ino
      ) {
        throw new Error(
          `Flight Recorder storage changed during private open: ${candidate}`,
        );
      }
      hardenPrivatePath(candidate);
      identities.push({
        path: candidate,
        dev: opened.dev,
        ino: opened.ino,
      });
    } finally {
      closeSync(descriptor);
    }
  }
  return identities;
}

function verifyPrivateDatabaseFiles(
  identities: PrivateFileIdentity[],
): void {
  for (const identity of identities) {
    const current = lstatSync(identity.path);
    if (
      current.isSymbolicLink() ||
      !current.isFile() ||
      current.dev !== identity.dev ||
      current.ino !== identity.ino
    ) {
      throw new Error(
        `Flight Recorder storage identity changed: ${identity.path}`,
      );
    }
  }
}

function materializeAndHardenDatabaseFiles(
  db: Database,
  databasePath: string,
): void {
  const probeId = `__openrappter_sidecar_probe__:${randomUUID()}`;
  db.transaction(() => {
    db.prepare(`
      INSERT INTO flight_events (
        id, sequence, trace_id, timestamp, timestamp_ms, kind, source,
        status, session_id, workspace_id, provider_id, agent_name,
        tool_name, event_json
      ) VALUES (?, 0, ?, '1970-01-01T00:00:00.000Z', 0, 'sidecar.probe',
                'flight-recorder', 'info', NULL, NULL, NULL, NULL, NULL, '{}')
    `).run(probeId, probeId);
    db.prepare("DELETE FROM flight_events WHERE id = ?").run(probeId);
  })();

  const candidates = [
    databasePath,
    `${databasePath}-wal`,
    `${databasePath}-shm`,
  ];
  const missing = candidates.filter((candidate) => !existsSync(candidate));
  if (missing.length > 0) {
    throw new Error(
      `Flight Recorder private SQLite files were not materialized: ${missing.join(", ")}`,
    );
  }
  hardenDatabaseFiles(databasePath);
}

function migrateTimestampColumn(db: Database): void {
  const columns = db
    .prepare("PRAGMA table_info(flight_events)")
    .all() as Array<{
    name: string;
  }>;
  if (columns.some((column) => column.name === "timestamp_ms")) {
    return;
  }

  try {
    db.transaction(() => {
      db.exec(
        "ALTER TABLE flight_events ADD COLUMN timestamp_ms INTEGER NOT NULL DEFAULT 0",
      );
      const rows = db
        .prepare("SELECT rowid AS row_id, * FROM flight_events")
        .all() as MigrationEventRow[];
      const update = db.prepare(
        "UPDATE flight_events SET timestamp_ms = ? WHERE rowid = ?",
      );
      for (const row of rows) {
        const event = rowToEvent(row, false);
        update.run(
          isoTimestampToMs(event.timestamp, `event "${event.id}"`),
          row.row_id,
        );
      }
    })();
  } catch (error) {
    if (isSqliteBusy(error)) {
      throw error;
    }
    throw new Error(
      `Flight ledger timestamp_ms migration failed: ${errorMessage(error)}`,
    );
  }
}

function buildRetentionTraces(rows: PruneEventRow[]): RetentionTrace[] {
  const traces = new Map<string, RetentionTrace>();

  for (const row of rows) {
    const event = rowToEvent(row);
    const timestamp = row.timestamp_ms;
    let trace = traces.get(event.traceId);
    if (!trace) {
      trace = {
        traceId: event.traceId,
        rowCount: 0,
        lifecycle: "atomic",
        lifecycleDepth: 0,
        sawLifecycleStart: false,
        malformedLifecycle: false,
        lifecycleStarts: new Map(),
        latestTimestamp: timestamp,
        latestRowId: row.row_id,
      };
      traces.set(event.traceId, trace);
    }

    trace.rowCount += 1;
    if (event.kind === "trace.started") {
      trace.sawLifecycleStart = true;
      if (event.id) {
        const ownerPid = Number(event.metadata.ownerPid);
        trace.lifecycleStarts.set(event.id, {
          pid:
            Number.isSafeInteger(ownerPid) && ownerPid > 0
              ? ownerPid
              : null,
          incarnation:
            typeof event.metadata.ownerIncarnation === "string"
              ? event.metadata.ownerIncarnation
              : undefined,
        });
        trace.lifecycleDepth = trace.lifecycleStarts.size;
      } else {
        trace.malformedLifecycle = true;
      }
    } else if (
      event.kind === "trace.completed" ||
      event.kind === "trace.failed"
    ) {
      if (
        event.parentId &&
        trace.lifecycleStarts.delete(event.parentId)
      ) {
        trace.lifecycleDepth = trace.lifecycleStarts.size;
      } else {
        trace.malformedLifecycle = true;
      }
    }
    if (
      timestamp > trace.latestTimestamp ||
      (timestamp === trace.latestTimestamp && row.row_id > trace.latestRowId)
    ) {
      trace.latestTimestamp = timestamp;
      trace.latestRowId = row.row_id;
    }
  }

  for (const trace of traces.values()) {
    trace.lifecycle =
      trace.lifecycleDepth > 0 &&
      [...trace.lifecycleStarts.values()].some(
        (owner) =>
          owner.pid !== null &&
          processMatchesIncarnation(owner.pid, owner.incarnation),
      )
        ? "active"
        : !trace.sawLifecycleStart && !trace.malformedLifecycle
          ? "atomic"
          : trace.sawLifecycleStart && !trace.malformedLifecycle
            ? "completed"
            : "malformed";
  }

  return [...traces.values()];
}

function compareRetentionTraces(
  left: RetentionTrace,
  right: RetentionTrace,
): number {
  return (
    right.latestTimestamp - left.latestTimestamp ||
    right.latestRowId - left.latestRowId
  );
}

function insertSql(replace: boolean): string {
  const values = `
    id, sequence, trace_id, timestamp, timestamp_ms, kind, source, status,
    session_id, workspace_id, provider_id, agent_name, tool_name, event_json
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

  if (!replace) {
    return `INSERT INTO flight_events (${values}
      ON CONFLICT(id) DO NOTHING`;
  }

  return `INSERT INTO flight_events (${values}
    ON CONFLICT(id) DO UPDATE SET
      sequence = excluded.sequence,
      trace_id = excluded.trace_id,
      timestamp = excluded.timestamp,
      timestamp_ms = excluded.timestamp_ms,
      kind = excluded.kind,
      source = excluded.source,
      status = excluded.status,
      session_id = excluded.session_id,
      workspace_id = excluded.workspace_id,
      provider_id = excluded.provider_id,
      agent_name = excluded.agent_name,
      tool_name = excluded.tool_name,
      event_json = excluded.event_json`;
}

function eventParameters(serialized: SerializedEvent): unknown[] {
  const { event, json } = serialized;
  return [
    event.id,
    event.sequence,
    event.traceId,
    event.timestamp,
    isoTimestampToMs(event.timestamp, `event "${event.id}"`),
    event.kind,
    event.source,
    event.status,
    event.sessionId ?? null,
    event.workspaceId ?? null,
    event.providerId ?? null,
    event.agentName ?? null,
    event.toolName ?? null,
    json,
  ];
}

interface ImportSnapshot {
  existingById: Map<string, FlightEvent>;
  liveTraceIds: Set<string>;
  liveStartIds: Set<string>;
}

function buildImportSnapshot(rows: FlightEventRow[]): ImportSnapshot {
  const existingById = new Map<string, FlightEvent>();
  const byTrace = new Map<string, FlightEvent[]>();
  for (const row of rows) {
    const event = rowToEvent(row);
    existingById.set(event.id, event);
    const trace = byTrace.get(event.traceId) ?? [];
    trace.push(event);
    byTrace.set(event.traceId, trace);
  }

  const liveTraceIds = new Set<string>();
  const liveStartIds = new Set<string>();
  for (const [traceId, events] of byTrace) {
    events.sort((left, right) => left.sequence - right.sequence);
    const unmatched = new Map<
      string,
      { ownerPid?: number; ownerIncarnation?: string }
    >();
    for (const event of events) {
      if (event.kind === "trace.started") {
        unmatched.set(event.id, {
          ownerPid:
            typeof event.metadata.ownerPid === "number"
              ? event.metadata.ownerPid
              : undefined,
          ownerIncarnation:
            typeof event.metadata.ownerIncarnation === "string"
              ? event.metadata.ownerIncarnation
              : undefined,
        });
      } else if (
        (event.kind === "trace.completed" ||
          event.kind === "trace.failed") &&
        event.parentId
      ) {
        unmatched.delete(event.parentId);
      }
    }
    for (const [startId, owner] of unmatched) {
      if (
        owner.ownerPid !== undefined &&
        processMatchesIncarnation(
          owner.ownerPid,
          owner.ownerIncarnation,
        )
      ) {
        liveTraceIds.add(traceId);
        liveStartIds.add(startId);
      }
    }
  }
  return { existingById, liveTraceIds, liveStartIds };
}

function preserveLiveOwnership(
  snapshot: ImportSnapshot,
  incoming: SerializedEvent,
): SerializedEvent {
  const existing = snapshot.existingById.get(incoming.event.id);
  if (!existing) return incoming;

  const ownerPid = Number(existing.metadata?.ownerPid);
  const ownerIncarnation =
    typeof existing.metadata?.ownerIncarnation === "string"
      ? existing.metadata.ownerIncarnation
      : undefined;
  if (
    existing.kind !== "trace.started" ||
    !Number.isSafeInteger(ownerPid) ||
    ownerPid <= 0 ||
    !processMatchesIncarnation(ownerPid, ownerIncarnation) ||
    !snapshot.liveStartIds.has(existing.id)
  ) {
    return incoming;
  }
  if (
    incoming.event.kind !== "trace.started" ||
    incoming.event.traceId !== existing.traceId ||
    incoming.event.sequence !== existing.sequence ||
    exportableEvent(existing).contentHash !== incoming.event.contentHash
  ) {
    throw new Error(
      `Cannot replace live trace start "${existing.id}" with different portable content.`,
    );
  }

  const metadata = {
    ...incoming.event.metadata,
    ownerPid,
    ...(ownerIncarnation === undefined
      ? {}
      : { ownerIncarnation }),
    ...(existing.metadata.ownerId === undefined
      ? {}
      : { ownerId: existing.metadata.ownerId }),
  };
  const body = {
    ...incoming.event,
    metadata,
  } as Omit<FlightEvent, "contentHash"> & Partial<FlightEvent>;
  delete body.contentHash;
  return serializeEvent(
    {
      ...body,
      contentHash: computeFlightEventHash(body),
    },
    `replacement event "${incoming.event.id}"`,
  );
}

function assertLiveTraceImportSafe(
  snapshot: ImportSnapshot,
  incoming: SerializedEvent,
): void {
  const existing = snapshot.existingById.get(incoming.event.id);
  if (existing) {
    if (
      existing.traceId !== incoming.event.traceId &&
      snapshot.liveTraceIds.has(existing.traceId)
    ) {
      throw new Error(
        `Cannot move event "${incoming.event.id}" out of live trace "${existing.traceId}".`,
      );
    }
  }
  if (!snapshot.liveTraceIds.has(incoming.event.traceId)) {
    return;
  }
  if (existing) {
    const portableExisting = exportableEvent(existing);
    if (portableExisting.contentHash === incoming.event.contentHash) return;
  }
  throw new Error(
    `Cannot import event "${incoming.event.id}" into live trace "${incoming.event.traceId}".`,
  );
}

function rowToEvent(
  row: FlightEventRow,
  verifyTimestampMs = true,
): FlightEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.event_json);
  } catch (error) {
    throw new Error(
      `Corrupt flight event row "${row.id}": event_json is not valid JSON: ${errorMessage(error)}`,
    );
  }

  let event: FlightEvent;
  try {
    event = validateEvent(parsed, `flight event row "${row.id}"`);
  } catch (error) {
    throw new Error(
      `Corrupt flight event row "${row.id}": ${errorMessage(error)}`,
    );
  }
  const mismatches: string[] = [];
  compareIndexed(mismatches, "id", row.id, event.id);
  compareIndexed(mismatches, "sequence", row.sequence, event.sequence);
  compareIndexed(mismatches, "traceId", row.trace_id, event.traceId);
  compareIndexed(mismatches, "timestamp", row.timestamp, event.timestamp);
  if (verifyTimestampMs) {
    compareIndexed(
      mismatches,
      "timestampMs",
      row.timestamp_ms,
      isoTimestampToMs(event.timestamp, `event "${event.id}"`),
    );
  }
  compareIndexed(mismatches, "kind", row.kind, event.kind);
  compareIndexed(mismatches, "source", row.source, event.source);
  compareIndexed(mismatches, "status", row.status, event.status);
  compareIndexed(
    mismatches,
    "sessionId",
    row.session_id,
    event.sessionId ?? null,
  );
  compareIndexed(
    mismatches,
    "workspaceId",
    row.workspace_id,
    event.workspaceId ?? null,
  );
  compareIndexed(
    mismatches,
    "providerId",
    row.provider_id,
    event.providerId ?? null,
  );
  compareIndexed(
    mismatches,
    "agentName",
    row.agent_name,
    event.agentName ?? null,
  );
  compareIndexed(mismatches, "toolName", row.tool_name, event.toolName ?? null);

  if (mismatches.length > 0) {
    throw new Error(
      `Corrupt flight event row "${row.id}": ${mismatches.join(", ")}.`,
    );
  }
  return event;
}

function compareIndexed(
  mismatches: string[],
  field: string,
  indexedValue: unknown,
  eventValue: unknown,
): void {
  if (indexedValue !== eventValue) {
    mismatches.push(`${field} does not match event_json`);
  }
}

function validateExport(data: unknown): SerializedEvent[] {
  if (!isPlainObject(data)) {
    throw new Error("Flight export must be an object.");
  }
  assertOnlyKeys(
    data,
    new Set(["schema", "exportedAt", "events"]),
    "flight export",
  );
  if (data.schema !== EXPORT_SCHEMA) {
    throw new Error(`Flight export schema must be "${EXPORT_SCHEMA}".`);
  }
  assertString(data.exportedAt, "flight export exportedAt");
  assertIsoTimestamp(data.exportedAt, "flight export exportedAt");
  if (!Array.isArray(data.events)) {
    throw new Error("Flight export events must be an array.");
  }
  const ids = new Set<string>();
  return data.events.map((event, index) => {
    if (
      isPlainObject(event) &&
      isPlainObject(event.metadata) &&
      (Object.hasOwn(event.metadata, "ownerPid") ||
        Object.hasOwn(event.metadata, "ownerId") ||
        Object.hasOwn(event.metadata, "ownerIncarnation"))
    ) {
      throw new Error(
        `flight export events[${index}] must not claim live trace ownership.`,
      );
    }
    const serialized = serializeEvent(
      event,
      `flight export events[${index}]`,
    );
    if (ids.has(serialized.event.id)) {
      throw new Error(
        `flight export contains duplicate event ID "${serialized.event.id}".`,
      );
    }
    ids.add(serialized.event.id);
    return serialized;
  });
}

function exportableEvent(event: FlightEvent): FlightEvent {
  if (
    !Object.hasOwn(event.metadata, "ownerPid") &&
    !Object.hasOwn(event.metadata, "ownerId") &&
    !Object.hasOwn(event.metadata, "ownerIncarnation")
  ) {
    return event;
  }
  const metadata = { ...event.metadata };
  delete metadata.ownerPid;
  delete metadata.ownerId;
  delete metadata.ownerIncarnation;
  const body = { ...event, metadata } as Omit<FlightEvent, "contentHash"> &
    Partial<Pick<FlightEvent, "contentHash">>;
  delete body.contentHash;
  return {
    ...body,
    contentHash: computeFlightEventHash(body),
  } as FlightEvent;
}

function serializeEvent(value: unknown, label: string): SerializedEvent {
  const event = validateEvent(value, label);
  let json: string;
  try {
    json = JSON.stringify(event);
  } catch (error) {
    throw new Error(
      `${label} is not JSON-serializable: ${errorMessage(error)}`,
    );
  }
  if (json === undefined) {
    throw new Error(`${label} is not JSON-serializable.`);
  }
  return { event, json };
}

function validateEvent(value: unknown, label: string): FlightEvent {
  if (!isPlainObject(value)) {
    throw new Error(`${label} must be an object.`);
  }
  assertOnlyKeys(value, EVENT_KEYS, label);

  if (value.schema !== FLIGHT_EVENT_SCHEMA) {
    throw new Error(`${label}.schema must be "${FLIGHT_EVENT_SCHEMA}".`);
  }
  assertString(value.id, `${label}.id`);
  assertNonNegativeInteger(value.sequence, `${label}.sequence`);
  assertString(value.kind, `${label}.kind`);
  assertString(value.source, `${label}.source`);
  if (!EVENT_STATUSES.has(value.status as FlightEventStatus)) {
    throw new Error(`${label}.status is invalid.`);
  }
  assertString(value.traceId, `${label}.traceId`);
  if (value.parentId !== null) {
    assertString(value.parentId, `${label}.parentId`);
  }
  assertString(value.timestamp, `${label}.timestamp`);
  assertIsoTimestamp(value.timestamp, `${label}.timestamp`);
  assertString(value.contentHash, `${label}.contentHash`);
  if (!/^[0-9a-f]{64}$/.test(value.contentHash)) {
    throw new Error(
      `${label}.contentHash must be 64 lowercase hexadecimal characters.`,
    );
  }
  if (!isPlainObject(value.metadata)) {
    throw new Error(`${label}.metadata must be an object.`);
  }

  for (const key of [
    "sessionId",
    "workspaceId",
    "providerId",
    "model",
    "agentName",
    "toolName",
  ] as const) {
    if (value[key] !== undefined) {
      assertString(value[key], `${label}.${key}`);
    }
    if (
      value.model !== undefined &&
      normalizeFlightModelId(value.model as string) !== value.model
    ) {
      throw new Error(`${label}.model must be a concrete normalized model ID.`);
    }
    for (const key of [
      "id",
      "kind",
      "source",
      "traceId",
      "parentId",
      "providerId",
      "workspaceId",
      "model",
      "agentName",
      "toolName",
    ] as const) {
      const field = value[key];
      if (
        typeof field === "string" &&
        sanitizeFlightValue(field) !== field
      ) {
        throw new Error(`${label}.${key} violates Flight Recorder privacy.`);
      }
    }
  }
  if (value.durationMs !== undefined) {
    if (
      typeof value.durationMs !== "number" ||
      !Number.isFinite(value.durationMs) ||
      value.durationMs < 0 ||
      (Number.isInteger(value.durationMs) &&
        !Number.isSafeInteger(value.durationMs))
    ) {
      throw new Error(
        `${label}.durationMs must be a finite non-negative JSON-safe number.`,
      );
    }
  }

  assertJsonValue(value.metadata, `${label}.metadata`);
  if (
    value.sessionId !== undefined &&
    !/^session:[0-9a-f]{24}$/.test(value.sessionId as string)
  ) {
    throw new Error(`${label}.sessionId must be an opaque session identifier.`);
  }
  if (
    value.workspaceId !== undefined &&
    normalizeFlightWorkspaceId(value.workspaceId as string) !==
      value.workspaceId
  ) {
    throw new Error(`${label}.workspaceId must not contain a raw path.`);
  }
  if (
    !isDeepStrictEqual(
      sanitizeFlightMetadata(value.metadata),
      value.metadata,
    )
  ) {
    throw new Error(`${label}.metadata violates Flight Recorder privacy.`);
  }
  if (Object.hasOwn(value, "payload")) {
    assertJsonValue(value.payload, `${label}.payload`);
    if (
      !isDeepStrictEqual(
        sanitizeFlightPayload(value.payload, {
          recordIO: true,
          maxPayloadBytes: Number.MAX_SAFE_INTEGER,
        }),
        value.payload,
      )
    ) {
      throw new Error(`${label}.payload violates Flight Recorder privacy.`);
    }
  }
  const event = value as unknown as FlightEvent;
  if (!verifyFlightEventHash(event)) {
    throw new Error(`Flight event integrity check failed for ${label}.`);
  }
  return event;
}

function assertJsonValue(
  value: unknown,
  label: string,
  seen: Set<object> = new Set(),
): void {
  if (typeof value === "string") {
    assertUnicodeScalarString(value, label);
    return;
  }
  if (
    value === null ||
    typeof value === "boolean" ||
    (typeof value === "number" &&
      Number.isFinite(value) &&
      (!Number.isInteger(value) || Number.isSafeInteger(value)))
  ) {
    return;
  }
  if (typeof value !== "object") {
    throw new Error(`${label} must contain only JSON-compatible values.`);
  }
  if (seen.has(value)) {
    throw new Error(`${label} must not contain circular references.`);
  }
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      assertJsonValue(item, `${label}[${index}]`, seen),
    );
  } else {
    if (!isPlainObject(value)) {
      throw new Error(`${label} must contain only plain JSON objects.`);
    }
    for (const [key, item] of Object.entries(value)) {
      assertUnicodeScalarString(key, `${label} key`);
      assertJsonValue(item, `${label}.${key}`, seen);
    }
  }
  seen.delete(value);
}

function assertUnicodeScalarString(value: string, label: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (
        !Number.isInteger(next) ||
        next < 0xdc00 ||
        next > 0xdfff
      ) {
        throw new Error(`${label} must contain valid Unicode scalar values.`);
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new Error(`${label} must contain valid Unicode scalar values.`);
    }
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertOnlyKeys(
  value: Record<string, unknown>,
  allowed: Set<string>,
  label: string,
): void {
  const unexpected = Object.keys(value).filter((key) => !allowed.has(key));
  if (unexpected.length > 0) {
    throw new Error(`${label} contains unexpected field "${unexpected[0]}".`);
  }
}

function assertString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string.`);
  }
  assertUnicodeScalarString(value, label);
}

function assertIsoTimestamp(value: string, label: string): void {
  isoTimestampToMs(value, label);
}

function isoTimestampToMs(value: string, label: string): number {
  const isoTimestamp =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|([+-])(\d{2}):(\d{2}))$/;
  const match = isoTimestamp.exec(value);
  if (!match) {
    throw new Error(`${label} must be a parseable ISO timestamp.`);
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const fraction = match[7] ?? "";
  const offsetSign = match[9];
  const offsetHour = match[10] === undefined ? 0 : Number(match[10]);
  const offsetMinute = match[11] === undefined ? 0 : Number(match[11]);
  const leapYear =
    year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [
    31,
    leapYear ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  const validCalendar =
    year >= 1 &&
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= daysInMonth[month - 1] &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59 &&
    offsetHour <= 14 &&
    offsetMinute <= 59 &&
    (offsetHour < 14 || offsetMinute === 0);
  if (!validCalendar) {
    throw new Error(`${label} must be a parseable ISO timestamp.`);
  }

  const fractionMs = Number(fraction.slice(0, 3).padEnd(3, "0") || "0");
  const offset =
    (offsetHour * 60 + offsetMinute) *
    (offsetSign === "-" ? -1 : 1);
  const timestampMs =
    daysFromCivil(year, month, day) * 86_400_000 +
    hour * 3_600_000 +
    minute * 60_000 +
    second * 1_000 +
    fractionMs -
    offset * 60_000;
  if (!Number.isSafeInteger(timestampMs)) {
    throw new Error(`${label} must be a parseable ISO timestamp.`);
  }
  return timestampMs;
}

function daysFromCivil(year: number, month: number, day: number): number {
  const adjustedYear = year - (month <= 2 ? 1 : 0);
  const era = Math.floor(adjustedYear / 400);
  const yearOfEra = adjustedYear - era * 400;
  const shiftedMonth = month + (month > 2 ? -3 : 9);
  const dayOfYear =
    Math.floor((153 * shiftedMonth + 2) / 5) + day - 1;
  const dayOfEra =
    yearOfEra * 365 +
    Math.floor(yearOfEra / 4) -
    Math.floor(yearOfEra / 100) +
    dayOfYear;
  return era * 146_097 + dayOfEra - 719_468;
}

function assertNonNegativeInteger(
  value: unknown,
  label: string,
): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer.`);
  }
}

function boundedInteger(
  value: number | undefined,
  label: string,
  maximum: number,
  fallback: number,
): number {
  if (value === undefined) {
    return fallback;
  }
  assertNonNegativeInteger(value, label);
  return Math.min(value, maximum);
}

async function retrySqliteBusy<T>(operation: () => T): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return operation();
    } catch (error) {
      if (!isSqliteBusy(error) || attempt >= MAX_BUSY_RETRIES) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 10 * 2 ** attempt));
    }
  }
}

function isSqliteBusy(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const code = "code" in error ? String(error.code) : "";
  return code === "SQLITE_BUSY" || code.startsWith("SQLITE_BUSY_");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
