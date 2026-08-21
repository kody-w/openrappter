import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  LineageStore,
  lineageStoreInternals,
} from "../electron/lineage-store.mjs";
import {
  executeLineageCommand,
  lineageControlReplies,
  parseLineageCommand,
} from "../electron/lineage-control.mjs";
import { BetaRouteManager } from "../electron/route-manager.mjs";


const betaRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function managerFixture({
  changed = 1,
  unchanged = 0,
  failed = [],
  promotion = null,
  drift = null,
  environments = null,
} = {}) {
  const calls = [];
  // The real route manager returns a report saying what actually moved. A double
  // that returns nothing makes every command look like a no-op, which is exactly
  // the state the honest-reporting rules are meant to detect — so it has to
  // model a real move by default.
  const report = () => ({
    disabled: false,
    changed: Array.from({ length: changed }, (_, i) => `rappid:@grail/a${i}:x`),
    unchanged: Array.from({ length: unchanged }, (_, i) => `rappid:@grail/u${i}:x`),
    failed,
  });
  return {
    calls,
    manager: {
      rollbackLineage: () => { calls.push("baseline"); return report(); },
      restoreLineage: () => { calls.push("restore"); return report(); },
      lineageEnvironments: () => {
        calls.push("environments");
        return environments || {
          disabled: false,
          loci: [{
            ancestorRappid: "rappid:@grail/echo:" + "a".repeat(64),
            filename: "echo_agent.py",
            environments: [
              {
                env: "default",
                head: "rappid:@grail/echo:" + "a".repeat(64),
                isBaseline: true,
              },
              {
                env: "prod",
                head: "rappid:@frontier/echo-ring:" + "b".repeat(64),
                isBaseline: false,
              },
            ],
          }],
        };
      },
      promoteLineage: (options) => {
        calls.push(`promote:${options.fromEnv}:${options.toEnv}`);
        return promotion || {
          disabled: false,
          changed: ["rappid:@grail/echo:" + "a".repeat(64)],
          unchanged: [],
          conflicts: [],
          failed: [],
          fromEnv: options.fromEnv,
          toEnv: options.toEnv,
        };
      },
      lineageDrift: (environment) => {
        calls.push(`drift:${environment}`);
        return drift || {
          disabled: false,
          env: environment,
          baseEnv: "default",
          drifted: [],
          loci: [],
        };
      },
      startDefault: async () => {
        calls.push("materialize");
        return {
          compositionHash: "composed",
          url: "http://127.0.0.1:7001",
        };
      },
    },
  };
}

test("control-word interceptor matches only the exact trimmed word", async () => {
  assert.equal(parseLineageCommand("talk about baseline"), null);
  assert.equal(parseLineageCommand("baseline please"), null);
  assert.equal(parseLineageCommand("BASELINE"), null);
  assert.deepEqual(parseLineageCommand("  baseline \n"), {
    action: "baseline",
    original: "  baseline \n",
    word: "baseline",
  });

  const { calls, manager } = managerFixture();
  const ordinary = "please keep the baseline behavior in this answer";
  assert.deepEqual(
    await executeLineageCommand({ message: ordinary, routeManager: manager }),
    { intercepted: false, message: ordinary },
  );
  assert.deepEqual(calls, [], "normal chat must pass without any lineage action");

  const reverted = await executeLineageCommand({
    message: "baseline",
    routeManager: manager,
  });
  assert.equal(reverted.intercepted, true);
  assert.equal(reverted.reply, lineageControlReplies.baseline);
  assert.deepEqual(calls, ["baseline", "materialize"]);
});

test("ordinary promote and drift messages fail open to chat", async () => {
  const { calls, manager } = managerFixture();
  for (const message of [
    "promote",
    "drift",
    "promote this agent",
    "promote default behavior",
    "drift report",
  ]) {
    assert.deepEqual(
      await executeLineageCommand({ message, routeManager: manager }),
      { intercepted: false, message },
    );
  }
  assert.doesNotMatch(calls.join(","), /promote:|drift:|materialize/);
});

test("control-word interceptor honors custom baseline and restore words", async () => {
  const env = {
    RAPP_BASELINE_SAFEWORD: "factory settings",
    RAPP_RESTORE_WORD: "grow again",
  };
  assert.equal(parseLineageCommand("baseline", env), null);
  assert.equal(
    parseLineageCommand(" factory settings ", env).action,
    "baseline",
  );
  assert.equal(parseLineageCommand("grow again", env).action, "restore");

  const { calls, manager } = managerFixture();
  const restored = await executeLineageCommand({
    message: "grow again",
    routeManager: manager,
    env,
  });
  assert.equal(restored.reply, lineageControlReplies.restore);
  assert.deepEqual(calls, ["restore", "materialize"]);
});

test("ALM chat words parse exactly and honor configured command words", () => {
  assert.deepEqual(parseLineageCommand("promote default prod"), {
    action: "promote",
    original: "promote default prod",
    word: "promote",
    fromEnv: "default",
    toEnv: "prod",
  });
  assert.deepEqual(parseLineageCommand("drift prod"), {
    action: "drift",
    original: "drift prod",
    word: "drift",
    env: "prod",
  });
  assert.equal(parseLineageCommand("talk about environments"), null);
  assert.equal(parseLineageCommand("promoted default prod"), null);
  assert.equal(parseLineageCommand("environments").action, "environments");
  assert.equal(parseLineageCommand("promote"), null);
  assert.equal(parseLineageCommand("drift prod extra"), null);

  const env = {
    RAPP_ENVIRONMENTS_WORD: "show rings",
    RAPP_PROMOTE_WORD: "ship",
    RAPP_DRIFT_WORD: "compare",
  };
  assert.equal(parseLineageCommand("environments", env), null);
  assert.equal(parseLineageCommand("show rings", env).action, "environments");
  assert.deepEqual(parseLineageCommand("ship dev production", env), {
    action: "promote",
    original: "ship dev production",
    word: "ship",
    fromEnv: "dev",
    toEnv: "production",
  });
  assert.equal(parseLineageCommand("compare production", env).action, "drift");
});

test("environment, promotion, and drift commands return honest wire results", async () => {
  const listedRun = managerFixture();
  const listed = await executeLineageCommand({
    message: "environments",
    routeManager: listedRun.manager,
  });
  assert.equal(listed.intercepted, true);
  assert.equal(listed.action, "environments");
  assert.match(listed.reply, /echo_agent\.py: default → baseline, prod → b{8}/);
  assert.equal(listed.environments.length, 1);
  assert.deepEqual(listedRun.calls, ["environments"]);

  const promotedRun = managerFixture();
  const promoted = await executeLineageCommand({
    message: "promote default prod",
    routeManager: promotedRun.manager,
  });
  assert.deepEqual(promotedRun.calls, [
    "promote:default:prod",
    "materialize",
  ]);
  assert.equal(promoted.changed, 1);
  assert.equal(promoted.unchanged, 0);
  assert.equal(promoted.fromEnv, "default");
  assert.equal(promoted.toEnv, "prod");
  assert.match(promoted.reply, /Promoted 1 agents to prod\./);
  assert.equal(promoted.compositionHash, "composed");
  assert.equal(promoted.url, "http://127.0.0.1:7001");

  const driftRun = managerFixture();
  const drift = await executeLineageCommand({
    message: "drift prod",
    routeManager: driftRun.manager,
  });
  assert.equal(drift.action, "drift");
  assert.match(drift.reply, /No drift detected in prod against default/);
  assert.deepEqual(driftRun.calls, ["drift:prod"]);
});

test("promotion conflicts name the agent and never claim a move", async () => {
  const conflictRun = managerFixture({
    promotion: {
      disabled: false,
      changed: [],
      unchanged: [],
      conflicts: [{
        ancestorRappid: "rappid:@grail/echo:" + "a".repeat(64),
        filename: "echo_agent.py",
        conflict: true,
      }],
      failed: [],
      fromEnv: "default",
      toEnv: "prod",
    },
  });
  const result = await executeLineageCommand({
    message: "promote default prod",
    routeManager: conflictRun.manager,
  });
  assert.match(
    result.reply,
    /CONFLICT on echo_agent\.py: prod has a molt default never built on — nothing moved/,
  );
  assert.equal(result.changed, 0);
  assert.equal(result.conflicts.length, 1);
});

test("every ALM chat command reports the call-time kill switch", async () => {
  for (const message of [
    "environments",
    "promote default prod",
    "drift prod",
  ]) {
    const run = managerFixture({
      environments: { disabled: true, loci: [] },
      promotion: {
        disabled: true,
        changed: [],
        unchanged: [],
        conflicts: [],
        failed: [],
        fromEnv: "default",
        toEnv: "prod",
      },
      drift: {
        disabled: true,
        env: "prod",
        baseEnv: "default",
        drifted: [],
        loci: [],
      },
    });
    const result = await executeLineageCommand({
      message,
      routeManager: run.manager,
    });
    assert.equal(result.disabled, true);
    assert.equal(result.reply, lineageControlReplies.disabled);
    assert.doesNotMatch(run.calls.join(","), /materialize/);
  }
});

test("lineage commands round-trip the full wire result shape", async () => {
  // The frame bridge forwards this result verbatim over postMessage and
  // fabricates the /chat and /chat/stream responses from result.reply, so the
  // exact shape IS the wire protocol.
  const baselineRun = managerFixture();
  const baseline = await executeLineageCommand({
    message: "baseline",
    routeManager: baselineRun.manager,
  });
  assert.deepEqual(baseline, {
    intercepted: true,
    action: "baseline",
    fallback: null,
    reply: lineageControlReplies.baseline,
    compositionHash: "composed",
    restored: undefined,
    // changed/unchanged are part of the wire shape: they are what lets a caller
    // tell a real restore from one that moved nothing.
    changed: 1,
    unchanged: 0,
    url: "http://127.0.0.1:7001",
  });
  assert.deepEqual(baselineRun.calls, ["baseline", "materialize"]);

  const restoreRun = managerFixture();
  const restored = await executeLineageCommand({
    message: "restore",
    routeManager: restoreRun.manager,
  });
  assert.equal(restored.intercepted, true);
  assert.equal(restored.action, "restore");
  assert.equal(restored.reply, lineageControlReplies.restore);
  assert.equal(restored.restored, true);
  assert.equal(restored.compositionHash, "composed");
  assert.equal(restored.url, "http://127.0.0.1:7001");
  assert.deepEqual(restoreRun.calls, ["restore", "materialize"]);
});

test("default control words pass through untouched when custom words are configured", async () => {
  const env = {
    RAPP_BASELINE_SAFEWORD: "factory settings",
    RAPP_RESTORE_WORD: "grow again",
  };
  const { calls, manager } = managerFixture();
  const passed = await executeLineageCommand({
    message: "restore",
    routeManager: manager,
    env,
  });
  assert.deepEqual(passed, { intercepted: false, message: "restore" });
  assert.deepEqual(calls, [], "the default word must reach Grail untouched");

  const reset = await executeLineageCommand({
    message: " factory settings ",
    routeManager: manager,
    env,
  });
  assert.equal(reset.action, "baseline");
  assert.equal(reset.reply, lineageControlReplies.baseline);
  assert.deepEqual(calls, ["baseline", "materialize"]);
});

test("a partially compatible restore reports the kept-last-good compromise", async () => {
  const { calls, manager } = managerFixture();
  manager.lastLineageFallback = {
    accepted: ["rappid:@frontier/good-ring:cafef00d"],
    rejected: ["rappid:@frontier/bad-ring:deadbeef"],
    strategy: "last-good",
  };
  const result = await executeLineageCommand({
    message: "restore",
    routeManager: manager,
  });
  assert.equal(result.intercepted, true);
  assert.equal(result.restored, false);
  assert.notEqual(result.reply, lineageControlReplies.restore);
  assert.match(result.reply, /compatible verified molts.*incompatible rings/i);
  assert.deepEqual(result.fallback, manager.lastLineageFallback);
  assert.deepEqual(calls, ["restore", "materialize"]);
});

test("baseline never reports a partial restore even with fallback state", async () => {
  const { manager } = managerFixture();
  manager.lastLineageFallback = {
    accepted: [],
    rejected: ["rappid:@frontier/bad-ring:deadbeef"],
    strategy: "last-good",
  };
  const result = await executeLineageCommand({
    message: "baseline",
    routeManager: manager,
  });
  assert.equal(result.reply, lineageControlReplies.baseline);
  assert.equal(result.restored, undefined);
});

test("a control word without the route manager is an error, not a silent pass", async () => {
  await assert.rejects(
    executeLineageCommand({ message: "restore" }),
    /Frontier route manager/,
  );
});

test("restore reports a refused composition instead of claiming success", async () => {
  const { manager } = managerFixture();
  manager.lastLineageFallback = {
    accepted: [],
    rejected: ["rappid:@frontier/bad-ring:deadbeef"],
    strategy: "last-good",
  };
  const result = await executeLineageCommand({
    message: "restore",
    routeManager: manager,
  });
  assert.equal(result.restored, false);
  assert.notEqual(result.reply, lineageControlReplies.restore);
  assert.match(result.reply, /could not activate.*last-good/i);
});

test("restore cannot move a newer live ring back through stale PRIOR_HEAD", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "rapp-lineage-control-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const brainstemDir = path.join(root, "brainstem");
  mkdirSync(path.join(brainstemDir, "agents"), { recursive: true });
  writeFileSync(
    path.join(brainstemDir, "agents", "alpha_agent.py"),
    "ALPHA = 'baseline'\n",
  );
  const store = new LineageStore({
    brainstemDir,
    root: path.join(root, "lineage"),
  });
  const alpha = store.baselineAncestors()[0];
  const first = store.appendRing(alpha.ancestorRappid, {
    source: "ALPHA = 'first'\n",
    verified: true,
  });
  store.setHead(alpha.ancestorRappid, first);
  store.rollbackToBaseline(alpha.ancestorRappid);
  const newer = store.appendRing(alpha.ancestorRappid, {
    source: "ALPHA = 'newer'\n",
    parentRappid: first,
    verified: true,
  });
  const locusDirectory = path.join(
    store.root,
    lineageStoreInternals.filesystemSegment(alpha.ancestorRappid),
  );
  const headPath = path.join(locusDirectory, "HEAD");
  const priorPath = path.join(locusDirectory, "PRIOR_HEAD");
  rmSync(headPath);
  mkdirSync(headPath);
  // The fault: HEAD replaced by a directory. POSIX reports EISDIR/ENOTDIR; Windows
  // refuses the same atomic rename with EPERM/EEXIST. The claim is the same on
  // both: the write fails and the recovery point survives.
  assert.throws(
    () => store.setHead(alpha.ancestorRappid, newer),
    /directory|EISDIR|ENOTDIR|EPERM|EEXIST|EACCES|EBUSY/i,
  );
  assert.equal(
    readFileSync(priorPath, "utf8").trim(),
    first,
    "a failed forward write must preserve the rollback recovery point",
  );
  rmSync(headPath, { recursive: true });
  writeFileSync(headPath, `${alpha.ancestorRappid}\n`);
  store.setHead(alpha.ancestorRappid, newer);

  const result = await executeLineageCommand({
    message: "restore",
    routeManager: {
      restoreLineage: () => store.restore(alpha.ancestorRappid),
      startDefault: async () => ({
        compositionHash: "newer-composition",
        url: "http://127.0.0.1:7001",
      }),
      lastLineageFallback: null,
    },
  });

  assert.equal(result.changed, 0);
  assert.match(result.reply, /nothing to restore/i);
  assert.equal(store.getHead(alpha.ancestorRappid), newer);
});

test("restore reports no change when a missing HEAD already resolves to baseline", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "rapp-lineage-control-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const brainstemDir = path.join(root, "brainstem");
  mkdirSync(path.join(brainstemDir, "agents"), { recursive: true });
  writeFileSync(
    path.join(brainstemDir, "agents", "alpha_agent.py"),
    "ALPHA = 'baseline'\n",
  );
  const store = new LineageStore({
    brainstemDir,
    root: path.join(root, "lineage"),
  });
  const alpha = store.baselineAncestors()[0];
  const ring = store.appendRing(alpha.ancestorRappid, {
    source: "ALPHA = 'gone'\n",
    verified: true,
  });
  store.setHead(alpha.ancestorRappid, ring);
  rmSync(path.join(
    store.root,
    lineageStoreInternals.filesystemSegment(alpha.ancestorRappid),
    "rings",
    lineageStoreInternals.filesystemSegment(ring),
  ), { recursive: true, force: true });
  assert.equal(store.resolveLive(alpha.ancestorRappid).isBaseline, true);

  const result = await executeLineageCommand({
    message: "restore",
    routeManager: {
      restoreLineage: () => store.restore(alpha.ancestorRappid),
      startDefault: async () => ({
        compositionHash: "baseline-composition",
        url: "http://127.0.0.1:7001",
      }),
      lastLineageFallback: null,
    },
  });

  assert.equal(result.changed, 0);
  assert.match(result.reply, /nothing to restore/i);
  assert.equal(store.resolveLive(alpha.ancestorRappid).isBaseline, true);
});

test("a control word returns before the lifecycle lock and restarts after release", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "rapp-lineage-control-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const brainstemDir = path.join(root, "brainstem");
  mkdirSync(path.join(brainstemDir, "agents"), { recursive: true });
  writeFileSync(
    path.join(brainstemDir, "agents", "alpha_agent.py"),
    "ALPHA = 'baseline'\n",
  );
  const store = new LineageStore({
    brainstemDir,
    root: path.join(root, "lineage"),
  });
  const alpha = store.baselineAncestors()[0];
  const ring = store.appendRing(alpha.ancestorRappid, {
    source: "ALPHA = 'live ring'\n",
    verified: true,
  });
  const manager = new BetaRouteManager({
    betaHome: path.join(root, "beta-home"),
    brainstemConfig: { brainstemDir, python: "/tmp/python" },
    lineageStore: store,
    seedLineageDefaults: false,
    compositionValidator: () => true,
  });
  manager.activeRoute = {
    compositionHash: "active-composition",
    url: "http://127.0.0.1:7001",
  };
  let releaseTask;
  let taskEntered;
  const entered = new Promise((resolve) => {
    taskEntered = resolve;
  });
  const heldTask = manager.withRouteLock("__lifecycle__", async () => {
    taskEntered();
    await new Promise((resolve) => {
      releaseTask = resolve;
    });
  });
  await entered;
  let starts = 0;
  let restartCalled;
  const restarted = new Promise((resolve) => {
    restartCalled = resolve;
  });
  manager.startDefaultUnlocked = async () => {
    starts += 1;
    restartCalled();
    return manager.activeRoute;
  };

  const startedAt = Date.now();
  const commandPromise = executeLineageCommand({
    message: "restore",
    routeManager: manager,
  });
  let timeoutId;
  const outcome = await Promise.race([
    commandPromise.then((value) => ({ value })),
    new Promise((resolve) => {
      timeoutId = setTimeout(() => resolve({ timedOut: true }), 500);
    }),
  ]);
  if (outcome.timedOut) {
    releaseTask();
    await heldTask;
    await commandPromise;
    assert.fail("control word waited behind the lifecycle lock");
  }
  clearTimeout(timeoutId);
  assert.ok(Date.now() - startedAt < 1000);
  assert.equal(starts, 0);
  assert.equal(store.getHead(alpha.ancestorRappid), ring);
  assert.equal(outcome.value.pending, true);
  assert.equal(outcome.value.restored, undefined);
  assert.notEqual(outcome.value.reply, lineageControlReplies.restore);
  assert.match(
    outcome.value.reply,
    /takes effect as soon as the current task finishes/,
  );

  releaseTask();
  await heldTask;
  await restarted;
  assert.equal(starts, 1);
});

test("renderer intercepts before Grail chat and main exposes the lineage IPC", () => {
  const renderer = readFileSync(
    path.join(betaRoot, "ui", "renderer.js"),
    "utf8",
  ).replaceAll("\r\n", "\n");
  const main = readFileSync(
    path.join(betaRoot, "electron", "main.mjs"),
    "utf8",
  ).replaceAll("\r\n", "\n");
  const preload = readFileSync(
    path.join(betaRoot, "electron", "preload.cjs"),
    "utf8",
  ).replaceAll("\r\n", "\n");
  assert.match(renderer, /type === "rapp-beta:lineage-chat"/);
  assert.match(renderer, /rapp-beta:lineage-confirmation-ack/);
  assert.match(renderer, /pendingLineageReply\.url !== loadedFrameUrl/);
  assert.match(renderer, /brainstemBeta\.lineageCommand/);
  assert.match(main, /beta:lineage-command/);
  assert.match(main, /beta:lineage-environments/);
  assert.match(main, /beta:lineage-promote/);
  assert.match(main, /beta:lineage-drift/);
  assert.match(main, /rapp-beta:lineage-confirmation-ack/);
  assert.match(main, /target\.pathname === "\/chat\/stream"/);
  assert.match(preload, /lineageCommand:/);
  assert.match(preload, /lineageEnvironments:/);
  assert.match(preload, /lineagePromote:/);
  assert.match(preload, /lineageDrift:/);
  // The synthetic /chat/stream done-frame the bridge fabricates must keep the
  // DOUBLE-escaped separator: the bridge lives inside a template literal, so
  // only \\n\\n in main.mjs source puts the \n\n escape into the injected
  // script and a real blank-line separator on the wire. A single-escaped
  // newline breaks Grail's SSE parser ("stream ended without done").
  assert.match(
    main,
    /const frame = "data: " \+ JSON\.stringify\(\{\s+type: "done",\s+response: result\.reply,\s+agent_logs: "",\s+streamed: false,\s+\}\) \+ "\\\\n\\\\n";/,
  );
  assert.match(main, /text\/event-stream/);
});
