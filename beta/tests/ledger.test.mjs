import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

// Scratch removal is best-effort and retried: on Windows an SQLite handle that
// a later after-hook closes still locks ledger.sqlite while this hook runs, and
// a leftover temp directory must not fail the test that already passed.
function removeScratch(directory) {
  try {
    rmSync(directory, { force: true, maxRetries: 10, recursive: true, retryDelay: 50 });
  } catch (error) {
    if (!["EBUSY", "EPERM", "ENOTEMPTY"].includes(error?.code)) throw error;
  }
}

import {
  describe,
  inferAgentToolName,
  ledgerInternals,
  openLedger,
  parseAgentLogs,
  recordCompletedTurn,
} from "../electron/ledger.mjs";


function scratch(t, prefix = "rapp-ledger-") {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  t.after(() => removeScratch(root));
  return root;
}

function rows(databasePath, sql) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return database.prepare(sql).all().map((row) => ({ ...row }));
  } finally {
    database.close();
  }
}

test("ledger creates private WAL storage with the documented schema and queries", (t) => {
  const betaHome = scratch(t);
  const ledger = openLedger(betaHome);
  t.after(() => ledger.close());

  const databasePath = path.join(betaHome, "ledger.sqlite");
  const mirrorPath = path.join(betaHome, "ledger.jsonl");
  const tableNames = rows(
    databasePath,
    "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
  ).map(({ name }) => name);
  assert.deepEqual(
    tableNames.filter((name) => !name.startsWith("sqlite_")),
    ["agents", "sources", "tools_called", "turns"],
  );
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    assert.equal(database.prepare("PRAGMA journal_mode").get().journal_mode, "wal");
  } finally {
    database.close();
  }
  if (process.platform !== "win32") {
    assert.equal(statSync(betaHome).mode & 0o777, 0o700);
    assert.equal(statSync(databasePath).mode & 0o777, 0o600);
    assert.equal(statSync(mirrorPath).mode & 0o777, 0o600);
  }

  const summary = ledger.describe();
  assert.deepEqual(summary, describe(betaHome));
  assert.match(summary.query_lines[0], /^sqlite3 .*ledger\.sqlite/);
  assert.match(summary.query_lines[0], /select \* from agents/);
  assert.match(summary.query_lines[1], /^grep -i '<word>' .*ledger\.jsonl/);
});

test("ledger mirrors turns, tools, agents, and source locations synchronously", (t) => {
  const betaHome = scratch(t);
  const writes = [];
  const ledger = openLedger(betaHome, {
    now: () => "2026-08-20T20:12:00.000Z",
    onWrite: (row) => writes.push(row.table),
  });
  t.after(() => ledger.close());

  ledger.recordTurn({
    sessionId: "session-1",
    surface: "brainstem",
    role: "user",
    content: "what's the weather here",
    model: "scripted",
    requestId: "request-1",
  });
  ledger.recordToolCall({
    sessionId: "session-1",
    toolName: "WeatherAgent",
    ok: true,
    summary: "forecast returned",
  });
  ledger.recordAgent({
    event: "installed",
    filename: "weather_agent.py",
    toolName: "WeatherAgent",
    rappid: "rapp:test:weather",
    sha256: "abc123",
    sourcePath: "/tmp/composition/weather_agent.py",
    origin: "store",
    detail: { stack: "default" },
  });

  assert.deepEqual(writes, ["turns", "tools_called", "agents"]);
  assert.deepEqual(
    rows(
      ledger.databasePath,
      "SELECT session_id, surface, role, content, model, request_id FROM turns",
    ),
    [{
      session_id: "session-1",
      surface: "brainstem",
      role: "user",
      content: "what's the weather here",
      model: "scripted",
      request_id: "request-1",
    }],
  );
  assert.deepEqual(
    rows(
      ledger.databasePath,
      "SELECT session_id, tool_name, ok, summary FROM tools_called",
    ),
    [{
      session_id: "session-1",
      tool_name: "WeatherAgent",
      ok: 1,
      summary: "forecast returned",
    }],
  );
  assert.deepEqual(
    rows(ledger.databasePath, "SELECT sha256, path FROM sources"),
    [{
      sha256: "abc123",
      path: "/tmp/composition/weather_agent.py",
    }],
  );
  assert.equal(ledger.recentAgentEvents().length, 1);
  assert.equal(ledger.describe().recent_agents[0].tool_name, "WeatherAgent");

  const mirror = readFileSync(ledger.mirrorPath, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    mirror.map(({ table }) => table),
    ["turns", "tools_called", "agents", "sources"],
  );
  assert.equal(mirror[2].detail, '{"stack":"default"}');
});

test("ledger retention bounds rows, mirror bytes, content, and source archives", (t) => {
  const betaHome = scratch(t, "rapp-ledger-retention-");
  const ledger = openLedger(betaHome, {
    now: () => "2026-08-20T20:12:00.000Z",
    retention: {
      maxAgentRows: 2,
      maxMirrorBytes: 400,
      maxToolRows: 2,
      maxTurnRows: 2,
      pruneEveryWrites: 1,
    },
  });
  t.after(() => ledger.close());
  const archives = [];

  for (let index = 1; index <= 4; index += 1) {
    const archived = ledger.archiveAgentSource({
      filename: `agent_${index}_agent.py`,
      source: `class Agent${index}:\n    value = ${index}\n`,
    });
    archives.push(archived);
    ledger.recordAgent({
      event: "installed",
      filename: `agent_${index}_agent.py`,
      sha256: archived.sha256,
      sourcePath: archived.path,
    });
    ledger.recordTurn({
      content: index === 4
        ? "x".repeat(ledgerInternals.MAX_TURN_CONTENT_BYTES + 100)
        : `turn ${index}`,
      role: "user",
      surface: "brainstem",
    });
    ledger.recordToolCall({
      ok: true,
      summary: `tool ${index}`,
      toolName: `Tool${index}`,
    });
  }

  assert.deepEqual(
    rows(
      ledger.databasePath,
      `
        SELECT
          (SELECT count(*) FROM agents) AS agents,
          (SELECT count(*) FROM sources) AS sources,
          (SELECT count(*) FROM tools_called) AS tools,
          (SELECT count(*) FROM turns) AS turns
      `,
    ),
    [{ agents: 2, sources: 2, tools: 2, turns: 2 }],
  );
  const retainedContent = rows(
    ledger.databasePath,
    "SELECT content FROM turns ORDER BY id DESC LIMIT 1",
  )[0].content;
  assert.equal(
    Buffer.byteLength(retainedContent, "utf8"),
    ledgerInternals.MAX_TURN_CONTENT_BYTES,
  );
  assert.match(retainedContent, /\[ledger entry truncated\]$/);

  assert.ok(!existsSync(archives[0].path));
  assert.ok(!existsSync(archives[1].path));
  assert.ok(existsSync(archives[2].path));
  assert.ok(existsSync(archives[3].path));
  assert.equal(
    readdirSync(path.join(betaHome, "ledger-sources")).length,
    2,
  );

  const mirror = readFileSync(ledger.mirrorPath, "utf8");
  assert.ok(Buffer.byteLength(mirror) <= 400);
  for (const line of mirror.trim().split("\n").filter(Boolean)) {
    assert.doesNotThrow(() => JSON.parse(line));
  }
});

test("every persisted ledger field passes through credential redaction", (t) => {
  const betaHome = scratch(t);
  const ledger = openLedger(betaHome, {
    now: () => "2026-08-20T20:13:00.000Z",
  });
  t.after(() => ledger.close());
  const credential = "******";

  ledger.recordTurn({
    sessionId: "session-redaction",
    surface: "surgeon",
    role: "user",
    content: `use token=${credential}`,
    model: "scripted",
    requestId: "request-redaction",
  });
  ledger.recordToolCall({
    sessionId: "session-redaction",
    toolName: "WeatherAgent",
    ok: false,
    summary: `Authorization: ******`,
  });
  ledger.recordAgent({
    event: "installed",
    filename: "weather_agent.py",
    toolName: "WeatherAgent",
    sha256: "abc123",
    sourcePath: "/tmp/weather_agent.py",
    origin: "surgeon",
    detail: `password=${credential}`,
  });
  const archived = ledger.archiveAgentSource({
    filename: "credential_agent.py",
    source: `TOKEN = "${credential}"\n`,
  });

  const persisted = [
    readFileSync(ledger.mirrorPath, "utf8"),
    readFileSync(archived.path, "utf8"),
    JSON.stringify(rows(
      ledger.databasePath,
      "SELECT content FROM turns UNION ALL SELECT summary FROM tools_called UNION ALL SELECT detail FROM agents",
    )),
  ].join("\n");
  assert.doesNotMatch(persisted, /ghp_/);
  assert.doesNotMatch(persisted, /authorizationSecret/);
  assert.match(persisted, /\[redacted:token\]/);
  assert.match(persisted, /\[redacted:authorization\]/);
  assert.match(persisted, /\[redacted:password\]/);
  assert.match(readFileSync(archived.path, "utf8"), /\[redacted:token\]/);
  if (process.platform !== "win32") {
    assert.equal(statSync(archived.path).mode & 0o777, 0o600);
  }
});

test("ledger initialization and write failures are isolated and logged once", (t) => {
  const root = scratch(t, "rapp-ledger-failure-");
  const blocked = path.join(root, "not-a-directory");
  writeFileSync(blocked, "occupied");
  const messages = [];

  let ledger;
  assert.doesNotThrow(() => {
    ledger = openLedger(blocked, {
      logger: { error: (message) => messages.push(message) },
    });
  });
  assert.doesNotThrow(() => {
    ledger.recordTurn({
      surface: "brainstem",
      role: "user",
      content: "still serving",
    });
    ledger.recordAgent({ event: "installed" });
    ledger.recordToolCall({ toolName: "TestAgent", ok: true });
    ledger.close();
  });
  assert.equal(messages.length, 1);
  assert.match(messages[0], /^\[ledger\] /);

  const writable = path.join(root, "writable");
  mkdirSync(writable);
  const invalidRows = [];
  const writableLedger = openLedger(writable, {
    logger: { error: (message) => invalidRows.push(message) },
  });
  t.after(() => writableLedger.close());
  assert.equal(writableLedger.recordTurn({
    surface: "",
    role: "user",
    content: "invalid surface",
  }), null);
  assert.equal(writableLedger.recordToolCall({
    toolName: "",
    ok: true,
  }), null);
  assert.equal(invalidRows.length, 1);
});

test("completed turns normalize tool logs and persist both roles at the terminal event", (t) => {
  const betaHome = scratch(t, "rapp-ledger-complete-");
  const ledger = openLedger(betaHome, {
    now: () => "2026-08-20T20:14:00.000Z",
  });
  t.after(() => ledger.close());

  assert.equal(
    inferAgentToolName(
      "class WeatherAgent:\n    def __init__(self):\n        self.name = \"Weather\"\n",
      "weather_agent.py",
    ),
    "Weather",
  );
  assert.equal(
    inferAgentToolName([
      "TEMPLATE = '''",
      "class GeneratedAgent:",
      "    def __init__(self):",
      "        self.name = \"{cls}\"",
      "'''",
      "class AgentMigration(BasicAgent):",
      "    def __init__(self):",
      "        self.name = \"AgentMigration\"",
      "",
    ].join("\n"), "agent_migration_agent.py"),
    "AgentMigration",
  );
  assert.deepEqual(parseAgentLogs([
    { tool_name: "ArrayTool", ok: true, summary: "array result" },
  ]), [{
    tool_name: "ArrayTool",
    ok: true,
    summary: "array result",
  }]);
  assert.deepEqual(
    parseAgentLogs(
      "[WeatherAgent] deterministic forecast\n"
        + "[PinDrop] ERROR: destination refused\n"
        + "continuation text",
    ),
    [
      {
        tool_name: "WeatherAgent",
        ok: true,
        summary: "deterministic forecast",
      },
      {
        tool_name: "PinDrop",
        ok: false,
        // The continuation line belongs to PinDrop's result: the kernel
        // inlines the whole result after the tool name, so a line that does
        // not open a new tool call is part of the one above it.
        summary: "ERROR: destination refused\ncontinuation text",
      },
    ],
  );

  const recorded = recordCompletedTurn(ledger, {
    agentLogs: "[WeatherAgent] deterministic forecast",
    model: "scripted",
    requestId: "request-terminal",
    response: "sunny",
    sessionId: "session-terminal",
    surface: "brainstem",
    userInput: "what's the weather here",
  });
  assert.equal(recorded.turns.length, 2);
  assert.equal(recorded.tools.length, 1);
  assert.deepEqual(
    rows(
      ledger.databasePath,
      "SELECT role, content FROM turns ORDER BY id",
    ),
    [
      { role: "user", content: "what's the weather here" },
      { role: "assistant", content: "sunny" },
    ],
  );
});

test("route lifecycle telemetry becomes complete agent and source rows", (t) => {
  const betaHome = scratch(t, "rapp-ledger-routes-");
  const ledger = openLedger(betaHome, {
    now: () => "2026-08-20T20:15:00.000Z",
  });
  t.after(() => ledger.close());
  const sourcePath = path.join(betaHome, "routing", "objects", "weather.py");

  const installed = ledger.recordRouteEvent({
    type: "stack-agent-installed",
    timestamp: "2026-08-20T20:15:00.000Z",
    filename: "weather_agent.py",
    tool_name: "WeatherAgent",
    rappid: "rappid:@microsoft/weather",
    sha256: "weather-sha",
    source_path: sourcePath,
    origin: "store",
  });
  const removed = ledger.recordRouteEvent({
    type: "stack-agent-removed",
    timestamp: "2026-08-20T20:16:00.000Z",
    filename: "weather_agent.py",
    tool_name: "WeatherAgent",
    rappid: "rappid:@microsoft/weather",
    sha256: "weather-sha",
    source_path: sourcePath,
    origin: "store",
  });
  const noChange = ledger.recordRouteEvent({
    type: "lineage-promote",
    timestamp: "2026-08-20T20:17:00.000Z",
    agent_rows: [],
    changed: 0,
  });
  assert.equal(installed.length, 1);
  assert.equal(removed.length, 1);
  assert.equal(noChange.length, 0);
  assert.deepEqual(
    rows(
      ledger.databasePath,
      "SELECT event, tool_name, rappid, sha256, source_path, origin FROM agents ORDER BY id",
    ),
    [
      {
        event: "installed",
        tool_name: "WeatherAgent",
        rappid: "rappid:@microsoft/weather",
        sha256: "weather-sha",
        source_path: sourcePath,
        origin: "store",
      },
      {
        event: "removed",
        tool_name: "WeatherAgent",
        rappid: "rappid:@microsoft/weather",
        sha256: "weather-sha",
        source_path: sourcePath,
        origin: "store",
      },
    ],
  );
  assert.equal(
    rows(ledger.databasePath, "SELECT count(*) AS total FROM sources")[0].total,
    1,
  );
});

test("main, preload, and renderer keep completed Brainstem and Surgeon feeds explicit", () => {
  const main = readFileSync(
    new URL("../electron/main.mjs", import.meta.url),
    "utf8",
  );
  const preload = readFileSync(
    new URL("../electron/preload.cjs", import.meta.url),
    "utf8",
  );
  const renderer = readFileSync(
    new URL("../ui/renderer.js", import.meta.url),
    "utf8",
  );
  assert.match(main, /ipcMain\.handle\("beta:record-brainstem-turn"/);
  assert.match(main, /surface: "brainstem"/);
  assert.match(main, /surface: "surgeon"/);
  assert.match(main, /surface: `twin:\$\{twin\.id\}`/);
  assert.match(main, /recordCompletedTurn\(ledger/);
  assert.match(preload, /recordBrainstemTurn:/);
  assert.match(preload, /recordTwinTurn:/);
  assert.match(renderer, /type === "rapp-beta:ledger-turn"/);
  assert.match(renderer, /rapp-beta:twin-ledger-turn/);
  assert.match(main, /completedBrainstemRequests/);
  assert.match(renderer, /pendingLineageReply\.userInput/);
  assert.match(renderer, /brainstemBeta\.recordBrainstemTurn/);
});

test("human ledger paths never quote a non-expanding home shortcut", () => {
  const home = "/Users/Proof User";
  const spaced = `${home}/Library/Application Support/RAPP/ledger.sqlite`;
  assert.equal(
    ledgerInternals.ledgerShellPath(spaced, {
      home,
      platform: "darwin",
    }),
    `"${spaced}"`,
  );
  const windows = "C:\\Users\\Proof User\\.brainstem\\beta-launcher\\ledger.sqlite";
  assert.equal(
    ledgerInternals.ledgerShellPath(windows, {
      home: "C:\\Users\\Proof User",
      platform: "win32",
    }),
    `"${windows}"`,
  );
});

test("a multi-line tool result is one tool call, not one per line", () => {
  // The kernel inlines a tool's ENTIRE result after `[toolName]`, so the
  // result may span lines that themselves begin with a bracket. Treating each
  // such line as its own call fabricated thousands of rows from one call and
  // blocked the main thread while writing them.
  const logs = ["[ReadLogAgent] tail follows"]
    .concat(Array.from(
      { length: 3000 },
      (_, index) => `[2026-08-20 10:${String(index % 60).padStart(2, "0")}:00] worker ${index} finished`,
    ))
    .join("\n");
  const rows = parseAgentLogs(logs);
  assert.equal(rows.length, 1, "one tool call produces one row");
  assert.equal(rows[0].tool_name, "ReadLogAgent");
  assert.match(rows[0].summary, /tail follows/);

  // ...and the continuation lines are kept, not silently dropped.
  const multi = parseAgentLogs("[Reader] line one\nline two\nline three");
  assert.equal(multi.length, 1);
  assert.equal(multi[0].summary, "line one\nline two\nline three");

  // Real consecutive tool calls are still separate rows.
  assert.deepEqual(
    parseAgentLogs("[Alpha] did a thing\n[Beta] did another").map((row) => row.tool_name),
    ["Alpha", "Beta"],
  );

  // And a turn cannot describe an unbounded number of calls.
  assert.equal(
    parseAgentLogs(Array.from({ length: 500 }, (_, i) => `[Tool${i}] x`).join("\n")).length,
    64,
  );
});
