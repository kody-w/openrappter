import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  computeFlightEventHash,
  normalizeFlightSessionId,
  normalizeFlightWorkspaceId,
  verifyFlightEventHash,
} from "./integrity.js";
import {
  ensureFlightRecorderFromEnv,
  FlightRecorder,
  getFlightRecorder,
  resetFlightRecorderEnvironmentForTests,
  setFlightRecorder,
} from "./recorder.js";
import { SQLiteFlightLedger } from "./ledger.js";
import type {
  FlightEvent,
  FlightEventQuery,
  FlightExport,
  FlightLedger,
} from "./types.js";

const closeables: FlightRecorder[] = [];
const temporaryDirectories: string[] = [];
const TEST_IDENTITY_KEY = "11".repeat(32);

afterEach(async () => {
  await Promise.all(closeables.splice(0).map((recorder) => recorder.close()));
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

async function recorder(
  options: ConstructorParameters<typeof FlightRecorder>[0] = {},
) {
  const instance = new FlightRecorder({
    enabled: true,
    inMemory: true,
    identityKey: TEST_IDENTITY_KEY,
    ...options,
  });
  closeables.push(instance);
  await instance.initialize();
  return instance;
}

describe("FlightRecorder", () => {
  it("records one ordered, privacy-safe trace with valid integrity hashes", async () => {
    const instance = await recorder({
      privacy: { recordIO: true },
    });
    const githubToken = `ghp_${"a".repeat(32)}`;

    const result = await instance.runTrace(
      { traceId: "trace-one", sessionId: "session-one", workspaceId: "/repo" },
      async () => {
        await instance.record({
          kind: "context.assembled",
          source: "test",
          status: "info",
          metadata: {
            categories: ["workspace", "memory"],
            token: githubToken,
          },
          payload: {
            prompt: "ordinary prompt",
            authorization: `Bearer ${"b".repeat(32)}`,
          },
        });
        return "unchanged result";
      },
    );

    expect(result).toBe("unchanged result");
    const exported = await instance.exportTrace("trace-one");
    expect(exported?.events.map((event) => event.kind)).toEqual([
      "trace.started",
      "context.assembled",
      "trace.completed",
    ]);
    expect(exported?.events.map((event) => event.sequence)).toEqual([1, 2, 3]);
    for (const event of exported?.events ?? []) {
      expect(event.traceId).toBe("trace-one");
      expect(event.sessionId).toBe(
        normalizeFlightSessionId("session-one", TEST_IDENTITY_KEY),
      );
      expect(event.workspaceId).toBe(normalizeFlightWorkspaceId("/repo"));
      expect(verifyFlightEventHash(event)).toBe(true);
    }
    const context = exported?.events[1];
    expect(context?.metadata.token).toBe("[redacted]");
    expect(context?.payload).toEqual({
      authorization: "[redacted]",
      prompt: "ordinary prompt",
    });
    expect(JSON.stringify(exported)).not.toContain(githubToken);
    expect(JSON.stringify(exported)).not.toContain("/repo");
  });

  it("hashes counterparty session identifiers while preserving queryability", async () => {
    const instance = await recorder();
    const handle = "imessage:iMessage;-;+15551234567";

    await instance.runTrace({ traceId: "private-session", sessionId: handle }, async () => {});

    const events = await instance.query({ sessionId: handle });
    expect(events).toHaveLength(2);
    expect(
      events.every(
        (event) =>
          event.sessionId ===
          normalizeFlightSessionId(handle, TEST_IDENTITY_KEY),
      ),
    ).toBe(true);
    expect(JSON.stringify(events)).not.toContain("+15551234567");
  });

  it("drops raw IO by default while preserving sanitized metadata", async () => {
    const instance = await recorder();
    await instance.runTrace({ traceId: "no-io" }, async () => {
      await instance.record({
        kind: "agent.execute.completed",
        source: "agent",
        metadata: { apiKey: "ordinary-but-key-is-sensitive", count: 3 },
        payload: { rawPrompt: "must not persist" },
      });
    });

    const events = (await instance.exportTrace("no-io"))!.events;
    const agent = events.find(
      (event) => event.kind === "agent.execute.completed",
    )!;
    expect(Object.hasOwn(agent, "payload")).toBe(false);
    expect(agent.metadata).toEqual({ apiKey: "[redacted]", count: 3 });
    expect(JSON.stringify(events)).not.toContain("must not persist");
  });

  it("normalizes auto model identity centrally for direct recorder callers", async () => {
    const instance = await recorder();
    const event = await instance.record({
      traceId: "direct-auto",
      kind: "provider.attempt.completed",
      source: "direct-test",
      model: "  AUTO  ",
      metadata: { modelPolicy: "auto" },
    });
    expect(event?.model).toBeUndefined();
    expect(event?.metadata.modelPolicy).toBe("auto");
  });

  it("continues per-trace sequence numbers after a durable restart", async () => {
    const directory = mkdtempSync(
      path.join(os.tmpdir(), "openrappter-flight-"),
    );
    temporaryDirectories.push(directory);
    chmodSync(directory, 0o755);
    const databasePath = path.join(directory, "flight.db");

    const first = new FlightRecorder({ enabled: true, databasePath });
    await first.initialize();
    await first.runTrace(
      { traceId: "continued", sessionId: "person@example.com" },
      async () => {
      await first.record({ kind: "phase.one", source: "test" });
      },
    );

    expect(statSync(databasePath).mode & 0o777).toBe(0o600);
    expect(statSync(directory).mode & 0o777).toBe(0o755);
    expect(statSync(`${databasePath}-wal`).mode & 0o777).toBe(0o600);
    expect(statSync(`${databasePath}-shm`).mode & 0o777).toBe(0o600);
    expect(
      statSync(`${databasePath}.identity-key`).mode & 0o777,
    ).toBe(0o600);
    await first.close();
    const sidecars = [`${databasePath}-wal`, `${databasePath}-shm`];
    const sidecarInodes = new Map<string, number>();
    for (const sidecar of sidecars) {
      writeFileSync(sidecar, "", { mode: 0o666 });
      chmodSync(sidecar, 0o666);
      sidecarInodes.set(sidecar, statSync(sidecar).ino);
    }

    const second = new FlightRecorder({ enabled: true, databasePath });
    closeables.push(second);
    await second.initialize();
    for (const sidecar of sidecars) {
      expect(statSync(sidecar).ino).toBe(sidecarInodes.get(sidecar));
      expect(statSync(sidecar).mode & 0o777).toBe(0o600);
    }
    await second.runTrace(
      { traceId: "continued", sessionId: "person@example.com" },
      async () => {
      await second.record({ kind: "phase.two", source: "test" });
      },
    );

    const events = (await second.exportTrace("continued"))!.events;
    expect(events.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(events.map((event) => event.kind)).toEqual([
      "trace.started",
      "phase.one",
      "trace.completed",
      "trace.started",
      "phase.two",
      "trace.completed",
    ]);
    expect(
      await second.query({ sessionId: "person@example.com" }),
    ).toHaveLength(6);
  });

  it("rejects symlinked database and identity-key artifacts", async () => {
    if (process.platform === "win32") return;
    const directory = mkdtempSync(
      path.join(os.tmpdir(), "openrappter-flight-symlink-"),
    );
    temporaryDirectories.push(directory);
    const target = path.join(directory, "target.db");
    writeFileSync(target, "do not modify", { mode: 0o600 });
    const databasePath = path.join(directory, "flight.db");
    symlinkSync(target, databasePath);
    const linked = new FlightRecorder({ enabled: true, databasePath });
    closeables.push(linked);
    await linked.initialize();
    expect(await linked.health()).toMatchObject({ initialized: false });
    expect((await linked.health()).lastError).toMatch(/regular file/i);
    expect(readFileSync(target, "utf8")).toBe("do not modify");

    rmSync(databasePath);
    const first = new FlightRecorder({
      enabled: true,
      databasePath,
      identityKey: "ab".repeat(32),
    });
    closeables.push(first);
    await first.initialize();
    await first.close();
    const keyPath = `${databasePath}.identity-key`;
    const keyTarget = path.join(directory, "external-key");
    writeFileSync(keyTarget, `${"ab".repeat(32)}\n`, { mode: 0o600 });
    rmSync(keyPath);
    symlinkSync(keyTarget, keyPath);
    const keyLinked = new FlightRecorder({ enabled: true, databasePath });
    closeables.push(keyLinked);
    await keyLinked.initialize();
    expect(await keyLinked.health()).toMatchObject({ initialized: false });
    expect((await keyLinked.health()).lastError).toMatch(/regular file/i);

    const realParent = path.join(directory, "real-parent");
    mkdirSync(realParent);
    const parentAlias = path.join(directory, "parent-alias");
    symlinkSync(realParent, parentAlias, "dir");
    const parentLinked = new FlightRecorder({
      enabled: true,
      databasePath: path.join(parentAlias, "flight.db"),
    });
    closeables.push(parentLinked);
    await parentLinked.initialize();
    expect(await parentLinked.health()).toMatchObject({
      initialized: false,
    });
    expect((await parentLinked.health()).lastError).toMatch(
      /user-controlled symlink/i,
    );

    const ownerDatabase = path.join(directory, "owner-flight.db");
    const externalOwners = path.join(directory, "external-owners");
    mkdirSync(externalOwners);
    writeFileSync(
      path.join(externalOwners, "marker.json"),
      "do not modify",
    );
    symlinkSync(externalOwners, `${ownerDatabase}.owners`, "dir");
    const ownerLinked = new FlightRecorder({
      enabled: true,
      databasePath: ownerDatabase,
    });
    closeables.push(ownerLinked);
    await ownerLinked.initialize();
    expect(await ownerLinked.health()).toMatchObject({
      initialized: false,
    });
    expect((await ownerLinked.health()).lastError).toMatch(
      /owner storage.*regular directory/i,
    );
    expect(
      readFileSync(
        path.join(externalOwners, "marker.json"),
        "utf8",
      ),
    ).toBe("do not modify");
  });

  it("rejects group or world-writable custom storage parents", async () => {
    if (process.platform === "win32") return;
    const directory = mkdtempSync(
      path.join(os.tmpdir(), "openrappter-flight-insecure-parent-"),
    );
    temporaryDirectories.push(directory);
    chmodSync(directory, 0o777);
    const instance = new FlightRecorder({
      enabled: true,
      databasePath: path.join(directory, "flight.db"),
    });
    closeables.push(instance);

    await instance.initialize();
    expect(await instance.health()).toMatchObject({ initialized: false });
    expect((await instance.health()).lastError).toMatch(
      /group\/world writable/i,
    );
  });

  it("recovers an empty crashed identity-key publication", async () => {
    const directory = mkdtempSync(
      path.join(os.tmpdir(), "openrappter-flight-empty-key-"),
    );
    temporaryDirectories.push(directory);
    const databasePath = path.join(directory, "flight.db");
    writeFileSync(`${databasePath}.identity-key`, "", { mode: 0o600 });
    const instance = new FlightRecorder({ enabled: true, databasePath });
    closeables.push(instance);

    await instance.initialize();
    await instance.runTrace(
      { traceId: "recovered-key", sessionId: "person@example.com" },
      async () => {},
    );

    expect(
      statSync(`${databasePath}.identity-key`).size,
    ).toBeGreaterThan(0);
    expect(
      (await instance.exportTrace("recovered-key"))?.events[0].sessionId,
    ).toMatch(/^session:[0-9a-f]{24}$/);
  });

  it("persists explicit identity keys and rejects later divergence", async () => {
    const directory = mkdtempSync(
      path.join(os.tmpdir(), "openrappter-flight-explicit-key-"),
    );
    temporaryDirectories.push(directory);
    const databasePath = path.join(directory, "flight.db");
    const explicit = "ab".repeat(32);
    const first = new FlightRecorder({
      enabled: true,
      databasePath,
      identityKey: explicit,
    });
    const second = new FlightRecorder({ enabled: true, databasePath });
    const mismatch = new FlightRecorder({
      enabled: true,
      databasePath,
      identityKey: "cd".repeat(32),
    });
    closeables.push(first, second, mismatch);

    await first.initialize();
    await first.runTrace(
      { traceId: "explicit-key-first", sessionId: "same-person" },
      async () => {},
    );
    expect(
      readFileSync(`${databasePath}.identity-key`, "utf8").trim(),
    ).toBe(explicit);

    await second.initialize();
    await second.runTrace(
      { traceId: "explicit-key-second", sessionId: "same-person" },
      async () => {},
    );
    const firstSession = (
      await first.exportTrace("explicit-key-first")
    )!.events[0].sessionId;
    const secondSession = (
      await second.exportTrace("explicit-key-second")
    )!.events[0].sessionId;
    expect(secondSession).toBe(firstSession);

    await mismatch.initialize();
    expect(await mismatch.health()).toMatchObject({
      initialized: false,
    });
    expect((await mismatch.health()).lastError).toMatch(
      /does not match the persisted key/i,
    );

    await first.close();
    await second.close();
    rmSync(`${databasePath}.identity-key`, { force: true });
    const missing = new FlightRecorder({ enabled: true, databasePath });
    closeables.push(missing);
    await missing.initialize();
    expect(await missing.health()).toMatchObject({
      initialized: false,
    });
    expect((await missing.health()).lastError).toMatch(
      /missing for a non-empty ledger/i,
    );
  });

  it("binds the persisted identity key to the ledger fingerprint", async () => {
    const directory = mkdtempSync(
      path.join(os.tmpdir(), "openrappter-flight-key-binding-"),
    );
    temporaryDirectories.push(directory);
    const databasePath = path.join(directory, "flight.db");
    const first = new FlightRecorder({
      enabled: true,
      databasePath,
      identityKey: "12".repeat(32),
    });
    closeables.push(first);
    await first.initialize();
    await first.runTrace({ traceId: "bound-key" }, async () => {});
    await first.close();

    writeFileSync(
      `${databasePath}.identity-key`,
      `${"34".repeat(32)}\n`,
      { mode: 0o600 },
    );
    const second = new FlightRecorder({ enabled: true, databasePath });
    closeables.push(second);
    await second.initialize();

    expect(await second.health()).toMatchObject({ initialized: false });
    expect((await second.health()).lastError).toMatch(
      /ledger fingerprint/i,
    );
  });

  it("always redacts the active identity key and its sidecar aliases", async () => {
    const identityKey = "ef".repeat(32);
    const instance = new FlightRecorder({
      enabled: true,
      inMemory: true,
      identityKey,
      privacy: { recordIO: true },
    });
    closeables.push(instance);
    await instance.initialize();
    await instance.record({
      traceId: "identity-key-redaction",
      kind: "identity.probe",
      source: "test",
      metadata: {
        identityKey,
        OPENRAPPTER_FLIGHT_ID_KEY: identityKey,
        assignment: `OPENRAPPTER_FLIGHT_ID_KEY=${identityKey}`,
        path: "/tmp/flight.db.identity-key",
      },
      payload: {
        raw: identityKey,
      },
    });
    await instance.record({
      traceId: "identity-kind-redaction",
      kind: identityKey.toUpperCase(),
      source: "test",
    });

    const serialized = JSON.stringify(await instance.export());
    expect(serialized).not.toContain(identityKey);
    expect(serialized).not.toContain(identityKey.toUpperCase());
    expect(serialized).not.toContain("flight.db.identity-key");
    expect(serialized).toContain("[redacted]");
    expect(serialized).toContain("[excluded-path]");
  });

  it("applies exact-value privacy before opaque identifier passthrough", async () => {
    const providerId = `provider:${"a".repeat(24)}`;
    const sessionId = `session:${"b".repeat(24)}`;
    const workspaceId = `workspace:${"c".repeat(24)}`;
    const instance = await recorder({
      privacy: {
        redactedValues: [providerId, sessionId, workspaceId],
      },
    });
    await instance.runTrace(
      {
        traceId: "opaque-redaction",
        sessionId,
        workspaceId,
      },
      async () => {
        await instance.record({
          kind: "opaque.probe",
          source: "test",
          providerId,
        });
      },
    );

    const events = await instance.query({ traceId: "opaque-redaction" });
    const probe = events.find((event) => event.kind === "opaque.probe")!;
    expect(probe.providerId).toMatch(/^provider:[0-9a-f]{24}$/);
    expect(probe.providerId).not.toBe(providerId);
    expect(probe.sessionId).toMatch(/^session:[0-9a-f]{24}$/);
    expect(probe.sessionId).not.toBe(sessionId);
    expect(probe.workspaceId).toMatch(/^workspace:[0-9a-f]{24}$/);
    expect(probe.workspaceId).not.toBe(workspaceId);
    expect(JSON.stringify(events)).not.toContain(providerId);
    expect(await instance.query({ sessionId })).toHaveLength(events.length);
  });

  it("uses a private trace-scoped sequence lookup", async () => {
    const ledger = new SQLiteFlightLedger({ inMemory: true });
    const query = vi
      .spyOn(ledger, "query")
      .mockRejectedValue(new Error("public query must not run"));
    const instance = new FlightRecorder(
      {
        enabled: true,
        inMemory: true,
        identityKey: TEST_IDENTITY_KEY,
        retentionEvents: -1,
      },
      ledger,
    );
    closeables.push(instance);
    await instance.initialize();

    await instance.runTrace({ traceId: "private-sequence" }, async () => {});
    await instance.runTrace({ traceId: "private-sequence" }, async () => {});

    expect(query).not.toHaveBeenCalled();
    expect(await ledger.lastSequence("private-sequence")).toBe(4);
  });

  it("recovers when another recorder advances the same durable trace", async () => {
    const directory = mkdtempSync(
      path.join(os.tmpdir(), "openrappter-flight-shared-"),
    );
    temporaryDirectories.push(directory);
    const databasePath = path.join(directory, "flight.db");
    const first = new FlightRecorder({ enabled: true, databasePath });
    const second = new FlightRecorder({ enabled: true, databasePath });
    closeables.push(first, second);
    await first.initialize();
    await second.initialize();

    expect(
      (await first.record({
        traceId: "shared-trace",
        kind: "first",
        source: "test",
      }))?.sequence,
    ).toBe(1);
    expect(
      (await second.record({
        traceId: "shared-trace",
        kind: "second",
        source: "test",
      }))?.sequence,
    ).toBe(2);
    expect(
      (await first.record({
        traceId: "shared-trace",
        kind: "third",
        source: "test",
      }))?.sequence,
    ).toBe(3);
    expect(
      (await first.record({
        traceId: "shared-trace",
        kind: "fourth",
        source: "test",
      }))?.sequence,
    ).toBe(4);
  });

  it("enforces retention from the authoritative shared database count", async () => {
    const directory = mkdtempSync(
      path.join(os.tmpdir(), "openrappter-flight-retention-shared-"),
    );
    temporaryDirectories.push(directory);
    const databasePath = path.join(directory, "flight.db");
    const first = new FlightRecorder({
      enabled: true,
      databasePath,
      retentionEvents: 10,
    });
    const second = new FlightRecorder({
      enabled: true,
      databasePath,
      retentionEvents: 10,
    });
    closeables.push(first, second);
    await first.initialize();
    await second.initialize();

    for (let index = 0; index < 6; index += 1) {
      await first.record({
        traceId: `shared-first-${index}`,
        kind: "atomic",
        source: "test",
      });
      await second.record({
        traceId: `shared-second-${index}`,
        kind: "atomic",
        source: "test",
      });
    }

    expect((await first.health()).eventCount).toBe(10);
  });

  it("eventually allocates every same-trace sequence across many recorders", async () => {
    const directory = mkdtempSync(
      path.join(os.tmpdir(), "openrappter-flight-many-recorders-"),
    );
    temporaryDirectories.push(directory);
    const databasePath = path.join(directory, "flight.db");
    const recorders = Array.from(
      { length: 12 },
      () =>
        new FlightRecorder({
          enabled: true,
          databasePath,
          retentionEvents: -1,
        }),
    );
    closeables.push(...recorders);
    await Promise.all(recorders.map((recorder) => recorder.initialize()));

    const events = await Promise.all(
      recorders.map((recorder) =>
        recorder.record({
          traceId: "shared-concurrent-trace",
          kind: "atomic",
          source: "test",
        }),
      ),
    );

    expect(events.every(Boolean)).toBe(true);
    expect(
      events.map((event) => event!.sequence).sort((a, b) => a - b),
    ).toEqual(Array.from({ length: 12 }, (_, index) => index + 1));
  });

  it("records terminal events even when the wall clock moves backward", async () => {
    const instance = await recorder();
    vi.spyOn(Date, "now")
      .mockReturnValueOnce(1_000)
      .mockReturnValue(900);

    await instance.runTrace({ traceId: "clock-rollback" }, async () => {});

    expect(
      (await instance.exportTrace("clock-rollback"))?.events.map(
        (event) => event.kind,
      ),
    ).toEqual(["trace.started", "trace.completed"]);
  });

  it("uses a keyed session pseudonym instead of a guessable plain hash", () => {
    const handle = "+15551234567";
    const first = normalizeFlightSessionId(handle, TEST_IDENTITY_KEY);
    const second = normalizeFlightSessionId(handle, "44".repeat(32));

    expect(first).toMatch(/^session:[0-9a-f]{24}$/);
    expect(first).toBe("session:b2141ccddd8e77eff1eb84f6");
    expect(normalizeFlightSessionId(handle, "33".repeat(32))).toBe(
      "session:e523e4096e6419b507b73af3",
    );
    expect(first).not.toBe(second);
  });

  it("shares only pseudonymized scope and effective storage settings with children", async () => {
    const directory = mkdtempSync(
      path.join(os.tmpdir(), "openrappter-flight-child-env-"),
    );
    temporaryDirectories.push(directory);
    const databasePath = path.join(directory, "flight.db");
    const instance = new FlightRecorder({
      enabled: true,
      databasePath,
      retentionEvents: 321,
      privacy: { recordIO: true, maxPayloadBytes: 1_234 },
    });
    closeables.push(instance);
    await instance.initialize();

    await instance.runTrace(
      { traceId: "child-trace", sessionId: "person@example.com" },
      async () => {
        const environment = instance.childProcessEnvironment();
        expect(environment).toMatchObject({
          OPENRAPPTER_FLIGHT_RECORDER: "1",
          OPENRAPPTER_FLIGHT_DB: databasePath,
          OPENRAPPTER_FLIGHT_RETENTION: "321",
          OPENRAPPTER_FLIGHT_RECORD_IO: "1",
          OPENRAPPTER_FLIGHT_MAX_PAYLOAD: "1234",
          OPENRAPPTER_FLIGHT_TRACE_ID: "child-trace",
        });
        expect(environment.OPENRAPPTER_FLIGHT_SESSION_ID).toMatch(
          /^session:[0-9a-f]{24}$/,
        );
        expect(environment.OPENRAPPTER_FLIGHT_SESSION_ID).not.toContain(
          "person@example.com",
        );
        expect(environment).not.toHaveProperty(
          "OPENRAPPTER_FLIGHT_ID_KEY",
        );
      },
    );
  });

  it("accepts payloads within a configured cap above the default", async () => {
    const instance = await recorder({
      privacy: { recordIO: true, maxPayloadBytes: 30_000 },
    });
    const event = await instance.record({
      traceId: "large-configured-payload",
      kind: "payload",
      source: "test",
      payload: { value: "x".repeat(20_000) },
    });

    expect(event).not.toBeNull();
    expect((await instance.health()).eventCount).toBe(1);
  });

  it("releases start ownership when terminal persistence fails", async () => {
    const ledger = new TerminalFailLedger();
    const instance = new FlightRecorder(
      {
        enabled: true,
        inMemory: true,
        identityKey: TEST_IDENTITY_KEY,
        retentionEvents: -1,
      },
      ledger,
    );
    closeables.push(instance);
    await instance.initialize();

    expect(
      await instance.runTrace(
        { traceId: "terminal-failure" },
        async () => "success",
      ),
    ).toBe("success");
    expect(
      (await instance.query({ traceId: "terminal-failure" }))[0].metadata,
    ).not.toHaveProperty("ownerPid");
    await expect(instance.clear()).resolves.toBe(true);
  });

  it("retries a transient ownership release instead of swallowing one failure", async () => {
    const ledger = new RetryingTerminalFailLedger(1);
    const instance = new FlightRecorder(
      {
        enabled: true,
        inMemory: true,
        identityKey: TEST_IDENTITY_KEY,
        retentionEvents: -1,
      },
      ledger,
    );
    closeables.push(instance);
    await instance.initialize();

    await instance.runTrace(
      { traceId: "release-retry" },
      async () => "success",
    );

    expect(ledger.releaseAttempts).toBe(2);
    expect(
      (await instance.query({ traceId: "release-retry" }))[0].metadata,
    ).not.toHaveProperty("ownerPid");
    expect((await instance.health()).pendingOwnershipReleases).toBe(0);
  });

  it("queues bounded cleanup and eventually releases a stale pin while the daemon stays alive", async () => {
    const ledger = new RetryingTerminalFailLedger(5);
    const instance = new FlightRecorder(
      {
        enabled: true,
        inMemory: true,
        identityKey: TEST_IDENTITY_KEY,
        retentionEvents: -1,
      },
      ledger,
    );
    closeables.push(instance);
    await instance.initialize();

    await instance.runTrace(
      { traceId: "release-queued" },
      async () => "success",
    );

    expect(process.pid).toBeGreaterThan(0);
    expect(await ledger.pendingOwnershipReleaseCount()).toBe(1);
    const queuedRoot =
      (await instance.query({ traceId: "release-queued" }))[0];
    expect(queuedRoot.metadata).toHaveProperty("ownerPid", process.pid);
    expect(
      await ledger.queueEventOwnershipRelease(queuedRoot.id, 1),
    ).toBe(1);
    await expect(
      ledger.queueEventOwnershipRelease("different-owner-id", 1),
    ).rejects.toThrow(/bound of 1/i);

    expect((await instance.health()).pendingOwnershipReleases).toBe(1);
    expect((await instance.health()).pendingOwnershipReleases).toBe(0);
    expect(
      (await instance.query({ traceId: "release-queued" }))[0].metadata,
    ).not.toHaveProperty("ownerPid");
    expect(ledger.releaseAttempts).toBe(6);
  });

  it("reconciles durable queued cleanup on startup without releasing a genuinely active trace", async () => {
    const directory = mkdtempSync(
      path.join(os.tmpdir(), "flight-owner-reconcile-"),
    );
    temporaryDirectories.push(directory);
    const databasePath = path.join(directory, "flight.db");
    const failingLedger = new RetryingTerminalFailLedger(10, databasePath);
    const first = new FlightRecorder(
      {
        enabled: true,
        databasePath,
        identityKey: TEST_IDENTITY_KEY,
        retentionEvents: -1,
      },
      failingLedger,
    );
    await first.initialize();

    await first.runTrace(
      { traceId: "startup-stale" },
      async () => "success",
    );
    const genuinelyActive = await first.record({
      traceId: "genuinely-active",
      parentId: null,
      kind: "trace.started",
      source: "runtime",
      status: "started",
    });
    expect(genuinelyActive).not.toBeNull();
    expect(await failingLedger.pendingOwnershipReleaseCount()).toBe(1);
    await first.close();

    const healthyLedger = new SQLiteFlightLedger({
      databasePath,
      inMemory: false,
    });
    const second = new FlightRecorder(
      {
        enabled: true,
        databasePath,
        identityKey: TEST_IDENTITY_KEY,
        retentionEvents: -1,
      },
      healthyLedger,
    );
    closeables.push(second);
    await second.initialize();

    expect((await second.health()).pendingOwnershipReleases).toBe(0);
    expect(
      (await second.query({ traceId: "startup-stale" }))[0].metadata,
    ).not.toHaveProperty("ownerPid");
    expect(
      (await second.query({ traceId: "genuinely-active" }))[0].metadata,
    ).toHaveProperty("ownerPid", process.pid);
  });

  it("does not terminate an ancestor when a nested start is not durable", async () => {
    const ledger = new FailSecondAppendLedger();
    const instance = new FlightRecorder(
      {
        enabled: true,
        inMemory: true,
        identityKey: TEST_IDENTITY_KEY,
        retentionEvents: -1,
      },
      ledger,
    );
    closeables.push(instance);
    await instance.initialize();

    await instance.runTrace({ traceId: "nested-start-failure" }, async () => {
      await expect(
        instance.runTrace({}, async () => {
          await instance.record({
            kind: "nested.work",
            source: "test",
          });
          return "nested result";
        }),
      ).resolves.toBe("nested result");
      const active = await instance.query({
        traceId: "nested-start-failure",
      });
      expect(active.map((event) => event.kind)).toEqual([
        "trace.started",
        "nested.work",
      ]);
      expect(active[1].parentId).toBeNull();
    });

    const events = await instance.query({
      traceId: "nested-start-failure",
    });
    expect(events.map((event) => event.kind)).toEqual([
      "trace.started",
      "nested.work",
      "trace.completed",
    ]);
    expect(events[2].parentId).toBe(events[0].id);
  });

  it("does not emit a failed terminal when a nested start was not durable", async () => {
    const ledger = new FailSecondAppendLedger();
    const instance = new FlightRecorder(
      {
        enabled: true,
        inMemory: true,
        identityKey: TEST_IDENTITY_KEY,
        retentionEvents: -1,
      },
      ledger,
    );
    closeables.push(instance);
    await instance.initialize();

    await instance.runTrace({ traceId: "nested-start-throw" }, async () => {
      await expect(
        instance.runTrace({}, async () => {
          throw new Error("nested failure");
        }),
      ).rejects.toThrow("nested failure");
      expect(
        (await instance.query({ traceId: "nested-start-throw" })).map(
          (event) => event.kind,
        ),
      ).toEqual(["trace.started"]);
    });

    expect(
      (await instance.query({ traceId: "nested-start-throw" })).map(
        (event) => event.kind,
      ),
    ).toEqual(["trace.started", "trace.completed"]);
  });

  it("preserves explicit null parents inside an active trace", async () => {
    const instance = await recorder();
    await instance.runTrace({ traceId: "explicit-null-parent" }, async () => {
      const detached = await instance.record({
        kind: "detached.event",
        source: "test",
        parentId: null,
      });
      expect(detached?.parentId).toBeNull();
      await instance.runTrace({ parentId: null }, async () => {});
    });

    const starts = (
      await instance.query({ traceId: "explicit-null-parent" })
    ).filter((event) => event.kind === "trace.started");
    expect(starts).toHaveLength(2);
    expect(starts[1].parentId).toBeNull();
  });

  it("keeps explicit global recorder configuration synchronized with bootstrap", async () => {
    resetFlightRecorderEnvironmentForTests();
    const first = await recorder();
    const previous = setFlightRecorder(first);
    const second = await recorder();
    try {
      expect(
        await ensureFlightRecorderFromEnv({
          NODE_ENV: "test",
          OPENRAPPTER_FLIGHT_RECORDER: "0",
        }),
      ).toBe(first);

      setFlightRecorder(second);
      expect(await ensureFlightRecorderFromEnv()).toBe(second);
    } finally {
      setFlightRecorder(previous);
      resetFlightRecorderEnvironmentForTests();
    }
  });

  it("lets explicit configuration win a concurrent environment bootstrap", async () => {
    resetFlightRecorderEnvironmentForTests();
    const pending = ensureFlightRecorderFromEnv({
      NODE_ENV: "test",
      OPENRAPPTER_FLIGHT_RECORDER: "0",
    });
    const explicit = new FlightRecorder({
      enabled: true,
      inMemory: true,
      identityKey: TEST_IDENTITY_KEY,
    });
    closeables.push(explicit);
    const previous = setFlightRecorder(explicit);
    await explicit.initialize();
    try {
      expect(await pending).toBe(explicit);
      expect(getFlightRecorder()).toBe(explicit);
      expect(await ensureFlightRecorderFromEnv()).toBe(explicit);
    } finally {
      setFlightRecorder(previous);
      resetFlightRecorderEnvironmentForTests();
    }
  });

  it("round-trips an export through the public recorder import API", async () => {
    const source = await recorder({ privacy: { recordIO: true } });
    await source.runTrace({ traceId: "portable" }, async () => {
      await source.record({
        kind: "portable.event",
        source: "test",
        payload: { answer: 42 },
      });
    });
    const bundle = (await source.exportTrace("portable"))!;
    expect(bundle.events[0].metadata).not.toHaveProperty("ownerPid");
    expect(await source.import(bundle)).toBe(0);

    const target = await recorder({ privacy: { recordIO: true } });
    expect(await target.import(bundle)).toBe(bundle.events.length);
    expect((await target.exportTrace("portable"))?.events).toEqual(
      bundle.events,
    );
    expect(await target.import(bundle)).toBe(0);

    const tampered = structuredClone(bundle);
    tampered.events[0].traceId = "tampered";
    await expect(target.import(tampered)).rejects.toThrow(/integrity/i);
  });

  it("rejects payload-bearing imports when recordIO is disabled", async () => {
    const source = await recorder({ privacy: { recordIO: true } });
    await source.record({
      traceId: "payload-import",
      kind: "payload",
      source: "test",
      payload: { ordinary: "private" },
    });
    const bundle = (await source.exportTrace("payload-import"))!;
    const target = await recorder({ privacy: { recordIO: false } });

    await expect(target.import(bundle)).rejects.toThrow(/recordIO is disabled/i);
    expect((await target.health()).eventCount).toBe(0);
  });

  it("applies custom redaction policy to imported metadata", async () => {
    const source = await recorder();
    await source.record({
      traceId: "custom-policy-import",
      kind: "metadata",
      source: "test",
      metadata: { customerData: "raw-value" },
    });
    const bundle = (await source.exportTrace("custom-policy-import"))!;
    const target = await recorder({
      privacy: { redactedKeys: ["customerData"] },
    });

    await expect(target.import(bundle)).rejects.toThrow(
      /active privacy policy/i,
    );
  });

  it("applies custom privacy policy to imported top-level identifiers", async () => {
    const source = await recorder();
    await source.record({
      traceId: "sensitive-trace",
      kind: "ordinary",
      source: "test",
      providerId: "internal-provider",
    });
    const bundle = (await source.exportTrace("sensitive-trace"))!;
    const target = await recorder({
      privacy: {
        excludedPathPatterns: [/sensitive|internal/i],
      },
    });

    await expect(target.import(bundle)).rejects.toThrow(
      /active privacy policy/i,
    );

    const keyTarget = await recorder({
      privacy: { redactedKeys: ["providerId"] },
    });
    await expect(keyTarget.import(bundle)).rejects.toThrow(
      /active privacy policy/i,
    );

    const modelSource = await recorder();
    await modelSource.record({
      traceId: "model-policy-import",
      kind: "ordinary",
      source: "test",
      model: "sensitive-model",
    });
    const modelTarget = await recorder({
      privacy: { redactedKeys: ["model"] },
    });
    await expect(
      modelTarget.import(
        (await modelSource.exportTrace("model-policy-import"))!,
      ),
    ).rejects.toThrow(/active privacy policy/i);
  });

  it("applies custom key policy to recorded envelope fields", async () => {
    const instance = await recorder({
      privacy: { redactedKeys: ["providerId"] },
    });
    const event = await instance.record({
      traceId: "custom-envelope-key",
      kind: "ordinary",
      source: "test",
      providerId: "internal-provider",
    });

    expect(event?.providerId).toMatch(/^provider:[0-9a-f]{24}$/);
    expect(JSON.stringify(event)).not.toContain("internal-provider");
  });

  it("keeps structural lifecycle fields stable under custom key policy", async () => {
    const instance = await recorder({
      privacy: {
        redactedKeys: ["traceId", "parentId", "kind", "source"],
      },
    });

    await instance.runTrace(
      { traceId: "structural-trace" },
      async () => {},
    );
    const events = await instance.query({ traceId: "structural-trace" });
    expect(events.map((event) => event.kind)).toEqual([
      "trace.started",
      "trace.completed",
    ]);
    await expect(instance.clear()).resolves.toBe(true);
  });

  it("keeps identifier pseudonyms idempotent across export and import", async () => {
    const source = await recorder({
      privacy: { redactedKeys: ["providerId"] },
    });
    await source.record({
      traceId: "idempotent",
      kind: "ordinary",
      source: "test",
      providerId: "internal-provider",
    });
    const bundle = (await source.exportTrace("idempotent"))!;
    const providerId = bundle.events[0].providerId;
    const target = await recorder({
      privacy: { redactedKeys: ["providerId"] },
    });

    await target.import(bundle);
    expect(
      (await target.exportTrace("idempotent"))?.events[0].providerId,
    ).toBe(providerId);
  });

  it("does not leak sequence cache entries for normalized trace IDs", async () => {
    const instance = await recorder({
      privacy: { excludedPathPatterns: [/secret-trace/i] },
    });
    for (let index = 0; index < 20; index += 1) {
      await instance.runTrace(
        { traceId: `secret-trace-${index}` },
        async () => {},
      );
    }
    const cache = instance as unknown as {
      sequenceByTrace: Map<string, number>;
    };
    expect(cache.sequenceByTrace.size).toBe(0);
  });

  it("preserves internal ownership when replacing an active exported start", async () => {
    const instance = await recorder({ retentionEvents: 0 });
    await instance.runTrace({ traceId: "replace-active" }, async () => {
      const bundle = (await instance.exportTrace("replace-active"))!;
      expect(bundle.events[0].metadata).not.toHaveProperty("ownerPid");
      const altered = structuredClone(bundle);
      altered.events[0].sessionId = "session:111111111111111111111111";
      altered.events[0].workspaceId =
        "workspace:222222222222222222222222";
      altered.events[0].metadata = {
        ...altered.events[0].metadata,
        scopeChanged: true,
      };
      altered.events[0].contentHash = computeFlightEventHash(
        altered.events[0],
      );
      await expect(
        instance.import(altered, { replace: true }),
      ).rejects.toThrow(/live trace|portable content/i);

      expect(
        await instance.import(bundle, { replace: true }),
      ).toBe(bundle.events.length);
      await instance.record({
        kind: "inside-active",
        source: "test",
      });
      expect(
        (await instance.query({ traceId: "replace-active" })).some(
          (event) => event.kind === "trace.started",
        ),
      ).toBe(true);
    });
  });

  it("does not restore ownership when replacing a completed trace start", async () => {
    const instance = await recorder({ retentionEvents: -1 });
    await instance.runTrace(
      { traceId: "replace-completed" },
      async () => {},
    );
    const bundle = (await instance.exportTrace("replace-completed"))!;

    expect(await instance.import(bundle, { replace: true })).toBe(
      bundle.events.length,
    );
    const start = (
      await instance.query({ traceId: "replace-completed" })
    ).find((event) => event.kind === "trace.started")!;
    expect(start.metadata).not.toHaveProperty("ownerPid");
    expect(start.metadata).not.toHaveProperty("ownerIncarnation");
  });

  it("rejects new imported events that would terminate a live trace", async () => {
    const instance = await recorder({ retentionEvents: 0 });
    await instance.runTrace({ traceId: "live-import" }, async () => {
      const root = (
        await instance.query({ traceId: "live-import" })
      ).find((event) => event.kind === "trace.started")!;
      const body: Omit<FlightEvent, "contentHash"> = {
        schema: "openrappter-event/1.0",
        id: "forged-terminal",
        sequence: root.sequence + 1,
        traceId: root.traceId,
        parentId: root.id,
        kind: "trace.completed",
        source: "import-test",
        status: "success",
        timestamp: new Date().toISOString(),
        metadata: {},
      };
      const terminal: FlightEvent = {
        ...body,
        contentHash: computeFlightEventHash(body),
      };

      await expect(
        instance.import({
          schema: "openrappter-flight-export/1.0",
          exportedAt: new Date().toISOString(),
          events: [terminal],
        }),
      ).rejects.toThrow(/live trace/i);
      expect(
        (await instance.query({ traceId: "live-import" })).some(
          (event) => event.kind === "trace.started",
        ),
      ).toBe(true);
    });
  });

  it("rejects replacing an event ID that belongs to another live trace", async () => {
    const instance = await recorder({ retentionEvents: -1 });
    await instance.runTrace({ traceId: "original-live" }, async () => {
      const context = await instance.record({
        kind: "context.assembled",
        source: "test",
      });
      const body: Omit<FlightEvent, "contentHash"> = {
        schema: "openrappter-event/1.0",
        id: context!.id,
        sequence: 1,
        traceId: "other-trace",
        parentId: null,
        kind: "context.assembled",
        source: "import-test",
        status: "info",
        timestamp: new Date().toISOString(),
        metadata: {},
      };
      const moved = {
        ...body,
        contentHash: computeFlightEventHash(body),
      };

      await expect(
        instance.import(
          {
            schema: "openrappter-flight-export/1.0",
            exportedAt: new Date().toISOString(),
            events: [moved],
          },
          { replace: true },
        ),
      ).rejects.toThrow(/move event.*live trace/i);
    });
  });

  it("keeps concurrent traces isolated and ordered independently", async () => {
    const instance = await recorder();
    const ids = Array.from({ length: 20 }, (_, index) => `concurrent-${index}`);

    await Promise.all(
      ids.map((traceId, index) =>
        instance.runTrace(
          { traceId, sessionId: `session-${index}` },
          async () => {
            await Promise.resolve();
            await instance.record({
              kind: "agent.execute.completed",
              source: "agent",
              agentName: `Agent${index}`,
            });
          },
        ),
      ),
    );

    for (const [index, traceId] of ids.entries()) {
      const events = (await instance.exportTrace(traceId))!.events;
      expect(events).toHaveLength(3);
      expect(new Set(events.map((event) => event.traceId))).toEqual(
        new Set([traceId]),
      );
      expect(events.map((event) => event.sequence)).toEqual([1, 2, 3]);
      expect(
        events.every(
          (event) =>
            event.sessionId ===
            normalizeFlightSessionId(
              `session-${index}`,
              TEST_IDENTITY_KEY,
            ),
        ),
      ).toBe(true);
    }
  });

  it("initializes the ledger exactly once under concurrent cold-start turns", async () => {
    const ledger = new SlowCountingLedger();
    const instance = new FlightRecorder({ enabled: true }, ledger);
    closeables.push(instance);

    await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        instance.runTrace({ traceId: `cold-${index}` }, async () => index),
      ),
    );

    expect(ledger.initializeCalls).toBe(1);
    expect(ledger.appendCalls).toBe(24);
  });

  it("does not reopen when close races an active initialization", async () => {
    const ledger = new SlowCountingLedger();
    const instance = new FlightRecorder({ enabled: true }, ledger);
    const initialization = instance.initialize();

    await instance.close();
    await initialization;

    expect(await instance.health()).toMatchObject({
      initialized: false,
      eventCount: 0,
    });
    expect(
      await instance.record({
        traceId: "closed-race",
        kind: "after-close",
        source: "test",
      }),
    ).toBeNull();
  });

  it("reserves an active trace slot before delayed initialization", async () => {
    const ledger = new SlowCountingLedger();
    const instance = new FlightRecorder(
      { enabled: true, identityKey: TEST_IDENTITY_KEY },
      ledger,
    );
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const operation = instance.runTrace(
      { traceId: "pre-init-active" },
      async () => {
        await gate;
        return "done";
      },
    );
    let closeDone = false;
    const closing = instance.close().then(() => {
      closeDone = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(closeDone).toBe(false);

    release();
    expect(await operation).toBe("done");
    await closing;
  });

  it("sanitizes secret-shaped top-level identifiers during recording", async () => {
    const instance = await recorder();
    const token = `ghp_${"x".repeat(32)}`;
    const event = await instance.record({
      traceId: token,
      kind: "ordinary",
      source: "/Users/alice/.ssh/id_ed25519",
      providerId: token,
    });

    expect(JSON.stringify(event)).not.toContain(token);
    expect(JSON.stringify(event)).not.toContain("id_ed25519");
    expect(event?.traceId).toMatch(/^trace:[0-9a-f]{24}$/);
    const workspaceEvent = await instance.record({
      traceId: "workspace-secret",
      kind: "ordinary",
      source: "test",
      workspaceId: token,
    });
    expect(workspaceEvent?.workspaceId).toMatch(
      /^workspace:[0-9a-f]{24}$/,
    );
  });

  it("hashes filesystem identities hidden in workspace URI forms", () => {
    const values = [
      "file:///Users/alice/private-project",
      "workspace:/Users/alice/private-project",
      String.raw`workspace:C:\Users\alice\private-project`,
      "workspace:%2FUsers%2Falice%2Fprivate-project",
      "workspace:%2FUsers%2Falice%2Fprivate-project%ZZ",
      "workspace:%252FUsers%252Falice%252Fprivate-project",
      "vscode-remote://ssh-remote+host/home/alice/private-project",
    ];
    for (const value of values) {
      expect(normalizeFlightWorkspaceId(value)).toMatch(
        /^workspace:[0-9a-f]{24}$/,
      );
      expect(normalizeFlightWorkspaceId(value)).not.toBe(value);
    }
    expect(normalizeFlightWorkspaceId("channel:memory")).toBe(
      "channel:memory",
    );
    expect(
      normalizeFlightWorkspaceId("workspace:0123456789abcdef01234567"),
    ).toBe("workspace:0123456789abcdef01234567");
  });

  it("normalizes raw workspace filters for query and export", async () => {
    const instance = await recorder();
    const workspace = "/Users/alice/private-project";
    await instance.runTrace(
      { traceId: "workspace-filter", workspaceId: workspace },
      async () => {},
    );

    expect(await instance.query({ workspaceId: workspace })).toHaveLength(2);
    expect(
      (await instance.export({ workspaceId: workspace }))?.events,
    ).toHaveLength(2);
  });

  it("normalizes lone Unicode surrogates before identity persistence", async () => {
    const instance = await recorder();
    let ran = false;
    await instance.runTrace(
      { traceId: "unicode-session", sessionId: "\ud800" },
      async () => {
        ran = true;
      },
    );

    expect(ran).toBe(true);
    const events = await instance.query({ traceId: "unicode-session" });
    expect(events).toHaveLength(2);
    expect(events[0].sessionId).toMatch(/^session:[0-9a-f]{24}$/);
    expect((await instance.health()).errorCount).toBe(0);
    const structural = await instance.record({
      traceId: "bad\ud800",
      kind: "unicode.identifier",
      source: "test",
    });
    expect(structural?.traceId).toBe("bad\ufffd");
  });

  it("drains an admitted trace before closing its ledger", async () => {
    const ledger = new RecordingLedger();
    const instance = new FlightRecorder(
      {
        enabled: true,
        identityKey: TEST_IDENTITY_KEY,
        retentionEvents: -1,
      },
      ledger,
    );
    await instance.initialize();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const operation = instance.runTrace(
      { traceId: "close-active" },
      async () => {
        await gate;
        return "done";
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    const closing = instance.close();

    release();
    expect(await operation).toBe("done");
    await closing;
    expect(ledger.events.map((event) => event.kind)).toEqual([
      "trace.started",
      "trace.completed",
    ]);
  });

  it("rejects reentrant close and clear before joining pending operations", async () => {
    const instance = await recorder({ retentionEvents: -1 });
    let entered!: () => void;
    const active = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let resume!: () => void;
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const operation = instance.runTrace(
      { traceId: "reentrant-shutdown" },
      async () => {
        entered();
        await gate;
        await expect(instance.close()).rejects.toThrow(/active trace/i);
        await expect(instance.clear()).rejects.toThrow(/active trace/i);
      },
    );
    await active;
    const closing = instance.close();
    resume();
    await operation;
    await closing;
  });

  it("re-roots detached async work after its trace generation ends", async () => {
    const instance = await recorder({ retentionEvents: -1 });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let detached!: Promise<FlightEvent | null>;

    await instance.runTrace({ traceId: "detached-origin" }, async () => {
      detached = (async () => {
        await gate;
        return instance.record({
          kind: "detached.event",
          source: "test",
        });
      })();
    });
    release();
    const detachedEvent = await detached;

    expect(detachedEvent).not.toBeNull();
    expect(detachedEvent?.traceId).not.toBe("detached-origin");
    expect(detachedEvent?.parentId).toBeNull();
    expect(
      (await instance.query({ traceId: "detached-origin" })).map(
        (event) => event.kind,
      ),
    ).toEqual(["trace.started", "trace.completed"]);
  });

  it("applies custom privacy to structural identifiers except kind", async () => {
    const instance = await recorder({
      privacy: {
        excludedPathPatterns: [/secret|custom\.kind/i],
        redactedKeys: ["id", "traceId", "source", "parentId"],
      },
    });
    await instance.runTrace(
      { traceId: "secret-trace-customer-123" },
      async () => {
        await instance.record({
          kind: "custom.kind",
          source: "secret-source",
          parentId: "secret-parent",
        });
      },
    );

    const events = await instance.query({
      traceId: "secret-trace-customer-123",
    });
    const custom = events.find((event) => event.kind === "custom.kind")!;
    expect(custom.traceId).toMatch(/^trace:[0-9a-f]{24}$/);
    expect(custom.source).toMatch(/^source:[0-9a-f]{24}$/);
    expect(custom.parentId).toMatch(/^event:[0-9a-f]{24}$/);
    expect(events.every((event) => /^event:[0-9a-f]{24}$/.test(event.id)))
      .toBe(true);
    expect(await instance.query({ source: "secret-source" })).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain("secret-");
  });

  it("keeps lifecycle kinds non-redactable for active retention", async () => {
    const instance = await recorder({
      retentionEvents: 0,
      privacy: { redactedValues: ["trace"] },
    });
    await instance.runTrace(
      { traceId: "private-lifecycle" },
      async () => {
        await instance.record({
          kind: "inside.lifecycle",
          source: "test",
        });
        const active = await instance.query({
          traceId: "private-lifecycle",
        });
        expect(active.map((event) => event.kind)).toEqual([
          "trace.started",
          "inside.lifecycle",
        ]);
      },
    );
  });

  it("keeps displayed private trace IDs stable across record query and import", async () => {
    const instance = await recorder({
      privacy: { redactedValues: ["trace"] },
    });
    await instance.runTrace(
      { traceId: "private-stable-trace" },
      async () => {
        await instance.record({
          kind: "stable.event",
          source: "test",
        });
      },
    );
    const exported = (await instance.export())!;
    const displayedTraceId = exported.events[0].traceId;

    expect(
      (await instance.query({ traceId: displayedTraceId })).length,
    ).toBe(exported.events.length);
    await expect(
      instance.import(exported, { replace: true }),
    ).resolves.toBe(exported.events.length);
  });

  it("makes concurrent close callers await the same cleanup", async () => {
    const ledger = new SlowCloseLedger();
    const instance = new FlightRecorder(
      { enabled: true, identityKey: TEST_IDENTITY_KEY },
      ledger,
    );
    await instance.initialize();
    const first = instance.close();
    await ledger.closeEntered;
    let secondDone = false;
    const second = instance.close().then(() => {
      secondDone = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(secondDone).toBe(false);

    ledger.releaseClose();
    await Promise.all([first, second]);
    expect(secondDone).toBe(true);
  });

  it("blocks direct records while clear is deleting storage", async () => {
    const ledger = new SlowClearLedger();
    const instance = new FlightRecorder(
      {
        enabled: true,
        identityKey: TEST_IDENTITY_KEY,
        retentionEvents: -1,
      },
      ledger,
    );
    closeables.push(instance);
    await instance.initialize();
    await instance.record({
      traceId: "before-clear",
      kind: "before",
      source: "test",
    });

    const clearing = instance.clear();
    await ledger.clearEntered;
    expect(
      await instance.record({
        traceId: "during-clear",
        kind: "during",
        source: "test",
      }),
    ).toBeNull();
    ledger.releaseClear();
    await clearing;
    expect(ledger.events).toEqual([]);
  });

  it("makes close wait for an in-progress clear", async () => {
    const ledger = new SlowClearLedger();
    const instance = new FlightRecorder(
      {
        enabled: true,
        identityKey: TEST_IDENTITY_KEY,
        retentionEvents: -1,
      },
      ledger,
    );
    await instance.initialize();
    const clearing = instance.clear();
    await ledger.clearEntered;
    let closed = false;
    const closing = instance.close().then(() => {
      closed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(closed).toBe(false);

    ledger.releaseClear();
    await clearing;
    await closing;
    expect(closed).toBe(true);
  });

  it("rejects import admission once close begins", async () => {
    const ledger = new SlowCloseLedger();
    const instance = new FlightRecorder(
      { enabled: true, identityKey: TEST_IDENTITY_KEY },
      ledger,
    );
    await instance.initialize();
    const closing = instance.close();
    await ledger.closeEntered;
    const bundle: FlightExport = {
      schema: "openrappter-flight-export/1.0",
      exportedAt: new Date().toISOString(),
      events: [],
    };

    await expect(instance.import(bundle)).rejects.toThrow(/close/i);
    expect(ledger.importCalls).toBe(0);
    ledger.releaseClose();
    await closing;
  });

  it("evicts completed trace sequence caches in a long-running gateway", async () => {
    const instance = await recorder();
    for (let index = 0; index < 250; index += 1) {
      await instance.runTrace(
        { traceId: `gateway-turn-${index}` },
        async () => {},
      );
    }

    const cache = instance as unknown as {
      sequenceByTrace: Map<string, number>;
      sequenceLocks: Map<string, Promise<void>>;
    };
    expect(cache.sequenceByTrace.size).toBe(0);
    expect(cache.sequenceLocks.size).toBe(0);
    expect((await instance.health()).eventCount).toBe(500);
  });

  it("evicts sequence caches after standalone direct records", async () => {
    const instance = await recorder({ retentionEvents: 0 });
    for (let index = 0; index < 1_000; index += 1) {
      await instance.record({
        traceId: `standalone-${index}`,
        kind: "atomic",
        source: "test",
      });
    }

    const cache = instance as unknown as {
      sequenceByTrace: Map<string, number>;
      sequenceLocks: Map<string, Promise<void>>;
    };
    expect(cache.sequenceByTrace.size).toBe(0);
    expect(cache.sequenceLocks.size).toBe(0);
    expect((await instance.health()).eventCount).toBe(0);
  });

  it("reserves runtime owner metadata from custom redaction policy", async () => {
    const instance = await recorder({
      retentionEvents: 0,
      privacy: { redactedKeys: ["ownerPid"] },
    });
    await instance.runTrace({ traceId: "reserved-owner" }, async () => {
      expect(
        (await instance.query({ traceId: "reserved-owner" })).some(
          (event) => event.kind === "trace.started",
        ),
      ).toBe(true);
    });
  });

  it("removes user-supplied owner metadata outside runtime trace starts", async () => {
    const instance = await recorder();
    const event = await instance.record({
      traceId: "user-owner-metadata",
      kind: "ordinary",
      source: "test",
      metadata: { ownerId: "forged", ownerPid: process.pid },
    });

    expect(event?.metadata).toEqual({});
    expect(
      (await instance.exportTrace("user-owner-metadata"))?.events[0]
        .metadata,
    ).toEqual({});
  });

  it("rethrows the original operation error and records a failed terminal event", async () => {
    const instance = await recorder();
    const original = new TypeError("operation exploded");

    await expect(
      instance.runTrace({ traceId: "failed-trace" }, async () => {
        throw original;
      }),
    ).rejects.toBe(original);

    const events = (await instance.exportTrace("failed-trace"))!.events;
    expect(events.map((event) => event.kind)).toEqual([
      "trace.started",
      "trace.failed",
    ]);
    expect(events[1].status).toBe("error");
    expect(events[1].metadata.errorName).toBe("TypeError");
    expect(events[1].metadata.messageChars).toBe("operation exploded".length);
    expect(JSON.stringify(events[1])).not.toContain("operation exploded");
  });

  it("preserves hostile application errors and releases trace ownership", async () => {
    const instance = await recorder();
    const original = new Error("hidden");
    Object.defineProperty(original, "message", {
      get() {
        throw new Error("hostile getter");
      },
    });
    let caught: unknown;
    try {
      await instance.runTrace(
        { traceId: "hostile-error" },
        async () => {
          throw original;
        },
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(original);
    await expect(instance.clear()).resolves.toBe(true);
  });

  it("is a true no-op when disabled", async () => {
    const ledger = new CountingLedger();
    const instance = new FlightRecorder({ enabled: false }, ledger);
    closeables.push(instance);

    await instance.initialize();
    const result = await instance.runTrace(
      { traceId: "disabled" },
      async () => 42,
    );
    const recorded = await instance.record({ kind: "ignored", source: "test" });

    expect(result).toBe(42);
    expect(recorded).toBeNull();
    expect(ledger.initializeCalls).toBe(0);
    expect(ledger.appendCalls).toBe(0);
    expect(await instance.health()).toMatchObject({
      enabled: false,
      initialized: false,
      eventCount: 0,
      errorCount: 0,
    });
  });

  it("fails open on ledger initialization and append failures but exposes health", async () => {
    const initFailure = new FlightRecorder(
      { enabled: true },
      new FailingLedger("initialize"),
    );
    closeables.push(initFailure);
    const firstResult = await initFailure.runTrace(
      {},
      async () => "still works",
    );
    expect(firstResult).toBe("still works");
    expect(await initFailure.health()).toMatchObject({
      initialized: false,
    });
    expect((await initFailure.health()).errorCount).toBe(1);
    expect((await initFailure.health()).lastError).toContain(
      "initialize failed",
    );

    const appendFailure = new FlightRecorder(
      { enabled: true },
      new FailingLedger("append"),
    );
    closeables.push(appendFailure);
    await appendFailure.initialize();
    const secondResult = await appendFailure.runTrace(
      {},
      async () => "also works",
    );
    expect(secondResult).toBe("also works");
    const health = await appendFailure.health();
    expect(health.initialized).toBe(true);
    expect(health.errorCount).toBeGreaterThanOrEqual(1);
    expect(health.lastError).toContain("append failed");
  });

  it("uses an initialization cooldown within one failed trace", async () => {
    const ledger = new CountingInitializationFailureLedger();
    const instance = new FlightRecorder({ enabled: true }, ledger);

    expect(
      await instance.runTrace({}, async () => "still works"),
    ).toBe("still works");
    expect(ledger.initializeCalls).toBe(1);
  });

  it("uses monotonic time for initialization retry cooldowns", async () => {
    let monotonic = 1_000;
    vi.spyOn(performance, "now").mockImplementation(() => monotonic);
    vi.spyOn(Date, "now").mockReturnValue(-1_000_000);
    const ledger = new CountingInitializationFailureLedger();
    const instance = new FlightRecorder({ enabled: true }, ledger);

    await instance.initialize();
    expect(ledger.initializeCalls).toBe(1);
    monotonic = 2_001;
    await instance.initialize();
    expect(ledger.initializeCalls).toBe(2);
  });

  it("fails inspection loud on corruption while retaining recorder health", async () => {
    const instance = new FlightRecorder(
      { enabled: true },
      new FailingLedger("query"),
    );
    closeables.push(instance);
    await instance.initialize();

    await expect(instance.query()).rejects.toThrow("query corrupt");
    await expect(instance.export()).rejects.toThrow("query corrupt");
    const health = await instance.health();
    expect(health.initialized).toBe(true);
    expect(health.errorCount).toBeGreaterThanOrEqual(2);
    expect(health.lastError).toContain("query corrupt");
  });

  it("does not consume a trace sequence when append fails before durability", async () => {
    const ledger = new FailOnceAppendLedger();
    const instance = new FlightRecorder(
      { enabled: true, retentionEvents: -1 },
      ledger,
    );
    closeables.push(instance);
    await instance.initialize();

    expect(
      await instance.record({
        traceId: "append-retry",
        kind: "first",
        source: "test",
      }),
    ).toBeNull();
    const persisted = await instance.record({
      traceId: "append-retry",
      kind: "second",
      source: "test",
    });

    expect(persisted?.sequence).toBe(1);
    expect(ledger.events.map((event) => event.sequence)).toEqual([1]);
  });

  it("loads the latest sequence with one descending query for very long traces", async () => {
    const ledger = new LongTraceLedger();
    const instance = new FlightRecorder(
      { enabled: true, retentionEvents: -1 },
      ledger,
    );
    closeables.push(instance);
    await instance.initialize();

    const persisted = await instance.record({
      traceId: "million-event-trace",
      kind: "continued",
      source: "test",
    });

    expect(persisted?.sequence).toBe(1_010_001);
    expect(ledger.queries).toEqual([
      {
        traceId: "million-event-trace",
        order: "desc",
        limit: 1,
      },
    ]);
  });

  it("returns a durable event when post-append retention maintenance fails", async () => {
    const ledger = new PruneFailingLedger();
    const instance = new FlightRecorder(
      { enabled: true, retentionEvents: 0 },
      ledger,
    );
    closeables.push(instance);
    await instance.initialize();

    const first = await instance.record({
      traceId: "prune-health",
      kind: "first",
      source: "test",
    });
    const second = await instance.record({
      traceId: "prune-health",
      kind: "second",
      source: "test",
    });

    expect(first?.sequence).toBe(1);
    expect(second?.sequence).toBe(2);
    expect(ledger.events.map((event) => event.id)).toEqual([
      first?.id,
      second?.id,
    ]);
    const health = await instance.health();
    expect(health.errorCount).toBe(2);
    expect(health.lastError).toContain("prune failed");
  });

  it("retention preserves the newest events across traces, not the largest sequence", async () => {
    const instance = await recorder({ retentionEvents: 3 });
    await instance.record({
      traceId: "old-high-sequence",
      kind: "old",
      source: "test",
      timestamp: "2020-01-01T00:00:00.000Z",
    });
    // Force a high old sequence without changing public state.
    for (let index = 0; index < 10; index += 1) {
      await instance.record({
        traceId: "old-high-sequence",
        kind: `old.${index}`,
        source: "test",
        timestamp: "2020-01-01T00:00:00.000Z",
      });
    }
    await instance.record({
      traceId: "new-low-sequence",
      kind: "new",
      source: "test",
      timestamp: "2030-01-01T00:00:00.000Z",
    });

    const oldEvents = await instance.exportTrace("old-high-sequence");
    const newEvents = await instance.exportTrace("new-low-sequence");
    expect(newEvents?.events.map((event) => event.kind)).toEqual(["new"]);
    expect(
      (oldEvents?.events.length ?? 0) + (newEvents?.events.length ?? 0),
    ).toBe(1);
  });

  it("batches retention maintenance instead of pruning every append above the target", async () => {
    const ledger = new CountingLedger();
    const instance = new FlightRecorder(
      { enabled: true, retentionEvents: 101 },
      ledger,
    );
    closeables.push(instance);
    await instance.initialize();

    for (let index = 0; index < 112; index += 1) {
      await instance.record({
        traceId: "retention-batch",
        kind: "agent.execute.completed",
        source: "test",
      });
    }

    expect(ledger.appendCalls).toBe(112);
    expect(ledger.pruneCalls).toBe(1);
  });
});

class CountingLedger implements FlightLedger {
  initializeCalls = 0;
  appendCalls = 0;
  pruneCalls = 0;
  async initialize() {
    this.initializeCalls += 1;
  }
  async close() {}
  async append(_event: FlightEvent) {
    this.appendCalls += 1;
  }
  async query(_query: FlightEventQuery = {}): Promise<FlightEvent[]> {
    return [];
  }
  async count() {
    return this.appendCalls;
  }
  async prune(_keep: number) {
    this.pruneCalls += 1;
    return 0;
  }
  async export(): Promise<FlightExport> {
    return {
      schema: "openrappter-flight-export/1.0",
      exportedAt: new Date().toISOString(),
      events: [],
    };
  }
  async import() {
    return 0;
  }
  async clear() {}
}

class SlowCountingLedger extends CountingLedger {
  override async initialize() {
    this.initializeCalls += 1;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

class RecordingLedger extends CountingLedger {
  events: FlightEvent[] = [];

  override async append(event: FlightEvent) {
    this.appendCalls += 1;
    this.events.push(event);
  }

  override async query(query: FlightEventQuery = {}) {
    return this.events.filter(
      (event) => !query.traceId || event.traceId === query.traceId,
    );
  }

  override async count() {
    return this.events.length;
  }
}

class FailOnceAppendLedger extends RecordingLedger {
  private failed = false;

  override async append(event: FlightEvent) {
    if (!this.failed) {
      this.failed = true;
      throw new Error("append failed once");
    }
    await super.append(event);
  }
}

class FailSecondAppendLedger extends RecordingLedger {
  private attempts = 0;

  override async append(event: FlightEvent) {
    this.attempts += 1;
    if (this.attempts === 2) {
      throw new Error("nested start append failed");
    }
    await super.append(event);
  }
}

class PruneFailingLedger extends RecordingLedger {
  override async prune(_keep: number): Promise<number> {
    this.pruneCalls += 1;
    throw new Error("prune failed");
  }
}

class LongTraceLedger extends RecordingLedger {
  queries: FlightEventQuery[] = [];

  override async query(query: FlightEventQuery = {}) {
    this.queries.push(query);
    return [{ sequence: 1_010_000 } as FlightEvent];
  }
}

class SlowClearLedger extends RecordingLedger {
  private release!: () => void;
  private entered!: () => void;
  readonly clearEntered: Promise<void>;

  constructor() {
    super();
    this.clearEntered = new Promise<void>((resolve) => {
      this.entered = resolve;
    });
  }

  releaseClear(): void {
    this.release();
  }

  override async clear() {
    this.entered();
    await new Promise<void>((resolve) => {
      this.release = resolve;
    });
    this.events = [];
  }
}

class TerminalFailLedger extends SQLiteFlightLedger {
  constructor() {
    super({ inMemory: true });
  }

  override async append(event: FlightEvent): Promise<void> {
    if (event.kind === "trace.completed") {
      throw new Error("terminal append failed");
    }
    await super.append(event);
  }
}

class RetryingTerminalFailLedger extends SQLiteFlightLedger {
  releaseAttempts = 0;

  constructor(
    private releaseFailures: number,
    databasePath?: string,
  ) {
    super(databasePath
      ? { databasePath, inMemory: false }
      : { inMemory: true });
  }

  override async append(event: FlightEvent) {
    if (event.kind === "trace.completed") {
      throw new Error("terminal append failed");
    }
    return super.append(event);
  }

  override async releaseEventOwnership(eventId: string): Promise<void> {
    this.releaseAttempts += 1;
    if (this.releaseAttempts <= this.releaseFailures) {
      const error = new Error("transient ownership release contention") as
        Error & { code: string };
      error.code = "SQLITE_BUSY";
      throw error;
    }
    return super.releaseEventOwnership(eventId);
  }
}

class FailingLedger implements FlightLedger {
  private initialized = false;
  constructor(private readonly failure: "initialize" | "append" | "query") {}
  async initialize() {
    if (this.failure === "initialize") throw new Error("initialize failed");
    this.initialized = true;
  }
  async close() {}
  async append(_event: FlightEvent) {
    if (!this.initialized) throw new Error("not initialized");
    if (this.failure === "append") throw new Error("append failed");
  }
  async query(_query?: FlightEventQuery) {
    if (this.failure === "query") throw new Error("query corrupt");
    return [];
  }
  async count() {
    return 0;
  }
  async prune() {
    return 0;
  }
  async export(): Promise<FlightExport> {
    if (this.failure === "query") throw new Error("query corrupt");
    return {
      schema: "openrappter-flight-export/1.0",
      exportedAt: new Date().toISOString(),
      events: [],
    };
  }
  async import(_data: FlightExport) {
    return 0;
  }
  async clear() {}
}

class CountingInitializationFailureLedger extends FailingLedger {
  initializeCalls = 0;

  constructor() {
    super("initialize");
  }

  override async initialize() {
    this.initializeCalls += 1;
    await super.initialize();
  }
}

class SlowCloseLedger extends RecordingLedger {
  importCalls = 0;
  private entered!: () => void;
  private release!: () => void;
  readonly closeEntered: Promise<void>;

  constructor() {
    super();
    this.closeEntered = new Promise<void>((resolve) => {
      this.entered = resolve;
    });
  }

  releaseClose(): void {
    this.release();
  }

  override async close() {
    this.entered();
    await new Promise<void>((resolve) => {
      this.release = resolve;
    });
  }

  override async import() {
    this.importCalls += 1;
    return 0;
  }
}
