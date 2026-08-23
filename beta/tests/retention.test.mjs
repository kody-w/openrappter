// Growth and retention. Measured on one developer machine before this change:
// routing/compositions 43 MB across 30 directories, 40 MB of it regenerable
// __pycache__ written by live workers; 35 worker logs never pruned.
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { buildWorkerEnvironment } from "../electron/brainstem-process.mjs";
import { LineageStore } from "../electron/lineage-store.mjs";
import { BetaRouteManager } from "../electron/route-manager.mjs";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), "rapp-retention-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const brainstemDir = path.join(root, "brainstem");
  mkdirSync(path.join(brainstemDir, "agents"), { recursive: true });
  for (const [name, source] of Object.entries({
    "basic_agent.py": "class BasicAgent: pass\n",
    "context_memory_agent.py": "class ContextMemoryAgent: pass\n",
    "manage_memory_agent.py": "class ManageMemoryAgent: pass\n",
    "global_agent.py": "GLOBAL = 'baseline'\n",
  })) {
    writeFileSync(path.join(brainstemDir, "agents", name), source);
  }
  const betaHome = path.join(root, "beta-home");
  const lineageRoot = path.join(root, "lineage");
  const store = new LineageStore({ brainstemDir, root: lineageRoot });
  const options = {
    betaHome,
    brainstemConfig: { brainstemDir, python: "/tmp/python" },
    lineageRoot,
    lineageStore: store,
    seedLineageDefaults: false,
    compositionValidator: () => true,
  };
  return { root, betaHome, options };
}

const hashOf = (index) => index.toString(16).padStart(64, "0");

function fakeComposition(betaHome, hash, ageMs, { pycache = true } = {}) {
  const dir = path.join(betaHome, "routing", "compositions", hash);
  mkdirSync(path.join(dir, "agents"), { recursive: true });
  writeFileSync(path.join(dir, "agents", "global_agent.py"), "GLOBAL = 'x'\n");
  writeFileSync(path.join(dir, "complete.json"), JSON.stringify({ composition_hash: hash }));
  if (pycache) {
    mkdirSync(path.join(dir, "agents", "__pycache__"), { recursive: true });
    writeFileSync(path.join(dir, "agents", "__pycache__", "global_agent.cpython-311.pyc"), "x".repeat(2048));
  }
  const when = (Date.now() - ageMs) / 1000;
  utimesSync(path.join(dir, "complete.json"), when, when);
  utimesSync(dir, when, when);
  return dir;
}

function fakeResidue(betaHome, name, ageMs) {
  const dir = path.join(betaHome, "routing", "compositions", name);
  mkdirSync(dir, { recursive: true });
  const when = (Date.now() - ageMs) / 1000;
  utimesSync(dir, when, when);
  return dir;
}

function fakeWorkerLog(betaHome, name, ageMs) {
  const file = path.join(betaHome, "logs", "workers", name);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, "log\n");
  const when = (Date.now() - ageMs) / 1000;
  utimesSync(file, when, when);
  return file;
}

test("live workers run without writing bytecode caches; an explicit config.env still wins", () => {
  const env = buildWorkerEnvironment({ port: 7091 }, { PATH: "/usr/bin" });
  assert.equal(env.PYTHONDONTWRITEBYTECODE, "1");
  assert.equal(env.PORT, "7091");
  assert.equal(env.PYTHONUTF8, "1");
  assert.equal(env.PATH, "/usr/bin");
  const overridden = buildWorkerEnvironment({ port: 7091, env: { PYTHONDONTWRITEBYTECODE: "0" } }, {});
  assert.equal(overridden.PYTHONDONTWRITEBYTECODE, "0");
});

test("a new manager keeps the newest compositions, drops the rest, and removes bytecode caches", (t) => {
  const { betaHome, options } = fixture(t);
  const compositionsRoot = path.join(betaHome, "routing", "compositions");
  for (let index = 1; index <= 12; index += 1) fakeComposition(betaHome, hashOf(index), index * HOUR);
  fakeResidue(betaHome, ".deadbeef.123.stage", 3 * HOUR);
  fakeResidue(betaHome, ".dry-load-abc", 5 * 60 * 1000);

  const manager = new BetaRouteManager(options);
  const remaining = readdirSync(compositionsRoot).sort();
  const keptHashes = remaining.filter((name) => /^[0-9a-f]{64}$/.test(name));
  assert.equal(keptHashes.length, 8, "the newest eight compositions are kept");
  assert.deepEqual(keptHashes, Array.from({ length: 8 }, (_, i) => hashOf(i + 1)).sort());
  for (const hash of keptHashes) {
    assert.ok(!existsSync(path.join(compositionsRoot, hash, "agents", "__pycache__")), `${hash.slice(0, 6)} bytecode removed`);
    assert.ok(existsSync(path.join(compositionsRoot, hash, "agents", "global_agent.py")), "sources untouched");
  }
  assert.ok(!remaining.includes(".deadbeef.123.stage"), "stale staging residue removed");
  assert.ok(remaining.includes(".dry-load-abc"), "fresh residue left alone (a run may be using it)");
  const pruned = manager.telemetry.find((event) => event.type === "routing-pruned");
  assert.deepEqual(
    { c: pruned.compositions_removed, r: pruned.residue_removed, p: pruned.pycache_removed, k: pruned.compositions_kept },
    { c: 4, r: 1, p: 8, k: 8 },
  );
});

test("compositions a running app can still reach are never pruned, however old", (t) => {
  const { betaHome, options } = fixture(t);
  const compositionsRoot = path.join(betaHome, "routing", "compositions");
  const manager = new BetaRouteManager(options);
  for (let index = 1; index <= 12; index += 1) fakeComposition(betaHome, hashOf(index), index * HOUR);
  const live = hashOf(12);
  const lastGood = hashOf(11);
  const active = hashOf(10);
  manager.workers.set(live, { route: { compositionHash: live } });
  manager.lastGoodDescriptor = { compositionHash: lastGood };
  manager.activeRoute = { compositionHash: active };
  fakeWorkerLog(betaHome, `${live}.log`, 30 * DAY);

  const report = manager.pruneRoutingArtifacts({ keepCompositions: 2 });
  for (const hash of [live, lastGood, active, hashOf(1), hashOf(2)]) {
    assert.ok(existsSync(path.join(compositionsRoot, hash)), `${hash.slice(0, 6)} kept`);
  }
  assert.equal(report.compositionsRemoved.length, 12 - 5);
  assert.ok(existsSync(path.join(betaHome, "logs", "workers", `${live}.log`)), "a live worker's log is never pruned");
});

test("a re-keyed worker keeps the composition directory it still serves", (t) => {
  const { betaHome, options } = fixture(t);
  const manager = new BetaRouteManager(options);
  const servedHash = hashOf(300);
  const defaultHash = hashOf(301);
  const compositionDirectory = fakeComposition(
    betaHome,
    servedHash,
    30 * DAY,
  );
  const agentDirectory = path.join(compositionDirectory, "agents");
  const route = { compositionHash: defaultHash };
  manager.workers.set(defaultHash, {
    agentDirectory,
    compositionDirectory,
    retiredCompositionDirectory: compositionDirectory,
    route,
  });
  manager.activeRoute = route;

  manager.pruneRoutingArtifacts({ keepCompositions: 0 });

  assert.ok(existsSync(compositionDirectory));
  assert.ok(existsSync(path.join(agentDirectory, "global_agent.py")));
});

test("a fallback worker log is protected by its effective composition hash", async (t) => {
  const { betaHome, options } = fixture(t);
  const manager = new BetaRouteManager(options);
  const requestedHash = hashOf(301);
  const effectiveHash = hashOf(302);
  const compositionDirectory = fakeComposition(betaHome, effectiveHash, 0);
  const effectiveDescriptor = {
    compositionHash: effectiveHash,
    ephemeral: false,
    identity: {
      caller_rappid: "rappid:caller",
      memory_guid: "memory-guid",
      overlay_stack_rappids: [],
    },
    selectedStacks: [],
    stack: { rappid: "rappid:stack" },
  };
  let workerConfig = null;
  manager.materializeComposition = () => ({
    agentDirectory: path.join(compositionDirectory, "agents"),
    compositionDirectory,
    descriptor: effectiveDescriptor,
    fallbackStrategy: "baseline",
  });
  manager.createWorkerProcess = (config) => {
    workerConfig = config;
    return {
      start: async () => ({ health: { status: "ok" } }),
    };
  };

  const route = await manager.startWorker({
    ...effectiveDescriptor,
    compositionHash: requestedHash,
  });
  assert.equal(route.compositionHash, effectiveHash);
  writeFileSync(workerConfig.logFile, "live fallback worker\n");

  manager.pruneRoutingArtifacts({ keepWorkerLogs: 0 });

  assert.equal(path.basename(workerConfig.logFile), `${effectiveHash}.log`);
  assert.ok(existsSync(workerConfig.logFile));
});

test("worker logs are pruned by count and by age", (t) => {
  const { betaHome, options } = fixture(t);
  const manager = new BetaRouteManager(options);
  for (let index = 1; index <= 25; index += 1) fakeWorkerLog(betaHome, `${hashOf(100 + index)}.log`, index * HOUR);
  fakeWorkerLog(betaHome, `${hashOf(200)}.log.1`, 40 * DAY);
  fakeWorkerLog(betaHome, "notes.txt", 40 * DAY);

  const report = manager.pruneRoutingArtifacts({ keepWorkerLogs: 20 });
  const remaining = readdirSync(path.join(betaHome, "logs", "workers"));
  assert.equal(remaining.filter((name) => /\.log(\.\d+)?$/.test(name)).length, 20);
  assert.ok(remaining.includes("notes.txt"), "only log files are considered");
  assert.ok(!remaining.includes(`${hashOf(200)}.log.1`), "a 40-day-old rotated log is gone");
  assert.equal(report.workerLogsRemoved.length, 6);
});

test("a missing compositions root is not an error", (t) => {
  const { betaHome, options } = fixture(t);
  const manager = new BetaRouteManager(options);
  rmSync(path.join(betaHome, "routing", "compositions"), { recursive: true, force: true });
  assert.deepEqual(manager.pruneRoutingArtifacts(), {
    compositionsRemoved: [], residueRemoved: [], pycacheRemoved: 0, workerLogsRemoved: [],
  });
});
