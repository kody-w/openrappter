import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  copyFileSync,
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { BrainstemProcess } from "./brainstem-process.mjs";
import { inferAgentToolName } from "./ledger.mjs";
import {
  pruneLogFiles,
  redactSensitiveValue,
} from "./log-redaction.mjs";
import {
  LineageStore,
  MAX_AGENT_BYTES,
  lineageStoreInternals,
} from "./lineage-store.mjs";
import {
  Hb,
  canonical,
  mintRappid,
  packEgg,
  readEgg,
  verifyEgg,
} from "./rapp-protocol.mjs";


const ROUTING_SCHEMA = "rapp-beta-routing/1";
const STACK_SCHEMA = "rapp-beta-stack/1";
const AGENT_FILE = /^[A-Za-z0-9_.-]+_agent\.py$/;
const MEMORY_FILES = new Set([
  "context_memory_agent.py",
  "manage_memory_agent.py",
]);
const MODULE_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const CONTEXT_MEMORY_RING1_PATH = path.join(
  MODULE_DIRECTORY,
  "rings",
  "context_memory_agent.ring1.py",
);
const CONTEXT_MEMORY_RING2_PATH = path.join(
  MODULE_DIRECTORY,
  "rings",
  "context_memory_agent.ring2.py",
);
const MOLTER_AGENT_PATH = unpackedAsarPath(path.resolve(
  MODULE_DIRECTORY,
  "..",
  "frontier",
  "rapplications",
  "molter",
  "agents",
  "molter_agent.py",
));
const CONTEXT_MEMORY_RING1_BASELINE_SHA256 =
  "3f9ba4ec5c625d541380cbccfbe084479ce12cafc0cec4b55e3dd62128e32266";
const CONTEXT_MEMORY_RING2_LEGACY_SHA256 =
  "f1e1a3c7c0db5ed3eb74a7d4ad3a355b85e8fca2649c5840726877c9283c9cc9";

function ensurePrivateDirectory(directory) {
  mkdirSync(directory, { recursive: true });
  try {
    chmodSync(directory, 0o700);
  } catch {}
}

function atomicWriteJson(filePath, value) {
  ensurePrivateDirectory(path.dirname(filePath));
  const temporary = `${filePath}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
  renameSync(temporary, filePath);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function agentLedgerRow({
  filename,
  origin,
  rappid = null,
  source = null,
  sourcePath = null,
} = {}) {
  return {
    filename,
    origin,
    rappid,
    sha256: source === null ? null : sha256(source),
    source_path: sourcePath,
    tool_name: source === null
      ? null
      : inferAgentToolName(source, filename),
  };
}

function validatedMoltBytes(source, filename) {
  const bytes = Buffer.from(source, "utf8");
  if (!bytes.length || bytes.length > MAX_AGENT_BYTES) {
    throw new Error(`Molt ring for ${filename} exceeds the agent size limit.`);
  }
  return bytes;
}

function safeAgentFilename(value) {
  const filename = path.basename(String(value || "").trim());
  if (!AGENT_FILE.test(filename) || filename === "basic_agent.py") {
    throw new Error("Agent filename must be a safe *_agent.py name.");
  }
  return filename;
}

function slugFromFilename(filename) {
  const slug = filename
    .replace(/_agent\.py$/, "")
    .replaceAll("_", "-")
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return slug || "agent";
}

function stackNameFromRappid(rappid) {
  const match = String(rappid || "").match(/^rappid:@[^/]+\/([^:]+):/);
  const slug = String(match?.[1] || "stack")
    .replace(/^brainstem-/, "")
    .replace(/-stack$/, "");
  return slug || "stack";
}

// Always a COPY, never a hardlink. A published composition is a directory a
// running kernel (and its agents) may write into — the Grail's own learn agent
// rewrites files in its agents directory to create swarms. With a hardlink that
// write goes straight through into the content-addressed object store and
// every later boot of every composition using that object fails closed. Agent
// sources are kilobytes; the copy is free and the store stays immutable.
function copyObject(source, destination) {
  copyFileSync(source, destination);
  return "copy";
}

function unpackedAsarPath(filePath) {
  const marker = `${path.sep}app.asar${path.sep}`;
  return filePath.includes(marker)
    ? filePath.replace(
        marker,
        `${path.sep}app.asar.unpacked${path.sep}`,
      )
    : filePath;
}

function allocatePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address
        ? address.port
        : null;
      server.close((error) => {
        if (error) reject(error);
        else if (!port) reject(new Error("Could not allocate worker port."));
        else resolve(port);
      });
    });
  });
}

function contextMemorySource(memoryGuid) {
  return `from agents.context_memory_agent import ContextMemoryAgent


class RoutedContextMemoryAgent(ContextMemoryAgent):
    def system_context(self):
        self.storage_manager.set_memory_context(${JSON.stringify(memoryGuid)})
        return super().system_context()

    def perform(self, **kwargs):
        kwargs["user_guid"] = ${JSON.stringify(memoryGuid)}
        return super().perform(**kwargs)
`;
}

function manageMemorySource(memoryGuid) {
  return `from agents.manage_memory_agent import ManageMemoryAgent


class RoutedManageMemoryAgent(ManageMemoryAgent):
    def perform(self, **kwargs):
        kwargs["user_guid"] = ${JSON.stringify(memoryGuid)}
        return super().perform(**kwargs)
`;
}

function routedContextMemoryMoltSource(ringSource, memoryGuid) {
  // Ring sources arrive from disk. A Windows autocrlf checkout (or a Windows
  // editor) hands us CRLF bytes, and the multi-line scanner match below is
  // written in LF — without canonicalizing first the match silently fails, the
  // overlay is skipped, and the user runs baseline while status says ring 1.
  // Same canonical form as lineage-store's sourceSha256 identity chokepoint.
  const source = String(ringSource).replaceAll("\r\n", "\n");
  const declaration = "class ContextMemoryAgent(BasicAgent):";
  const baselineScanner = `def _defines_basic_agent_subclass(tree):
    for node in ast.walk(tree):
        if isinstance(node, ast.ClassDef):
            for base in node.bases:
                name = base.attr if isinstance(base, ast.Attribute) else getattr(base, "id", None)
                if name == "BasicAgent":
                    return True
    return False`;
  const routedScanner = `def _defines_basic_agent_subclass(tree):
    imported_agent_bases = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and (node.module or "").startswith("agents."):
            imported_agent_bases.update(alias.asname or alias.name for alias in node.names)
    for node in ast.walk(tree):
        if isinstance(node, ast.ClassDef):
            for base in node.bases:
                name = base.attr if isinstance(base, ast.Attribute) else getattr(base, "id", None)
                if name == "BasicAgent" or name in imported_agent_bases:
                    return True
    return False`;
  if (source.split(declaration).length !== 2) {
    throw new Error(
      "ContextMemory ring source must define one direct BasicAgent subclass.",
    );
  }
  if (source.split(baselineScanner).length !== 2) {
    throw new Error(
      "ContextMemory ring source must contain the verified ambient scanner.",
    );
  }
  const inlined = source.replace(
    baselineScanner,
    routedScanner,
  ).replace(
    declaration,
    "class _ContextMemoryRing1(BasicAgent):",
  ).trimEnd();
  return `${inlined}


class RoutedContextMemoryAgent(_ContextMemoryRing1):
    def system_context(self):
        self.storage_manager.set_memory_context(${JSON.stringify(memoryGuid)})
        return super().system_context()

    def perform(self, **kwargs):
        kwargs["user_guid"] = ${JSON.stringify(memoryGuid)}
        return super().perform(**kwargs)
`;
}

function verifyMoltWithMolter({
  python,
  brainstemDir,
  source,
  molterPath = MOLTER_AGENT_PATH,
} = {}) {
  if (!python || !existsSync(python)) {
    return { ok: false, error: `Python is unavailable at ${python || "(unset)"}.` };
  }
  if (!existsSync(molterPath)) {
    return { ok: false, error: `Molter verify gate is unavailable at ${molterPath}.` };
  }
  const shimRoot = mkdtempSync(path.join(tmpdir(), "rapp-molt-verify-"));
  const utilsDirectory = path.join(shimRoot, "utils");
  mkdirSync(utilsDirectory, { recursive: true });
  writeFileSync(path.join(utilsDirectory, "__init__.py"), "", { mode: 0o600 });
  writeFileSync(
    path.join(utilsDirectory, "azure_file_storage.py"),
    [
      "class AzureFileStorageManager:",
      "    def __init__(self, *args, **kwargs):",
      "        self.current_guid = None",
      "    def set_memory_context(self, guid):",
      "        self.current_guid = guid",
      "    def read_json(self):",
      "        return {}",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  const verifier = [
    "import importlib.util",
    "import sys",
    "spec = importlib.util.spec_from_file_location('_frontier_molter_gate', sys.argv[1])",
    "module = importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(module)",
    "ok, detail = module._verify(sys.stdin.read())",
    "if not ok:",
    "    sys.stderr.write(str(detail.get('lesson') or detail))",
    "    raise SystemExit(1)",
  ].join("\n");
  try {
    const pythonPath = [
      shimRoot,
      brainstemDir,
      process.env.PYTHONPATH || "",
    ].filter(Boolean).join(path.delimiter);
    const result = spawnSync(python, ["-c", verifier, molterPath], {
      encoding: "utf8",
      env: {
        ...process.env,
        PYTHONDONTWRITEBYTECODE: "1",
        PYTHONPATH: pythonPath,
        PYTHONUTF8: "1",
      },
      input: source,
      maxBuffer: 1024 * 1024,
      timeout: 30_000,
    });
    if (result.error) {
      return { ok: false, error: result.error.message };
    }
    return result.status === 0
      ? { ok: true }
      : {
          ok: false,
          error: String(result.stderr || result.stdout || "Molter verification failed.").trim(),
        };
  } finally {
    rmSync(shimRoot, { recursive: true, force: true });
  }
}

const DRY_LOAD_SCRIPT = `
import glob
import importlib.util
import os
import sys

brainstem_dir, agents_dir = sys.argv[1:3]
os.environ["AGENTS_PATH"] = agents_dir
sys.path.insert(0, brainstem_dir)
spec = importlib.util.spec_from_file_location("_lineage_brainstem", os.path.join(brainstem_dir, "brainstem.py"))
brainstem = importlib.util.module_from_spec(spec)
spec.loader.exec_module(brainstem)

names = {}
failures = []
for filepath in sorted(glob.glob(os.path.join(agents_dir, "*_agent.py"))):
    if os.path.basename(filepath) == "basic_agent.py":
        continue
    loaded = brainstem._load_agent_from_file(filepath)
    if not loaded:
        failures.append(f"{os.path.basename(filepath)}: no valid agents")
        continue
    for name in loaded:
        if name in names:
            failures.append(f"duplicate tool name {name!r} in {os.path.basename(filepath)} and {names[name]}")
        else:
            names[name] = os.path.basename(filepath)

for item in brainstem._quarantine_snapshot():
    failures.append(f"{item.get('file')}: {item.get('reason')}")
if failures:
    sys.stderr.write("\\n".join(failures))
    raise SystemExit(1)
`;

function dryLoadAgentDirectory({
  python,
  brainstemDir,
  agentDirectory,
} = {}) {
  if (!python || !existsSync(python)) {
    return { ok: false, error: `Python is unavailable at ${python || "(unset)"}.` };
  }
  const brainstemFile = path.join(brainstemDir, "brainstem.py");
  if (!existsSync(brainstemFile)) {
    return { ok: false, error: `Grail kernel is unavailable at ${brainstemFile}.` };
  }
  const result = spawnSync(
    python,
    ["-c", DRY_LOAD_SCRIPT, brainstemDir, agentDirectory],
    {
      cwd: brainstemDir,
      encoding: "utf8",
      env: {
        ...process.env,
        AGENTS_PATH: agentDirectory,
        PYTHONDONTWRITEBYTECODE: "1",
        PYTHONUTF8: "1",
      },
      maxBuffer: 2 * 1024 * 1024,
      timeout: 90_000,
    },
  );
  if (result.error) return { ok: false, error: result.error.message };
  return result.status === 0
    ? { ok: true }
    : {
        ok: false,
        error: String(result.stderr || result.stdout || "Grail dry-load failed.").trim(),
      };
}

// A repaired environment (a missing dependency installed, a permission fixed)
// does not change any composition hash, so the negative cache must expire.
const COMPOSITION_FAILURE_TTL_MS = 60_000;

function dryLoadFailureFilenames(error, candidateFilenames, excluded) {
  const found = new Map();
  const text = String(error?.message || error || "");
  if (!text.includes("Grail dry-load")) return found;
  for (const line of text.split("\n")) {
    for (const match of line.matchAll(/[A-Za-z0-9_.-]+_agent\.py/g)) {
      const filename = path.basename(match[0]);
      if (
        candidateFilenames.has(filename)
        && !excluded.has(filename)
        && !found.has(filename)
      ) {
        found.set(filename, line.trim());
      }
    }
  }
  return found;
}

export class BetaRouteManager {
  constructor({
    betaHome,
    brainstemConfig,
    owner = process.env.BRAINSTEM_BETA_RAPP_OWNER || "microsoft",
    onActivate = () => {},
    lineageRoot = process.env.RAPP_LINEAGE_HOME,
    lineageStore = null,
    lineageEnabled = process.env.RAPP_MOLT_LINEAGE !== "0",
    lineageEnv = process.env.RAPP_LINEAGE_ENV || "default",
    seedLineageDefaults = true,
    compositionValidator = null,
    ledger = null,
    moltVerifier = null,
  } = {}) {
    this.betaHome = betaHome;
    this.brainstemConfig = brainstemConfig;
    this.owner = owner;
    this.onActivate = onActivate;
    this.ledger = ledger;
    this.routingRoot = path.join(betaHome, "routing");
    this.identityFile = path.join(this.routingRoot, "identity.json");
    this.stackRoot = path.join(this.routingRoot, "stacks");
    this.objectRoot = path.join(this.routingRoot, "objects");
    this.eggRoot = path.join(this.routingRoot, "eggs");
    this.compositionRoot = path.join(this.routingRoot, "compositions");
    this.workerLogRoot = path.join(betaHome, "logs", "workers");
    this.workers = new Map();
    this.routeLocks = new Map();
    this.stackOverrides = new Map();
    this.telemetry = [];
    this.telemetrySequence = 0;
    this.activeRoute = null;
    this.validatedCompositions = new Set();
    // Negative cache. compositionHash is content-addressed, so the same hash is
    // the same bytes and will fail the same way — re-running the whole fallback
    // ladder (including a Python dry-load subprocess) on every request while a
    // broken agent sits on disk is pure waste. TTL'd so a repaired environment
    // recovers on its own rather than needing a restart.
    this.failedCompositions = new Map();
    this.lastGoodDescriptor = null;
    this.lastLineageFallback = null;
    this.lineageEnabled = lineageEnabled !== false;
    this.lineageEnv = lineageStoreInternals.normalizeEnvironment(lineageEnv);
    this.lineageStore = lineageStore || new LineageStore({
      brainstemDir: this.brainstemConfig.brainstemDir,
      root: lineageRoot,
      enabled: this.lineageEnabled,
      onTelemetry: (type, details) => this.recordTelemetry(type, details),
    });
    this.compositionValidator = compositionValidator || ((agentDirectory) => (
      dryLoadAgentDirectory({
        python: this.brainstemConfig.python,
        brainstemDir: this.brainstemConfig.brainstemDir,
        agentDirectory,
      })
    ));
    this.moltVerifier = moltVerifier || ((source) => verifyMoltWithMolter({
      python: this.brainstemConfig.python,
      brainstemDir: this.brainstemConfig.brainstemDir,
      source,
    }));
    for (const directory of [
      this.routingRoot,
      this.stackRoot,
      this.objectRoot,
      this.eggRoot,
      this.compositionRoot,
      this.workerLogRoot,
    ]) {
      ensurePrivateDirectory(directory);
    }
    this.pruneRoutingArtifacts();
    if (this.lineageIsEnabled() && seedLineageDefaults) {
      const ring1 = this.seedContextMemoryRing1();
      if (typeof ring1 === "string") this.seedContextMemoryRing2(ring1);
    }
  }

  // Retention. Compositions are content-addressed and regenerable (kilobytes
  // of agent source each), worker logs rotate but were never pruned, and
  // staging / dry-load residue survived crashes forever. Keep what a running
  // app can still reach — live workers, the active route, the last-good set —
  // plus the newest few, and drop the rest. Bytecode caches inside kept
  // compositions are removed outright: workers no longer write them.
  pruneRoutingArtifacts({
    keepCompositions = 8,
    keepWorkerLogs = 20,
    maxWorkerLogAgeMs = 14 * 24 * 60 * 60 * 1000,
    residueMaxAgeMs = 60 * 60 * 1000,
    now = Date.now(),
  } = {}) {
    const report = {
      compositionsRemoved: [],
      residueRemoved: [],
      pycacheRemoved: 0,
      workerLogsRemoved: [],
    };
    const protectedHashes = new Set(this.workers.keys());
    for (const worker of this.workers.values()) {
      for (const directory of [
        worker.compositionDirectory,
        worker.retiredCompositionDirectory,
      ]) {
        const hash = directory
          ? path.relative(this.compositionRoot, directory)
          : "";
        if (/^[0-9a-f]{64}$/.test(hash)) protectedHashes.add(hash);
      }
    }
    for (const hash of [
      this.activeRoute?.compositionHash,
      this.activeRoute?.transientCompositionHash,
      this.lastGoodDescriptor?.compositionHash,
    ]) {
      if (hash) protectedHashes.add(hash);
    }
    const mtimeOf = (file) => {
      try {
        return statSync(file).mtimeMs;
      } catch {
        return 0;
      }
    };
    let entries = [];
    try {
      entries = readdirSync(this.compositionRoot, { withFileTypes: true });
    } catch {
      return report;
    }
    const compositions = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const full = path.join(this.compositionRoot, entry.name);
      if (entry.name.startsWith(".")) {
        const age = now - mtimeOf(full);
        if (age > residueMaxAgeMs) {
          try { rmSync(full, { recursive: true, force: true }); } catch { continue; }
          report.residueRemoved.push(entry.name);
        }
        continue;
      }
      if (!/^[0-9a-f]{64}$/.test(entry.name)) continue;
      compositions.push({
        hash: entry.name,
        full,
        mtime: mtimeOf(path.join(full, "complete.json")) || mtimeOf(full),
      });
    }
    compositions.sort((left, right) => right.mtime - left.mtime);
    compositions.forEach((composition, index) => {
      if (protectedHashes.has(composition.hash) || index < keepCompositions) {
        const pycache = path.join(composition.full, "agents", "__pycache__");
        if (existsSync(pycache)) {
          try {
            rmSync(pycache, { recursive: true, force: true });
            report.pycacheRemoved += 1;
          } catch { /* a worker may be mid-import; try again next time */ }
        }
        return;
      }
      try { rmSync(composition.full, { recursive: true, force: true }); } catch { return; }
      report.compositionsRemoved.push(composition.hash);
    });
    report.workerLogsRemoved = pruneLogFiles(this.workerLogRoot, {
      keep: keepWorkerLogs,
      maxAgeMs: maxWorkerLogAgeMs,
      now,
      protectedNames: new Set(
        [...protectedHashes].map((hash) => `${hash}.log`),
      ),
    });
    if (
      report.compositionsRemoved.length
      || report.residueRemoved.length
      || report.pycacheRemoved
      || report.workerLogsRemoved.length
    ) {
      this.recordTelemetry("routing-pruned", {
        compositions_removed: report.compositionsRemoved.length,
        residue_removed: report.residueRemoved.length,
        pycache_removed: report.pycacheRemoved,
        worker_logs_removed: report.workerLogsRemoved.length,
        compositions_kept: compositions.length - report.compositionsRemoved.length,
      });
    }
    return report;
  }

  lineageIsEnabled() {
    return this.lineageEnabled && process.env.RAPP_MOLT_LINEAGE !== "0";
  }

  seedContextMemoryRing1() {
    if (!this.lineageIsEnabled()) {
      const refusal = {
        ok: false,
        disabled: true,
        refused: true,
        reason: "Molt Lineage is disabled (RAPP_MOLT_LINEAGE=0).",
      };
      this.recordTelemetry("lineage-default-skipped", {
        env: "default",
        reason: refusal.reason,
      });
      return refusal;
    }
    try {
      const baseline = this.lineageStore.baselineAncestors().find(
        (candidate) => candidate.filename === "context_memory_agent.py",
      );
      if (!baseline) {
        this.recordTelemetry("lineage-default-skipped", {
          env: "default",
          reason: "ContextMemory is not present in the Grail baseline.",
        });
        return null;
      }
      if (baseline.sha256 !== CONTEXT_MEMORY_RING1_BASELINE_SHA256) {
        this.recordTelemetry("lineage-default-skipped", {
          ancestor_rappid: baseline.ancestorRappid,
          env: "default",
          reason: "ContextMemory baseline bytes do not match the verified ring-1 parent.",
        });
        return null;
      }
      // Store the ring in canonical LF form so the same molt has the same
      // bytes on every platform, whatever line endings the checkout used.
      const source = readFileSync(CONTEXT_MEMORY_RING1_PATH, "utf8")
        .replaceAll("\r\n", "\n");
      const ringRappid = lineageStoreInternals.ringRappidFor(
        baseline.ancestorRappid,
        baseline.ancestorRappid,
        source,
        baseline.filename,
      );
      if (
        this.lineageStore.listRings(baseline.ancestorRappid)
          .some((ring) => ring.ringRappid === ringRappid)
      ) {
        return ringRappid;
      }
      const verdict = this.moltVerifier(source);
      if (verdict !== true && verdict?.ok !== true) {
        this.recordTelemetry("lineage-default-skipped", {
          ancestor_rappid: baseline.ancestorRappid,
          env: "default",
          reason: verdict?.error || "ContextMemory ring-1 failed the Molter verify gate.",
        });
        return null;
      }
      const appended = this.lineageStore.appendRing(
        baseline.ancestorRappid,
        {
          source,
          parentRappid: baseline.ancestorRappid,
          verified: true,
          meta: {
            author: "frontier",
            kind: "ambient-context/1.0",
            policy: "mutable",
            ring: 1,
            verifiedBy: "molter._verify",
          },
        },
      );
      const moved = this.lineageStore.setHead(
        baseline.ancestorRappid,
        appended,
        { env: "default" },
      );
      if (moved !== true) {
        this.recordTelemetry("lineage-default-skipped", {
          ancestor_rappid: baseline.ancestorRappid,
          env: "default",
          reason: moved?.reason || "ContextMemory ring-1 HEAD write was refused.",
        });
        return moved;
      }
      this.recordTelemetry("lineage-default-seeded", {
        agent_rows: [agentLedgerRow({
          filename: baseline.filename,
          origin: "lineage",
          rappid: appended,
          source,
          sourcePath: path.join(
            this.lineageStore.root,
            lineageStoreInternals.filesystemSegment(baseline.ancestorRappid),
            "rings",
            lineageStoreInternals.filesystemSegment(appended),
            "source.py",
          ),
        })],
        ancestor_rappid: baseline.ancestorRappid,
        env: "default",
        ring_rappid: appended,
      });
      return appended;
    } catch (error) {
      this.recordTelemetry("lineage-default-skipped", {
        env: "default",
        reason: String(error?.message || error),
      });
      return null;
    }
  }

  seedContextMemoryRing2(parentRappid = null) {
    if (!this.lineageIsEnabled()) {
      const refusal = {
        ok: false,
        disabled: true,
        refused: true,
        reason: "Molt Lineage is disabled (RAPP_MOLT_LINEAGE=0).",
      };
      this.recordTelemetry("lineage-default-skipped", {
        env: "default",
        reason: refusal.reason,
        ring: 2,
      });
      return refusal;
    }
    try {
      const baseline = this.lineageStore.baselineAncestors().find(
        (candidate) => candidate.filename === "context_memory_agent.py",
      );
      if (!baseline) {
        this.recordTelemetry("lineage-default-skipped", {
          env: "default",
          reason: "ContextMemory is not present in the Grail baseline.",
          ring: 2,
        });
        return null;
      }
      if (baseline.sha256 !== CONTEXT_MEMORY_RING1_BASELINE_SHA256) {
        this.recordTelemetry("lineage-default-skipped", {
          ancestor_rappid: baseline.ancestorRappid,
          env: "default",
          reason: "ContextMemory baseline bytes do not match the verified ring-2 lineage.",
          ring: 2,
        });
        return null;
      }
      const ring1Source = readFileSync(CONTEXT_MEMORY_RING1_PATH, "utf8")
        .replaceAll("\r\n", "\n");
      const expectedParent = lineageStoreInternals.ringRappidFor(
        baseline.ancestorRappid,
        baseline.ancestorRappid,
        ring1Source,
        baseline.filename,
      );
      const parent = parentRappid || expectedParent;
      if (
        parent !== expectedParent
        || !this.lineageStore.listRings(baseline.ancestorRappid)
          .some((ring) => ring.ringRappid === parent)
      ) {
        this.recordTelemetry("lineage-default-skipped", {
          ancestor_rappid: baseline.ancestorRappid,
          env: "default",
          reason: "ContextMemory ring-2 requires the verified ring-1 parent.",
          ring: 2,
        });
        return null;
      }
      const source = readFileSync(CONTEXT_MEMORY_RING2_PATH, "utf8")
        .replaceAll("\r\n", "\n");
      const ringRappid = lineageStoreInternals.ringRappidFor(
        baseline.ancestorRappid,
        parent,
        source,
        baseline.filename,
      );
      const rings = this.lineageStore.listRings(baseline.ancestorRappid);
      const currentHead = this.lineageStore.getHead(
        baseline.ancestorRappid,
        { env: "default" },
      );
      const legacyDefault = rings.find((ring) => (
        ring.ringRappid === currentHead
        && ring.parentRappid === parent
        && ring.meta?.ring === 2
        && ring.sha256 === CONTEXT_MEMORY_RING2_LEGACY_SHA256
      ));
      if (rings.some((ring) => ring.ringRappid === ringRappid)) {
        if (legacyDefault) {
          const moved = this.lineageStore.setHead(
            baseline.ancestorRappid,
            ringRappid,
            { env: "default" },
          );
          if (moved !== true) return moved;
        }
        return ringRappid;
      }
      if (currentHead !== parent && !legacyDefault) {
        this.recordTelemetry("lineage-default-skipped", {
          ancestor_rappid: baseline.ancestorRappid,
          env: "default",
          reason: "ContextMemory HEAD moved beyond ring 1; preserving the selected lineage.",
          ring: 2,
        });
        return null;
      }
      const verdict = this.moltVerifier(source);
      if (verdict !== true && verdict?.ok !== true) {
        this.recordTelemetry("lineage-default-skipped", {
          ancestor_rappid: baseline.ancestorRappid,
          env: "default",
          reason: verdict?.error || "ContextMemory ring-2 failed the Molter verify gate.",
          ring: 2,
        });
        return null;
      }
      const appended = this.lineageStore.appendRing(
        baseline.ancestorRappid,
        {
          source,
          parentRappid: parent,
          verified: true,
          meta: {
            author: "frontier",
            kind: "ambient-context/1.0",
            policy: "mutable",
            ring: 2,
            verifiedBy: "molter._verify",
          },
        },
      );
      const moved = this.lineageStore.setHead(
        baseline.ancestorRappid,
        appended,
        { env: "default" },
      );
      if (moved !== true) {
        this.recordTelemetry("lineage-default-skipped", {
          ancestor_rappid: baseline.ancestorRappid,
          env: "default",
          reason: moved?.reason || "ContextMemory ring-2 HEAD write was refused.",
          ring: 2,
        });
        return moved;
      }
      this.recordTelemetry("lineage-default-seeded", {
        agent_rows: [agentLedgerRow({
          filename: baseline.filename,
          origin: "lineage",
          rappid: appended,
          source,
          sourcePath: path.join(
            this.lineageStore.root,
            lineageStoreInternals.filesystemSegment(baseline.ancestorRappid),
            "rings",
            lineageStoreInternals.filesystemSegment(appended),
            "source.py",
          ),
        })],
        ancestor_rappid: baseline.ancestorRappid,
        env: "default",
        parent_rappid: parent,
        migrated_from: legacyDefault?.ringRappid || null,
        ring: 2,
        ring_rappid: appended,
      });
      return appended;
    } catch (error) {
      this.recordTelemetry("lineage-default-skipped", {
        env: "default",
        reason: String(error?.message || error),
        ring: 2,
      });
      return null;
    }
  }

  baselineAncestor(filename) {
    return this.lineageStore.baselineAncestors().find(
      (candidate) => candidate.filename === filename,
    ) || null;
  }

  resolveLineageEntry(entry, memoryGuid, lineageHeads = null) {
    if (!this.lineageIsEnabled() || entry.scope === "ephemeral") return entry;
    const baseline = this.baselineAncestor(entry.filename);
    if (!baseline) return entry;
    const generatedContextMemory = (
      entry.scope === "memory"
      && entry.filename === "context_memory_agent.py"
    );
    if (!generatedContextMemory) {
      const source = entry.objectPath
        ? readFileSync(entry.objectPath, "utf8")
        : Buffer.from(entry.bytes || []).toString("utf8");
      if (source !== readFileSync(baseline.sourcePath, "utf8")) return entry;
    }
    const live = lineageHeads?.has(baseline.ancestorRappid)
      ? this.lineageStore.resolveRing(
          baseline.ancestorRappid,
          lineageHeads.get(baseline.ancestorRappid),
        )
      : this.lineageStore.resolveLive(
          baseline.ancestorRappid,
          { env: this.lineageEnv },
        );
    if (!live || live.isBaseline) return entry;
    const source = generatedContextMemory
      ? routedContextMemoryMoltSource(live.source, memoryGuid)
      : live.source;
    const bytes = validatedMoltBytes(source, entry.filename);
    return {
      ...entry,
      address: Hb("rapp/1:egg", bytes),
      bytes,
      objectPath: null,
      lineage: {
        ancestorRappid: baseline.ancestorRappid,
        ringRappid: live.ringRappid,
      },
    };
  }

  resolveTwinLineageSource(filename, source) {
    if (!this.lineageIsEnabled()) {
      return { filename, source, lineage: null };
    }
    const baseline = this.baselineAncestor(filename);
    if (
      !baseline
      || String(source) !== readFileSync(baseline.sourcePath, "utf8")
    ) {
      return { filename, source, lineage: null };
    }
    const live = this.lineageStore.resolveLive(
      baseline.ancestorRappid,
      { env: this.lineageEnv },
    );
    if (!live || live.isBaseline) {
      return { filename, source, lineage: null };
    }
    validatedMoltBytes(live.source, filename);
    return {
      filename,
      source: live.source,
      lineage: {
        ancestorRappid: baseline.ancestorRappid,
        ringRappid: live.ringRappid,
      },
    };
  }

  rollbackLineage(ancestorRappid = null) {
    const report = this.lineageStore.rollbackToBaseline(
      ancestorRappid,
      { env: this.lineageEnv },
    ) || null;
    this.recordTelemetry("lineage-rollback", {
      agent_rows: (report?.changed || [])
        .map((rappid) => this.lineageLedgerRow(rappid, this.lineageEnv))
        .filter(Boolean),
      ancestor_rappid: ancestorRappid,
      scope: ancestorRappid ? "locus" : "all",
      disabled: Boolean(report?.disabled),
      changed: report?.changed?.length ?? null,
      unchanged: report?.unchanged?.length ?? null,
      failed: report?.failed?.length ?? null,
    });
    return report;
  }

  restoreLineage(ancestorRappid = null) {
    const report = this.lineageStore.restore(
      ancestorRappid,
      { env: this.lineageEnv },
    ) || null;
    this.recordTelemetry("lineage-restore", {
      agent_rows: (report?.changed || [])
        .map((rappid) => this.lineageLedgerRow(rappid, this.lineageEnv))
        .filter(Boolean),
      ancestor_rappid: ancestorRappid,
      scope: ancestorRappid ? "locus" : "all",
      disabled: Boolean(report?.disabled),
      changed: report?.changed?.length ?? null,
      unchanged: report?.unchanged?.length ?? null,
      failed: report?.failed?.length ?? null,
    });
    return report;
  }

  lineageEnvironments() {
    if (!this.lineageIsEnabled()) {
      return { disabled: true, loci: [] };
    }
    const loci = this.lineageStore.baselineAncestors().map((baseline) => {
      const environments = this.lineageStore.environments(
        baseline.ancestorRappid,
      );
      return {
        ancestorRappid: baseline.ancestorRappid,
        filename: baseline.filename,
        drifted: environments.some((entry) => (
          this.lineageStore.baselineDrift(
            baseline.ancestorRappid,
            { env: entry.env },
          ).drifted
        )),
        environments,
      };
    });
    const report = { disabled: false, loci };
    this.recordTelemetry("lineage-environments", {
      loci: loci.length,
    });
    return report;
  }

  promoteLineage({
    fromEnv = "default",
    toEnv = "default",
    actor = null,
    utc = null,
  } = {}) {
    const sourceEnvironment =
      lineageStoreInternals.normalizeEnvironment(fromEnv);
    const targetEnvironment =
      lineageStoreInternals.normalizeEnvironment(toEnv);
    const report = this.lineageStore.promoteAll({
      fromEnv: sourceEnvironment,
      toEnv: targetEnvironment,
      actor,
      utc,
    });
    this.recordTelemetry("lineage-promote", {
      agent_rows: (report.changed || [])
        .map((rappid) => this.lineageLedgerRow(rappid, targetEnvironment))
        .filter(Boolean),
      changed: report.changed?.length ?? 0,
      conflicts: report.conflicts?.length ?? 0,
      disabled: Boolean(report.disabled),
      failed: report.failed?.length ?? 0,
      from_env: sourceEnvironment,
      to_env: targetEnvironment,
      unchanged: report.unchanged?.length ?? 0,
    });
    return {
      ...report,
      fromEnv: sourceEnvironment,
      toEnv: targetEnvironment,
    };
  }

  lineageDrift(env) {
    const environment = lineageStoreInternals.normalizeEnvironment(env);
    if (!this.lineageIsEnabled()) {
      return {
        disabled: true,
        env: environment,
        baseEnv: "default",
        drifted: [],
        loci: [],
      };
    }
    const loci = this.lineageStore.baselineAncestors().map((baseline) => {
      const expected = this.lineageStore.getHead(
        baseline.ancestorRappid,
        { env: "default" },
      );
      const environmentDrift = this.lineageStore.detectDrift(
        baseline.ancestorRappid,
        environment,
        expected,
      );
      const baselineDrift = this.lineageStore.baselineDrift(
        baseline.ancestorRappid,
        { env: environment },
      );
      return {
        ancestorRappid: baseline.ancestorRappid,
        filename: baseline.filename,
        ...environmentDrift,
        baselineDrifted: baselineDrift.drifted,
        drifted: environmentDrift.drifted || baselineDrift.drifted,
      };
    });
    const drifted = loci.filter((locus) => locus.drifted);
    const report = {
      disabled: false,
      env: environment,
      baseEnv: "default",
      drifted,
      loci,
    };
    this.recordTelemetry("lineage-drift", {
      base_env: "default",
      drifted: drifted.length,
      target_env: environment,
    });
    return report;
  }

  validateAgentDirectory(agentDirectory) {
    const verdict = this.compositionValidator(agentDirectory);
    if (verdict === true || verdict?.ok === true) return verdict;
    throw new Error(
      verdict?.error
        ? `Composed agent set failed Grail dry-load: ${verdict.error}`
        : "Composed agent set failed Grail dry-load.",
    );
  }

  assertAgentDirectoryMatches(agentDirectory, entries) {
    const expected = new Map(
      entries.map((entry) => [entry.filename, entry.address]),
    );
    const actual = readdirSync(agentDirectory, { withFileTypes: true })
      .filter((entry) => entry.name !== "__pycache__");
    if (
      actual.length !== expected.size
      || actual.some((entry) => !entry.isFile() || !expected.has(entry.name))
    ) {
      throw new Error("Composed agent set contains missing or unexpected files.");
    }
    for (const [filename, address] of expected) {
      const bytes = readFileSync(path.join(agentDirectory, filename));
      if (Hb("rapp/1:egg", bytes) !== address) {
        throw new Error(
          `Composed agent bytes changed during validation: ${filename}`,
        );
      }
    }
  }

  validatePrivateAgentSet(agentDirectory, entries) {
    this.assertAgentDirectoryMatches(agentDirectory, entries);
    const validationRoot = mkdtempSync(
      path.join(this.compositionRoot, ".dry-load-"),
    );
    const validationDirectory = path.join(validationRoot, "agents");
    ensurePrivateDirectory(validationDirectory);
    try {
      for (const entry of entries) {
        copyFileSync(
          path.join(agentDirectory, entry.filename),
          path.join(validationDirectory, entry.filename),
        );
      }
      this.validateAgentDirectory(validationDirectory);
    } finally {
      rmSync(validationRoot, { recursive: true, force: true });
    }
    this.assertAgentDirectoryMatches(agentDirectory, entries);
  }

  identity() {
    if (existsSync(this.identityFile)) {
      const identity = JSON.parse(readFileSync(this.identityFile, "utf8"));
      let changed = false;
      if (!identity.active_stack_rappid) {
        identity.active_stack_rappid = identity.default_stack_rappid;
        changed = true;
      }

      if (!Array.isArray(identity.overlay_stack_rappids)) {
        identity.overlay_stack_rappids = [];
        changed = true;
      }
      if (changed) atomicWriteJson(this.identityFile, identity);
      return identity;
    }
    const caller = mintRappid(this.owner, "brainstem-beta");
    const rootStack = mintRappid(this.owner, "brainstem-default-stack");
    const identity = {
      schema: ROUTING_SCHEMA,
      caller_rappid: caller.rappid,
      memory_guid: caller.uuidAnchor,
      default_stack_rappid: rootStack.rappid,
      active_stack_rappid: rootStack.rappid,
      overlay_stack_rappids: [],
      created_utc: new Date().toISOString(),
    };
    atomicWriteJson(this.identityFile, identity);
    atomicWriteJson(this.stackPath(rootStack.rappid), {
      schema: STACK_SCHEMA,
      rappid: rootStack.rappid,
      owner_rappid: caller.rappid,
      name: "default",
      parent_rappid: null,
      overlay_rappids: [],
      agents: [],
    });
    return identity;
  }

  recordTelemetry(type, details = {}) {
    const lineageContext = String(type).startsWith("lineage-")
      ? { env: this.lineageEnv }
      : {};
    const ledgerEvent = {
      sequence: ++this.telemetrySequence,
      timestamp: new Date().toISOString(),
      type,
      ...lineageContext,
      ...redactSensitiveValue(details),
    };
    this.ledger?.recordRouteEvent?.(ledgerEvent);
    const {
      agent_rows: agentRows,
      ...event
    } = ledgerEvent;
    if (Array.isArray(agentRows)) {
      event.agent_row_count = agentRows.length;
    }
    if (Array.isArray(event.excluded_files)) {
      event.excluded_files = event.excluded_files.map(({ filename, reason }) => ({
        filename,
        reason,
      }));
    }
    this.telemetry.push(event);
    if (this.telemetry.length > 500) this.telemetry.shift();
    return event;
  }

  lineageLedgerRow(ancestorRappid, env = this.lineageEnv) {
    try {
      const baseline = this.lineageStore.baselineAncestors().find(
        (candidate) => candidate.ancestorRappid === ancestorRappid,
      );
      const live = this.lineageStore.resolveLive(ancestorRappid, { env });
      if (!baseline || !live) return null;
      const sourcePath = live.isBaseline
        ? baseline.sourcePath
        : path.join(
            this.lineageStore.root,
            lineageStoreInternals.filesystemSegment(ancestorRappid),
            "rings",
            lineageStoreInternals.filesystemSegment(live.ringRappid),
            "source.py",
          );
      return agentLedgerRow({
        filename: baseline.filename,
        origin: "lineage",
        rappid: live.ringRappid,
        source: live.source,
        sourcePath,
      });
    } catch {
      return null;
    }
  }

  telemetrySnapshot() {
    const activeWorker = this.activeRoute
      ? this.workers.get(this.activeRoute.compositionHash)
      : null;
    return {
      sequence: this.telemetrySequence,
      active_route: this.activeRoute
        ? {
            url: this.activeRoute.url,
            composition_hash: this.activeRoute.transientCompositionHash
              || this.activeRoute.compositionHash,
            base_composition_hash: this.activeRoute.compositionHash,
          }
        : null,
      worker_count: this.workers.size,
      stack_count: this.stacks().length,
      stack_tree: this.stackTree(),
      active_composition_fingerprint: activeWorker
        ? this.compositionFingerprint(activeWorker)
        : null,
      object_count: readdirSync(this.objectRoot).length,
      egg_count: readdirSync(this.eggRoot).length,
      events: [...this.telemetry],
    };
  }

  compositionFingerprint(worker) {
    const files = readdirSync(worker.agentDirectory)
      .filter((filename) => filename.endsWith(".py"))
      .sort();
    const hash = createHash("sha256");
    for (const filename of files) {
      hash.update(filename);
      hash.update("\0");
      hash.update(readFileSync(path.join(worker.agentDirectory, filename)));
      hash.update("\0");
    }
    const manifestPath = path.join(
      worker.compositionDirectory,
      "complete.json",
    );
    const manifest = readFileSync(manifestPath);
    hash.update("complete.json");
    hash.update("\0");
    hash.update(manifest);
    return {
      agent_directory: worker.agentDirectory,
      files,
      manifest_path: manifestPath,
      source_hash: hash.digest("hex"),
    };
  }

  stackPath(rappid) {
    return path.join(this.stackRoot, `${sha256(Buffer.from(rappid))}.json`);
  }

  normalizeStack(stack, filePath) {
    let changed = false;
    if (!stack.name) {
      stack.name = stackNameFromRappid(stack.rappid);
      changed = true;
    }
    if (!Array.isArray(stack.overlay_rappids)) {
      stack.overlay_rappids = [];
      changed = true;
    }
    if (!Array.isArray(stack.agents)) {
      stack.agents = [];
      changed = true;
    }
    if (changed) atomicWriteJson(filePath, stack);
    return stack;
  }

  loadStack(rappid) {
    const override = this.stackOverrides.get(rappid);
    if (override) return override;
    const filePath = this.stackPath(rappid);
    if (!existsSync(filePath)) throw new Error(`Unknown stack RAPPID: ${rappid}`);
    return this.normalizeStack(
      JSON.parse(readFileSync(filePath, "utf8")),
      filePath,
    );
  }

  stacks() {
    return readdirSync(this.stackRoot)
      .filter((filename) => filename.endsWith(".json"))
      .map((filename) => {
        const filePath = path.join(this.stackRoot, filename);
        return this.normalizeStack(
          JSON.parse(readFileSync(filePath, "utf8")),
          filePath,
        );
      })
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  stackTree() {
    const identity = this.identity();
    const stacks = this.stacks();
    const byRappid = new Map(stacks.map((stack) => [stack.rappid, stack]));
    const children = new Map();
    for (const stack of stacks) {
      if (stack.parent_rappid && !byRappid.has(stack.parent_rappid)) {
        throw new Error(`Unknown parent stack RAPPID: ${stack.parent_rappid}`);
      }
      const parent = stack.parent_rappid || null;
      if (!children.has(parent)) children.set(parent, []);
      children.get(parent).push(stack);
    }
    for (const siblings of children.values()) {
      siblings.sort((left, right) => (
        left.name.localeCompare(right.name)
        || left.rappid.localeCompare(right.rappid)
      ));
    }
    const buildNode = (stack, lineage = new Set()) => {
      if (lineage.has(stack.rappid)) {
        throw new Error("Stack parent cycle detected.");
      }
      const nextLineage = new Set(lineage);
      nextLineage.add(stack.rappid);
      const overlayIndex = identity.overlay_stack_rappids.indexOf(stack.rappid);
      return {
        name: stack.name,
        rappid: stack.rappid,
        parent_rappid: stack.parent_rappid,
        active: stack.rappid === identity.active_stack_rappid,
        overlay_order: overlayIndex >= 0 ? overlayIndex + 1 : null,
        agent_count: stack.agents.length,
        children: (children.get(stack.rappid) || []).map(
          (child) => buildNode(child, nextLineage),
        ),
      };
    };
    return (children.get(null) || []).map((stack) => buildNode(stack));
  }

  stackLineage(rappid) {
    const lineage = [];
    const seen = new Set();
    let current = rappid;
    while (current) {
      if (seen.has(current)) throw new Error("Stack parent cycle detected.");
      seen.add(current);
      const stack = this.loadStack(current);
      lineage.unshift(stack);
      current = stack.parent_rappid;
    }
    return lineage;
  }

  async createStack({ name, parentRappid = null }) {
    const normalizedName = String(name || "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");
    if (!normalizedName) throw new Error("Stack name is required.");
    const identity = this.identity();
    const parent = parentRappid || identity.active_stack_rappid;
    this.loadStack(parent);
    const minted = mintRappid(
      this.owner,
      `brainstem-${normalizedName}-stack`,
    );
    const stack = {
      schema: STACK_SCHEMA,
      rappid: minted.rappid,
      owner_rappid: identity.caller_rappid,
      name: normalizedName,
      parent_rappid: parent,
      overlay_rappids: [],
      agents: [],
    };
    this.saveStack(stack);
    this.recordTelemetry("stack-created", {
      parent_rappid: parent,
      stack_rappid: stack.rappid,
    });
    return stack;
  }

  async selectStack({ stackRappid, overlayRappids = [] }) {
    const identity = this.identity();
    const leaf = String(stackRappid || "").trim();
    if (!leaf) throw new Error("A leaf stack RAPPID is required.");
    this.loadStack(leaf);
    if (!Array.isArray(overlayRappids)) {
      throw new Error("Overlay stack RAPPIDs must be an ordered array.");
    }
    const overlays = [];
    for (const overlay of overlayRappids) {
      if (overlay === leaf) {
        throw new Error("The selected leaf stack cannot also be an overlay.");
      }
      this.loadStack(overlay);
      if (!overlays.includes(overlay)) overlays.push(overlay);
    }
    identity.active_stack_rappid = leaf;
    identity.overlay_stack_rappids = overlays;
    atomicWriteJson(this.identityFile, identity);
    this.recordTelemetry("stack-selected", {
      active_stack_rappid: leaf,
      overlay_stack_rappids: identity.overlay_stack_rappids,
    });
    return {
      caller_rappid: identity.caller_rappid,
      memory_guid: identity.memory_guid,
      active_stack_rappid: leaf,
      overlay_stack_rappids: identity.overlay_stack_rappids,
      stack_tree: this.stackTree(),
    };
  }

  saveStack(stack) {
    atomicWriteJson(this.stackPath(stack.rappid), stack);
  }

  async removeStack({ stackRappid }) {
    const identity = this.identity();
    const target = String(stackRappid || "").trim();
    if (!target) throw new Error("A stack RAPPID is required.");
    if (target === identity.default_stack_rappid) {
      throw new Error("The default stack cannot be removed.");
    }
    if (target === identity.active_stack_rappid) {
      throw new Error("The active stack cannot be removed.");
    }
    if (identity.overlay_stack_rappids.includes(target)) {
      throw new Error("An active overlay stack cannot be removed.");
    }
    const stack = this.loadStack(target);
    if (stack.agents.length) {
      throw new Error("Remove every stack agent before removing the stack.");
    }
    if (this.stacks().some((candidate) => candidate.parent_rappid === target)) {
      throw new Error("A stack with child stacks cannot be removed.");
    }
    rmSync(this.stackPath(target), { force: true });
    this.recordTelemetry("stack-removed", {
      stack_rappid: target,
    });
    return {
      removed_stack_rappid: target,
      stack_tree: this.stackTree(),
    };
  }

  cacheSource(source) {
    const bytes = Buffer.from(source, "utf8");
    if (!bytes.length || bytes.length > MAX_AGENT_BYTES) {
      throw new Error("Agent source must be between 1 byte and 512 KiB.");
    }
    const address = Hb("rapp/1:egg", bytes);
    const objectPath = path.join(this.objectRoot, `${address}.py`);
    // The object store is content-addressed, so an object is only ever valid
    // when its bytes still hash to its name. A torn write (crash, ENOSPC) or a
    // write-through from a published composition (an agent rewriting a file
    // in its own agents directory) used to poison the object for good: the
    // exists-check skipped it forever and every later boot failed closed.
    // Verify on reuse and rewrite atomically so the store heals itself.
    let intact = false;
    if (existsSync(objectPath)) {
      try {
        intact = Hb("rapp/1:egg", readFileSync(objectPath)) === address;
      } catch {
        intact = false;
      }
    }
    if (!intact) {
      const staging = `${objectPath}.${process.pid}.${randomUUID()}.tmp`;
      writeFileSync(staging, bytes, { mode: 0o600 });
      renameSync(staging, objectPath);
    }
    return { address, bytes, objectPath };
  }

  cachePackagedAgent(agent) {
    if (
      !/^[0-9a-f]{64}$/.test(agent.egg_address)
      || !/^[0-9a-f]{64}$/.test(agent.source_address)
    ) {
      throw new Error(`Agent package address is invalid: ${agent.filename}`);
    }
    const eggPath = path.join(this.eggRoot, `${agent.egg_address}.egg`);
    const egg = readFileSync(eggPath);
    if (Hb("rapp/1:egg", egg) !== agent.egg_address) {
      throw new Error(`Agent egg bytes changed: ${agent.filename}`);
    }
    const [valid, law, reason] = verifyEgg(egg);
    if (!valid) {
      throw new Error(`Agent egg failed verification (${law}: ${reason})`);
    }
    const { manifest, files } = readEgg(egg);
    if (manifest.rappid !== agent.agent_rappid || !files[agent.filename]) {
      throw new Error(`Agent egg identity changed: ${agent.filename}`);
    }
    const sourceBytes = Buffer.from(files[agent.filename]);
    const source = sourceBytes.toString("utf8");
    if (!Buffer.from(source, "utf8").equals(sourceBytes)) {
      throw new Error(`Agent egg source is not valid UTF-8: ${agent.filename}`);
    }
    const cached = this.cacheSource(source);
    if (cached.address !== agent.source_address) {
      throw new Error(`Agent egg source changed: ${agent.filename}`);
    }
    return cached;
  }

  packageAgent({ filename, source, existingRappid = null }) {
    const safeName = safeAgentFilename(filename);
    const cached = this.cacheSource(source);
    const identity = existingRappid
      ? { rappid: existingRappid }
      : mintRappid(this.owner, slugFromFilename(safeName));
    const rappidJson = Buffer.from(canonical({ rappid: identity.rappid }), "utf8");
    const egg = packEgg({
      variant: "rapplication",
      rappid: identity.rappid,
      createdUtc: new Date().toISOString(),
      files: {
        "rappid.json": rappidJson,
        [safeName]: cached.bytes,
      },
    });
    const eggAddress = Hb("rapp/1:egg", egg);
    const eggPath = path.join(this.eggRoot, `${eggAddress}.egg`);
    if (!existsSync(eggPath)) writeFileSync(eggPath, egg, { mode: 0o600 });
    return {
      filename: safeName,
      agent_rappid: identity.rappid,
      egg_address: eggAddress,
      source_address: cached.address,
      object_path: cached.objectPath,
    };
  }

  ephemeralAgentEntry({ filename, source }) {
    const safeName = safeAgentFilename(filename);
    const bytes = Buffer.from(String(source || ""), "utf8");
    if (!bytes.length || bytes.length > MAX_AGENT_BYTES) {
      throw new Error("Agent source must be between 1 byte and 512 KiB.");
    }
    return {
      filename: safeName,
      address: Hb("rapp/1:egg", bytes),
      bytes,
      scope: "ephemeral",
    };
  }

  validateScopedAgentInstall(candidateStack, packaged) {
    // Fertility gate: a candidate composition containing the new agent must
    // dry-load against the Grail kernel BEFORE the stack is persisted, so a
    // broken install can never brick the next boot.
    this.stackOverrides.set(candidateStack.rappid, candidateStack);
    let entries;
    try {
      const descriptor = this.compositionDescriptor({ applyLineage: false });
      entries = descriptor.entries.some(
        (entry) => entry.filename === packaged.filename
          && entry.scope === `stack:${candidateStack.rappid}`,
      )
        ? descriptor.entries
        : [
            ...this.globalAgentEntries(descriptor.identity.memory_guid),
            {
              address: packaged.source_address,
              filename: packaged.filename,
              objectPath: packaged.object_path,
              scope: `stack:${candidateStack.rappid}`,
            },
          ];
    } finally {
      this.stackOverrides.delete(candidateStack.rappid);
    }
    const validationRoot = mkdtempSync(
      path.join(this.compositionRoot, ".install-gate-"),
    );
    const validationDirectory = path.join(validationRoot, "agents");
    ensurePrivateDirectory(validationDirectory);
    try {
      for (const entry of entries) {
        const destination = path.join(validationDirectory, entry.filename);
        if (entry.objectPath) copyFileSync(entry.objectPath, destination);
        else writeFileSync(destination, entry.bytes, { mode: 0o600 });
      }
      this.validateAgentDirectory(validationDirectory);
    } finally {
      rmSync(validationRoot, { recursive: true, force: true });
    }
  }

  async installScopedAgent({
    filename,
    source,
    stackRappid = null,
    origin = "surgeon",
  }) {
    const identity = this.identity();
    const stack = this.loadStack(
      stackRappid || identity.active_stack_rappid,
    );
    const safeName = safeAgentFilename(filename);
    const previous = stack.agents.find((agent) => agent.filename === safeName);
    const packaged = this.packageAgent({
      filename: safeName,
      source,
      existingRappid: previous?.agent_rappid || null,
    });
    const agents = [
      ...stack.agents.filter((agent) => agent.filename !== packaged.filename),
      packaged,
    ].sort((left, right) => left.filename.localeCompare(right.filename));
    try {
      this.validateScopedAgentInstall({ ...stack, agents }, packaged);
    } catch (error) {
      const lesson = String(error?.message || error);
      this.recordTelemetry("stack-agent-install-refused", {
        filename: packaged.filename,
        lesson,
        stack_rappid: stack.rappid,
      });
      throw new Error(
        `Refusing to install ${packaged.filename}: ${lesson}`,
      );
    }
    stack.agents = agents;
    this.saveStack(stack);
    this.recordTelemetry("stack-agent-installed", {
      ...agentLedgerRow({
        filename: packaged.filename,
        origin,
        rappid: packaged.agent_rappid,
        source,
        sourcePath: packaged.object_path,
      }),
      filename: packaged.filename,
      stack_rappid: stack.rappid,
    });
    return {
      user_rappid: identity.caller_rappid,
      memory_guid: identity.memory_guid,
      stack_rappid: stack.rappid,
      agent: packaged,
    };
  }

  async listScopedAgents({ stackRappid = null } = {}) {
    const identity = this.identity();
    const stack = this.loadStack(stackRappid || identity.active_stack_rappid);
    const descriptor = this.compositionDescriptor();
    return {
      user_rappid: identity.caller_rappid,
      memory_guid: identity.memory_guid,
      active_stack_rappid: identity.active_stack_rappid,
      overlay_stack_rappids: identity.overlay_stack_rappids,
      selected_stack: stack,
      stack_lineage: descriptor.selectedStacks.map((item) => item.rappid),
      stack_tree: this.stackTree(),
      composition_hash: descriptor.compositionHash,
      agents: stack.agents,
    };
  }

  async removeScopedAgent({
    filename,
    stackRappid = null,
    origin = "surgeon",
  }) {
    const identity = this.identity();
    const stack = this.loadStack(
      stackRappid || identity.active_stack_rappid,
    );
    const safeName = safeAgentFilename(filename);
    const removedAgent = stack.agents.find(
      (agent) => agent.filename === safeName,
    );
    const before = stack.agents.length;
    stack.agents = stack.agents.filter((agent) => agent.filename !== safeName);
    if (stack.agents.length === before) {
      throw new Error(`Scoped agent not found: ${safeName}`);
    }
    this.saveStack(stack);
    let removedSource = null;
    try {
      removedSource = readFileSync(removedAgent?.object_path);
    } catch {
      // Removal remains authoritative even if its content-addressed source is gone.
    }
    this.recordTelemetry("stack-agent-removed", {
      ...agentLedgerRow({
        filename: safeName,
        origin,
        rappid: removedAgent?.agent_rappid || null,
        source: removedSource,
        sourcePath: removedAgent?.object_path || null,
      }),
      filename: safeName,
      stack_rappid: stack.rappid,
    });
    return {
      removed: safeName,
      stack_rappid: stack.rappid,
    };
  }

  async removeActiveAgent({ filename }) {
    const safeName = safeAgentFilename(filename);
    const active = this.activeAgentFiles().find(
      (agent) => agent.filename === safeName,
    );
    if (!active) throw new Error(`Active agent not found: ${safeName}`);
    if (active.scope === "memory") {
      throw new Error(
        `${safeName} is generated from the OpenRappter identity and cannot be deleted.`,
      );
    }
    if (active.scope === "ephemeral") {
      throw new Error(
        `${safeName} is temporary and is removed automatically after its request.`,
      );
    }
    if (active.scope === "global") {
      const globalDirectory = path.resolve(
        this.brainstemConfig.brainstemDir,
        "agents",
      );
      const sourcePath = path.resolve(globalDirectory, safeName);
      if (path.dirname(sourcePath) !== globalDirectory) {
        throw new Error("Global agent path escaped the agents directory.");
      }
      if (!existsSync(sourcePath)) {
        throw new Error(`Global agent source not found: ${safeName}`);
      }
      const source = readFileSync(sourcePath);
      const cached = this.cacheSource(source);
      rmSync(sourcePath, { force: true });
      this.recordTelemetry("global-agent-removed", {
        ...agentLedgerRow({
          filename: safeName,
          origin: "surgeon",
          source: cached.bytes,
          sourcePath: cached.objectPath,
        }),
        filename: safeName,
      });
      return { removed: safeName, scope: active.scope };
    }
    if (active.scope.startsWith("stack:")) {
      const stackRappid = active.scope.slice("stack:".length);
      const result = await this.removeScopedAgent({
        filename: safeName,
        stackRappid,
      });
      return { ...result, scope: active.scope };
    }
    throw new Error(`Unsupported agent scope: ${active.scope}`);
  }

  globalAgentEntries(memoryGuid) {
    const globalDirectory = path.join(this.brainstemConfig.brainstemDir, "agents");
    const entries = [];
    for (const filename of readdirSync(globalDirectory).sort()) {
      if (!filename.endsWith("_agent.py") || filename.startsWith("__")) continue;
      if (MEMORY_FILES.has(filename)) continue;
      const source = readFileSync(path.join(globalDirectory, filename), "utf8");
      entries.push({
        filename,
        ...this.cacheSource(source),
        scope: "global",
      });
    }
    for (const [filename, source] of [
      ["context_memory_agent.py", contextMemorySource(memoryGuid)],
      ["manage_memory_agent.py", manageMemorySource(memoryGuid)],
    ]) {
      entries.push({
        filename,
        ...this.cacheSource(source),
        scope: "memory",
      });
    }
    return entries;
  }

  finalizeCompositionDescriptor({
    entries,
    identity,
    stack,
    selectedStacks,
    ephemeralAgent = null,
    ephemeralNonce = null,
  }) {
    const ordered = [...entries].sort(
      (left, right) => left.filename.localeCompare(right.filename),
    );
    const compositionDocument = {
      caller_rappid: identity.caller_rappid,
      memory_guid: identity.memory_guid,
      stack_rappid: stack.rappid,
      overlay_stack_rappids: identity.overlay_stack_rappids,
      stack_lineage: selectedStacks.map((selected) => selected.rappid),
      agents: ordered.map((entry) => ({
        filename: entry.filename,
        address: entry.address,
        scope: entry.scope,
      })),
    };
    if (ephemeralNonce) {
      compositionDocument.ephemeral_nonce = ephemeralNonce;
    }
    return {
      compositionHash: sha256(Buffer.from(canonical(compositionDocument))),
      entries: ordered,
      identity,
      stack,
      selectedStacks,
      ephemeral: Boolean(ephemeralAgent),
      ephemeralNonce,
      ephemeralAgent,
      lineageOverlays: ordered
        .filter((entry) => entry.lineage)
        .map((entry) => ({ ...entry.lineage, filename: entry.filename })),
    };
  }

  compositionDescriptor({
    ephemeralAgent = null,
    applyLineage = true,
    lineageHeads = null,
    excludeFilenames = null,
  } = {}) {
    const identity = this.identity();
    const stack = this.loadStack(identity.active_stack_rappid);
    const entries = this.globalAgentEntries(identity.memory_guid);
    const selectedStacks = [];
    for (const candidate of [
      stack.rappid,
      ...identity.overlay_stack_rappids,
    ]) {
      for (const inherited of this.stackLineage(candidate)) {
        if (!selectedStacks.some((item) => item.rappid === inherited.rappid)) {
          selectedStacks.push(inherited);
        }
      }
    }
    for (const selected of selectedStacks) {
      for (const agent of selected.agents) {
        const cached = this.cachePackagedAgent(agent);
        entries.push({
          filename: agent.filename,
          ...cached,
          scope: `stack:${selected.rappid}`,
        });
      }
    }
    const ephemeralNonce = ephemeralAgent ? randomUUID() : null;
    if (ephemeralAgent) entries.push(this.ephemeralAgentEntry(ephemeralAgent));
    // The composition-quarantine fallback tier re-composes without the files
    // the Grail dry-load named, so user-added content can never brick boot.
    const composedEntries = excludeFilenames?.size
      ? entries.filter((entry) => !excludeFilenames.has(entry.filename))
      : entries;

    const resolvedEntries = applyLineage ? composedEntries.map((entry) => {
      try {
        return this.resolveLineageEntry(
          entry,
          identity.memory_guid,
          lineageHeads,
        );
      } catch (error) {
        this.recordTelemetry("lineage-overlay-skipped", {
          error: String(error?.message || error),
          filename: entry.filename,
        });
        return entry;
      }
    }) : composedEntries;
    const byFilename = new Map();
    for (const entry of resolvedEntries) {
      if (byFilename.has(entry.filename)) {
        throw new Error(
          `Agent composition collision for ${entry.filename}; `
          + "explicit override policy is required.",
        );
      }
      byFilename.set(entry.filename, entry);
    }
    return this.finalizeCompositionDescriptor({
      entries: [...byFilename.values()],
      identity,
      stack,
      selectedStacks,
      ephemeralAgent,
      ephemeralNonce,
    });
  }

  tileCompositionDescriptor(agentSources = []) {
    if (!Array.isArray(agentSources)) {
      throw new Error("A tile agent payload must be an array.");
    }
    const identity = this.identity();
    const tileIdentity = {
      ...identity,
      overlay_stack_rappids: [],
    };
    const stack = this.loadStack(identity.active_stack_rappid);
    const entries = this.globalAgentEntries(identity.memory_guid);
    const filenames = new Set(entries.map((entry) => entry.filename));
    for (const agent of agentSources) {
      if (!agent || typeof agent !== "object" || Array.isArray(agent)) {
        throw new Error("Every tile agent payload entry must be an object.");
      }
      const filename = safeAgentFilename(agent.filename);
      if (filenames.has(filename)) {
        throw new Error(
          `Agent composition collision for ${filename}; `
          + "a tile cannot replace a global or memory agent.",
        );
      }
      filenames.add(filename);
      entries.push({
        filename,
        ...this.cacheSource(String(agent.source || "")),
        scope: "tile",
      });
    }
    return this.finalizeCompositionDescriptor({
      entries,
      identity: tileIdentity,
      stack,
      selectedStacks: [],
    });
  }

  compositionIsComplete(descriptor, agentDirectory, manifest) {
    if (
      manifest?.composition_hash !== descriptor.compositionHash
      || !Array.isArray(manifest.agents)
      || manifest.agents.length !== descriptor.entries.length
    ) {
      return false;
    }
    const expected = new Map(
      descriptor.entries.map((entry) => [entry.filename, entry]),
    );
    const manifestMatches = manifest.agents.every((agent) => {
      const entry = expected.get(agent.filename);
      return Boolean(
        entry
        && agent.address === entry.address
        && agent.scope === entry.scope
        && existsSync(path.join(agentDirectory, agent.filename)),
      );
    });
    if (!manifestMatches) return false;
    try {
      this.assertAgentDirectoryMatches(agentDirectory, descriptor.entries);
      return true;
    } catch {
      return false;
    }
  }

  materializeCompositionOnce(descriptor, { fresh = false } = {}) {
    const hash = descriptor.compositionHash;
    // `fresh` bypasses the negative cache. The lineage isolation trial uses it:
    // a decision to DEMOTE a ring must rest on a validation that actually ran,
    // not on a remembered failure from seconds ago that may have been a
    // transient (a timed-out dry-load under load) — otherwise one flake moves
    // HEAD to baseline until the user types the restore word.
    if (fresh) this.failedCompositions.delete(hash);
    const remembered = this.failedCompositions.get(hash);
    if (remembered) {
      if (Date.now() - remembered.at < COMPOSITION_FAILURE_TTL_MS) {
        throw new Error(remembered.message);
      }
      this.failedCompositions.delete(hash);
    }
    try {
      return this._materializeCompositionOnce(descriptor);
    } catch (error) {
      this.failedCompositions.set(hash, {
        at: Date.now(),
        message: String(error?.message || error),
      });
      throw error;
    }
  }

  _materializeCompositionOnce(descriptor) {
    const compositionDirectory = path.join(
      this.compositionRoot,
      descriptor.compositionHash,
    );
    const agentDirectory = path.join(compositionDirectory, "agents");
    const completeFile = path.join(compositionDirectory, "complete.json");
    if (existsSync(completeFile)) {
      try {
        const manifest = JSON.parse(readFileSync(completeFile, "utf8"));
        if (this.compositionIsComplete(descriptor, agentDirectory, manifest)) {
          if (!this.validatedCompositions.has(descriptor.compositionHash)) {
            this.validatePrivateAgentSet(
              agentDirectory,
              descriptor.entries,
            );
            this.validatedCompositions.add(descriptor.compositionHash);
          }
          return { compositionDirectory, agentDirectory };
        }
      } catch {}
    }
    const stagingDirectory = path.join(
      this.compositionRoot,
      `.${descriptor.compositionHash}.${process.pid}.${randomUUID()}.stage`,
    );
    const stagingAgentDirectory = path.join(stagingDirectory, "agents");
    const stagingCompleteFile = path.join(stagingDirectory, "complete.json");
    rmSync(stagingDirectory, { recursive: true, force: true });
    ensurePrivateDirectory(stagingAgentDirectory);
    const links = [];
    try {
      for (const entry of descriptor.entries) {
        const destination = path.join(stagingAgentDirectory, entry.filename);
        let method;
        if (entry.scope === "ephemeral" || entry.lineage) {
          writeFileSync(destination, entry.bytes, { mode: 0o600 });
          method = entry.lineage ? "molt" : "ephemeral";
        } else {
          method = copyObject(entry.objectPath, destination);
        }
        links.push({
          filename: entry.filename,
          method,
          address: entry.address,
          scope: entry.scope,
        });
      }
      this.validatePrivateAgentSet(
        stagingAgentDirectory,
        descriptor.entries,
      );
      atomicWriteJson(stagingCompleteFile, {
        schema: ROUTING_SCHEMA,
        composition_hash: descriptor.compositionHash,
        caller_rappid: descriptor.identity.caller_rappid,
        memory_guid: descriptor.identity.memory_guid,
        stack_rappid: descriptor.stack.rappid,
        overlay_stack_rappids: descriptor.identity.overlay_stack_rappids,
        stack_lineage: descriptor.selectedStacks.map((stack) => stack.rappid),
        agents: links,
      });

      if (existsSync(compositionDirectory)) {
        const existingManifest = existsSync(completeFile)
          ? JSON.parse(readFileSync(completeFile, "utf8"))
          : null;
        if (
          existingManifest
          && this.compositionIsComplete(
            descriptor,
            agentDirectory,
            existingManifest,
          )
        ) {
          this.validatePrivateAgentSet(agentDirectory, descriptor.entries);
          rmSync(stagingDirectory, { recursive: true, force: true });
          this.validatedCompositions.add(descriptor.compositionHash);
          return { compositionDirectory, agentDirectory };
        }
        if (this.workers.has(descriptor.compositionHash)) {
          throw new Error(
            "Refusing to replace an invalid composition while its worker is live.",
          );
        }
        rmSync(compositionDirectory, { recursive: true, force: true });
      }
      renameSync(stagingDirectory, compositionDirectory);
      this.validatedCompositions.add(descriptor.compositionHash);
      return { compositionDirectory, agentDirectory };
    } catch (error) {
      rmSync(stagingDirectory, { recursive: true, force: true });
      throw error;
    }
  }

  materializeComposition(descriptor, { allowLineageFallback = true } = {}) {
    const lastGoodDescriptor = this.lastGoodDescriptor;
    try {
      const materialized = {
        ...this.materializeCompositionOnce(descriptor),
        descriptor,
      };
      if (!descriptor.ephemeral) this.lastGoodDescriptor = descriptor;
      return materialized;
    } catch (error) {
      if (!allowLineageFallback) throw error;
      if (!descriptor.lineageOverlays?.length) {
        return this.quarantineCompositionFallback(descriptor, error, error);
      }
      if (
        lastGoodDescriptor
        && lastGoodDescriptor.compositionHash !== descriptor.compositionHash
        && this.sameRouteIdentity(lastGoodDescriptor, descriptor)
      ) {
        try {
          const reconciliation = this.reconcileLastGoodLineage(
            lastGoodDescriptor,
            descriptor,
          );
          const fallbackDescriptor = reconciliation
            ? reconciliation.descriptor
            : lastGoodDescriptor;
          if (
            reconciliation
            && fallbackDescriptor.compositionHash === descriptor.compositionHash
          ) {
            throw new Error(
              "Reconciled last-good lineage still resolves to the failed composition.",
            );
          }
          const lastGood = this.materializeCompositionOnce(
            fallbackDescriptor,
            { fresh: Boolean(reconciliation) },
          );
          if (reconciliation) {
            this.recordTelemetry("lineage-last-good-resynced", {
              dropped: reconciliation.dropped,
              fallback_composition_hash: fallbackDescriptor.compositionHash,
              requested_composition_hash: descriptor.compositionHash,
            });
          }
          const fallback = this.isolateLineageFallback(
            descriptor,
            fallbackDescriptor,
            lastGood,
            "last-good",
          );
          this.recordLineageFallback(descriptor, error, fallback);
          return fallback;
        } catch (lastGoodError) {
          this.recordTelemetry("lineage-last-good-skipped", {
            error: String(lastGoodError?.message || lastGoodError),
            requested_composition_hash: descriptor.compositionHash,
          });
          // The prior artifact is no longer loadable; try pristine baseline next.
        }
      }
      const fallbackDescriptor = this.compositionDescriptor({
        ephemeralAgent: descriptor.ephemeralAgent,
        applyLineage: false,
      });
      let fallback;
      try {
        fallback = this.materializeCompositionOnce(fallbackDescriptor);
      } catch (fallbackError) {
        return this.quarantineCompositionFallback(
          descriptor,
          error,
          fallbackError,
        );
      }
      const isolated = this.isolateLineageFallback(
        descriptor,
        fallbackDescriptor,
        fallback,
        "baseline",
      );
      this.recordLineageFallback(descriptor, error, isolated);
      return isolated;
    }
  }

  sameRouteIdentity(left, right) {
    // The last-good fallback may only revive the SAME route: after an explicit
    // stack or overlay switch, a failure on the new route must resolve to that
    // route's pristine baseline, never a previously selected stack.
    return (
      left.identity.caller_rappid === right.identity.caller_rappid
      && left.identity.memory_guid === right.identity.memory_guid
      && left.stack.rappid === right.stack.rappid
      && canonical(left.identity.overlay_stack_rappids)
        === canonical(right.identity.overlay_stack_rappids)
    );
  }

  reconcileLastGoodLineage(lastGoodDescriptor, failedDescriptor) {
    // A cached parent remains a valid fallback while the current verified HEAD
    // descends from it. Rollback, pinning, branch changes, and corrupt chains
    // revoke that endorsement and must be re-resolved from the live store.
    const cachedHeads = new Map(
      (lastGoodDescriptor.lineageOverlays || []).map(
        (overlay) => [overlay.ancestorRappid, overlay.ringRappid],
      ),
    );
    const ancestors = new Set([
      ...cachedHeads.keys(),
      ...(failedDescriptor.lineageOverlays || []).map(
        (overlay) => overlay.ancestorRappid,
      ),
    ]);
    const heads = new Map();
    const dropped = [];
    for (const ancestorRappid of ancestors) {
      const cachedRing = cachedHeads.get(ancestorRappid) || ancestorRappid;
      let effectiveRing = null;
      let reason = null;
      try {
        effectiveRing = this.lineageStore.resolveLive(
          ancestorRappid,
          { env: this.lineageEnv },
        )?.ringRappid || null;
        if (
          cachedRing !== ancestorRappid
          && this.lineageStore.locusPolicy(ancestorRappid) === "pinned"
        ) {
          reason = "pinned";
        } else if (
          cachedRing !== ancestorRappid
          && this.lineageStore.resolveRing(ancestorRappid, cachedRing)
            ?.ringRappid !== cachedRing
        ) {
          reason = "effective-ring-changed";
        } else {
          const currentHead = this.lineageStore.getHead(
            ancestorRappid,
            { env: this.lineageEnv },
          );
          if (
            !this.lineageStore.walk(ancestorRappid, currentHead)
              .includes(cachedRing)
          ) {
            reason = "head-moved";
          }
        }
      } catch {
        reason = "unresolvable";
      }
      if (reason) {
        dropped.push({
          ancestor_rappid: ancestorRappid,
          cached_ring: cachedRing,
          effective_ring: effectiveRing,
          reason,
        });
      } else {
        heads.set(ancestorRappid, cachedRing);
      }
    }
    const current = this.compositionDescriptor({
      ephemeralAgent: failedDescriptor.ephemeralAgent,
      lineageHeads: heads,
    });
    const currentEntries = new Map(
      current.entries.map((entry) => [entry.filename, entry]),
    );
    const mergedEntries = [];
    const included = new Set();
    for (const cachedEntry of lastGoodDescriptor.entries) {
      const currentEntry = currentEntries.get(cachedEntry.filename);
      const lineageManaged = Boolean(
        cachedEntry.lineage
        || currentEntry?.lineage
        || cachedEntry.scope === "global"
        || cachedEntry.scope === "memory"
      );
      if (lineageManaged) {
        if (currentEntry) mergedEntries.push(currentEntry);
      } else {
        mergedEntries.push(cachedEntry);
      }
      included.add(cachedEntry.filename);
    }
    for (const currentEntry of current.entries) {
      if (
        !included.has(currentEntry.filename)
        && (
          currentEntry.lineage
          || currentEntry.scope === "global"
          || currentEntry.scope === "memory"
          || currentEntry.scope === "ephemeral"
        )
      ) {
        mergedEntries.push(currentEntry);
      }
    }
    const reconciledDescriptor = this.finalizeCompositionDescriptor({
      entries: mergedEntries,
      identity: current.identity,
      stack: current.stack,
      selectedStacks: current.selectedStacks,
      ephemeralAgent: current.ephemeralAgent,
      ephemeralNonce: current.ephemeralNonce,
    });
    if (
      !dropped.length
      && reconciledDescriptor.compositionHash
        === lastGoodDescriptor.compositionHash
    ) {
      return null;
    }
    return {
      descriptor: reconciledDescriptor,
      dropped,
      heads,
    };
  }

  quarantineCompositionFallback(descriptor, error, pristineError) {
    // Final fail-safe tier: the pristine composition itself refuses to
    // dry-load. Grail names each failing file on stderr — re-compose without
    // those files (the sources on disk stay untouched) so the beta Brainstem
    // always boots, and record what was quarantined and why.
    const candidateFilenames = new Set(
      descriptor.entries.map((entry) => entry.filename),
    );
    // The pristine Grail factory agents are the survival floor and must never be
    // evicted. Grail's duplicate-tool-name error names BOTH colliding files, so
    // without this guard a user agent that collides with a baseline tool name
    // would quarantine the baseline agent too — silently disabling memory. A
    // baseline agent is protected; the colliding newcomer is the one that goes.
    const protectedFilenames = new Set(
      descriptor.entries
        .filter((entry) => entry.scope === "memory")
        .map((entry) => entry.filename),
    );
    try {
      for (const baseline of this.lineageStore.baselineAncestors()) {
        protectedFilenames.add(baseline.filename);
      }
    } catch {
      // Baseline manifest unreadable — fall back to the memory-scope guard only.
    }
    const excluded = new Map();
    let lastError = pristineError;
    for (let round = 0; round < candidateFilenames.size; round += 1) {
      const failing = dryLoadFailureFilenames(
        lastError,
        candidateFilenames,
        excluded,
      );
      for (const filename of [...failing.keys()]) {
        if (protectedFilenames.has(filename)) failing.delete(filename);
      }
      if (!failing.size) break;
      for (const [filename, reason] of failing) excluded.set(filename, reason);
      try {
        const fallbackDescriptor = this.compositionDescriptor({
          ephemeralAgent: descriptor.ephemeralAgent,
          applyLineage: false,
          excludeFilenames: new Set(excluded.keys()),
        });
        const materialized = this.materializeCompositionOnce(fallbackDescriptor);
        const descriptorEntries = new Map(
          descriptor.entries.map((entry) => [entry.filename, entry]),
        );
        const excludedFiles = [...excluded].map(([filename, reason]) => {
          const entry = descriptorEntries.get(filename);
          let source = entry?.bytes ?? null;
          if (source === null && entry?.objectPath) {
            try {
              source = readFileSync(entry.objectPath);
            } catch {
              source = null;
            }
          }
          return {
            ...agentLedgerRow({
              filename,
              origin: "lineage",
              source,
              sourcePath: entry?.objectPath || entry?.sourcePath || null,
            }),
            reason,
          };
        });
        this.recordTelemetry("composition-quarantine", {
          composition_hash: fallbackDescriptor.compositionHash,
          error: String(error?.message || error),
          excluded_files: excludedFiles,
          requested_composition_hash: descriptor.compositionHash,
        });
        if (!fallbackDescriptor.ephemeral) {
          this.lastGoodDescriptor = fallbackDescriptor;
        }
        return {
          ...materialized,
          descriptor: fallbackDescriptor,
          fallbackFrom: descriptor.compositionHash,
          fallbackStrategy: "quarantine",
          lineageAccepted: [],
          lineageRejected: (descriptor.lineageOverlays || []).map(
            (overlay) => overlay.ringRappid,
          ),
          quarantinedFiles: [...excluded.keys()],
        };
      } catch (quarantineError) {
        lastError = quarantineError;
      }
    }
    if (pristineError !== error) {
      throw new Error(
        `${String(error?.message || error)}; pristine fallback also failed: `
        + String(pristineError?.message || pristineError),
      );
    }
    throw error;
  }

  sameNonLineageComposition(left, right) {
    if (
      left.ephemeral
      || right.ephemeral
      || left.identity.caller_rappid !== right.identity.caller_rappid
      || left.identity.memory_guid !== right.identity.memory_guid
      || left.stack.rappid !== right.stack.rappid
      || left.entries.length !== right.entries.length
    ) {
      return false;
    }
    const rightEntries = new Map(
      right.entries.map((entry) => [entry.filename, entry]),
    );
    return left.entries.every((entry) => {
      const other = rightEntries.get(entry.filename);
      if (!other || entry.scope !== other.scope) return false;
      if (entry.lineage) {
        return !other.lineage
          || entry.lineage.ancestorRappid === other.lineage.ancestorRappid;
      }
      return !other.lineage && entry.address === other.address;
    });
  }

  isolateLineageFallback(
    failedDescriptor,
    fallbackDescriptor,
    fallbackMaterialized,
    baseStrategy,
  ) {
    let bestDescriptor = fallbackDescriptor;
    let bestMaterialized = fallbackMaterialized;
    const failedHeads = new Map(
      failedDescriptor.lineageOverlays.map(
        (overlay) => [overlay.ancestorRappid, overlay],
      ),
    );
    const fallbackHeads = new Map(
      (fallbackDescriptor.lineageOverlays || []).map(
        (overlay) => [overlay.ancestorRappid, overlay.ringRappid],
      ),
    );
    const changed = [...failedHeads.values()]
      .filter((overlay) => (
        overlay.ringRappid
        !== (fallbackHeads.get(overlay.ancestorRappid)
          || overlay.ancestorRappid)
      ))
      .sort((left, right) => left.filename.localeCompare(right.filename));
    const acceptedHeads = new Map(fallbackHeads);
    for (const overlay of changed) {
      if (!acceptedHeads.has(overlay.ancestorRappid)) {
        acceptedHeads.set(overlay.ancestorRappid, overlay.ancestorRappid);
      }
    }

    const accepted = [];
    const rejected = [];
    if (this.sameNonLineageComposition(failedDescriptor, fallbackDescriptor)) {
      for (const overlay of changed) {
        const trialHeads = new Map(acceptedHeads);
        trialHeads.set(overlay.ancestorRappid, overlay.ringRappid);
        const trialDescriptor = this.compositionDescriptor({
          ephemeralAgent: failedDescriptor.ephemeralAgent,
          lineageHeads: trialHeads,
        });
        try {
          bestMaterialized = this.materializeCompositionOnce(trialDescriptor, { fresh: true });
          bestDescriptor = trialDescriptor;
          acceptedHeads.set(overlay.ancestorRappid, overlay.ringRappid);
          accepted.push(overlay.ringRappid);
        } catch {
          rejected.push(overlay.ringRappid);
        }
      }
      for (const overlay of changed) {
        this.lineageStore.setHead(
          overlay.ancestorRappid,
          acceptedHeads.get(overlay.ancestorRappid),
          { env: this.lineageEnv },
        );
      }
    } else {
      rejected.push(...changed.map((overlay) => overlay.ringRappid));
    }
    if (!bestDescriptor.ephemeral) this.lastGoodDescriptor = bestDescriptor;
    return {
      ...bestMaterialized,
      descriptor: bestDescriptor,
      fallbackFrom: failedDescriptor.compositionHash,
      fallbackStrategy: accepted.length ? "isolated" : baseStrategy,
      lineageAccepted: accepted,
      lineageRejected: rejected,
    };
  }

  recordLineageFallback(failedDescriptor, error, fallback) {
    this.recordTelemetry("lineage-composition-fallback", {
      accepted_rings: fallback.lineageAccepted,
      error: String(error?.message || error),
      rejected_rings: fallback.lineageRejected,
      rings: failedDescriptor.lineageOverlays.map(
        (overlay) => overlay.ringRappid,
      ),
      strategy: fallback.fallbackStrategy,
    });
  }

  materializeExternalAgentSet(agentSources, agentDirectory) {
    const original = agentSources.map((agent) => ({ ...agent }));
    const resolved = original.map((agent) => {
      try {
        return this.resolveTwinLineageSource(agent.filename, agent.source);
      } catch (error) {
        this.recordTelemetry("lineage-overlay-skipped", {
          error: String(error?.message || error),
          filename: agent.filename,
        });
        return { ...agent, lineage: null };
      }
    });
    const materialize = (sources) => {
      const stagingDirectory = `${agentDirectory}.${process.pid}.${randomUUID()}.stage`;
      rmSync(stagingDirectory, { recursive: true, force: true });
      ensurePrivateDirectory(stagingDirectory);
      try {
        for (const agent of sources) {
          writeFileSync(
            path.join(stagingDirectory, agent.filename),
            agent.source,
            { mode: 0o600 },
          );
        }
        this.validatePrivateAgentSet(
          stagingDirectory,
          sources.map((agent) => ({
            address: Hb(
              "rapp/1:egg",
              Buffer.from(agent.source, "utf8"),
            ),
            filename: agent.filename,
          })),
        );
        if (existsSync(agentDirectory)) {
          throw new Error(
            "Refusing to mutate an external AGENTS_PATH after publication.",
          );
        }
        renameSync(stagingDirectory, agentDirectory);
        return sources;
      } catch (error) {
        rmSync(stagingDirectory, { recursive: true, force: true });
        throw error;
      }
    };

    try {
      return materialize(resolved);
    } catch (error) {
      const overlays = resolved.filter((agent) => agent.lineage);
      if (!overlays.length) throw error;
      const baseline = materialize(original);
      this.recordTelemetry("lineage-composition-fallback", {
        error: String(error?.message || error),
        rings: overlays.map((agent) => agent.lineage.ringRappid),
        strategy: "twin-baseline",
      });
      return baseline;
    }
  }

  async startWorker(descriptor, { allowLineageFallback = true } = {}) {
    this.lastLineageFallback = null;
    const existing = this.workers.get(descriptor.compositionHash);
    if (existing) {
      existing.lastUsed = Date.now();
      return existing.route;
    }
    const materialized = this.materializeComposition(descriptor, {
      allowLineageFallback,
    });
    const effectiveDescriptor = materialized.descriptor || descriptor;
    if (materialized.fallbackStrategy) {
      this.lastLineageFallback = {
        accepted: materialized.lineageAccepted || [],
        effectiveCompositionHash: effectiveDescriptor.compositionHash,
        rejected: materialized.lineageRejected || [],
        requestedCompositionHash: descriptor.compositionHash,
        strategy: materialized.fallbackStrategy,
      };
    }
    const fallbackWorker = this.workers.get(effectiveDescriptor.compositionHash);
    if (fallbackWorker) {
      fallbackWorker.lastUsed = Date.now();
      return fallbackWorker.route;
    }
    const port = await allocatePort();
    const config = {
      ...this.brainstemConfig,
      port,
      portPreallocated: true,
      url: `http://127.0.0.1:${port}`,
      logFile: path.join(
        this.workerLogRoot,
        `${effectiveDescriptor.compositionHash}.log`,
      ),
      env: {
        AGENTS_PATH: materialized.agentDirectory,
        BRAINSTEM_BETA_ROUTED_WORKER: "1",
        RAPP_AMBIENT_DIR: path.join(this.betaHome, "ambient"),
        BRAINSTEM_SOURCE_AGENTS_PATH: path.join(
          this.brainstemConfig.brainstemDir,
          "agents",
        ),
      },
    };
    const process = this.createWorkerProcess(config);
    const result = await process.start();
    const route = {
      url: config.url,
      port,
      compositionHash: effectiveDescriptor.compositionHash,
      callerRappid: effectiveDescriptor.identity.caller_rappid,
      memoryGuid: effectiveDescriptor.identity.memory_guid,
      stackRappid: effectiveDescriptor.stack.rappid,
      overlayStackRappids: effectiveDescriptor.identity.overlay_stack_rappids,
      stackLineage: effectiveDescriptor.selectedStacks.map((stack) => stack.rappid),
      health: result.health,
    };
    this.workers.set(effectiveDescriptor.compositionHash, {
      activeRequests: 0,
      agentDirectory: materialized.agentDirectory,
      compositionDirectory: materialized.compositionDirectory,
      descriptor: effectiveDescriptor,
      process,
      route,
      lastUsed: Date.now(),
      ephemeral: effectiveDescriptor.ephemeral,
    });
    this.recordTelemetry("worker-started", {
      composition_hash: effectiveDescriptor.compositionHash,
      url: route.url,
      worker_count: this.workers.size,
    });
    return route;
  }

  createWorkerProcess(config) {
    return new BrainstemProcess(config);
  }

  async waitForWorkerIdle(worker, timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs;
    while (worker.activeRequests > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (worker.activeRequests > 0) {
      throw new Error("The superseded Brainstem worker is still handling a request.");
    }
  }

  async retireInactiveWorker(compositionHash) {
    const worker = this.workers.get(compositionHash);
    if (!worker || worker.route === this.activeRoute) return;
    await this.waitForWorkerIdle(worker);
    if (worker.route === this.activeRoute) return;
    this.workers.delete(compositionHash);
    await worker.process.stop();
    if (worker.retiredCompositionDirectory) {
      rmSync(worker.retiredCompositionDirectory, {
        recursive: true,
        force: true,
      });
    }
    this.pruneRoutingArtifacts();
    this.recordTelemetry("worker-stopped", {
      composition_hash: compositionHash,
      url: worker.route.url,
      worker_count: this.workers.size,
    });
  }

  async activate(route) {
    this.activeRoute = route;
    this.recordTelemetry("route-activated", {
      active_composition_hash: route.transientCompositionHash
        || route.compositionHash,
      base_composition_hash: route.compositionHash,
      url: route.url,
    });
    await this.onActivate(route);
    return route;
  }

  async activateDescriptorUnlocked(descriptor, options = {}) {
    const previous = this.activeRoute;
    const route = await this.activate(await this.startWorker(descriptor, options));
    if (
      previous
      && previous.compositionHash !== route.compositionHash
    ) {
      await this.retireInactiveWorker(previous.compositionHash);
    }
    return route;
  }

  async startDefaultUnlocked() {
    return this.activateDescriptorUnlocked(this.compositionDescriptor());
  }

  async startDefault() {
    return this.withRouteLock(
      "__lifecycle__",
      () => this.startDefaultUnlocked(),
    );
  }

  async startBlank() {
    return this.withRouteLock(
      "__lifecycle__",
      () => this.activateDescriptorUnlocked(this.tileCompositionDescriptor()),
    );
  }

  async startTile(agentSources) {
    return this.withRouteLock(
      "__lifecycle__",
      () => this.activateDescriptorUnlocked(
        this.tileCompositionDescriptor(agentSources),
        { allowLineageFallback: false },
      ),
    );
  }

  whenLifecycleIdle(callback) {
    if (typeof callback !== "function") {
      throw new Error("A lifecycle-idle callback is required.");
    }
    const pending = this.routeLocks.get("__lifecycle__");
    const completion = (pending || Promise.resolve()).then(callback);
    if (pending) {
      completion.catch((error) => {
        this.recordTelemetry("lifecycle-idle-callback-error", {
          error: String(error?.message || error),
        });
      });
    }
    return {
      deferred: Boolean(pending),
      completion,
    };
  }

  async withRouteLock(key, callback) {
    const previous = this.routeLocks.get(key) || Promise.resolve();
    this.recordTelemetry("lock-wait", {
      key,
      queued: this.routeLocks.has(key),
    });
    let release;
    const current = new Promise((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.routeLocks.set(key, tail);
    await previous;
    this.recordTelemetry("lock-acquired", { key });
    try {
      return await callback();
    } finally {
      release();
      if (this.routeLocks.get(key) === tail) this.routeLocks.delete(key);
      this.recordTelemetry("lock-released", { key });
    }
  }

  async withActiveEphemeral(descriptor, callback) {
    return this.withRouteLock("__lifecycle__", () => {
      const route = this.activeRoute;
      const worker = route
        ? this.workers.get(route.compositionHash)
        : null;
      if (!worker) throw new Error("No active Brainstem worker is available.");
      return this.withRouteLock(route.compositionHash, async () => {
        const entry = descriptor.entries.find(
          (candidate) => candidate.scope === "ephemeral",
        );
        if (!entry) throw new Error("The ephemeral agent entry is missing.");
        const destination = path.join(worker.agentDirectory, entry.filename);
        if (existsSync(destination)) {
          throw new Error(
            `Agent composition collision for ${entry.filename}; `
            + "explicit override policy is required.",
          );
        }
        const manifestPath = path.join(
          worker.compositionDirectory,
          "complete.json",
        );
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
        writeFileSync(destination, entry.bytes, { mode: 0o600 });
        manifest.active_composition_hash = descriptor.compositionHash;
        manifest.agents.push({
          filename: entry.filename,
          method: "ephemeral",
          address: entry.address,
          scope: entry.scope,
        });
        atomicWriteJson(manifestPath, manifest);
        route.transientCompositionHash = descriptor.compositionHash;
        worker.activeRequests += 1;
        const archivedSource = this.ledger?.archiveAgentSource?.({
          filename: entry.filename,
          source: entry.bytes,
        }) || null;
        const ephemeralLedgerRow = {
          ...agentLedgerRow({
            filename: entry.filename,
            origin: "surgeon",
            source: entry.bytes,
            sourcePath: archivedSource?.path || destination,
          }),
          ...(archivedSource ? { sha256: archivedSource.sha256 } : {}),
        };
        this.recordTelemetry("ephemeral-injected", {
          ...ephemeralLedgerRow,
          active_composition_hash: descriptor.compositionHash,
          base_composition_hash: route.compositionHash,
          egg_count: readdirSync(this.eggRoot).length,
          filename: entry.filename,
          manifest_agent_count: manifest.agents.length,
          object_count: readdirSync(this.objectRoot).length,
          url: route.url,
        });
        await this.activate(route);
        try {
          this.recordTelemetry("ephemeral-callback-start", {
            active_composition_hash: descriptor.compositionHash,
            filename: entry.filename,
            url: route.url,
          });
          const result = await callback(route);
          this.recordTelemetry("ephemeral-callback-end", {
            active_composition_hash: descriptor.compositionHash,
            filename: entry.filename,
            request_id: result?.requestId || null,
            url: route.url,
          });
          return result;
        } catch (error) {
          this.recordTelemetry("ephemeral-callback-error", {
            active_composition_hash: descriptor.compositionHash,
            error: String(error?.message || error),
            filename: entry.filename,
            url: route.url,
          });
          throw error;
        } finally {
          rmSync(destination, { force: true });
          rmSync(path.join(worker.agentDirectory, "__pycache__"), {
            recursive: true,
            force: true,
          });
          const retiredManifest = JSON.parse(
            readFileSync(manifestPath, "utf8"),
          );
          retiredManifest.agents = retiredManifest.agents.filter(
            (agent) => agent.scope !== "ephemeral",
          );
          delete retiredManifest.active_composition_hash;
          atomicWriteJson(manifestPath, retiredManifest);
          worker.activeRequests = Math.max(0, worker.activeRequests - 1);
          delete route.transientCompositionHash;
          this.recordTelemetry("ephemeral-cleaned", {
            ...ephemeralLedgerRow,
            active_composition_hash: descriptor.compositionHash,
            egg_count: readdirSync(this.eggRoot).length,
            filename: entry.filename,
            file_exists: existsSync(destination),
            manifest_has_ephemeral: retiredManifest.agents.some(
              (agent) => agent.scope === "ephemeral",
            ),
            object_count: readdirSync(this.objectRoot).length,
            url: route.url,
          });
          await this.activate(route);
        }
      });
    });
  }

  async retireEphemeralWorker(descriptor) {
    const worker = this.workers.get(descriptor.compositionHash);
    if (!worker) return this.startDefaultUnlocked();
    for (const entry of descriptor.entries.filter(
      (candidate) => candidate.scope === "ephemeral",
    )) {
      rmSync(path.join(worker.agentDirectory, entry.filename), { force: true });
    }
    rmSync(path.join(worker.agentDirectory, "__pycache__"), {
      recursive: true,
      force: true,
    });
    const retiredManifestPath = path.join(
      worker.compositionDirectory,
      "complete.json",
    );
    if (existsSync(retiredManifestPath)) {
      const retiredManifest = JSON.parse(
        readFileSync(retiredManifestPath, "utf8"),
      );
      retiredManifest.agents = retiredManifest.agents.filter(
        (agent) => agent.scope !== "ephemeral",
      );
      retiredManifest.retired_ephemeral = true;
      atomicWriteJson(retiredManifestPath, retiredManifest);
    }

    const requestedDefault = this.compositionDescriptor();
    const materializedDefault = this.materializeComposition(requestedDefault);
    // A composition fallback re-keys the worker under the EFFECTIVE hash the
    // next materialization actually serves, never a hash that cannot compose.
    const defaultDescriptor = materializedDefault.descriptor || requestedDefault;
    const previousDefault = this.workers.get(defaultDescriptor.compositionHash);
    if (previousDefault && previousDefault !== worker) {
      await this.waitForWorkerIdle(previousDefault);
      this.workers.delete(defaultDescriptor.compositionHash);
      await previousDefault.process.stop();
      if (previousDefault.retiredCompositionDirectory) {
        rmSync(previousDefault.retiredCompositionDirectory, {
          recursive: true,
          force: true,
        });
      }
    }

    this.workers.delete(descriptor.compositionHash);
    worker.descriptor = defaultDescriptor;
    worker.ephemeral = false;
    worker.lastUsed = Date.now();
    worker.retiredCompositionDirectory = worker.compositionDirectory;
    worker.route.compositionHash = defaultDescriptor.compositionHash;
    worker.route.stackRappid = defaultDescriptor.stack.rappid;
    worker.route.overlayStackRappids = defaultDescriptor.identity.overlay_stack_rappids;
    worker.route.stackLineage = defaultDescriptor.selectedStacks.map(
      (stack) => stack.rappid,
    );
    this.workers.set(defaultDescriptor.compositionHash, worker);
    return this.activate(worker.route);
  }

  async withRoute(options, callback) {
    const descriptor = this.compositionDescriptor({
      ephemeralAgent: options?.ephemeralAgent || null,
    });
    if (
      descriptor.ephemeral
      && this.activeRoute
      && this.workers.has(this.activeRoute.compositionHash)
    ) {
      return this.withActiveEphemeral(descriptor, callback);
    }
    return this.withRouteLock("__lifecycle__", async () => {
      const route = await this.startWorker(descriptor);
      const worker = this.workers.get(route.compositionHash);
      if (worker) worker.activeRequests += 1;
      await this.activate(route);
      try {
        this.recordTelemetry("route-callback-start", {
          composition_fingerprint: this.compositionFingerprint(worker),
          composition_hash: route.compositionHash,
          url: route.url,
        });
        const result = await callback(route);
        this.recordTelemetry("route-callback-end", {
          agent_logs_preview: String(result?.agentLogs || "").slice(0, 2000),
          composition_fingerprint: this.compositionFingerprint(worker),
          composition_hash: route.compositionHash,
          request_id: result?.requestId || null,
          response_preview: String(result?.response || "").slice(0, 1000),
          url: route.url,
        });
        return result;
      } catch (error) {
        this.recordTelemetry("route-callback-error", {
          composition_hash: route.compositionHash,
          error: String(error?.message || error),
          url: route.url,
        });
        throw error;
      } finally {
        if (worker) worker.activeRequests = Math.max(0, worker.activeRequests - 1);
        if (descriptor.ephemeral) {
          // A composition fallback registers the worker under the EFFECTIVE
          // descriptor's hash — retire that one so the fallback's ephemeral
          // composition directory and manifest are actually cleaned up.
          await this.retireEphemeralWorker(
            worker?.descriptor?.ephemeral ? worker.descriptor : descriptor,
          );
        }
      }
    });
  }

  activeAgentFiles() {
    if (!this.activeRoute) return [];
    const worker = this.workers.get(this.activeRoute.compositionHash);
    const manifestPath = worker
      ? path.join(worker.compositionDirectory, "complete.json")
      : path.join(
          this.compositionRoot,
          this.activeRoute.compositionHash,
          "complete.json",
        );
    return JSON.parse(readFileSync(manifestPath, "utf8")).agents;
  }

  activeTileAgentPayload() {
    return this.activeAgentFiles()
      .filter((agent) => !["global", "memory"].includes(agent.scope))
      .map((agent) => ({
        filename: agent.filename,
        scope: agent.scope,
        source: this.readActiveAgent(agent.filename),
      }));
  }

  readActiveAgent(filename) {
    const safeName = safeAgentFilename(filename);
    if (!this.activeRoute) throw new Error("No active beta route.");
    const worker = this.workers.get(this.activeRoute.compositionHash);
    const filePath = worker
      ? path.join(worker.agentDirectory, safeName)
      : path.join(
          this.compositionRoot,
          this.activeRoute.compositionHash,
          "agents",
          safeName,
        );
    if (!existsSync(filePath)) throw new Error(`Active agent not found: ${safeName}`);
    return readFileSync(filePath, "utf8");
  }

  async stop() {
    const workers = [...this.workers.values()];
    this.workers.clear();
    await Promise.allSettled(workers.map((worker) => worker.process.stop()));
    for (const worker of workers) {
      if (worker.retiredCompositionDirectory) {
        rmSync(worker.retiredCompositionDirectory, {
          recursive: true,
          force: true,
        });
      }
    }
  }
}

export const routeManagerInternals = {
  dryLoadAgentDirectory,
  routedContextMemoryMoltSource,
  safeAgentFilename,
  slugFromFilename,
  stackNameFromRappid,
  unpackedAsarPath,
  verifyMoltWithMolter,
};
