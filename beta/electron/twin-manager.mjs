// Twin manager — hatches rapplications from the RAPP Store as concurrent,
// long-lived Brainstem workers ("twins"), each on its own loopback port.
//
// Canon (crawled kody-w/rapp-spine — see docs/twins/COMPLIANCE.md):
//   * A herd of twins is one coordinator managing many Brainstem workers.
//   * Chat is the ONLY wire (Art. XXV): a twin is driven only over its worker's
//     `/chat`. We add NO route, never the legacy `/api/agent` (a known RCE).
//   * The shippable unit is the `rapp-cart/1.0` cartridge (the store's
//     `singleton_url` agent.py + optional `egg_url` .egg); ports/twins stay
//     under the hood.
//   * Twin workers bind 127.0.0.1 only (rapp-kernel-boundary/1.0).
//   * RAPPID mint-once via the route manager's UUID-anchor packageAgent.
//
// Unlike BetaRouteManager's single-active-composition model (workers retire on
// activate), twins are kept alive concurrently in a registry until closed.
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import path from "node:path";

import { BrainstemProcess } from "./brainstem-process.mjs";
import {
  inferAgentToolName,
  recordCompletedTurn,
} from "./ledger.mjs";
import {
  pruneLogFiles,
  redactCredentialText,
} from "./log-redaction.mjs";
import { readEgg, verifyEgg } from "./rapp-protocol.mjs";

const AGENT_FILE = /^[A-Za-z0-9_.-]+_agent\.py$/;

function allocatePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : null;
      server.close((error) => {
        if (error) reject(error);
        else if (!port) reject(new Error("Could not allocate a twin port."));
        else resolve(port);
      });
    });
  });
}

function twinSlug(value) {
  return String(value || "twin")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "twin";
}

// A twin needs the user only for a genuine, user-owned sign-in — match an auth
// REQUEST, not incidental auth vocabulary in an otherwise normal answer (so a
// reply like "users authenticate with their org account" doesn't abort a loop).
const NEEDS_AUTH_RE = /\b(please sign in|sign in (?:to continue|required|and continue|first)|device login|device code|run device login|not authenticated|authentication (?:required|needed)|authenticate (?:first|to continue)|pac auth login|you (?:need|must) to (?:sign in|authenticate)|requires? (?:you to )?(?:sign in|authenticate))\b/i;

// Completion detection for a twin's own reply (run()): not fooled by negation
// ("I am not done") and never treats an empty reply as success.
function saysDone(text) {
  const t = String(text || "").trim();
  if (!t) return false;
  if (/\b(?:not|isn'?t|cannot|can'?t|won'?t|unable to|couldn'?t|never|no longer)\s+(?:\w+\s+){0,3}(?:done|complete|completed|finished)\b/i.test(t)) return false;
  return /\b(done|complete|completed|finished|no further (?:action|steps)|draft (?:is )?ready)\b/i.test(t);
}

// The planner is told to answer "DONE — …"; accept it at the start of the reply
// or on its own line (tolerating a short preamble) so completion isn't missed
// and the "DONE — …" line is never forwarded to the twin as an instruction.
const planIsDone = (plan) => /(^|\n)\s*DONE\b/i.test(String(plan || ""));

const OWNER_FILE = "owner.json";
const CLAIM_SUFFIX = ".claim.json";

function sha256(source) {
  return createHash("sha256").update(source).digest("hex");
}

function discoverTwinMolts(molterHome, seen = new Set()) {
  const records = [];
  const moltsRoot = path.join(molterHome, "molts");
  let capabilities = [];
  try {
    capabilities = readdirSync(moltsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .sort((left, right) => left.name.localeCompare(right.name));
  } catch {
    return records;
  }
  for (const capabilityEntry of capabilities) {
    const capabilityDir = path.join(moltsRoot, capabilityEntry.name);
    let generations = [];
    try {
      generations = readdirSync(capabilityDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && /^gen-\d+$/.test(entry.name))
        .sort((left, right) => left.name.localeCompare(right.name));
    } catch {
      continue;
    }
    for (const generation of generations) {
      const generationDir = path.join(capabilityDir, generation.name);
      const metaPath = path.join(generationDir, "molt.json");
      const sourcePath = path.join(generationDir, "agent.py");
      if (seen.has(metaPath)) continue;
      try {
        const meta = JSON.parse(readFileSync(metaPath, "utf8"));
        const source = readFileSync(sourcePath);
        const capability = capabilityEntry.name;
        const filename = `${capability.replace(/[^a-z0-9_]+/gi, "_")}_agent.py`;
        seen.add(metaPath);
        records.push({
          capability,
          detail: {
            ...meta,
            molt_path: metaPath,
            recorded_sha256: meta.sha256 || null,
          },
          filename,
          sha256: sha256(source),
          source,
          source_path: sourcePath,
          tool_name: meta.detail?.tool_name
            || inferAgentToolName(source, filename),
        });
      } catch {
        // A partial generation is not a reported molt; retry after the next turn.
      }
    }
  }
  return records;
}

function readOwner(dir) {
  try {
    const owner = JSON.parse(readFileSync(path.join(dir, OWNER_FILE), "utf8"));
    return Number.isInteger(owner?.pid) && owner.pid > 0 ? owner : null;
  } catch {
    return null;
  }
}

function claimFilePath(twinsRoot, id) {
  return path.join(twinsRoot, `.${id}${CLAIM_SUFFIX}`);
}

function readClaim(filePath) {
  try {
    const claim = JSON.parse(readFileSync(filePath, "utf8"));
    return Number.isInteger(claim?.pid) && claim.pid > 0 ? claim : null;
  } catch {
    return null;
  }
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function removeTwinDirectories(twin) {
  for (const directory of new Set([twin?.dir, twin?.molterHome])) {
    if (!directory) continue;
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch {
      // Teardown remains best effort on platforms with transient file locks.
    }
  }
}

export class TwinManager {
  constructor({
    brainstemConfig,
    betaHome,
    createWorkerProcess = (config) => new BrainstemProcess(config),
    routeManager = null,
    storeClient,
    brainstemUrl = null,
    ledger = null,
    refreshAmbient = () => {},
    onEvent = () => {},
  }) {
    if (!brainstemConfig) throw new Error("TwinManager needs a brainstemConfig.");
    if (!storeClient) throw new Error("TwinManager needs a RAPP Store client.");
    this.brainstemConfig = brainstemConfig;
    // Resolver for the *current* visible Brainstem's base URL — used when the
    // Brainstem drives a two-brain loop with a twin. Defaults to the config URL;
    // main passes () => state.url so a routed Brainstem is honored.
    this.brainstemUrl = brainstemUrl || (() => this.brainstemConfig.url);
    this.betaHome = betaHome;
    this.createWorkerProcess = createWorkerProcess;
    this.routeManager = routeManager;
    this.ledger = ledger;
    this.refreshAmbient = typeof refreshAmbient === "function"
      ? refreshAmbient
      : () => {};
    this.store = storeClient;
    this.onEvent = onEvent;
    this.twins = new Map();
    this.seq = 0;
    this.maxTwins = 8;   // cap concurrent workers so a runaway can't exhaust the machine
    this.twinsRoot = path.join(betaHome, "twins");
    this.twinLogRoot = path.join(betaHome, "logs", "twins");
    // Clear stale twin dirs left by a crashed previous session — but only the
    // ones nobody owns. The twins root is shared state under the beta home; a
    // second launcher, a CLI, or a parallel session may be running its own twins
    // in it right now, and wiping the whole root used to take their live
    // generations away (and the Molter's installed capability with them).
    // NOTE: this does NOT reap an orphaned worker process from a hard-killed
    // prior session (that stays until the OS reclaims its port).
    this.reapStaleTwinDirectories();
    mkdirSync(this.twinLogRoot, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") chmodSync(this.twinLogRoot, 0o700);
    this.pruneTwinLogs();
  }

  // A twin directory is stale when its recorded owner process is gone (or it
  // predates ownership records). A directory owned by another live process on
  // this machine is left alone and reported.
  reapStaleTwinDirectories() {
    let entries = [];
    try {
      entries = readdirSync(this.twinsRoot, { withFileTypes: true });
    } catch {
      return { removed: [], kept: [] };
    }
    const removed = [];
    const kept = [];
    for (const entry of entries) {
      if (
        !entry.isFile()
        || !entry.name.startsWith(".")
        || !entry.name.endsWith(CLAIM_SUFFIX)
      ) continue;
      const filePath = path.join(this.twinsRoot, entry.name);
      const claim = readClaim(filePath);
      if (!claim || !processAlive(claim.pid)) {
        try { rmSync(filePath, { force: true }); } catch { /* best effort */ }
      }
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(this.twinsRoot, entry.name);
      const owner = readOwner(dir);
      const claimPath = claimFilePath(this.twinsRoot, entry.name);
      const claim = readClaim(claimPath);
      if (claim && processAlive(claim.pid)) {
        kept.push({ id: entry.name, pid: claim.pid });
        continue;
      }
      if (owner && owner.pid !== process.pid && processAlive(owner.pid)) {
        kept.push({ id: entry.name, pid: owner.pid });
        continue;
      }
      try { rmSync(claimPath, { force: true }); } catch { /* best effort */ }
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
      removed.push(entry.name);
    }
    for (const twin of kept) {
      this.emit({ type: "twin-dir-kept", id: twin.id, ownerPid: twin.pid });
    }
    return { removed, kept };
  }

  pruneTwinLogs({
    keep = 20,
    maxAgeMs = 14 * 24 * 60 * 60 * 1000,
    now = Date.now(),
  } = {}) {
    return pruneLogFiles(this.twinLogRoot, {
      keep,
      match: (name) => /\.log(?:\.\d+)?$/.test(name),
      maxAgeMs,
      now,
      protectedNames: new Set(
        [...this.twins.keys()].map((id) => `${id}.log`),
      ),
    });
  }

  emit(event) {
    this.onEvent({ timestamp: new Date().toISOString(), ...event });
  }

  descriptor(twin) {
    return {
      id: twin.id,
      storeId: twin.storeId,
      name: twin.name,
      rappid: twin.rappid,
      port: twin.port,
      url: twin.url,
      status: twin.status,
      license: twin.license,
      uiUrl: twin.uiUrl,
      preferredView: twin.preferredView || "full",
      hasCustomUi: Boolean(twin.uiHtml),
      loopLog: twin.loopLog.slice(-40),
      createdUtc: twin.createdUtc,
    };
  }

  list() {
    return Array.from(this.twins.values(), (twin) => this.descriptor(twin));
  }

  get(id) {
    const twin = this.twins.get(String(id));
    if (!twin) throw new Error(`No twin "${id}".`);
    return twin;
  }

  // The rapplication's own static UI HTML (to inject into its twin's iframe).
  uiHtml(id) {
    return this.twins.get(String(id))?.uiHtml || null;
  }

  #log(twin, line) {
    const safeLine = redactCredentialText(String(line)).slice(0, 600);
    twin.loopLog.push({ at: new Date().toISOString(), line: safeLine });
    this.emit({
      type: "twin-log",
      id: twin.id,
      line: safeLine,
      status: twin.status,
    });
  }

  #setStatus(twin, status) {
    if (twin.closed) return;   // a closed twin must not re-emit and resurrect its tile
    twin.status = status;
    this.emit({ type: "twin-status", id: twin.id, status, twin: this.descriptor(twin) });
  }

  // Hatch a rapplication FROM THE STORE into its own long-lived worker.
  async hatch(storeId, { instruction = null } = {}) {
    const cartridge = await this.store.download(storeId);   // sha256-verified
    const filename = cartridge.filename && /_agent\.py$/.test(cartridge.filename)
      ? cartridge.filename
      : `${twinSlug(cartridge.id || storeId)}_agent.py`;
    return this.#hatchComposed({
      idBase: cartridge.id || storeId,
      name: cartridge.entry?.name || cartridge.id || storeId,
      storeId: cartridge.id || storeId,
      agentSources: [{ filename, source: cartridge.source }],
      egg: cartridge.egg || null,
      resources: [],
      license: cartridge.entry?.license || null,
      uiUrl: null,
      uiHtml: cartridge.uiHtml || null,   // sha-verified by the store client, or null
      preferredView: cartridge.entry?.preferredView || "full",
      // Where these bytes came from, kept with the twin so a recall can find it
      // and so a non-default catalog stays visible after the fact.
      storeUrl: cartridge.storeUrl || null,
      trustedSource: cartridge.trustedSource !== false,
      note: (cartridge.trustedSource === false
        // "Verified" must not read identically for a catalog the user pointed at
        // themselves: the pin came from that same document, so it proves the
        // bytes match what THAT catalog said — not who wrote them.
        ? `Installed ${filename} from a custom catalog (${cartridge.storeUrl}) `
          + `— bytes match that catalog's own pin (sha256 ${cartridge.sha256.slice(0, 12)}…), `
          + "which vouches for consistency, not origin"
        : `Verified ${filename} (sha256 ${cartridge.sha256.slice(0, 12)}…)`)
        + (cartridge.uiNote ? ` — ${cartridge.uiNote}` : ""),
    }, { instruction });
  }

  // Hatch a twin from a LOCAL .egg the user dropped on the window. Fail-closed:
  // the egg must pass the rapp/1-egg verifier before a single byte is used.
  // Contract: variant "rapplication"; agents/*_agent.py become the twin's
  // AGENTS_PATH; an optional ui.html becomes the custom rapplication UI
  // (injected same-origin over the twin's Grail chat); every other file is
  // materialized into the twin dir as a local resource. Nothing is fetched.
  async hatchEgg({ bytes, filename = "dropped.egg" } = {}, { instruction = null } = {}) {
    const blob = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
    if (!blob.length) throw new Error("The dropped egg is empty.");
    const [ok, law, reason] = verifyEgg(blob);
    if (!ok) throw new Error(`Refusing to hatch ${filename}: egg failed verification (${law}: ${reason}).`);
    const { manifest, files } = readEgg(blob);
    if (manifest.variant !== "rapplication") {
      throw new Error(`Refusing to hatch ${filename}: variant "${manifest.variant}" is not a rapplication egg.`);
    }
    const agentSources = [];
    const resources = [];
    let uiHtml = null;
    const seenBasenames = new Set();
    for (const [name, data] of Object.entries(files)) {
      const base = name.split("/").pop();
      if (seenBasenames.has(base)) {
        throw new Error(`Refusing to hatch ${filename}: two egg entries flatten to the same file name "${base}".`);
      }
      seenBasenames.add(base);
      if (/_agent\.py$/.test(base)) {
        agentSources.push({ filename: base, source: Buffer.from(data).toString("utf8") });
      } else if (base === "ui.html") {
        uiHtml = Buffer.from(data).toString("utf8");
      } else {
        resources.push({ name: base, bytes: Buffer.from(data) });
      }
    }
    if (!agentSources.length) {
      throw new Error(`Refusing to hatch ${filename}: the egg carries no *_agent.py engine.`);
    }
    const slugSource = manifest.payload?.name
      || (manifest.rappid || "").split(":").pop()?.split("/").pop()
      || filename.replace(/\.egg$/i, "");
    return this.#hatchComposed({
      idBase: slugSource,
      name: manifest.payload?.name || slugSource,
      storeId: null,
      agentSources,
      egg: Buffer.from(blob),
      resources,
      license: manifest.payload?.license || null,
      uiUrl: null,
      uiHtml,
      note: `Hatched from ${filename} (rapp/1-egg verified, ${agentSources.length} agent${agentSources.length === 1 ? "" : "s"})`,
    }, { instruction });
  }

  // Hatch a twin from LOCAL agent sources (e.g. the bundled Copilot Studio
  // Factory + Deploy agents) — a Frontier-owned specialized twin, not a store
  // pull. Same worker/port/loop machinery; nothing is downloaded.
  async hatchLocal({
    id: idBase = "twin",
    name = idBase,
    agentSources = [],
    resources = [],
    license = null,
  } = {}, { instruction = null } = {}) {
    if (!agentSources.length) throw new Error("hatchLocal needs at least one agent source.");
    return this.#hatchComposed({
      idBase, name, storeId: null, agentSources, egg: null, resources, license, uiUrl: null,
      note: `Composed ${agentSources.map((a) => a.filename).join(", ")}`,
    }, { instruction });
  }

  // Shared core: compose an isolated AGENTS_PATH, start a dedicated worker on
  // its own loopback port, register it, and (optionally) kick its async loop.
  async #hatchComposed(spec, { instruction = null } = {}) {
    this.pruneTwinLogs();
    if (this.twins.size >= this.maxTwins) {
      throw new Error(`You have ${this.maxTwins} twins open — close one before hatching another.`);
    }
    const agentSources = [];
    const seenAgentFilenames = new Set();
    for (const agent of spec.agentSources) {
      const supplied = String(agent.filename || "");
      const filename = path.basename(supplied);
      if (supplied !== filename || /[\\/]/.test(supplied)
          || !AGENT_FILE.test(filename) || filename === "basic_agent.py") {
        throw new Error(`Refusing to hatch "${spec.name}": agent filename must be a safe *_agent.py basename.`);
      }
      if (seenAgentFilenames.has(filename)) {
        throw new Error(`Refusing to hatch "${spec.name}": duplicate agent filename "${filename}".`);
      }
      seenAgentFilenames.add(filename);
      agentSources.push({ ...agent, filename });
    }
    // Two launchers (or a launcher and a parallel session) may share one
    // betaHome, and each starts its sequence at 0: the id is claimed by
    // creating its directory atomically, and a taken name is skipped — never
    // adopted — so owner.json can only ever describe the twin that lives there.
    mkdirSync(this.twinsRoot, { recursive: true });
    let id = null;
    let dir = null;
    let claimPath = null;
    for (let candidate = this.seq + 1; candidate < this.seq + 10000; candidate += 1) {
      const candidateId = `${twinSlug(spec.idBase)}-${candidate}`;
      const candidateDir = path.join(this.twinsRoot, candidateId);
      const candidateClaim = claimFilePath(this.twinsRoot, candidateId);
      try {
        writeFileSync(
          candidateClaim,
          JSON.stringify({
            pid: process.pid,
            startedAt: new Date().toISOString(),
          }),
          { flag: "wx", mode: 0o600 },
        );
      } catch (error) {
        if (error?.code === "EEXIST") continue;
        throw error;
      }
      try {
        mkdirSync(candidateDir);
      } catch (error) {
        try { rmSync(candidateClaim, { force: true }); } catch { /* best effort */ }
        if (error?.code === "EEXIST") continue;
        throw error;
      }
      this.seq = candidate;
      id = candidateId;
      dir = candidateDir;
      claimPath = candidateClaim;
      break;
    }
    if (!id) throw new Error(`Refusing to hatch "${spec.name}": no free twin id.`);
    const agentsDir = path.join(dir, "agents");
    try {
      writeFileSync(
        path.join(dir, OWNER_FILE),
        JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
        { mode: 0o600 },
      );
    } catch (error) {
      try { rmSync(claimPath, { force: true }); } catch { /* best effort */ }
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
      throw error;
    }
    try { rmSync(claimPath, { force: true }); } catch { /* best effort */ }
    // A grown capability must survive a restart (the Molter rehydrates from
    // MOLTER_HOME), so the home is keyed by the rapplication's identity, not
    // by this hatch: a fresh id + UUID per hatch made rehydration impossible and
    // orphaned a directory every time. A second LIVE twin of the same
    // rapplication cannot share that state, so it takes an ephemeral home;
    // both are removed when their twin is closed.
    const stableMolterHome = path.join(
      this.betaHome,
      "molts",
      twinSlug(spec.idBase),
    );
    const claimedByLiveTwin = [...this.twins.values()]
      .some((existing) => existing?.molterHome === stableMolterHome);
    const molterHome = claimedByLiveTwin
      ? path.join(this.betaHome, "molts", `${id}-${randomUUID()}`)
      : stableMolterHome;
    mkdirSync(molterHome, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") chmodSync(molterHome, 0o700);
    let materializedAgentSources = agentSources;
    let port;
    let url;
    let worker;
    let rappid = null;
    const resourcePaths = {};
    try {
      if (this.routeManager?.materializeExternalAgentSet) {
        materializedAgentSources = this.routeManager.materializeExternalAgentSet(
          agentSources,
          agentsDir,
        );
      } else {
        mkdirSync(agentsDir, { recursive: true });
        for (const agent of agentSources) {
          writeFileSync(
            path.join(agentsDir, agent.filename),
            agent.source,
            { mode: 0o600 },
          );
        }
      }
      if (spec.egg) {
        writeFileSync(path.join(dir, `${id}.egg`), spec.egg, { mode: 0o600 });
      }
      // Materialize any resource files (e.g. parity cases / industry matrix)
      // into the twin dir so its agents can read them locally.
      for (const resource of spec.resources || []) {
        const target = path.join(dir, resource.name);
        writeFileSync(target, resource.bytes, { mode: 0o600 });
        resourcePaths[resource.name] = target;
      }

      // Mint a mint-once RAPPID from the first agent (UUID-anchor; rapp/1 §6.2).
      try {
        const first = materializedAgentSources[0];
        rappid = this.routeManager?.packageAgent
          ? this.routeManager.packageAgent({ filename: first.filename, source: first.source }).agent_rappid
          : null;
      } catch {
        rappid = null;
      }

      port = await allocatePort();
      url = `http://127.0.0.1:${port}`;
      worker = this.createWorkerProcess({
        ...this.brainstemConfig,
        port,
        portPreallocated: true,
        url,
        logFile: path.join(this.twinLogRoot, `${id}.log`),
        env: {
          ...(this.brainstemConfig.env || {}),
          AGENTS_PATH: agentsDir,
          BRAINSTEM_BETA_ROUTED_WORKER: "1",
          BRAINSTEM_BETA_TWIN: id,
          MOLTER_HOME: molterHome,
          RAPP_AMBIENT_DIR: path.join(this.betaHome, "ambient"),
          // A twin runs sha-pinned-but-still-third-party store code — it must
          // always bind loopback, never inherit the main Brainstem's LAN mode.
          BRAINSTEM_LAN_MODE: "0",
        },
      });
    } catch (error) {
      removeTwinDirectories({ dir, molterHome });
      throw error;
    }

    const twin = {
      id,
      storeId: spec.storeId,
      name: spec.name,
      rappid,
      port,
      url,
      status: "hatching",
      license: spec.license,
      uiUrl: spec.uiUrl,
      preferredView: spec.preferredView || "full",
      dir,
      resourcePaths,
      worker,
      uiHtml: null,
      loopLog: [],
      molterHome,
      running: false,
      seenMolts: new Set(),
    };
    this.twins.set(id, twin);
    this.emit({ type: "twin-hatched", id, twin: this.descriptor(twin) });
    const hatchOrigin = spec.storeId ? "store" : (spec.egg ? "egg" : "surgeon");
    for (const agent of materializedAgentSources) {
      const archivedSource = this.ledger?.archiveAgentSource?.({
        filename: agent.filename,
        source: agent.source,
      }) || null;
      const sourcePath = archivedSource?.path
        || path.join(agentsDir, agent.filename);
      this.ledger?.recordAgent?.({
        event: "hatched",
        filename: agent.filename,
        toolName: inferAgentToolName(agent.source, agent.filename),
        rappid,
        sha256: archivedSource?.sha256 || sha256(agent.source),
        sourcePath,
        origin: hatchOrigin,
        detail: {
          twin_id: id,
          store_id: spec.storeId,
        },
      });
    }
    this.#log(twin, `${spec.note} — hatching on ${url}`);

    try {
      await worker.start();
    } catch (error) {
      this.#setStatus(twin, "error");
      this.#log(twin, `Failed to start: ${error.message}`);
      await this.#disposeTwin(twin);
      this.emit({ type: "twin-closed", id });
      throw error;
    }
    this.#setStatus(twin, "ready");
    this.#log(twin, `Twin ready on ${url}`);

    // If the rapplication ships its OWN UI (static HTML), fetch it and keep it.
    // The tile loads the twin's Grail UI (same origin as the twin) and then
    // wipes it and injects this HTML in its place — so the custom UI's relative
    // /chat hits the twin directly (same origin, no server, no proxy, no CORS).
    if (spec.uiHtml) {
      twin.uiHtml = spec.uiHtml;
      this.#log(twin, `Custom rapplication UI verified and ready (${twin.uiHtml.length} bytes) — overrides the default Grail chat`);
      this.emit({ type: "twin-status", id, status: twin.status, twin: this.descriptor(twin) });
    }
    // A bare ui_url is never fetched here: executable UI reaches a twin only
    // sha-verified through the store client, or carried inside a verified egg.

    if (instruction) {
      // Kick its autonomous loop, but DO NOT block on it — the caller (and the
      // main Brainstem/Surgeon chat) stays free while the twin works.
      this.run(id, instruction).catch((error) => this.#log(twin, `Loop error: ${error.message}`));
    }
    return this.descriptor(twin);
  }

  // The wire: POST /chat to the twin's own worker (loopback). Every exchange is
  // emitted as a twin-message so the tile shows a live MULTIPLAYER transcript —
  // the Brainstem loop, the Brain Surgeon, and the user all talking to the same
  // rapplication in one room. Default session is shared per twin ("the room").
  async chat(id, prompt, { author = "you", sessionId = null } = {}) {
    const twin = this.get(id);
    const text = String(prompt || "");
    this.emit({ type: "twin-message", id, author, role: "user", text });
    // The kernel /chat is STATELESS — session_id does not accumulate turns
    // server-side; conversation_history is the only continuity mechanism. Carry a
    // per-twin room history so the loop, the Surgeon, and the user all build on
    // prior turns instead of speaking to a memoryless twin each time.
    if (!Array.isArray(twin.roomHistory)) twin.roomHistory = [];
    const effectiveSessionId = sessionId || `twin-room-${id}`;
    const requestId = randomUUID();
    const body = {
      user_input: text,
      session_id: effectiveSessionId,
      conversation_history: twin.roomHistory.slice(-40),
    };
    let data;
    try {
      try {
        await this.refreshAmbient();
      } catch {
        // Ambient context is additive; twin chat stays fail-open.
      }
      const response = await fetch(`${twin.url}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error(`Twin ${id} /chat returned HTTP ${response.status}.`);
      data = await response.json();
    } catch (error) {
      this.emit({ type: "twin-message", id, author: twin.name || "twin", role: "error", text: error.message });
      throw error;
    } finally {
      this.mirrorMolts(twin);
    }
    const reply = String(data.response || data.assistant_response || data.result || "");
    twin.roomHistory.push({ role: "user", content: text }, { role: "assistant", content: reply });
    if (twin.roomHistory.length > 80) twin.roomHistory.splice(0, twin.roomHistory.length - 80);
    this.emit({ type: "twin-message", id, author: twin.name || "twin", role: "assistant", text: reply });
    recordCompletedTurn(this.ledger, {
      agentLogs: data.agent_logs,
      model: data.model,
      requestId,
      response: reply,
      sessionId: data.session_id || effectiveSessionId,
      surface: `twin:${id}`,
      userInput: text,
    });
    return data;
  }

  mirrorMolts(twinOrId) {
    const twin = typeof twinOrId === "string"
      ? this.get(twinOrId)
      : twinOrId;
    if (!twin || !this.ledger) return [];
    const records = discoverTwinMolts(
      twin.molterHome || path.join(twin.dir, "molter"),
      twin.seenMolts,
    );
    for (const record of records) {
      const archivedSource = this.ledger.archiveAgentSource?.({
        filename: record.filename,
        source: record.source,
      }) || null;
      this.ledger.recordAgent({
        event: "molted",
        filename: record.filename,
        toolName: record.tool_name,
        rappid: twin.rappid,
        sha256: archivedSource?.sha256 || record.sha256,
        sourcePath: archivedSource?.path || record.source_path,
        origin: "molter",
        detail: {
          ...record.detail,
          capability: record.capability,
          twin_id: twin.id,
        },
      });
    }
    return records;
  }

  // A bounded autonomous loop driven by the Brainstem over /chat. P1 proves the
  // loop end-to-end; the specialized Copilot Studio deploy loop is P2.
  async run(id, instruction, options = {}) {
    const { maxRounds = 4 } = options;
    const twin = this.get(id);
    if (twin.running) throw new Error(`Twin ${id} is already looping.`);
    twin.running = true;
    this.#setStatus(twin, "working");
    let outcome = "ready";
    const author = options.author || "Brainstem";
    const task = String(instruction || "").trim();
    try {
      let prompt = task;
      for (let round = 0; round < maxRounds; round += 1) {
        if (twin.closed) break;
        const reply = await this.chat(id, prompt, { author });
        if (twin.closed) break;
        const text = String(reply.response || reply.assistant_response || reply.result || "").trim();
        // The one visible, user-owned auth step (e.g. PAC device login). Pause
        // only on a genuine auth REQUEST — completion is checked first so a
        // finished reply that merely mentions sign-in isn't hijacked.
        if (saysDone(text)) { outcome = "done"; break; }
        if (NEEDS_AUTH_RE.test(text)) {
          outcome = "needs-auth";
          this.emit({ type: "twin-needs-auth", id, message: text.slice(0, 400) });
          break;
        }
        if (!text) {   // an empty reply is a failure, not success
          this.emit({ type: "twin-message", id, author, role: "error", text: "Twin returned an empty reply; stopping." });
          outcome = "ready";
          break;
        }
        // The twin now carries room memory (chat()), so restate the task rather
        // than a bare "Continue" to a memoryless worker.
        prompt = `Continue toward this task: ${task.slice(0, 300)}\n` +
          `If it is complete, reply DONE. If you need the user to sign in, say exactly what auth is required.`;
      }
    } finally {
      twin.running = false;
      this.#setStatus(twin, outcome === "needs-auth" ? "needs-auth" : "ready");
    }
    return this.descriptor(twin);
  }

  // Ask the visible Brainstem, over ITS /chat, for the next thing to say to the
  // twin. A dedicated planner session keeps this control chatter out of the
  // user's own Brainstem thread. Returns the Brainstem's raw text.
  async #brainstemPlan(sessionId, prompt, history = []) {
    const base = String(this.brainstemUrl() || "").replace(/\/$/, "");
    if (!base) throw new Error("No Brainstem URL to plan with.");
    const userInput = String(prompt || "");
    const requestId = randomUUID();
    try {
      await this.refreshAmbient();
    } catch {
      // Ambient context is additive; planner chat stays fail-open.
    }
    const response = await fetch(`${base}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // The planner is stateless too — carry its running transcript so it never
      // loses the goal or what it already told the twin (see chat()).
      body: JSON.stringify({
        user_input: userInput,
        session_id: sessionId,
        conversation_history: history.slice(-40),
      }),
    });
    if (!response.ok) throw new Error(`Brainstem /chat returned HTTP ${response.status}.`);
    const data = await response.json();
    const reply = String(
      data.response || data.assistant_response || data.result || "",
    ).trim();
    recordCompletedTurn(this.ledger, {
      agentLogs: data.agent_logs,
      model: data.model,
      requestId,
      response: reply,
      sessionId: data.session_id || sessionId,
      surface: "brainstem",
      userInput,
    });
    return reply;
  }

  // A GENUINE two-brain autonomous loop: the visible Brainstem plans each turn,
  // the twin executes it, the Brainstem reads the result and plans the next —
  // until it declares the goal met (or maxRounds). Unlike run() (which feeds the
  // twin a canned "Continue"), here the real Brainstem is in the loop. Both sides
  // are /chat only (canon: chat is the only wire); the host just relays. Every
  // turn streams into the twin room as a twin-message, so the user watches the
  // Brainstem <-> twin exchange unfold live and can interject at any time.
  async loop(id, goal, options = {}) {
    const { maxRounds = 6 } = options;
    const twin = this.get(id);
    if (twin.running) throw new Error(`Twin ${id} is already looping.`);
    const goalText = String(goal || "").trim();
    if (!goalText) {   // surface, don't throw-then-swallow (the caller's .catch would hide it)
      this.emit({ type: "twin-message", id, author: "Brainstem", role: "error",
        text: "I need a goal to loop on — tell me what to have the twin do." });
      return this.descriptor(twin);
    }
    twin.running = true;
    this.#setStatus(twin, "working");
    const planSession = `twin-loop-${id}`;
    const twinName = twin.name || "the twin";
    const brief =
      `You are steering a specialist agent called "${twinName}" over chat to accomplish a goal for the user, hands-off. ` +
      `Each turn you send ${twinName} ONE concrete instruction, read its reply, and decide the next step. ` +
      `Goal: ${goalText}`;
    // The planner's own running transcript — passed as conversation_history every
    // turn so the stateless kernel never loses the goal or what it already sent.
    const planHistory = [];
    const plan = async (prompt) => {
      const reply = await this.#brainstemPlan(planSession, prompt, planHistory);
      planHistory.push({ role: "user", content: prompt }, { role: "assistant", content: reply });
      return reply;
    };
    let outcome = "ready";
    try {
      // Opening move: the Brainstem's first instruction to the twin.
      let instruction = await plan(
        `${brief}\n\nReply with ONLY the first message to send to ${twinName} — a single concrete instruction, addressed to ${twinName}, no preamble.`);
      for (let round = 0; round < maxRounds; round += 1) {
        if (twin.closed || !instruction) break;
        // The twin executes; its reply streams into the room as its own turn,
        // the instruction as a "Brainstem" turn.
        const reply = await this.chat(id, instruction, { author: "Brainstem" });
        if (twin.closed) break;
        const twinText = String(reply.response || reply.assistant_response || reply.result || "").trim();
        // Pause only on a genuine, user-owned auth REQUEST.
        if (NEEDS_AUTH_RE.test(twinText)) {
          outcome = "needs-auth";
          this.emit({ type: "twin-needs-auth", id, message: twinText.slice(0, 400) });
          break;
        }
        // The Brainstem reads the twin's reply and plans the next move — the goal
        // is restated (belt-and-suspenders) alongside the forwarded history.
        const next = await plan(
          `Goal (unchanged): ${goalText}\n\n` +
          `${twinName} replied:\n"""\n${twinText.slice(0, 4000)}\n"""\n\n` +
          `If the goal is fully met, reply with exactly: DONE — <one short line on the result>. ` +
          `Otherwise reply with ONLY the next single instruction to send to ${twinName} (addressed to it, no preamble).`);
        if (twin.closed) break;
        if (planIsDone(next)) {
          this.emit({ type: "twin-message", id, author: "Brainstem", role: "assistant", text: next.trim() });
          outcome = "done";
          break;
        }
        instruction = next;
        if (round === maxRounds - 1) {
          this.emit({ type: "twin-message", id, author: "Brainstem", role: "assistant",
            text: `Paused after ${maxRounds} rounds — steer me or say continue to keep going.` });
        }
      }
    } catch (error) {
      if (!twin.closed) {
        this.emit({ type: "twin-message", id, author: "Brainstem", role: "error", text: `Loop error: ${error.message}` });
      }
      outcome = "ready";
    } finally {
      twin.running = false;
      this.#setStatus(twin, outcome === "needs-auth" ? "needs-auth" : "ready");
    }
    return this.descriptor(twin);
  }

  async close(id) {
    const key = String(id);
    const twin = this.twins.get(key);
    if (twin) await this.#disposeTwin(twin);
    // Always emit — even for an already-absent id — so a stale tile is dismissable.
    this.emit({ type: "twin-closed", id: key });
    return { ok: true };
  }

  async stopAll() {
    const twins = Array.from(this.twins.values());
    await Promise.allSettled(twins.map((twin) => this.#disposeTwin(twin)));
  }

  async #disposeTwin(twin) {
    // Stop before deleting either directory; no live worker may still own them.
    twin.closed = true;
    twin.running = false;
    this.twins.delete(String(twin.id));
    try { this.mirrorMolts(twin); } catch { /* preserve teardown */ }
    if (twin.worker) await twin.worker.stop().catch(() => {});
    try { this.mirrorMolts(twin); } catch { /* preserve teardown */ }
    removeTwinDirectories(twin);
    this.pruneTwinLogs();
  }
}

export const twinManagerInternals = {
  allocatePort,
  discoverTwinMolts,
  twinSlug,
};
