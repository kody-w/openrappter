import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerFlightRecorderCommand } from "../cli/flight-recorder.js";
import {
  ensureFlightRecorderFromEnv,
  getFlightRecorder,
  resetFlightRecorderEnvironmentForTests,
} from "./recorder.js";

let directory: string;
let databasePath: string;
const originalEnv = { ...process.env };

beforeEach(() => {
  directory = mkdtempSync(path.join(os.tmpdir(), "openrappter-flight-cli-"));
  databasePath = path.join(directory, "flight.db");
  process.env.OPENRAPPTER_FLIGHT_RECORDER = "1";
  process.env.OPENRAPPTER_FLIGHT_DB = databasePath;
  process.env.OPENRAPPTER_FLIGHT_RECORD_IO = "0";
  process.env.NODE_ENV = "test";
  resetFlightRecorderEnvironmentForTests();
});

afterEach(async () => {
  await getFlightRecorder().close();
  resetFlightRecorderEnvironmentForTests();
  process.env = { ...originalEnv };
  rmSync(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function command(): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({
    writeOut: () => {},
    writeErr: () => {},
  });
  registerFlightRecorderCommand(program);
  return program;
}

describe("flight CLI", () => {
  it("prints machine-readable status from the real local ledger", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await command().parseAsync(["node", "test", "flight", "status", "--json"]);

    const status = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
    expect(status).toMatchObject({
      enabled: true,
      initialized: true,
      eventCount: 0,
      errorCount: 0,
      databasePath,
    });
    expect(statSync(databasePath).mode & 0o777).toBe(0o600);
  });

  it("lists privacy-safe event summaries and filters by trace", async () => {
    const recorder = await ensureFlightRecorderFromEnv();
    await recorder.runTrace(
      { traceId: "wanted", sessionId: "session-a" },
      async () => {
        await recorder.record({
          kind: "agent.execute.completed",
          source: "cli-test",
          agentName: "SafeAgent",
          metadata: { token: "must disappear", ordinary: 7 },
          payload: { prompt: "must not persist" },
        });
      },
    );
    await recorder.runTrace({ traceId: "other" }, async () => {});

    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await command().parseAsync([
      "node",
      "test",
      "flight",
      "events",
      "--trace",
      "wanted",
      "--kind",
      "agent.execute.completed",
      "--json",
    ]);

    const events = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      traceId: "wanted",
      agentName: "SafeAgent",
      metadata: { ordinary: 7, token: "[redacted]" },
    });
    expect(JSON.stringify(events)).not.toContain("must not persist");
  });

  it("never includes opt-in payloads in JSON summary output", async () => {
    await getFlightRecorder().close();
    resetFlightRecorderEnvironmentForTests();
    process.env.OPENRAPPTER_FLIGHT_RECORD_IO = "1";
    const recorder = await ensureFlightRecorderFromEnv();
    await recorder.record({
      traceId: "private-json-summary",
      kind: "private",
      source: "cli-test",
      payload: { value: "private-payload-probe" },
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await command().parseAsync([
      "node",
      "test",
      "flight",
      "events",
      "--trace",
      "private-json-summary",
      "--json",
    ]);

    const events = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
    expect(events).toHaveLength(1);
    expect(events[0]).not.toHaveProperty("payload");
    expect(JSON.stringify(events)).not.toContain("private-payload-probe");
  });

  it("lists newest cross-trace events first", async () => {
    const recorder = await ensureFlightRecorderFromEnv();
    await recorder.record({
      traceId: "older-high-sequence",
      kind: "old",
      source: "cli-test",
      timestamp: "2020-01-01T00:00:00.000Z",
    });
    await recorder.record({
      traceId: "newer-low-sequence",
      kind: "new",
      source: "cli-test",
      timestamp: "2030-01-01T00:00:00.000Z",
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await command().parseAsync([
      "node",
      "test",
      "flight",
      "events",
      "--limit",
      "1",
      "--json",
    ]);

    const events = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe("new");
  });

  it("exports a versioned mode-0600 bundle and clears only with confirmation", async () => {
    const recorder = await ensureFlightRecorderFromEnv();
    await recorder.runTrace({ traceId: "exported" }, async () => {});
    const output = path.join(directory, "trace.json");
    writeFileSync(output, "public placeholder", { mode: 0o644 });
    chmodSync(output, 0o644);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await command().parseAsync([
      "node",
      "test",
      "flight",
      "export",
      "--trace",
      "exported",
      "--output",
      output,
    ]);
    const bundle = JSON.parse(readFileSync(output, "utf8"));
    expect(bundle.schema).toBe("openrappter-flight-export/1.0");
    expect(bundle.events.length).toBeGreaterThan(0);
    expect(statSync(output).mode & 0o777).toBe(0o600);
    expect(
      readdirSync(directory).filter((name) => name.includes("trace.json.")),
    ).toEqual([]);

    await expect(
      command().parseAsync(["node", "test", "flight", "clear"]),
    ).rejects.toThrow(/--yes/);
    expect((await recorder.health()).eventCount).toBeGreaterThan(0);

    await command().parseAsync(["node", "test", "flight", "clear", "--yes"]);
    expect((await recorder.health()).eventCount).toBe(0);
    expect(
      log.mock.calls.some(([line]) => String(line).includes("cleared")),
    ).toBe(true);

    await command().parseAsync(["node", "test", "flight", "import", output]);
    expect((await recorder.health()).eventCount).toBe(bundle.events.length);
  });

  it("rejects export outputs that collide with live recorder storage", async () => {
    const recorder = await ensureFlightRecorderFromEnv();
    await recorder.runTrace({ traceId: "safe-export" }, async () => {});
    const before = (await recorder.health()).eventCount;

    for (const output of [
      databasePath,
      `${databasePath}-wal`,
      `${databasePath}-shm`,
      `${databasePath}.identity-key`,
    ]) {
      await expect(
        command().parseAsync([
          "node",
          "test",
          "flight",
          "export",
          "--output",
          output,
        ]),
      ).rejects.toThrow(/recorder storage|aliases/i);
    }
    if (process.platform === "darwin" || process.platform === "win32") {
      await expect(
        command().parseAsync([
          "node",
          "test",
          "flight",
          "export",
          "--output",
          `${databasePath}.RESET-LOCK`,
        ]),
      ).rejects.toThrow(/recorder storage/i);
    }
    if (process.platform !== "win32") {
      const ownerAlias = path.join(directory, "owners-alias");
      symlinkSync(`${databasePath}.owners`, ownerAlias, "dir");
      await expect(
        command().parseAsync([
          "node",
          "test",
          "flight",
          "export",
          "--output",
          path.join(ownerAlias, "forged-owner.json"),
        ]),
      ).rejects.toThrow(/recorder storage|owner storage/i);

      const databaseDirectoryAlias = path.join(
        directory,
        "database-directory-alias",
      );
      symlinkSync(directory, databaseDirectoryAlias, "dir");
      await expect(
        command().parseAsync([
          "node",
          "test",
          "flight",
          "export",
          "--output",
          path.join(
            databaseDirectoryAlias,
            `${path.basename(databasePath)}.reset-lock`,
          ),
        ]),
      ).rejects.toThrow(/recorder storage/i);
    }
    expect((await recorder.health()).eventCount).toBe(before);
    expect(
      (await recorder.query({ traceId: "safe-export" })).length,
    ).toBeGreaterThan(0);
  });

  it("rejects invalid numeric limits instead of silently defaulting", async () => {
    await expect(
      command().parseAsync([
        "node",
        "test",
        "flight",
        "events",
        "--limit",
        "-1",
      ]),
    ).rejects.toThrow(/non-negative integer/);
  });

  it("fails loud when the persisted ledger is corrupt", async () => {
    const recorder = await ensureFlightRecorderFromEnv();
    await recorder.record({
      traceId: "corrupt-me",
      kind: "before-corruption",
      source: "cli-test",
    });
    const module = await import("better-sqlite3");
    const Database = module.default as unknown as new (filename: string) => {
      prepare(sql: string): { run(...params: unknown[]): unknown };
      close(): void;
    };
    const db = new Database(databasePath);
    db.prepare(
      "UPDATE flight_events SET event_json = '{\"broken\":true}' WHERE trace_id = ?",
    ).run("corrupt-me");
    db.close();

    await expect(
      command().parseAsync(["node", "test", "flight", "events", "--json"]),
    ).rejects.toThrow(/corrupt/i);
    expect((await recorder.health()).lastError).toMatch(/corrupt/i);
  });

  it("fails loud when the ledger cannot initialize instead of printing empty history", async () => {
    process.env.OPENRAPPTER_FLIGHT_DB = "/dev/null/flight.db";
    resetFlightRecorderEnvironmentForTests();

    await expect(
      command().parseAsync(["node", "test", "flight", "events", "--json"]),
    ).rejects.toThrow(/unavailable|not a directory|ENOTDIR/i);

    const health = await ensureFlightRecorderFromEnv().then((recorder) =>
      recorder.health(),
    );
    expect(health.initialized).toBe(false);
    expect(health.errorCount).toBeGreaterThan(0);
    expect(health.lastError).toBeTruthy();
  });
});
