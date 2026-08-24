import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

import { TwinManager, twinManagerInternals } from "../electron/twin-manager.mjs";
import { tester123EmailContract } from "../electron/twin-adaptation-controller.mjs";
import { testPython } from "./_python.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (r) => (
  readFileSync(path.join(root, r), "utf8").replaceAll("\r\n", "\n")
);

test("twinSlug makes a safe agent-filename stem", () => {
  assert.equal(twinManagerInternals.twinSlug("JSON Doctor!"), "json-doctor");
  assert.equal(twinManagerInternals.twinSlug(""), "twin");
});

test("WorkIQ reuse gets a deterministic structured read-only email adapter", () => {
  const provider = [
    "import json, os, re, shutil, subprocess",
    "from agents.basic_agent import BasicAgent",
    "class WorkIQAgent(BasicAgent):",
    "    def __init__(self):",
    "        self.name = 'WorkIQ'",
    "        self.metadata = {'name': self.name, 'parameters': {'type': 'object', 'properties': {}}}",
    "        super().__init__(name=self.name, metadata=self.metadata)",
    "    def perform(self, **kwargs):",
    "        return 'No results found for your query.'",
    "",
  ].join("\n");
  const adapted = twinManagerInternals.buildWorkIqEmailAdapter(provider);
  assert.match(adapted, /class TwinReadOnlyEmailBindingAgent\(WorkIQAgent\)/);
  assert.match(adapted, /MOLTER_SHADOW/);
  assert.match(adapted, /"status": "auth_required"/);
  assert.match(adapted, /"status": "no_data"/);
  assert.match(adapted, /"status": "success", "messages": messages/);
  assert.equal(
    adapted,
    twinManagerInternals.buildWorkIqEmailAdapter(provider),
  );
  const probe = spawnSync(
    testPython(),
    ["-c", [
      "import importlib.util, json, sys, types",
      "agents = types.ModuleType('agents')",
      "basic = types.ModuleType('agents.basic_agent')",
      "class BasicAgent:",
      "    def __init__(self, name=None, metadata=None):",
      "        self.name = name",
      "        self.metadata = metadata",
      "basic.BasicAgent = BasicAgent",
      "agents.basic_agent = basic",
      "sys.modules['agents'] = agents",
      "sys.modules['agents.basic_agent'] = basic",
      "spec = importlib.util.spec_from_file_location('molter_probe', 'frontier/rapplications/molter/agents/molter_agent.py')",
      "module = importlib.util.module_from_spec(spec)",
      "spec.loader.exec_module(module)",
      "ok, detail = module._verify(sys.stdin.read(), json.loads(sys.argv[1]), ['network', 'data_source', 'credential', 'shell'])",
      "assert ok, detail",
    ].join("\n"), JSON.stringify(tester123EmailContract())],
    {
      cwd: root,
      encoding: "utf8",
      input: adapted,
    },
  );
  assert.equal(probe.status, 0, probe.stderr || probe.stdout);
});

test("TwinManager requires a store client and brainstem config", () => {
  assert.throws(() => new TwinManager({ betaHome: "/x", storeClient: {} }), /brainstemConfig/);
  assert.throws(() => new TwinManager({ betaHome: "/x", brainstemConfig: {} }), /Store client/);
});

test("store hatch refuses a traversal filename before it can escape the twin agents directory", async (t) => {
  const temporary = mkdtempSync(path.join(tmpdir(), "rapp-twin-hatch-"));
  const betaHome = path.join(temporary, "home");
  const escaped = path.join(temporary, "escaped_agent.py");
  mkdirSync(betaHome);
  t.after(() => rmSync(temporary, { recursive: true, force: true }));

  const manager = new TwinManager({
    betaHome,
    brainstemConfig: {},
    storeClient: {
      download: async () => ({
        id: "escape",
        filename: "../../../../escaped_agent.py",
        source: "VALUE = 'outside'\n",
        sha256: "0".repeat(64),
        entry: { name: "Escape" },
      }),
    },
  });

  await assert.rejects(() => manager.hatch("escape"), /safe \*_agent\.py basename/);
  assert.equal(existsSync(escaped), false);
});

test("a failed twin hatch removes its twin and Molter directories", async (t) => {
  const temporary = mkdtempSync(path.join(tmpdir(), "rapp-twin-failed-"));
  const betaHome = path.join(temporary, "home");
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  let stops = 0;
  const manager = new TwinManager({
    betaHome,
    brainstemConfig: {},
    createWorkerProcess: () => ({
      start: async () => {
        throw new Error("worker start failed");
      },
      stop: async () => {
        stops += 1;
      },
    }),
    storeClient: {},
  });

  await assert.rejects(
    () => manager.hatchLocal({
      id: "failed",
      agentSources: [{
        filename: "failed_agent.py",
        source: "class FailedAgent:\n    pass\n",
      }],
    }),
    /worker start failed/,
  );
  assert.equal(stops, 1);
  assert.equal(manager.twins.size, 0);
  assert.deepEqual(readdirSync(path.join(betaHome, "twins")), []);
  assert.deepEqual(readdirSync(path.join(betaHome, "molts")), []);
});

test("failed adaptation rehydration aborts hatch before an unvalidated worker starts", async (t) => {
  const temporary = mkdtempSync(path.join(tmpdir(), "rapp-twin-rehydrate-fail-"));
  const betaHome = path.join(temporary, "home");
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  let starts = 0;
  const manager = new TwinManager({
    betaHome,
    brainstemConfig: {},
    createAdaptationController: () => ({
      inspect: () => ({ capabilities: {} }),
      rehydrate: () => ({ ok: false, reason: "duplicate tool collision" }),
    }),
    createWorkerProcess: () => ({
      start: async () => { starts += 1; },
      stop: async () => {},
    }),
    storeClient: {},
  });
  await assert.rejects(
    () => manager.hatchLocal({
      id: "unsafe-rehydrate",
      agentSources: [{
        filename: "unsafe_agent.py",
        source: "class Unsafe: pass\n",
      }],
    }),
    /rehydration failed closed/,
  );
  assert.equal(starts, 0);
});

test("closing removes workers but preserves stable Molter/adaptation history", async (t) => {
  const temporary = mkdtempSync(path.join(tmpdir(), "rapp-twin-cleanup-"));
  const betaHome = path.join(temporary, "home");
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const stopped = new Set();
  const manager = new TwinManager({
    betaHome,
    brainstemConfig: {},
    createWorkerProcess: (config) => ({
      start: async () => {},
      stop: async () => {
        stopped.add(config.env.BRAINSTEM_BETA_TWIN);
      },
    }),
    storeClient: {},
  });
  const source = [{
    filename: "cleanup_agent.py",
    source: "class CleanupAgent:\n    pass\n",
  }];
  const first = await manager.hatchLocal({
    id: "first",
    agentSources: source,
  });
  const second = await manager.hatchLocal({
    id: "second",
    agentSources: source,
  });
  const firstPaths = {
    dir: manager.get(first.id).dir,
    molterHome: manager.get(first.id).molterHome,
  };
  const secondPaths = {
    dir: manager.get(second.id).dir,
    molterHome: manager.get(second.id).molterHome,
  };

  await manager.close(first.id);
  assert.equal(existsSync(firstPaths.dir), false);
  assert.equal(existsSync(firstPaths.molterHome), true);
  assert.ok(stopped.has(first.id));

  await manager.stopAll();
  assert.equal(existsSync(secondPaths.dir), false);
  assert.equal(existsSync(secondPaths.molterHome), true);
  assert.ok(stopped.has(second.id));
  assert.equal(manager.twins.size, 0);
});

test("twin logs are pruned by count and age while active logs stay live", (t) => {
  const temporary = mkdtempSync(path.join(tmpdir(), "rapp-twin-logs-"));
  const betaHome = path.join(temporary, "home");
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const manager = new TwinManager({
    betaHome,
    brainstemConfig: {},
    createWorkerProcess: () => null,
    storeClient: {},
  });
  const now = Date.now();
  const hour = 60 * 60 * 1000;
  const log = (name, ageMs) => {
    const file = path.join(manager.twinLogRoot, name);
    writeFileSync(file, "log\n");
    const when = new Date(now - ageMs);
    utimesSync(file, when, when);
    return file;
  };
  for (let index = 1; index <= 25; index += 1) {
    log(`closed-${index}.log`, index * hour);
  }
  const oldArchive = log("molter-1.log.1", 40 * 24 * hour);
  const activeLog = log("active-1.log", 40 * 24 * hour);
  log("notes.txt", 40 * 24 * hour);
  manager.twins.set("active-1", {});

  const removed = manager.pruneTwinLogs({ keep: 20, now });
  const remaining = readdirSync(manager.twinLogRoot);
  assert.equal(
    remaining.filter((name) => /\.log(?:\.\d+)?$/.test(name)).length,
    21,
  );
  assert.equal(existsSync(activeLog), true);
  assert.equal(existsSync(oldArchive), false);
  assert.ok(removed.includes("molter-1.log.1"));
  assert.ok(remaining.includes("notes.txt"));
});

test("a twin is driven only over /chat — never a new route (canon)", () => {
  const src = read("electron/twin-manager.mjs");
  assert.match(src, /fetch\(`\$\{twin\.url\}\/chat`/);      // the wire is /chat
  assert.doesNotMatch(src, /fetch\([^)]*\/api\/agent/);        // never the legacy RCE route
  assert.match(src, /127\.0\.0\.1/);      // loopback-only
  assert.match(src, /sha256-verified|singleton_sha256|cartridge\.sha256/i);
});

test("main wires twins + store IPC and the Surgeon hatch tools", () => {
  const main = read("electron/main.mjs");
  const preload = read("electron/preload.cjs");
  const surgeon = read("electron/rappter-surgeon.mjs");
  assert.match(main, /new TwinManager\(/);
  assert.match(main, /beta:twin-hatch/);
  assert.match(main, /beta:store-list/);
  assert.match(main, /twinManager\.stopAll\(\)/);
  assert.match(preload, /twinHatch:/);
  assert.match(preload, /onTwinEvent:/);
  assert.match(surgeon, /name: "hatch_rapplication"/);
  assert.match(surgeon, /name: "list_rapplications"/);
  assert.match(main, /beta:twin-adaptation-propose/);
  assert.match(main, /beta:twin-adaptation-approve/);
  assert.match(main, /dialog\.showMessageBox\(mainWindow/);
  assert.match(main, /Approve exact candidate/);
  assert.match(preload, /twinAdaptationInspect:/);
  assert.match(surgeon, /name: "inspect_twin_adaptation"/);
  assert.match(surgeon, /name: "propose_twin_adaptation"/);
  assert.match(surgeon, /name: "stage_twin_adaptation"/);
  assert.match(surgeon, /name: "rollback_twin_adaptation"/);
  assert.doesNotMatch(surgeon, /name: "approve_twin_adaptation"/);
  assert.doesNotMatch(surgeon, /name: "activate_twin_adaptation"/);
});

test("the herd renders a chat/work-log tile per twin", () => {
  const renderer = read("ui/renderer.js");
  const ui = read("ui/index.html");
  assert.match(renderer, /function twinTileFor/);
  assert.match(renderer, /handleTwinEvent/);
  assert.match(renderer, /twinClose/);
  assert.match(renderer, /function renderTwinChat/);      // the work-log/chat transcript
  assert.match(ui, /herd-tile\.twin/);
  assert.match(ui, /\.twin-chat/);
  assert.match(renderer, /function renderTwinAdaptation/);
  assert.match(renderer, /twinAdaptationApprove/);
  assert.match(ui, /\.twin-adaptation/);
});

test("the Copilot Studio deploy twin is composed from the bundled Factory + Deploy agents (P2)", () => {
  const main = read("electron/main.mjs");
  const surgeon = read("electron/rappter-surgeon.mjs");
  const src = read("electron/twin-manager.mjs");
  // hatchLocal composes a twin from local agent sources (not a store pull)
  assert.match(src, /async hatchLocal\(/);
  assert.match(src, /twin-needs-auth/);                 // pauses at the one user-owned auth step
  // main hatches the CS twin from the bundled deploy agents + resources
  assert.match(main, /rar_kody_w_factory_agent\.py/);
  assert.match(main, /rar_kody_w_copilot_studio_parity_deploy_agent\.py/);
  assert.match(main, /function hatchCopilotStudioTwin/);
  assert.match(main, /DRAFT-ONLY: never call release or publish/);
  // the Surgeon offloads to the twin instead of running it inline
  assert.match(surgeon, /name: "deploy_to_copilot_studio"/);
  assert.match(surgeon, /loops autonomously in the herd/);
});

test("small view = a chat/work-log over the twin's /chat; the full custom UI pops out (P3)", () => {
  const tm = read("electron/twin-manager.mjs");
  const main = read("electron/main.mjs");
  const renderer = read("ui/renderer.js");
  const ui = read("ui/index.html");
  const fs = require("node:fs");
  // the proxy is gone; the twin keeps the rapplication's static UI HTML
  assert.ok(!fs.existsSync(path.join(root, "electron/twin-ui-proxy.mjs")), "twin-ui-proxy.mjs should be removed");
  assert.doesNotMatch(tm, /startTwinUiProxy|uiProxyUrl/);
  // The pin law hardening: a twin's custom UI is never fetched unverified at
  // hatch time — it arrives sha-verified from the store client (cartridge
  // .uiHtml) or inside a verified egg. The old `twin.uiHtml = await fetch`
  // path must stay gone.
  assert.doesNotMatch(tm, /uiHtml = await fetch/);
  assert.match(tm, /spec\.uiHtml/);
  assert.match(tm, /cartridge\.uiHtml/);
  assert.match(tm, /uiHtml\(id\)/);
  assert.match(tm, /hasCustomUi/);
  assert.match(tm, /maxTwins/);
  // the tile is a chat log with a composer, NOT an inline custom-UI iframe
  assert.match(renderer, /function renderTwinChat/);
  assert.match(renderer, /function sendTwinMessage/);
  assert.match(renderer, /brainstemBeta\.twinChat\(id, text\)/);
  assert.doesNotMatch(renderer, /twin-frame|twin-ui-toggle/);
  assert.match(ui, /\.twin-chat/);
  assert.match(ui, /\.twin-comp/);
  // the full custom UI opens in the pop-out (which document.writes the UI)
  assert.match(renderer, /brainstemBeta\.twinPopOut/);
  assert.match(main, /function popOutTwin/);
  assert.match(main, /document\.open\(\); document\.write/);
});

test("the Brainstem loops with a twin autonomously — a genuine two-brain loop", () => {
  const tm = read("electron/twin-manager.mjs");
  const main = read("electron/main.mjs");
  const preload = read("electron/preload.cjs");
  const surgeon = read("electron/rappter-surgeon.mjs");
  const renderer = read("ui/renderer.js");
  const ui = read("ui/index.html");
  // The loop plans over the visible Brainstem's /chat AND executes over the twin's /chat.
  assert.match(tm, /async loop\(id, goal/);
  assert.match(tm, /#brainstemPlan\(/);
  assert.match(tm, /\$\{base\}\/chat/);                 // plans over the Brainstem /chat
  assert.match(tm, /this\.chat\(id, instruction, \{ author: "Brainstem" \}\)/);  // twin executes; labeled Brainstem
  assert.match(tm, /brainstemUrl/);
  // main resolves the live Brainstem URL and exposes the loop over IPC + to the Surgeon.
  assert.match(main, /brainstemUrl: \(\) => state\.url/);
  assert.match(main, /beta:twin-loop/);
  assert.match(main, /loop: \(id, goal\) =>/);
  assert.match(preload, /twinLoop:/);
  assert.match(surgeon, /name: "loop_brainstem_with_twin"/);
  // the herd tile can start the loop, and it lights while looping.
  assert.match(renderer, /brainstemBeta\.twinLoop/);
  assert.match(renderer, /classList\.toggle\("looping"/);
  assert.match(ui, /\.tw-loop/);
});

test("the AI can drive a twin's own UI in-tile (P3c)", () => {
  const server = read("electron/ui-driver-server.mjs");
  const surgeon = read("electron/rappter-surgeon.mjs");
  const main = read("electron/main.mjs");
  assert.match(server, /function twinFrame/);
  assert.match(server, /resolveTwinUrls/);
  assert.match(main, /resolveTwinUrls: \(id\) =>/);
  assert.match(surgeon, /name: "drive_twin"/);
  assert.match(surgeon, /action: "run",\s*twin: twinId/);
});

test("away-auth: notification + browser pop-out, never capturing credentials (P3d)", () => {
  const main = read("electron/main.mjs");
  const surgeon = read("electron/rappter-surgeon.mjs");
  const preload = read("electron/preload.cjs");
  assert.match(main, /new Notification\(/);
  assert.match(main, /notifyTwinNeedsAuth/);
  assert.match(main, /shell\.openExternal/);          // identity auth opens the user's own browser
  assert.match(surgeon, /name: "open_auth_window"/);
  assert.match(surgeon, /never capture or type their credentials/i);
  assert.match(preload, /twinPopOut:/);
  assert.match(preload, /openAuth:/);
});

test("twin molt.json generations mirror once with their archived source", (t) => {
  const temporary = mkdtempSync(path.join(tmpdir(), "rapp-twin-molts-"));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const molterHome = path.join(temporary, "molter");
  const generation = path.join(
    molterHome,
    "molts",
    "weather",
    "gen-001",
  );
  mkdirSync(generation, { recursive: true });
  const source = [
    "class WeatherAgent:",
    "    def __init__(self):",
    "        self.name = \"WeatherAgent\"",
    "",
  ].join("\n");
  writeFileSync(path.join(generation, "agent.py"), source);
  writeFileSync(path.join(generation, "molt.json"), JSON.stringify({
    generation: 1,
    kind: "mutate",
    verdict: "verified",
    sha256: "recorded-by-molter",
    detail: { tool_name: "WeatherAgent" },
  }));
  const writes = [];
  const archivedPath = path.join(temporary, "ledger-sources", "weather_agent.py");
  const manager = Object.create(TwinManager.prototype);
  manager.ledger = {
    archiveAgentSource: ({ filename, source: archivedSource }) => {
      assert.equal(filename, "weather_agent.py");
      assert.equal(Buffer.compare(archivedSource, Buffer.from(source)), 0);
      return { path: archivedPath, sha256: "archived-by-ledger" };
    },
    recordAgent: (row) => writes.push(row),
  };
  const twin = {
    dir: temporary,
    id: "weather-1",
    molterHome,
    rappid: "rappid:@microsoft/weather",
    seenMolts: new Set(),
  };

  const first = manager.mirrorMolts(twin);
  const second = manager.mirrorMolts(twin);
  assert.equal(first.length, 1);
  assert.equal(second.length, 0);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].event, "molted");
  assert.equal(writes[0].filename, "weather_agent.py");
  assert.equal(writes[0].toolName, "WeatherAgent");
  assert.equal(writes[0].origin, "molter");
  assert.equal(writes[0].sourcePath, archivedPath);
  assert.equal(writes[0].sha256, "archived-by-ledger");
  assert.equal(writes[0].detail.recorded_sha256, "recorded-by-molter");
});

test("twin hatches and chat completions are wired into the shared ledger", () => {
  const source = read("electron/twin-manager.mjs");
  assert.match(source, /event: "hatched"/);
  assert.match(source, /surface: `twin:\$\{id\}`/);
  assert.match(source, /MOLTER_HOME: molterHome/);
  assert.match(source, /path\.join\(\s*this\.betaHome,\s*"molts"/);
  assert.match(source, /this\.mirrorMolts\(twin\)/);
  assert.match(source, /recordCompletedTurn\(this\.ledger/);
  assert.match(source, /finally \{\s*this\.mirrorMolts\(twin\)/);
  assert.match(source, /async #disposeTwin[\s\S]*this\.mirrorMolts\(twin\)/);
  assert.match(source, /surface: "brainstem"/);
  assert.match(source, /sessionId: data\.session_id \|\| sessionId/);
});

test("a rapplication's Molter home is stable across hatches, so a grown capability survives a restart", (t) => {
  // The Molter rehydrates a grown capability from MOLTER_HOME. Keying that
  // home to the hatch (id + random UUID) made rehydration impossible and
  // orphaned a directory per hatch; it is keyed to the rapplication instead.
  const source = read("electron/twin-manager.mjs");
  assert.match(source, /const stableMolterHome = path\.join\([\s\S]{0,120}twinSlug\(spec\.idBase\)[\s\S]{0,80}sha256\(String\(spec\.idBase\)\)/);
  assert.match(source, /claimedByLiveTwin\s*\?[\s\S]{0,160}randomUUID\(\)[\s\S]{0,60}:\s*stableMolterHome/);
  // The ephemeral fallback exists only for a second LIVE twin of the same
  // rapplication, which cannot share one Molter state directory.
  assert.match(source, /\[\.\.\.this\.twins\.values\(\)\]\s*\.some\(\(existing\) => existing\?\.molterHome === stableMolterHome\)/);
  assert.match(source, /readOwner\(stableMolterHome\)/);
  assert.match(source, /molterLeasePath/);
});
