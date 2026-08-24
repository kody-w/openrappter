import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  acquirePlanLock,
  SemanticTrace,
  SemanticUiPlanRunner,
  validateSemanticPlan,
} from "../electron/semantic-ui-plan.mjs";

const validPlan = {
  schema: "openrappter-ui-plan/1.0",
  name: "bookfactory",
  actions: [
    { action: "inspect_state", target: "shell" },
    { action: "select_store_item", id: "bookfactory" },
    { action: "hatch", id: "bookfactory" },
    { action: "wait_status", status: "ready" },
    {
      action: "send_chat",
      text: "write a fixture chapter",
      waitText: "BOOKFACTORY_FIXTURE_REPLY",
    },
    { action: "assert_visible_text", text: "BOOKFACTORY_FIXTURE_REPLY" },
    { action: "screenshot", name: "bookfactory-ready" },
  ],
};

test("semantic plans accept only the closed action catalog", () => {
  const normalized = validateSemanticPlan(validPlan);
  assert.equal(normalized.actions.length, 7);
  assert.equal(normalized.actions[1].id, "bookfactory");
  assert.equal(normalized.actions[6].name, "bookfactory-ready");

  for (const bad of [
    { ...validPlan, eval: "alert(1)" },
    {
      ...validPlan,
      actions: [{ action: "javascript", source: "alert(1)" }],
    },
    {
      ...validPlan,
      actions: [{ action: "click_known", selector: "#send" }],
    },
    {
      ...validPlan,
      actions: [{ action: "click_known", handle: "@unknown.control" }],
    },
    {
      ...validPlan,
      actions: [{ action: "install", id: "bookfactory", approved: true }],
    },
    {
      ...validPlan,
      actions: [{ action: "screenshot", name: "../escape" }],
    },
    {
      ...validPlan,
      actions: [{ action: "inspect_state", completion: "forged" }],
    },
  ]) {
    assert.throws(() => validateSemanticPlan(bad), /Invalid semantic UI plan/);
  }
});

test("semantic plans bound actions, bytes, text, and time", () => {
  assert.throws(
    () => validateSemanticPlan({ ...validPlan, actions: Array(41).fill({ action: "inspect_state" }) }),
    /1 through 40/,
  );
  assert.throws(
    () => validateSemanticPlan({ ...validPlan, timeoutMs: 600001 }),
    /1000 through 600000/,
  );
  assert.throws(
    () => validateSemanticPlan({
      ...validPlan,
      actions: [{ action: "send_chat", text: "x".repeat(16 * 1024 + 1) }],
    }),
    /exceeds 16384/,
  );
  assert.throws(
    () => validateSemanticPlan({
      ...validPlan,
      actions: [{ action: "assert_visible_text", text: "x".repeat(4097) }],
    }),
    /exceeds 4096/,
  );
});

test("semantic runner drives the existing UI-driver protocol end to end", async () => {
  let hatched = false;
  let replied = false;
  const commands = [];
  const command = async (value) => {
    commands.push(value);
    if (value.action === "inspect") {
      return {
        rows: [
          ...(hatched
            ? [{
                h: "@twin[bookfactory-1].tile",
                name: `BookFactory ready ${replied ? "BOOKFACTORY_FIXTURE_REPLY" : ""}`,
                state: "enabled",
              }]
            : []),
        ],
      };
    }
    if (value.action === "run") {
      const clicked = value.steps?.find((step) => step.handle?.endsWith(".hatch"));
      if (clicked) hatched = true;
      const sent = value.steps?.find((step) => step.handle?.endsWith(".send"));
      if (sent) replied = true;
      return { results: value.steps.map(() => ({ ok: true })) };
    }
    if (value.action === "wait") return { matched: true };
    if (value.action === "screenshot") {
      return { path: "artifacts/bookfactory-ready.png" };
    }
    throw new Error(`unexpected command ${value.action}`);
  };
  const events = [];
  const runner = new SemanticUiPlanRunner({
    command,
    record: (event) => events.push(event),
  });

  const result = await runner.run(validPlan);

  assert.equal(result.ok, true);
  assert.equal(result.ran, validPlan.actions.length);
  assert.equal(runner.twinId, "bookfactory-1");
  assert.equal(events.length, validPlan.actions.length);
  assert(commands.some((value) => (
    value.action === "run"
    && value.steps?.some((step) => step.handle === "@store[bookfactory].hatch")
  )));
  assert(commands.some((value) => (
    value.action === "run"
    && value.steps?.some((step) => step.handle === "@twin[bookfactory-1].send")
  )));
  assert(commands.some((value) => value.action === "screenshot"));
});

test("semantic runner refuses user handoff and stale frame failures", async () => {
  const yielded = new SemanticUiPlanRunner({
    command: async () => ({ ok: true, reason: "yielded_to_user" }),
  });
  await assert.rejects(
    () => yielded.run({
      schema: "openrappter-ui-plan/1.0",
      actions: [{ action: "click_known", handle: "@shell.enter" }],
    }),
    /Visible UI action failed/,
  );

  const stale = new SemanticUiPlanRunner({
    command: async () => {
      throw new Error("The target frame navigated before the command finished.");
    },
  });
  await assert.rejects(
    () => stale.run({
      schema: "openrappter-ui-plan/1.0",
      actions: [{ action: "inspect_state" }],
    }),
    /navigated before/,
  );
});

test("semantic plan lock rejects simultaneous plans and recovers stale locks", () => {
  const root = mkdtempSync(path.join(tmpdir(), "semantic-plan-lock-"));
  const lock = path.join(root, "plan.lock");
  try {
    const release = acquirePlanLock(lock);
    assert.throws(() => acquirePlanLock(lock), /already active/);
    release();
    const releaseAgain = acquirePlanLock(lock);
    releaseAgain();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("semantic traces redact credentials and local roots", () => {
  const root = mkdtempSync(path.join(tmpdir(), "semantic-trace-"));
  const tracePath = path.join(root, "trace.jsonl");
  try {
    mkdirSync(path.dirname(tracePath), { recursive: true });
    const trace = new SemanticTrace({ filePath: tracePath, roots: [root] });
    trace.record({
      action: "inspect_state",
      result: {
        path: path.join(root, "secret.txt"),
        token: "never-write-this",
        url: "http://127.0.0.1:7071/path?code=secret",
      },
    });
    const text = readFileSync(tracePath, "utf8");
    assert.doesNotMatch(text, /never-write-this|code=secret/);
    assert.equal(text.includes(root), false);
    assert.match(text, /\[redacted:token\]|<REDACTED_PATH>/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("headless CLI validates plans and exits nonzero on malformed input", () => {
  const root = mkdtempSync(path.join(tmpdir(), "semantic-cli-"));
  try {
    const good = path.join(root, "good.json");
    const bad = path.join(root, "bad.json");
    writeFileSync(good, JSON.stringify(validPlan));
    writeFileSync(bad, JSON.stringify({
      schema: "openrappter-ui-plan/1.0",
      actions: [{ action: "javascript", source: "SECRET_SCRIPT_BODY" }],
    }));
    const script = path.resolve("scripts/frontier-ui.mjs");
    const accepted = spawnSync(process.execPath, [
      script,
      "--plan",
      good,
      "--validate-only",
    ], { cwd: path.resolve("."), encoding: "utf8" });
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.match(accepted.stdout, /"ok":true/);
    const rejected = spawnSync(process.execPath, [
      script,
      "--plan",
      bad,
      "--validate-only",
    ], { cwd: path.resolve("."), encoding: "utf8" });
    assert.notEqual(rejected.status, 0);
    assert.doesNotMatch(rejected.stderr, /SECRET_SCRIPT_BODY/);
    assert.match(rejected.stderr, /Invalid semantic UI plan/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
