import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { executeLineageCommand } from "../electron/lineage-control.mjs";
import {
  LineageStore,
  lineageStoreInternals,
} from "../electron/lineage-store.mjs";
import {
  AIBAST_REGISTRY_URL,
  RappStoreClient,
} from "../electron/rapp-store.mjs";
import { BetaRouteManager } from "../electron/route-manager.mjs";
import { TwinManager } from "../electron/twin-manager.mjs";


const betaRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const repositoryRoot = path.resolve(betaRoot, "..");
const pristineGrail = path.join(repositoryRoot, "rapp_brainstem");
const python = process.env.BRAINSTEM_BETA_PYTHON
  || path.join(homedir(), ".brainstem", "venv", "bin", "python");
const scratchRoot = mkdtempSync(
  path.join(tmpdir(), "rapp-frontier-runtime-proof-"),
);
const scratchHome = path.join(scratchRoot, "home");
const betaHome = path.join(scratchRoot, "beta-home");
const lineageRoot = path.join(scratchRoot, "lineage");
const grailDirectory = path.join(scratchRoot, "rapp_brainstem");
const memoryFile = path.join(
  grailDirectory,
  ".brainstem_data",
  "memory",
  "runtime-proof",
  "user_memory.json",
);
const memoryBytes = Buffer.from(
  '{"schema":"runtime-proof/1","memory":"never touch these bytes"}\n',
  "utf8",
);
const rows = [];
const managers = new Set();
const workerPids = new Set();
const previousEnvironment = new Map();
let failed = false;
let fixtureServer = null;
let cleanupPromise = null;
let pythonPackagesBefore = null;

const environmentOverrides = {
  BRAINSTEM_HOME: path.join(scratchHome, ".brainstem"),
  BRAINSTEM_LAN_MODE: "0",
  GH_CONFIG_DIR: path.join(scratchHome, ".config", "gh"),
  GITHUB_TOKEN: "frontier-proof-non-credential",
  HOME: scratchHome,
  MOLTER_HOME: path.join(scratchHome, ".rapp", "molter"),
  PIP_CACHE_DIR: path.join(scratchHome, ".cache", "pip"),
  PIP_DISABLE_PIP_VERSION_CHECK: "1",
  PIP_NO_INDEX: "1",
  PYTHONDONTWRITEBYTECODE: "1",
  PYTHONNOUSERSITE: "1",
  RAPP_MOLT_LINEAGE: "1",
  XDG_CONFIG_HOME: path.join(scratchHome, ".config"),
};

function printable(value) {
  return String(value ?? "")
    .replaceAll("|", "/")
    .replaceAll("\n", " ");
}

async function step(name, run) {
  try {
    const outcome = await run();
    const pass = outcome === true || outcome?.pass === true;
    const detail = outcome && typeof outcome === "object"
      ? outcome.detail
      : "";
    rows.push({ name, result: pass ? "PASS" : "FAIL", detail });
    if (!pass) failed = true;
    return outcome?.value;
  } catch (error) {
    failed = true;
    rows.push({
      name,
      result: "FAIL",
      detail: String(error?.stack || error?.message || error),
    });
    return undefined;
  }
}

function printTable() {
  console.log("| Check | Result | Detail |");
  console.log("|---|---|---|");
  for (const row of rows) {
    console.log(
      `| ${printable(row.name)} | ${row.result} | ${printable(row.detail)} |`,
    );
  }
}

function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function pythonPackageFingerprint() {
  const result = spawnSync(
    python,
    ["-m", "pip", "freeze", "--disable-pip-version-check"],
    {
      encoding: "utf8",
      env: process.env,
      maxBuffer: 4 * 1024 * 1024,
      timeout: 30_000,
    },
  );
  if (result.error || result.status !== 0) {
    throw new Error(
      result.error?.message
      || String(result.stderr || result.stdout || "pip freeze failed").trim(),
    );
  }
  return sha256Hex(Buffer.from(result.stdout, "utf8"));
}

function networkUnavailable(error) {
  const text = String(error?.message || error);
  return error?.name === "AbortError"
    || error?.name === "TimeoutError"
    || /fetch failed|ECONN|ENET|EAI_AGAIN|ENOTFOUND|network|socket|timed? out|HTTP 5\d\d/i.test(
      text,
    );
}

function pidIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function currentWorker(manager, route) {
  const worker = manager.workers.get(route?.compositionHash);
  const pid = worker?.process?.child?.pid;
  if (Number.isInteger(pid)) workerPids.add(pid);
  return { worker, pid };
}

async function healthEvidence(manager, route, expectedTools = []) {
  const response = await fetch(`${route.url}/health`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(5_000),
  });
  const health = await response.json();
  const { worker, pid } = currentWorker(manager, route);
  const missing = expectedTools.filter(
    (tool) => !health.agents?.includes(tool),
  );
  return {
    health,
    missing,
    pid,
    worker,
    alive: pidIsAlive(pid),
    ok: response.ok
      && ["ok", "unauthenticated"].includes(health.status)
      && Array.isArray(health.agents)
      && missing.length === 0
      && pidIsAlive(pid),
  };
}

function memoryIsIntact() {
  try {
    return readFileSync(memoryFile).equals(memoryBytes);
  } catch {
    return false;
  }
}

function requireMemoryIntact(operation) {
  if (!memoryIsIntact()) {
    throw new Error(`Memory bytes changed during ${operation}.`);
  }
}

function ringDirectory(store, ancestorRappid, ringRappid) {
  return path.join(
    store.root,
    lineageStoreInternals.filesystemSegment(ancestorRappid),
    "rings",
    lineageStoreInternals.filesystemSegment(ringRappid),
  );
}

function promotionJournal(store, ancestorRappid) {
  return path.join(
    store.root,
    lineageStoreInternals.filesystemSegment(ancestorRappid),
    "promotions.json",
  );
}

function headSnapshot(store, env = "default") {
  return Object.fromEntries(
    store.baselineAncestors().map((baseline) => [
      baseline.ancestorRappid,
      store.getHead(baseline.ancestorRappid, { env }),
    ]),
  );
}

function agentSource({
  className,
  marker,
  markerValue,
  reply,
  toolName,
}) {
  return `from agents.basic_agent import BasicAgent

${marker} = ${JSON.stringify(markerValue)}


class ${className}(BasicAgent):
    def __init__(self):
        self.name = ${JSON.stringify(toolName)}
        self.metadata = {
            "name": ${JSON.stringify(toolName)},
            "description": "Deterministic Frontier runtime proof agent.",
            "parameters": {
                "type": "object",
                "properties": {},
                "required": [],
            },
        }
        super().__init__(name=self.name, metadata=self.metadata)

    def perform(self, **kwargs):
        return ${JSON.stringify(reply)}
`;
}

function ingestVerifiedRing(manager, baseline, {
  source,
  parentRappid = null,
  meta = {},
} = {}) {
  const verdict = manager.moltVerifier(source);
  if (verdict !== true && verdict?.ok !== true) {
    throw new Error(
      verdict?.error || "The real Molter gate refused the candidate.",
    );
  }
  const ringRappid = manager.lineageStore.appendRing(
    baseline.ancestorRappid,
    {
      source,
      parentRappid: parentRappid || baseline.ancestorRappid,
      verified: true,
      meta: {
        ...meta,
        verifiedBy: "molter._verify",
      },
    },
  );
  return { ringRappid, verdict };
}

async function startFixtureStore() {
  const firstSource = agentSource({
    className: "FixtureAgent",
    marker: "FIXTURE_AGENT",
    markerValue: "absorbed",
    reply: "fixture agent alive",
    toolName: "FixtureAgent",
  });
  const collisionSource = agentSource({
    className: "CollisionAgent",
    marker: "COLLISION_AGENT",
    markerValue: "must-not-replace",
    reply: "collision agent",
    toolName: "CollisionAgent",
  });
  let catalog = null;
  const server = createServer((request, response) => {
    const requestPath = new URL(
      request.url,
      "http://127.0.0.1",
    ).pathname;
    const body = requestPath === "/index.json"
      ? Buffer.from(JSON.stringify(catalog), "utf8")
      : requestPath === "/fixture_agent.py"
        ? Buffer.from(firstSource, "utf8")
        : requestPath === "/collision_agent.py"
          ? Buffer.from(collisionSource, "utf8")
          : null;
    if (!body) {
      response.writeHead(404, { "Content-Type": "text/plain" });
      response.end("not found");
      return;
    }
    response.writeHead(200, {
      "Content-Length": body.length,
      "Content-Type": requestPath.endsWith(".json")
        ? "application/json"
        : "text/x-python",
    });
    response.end(body);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  catalog = {
    schema: "rapp-store/1.0",
    generated_at: "2026-08-20T19:25:50.792Z",
    rapplications: [
      {
        id: "fixture-agent",
        name: "Fixture Agent",
        version: "1.0.0",
        singleton_filename: "fixture_agent.py",
        singleton_url: `${baseUrl}/fixture_agent.py`,
        singleton_sha256: sha256Hex(Buffer.from(firstSource, "utf8")),
      },
      {
        id: "collision-agent",
        name: "Collision Agent",
        version: "1.0.0",
        singleton_filename: "fixture_agent.py",
        singleton_url: `${baseUrl}/collision_agent.py`,
        singleton_sha256: sha256Hex(Buffer.from(collisionSource, "utf8")),
      },
    ],
  };
  return {
    client: new RappStoreClient({
      url: `${baseUrl}/index.json`,
      timeoutMs: 5_000,
    }),
    collisionSource,
    firstSource,
    server,
    url: `${baseUrl}/index.json`,
  };
}

function copyGrail() {
  const excluded = new Set([
    ".brainstem_data",
    ".copilot_session",
    ".copilot_token",
    ".env",
    ".git",
    ".venv",
    "__pycache__",
  ]);
  cpSync(pristineGrail, grailDirectory, {
    recursive: true,
    filter: (source) => {
      const relative = path.relative(pristineGrail, source);
      if (!relative) return true;
      return !relative.split(path.sep).some((part) => excluded.has(part));
    },
  });
}

async function closeServer(server) {
  if (!server) return;
  await new Promise((resolve) => server.close(() => resolve()));
}

async function cleanupResources() {
  if (cleanupPromise) return cleanupPromise;
  cleanupPromise = (async () => {
    const stopResults = await Promise.allSettled(
      [...managers].map((candidate) => candidate.stop()),
    );
    let cleanupError = stopResults.find(
      (result) => result.status === "rejected",
    )?.reason || null;
    try {
      await closeServer(fixtureServer);
    } catch (error) {
      cleanupError ||= error;
    }
    for (const [name, value] of previousEnvironment) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    try {
      rmSync(scratchRoot, { recursive: true, force: true });
    } catch (error) {
      cleanupError ||= error;
    }
    const livePids = [...workerPids].filter(pidIsAlive);
    return {
      error: cleanupError,
      livePids,
      pass: !cleanupError
        && !existsSync(scratchRoot)
        && livePids.length === 0,
    };
  })();
  return cleanupPromise;
}

for (const [signal, exitCode] of [
  ["SIGHUP", 129],
  ["SIGINT", 130],
  ["SIGTERM", 143],
]) {
  process.once(signal, () => {
    void cleanupResources().finally(() => process.exit(exitCode));
  });
}

let manager = null;
let store = null;
let route = null;
let contextBaseline = null;
let contextRing1 = null;
let hackerBaseline = null;
let hackerGrowthRing = null;
let hackerTransientRing = null;
let learnBaseline = null;
let fixtureDownload = null;
let collisionStack = null;

try {
  for (const [name, value] of Object.entries(environmentOverrides)) {
    previousEnvironment.set(name, process.env[name]);
    process.env[name] = value;
  }
  mkdirSync(scratchHome, { recursive: true });
  pythonPackagesBefore = pythonPackageFingerprint();

  await step("preflight: configured Brainstem Python exists", () => ({
    pass: existsSync(python),
    detail: python,
  }));
  await step("preflight: pristine Grail is present", () => ({
    pass: existsSync(path.join(pristineGrail, "brainstem.py")),
    detail: pristineGrail,
  }));

  copyGrail();
  mkdirSync(path.dirname(memoryFile), { recursive: true });
  writeFileSync(memoryFile, memoryBytes);

  const managerOptions = {
    betaHome,
    brainstemConfig: {
      brainstemDir: grailDirectory,
      python,
    },
    lineageRoot,
    lineageEnv: "default",
  };
  manager = new BetaRouteManager(managerOptions);
  managers.add(manager);
  store = manager.lineageStore;
  contextBaseline = manager.baselineAncestor("context_memory_agent.py");
  contextRing1 = contextBaseline
    ? store.getHead(contextBaseline.ancestorRappid, { env: "default" })
    : null;
  hackerBaseline = manager.baselineAncestor("hacker_news_agent.py");
  learnBaseline = manager.baselineAncestor("rar_rapp_learn_new_agent.py");

  await step("runtime: real Molter seeds Frontier ring-1", () => {
    const ring = store.listRings(contextBaseline?.ancestorRappid)
      .find((candidate) => candidate.ringRappid === contextRing1);
    return {
      pass: Boolean(
        contextBaseline
        && contextRing1
        && contextRing1 !== contextBaseline.ancestorRappid
        && ring?.verified === true
        && ring?.meta?.verifiedBy === "molter._verify",
      ),
      detail: contextRing1 || "ContextMemory ring-1 was not seeded",
    };
  });

  await step("runtime: real Grail worker starts and exposes tools", async () => {
    route = await manager.startDefault();
    const evidence = await healthEvidence(
      manager,
      route,
      ["ContextMemory", "HackerNews", "LearnNew", "ManageMemory"],
    );
    return {
      pass: evidence.ok && memoryIsIntact(),
      detail: `pid=${evidence.pid}; status=${evidence.health.status}; tools=${evidence.health.agents.join(",")}`,
    };
  });

  const fixture = await startFixtureStore();
  fixtureServer = fixture.server;
  await step("absorb: sha-pinned fixture agent becomes a live tool", async () => {
    fixtureDownload = await fixture.client.download("fixture-agent");
    const installed = await manager.installScopedAgent({
      filename: fixtureDownload.filename,
      source: fixtureDownload.source,
    });
    route = await manager.startDefault();
    const evidence = await healthEvidence(
      manager,
      route,
      ["FixtureAgent"],
    );
    const composed = manager.readActiveAgent(fixtureDownload.filename);
    return {
      pass: fixtureDownload.verified === true
        && installed.agent.filename === fixtureDownload.filename
        && composed === fixtureDownload.source
        && evidence.ok,
      detail: `catalog=${fixture.url}; sha256=${fixtureDownload.sha256}; pid=${evidence.pid}; tool=FixtureAgent`,
    };
  });

  await step("absorb: same-filename agent collision fails closed", async () => {
    const identity = manager.identity();
    collisionStack = await manager.createStack({
      name: "collision-proof",
      parentRappid: identity.default_stack_rappid,
    });
    await manager.selectStack({
      stackRappid: identity.default_stack_rappid,
      overlayRappids: [collisionStack.rappid],
    });
    const collisionDownload = await fixture.client.download(
      "collision-agent",
    );
    let refusal = null;
    try {
      await manager.installScopedAgent({
        filename: collisionDownload.filename,
        source: collisionDownload.source,
        stackRappid: collisionStack.rappid,
      });
    } catch (error) {
      refusal = String(error?.message || error);
    }
    route = await manager.startDefault();
    const evidence = await healthEvidence(
      manager,
      route,
      ["FixtureAgent"],
    );
    const overlay = manager.loadStack(collisionStack.rappid);
    return {
      pass: /composition collision/i.test(refusal || "")
        && overlay.agents.length === 0
        && manager.readActiveAgent(fixtureDownload.filename)
          === fixtureDownload.source
        && evidence.ok,
      detail: `${refusal || "collision was accepted"}; first-sha=${fixtureDownload.sha256}; pid=${evidence.pid}`,
    };
  });

  await step("absorb: optional live AIBAST catalog agent", async () => {
    const client = new RappStoreClient({
      url: AIBAST_REGISTRY_URL,
      timeoutMs: 8_000,
    });
    let entries;
    try {
      entries = await client.list();
    } catch (error) {
      if (networkUnavailable(error)) {
        return {
          pass: true,
          detail: `optional network unavailable; skipped (${String(error?.message || error)})`,
        };
      }
      throw error;
    }
    const preferred = [
      "prior-authorization",
      "industry-agent-generator",
      "workshop",
    ];
    const candidate = preferred
      .map((id) => entries.find((entry) => entry.id === id))
      .find(Boolean)
      || entries.find((entry) => (
        !entry.gated
        && !entry.yanked
        && !entry.deprecated
        && entry.singletonFilename
        && entry.singletonSha256
      ));
    if (!candidate) {
      return {
        pass: false,
        detail: "AIBAST catalog was reachable but had no installable pinned entry.",
      };
    }
    const before = await healthEvidence(manager, route);
    let downloaded;
    try {
      downloaded = await client.download(candidate.id);
    } catch (error) {
      if (networkUnavailable(error)) {
        return {
          pass: true,
          detail: `optional singleton network unavailable; skipped (${String(error?.message || error)})`,
        };
      }
      throw error;
    }
    await manager.installScopedAgent({
      filename: downloaded.filename,
      source: downloaded.source,
    });
    route = await manager.startDefault();
    const evidence = await healthEvidence(manager, route);
    const addedTools = evidence.health.agents.filter(
      (tool) => !before.health.agents.includes(tool),
    );
    return {
      pass: downloaded.verified === true
        && manager.readActiveAgent(downloaded.filename) === downloaded.source
        && addedTools.length >= 1
        && evidence.ok,
      detail: `id=${candidate.id}; sha256=${downloaded.sha256}; pid=${evidence.pid}; tool=${addedTools.join(",") || "none"}`,
    };
  });

  const growthSource = agentSource({
    className: "HackerNewsGrowthAgent",
    marker: "RUNTIME_GROWTH_RING",
    markerValue: "ring-1-live",
    reply: "grown HackerNews behavior",
    toolName: "HackerNews",
  });
  await step("grow: verified ring restore moves HEAD and live worker serves it", async () => {
    const appended = ingestVerifiedRing(manager, hackerBaseline, {
      source: growthSource,
      meta: { author: "user", proof: "runtime-grow" },
    });
    hackerGrowthRing = appended.ringRappid;
    const restored = manager.restoreLineage(hackerBaseline.ancestorRappid);
    requireMemoryIntact("grow restore");
    route = await manager.startDefault();
    const evidence = await healthEvidence(manager, route, ["HackerNews"]);
    const workerBytes = manager.readActiveAgent("hacker_news_agent.py");
    return {
      pass: restored.changed.includes(hackerBaseline.ancestorRappid)
        && store.getHead(hackerBaseline.ancestorRappid) === hackerGrowthRing
        && workerBytes === growthSource
        && evidence.ok,
      detail: `ring=${hackerGrowthRing}; composed-sha=${sha256Hex(Buffer.from(workerBytes))}; pid=${evidence.pid}; tool=HackerNews`,
    };
  });

  await step("scramble: lethal os._exit molt is refused without moving HEAD", async () => {
    const lethalSource = `from agents.basic_agent import BasicAgent
import os

os._exit(0)


class LethalMoltAgent(BasicAgent):
    def __init__(self):
        self.name = "LethalMolt"
        self.metadata = {
            "name": "LethalMolt",
            "description": "must never load",
            "parameters": {"type": "object", "properties": {}},
        }
        super().__init__(name=self.name, metadata=self.metadata)

    def perform(self, **kwargs):
        return "never"
`;
    const beforeHead = store.getHead(hackerBaseline.ancestorRappid);
    const beforeRings = store.listRings(hackerBaseline.ancestorRappid).length;
    const beforePid = currentWorker(manager, route).pid;
    const verdict = manager.moltVerifier(lethalSource);
    const evidence = await healthEvidence(manager, route, ["HackerNews"]);
    return {
      pass: verdict?.ok === false
        && /os\._exit/.test(verdict.error || "")
        && store.getHead(hackerBaseline.ancestorRappid) === beforeHead
        && store.listRings(hackerBaseline.ancestorRappid).length === beforeRings
        && evidence.pid === beforePid
        && evidence.ok,
      detail: `gate=${verdict?.error || JSON.stringify(verdict)}; head=${beforeHead}; pid=${evidence.pid}`,
    };
  });

  await step("scramble: colliding verified ring rewinds only its locus", async () => {
    const collisionSource = agentSource({
      className: "HackerNewsCollisionAgent",
      marker: "COLLIDES_WITH_FACTORY",
      markerValue: "ManageMemory",
      reply: "must never become live",
      toolName: "ManageMemory",
    });
    const siblingHead = store.getHead(contextBaseline.ancestorRappid);
    const beforePid = currentWorker(manager, route).pid;
    const appended = ingestVerifiedRing(manager, hackerBaseline, {
      source: collisionSource,
      parentRappid: hackerGrowthRing,
      meta: { author: "user", proof: "composition-collision" },
    });
    store.setHead(hackerBaseline.ancestorRappid, appended.ringRappid);
    route = await manager.startDefault();
    const evidence = await healthEvidence(manager, route, ["HackerNews"]);
    const fallback = manager.lastLineageFallback;
    return {
      pass: fallback?.rejected?.includes(appended.ringRappid)
        && store.getHead(hackerBaseline.ancestorRappid) === hackerGrowthRing
        && store.getHead(contextBaseline.ancestorRappid) === siblingHead
        && manager.readActiveAgent("hacker_news_agent.py") === growthSource
        && evidence.pid === beforePid
        && evidence.ok,
      detail: `rejected=${appended.ringRappid}; rewound=${store.getHead(hackerBaseline.ancestorRappid)}; sibling=${siblingHead}; pid=${evidence.pid}`,
    };
  });

  await step("scramble: truncated live ring resolves to baseline and worker survives", async () => {
    const source = agentSource({
      className: "LearnNewTruncationAgent",
      marker: "TRUNCATION_RING",
      markerValue: "live-before-corruption",
      reply: "truncation proof",
      toolName: "LearnNew",
    });
    const appended = ingestVerifiedRing(manager, learnBaseline, {
      source,
      meta: { author: "user", proof: "truncate" },
    });
    store.setHead(learnBaseline.ancestorRappid, appended.ringRappid);
    route = await manager.startDefault();
    const liveEvidence = await healthEvidence(manager, route, ["LearnNew"]);
    const wasLive = manager.readActiveAgent(
      "rar_rapp_learn_new_agent.py",
    ) === source;
    writeFileSync(
      path.join(
        ringDirectory(
          store,
          learnBaseline.ancestorRappid,
          appended.ringRappid,
        ),
        "source.py",
      ),
      "from agents.basic_agent import BasicAgent\n",
    );
    const resolved = store.resolveLive(learnBaseline.ancestorRappid);
    route = await manager.startDefault();
    const evidence = await healthEvidence(manager, route, ["LearnNew"]);
    const factoryBytes = readFileSync(learnBaseline.sourcePath, "utf8");
    return {
      pass: liveEvidence.ok
        && wasLive
        && resolved.isBaseline === true
        && resolved.ringRappid === learnBaseline.ancestorRappid
        && manager.readActiveAgent("rar_rapp_learn_new_agent.py")
          === factoryBytes
        && evidence.ok,
      detail: `corrupt-head=${appended.ringRappid}; resolved=${resolved.ringRappid}; replacement-pid=${evidence.pid}; alive=${evidence.alive}`,
    };
  });

  await step("scramble: oversized ring is refused at ingest", async () => {
    const isolatedStore = new LineageStore({
      brainstemDir: grailDirectory,
      root: path.join(scratchRoot, "oversized-lineage"),
    });
    const isolatedBaseline = isolatedStore.baselineAncestors().find(
      (baseline) => baseline.filename === "hacker_news_agent.py",
    );
    const base = agentSource({
      className: "OversizedRingAgent",
      marker: "OVERSIZED_RING",
      markerValue: "must-be-refused",
      reply: "oversized",
      toolName: "HackerNews",
    });
    const source = `${base}\n${"# oversized padding\n".repeat(30_000)}`;
    const verdict = manager.moltVerifier(source);
    let appended = null;
    let refusal = verdict?.ok === false
      ? verdict.error || "Molter refused"
      : null;
    if (verdict === true || verdict?.ok === true) {
      try {
        appended = isolatedStore.appendRing(
          isolatedBaseline.ancestorRappid,
          {
            source,
            verified: true,
            meta: {
              author: "runtime-proof",
              verifiedBy: "molter._verify",
            },
          },
        );
      } catch (error) {
        refusal = String(error?.message || error);
      }
    }
    const evidence = await healthEvidence(manager, route, ["HackerNews"]);
    return {
      pass: Boolean(refusal) && !appended && evidence.ok,
      detail: appended
        ? `DEFECT: accepted ${Buffer.byteLength(source)} bytes as ${appended}; worker pid=${evidence.pid} alive=${evidence.alive}`
        : `refused ${Buffer.byteLength(source)} bytes: ${refusal}; worker pid=${evidence.pid}`,
    };
  });

  const transientSource = agentSource({
    className: "HackerNewsTransientAgent",
    marker: "TRANSIENT_VALIDATION_RING",
    markerValue: "fresh-validation-wins",
    reply: "healthy after one transient validator failure",
    toolName: "HackerNews",
  });
  await step("scramble: transient validator failure never demotes healthy HEAD", async () => {
    const appended = ingestVerifiedRing(manager, hackerBaseline, {
      source: transientSource,
      parentRappid: hackerGrowthRing,
      meta: { author: "user", proof: "fresh-validation" },
    });
    hackerTransientRing = appended.ringRappid;
    store.setHead(hackerBaseline.ancestorRappid, hackerTransientRing);
    const realValidator = manager.compositionValidator;
    let flakesLeft = 1;
    manager.compositionValidator = (agentDirectory) => {
      const source = readFileSync(
        path.join(agentDirectory, "hacker_news_agent.py"),
        "utf8",
      );
      if (source.includes("TRANSIENT_VALIDATION_RING") && flakesLeft > 0) {
        flakesLeft -= 1;
        return {
          ok: false,
          error: "Grail dry-load timed out under transient proof load",
        };
      }
      return realValidator(agentDirectory);
    };
    try {
      route = await manager.startDefault();
    } finally {
      manager.compositionValidator = realValidator;
    }
    const evidence = await healthEvidence(manager, route, ["HackerNews"]);
    return {
      pass: flakesLeft === 0
        && store.getHead(hackerBaseline.ancestorRappid)
          === hackerTransientRing
        && manager.readActiveAgent("hacker_news_agent.py") === transientSource
        && manager.lastLineageFallback?.accepted?.includes(
          hackerTransientRing,
        )
        && evidence.ok,
      detail: `head=${store.getHead(hackerBaseline.ancestorRappid)}; accepted=${manager.lastLineageFallback?.accepted?.join(",") || "none"}; pid=${evidence.pid}`,
    };
  });

  await step("scramble: corrupt ring meta.json is skipped without killing worker", async () => {
    const corruptSource = agentSource({
      className: "CorruptMetaAgent",
      marker: "CORRUPT_META_RING",
      markerValue: "must-be-skipped",
      reply: "corrupt meta",
      toolName: "HackerNews",
    });
    const appended = ingestVerifiedRing(manager, hackerBaseline, {
      source: corruptSource,
      parentRappid: hackerTransientRing,
      meta: { author: "user", proof: "corrupt-meta" },
    });
    store.setHead(hackerBaseline.ancestorRappid, appended.ringRappid);
    route = await manager.startDefault();
    const liveEvidence = await healthEvidence(manager, route, ["HackerNews"]);
    const wasLive = manager.readActiveAgent("hacker_news_agent.py")
      === corruptSource;
    writeFileSync(
      path.join(
        ringDirectory(
          store,
          hackerBaseline.ancestorRappid,
          appended.ringRappid,
        ),
        "meta.json",
      ),
      "{ truncated",
    );
    const listed = store.listRings(hackerBaseline.ancestorRappid);
    const inspection = store.inspectLineage(hackerBaseline.ancestorRappid);
    const resolved = store.resolveLive(hackerBaseline.ancestorRappid);
    route = await manager.startDefault();
    const evidence = await healthEvidence(manager, route, ["HackerNews"]);
    const factorySource = readFileSync(hackerBaseline.sourcePath, "utf8");
    return {
      pass: liveEvidence.ok
        && wasLive
        && !listed.some((ring) => ring.ringRappid === appended.ringRappid)
        && inspection.corruptRings >= 1
        && resolved.ringRappid === hackerBaseline.ancestorRappid
        && resolved.isBaseline === true
        && manager.readActiveAgent("hacker_news_agent.py") === factorySource
        && evidence.ok,
      detail: `corrupt-head=${appended.ringRappid}; resolved=${resolved.ringRappid}; corrupt-rings=${inspection.corruptRings}; replacement-pid=${evidence.pid}; alive=${evidence.alive}`,
    };
  });

  await step("words: baseline serves factory behavior and preserves memory", async () => {
    const result = await executeLineageCommand({
      message: "baseline",
      routeManager: manager,
    });
    route = manager.activeRoute;
    requireMemoryIntact("baseline");
    const evidence = await healthEvidence(manager, route, ["HackerNews"]);
    const factorySource = readFileSync(hackerBaseline.sourcePath, "utf8");
    const everyHeadIsBaseline = store.baselineAncestors().every(
      (baseline) => store.getHead(baseline.ancestorRappid)
        === baseline.ancestorRappid,
    );
    return {
      pass: result.intercepted === true
        && result.action === "baseline"
        && manager.readActiveAgent("hacker_news_agent.py") === factorySource
        && everyHeadIsBaseline
        && !result.fallback?.rejected?.length
        && evidence.ok,
      detail: `${result.reply}; all-heads-baseline=${everyHeadIsBaseline}; factory-sha=${sha256Hex(Buffer.from(factorySource))}; pid=${evidence.pid}; memory=identical`,
    };
  });

  await step("words: restore brings verified rings back and preserves memory", async () => {
    const result = await executeLineageCommand({
      message: "restore",
      routeManager: manager,
    });
    route = manager.activeRoute;
    requireMemoryIntact("restore");
    const evidence = await healthEvidence(manager, route, ["HackerNews"]);
    const expectedHeads = new Map(
      store.baselineAncestors().map(
        (baseline) => [baseline.ancestorRappid, baseline.ancestorRappid],
      ),
    );
    expectedHeads.set(contextBaseline.ancestorRappid, contextRing1);
    expectedHeads.set(hackerBaseline.ancestorRappid, hackerTransientRing);
    const everyHeadRestored = [...expectedHeads].every(
      ([ancestorRappid, expected]) => (
        store.getHead(ancestorRappid) === expected
      ),
    );
    return {
      pass: result.intercepted === true
        && result.action === "restore"
        && result.restored === true
        && everyHeadRestored
        && manager.readActiveAgent("hacker_news_agent.py") === transientSource
        && evidence.ok,
      detail: `${result.reply}; all-heads-restored=${everyHeadRestored}; hacker-head=${store.getHead(hackerBaseline.ancestorRappid)}; pid=${evidence.pid}; memory=identical`,
    };
  });

  await step("words: environments reports named HEADs", async () => {
    for (const baseline of store.baselineAncestors()) {
      store.setHead(
        baseline.ancestorRappid,
        baseline.ancestorRappid,
        { env: "prod" },
      );
    }
    const result = await executeLineageCommand({
      message: "environments",
      routeManager: manager,
    });
    requireMemoryIntact("environment creation");
    const hacker = result.environments.find(
      (locus) => locus.ancestorRappid === hackerBaseline.ancestorRappid,
    );
    return {
      pass: result.intercepted === true
        && result.action === "environments"
        && hacker?.environments.some(
          (entry) => entry.env === "default"
            && entry.head === hackerTransientRing,
        )
        && hacker?.environments.some(
          (entry) => entry.env === "prod"
            && entry.head === hackerBaseline.ancestorRappid,
        ),
      detail: `hacker=${hacker?.environments.map((entry) => `${entry.env}:${entry.head}`).join(",")}; memory=identical`,
    };
  });

  await step("words: promote default prod fast-forwards and preserves memory", async () => {
    const expectedProdHeads = headSnapshot(store, "default");
    const result = await executeLineageCommand({
      message: "promote default prod",
      routeManager: manager,
    });
    route = manager.activeRoute;
    requireMemoryIntact("fast-forward promotion");
    const evidence = await healthEvidence(manager, route, ["HackerNews"]);
    const actualProdHeads = headSnapshot(store, "prod");
    const everyHeadPromoted = JSON.stringify(actualProdHeads)
      === JSON.stringify(expectedProdHeads);
    return {
      pass: result.intercepted === true
        && result.action === "promote"
        && result.conflicts.length === 0
        && result.failed.length === 0
        && everyHeadPromoted
        && evidence.ok,
      detail: `${result.reply}; changed=${result.changed}; all-heads-promoted=${everyHeadPromoted}; prod=${store.getHead(hackerBaseline.ancestorRappid, { env: "prod" })}; memory=identical`,
    };
  });

  let prodOnlyRing = null;
  await step("words: prod-only ring makes promote return CONFLICT and moves nothing", async () => {
    const source = agentSource({
      className: "HackerNewsProdOnlyAgent",
      marker: "PROD_ONLY_RING",
      markerValue: "diverged",
      reply: "prod only",
      toolName: "HackerNews",
    });
    const appended = ingestVerifiedRing(manager, hackerBaseline, {
      source,
      parentRappid: hackerTransientRing,
      meta: { author: "prod-operator", environment: "prod" },
    });
    prodOnlyRing = appended.ringRappid;
    store.setHead(
      hackerBaseline.ancestorRappid,
      prodOnlyRing,
      { env: "prod" },
    );
    const beforeDefault = headSnapshot(store, "default");
    const beforeProd = headSnapshot(store, "prod");
    const result = await executeLineageCommand({
      message: "promote default prod",
      routeManager: manager,
    });
    route = manager.activeRoute;
    requireMemoryIntact("conflicting promotion");
    const afterDefault = headSnapshot(store, "default");
    const afterProd = headSnapshot(store, "prod");
    return {
      pass: result.reply.includes("CONFLICT")
        && result.changed === 0
        && result.conflicts.some(
          (conflict) => conflict.ancestorRappid
            === hackerBaseline.ancestorRappid,
        )
        && JSON.stringify(afterDefault) === JSON.stringify(beforeDefault)
        && JSON.stringify(afterProd) === JSON.stringify(beforeProd),
      detail: `${result.reply}; prod=${store.getHead(hackerBaseline.ancestorRappid, { env: "prod" })}; memory=identical`,
    };
  });

  await step("words: drift prod reports the divergent agent", async () => {
    const result = await executeLineageCommand({
      message: "drift prod",
      routeManager: manager,
    });
    const drift = result.drifted.find(
      (entry) => entry.ancestorRappid === hackerBaseline.ancestorRappid,
    );
    return {
      pass: result.intercepted === true
        && result.action === "drift"
        && drift?.actual === prodOnlyRing
        && drift?.expected === hackerTransientRing,
      detail: `${result.reply}; actual=${drift?.actual}; expected=${drift?.expected}`,
    };
  });

  await step("words: corrupt promotions journal refuses without touching bytes", () => {
    const journalFile = promotionJournal(
      store,
      hackerBaseline.ancestorRappid,
    );
    const corruptBytes = "{ deliberately corrupt";
    writeFileSync(journalFile, corruptBytes);
    const beforeHead = store.getHead(
      hackerBaseline.ancestorRappid,
      { env: "prod" },
    );
    const refusal = store.promote(hackerBaseline.ancestorRappid, {
      fromEnv: "default",
      toEnv: "prod",
      actor: "runtime-proof",
    });
    const afterHead = store.getHead(
      hackerBaseline.ancestorRappid,
      { env: "prod" },
    );
    requireMemoryIntact("corrupt-journal promotion");
    return {
      pass: refusal.journal_corrupt === true
        && beforeHead === afterHead
        && readFileSync(journalFile, "utf8") === corruptBytes,
      detail: `${refusal.reason}; head=${afterHead}; journal=byte-identical; memory=identical`,
    };
  });

  await step("memory: every rollback restore promote path kept bytes identical", () => ({
    pass: memoryIsIntact(),
    detail: `sha256=${sha256Hex(readFileSync(memoryFile))}; ${memoryFile}`,
  }));

  await step("persistence: legacy lineage migration preserves memory", () => {
    const manageBaseline = manager.baselineAncestor("manage_memory_agent.py");
    const migratedSource = agentSource({
      className: "MigratedManageMemoryAgent",
      marker: "MIGRATED_USER_RING",
      markerValue: "survives",
      reply: "migrated user behavior",
      toolName: "ManageMemory",
    });
    const verdict = manager.moltVerifier(migratedSource);
    if (verdict !== true && verdict?.ok !== true) {
      throw new Error(verdict?.error || "Molter refused migration fixture.");
    }
    const legacyAncestor = `rappid:@grail/manage-memory-legacy:${"d".repeat(64)}`;
    const legacyRing = `rappid:@frontier/manage-memory-ring:${"e".repeat(64)}`;
    const legacyDirectory = path.join(
      lineageRoot,
      lineageStoreInternals.filesystemSegment(legacyAncestor),
    );
    const legacyRingDirectory = path.join(
      legacyDirectory,
      "rings",
      lineageStoreInternals.filesystemSegment(legacyRing),
    );
    mkdirSync(legacyRingDirectory, { recursive: true });
    writeFileSync(
      path.join(legacyDirectory, "locus.json"),
      JSON.stringify({
        schema: "molt-lineage/1.0",
        ancestorRappid: legacyAncestor,
        filename: manageBaseline.filename,
      }),
    );
    writeFileSync(path.join(legacyDirectory, "HEAD"), `${legacyRing}\n`);
    writeFileSync(
      path.join(legacyRingDirectory, "source.py"),
      migratedSource,
    );
    writeFileSync(
      path.join(legacyRingDirectory, "meta.json"),
      JSON.stringify({
        ringRappid: legacyRing,
        parentRappid: legacyAncestor,
        ancestorRappid: legacyAncestor,
        // The real pre-fix store always recorded the source digest; the
        // migration refuses a ring whose digest it cannot verify.
        sha256: lineageStoreInternals.sourceSha256(migratedSource),
        verified: true,
        createdAt: "2026-08-20T19:25:50.792Z",
        meta: {
          author: "user",
          verifiedBy: "molter._verify",
        },
      }),
    );
    const migrationStore = new LineageStore({
      brainstemDir: grailDirectory,
      root: lineageRoot,
    });
    migrationStore.baselineAncestors();
    const report = migrationStore.lastMigrationReport;
    const live = migrationStore.resolveLive(manageBaseline.ancestorRappid);
    requireMemoryIntact("legacy lineage migration");
    return {
      pass: report?.migrated?.includes(manageBaseline.ancestorRappid)
        && live.isBaseline === false
        && live.source === migratedSource
        && existsSync(path.join(
          lineageRoot,
          `.migrated-${lineageStoreInternals.filesystemSegment(legacyAncestor)}`,
        )),
      detail: `migrated=${report?.migrated?.join(",") || "none"}; head=${live.ringRappid}; memory=identical`,
    };
  });

  const restartHeads = headSnapshot(store, "default");
  const restartCompositionHash = manager.compositionDescriptor()
    .compositionHash;
  await manager.stop();
  managers.delete(manager);

  await step("persistence: new route manager keeps HEADs and composition hash", async () => {
    manager = new BetaRouteManager({
      betaHome,
      brainstemConfig: {
        brainstemDir: grailDirectory,
        python,
      },
      lineageRoot,
      lineageEnv: "default",
    });
    managers.add(manager);
    store = manager.lineageStore;
    const afterHeads = headSnapshot(store, "default");
    const descriptor = manager.compositionDescriptor();
    route = await manager.startDefault();
    const afterActivationHeads = headSnapshot(store, "default");
    const evidence = await healthEvidence(
      manager,
      route,
      ["FixtureAgent", "HackerNews", "ManageMemory"],
    );
    requireMemoryIntact("route manager restart");
    return {
      pass: JSON.stringify(afterHeads) === JSON.stringify(restartHeads)
        && JSON.stringify(afterActivationHeads) === JSON.stringify(restartHeads)
        && descriptor.compositionHash === restartCompositionHash
        && route.compositionHash === restartCompositionHash
        && manager.lastLineageFallback === null
        && evidence.ok,
      detail: `requested-hash=${descriptor.compositionHash}; live-hash=${route.compositionHash}; heads=${Object.keys(afterActivationHeads).length}; fallback=none; pid=${evidence.pid}; memory=identical`,
    };
  });

  await step("persistence: two twin managers keep live owner and reap abandoned root", () => {
    const { pid } = currentWorker(manager, route);
    const twinsRoot = path.join(betaHome, "twins");
    const liveDirectory = path.join(twinsRoot, "live-owner");
    const abandonedDirectory = path.join(twinsRoot, "abandoned-owner");
    mkdirSync(path.join(liveDirectory, "agents"), { recursive: true });
    mkdirSync(path.join(abandonedDirectory, "agents"), { recursive: true });
    writeFileSync(
      path.join(liveDirectory, "owner.json"),
      JSON.stringify({ pid, startedAt: "2026-08-20T19:25:50.792Z" }),
    );
    writeFileSync(
      path.join(abandonedDirectory, "owner.json"),
      JSON.stringify({
        pid: 2_147_483_647,
        startedAt: "2026-08-20T19:25:50.792Z",
      }),
    );
    const events = [];
    const first = new TwinManager({
      betaHome,
      brainstemConfig: manager.brainstemConfig,
      routeManager: manager,
      storeClient: {},
      onEvent: (event) => events.push(event),
    });
    const second = new TwinManager({
      betaHome,
      brainstemConfig: manager.brainstemConfig,
      routeManager: manager,
      storeClient: {},
      onEvent: (event) => events.push(event),
    });
    const secondReport = second.reapStaleTwinDirectories();
    return {
      pass: existsSync(liveDirectory)
        && !existsSync(abandonedDirectory)
        && events.filter((event) => event.type === "twin-dir-kept").length >= 2
        && secondReport.kept.some((entry) => entry.pid === pid)
        && pidIsAlive(pid)
        && first.twinsRoot === second.twinsRoot,
      detail: `twin-dir-kept pid=${pid}; abandoned-reaped=${!existsSync(abandonedDirectory)}; shared-root=${first.twinsRoot}`,
    };
  });

  const beforeUpgradeContext = manager.baselineAncestor(
    "context_memory_agent.py",
  );
  const ringsBeforeUpgrade = store.listRings(
    beforeUpgradeContext.ancestorRappid,
  ).map((ring) => ring.ringRappid);
  writeFileSync(
    beforeUpgradeContext.sourcePath,
    `${readFileSync(beforeUpgradeContext.sourcePath, "utf8").trimEnd()}\n\n# runtime proof Grail v2\n`,
  );
  await manager.stop();
  managers.delete(manager);

  await step("Grail upgrade: Frontier ring-1 is not served across baseline drift", async () => {
    manager = new BetaRouteManager({
      betaHome,
      brainstemConfig: {
        brainstemDir: grailDirectory,
        python,
      },
      lineageRoot,
      lineageEnv: "default",
    });
    managers.add(manager);
    store = manager.lineageStore;
    const after = manager.baselineAncestor("context_memory_agent.py");
    const ringsAfter = store.listRings(after.ancestorRappid)
      .map((ring) => ring.ringRappid);
    const upgradeDescriptor = manager.compositionDescriptor();
    const contextEntry = upgradeDescriptor.entries.find(
      (entry) => entry.filename === "context_memory_agent.py",
    );
    const drift = manager.telemetrySnapshot().events.find(
      (event) => event.type === "lineage-default-skipped"
        && /baseline bytes do not match/.test(event.reason || ""),
    );
    route = await manager.startDefault();
    const evidence = await healthEvidence(manager, route, ["ContextMemory"]);
    const { worker } = currentWorker(manager, route);
    const liveContextEntry = worker?.descriptor?.entries.find(
      (entry) => entry.filename === "context_memory_agent.py",
    );
    const liveContextBytes = manager.readActiveAgent(
      "context_memory_agent.py",
    );
    const servesFrontierRing1 = liveContextEntry?.lineage?.ringRappid
      === contextRing1
      || liveContextBytes.includes("class _ContextMemoryRing1");
    requireMemoryIntact("Grail upgrade");
    return {
      pass: after.ancestorRappid === beforeUpgradeContext.ancestorRappid
        && ringsBeforeUpgrade.every((ring) => ringsAfter.includes(ring))
        && !servesFrontierRing1
        && Boolean(drift)
        && evidence.ok,
      detail: `locus-stable=${after.ancestorRappid === beforeUpgradeContext.ancestorRappid}; rings=${ringsAfter.length}; requested-ring=${contextEntry?.lineage?.ringRappid || "baseline"}; live-ring=${liveContextEntry?.lineage?.ringRappid || "baseline"}; frontier-ring-served=${servesFrontierRing1}; drift-telemetry=${Boolean(drift)}; pid=${evidence.pid}; memory=identical`,
    };
  });

  await step("Grail upgrade: user-authored ring still serves on live worker", async () => {
    const { worker } = currentWorker(manager, route);
    const hackerEntry = worker?.descriptor?.entries.find(
      (entry) => entry.filename === "hacker_news_agent.py",
    );
    const evidence = await healthEvidence(
      manager,
      route,
      ["HackerNews", "ManageMemory"],
    );
    const workerBytes = manager.readActiveAgent("hacker_news_agent.py");
    return {
      pass: hackerEntry?.lineage?.ringRappid === hackerTransientRing
        && workerBytes === transientSource
        && evidence.ok
        && memoryIsIntact(),
      detail: `ring=${hackerEntry?.lineage?.ringRappid || "baseline"}; composed-sha=${sha256Hex(Buffer.from(workerBytes))}; pid=${evidence.pid}; memory=identical`,
    };
  });

  await step("isolation: all configured writable roots are inside scratch", () => {
    const writableRoots = [
      betaHome,
      grailDirectory,
      lineageRoot,
      memoryFile,
      process.env.BRAINSTEM_HOME,
      process.env.GH_CONFIG_DIR,
      process.env.MOLTER_HOME,
      process.env.PIP_CACHE_DIR,
      process.env.XDG_CONFIG_HOME,
    ].map((entry) => path.resolve(entry));
    const pythonPackagesAfter = pythonPackageFingerprint();
    const rootsInsideScratch = writableRoots.every(
      (entry) => entry === scratchRoot
        || entry.startsWith(`${scratchRoot}${path.sep}`),
    );
    return {
      pass: rootsInsideScratch
        && pythonPackagesAfter === pythonPackagesBefore,
      detail: `scratch=${scratchRoot}; roots=${writableRoots.length}; python-packages-unchanged=${pythonPackagesAfter === pythonPackagesBefore}; python-env-sha=${pythonPackagesAfter}`,
    };
  });
} catch (error) {
  failed = true;
  rows.push({
    name: "proof harness",
    result: "FAIL",
    detail: String(error?.stack || error?.message || error),
  });
} finally {
  const cleanup = await cleanupResources();
  rows.push({
    name: "cleanup: every worker stopped and scratch root removed",
    result: cleanup.pass ? "PASS" : "FAIL",
    detail: cleanup.pass
      ? `workers=${workerPids.size}; scratch-removed=true`
      : `error=${cleanup.error?.message || cleanup.error || "none"}; live-pids=${cleanup.livePids.join(",")}; scratch-exists=${existsSync(scratchRoot)}`,
  });
  if (!cleanup.pass) failed = true;
}

printTable();
if (failed || rows.some((row) => row.result === "FAIL")) {
  process.exitCode = 1;
}
