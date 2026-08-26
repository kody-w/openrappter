import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { computeFlightEventHash } from "./integrity.js";
import { SQLiteFlightLedger } from "./ledger.js";
import {
  FLIGHT_EVENT_SCHEMA,
  type FlightEvent,
  type FlightEventKind,
  type FlightEventQuery,
  type FlightExport,
} from "./types.js";

interface RawDatabase {
  exec(sql: string): void;
  close(): void;
  pragma(sql: string, options?: { simple?: boolean }): unknown;
  prepare(sql: string): {
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
    run(...params: unknown[]): { changes: number };
  };
}

const ledgers: SQLiteFlightLedger[] = [];
let testRoot: string;
let eventCounter = 0;

beforeAll(() => {
  testRoot = mkdtempSync(join(process.cwd(), ".flight-ledger-test-"));
});

afterEach(async () => {
  await Promise.all(ledgers.splice(0).map((ledger) => ledger.close()));
});

afterAll(() => {
  rmSync(testRoot, { recursive: true, force: true });
});

function ledger(options: {
  databasePath?: string;
  inMemory?: boolean;
}): SQLiteFlightLedger {
  const instance = new SQLiteFlightLedger(options);
  ledgers.push(instance);
  return instance;
}

function databasePath(name: string): string {
  return join(testRoot, `${name}.sqlite`);
}

function event(overrides: Partial<FlightEvent> = {}): FlightEvent {
  eventCounter += 1;
  const id = overrides.id ?? `event-${eventCounter}`;
  const { contentHash, ...eventOverrides } = overrides;
  const body = {
    schema: FLIGHT_EVENT_SCHEMA,
    id,
    sequence: eventCounter,
    kind: "agent.execute.completed",
    source: "test-recorder",
    status: "success",
    traceId: `trace-${eventCounter}`,
    parentId: `parent-${eventCounter}`,
    sessionId: `session:${eventCounter.toString(16).padStart(24, "0")}`,
    workspaceId: `workspace-${eventCounter}`,
    providerId: "copilot",
    model: "gpt-test",
    agentName: "TestAgent",
    toolName: "test-tool",
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, eventCounter)).toISOString(),
    durationMs: eventCounter,
    metadata:
      eventOverrides.kind === "trace.started"
        ? { ownerPid: process.pid }
        : {
            index: eventCounter,
            nested: { enabled: true, values: [1, "two", null] },
          },
    payload: { input: `payload-${eventCounter}`, output: ["ok"] },
    ...eventOverrides,
  } as Omit<FlightEvent, "contentHash">;
  if (Object.hasOwn(overrides, "payload") && overrides.payload === undefined) {
    delete body.payload;
  }
  return {
    ...body,
    contentHash: contentHash ?? computeFlightEventHash(body),
  };
}

function recordedTrace(options: {
  traceId: string;
  prefix: string;
  startedAt: string;
  middleKinds?: FlightEventKind[];
  terminal?: "trace.completed" | "trace.failed" | null;
  sequenceStart?: number;
}): FlightEvent[] {
  const kinds: FlightEventKind[] = [
    "trace.started",
    ...(options.middleKinds ?? []),
    ...(options.terminal === null
      ? []
      : [options.terminal ?? "trace.completed"]),
  ];
  const startedAt = Date.parse(options.startedAt);
  return kinds.map((kind, index) =>
    event({
      id: `${options.prefix}-${index + 1}`,
      traceId: options.traceId,
      parentId: index === 0 ? null : `${options.prefix}-1`,
      sequence: (options.sequenceStart ?? 1) + index,
      kind,
      ...(kind === "trace.started"
        ? { metadata: { ownerPid: process.pid } }
        : {}),
      status:
        kind === "trace.started"
          ? "started"
          : kind === "trace.failed"
            ? "error"
            : kind === "trace.completed"
              ? "success"
              : "info",
      timestamp: new Date(startedAt + index * 1_000).toISOString(),
    }),
  );
}

async function rawDatabase(path: string): Promise<RawDatabase> {
  const module = await import("better-sqlite3");
  const Database = module.default as unknown as new (
    filename: string,
    options?: { timeout?: number },
  ) => RawDatabase;
  return new Database(path, { timeout: 5_000 });
}

function createLegacyFlightTable(database: RawDatabase): void {
  database.exec(`
    CREATE TABLE flight_events (
      id TEXT PRIMARY KEY,
      sequence INTEGER NOT NULL,
      trace_id TEXT NOT NULL,
      timestamp TEXT NOT NULL,
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
    )
  `);
}

function insertLegacyEvent(
  database: RawDatabase,
  sample: FlightEvent,
  eventJson = JSON.stringify(sample),
): void {
  database
    .prepare(
      `INSERT INTO flight_events (
        id, sequence, trace_id, timestamp, kind, source, status,
        session_id, workspace_id, provider_id, agent_name, tool_name, event_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      sample.id,
      sample.sequence,
      sample.traceId,
      sample.timestamp,
      sample.kind,
      sample.source,
      sample.status,
      sample.sessionId ?? null,
      sample.workspaceId ?? null,
      sample.providerId ?? null,
      sample.agentName ?? null,
      sample.toolName ?? null,
      eventJson,
    );
}

describe("SQLiteFlightLedger", () => {
  it("requires initialization, rejects use after close, and closes idempotently", async () => {
    const instance = ledger({ inMemory: true });
    const sample = event();

    await expect(instance.append(sample)).rejects.toThrow(/not initialized/i);
    await expect(instance.query()).rejects.toThrow(/not initialized/i);
    await expect(instance.count()).rejects.toThrow(/not initialized/i);
    await expect(instance.prune(1)).rejects.toThrow(/not initialized/i);
    await expect(instance.export()).rejects.toThrow(/not initialized/i);
    await expect(
      instance.import({
        schema: "openrappter-flight-export/1.0",
        exportedAt: new Date().toISOString(),
        events: [],
      }),
    ).rejects.toThrow(/not initialized/i);
    await expect(instance.clear()).rejects.toThrow(/not initialized/i);

    await instance.initialize();
    await instance.close();
    await instance.close();
    await expect(instance.count()).rejects.toThrow(/closed/i);
    await expect(instance.append(sample)).rejects.toThrow(/closed/i);
    await expect(instance.initialize()).rejects.toThrow(/closed/i);
  });

  it("refuses clear while any trace remains active", async () => {
    const instance = ledger({ inMemory: true });
    await instance.initialize();
    const started = event({
      id: "active-clear-start",
      traceId: "active-clear",
      sequence: 1,
      kind: "trace.started",
      status: "started",
    });
    await instance.append(started);

    await expect(instance.clear()).rejects.toThrow(/active traces/i);
    expect(await instance.count()).toBe(1);

    await instance.append(
      event({
        id: "active-clear-complete",
        traceId: "active-clear",
        sequence: 2,
        kind: "trace.completed",
        status: "success",
        parentId: started.id,
      }),
    );
    await instance.clear();
    expect(await instance.count()).toBe(0);
  });

  it("reconciles unmatched starts owned by dead processes", async () => {
    const instance = ledger({ inMemory: true });
    await instance.initialize();
    await instance.append(
      event({
        id: "orphaned-start",
        traceId: "orphaned-trace",
        sequence: 1,
        kind: "trace.started",
        status: "started",
        metadata: { ownerPid: 2_147_483_647 },
      }),
    );

    expect(await instance.prune(0)).toBe(1);
    expect(await instance.count()).toBe(0);
  });

  it("does not treat a reused PID with another incarnation as active", async () => {
    const instance = ledger({ inMemory: true });
    await instance.initialize();
    await instance.append(
      event({
        id: "reused-pid-start",
        traceId: "reused-pid",
        sequence: 1,
        kind: "trace.started",
        status: "started",
        metadata: {
          ownerPid: process.pid,
          ownerIncarnation: "different-process-start",
        },
      }),
    );

    expect(await instance.prune(0)).toBe(1);
  });

  it("matches lifecycle terminals to their exact parent start", async () => {
    const instance = ledger({ inMemory: true });
    await instance.initialize();
    const liveStart = event({
      id: "live-start",
      traceId: "parent-match",
      sequence: 1,
      kind: "trace.started",
      status: "started",
      metadata: { ownerPid: process.pid },
    });
    const deadStart = event({
      id: "dead-start",
      traceId: "parent-match",
      sequence: 2,
      kind: "trace.started",
      status: "started",
      metadata: { ownerPid: 2_147_483_647 },
    });
    const liveComplete = event({
      id: "live-complete",
      traceId: "parent-match",
      sequence: 3,
      kind: "trace.completed",
      status: "success",
      parentId: liveStart.id,
    });
    for (const sample of [liveStart, deadStart, liveComplete]) {
      await instance.append(sample);
    }

    expect(await instance.prune(0)).toBe(3);
    expect(await instance.count()).toBe(0);
  });

  it("does not reopen when close races asynchronous initialization", async () => {
    const instance = ledger({ inMemory: true });
    const initialization = instance.initialize();

    await instance.close();
    await initialization;

    await expect(instance.count()).rejects.toThrow(/closed/i);
    await expect(instance.initialize()).rejects.toThrow(/closed/i);
  });

  it("initializes one SQLite connection under concurrent callers", async () => {
    const instance = ledger({
      databasePath: databasePath("concurrent-initialize"),
    });

    await Promise.all([instance.initialize(), instance.initialize()]);
    expect(await instance.count()).toBe(0);
    await instance.close();
    await expect(instance.count()).rejects.toThrow(/closed/i);
  });

  it("preserves complete events in memory and ignores duplicate IDs", async () => {
    const instance = ledger({ inMemory: true });
    await instance.initialize();
    const complete = event({
      id: "complete",
      sequence: 7,
      traceId: "trace-complete",
    });
    const withoutPayload = event({
      id: "without-payload",
      sequence: 8,
      traceId: "trace-without",
      payload: undefined,
    });
    const nullPayload = event({
      id: "null-payload",
      sequence: 9,
      traceId: "trace-null",
      payload: null,
    });

    await instance.append(complete);
    await instance.append(withoutPayload);
    await instance.append(nullPayload);
    await instance.append(
      event({ id: complete.id, traceId: "changed-trace", sequence: 99 }),
    );

    expect(await instance.query()).toEqual([
      complete,
      withoutPayload,
      nullPayload,
    ]);
    expect(await instance.count()).toBe(3);
    expect(
      Object.hasOwn(
        (await instance.query({ traceId: "trace-without" }))[0],
        "payload",
      ),
    ).toBe(false);
    expect(
      (await instance.query({ traceId: "trace-null" }))[0].payload,
    ).toBeNull();
  });

  it("allows identical sequences across traces and rejects collisions within one trace", async () => {
    const instance = ledger({ inMemory: true });
    await instance.initialize();
    const traceA = event({
      id: "same-sequence-a",
      sequence: 1,
      traceId: "trace-a",
    });
    const traceB = event({
      id: "same-sequence-b",
      sequence: 1,
      traceId: "trace-b",
    });

    await instance.append(traceA);
    await instance.append(traceB);
    const collision = event({
      id: "same-sequence-collision",
      sequence: 1,
      traceId: "trace-a",
    });

    expect(await instance.count()).toBe(2);
    expect(await instance.query({ traceId: "trace-a" })).toEqual([traceA]);
    expect(await instance.query({ traceId: "trace-b" })).toEqual([traceB]);
    await expect(instance.append(collision)).rejects.toThrow(
      /UNIQUE constraint failed/i,
    );
    expect(await instance.count()).toBe(2);
  });

  it("supports every query filter, kind arrays, stable ordering, limits, and offsets", async () => {
    const instance = ledger({ inMemory: true });
    await instance.initialize();
    const first = event({
      id: "query-first",
      sequence: 2,
      timestamp: "2026-01-01T00:00:02.000Z",
      kind: "tool.call.started",
      source: "source-a",
      status: "started",
      traceId: "trace-query",
      sessionId: "session:aaaaaaaaaaaaaaaaaaaaaaaa",
      workspaceId: "workspace-a",
      providerId: "provider-a",
      agentName: "AgentA",
      toolName: "ToolA",
    });
    const second = event({
      id: "query-second",
      sequence: 1,
      timestamp: "2026-01-01T00:00:03.000Z",
      kind: "tool.call.completed",
      source: "source-b",
      status: "success",
      traceId: "trace-other",
      sessionId: "session:bbbbbbbbbbbbbbbbbbbbbbbb",
      workspaceId: "workspace-b",
      providerId: "provider-b",
      agentName: "AgentB",
      toolName: "ToolB",
    });
    const third = event({
      id: "query-third",
      sequence: 1,
      timestamp: "2026-01-01T00:00:01.000Z",
      kind: "tool.call.failed",
      source: "source-c",
      status: "error",
      traceId: "trace-query",
      sessionId: "session:cccccccccccccccccccccccc",
      workspaceId: "workspace-c",
      providerId: "provider-c",
      agentName: "AgentC",
      toolName: "ToolC",
    });
    await instance.append(first);
    await instance.append(second);
    await instance.append(third);

    expect(await instance.query()).toEqual([third, first, second]);
    expect(await instance.query({ order: "desc" })).toEqual([
      second,
      first,
      third,
    ]);
    expect(await instance.query({ traceId: "trace-query" })).toEqual([
      third,
      first,
    ]);
    expect(
      await instance.query({ traceId: "trace-query", order: "desc" }),
    ).toEqual([first, third]);
    const filters: Array<[FlightEventQuery, FlightEvent]> = [
      [{ traceId: "trace-query", limit: 1, offset: 1 }, first],
      [{ limit: 1, offset: 1 }, first],
      [{ sessionId: "session:bbbbbbbbbbbbbbbbbbbbbbbb" }, second],
      [{ workspaceId: "workspace-c" }, third],
      [{ kind: "tool.call.started" }, first],
      [{ kind: ["tool.call.completed", "tool.call.failed"], limit: 1 }, third],
      [{ source: "source-a" }, first],
      [{ providerId: "provider-b" }, second],
      [{ agentName: "AgentC" }, third],
      [{ toolName: "ToolA" }, first],
      [{ status: "error" }, third],
      [
        {
          since: "2026-01-01T00:00:02.000Z",
          until: "2026-01-01T00:00:02.000Z",
        },
        first,
      ],
    ];
    for (const [query, expected] of filters) {
      expect(await instance.query(query)).toEqual([expected]);
    }

    expect(await instance.query({ kind: [] })).toEqual([]);
    expect(await instance.query({ limit: 0 })).toEqual([]);
    expect(await instance.query({ limit: 50_000 })).toHaveLength(3);
    expect(await instance.query({ offset: 50_000_000 })).toEqual([]);
    await expect(instance.query({ limit: -1 })).rejects.toThrow(/limit/i);
    await expect(instance.query({ offset: 1.5 })).rejects.toThrow(/offset/i);
    await expect(
      instance.query({ order: "sideways" as "asc" }),
    ).rejects.toThrow(/order/i);
  });

  it("orders and filters offset timestamps by their UTC instant", async () => {
    const instance = ledger({ inMemory: true });
    await instance.initialize();
    const olderOffset = event({
      id: "offset-older",
      traceId: "offset-trace",
      sequence: 1,
      timestamp: "2026-01-01T00:30:00+01:00",
    });
    const newerUtc = event({
      id: "utc-newer",
      traceId: "utc-trace",
      sequence: 1,
      timestamp: "2025-12-31T23:45:00Z",
    });
    await instance.append(newerUtc);
    await instance.append(olderOffset);

    expect(await instance.query()).toEqual([olderOffset, newerUtc]);
    expect(await instance.query({ order: "desc" })).toEqual([
      newerUtc,
      olderOffset,
    ]);
    expect(await instance.query({ since: "2025-12-31T23:40:00Z" })).toEqual([
      newerUtc,
    ]);
    expect(await instance.query({ until: "2025-12-31T23:40:00Z" })).toEqual([
      olderOffset,
    ]);
    await expect(instance.query({ since: "not-an-iso-date" })).rejects.toThrow(
      /ISO timestamp/i,
    );
    await expect(
      instance.query({ until: "2026-99-99T00:00:00Z" }),
    ).rejects.toThrow(/ISO timestamp/i);
    expect(await instance.prune(1)).toBe(1);
    expect(await instance.query()).toEqual([newerUtc]);
  });

  it("returns the newest cross-trace events instead of old sequence-one starts", async () => {
    const instance = ledger({ inMemory: true });
    await instance.initialize();
    for (let trace = 0; trace < 20; trace += 1) {
      await instance.append(
        event({
          id: `chronology-${trace}`,
          traceId: `trace-${trace}`,
          sequence: trace === 0 ? 100 : 1,
          timestamp: `2026-01-01T00:00:${String(trace).padStart(2, "0")}.000Z`,
        }),
      );
    }

    const newest = await instance.query({ order: "desc", limit: 5 });
    expect(newest.map((entry) => entry.id)).toEqual([
      "chronology-19",
      "chronology-18",
      "chronology-17",
      "chronology-16",
      "chronology-15",
    ]);
  });

  it("parameterizes caller values instead of interpolating SQL", async () => {
    const instance = ledger({ inMemory: true });
    await instance.initialize();
    const sample = event({ source: "safe-source" });
    await instance.append(sample);

    expect(await instance.query({ source: "' OR 1=1 --" })).toEqual([]);
    expect(await instance.query({ kind: ["x') OR 1=1 --"] })).toEqual([]);
    expect(await instance.count()).toBe(1);
  });

  it("creates an isolated WAL-backed durable schema with configured pragmas and indexes", async () => {
    const path = databasePath("schema");
    const instance = ledger({ databasePath: path });
    await instance.initialize();
    await instance.append(event());

    const configured = (instance as unknown as { db: RawDatabase }).db;
    expect(configured.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(configured.pragma("busy_timeout", { simple: true })).toBe(5_000);
    expect(configured.pragma("secure_delete", { simple: true })).toBe(1);
    expect(configured.pragma("synchronous", { simple: true })).toBe(2);

    const raw = await rawDatabase(path);
    try {
      expect(raw.pragma("journal_mode", { simple: true })).toBe("wal");
      const tables = raw
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
        )
        .all() as Array<{ name: string }>;
      expect(tables.map((row) => row.name)).toEqual([
        "flight_events",
        "flight_metadata",
        "flight_pending_owner_release",
      ]);
      const columns = raw
        .prepare("PRAGMA table_info(flight_events)")
        .all() as Array<{ name: string; notnull: number }>;
      expect(columns).toContainEqual(
        expect.objectContaining({ name: "timestamp_ms", notnull: 1 }),
      );
      const indexes = raw
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'flight_events'",
        )
        .all() as Array<{ name: string }>;
      expect(indexes.length).toBeGreaterThanOrEqual(10);
      expect(indexes.map((row) => row.name)).toEqual(
        expect.arrayContaining([
          "idx_flight_events_sequence_timestamp_ms",
          "idx_flight_events_timestamp_ms",
        ]),
      );
    } finally {
      raw.close();
    }
  });

  it("bounds runtime append contention and restores the admin timeout", async () => {
    const path = databasePath("runtime-busy");
    const instance = ledger({ databasePath: path });
    await instance.initialize();
    const locker = await rawDatabase(path);
    try {
      locker.exec("BEGIN IMMEDIATE");
      const started = performance.now();
      await expect(
        instance.append(event({ traceId: "runtime-busy" })),
      ).rejects.toMatchObject({ code: expect.stringMatching(/^SQLITE_BUSY/) });
      expect(performance.now() - started).toBeLessThan(1_000);
      const configured = (instance as unknown as { db: RawDatabase }).db;
      expect(configured.pragma("busy_timeout", { simple: true })).toBe(5_000);
    } finally {
      locker.exec("ROLLBACK");
      locker.close();
    }
  });

  it("bounds runtime ownership cleanup and automatic pruning contention", async () => {
    const path = databasePath("runtime-maintenance-busy");
    const instance = ledger({ databasePath: path });
    await instance.initialize();
    const start = event({
      traceId: "runtime-maintenance",
      sequence: 1,
      kind: "trace.started",
      status: "started",
      parentId: null,
      metadata: { ownerPid: process.pid },
    });
    await instance.append(start);
    await instance.append(
      event({
        id: "runtime-prune-candidate",
        traceId: "runtime-prune-candidate",
        sequence: 1,
        kind: "agent.execute.completed",
        parentId: null,
      }),
    );
    const locker = await rawDatabase(path);
    try {
      locker.exec("BEGIN IMMEDIATE");
      let started = performance.now();
      await expect(
        instance.releaseEventOwnership(start.id),
      ).rejects.toMatchObject({ code: expect.stringMatching(/^SQLITE_BUSY/) });
      expect(performance.now() - started).toBeLessThan(1_000);

      started = performance.now();
      await expect(instance.pruneRuntime(0)).rejects.toMatchObject({
        code: expect.stringMatching(/^SQLITE_BUSY/),
      });
      expect(performance.now() - started).toBeLessThan(1_000);
      const configured = (instance as unknown as { db: RawDatabase }).db;
      expect(configured.pragma("busy_timeout", { simple: true })).toBe(5_000);
    } finally {
      locker.exec("ROLLBACK");
      locker.close();
    }
  });

  it("never heals a corrupt row while releasing ownership", async () => {
    const instance = ledger({ inMemory: true });
    await instance.initialize();
    const start = event({
      id: "corrupt-ownership",
      traceId: "corrupt-ownership",
      sequence: 1,
      kind: "trace.started",
      status: "started",
      parentId: null,
      metadata: { ownerPid: process.pid },
    });
    await instance.append(start);
    const configured = (instance as unknown as { db: RawDatabase }).db;
    const row = configured
      .prepare("SELECT event_json FROM flight_events WHERE id = ?")
      .get(start.id) as { event_json: string };
    const tampered = JSON.parse(row.event_json) as FlightEvent;
    tampered.metadata.tampered = true;
    configured
      .prepare("UPDATE flight_events SET event_json = ? WHERE id = ?")
      .run(JSON.stringify(tampered), start.id);

    await expect(
      instance.releaseEventOwnership(start.id),
    ).rejects.toThrow(/integrity/i);
    await expect(instance.query()).rejects.toThrow(/integrity/i);
  });

  it("physically purges private payload bytes on clear", async () => {
    const path = databasePath("secure-clear");
    const instance = ledger({ databasePath: path });
    await instance.initialize();
    const sentinel = "PRIVATE_PAYLOAD_SENTINEL_7421";
    await instance.append(
      event({
        id: "secure-clear-event",
        payload: { value: sentinel },
      }),
    );

    await instance.clear();
    await instance.close();
    const bytes = [path, `${path}-wal`, `${path}-shm`]
      .filter(existsSync)
      .map((file) => readFileSync(file))
      .reduce((combined, current) => Buffer.concat([combined, current]));
    expect(bytes.includes(Buffer.from(sentinel))).toBe(false);
  });

  it("physically purges superseded payload bytes after replace import", async () => {
    const path = databasePath("secure-replace");
    const instance = ledger({ databasePath: path });
    await instance.initialize();
    const sentinel = "REPLACED_PRIVATE_SENTINEL_7421";
    const original = event({
      id: "secure-replace-event",
      payload: { value: sentinel },
    });
    const replacement = event({
      id: original.id,
      sequence: original.sequence,
      traceId: original.traceId,
      payload: { value: "removed" },
    });
    await instance.append(original);
    await instance.import(
      {
        schema: "openrappter-flight-export/1.0",
        exportedAt: "2026-01-01T00:00:00.000Z",
        events: [replacement],
      },
      { replace: true },
    );
    await instance.close();

    const bytes = [path, `${path}-wal`, `${path}-shm`]
      .filter(existsSync)
      .map((file) => readFileSync(file))
      .reduce((combined, current) => Buffer.concat([combined, current]));
    expect(bytes.includes(Buffer.from(sentinel))).toBe(false);
  });

  it("migrates and backfills legacy rows without timestamp_ms", async () => {
    const path = databasePath("timestamp-migration");
    const olderOffset = event({
      id: "legacy-offset-older",
      traceId: "legacy-offset-trace",
      sequence: 1,
      timestamp: "2026-01-01T00:30:00+01:00",
    });
    const newerUtc = event({
      id: "legacy-utc-newer",
      traceId: "legacy-utc-trace",
      sequence: 1,
      timestamp: "2025-12-31T23:45:00Z",
    });
    const raw = await rawDatabase(path);
    createLegacyFlightTable(raw);
    insertLegacyEvent(raw, newerUtc);
    insertLegacyEvent(raw, olderOffset);
    raw.close();

    const instance = ledger({ databasePath: path });
    await instance.initialize();
    expect(await instance.query()).toEqual([olderOffset, newerUtc]);

    const inspected = await rawDatabase(path);
    try {
      const columns = inspected
        .prepare("PRAGMA table_info(flight_events)")
        .all() as Array<{ name: string; notnull: number }>;
      expect(columns).toContainEqual(
        expect.objectContaining({ name: "timestamp_ms", notnull: 1 }),
      );
      const rows = inspected
        .prepare(
          "SELECT id, timestamp_ms FROM flight_events ORDER BY timestamp_ms",
        )
        .all() as Array<{ id: string; timestamp_ms: number }>;
      expect(rows).toEqual([
        { id: olderOffset.id, timestamp_ms: Date.parse(olderOffset.timestamp) },
        { id: newerUtc.id, timestamp_ms: Date.parse(newerUtc.timestamp) },
      ]);
    } finally {
      inspected.close();
    }
  });

  it("rolls back timestamp_ms migration when a legacy row is invalid", async () => {
    const path = databasePath("timestamp-migration-invalid");
    const valid = event({
      id: "legacy-valid",
      traceId: "legacy-valid-trace",
      sequence: 1,
    });
    const invalid = event({
      id: "legacy-invalid",
      traceId: "legacy-invalid-trace",
      sequence: 1,
    });
    const raw = await rawDatabase(path);
    createLegacyFlightTable(raw);
    insertLegacyEvent(raw, valid);
    insertLegacyEvent(raw, invalid, "{");
    raw.close();

    const instance = ledger({ databasePath: path });
    await expect(instance.initialize()).rejects.toThrow(
      /timestamp_ms migration failed.*valid JSON/i,
    );

    const inspected = await rawDatabase(path);
    try {
      const columns = inspected
        .prepare("PRAGMA table_info(flight_events)")
        .all() as Array<{ name: string }>;
      expect(columns.some((column) => column.name === "timestamp_ms")).toBe(
        false,
      );
      expect(
        (
          inspected
            .prepare("SELECT COUNT(*) AS count FROM flight_events")
            .get() as { count: number }
        ).count,
      ).toBe(2);
    } finally {
      inspected.close();
    }
  });

  it("counts and clears events", async () => {
    const instance = ledger({ inMemory: true });
    await instance.initialize();
    await instance.append(event());
    await instance.append(event());
    expect(await instance.count()).toBe(2);
    await instance.clear();
    expect(await instance.count()).toBe(0);
    expect(await instance.query()).toEqual([]);
  });

  it("treats retention as a target and keeps an oversized completed trace whole", async () => {
    const instance = ledger({ inMemory: true });
    await instance.initialize();
    const completed = recordedTrace({
      traceId: "oversized-completed-trace",
      prefix: "oversized",
      startedAt: "2026-01-01T00:00:00.000Z",
      middleKinds: [
        "context.assembled",
        "provider.attempt.completed",
        "agent.execute.completed",
      ],
    });
    for (const sample of completed) {
      await instance.append(sample);
    }

    expect(await instance.prune(3)).toBe(0);
    expect(
      await instance.query({ traceId: "oversized-completed-trace" }),
    ).toEqual(completed);
  });

  it("prunes an older completed trace as a whole", async () => {
    const instance = ledger({ inMemory: true });
    await instance.initialize();
    const older = recordedTrace({
      traceId: "older-completed-trace",
      prefix: "older-completed",
      startedAt: "2026-01-01T00:00:00.000Z",
      middleKinds: ["context.assembled"],
    });
    const newer = recordedTrace({
      traceId: "newer-completed-trace",
      prefix: "newer-completed",
      startedAt: "2026-02-01T00:00:00.000Z",
      middleKinds: ["context.assembled"],
    });
    for (const sample of [...older, ...newer]) {
      await instance.append(sample);
    }

    expect(await instance.prune(newer.length)).toBe(older.length);
    expect(await instance.query()).toEqual(newer);
    expect(await instance.query({ traceId: "older-completed-trace" })).toEqual(
      [],
    );
  });

  it("always preserves active traces while pruning older completed traces", async () => {
    const instance = ledger({ inMemory: true });
    await instance.initialize();
    const completed = recordedTrace({
      traceId: "old-completed-trace",
      prefix: "old-completed",
      startedAt: "2026-01-01T00:00:00.000Z",
      middleKinds: ["context.assembled"],
    });
    const active = recordedTrace({
      traceId: "active-trace",
      prefix: "active",
      startedAt: "2026-08-11T18:00:00.000Z",
      middleKinds: ["context.assembled", "provider.attempt.started"],
      terminal: null,
    });
    for (const sample of [...completed, ...active]) {
      await instance.append(sample);
    }

    expect(await instance.prune(1)).toBe(0);
    expect(await instance.query({ traceId: "active-trace" })).toEqual(active);
    expect(await instance.query({ traceId: "old-completed-trace" })).toEqual(
      completed,
    );
    expect(await instance.count()).toBe(active.length + completed.length);
  });

  it("preserves the newest completed trace alongside active traces", async () => {
    const instance = ledger({ inMemory: true });
    await instance.initialize();
    const active = recordedTrace({
      traceId: "active-pinned",
      prefix: "active-pinned",
      startedAt: "2026-01-01T00:00:00.000Z",
      middleKinds: ["context.assembled"],
      terminal: null,
    });
    const completed = recordedTrace({
      traceId: "completed-pinned",
      prefix: "completed-pinned",
      startedAt: "2026-02-01T00:00:00.000Z",
    });
    for (const sample of [...active, ...completed]) {
      await instance.append(sample);
    }

    expect(await instance.prune(3)).toBe(0);
    expect(await instance.query({ traceId: "active-pinned" })).toEqual(active);
    expect(await instance.query({ traceId: "completed-pinned" })).toEqual(
      completed,
    );
  });

  it("treats a resumed completed trace as active when its latest lifecycle is started", async () => {
    const instance = ledger({ inMemory: true });
    await instance.initialize();
    const older = recordedTrace({
      traceId: "older-finished",
      prefix: "older-finished",
      startedAt: "2026-01-01T00:00:00.000Z",
      middleKinds: [],
    });
    const firstRun = recordedTrace({
      traceId: "resumed-trace",
      prefix: "resumed-first",
      startedAt: "2026-02-01T00:00:00.000Z",
      middleKinds: [],
    });
    const resumed = recordedTrace({
      traceId: "resumed-trace",
      prefix: "resumed-second",
      startedAt: "2026-03-01T00:00:00.000Z",
      middleKinds: ["context.assembled"],
      terminal: null,
      sequenceStart: firstRun.length + 1,
    });
    for (const sample of [...older, ...firstRun, ...resumed]) {
      await instance.append(sample);
    }

    expect(await instance.prune(1)).toBe(0);
    expect(await instance.query({ traceId: "resumed-trace" })).toEqual([
      ...firstRun,
      ...resumed,
    ]);
    expect(await instance.query({ traceId: "older-finished" })).toEqual(older);
  });

  it("uses sequence-ordered lifecycle depth for nested and clock-rolled-back traces", async () => {
    const instance = ledger({ inMemory: true });
    await instance.initialize();
    const completed = recordedTrace({
      traceId: "completed-before-nested",
      prefix: "completed-before-nested",
      startedAt: "2026-01-01T00:00:00.000Z",
    });
    const nestedActive = [
      event({
        id: "nested-outer-start",
        traceId: "nested-active",
        sequence: 1,
        kind: "trace.started",
        timestamp: "2026-06-01T00:00:00.000Z",
      }),
      event({
        id: "nested-inner-start",
        traceId: "nested-active",
        sequence: 2,
        kind: "trace.started",
        timestamp: "2026-06-01T00:00:01.000Z",
      }),
      event({
        id: "nested-inner-complete",
        traceId: "nested-active",
        sequence: 3,
        kind: "trace.completed",
        timestamp: "2026-06-01T00:00:02.000Z",
      }),
    ];
    const resumedAfterRollback = [
      event({
        id: "rollback-start-1",
        traceId: "rollback-active",
        sequence: 1,
        kind: "trace.started",
        timestamp: "2026-05-01T00:00:00.000Z",
      }),
      event({
        id: "rollback-complete",
        traceId: "rollback-active",
        sequence: 2,
        kind: "trace.completed",
        timestamp: "2026-05-01T00:00:01.000Z",
      }),
      event({
        id: "rollback-start-2",
        traceId: "rollback-active",
        sequence: 3,
        kind: "trace.started",
        timestamp: "2025-01-01T00:00:00.000Z",
      }),
    ];
    for (const sample of [
      ...completed,
      ...nestedActive,
      ...resumedAfterRollback,
    ]) {
      await instance.append(sample);
    }

    expect(await instance.prune(0)).toBe(completed.length);
    expect(await instance.query({ traceId: "nested-active" })).toEqual(
      nestedActive,
    );
    expect(await instance.query({ traceId: "rollback-active" })).toEqual(
      resumedAfterRollback,
    );
  });

  it("preserves the newest completed trace when newer atomic events consume the target", async () => {
    const instance = ledger({ inMemory: true });
    await instance.initialize();
    const completed = recordedTrace({
      traceId: "completed-trace",
      prefix: "completed",
      startedAt: "2026-01-01T00:00:00.000Z",
      middleKinds: ["context.assembled", "agent.execute.completed"],
    });
    const atomic = [
      event({
        id: "atomic-1",
        traceId: "atomic-trace",
        sequence: 1,
        timestamp: "2026-01-01T00:00:10.000Z",
      }),
      event({
        id: "atomic-2",
        traceId: "atomic-trace",
        sequence: 2,
        timestamp: "2026-01-01T00:00:11.000Z",
      }),
      event({
        id: "atomic-3",
        traceId: "atomic-trace",
        sequence: 3,
        timestamp: "2026-01-01T00:00:12.000Z",
      }),
    ];
    for (const sample of [...completed, ...atomic]) {
      await instance.append(sample);
    }

    expect(await instance.prune(5)).toBe(atomic.length);
    expect(await instance.query({ traceId: "completed-trace" })).toEqual(
      completed,
    );
    expect(await instance.query({ traceId: "atomic-trace" })).toEqual([]);
  });

  it("prunes to the newest complete events and validates keep", async () => {
    const instance = ledger({ inMemory: true });
    await instance.initialize();
    const oldest = event({
      id: "prune-oldest",
      sequence: 1,
      timestamp: "2026-01-01T00:00:01.000Z",
    });
    const middle = event({
      id: "prune-middle",
      sequence: 2,
      timestamp: "2026-01-01T00:00:02.000Z",
    });
    const newest = event({
      id: "prune-newest",
      sequence: 3,
      timestamp: "2026-01-01T00:00:03.000Z",
    });
    await instance.append(oldest);
    await instance.append(middle);
    await instance.append(newest);

    await expect(instance.prune(-1)).rejects.toThrow(/keep/i);
    await expect(instance.prune(1.2)).rejects.toThrow(/keep/i);
    expect(await instance.prune(2)).toBe(1);
    expect(await instance.query()).toEqual([middle, newest]);
    expect(await instance.prune(2)).toBe(0);
    expect(await instance.prune(0)).toBe(2);
    expect(await instance.count()).toBe(0);
  });

  it("prunes globally by timestamp rather than per-trace sequence", async () => {
    const instance = ledger({ inMemory: true });
    await instance.initialize();
    const oldHighSequence = event({
      id: "old-high-sequence",
      traceId: "old-trace",
      sequence: 100,
      timestamp: "2026-01-01T00:00:00.000Z",
    });
    const newLowSequence = event({
      id: "new-low-sequence",
      traceId: "new-trace",
      sequence: 1,
      timestamp: "2026-08-11T18:00:00.000Z",
    });
    await instance.append(oldHighSequence);
    await instance.append(newLowSequence);

    expect(await instance.prune(1)).toBe(1);
    expect(await instance.query()).toEqual([newLowSequence]);
  });

  it("uses insertion order as the deterministic prune tiebreak", async () => {
    const instance = ledger({ inMemory: true });
    await instance.initialize();
    const timestamp = "2026-08-11T18:00:00.000Z";
    const first = event({
      id: "timestamp-tie-first",
      traceId: "timestamp-tie-a",
      sequence: 100,
      timestamp,
    });
    const second = event({
      id: "timestamp-tie-second",
      traceId: "timestamp-tie-b",
      sequence: 1,
      timestamp,
    });
    await instance.append(first);
    await instance.append(second);

    expect(await instance.prune(1)).toBe(1);
    expect(await instance.query()).toEqual([second]);
  });

  it("exports the exact versioned envelope and honors export filters", async () => {
    const instance = ledger({ inMemory: true });
    await instance.initialize();
    const included = event({ traceId: "export-me" });
    await instance.append(included);
    await instance.append(event({ traceId: "skip-me" }));

    const exported = await instance.export({ traceId: "export-me" });
    expect(Object.keys(exported)).toEqual(["schema", "exportedAt", "events"]);
    expect(exported.schema).toBe("openrappter-flight-export/1.0");
    expect(Number.isNaN(Date.parse(exported.exportedAt))).toBe(false);
    expect(exported.events).toEqual([included]);
  });

  it("exports complete snapshots beyond the public 10,000-row query cap", async () => {
    const instance = ledger({ inMemory: true });
    await instance.initialize();
    const events = Array.from({ length: 10_001 }, (_, index) =>
      event({
        id: `uncapped-export-${index}`,
        traceId: `uncapped-trace-${index}`,
        sequence: 1,
        timestamp: "2026-01-01T00:00:00.000Z",
      }),
    );
    await instance.import({
      schema: "openrappter-flight-export/1.0",
      exportedAt: "2026-01-01T00:00:00.000Z",
      events,
    });

    expect(await instance.query()).toHaveLength(10_000);
    expect((await instance.export()).events).toHaveLength(10_001);
  });

  it("round-trips exports exactly and includes a non-vacuous trace mutation check", async () => {
    const source = ledger({ inMemory: true });
    const target = ledger({ inMemory: true });
    await source.initialize();
    await target.initialize();
    const events = [
      event({ id: "roundtrip-a", sequence: 1, traceId: "trace-roundtrip-a" }),
      event({ id: "roundtrip-b", sequence: 2, traceId: "trace-roundtrip-b" }),
    ];
    for (const sample of events) {
      await source.append(sample);
    }

    const exported = await source.export();
    expect(await target.import(exported)).toBe(2);
    const reexported = await target.export();
    expect(reexported.events).toEqual(exported.events);
    expect(await target.query()).toEqual(events);

    const mutated = structuredClone(exported.events);
    mutated[0].traceId = "intentionally-mutated-trace";
    expect(mutated).not.toEqual(reexported.events);
  });

  it("accepts exact duplicate IDs and requires replace for different content", async () => {
    const instance = ledger({ inMemory: true });
    await instance.initialize();
    const original = event({
      id: "replace-id",
      sequence: 1,
      traceId: "original-trace",
    });
    const replacement = event({
      id: "replace-id",
      sequence: 99,
      traceId: "replacement-trace",
    });
    const originalExport: FlightExport = {
      schema: "openrappter-flight-export/1.0",
      exportedAt: new Date().toISOString(),
      events: [original],
    };
    const replacementExport: FlightExport = {
      ...originalExport,
      events: [replacement],
    };

    expect(await instance.import(originalExport)).toBe(1);
    expect(await instance.import(originalExport)).toBe(0);
    await expect(instance.import(replacementExport)).rejects.toThrow(
      /conflicts with existing content/i,
    );
    expect(await instance.query()).toEqual([original]);
    expect(await instance.import(replacementExport, { replace: true })).toBe(1);
    expect(await instance.query()).toEqual([replacement]);
  });

  it("stages multi-row replacements before inserting swapped sequences", async () => {
    const instance = ledger({ inMemory: true });
    await instance.initialize();
    const first = event({
      id: "swap-a",
      traceId: "swap-trace",
      sequence: 1,
    });
    const second = event({
      id: "swap-b",
      traceId: "swap-trace",
      sequence: 2,
    });
    await instance.append(first);
    await instance.append(second);
    const swappedA = event({
      id: first.id,
      traceId: first.traceId,
      sequence: 2,
    });
    const swappedB = event({
      id: second.id,
      traceId: second.traceId,
      sequence: 1,
    });

    expect(
      await instance.import(
        {
          schema: "openrappter-flight-export/1.0",
          exportedAt: "2026-01-01T00:00:00.000Z",
          events: [swappedA, swappedB],
        },
        { replace: true },
      ),
    ).toBe(2);
    expect(
      (await instance.query({ traceId: "swap-trace" })).map(
        (event) => [event.id, event.sequence],
      ),
    ).toEqual([
      ["swap-b", 1],
      ["swap-a", 2],
    ]);
  });

  it("rejects a hash-stale trace mutation without partially importing", async () => {
    const instance = ledger({ inMemory: true });
    await instance.initialize();
    const baseline = event({ id: "integrity-baseline" });
    await instance.append(baseline);
    const valid = event({ id: "integrity-valid" });
    const tampered = {
      ...event({ id: "integrity-tampered" }),
      traceId: "mutated-after-hashing",
    };
    const imported: FlightExport = {
      schema: "openrappter-flight-export/1.0",
      exportedAt: new Date().toISOString(),
      events: [valid, tampered],
    };

    await expect(instance.import(imported)).rejects.toThrow(/integrity/i);
    expect(await instance.query()).toEqual([baseline]);
  });

  it("rejects malformed event timestamps even when their hash matches", async () => {
    const instance = ledger({ inMemory: true });
    await instance.initialize();
    const malformedTimestamp = event({
      id: "malformed-timestamp",
      timestamp: "not-an-iso-date",
    });
    const imported: FlightExport = {
      schema: "openrappter-flight-export/1.0",
      exportedAt: new Date().toISOString(),
      events: [malformedTimestamp],
    };

    await expect(instance.import(imported)).rejects.toThrow(/ISO timestamp/i);
    expect(await instance.count()).toBe(0);
  });

  it("rejects lone surrogates in every top-level event string", async () => {
    const instance = ledger({ inMemory: true });
    await instance.initialize();
    const invalid = event({ source: "\ud800" });

    await expect(instance.append(invalid)).rejects.toThrow(/Unicode scalar/i);
    expect(await instance.count()).toBe(0);
  });

  it("rejects impossible dates and invalid offsets while accepting strict ISO controls", async () => {
    const invalidTimestamps = [
      "2026-02-29T00:00:00.000Z",
      "2026-02-30T00:00:00.000Z",
      "2026-04-31T00:00:00.000Z",
      "2026-06-15T24:00:00.000Z",
      "2026-06-15T12:00:00.1234Z",
      "2026-06-15T12:00:00+00:60",
      "2026-06-15T12:00:00+14:01",
    ];
    for (const [index, timestamp] of invalidTimestamps.entries()) {
      const instance = ledger({ inMemory: true });
      await instance.initialize();
      const invalid = event({ id: `invalid-date-${index}`, timestamp });
      await expect(instance.append(invalid)).rejects.toThrow(/ISO timestamp/i);
      await instance.close();
    }

    const instance = ledger({ inMemory: true });
    await instance.initialize();
    await expect(
      instance.import({
        schema: "openrappter-flight-export/1.0",
        exportedAt: "2026-02-30T00:00:00.000Z",
        events: [],
      }),
    ).rejects.toThrow(/ISO timestamp/i);
    await expect(
      instance.query({ since: "2026-04-31T00:00:00.000Z" }),
    ).rejects.toThrow(/ISO timestamp/i);
    const valid = [
      event({
        id: "valid-leap-day",
        sequence: 1,
        timestamp: "2024-02-29T23:59:59.999Z",
      }),
      event({
        id: "valid-offset",
        sequence: 2,
        timestamp: "2026-06-15T12:00:00.123-05:30",
      }),
      event({
        id: "valid-maximum-offset",
        sequence: 3,
        timestamp: "2026-06-15T12:00:00+14:00",
      }),
    ];
    for (const sample of valid) {
      await instance.append(sample);
    }
    expect(await instance.count()).toBe(3);
  });

  it("parses one-to-three fractional digits exactly without Date.parse normalization", async () => {
    const instance = ledger({ inMemory: true });
    await instance.initialize();
    const samples = [
      ["fraction-1", "1970-01-01T00:00:00.1Z", 100],
      ["fraction-2", "1970-01-01T00:00:00.12Z", 120],
      ["fraction-3", "1970-01-01T00:00:00.123Z", 123],
      ["pre-epoch", "1969-12-31T23:59:59.999Z", -1],
    ] as const;
    for (const [id, timestamp] of samples) {
      await instance.append(event({ id, timestamp }));
    }

    const configured = (instance as unknown as { db: RawDatabase }).db;
    const stored = configured
      .prepare(
        `SELECT id, timestamp_ms FROM flight_events
         WHERE id IN (${samples.map(() => "?").join(", ")})`,
      )
      .all(...samples.map(([id]) => id)) as Array<{
      id: string;
      timestamp_ms: number;
    }>;
    expect(Object.fromEntries(stored.map((row) => [row.id, row.timestamp_ms])))
      .toEqual(Object.fromEntries(samples.map(([id, , ms]) => [id, ms])));
  });

  it("rejects unsafe integer payloads that cannot hash consistently across runtimes", async () => {
    const instance = ledger({ inMemory: true });
    await instance.initialize();
    const unsafe = event({ payload: { value: Number.MAX_SAFE_INTEGER + 1 } });
    unsafe.contentHash = computeFlightEventHash(unsafe);
    const imported: FlightExport = {
      schema: "openrappter-flight-export/1.0",
      exportedAt: new Date().toISOString(),
      events: [unsafe],
    };

    await expect(instance.import(imported)).rejects.toThrow(/JSON-compatible/);
    expect(await instance.count()).toBe(0);
  });

  it("rejects hash-valid imports that violate persisted privacy invariants", async () => {
    const instance = ledger({ inMemory: true });
    await instance.initialize();
    const unsafeCases = [
      event({ sessionId: "alice@example.com" }),
      event({ workspaceId: "/Users/alice/private" }),
      event({ workspaceId: "file:///Users/alice/private" }),
      event({ workspaceId: "workspace:/Users/alice/private" }),
      event({ workspaceId: String.raw`workspace:C:\Users\alice\private` }),
      event({ metadata: { authorization: "raw-secret" } }),
      event({ payload: { token: "raw-token" } }),
      event({
        kind: "trace.started",
        status: "started",
        metadata: { ownerPid: process.pid },
      }),
    ];
    for (const unsafe of unsafeCases) {
      unsafe.contentHash = computeFlightEventHash(unsafe);
      await expect(
        instance.import({
          schema: "openrappter-flight-export/1.0",
          exportedAt: "2026-01-01T00:00:00.000Z",
          events: [unsafe],
        }),
      ).rejects.toThrow(/privacy|opaque session|raw path|live trace ownership/i);
    }
    expect(await instance.count()).toBe(0);
  });

  it("rejects secret-shaped top-level envelope fields", async () => {
    const instance = ledger({ inMemory: true });
    await instance.initialize();
    const token = `ghp_${"x".repeat(32)}`;
    const invalid = event({ providerId: token });
    invalid.contentHash = computeFlightEventHash(invalid);

    await expect(
      instance.import({
        schema: "openrappter-flight-export/1.0",
        exportedAt: "2026-01-01T00:00:00.000Z",
        events: [invalid],
      }),
    ).rejects.toThrow(/providerId.*privacy/i);

    const secretId = event({ id: token });
    secretId.contentHash = computeFlightEventHash(secretId);
    await expect(
      instance.import({
        schema: "openrappter-flight-export/1.0",
        exportedAt: "2026-01-01T00:00:00.000Z",
        events: [secretId],
      }),
    ).rejects.toThrow(/id.*privacy/i);
  });

  it("rejects conflicting duplicate IDs unless replace is explicit", async () => {
    const instance = ledger({ inMemory: true });
    await instance.initialize();
    const original = event({
      id: "duplicate-id",
      traceId: "duplicate-original",
    });
    const conflicting = event({
      id: "duplicate-id",
      traceId: "duplicate-conflict",
    });
    await instance.append(original);

    await expect(
      instance.import({
        schema: "openrappter-flight-export/1.0",
        exportedAt: "2026-01-01T00:00:00.000Z",
        events: [conflicting],
      }),
    ).rejects.toThrow(/conflicts with existing content/i);
  });

  it("validates every existing row before importing anything", async () => {
    const instance = ledger({ inMemory: true });
    await instance.initialize();
    await instance.append(event({ id: "existing-corrupt" }));
    const configured = (instance as unknown as { db: RawDatabase }).db;
    configured
      .prepare("UPDATE flight_events SET event_json = ? WHERE id = ?")
      .run("{bad", "existing-corrupt");
    const incoming = event({ id: "unrelated-import" });

    await expect(
      instance.import({
        schema: "openrappter-flight-export/1.0",
        exportedAt: "2026-01-01T00:00:00.000Z",
        events: [incoming],
      }),
    ).rejects.toThrow(/not valid JSON/i);
    expect(await instance.count()).toBe(1);
  });

  it("validates every snapshot row before applying inspection filters", async () => {
    const instance = ledger({ inMemory: true });
    await instance.initialize();
    const trace = recordedTrace({
      traceId: "filtered-corruption",
      prefix: "filtered-corruption",
      startedAt: "2026-01-01T00:00:00.000Z",
      middleKinds: ["context.assembled"],
    });
    for (const entry of trace) await instance.append(entry);
    const configured = (instance as unknown as { db: RawDatabase }).db;
    configured
      .prepare("UPDATE flight_events SET trace_id = ? WHERE id = ?")
      .run("hidden-corrupt-trace", trace[1].id);

    await expect(
      instance.query({ traceId: "filtered-corruption" }),
    ).rejects.toThrow(/traceId does not match event_json/i);
    await expect(
      instance.export({ traceId: "filtered-corruption" }),
    ).rejects.toThrow(/traceId does not match event_json/i);
  });

  it("rejects auto as imported concrete model identity", async () => {
    const instance = ledger({ inMemory: true });
    await instance.initialize();
    const invalid = event({ model: "auto" });
    invalid.contentHash = computeFlightEventHash(invalid);

    await expect(
      instance.import({
        schema: "openrappter-flight-export/1.0",
        exportedAt: "2026-01-01T00:00:00.000Z",
        events: [invalid],
      }),
    ).rejects.toThrow(/concrete normalized model/i);
  });

  it("imports the committed cross-runtime portability vector", async () => {
    const instance = ledger({ inMemory: true });
    await instance.initialize();
    const vector = JSON.parse(
      readFileSync(
        new URL(
          "../../../contracts/flight-recorder-vector.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as FlightEvent;
    const imported: FlightExport = {
      schema: "openrappter-flight-export/1.0",
      exportedAt: new Date().toISOString(),
      events: [vector],
    };

    expect(await instance.import(imported)).toBe(1);
    expect(await instance.query()).toEqual([vector]);
  });

  it("validates the envelope and every event field before changing the database", async () => {
    const instance = ledger({ inMemory: true });
    await instance.initialize();
    const baseline = event({ id: "baseline" });
    await instance.append(baseline);

    const valid = event({ id: "valid-import" });
    const invalidEvents: unknown[] = [
      { ...valid, schema: "wrong-schema" },
      { ...valid, id: 1 },
      { ...valid, sequence: -1 },
      { ...valid, sequence: 1.5 },
      { ...valid, kind: 1 },
      { ...valid, source: null },
      { ...valid, status: "unknown" },
      { ...valid, traceId: false },
      { ...valid, parentId: 1 },
      { ...valid, timestamp: 1 },
      { ...valid, metadata: [] },
      { ...valid, contentHash: null },
      { ...valid, contentHash: "A".repeat(64) },
      { ...valid, contentHash: "a".repeat(63) },
      { ...valid, sessionId: 1 },
      { ...valid, workspaceId: 1 },
      { ...valid, providerId: 1 },
      { ...valid, model: 1 },
      { ...valid, agentName: 1 },
      { ...valid, toolName: 1 },
      { ...valid, durationMs: Number.POSITIVE_INFINITY },
      { ...valid, payload: undefined },
      { ...valid, unexpected: true },
    ];

    const wrongEnvelope = {
      schema: "wrong-export",
      exportedAt: new Date().toISOString(),
      events: [],
    } as unknown as FlightExport;
    await expect(instance.import(wrongEnvelope)).rejects.toThrow(/schema/i);
    await expect(
      instance.query({
        traceId: "baseline",
        unexpected: true,
      } as FlightEventQuery & { unexpected: boolean }),
    ).rejects.toThrow(/unexpected field/i);

    for (const invalidEvent of invalidEvents) {
      const malformed = {
        schema: "openrappter-flight-export/1.0",
        exportedAt: new Date().toISOString(),
        events: [valid, invalidEvent],
      } as FlightExport;
      await expect(instance.import(malformed)).rejects.toThrow();
      expect(await instance.query()).toEqual([baseline]);
    }
  });

  it("rolls back a whole import when a later serialized event is malformed", async () => {
    const instance = ledger({ inMemory: true });
    await instance.initialize();
    const baseline = event({ id: "atomic-baseline" });
    await instance.append(baseline);
    const circular = event({ id: "circular" });
    circular.metadata.self = circular.metadata;

    const malformed: FlightExport = {
      schema: "openrappter-flight-export/1.0",
      exportedAt: new Date().toISOString(),
      events: [event({ id: "would-have-imported" }), circular],
    };
    await expect(instance.import(malformed)).rejects.toThrow(/circular/i);
    expect(await instance.query()).toEqual([baseline]);
  });

  it("preserves exact event sequence and correlation after durable reopen", async () => {
    const path = databasePath("reopen");
    const first = ledger({ databasePath: path });
    await first.initialize();
    const events = [
      event({
        id: "reopen-a",
        sequence: 42,
        traceId: "durable-trace",
        parentId: null,
        sessionId: "session:dddddddddddddddddddddddd",
      }),
      event({
        id: "reopen-b",
        sequence: 43,
        traceId: "durable-trace",
        parentId: "reopen-a",
        sessionId: "session:dddddddddddddddddddddddd",
      }),
    ];
    await first.append(events[0]);
    await first.append(events[1]);
    await first.close();

    const reopened = ledger({ databasePath: path });
    await reopened.initialize();
    expect(await reopened.query()).toEqual(events);
    expect(await reopened.query({ traceId: "durable-trace" })).toEqual(events);
  });

  it("supports two durable instances writing distinct traces without loss or cross-correlation", async () => {
    const path = databasePath("concurrent");
    const first = ledger({ databasePath: path });
    const second = ledger({ databasePath: path });
    await Promise.all([first.initialize(), second.initialize()]);
    const traceA = Array.from({ length: 40 }, (_, index) =>
      event({
        id: `concurrent-a-${index}`,
        sequence: index,
        traceId: "concurrent-trace-a",
        timestamp: new Date(Date.UTC(2026, 1, 1, 0, 0, index)).toISOString(),
      }),
    );
    const traceB = Array.from({ length: 40 }, (_, index) =>
      event({
        id: `concurrent-b-${index}`,
        sequence: index,
        traceId: "concurrent-trace-b",
        timestamp: new Date(Date.UTC(2026, 1, 2, 0, 0, index)).toISOString(),
      }),
    );

    await Promise.all(
      traceA.flatMap((sample, index) => [
        first.append(sample),
        second.append(traceB[index]),
      ]),
    );

    expect(await first.count()).toBe(80);
    expect(await second.query({ traceId: "concurrent-trace-a" })).toEqual(
      traceA,
    );
    expect(await first.query({ traceId: "concurrent-trace-b" })).toEqual(
      traceB,
    );
    expect(
      (await first.query({ traceId: "concurrent-trace-a" })).every(
        (sample) => sample.traceId === "concurrent-trace-a",
      ),
    ).toBe(true);
  });

  it("surfaces invalid stored JSON instead of returning partial results", async () => {
    const path = databasePath("bad-json");
    const instance = ledger({ databasePath: path });
    await instance.initialize();
    await instance.append(event({ id: "good-row", sequence: 1 }));
    await instance.append(event({ id: "bad-row", sequence: 2 }));

    const raw = await rawDatabase(path);
    try {
      raw
        .prepare("UPDATE flight_events SET event_json = ? WHERE id = ?")
        .run("{", "bad-row");
    } finally {
      raw.close();
    }

    await expect(instance.query()).rejects.toThrow(/corrupt.*valid JSON/i);
  });

  it("rejects stored event JSON changed without updating its hash", async () => {
    const path = databasePath("bad-row");
    const instance = ledger({ databasePath: path });
    await instance.initialize();
    const sample = event({ id: "mismatched-row", traceId: "indexed-trace" });
    await instance.append(sample);

    const raw = await rawDatabase(path);
    try {
      raw
        .prepare("UPDATE flight_events SET event_json = ? WHERE id = ?")
        .run(
          JSON.stringify({ ...sample, payload: { corrupted: true } }),
          sample.id,
        );
    } finally {
      raw.close();
    }

    await expect(instance.query()).rejects.toThrow(/integrity/i);
  });
});
