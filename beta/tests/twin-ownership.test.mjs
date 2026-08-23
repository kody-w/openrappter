// The twins root under the beta home is shared state. A new TwinManager used
// to wipe it wholesale on construction, taking another live launcher's twins
// (and a grown capability the Molter had installed) with it while status still
// said "live". Now only directories whose owner process is gone are reaped.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { TwinManager } from "../electron/twin-manager.mjs";

function twinDir(root, id, owner) {
  const dir = path.join(root, "twins", id);
  mkdirSync(path.join(dir, "agents"), { recursive: true });
  writeFileSync(path.join(dir, "agents", "demo_agent.py"), "# twin\n");
  if (owner !== undefined) {
    writeFileSync(path.join(dir, "owner.json"), JSON.stringify(owner));
  }
  return dir;
}

test("a new TwinManager reaps only twin directories whose owner is gone", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "rapp-twin-ownership-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const liveOwner = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
  t.after(() => liveOwner.kill());
  const deadPid = spawnSync("sh", ["-c", "exit 0"]).pid;

  const foreign = twinDir(root, "foreign-1", { pid: liveOwner.pid, startedAt: "2026-08-20T00:00:00Z" });
  const crashed = twinDir(root, "crashed-2", { pid: deadPid, startedAt: "2026-08-20T00:00:00Z" });
  const legacy = twinDir(root, "legacy-3", undefined);
  const corrupt = twinDir(root, "corrupt-4", "not json at all");
  writeFileSync(path.join(root, "twins", "stray-file.txt"), "keep me");

  const events = [];
  const manager = new TwinManager({
    betaHome: root,
    brainstemConfig: { url: "http://127.0.0.1:1" },
    storeClient: {},
    onEvent: (event) => events.push(event),
  });

  assert.ok(existsSync(foreign), "a directory owned by another live process is kept");
  assert.ok(!existsSync(crashed), "a directory whose owner died is reaped");
  assert.ok(!existsSync(legacy), "a directory with no ownership record is reaped (pre-ownership layout)");
  assert.ok(!existsSync(corrupt), "an unreadable ownership record counts as unowned");
  assert.ok(existsSync(path.join(root, "twins", "stray-file.txt")), "only directories are considered");
  assert.deepEqual(
    events.filter((event) => event.type === "twin-dir-kept").map((event) => event.id),
    ["foreign-1"],
  );
  assert.deepEqual(manager.reapStaleTwinDirectories(), { removed: [], kept: [{ id: "foreign-1", pid: liveOwner.pid }] });
});

test("a directory owned by THIS process is treated as stale on construction", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "rapp-twin-ownership-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const self = twinDir(root, "self-1", { pid: process.pid, startedAt: "2026-08-20T00:00:00Z" });
  new TwinManager({ betaHome: root, brainstemConfig: { url: "http://127.0.0.1:1" }, storeClient: {} });
  assert.ok(!existsSync(self), "a fresh manager in the same process starts its own bookkeeping clean");
});

test("a missing twins root is not an error", () => {
  const root = mkdtempSync(path.join(tmpdir(), "rapp-twin-ownership-"));
  const manager = new TwinManager({ betaHome: root, brainstemConfig: { url: "http://127.0.0.1:1" }, storeClient: {} });
  assert.deepEqual(manager.reapStaleTwinDirectories(), { removed: [], kept: [] });
  rmSync(root, { recursive: true, force: true });
});

test("a twin id taken by another live launcher is skipped, never adopted", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "rapp-twin-ownership-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // Another launcher (a live pid that is not us) already owns twins/demo-1.
  const liveOwner = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  t.after(() => { try { liveOwner.kill("SIGKILL"); } catch {} });
  const foreignDir = path.join(root, "twins", "demo-1");
  mkdirSync(path.join(foreignDir, "agents"), { recursive: true });
  const foreignOwner = JSON.stringify({ pid: liveOwner.pid, startedAt: "2026-08-20T00:00:00Z" });
  writeFileSync(path.join(foreignDir, "owner.json"), foreignOwner);
  writeFileSync(path.join(foreignDir, "agents", "demo_agent.py"), "FOREIGN = True\n");

  let claimedDir = null;
  const manager = new TwinManager({
    betaHome: root,
    brainstemConfig: { url: "http://127.0.0.1:1" },
    routeManager: {
      materializeExternalAgentSet(agentSources, agentsDir) {
        claimedDir = path.dirname(agentsDir);
        throw new Error("stop here: the id was claimed, no worker is spawned in this test");
      },
    },
    storeClient: {
      download: async () => ({
        id: "demo",
        filename: "demo_agent.py",
        source: "OURS = True\n",
        sha256: "0".repeat(64),
        entry: { name: "Demo", id: "demo" },
      }),
    },
  });
  await assert.rejects(() => manager.hatch("demo"), /stop here/);
  assert.equal(path.basename(claimedDir), "demo-2", "the taken id demo-1 is skipped");
  assert.equal(readFileSync(path.join(foreignDir, "owner.json"), "utf8"), foreignOwner, "the other launcher's owner.json is untouched");
  assert.equal(readFileSync(path.join(foreignDir, "agents", "demo_agent.py"), "utf8"), "FOREIGN = True\n");
  assert.ok(!existsSync(path.join(root, "twins", "demo-2")), "the failed hatch cleaned up only its own directory");
});

test("a live in-progress claim cannot be reaped or adopted", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "rapp-twin-ownership-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const liveOwner = spawn(
    process.execPath,
    ["-e", "setInterval(() => {}, 1000)"],
    { stdio: "ignore" },
  );
  t.after(() => { try { liveOwner.kill("SIGKILL"); } catch {} });
  const twinsRoot = path.join(root, "twins");
  const claimed = path.join(twinsRoot, "demo-1");
  mkdirSync(claimed, { recursive: true });
  writeFileSync(
    path.join(twinsRoot, ".demo-1.claim.json"),
    JSON.stringify({
      pid: liveOwner.pid,
      startedAt: "2026-08-20T00:00:00Z",
    }),
  );

  let claimedDir = null;
  const manager = new TwinManager({
    betaHome: root,
    brainstemConfig: { url: "http://127.0.0.1:1" },
    routeManager: {
      materializeExternalAgentSet(_agentSources, agentsDir) {
        claimedDir = path.dirname(agentsDir);
        throw new Error("stop after atomic claim");
      },
    },
    storeClient: {
      download: async () => ({
        id: "demo",
        filename: "demo_agent.py",
        source: "OURS = True\n",
        sha256: "0".repeat(64),
        entry: { name: "Demo", id: "demo" },
      }),
    },
  });
  assert.ok(existsSync(claimed), "the live ownerless claim survives reaping");
  await assert.rejects(() => manager.hatch("demo"), /stop after atomic claim/);
  assert.equal(path.basename(claimedDir), "demo-2");
  assert.ok(existsSync(claimed), "hatching skips rather than adopts the live claim");
});
