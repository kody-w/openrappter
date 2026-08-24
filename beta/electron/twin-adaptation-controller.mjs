import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

const SCHEMA = "rapp-twin-adaptation/1.0";
const SEGMENT = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const HASH = /^[a-f0-9]{64}$/;
const SIGNALS = new Set([
  "explicit_request",
  "explicit_correction",
  "tool_error",
  "schema_mismatch",
  "constant_output",
  "declared_no_data",
  "missing_binding",
  "health_failure",
]);
const RUNTIME_SIGNALS = new Set([
  "tool_error",
  "schema_mismatch",
  "constant_output",
  "declared_no_data",
  "missing_binding",
  "health_failure",
]);
const STATES = new Set([
  "observed",
  "diagnosed",
  "proposed",
  "staged",
  "shadow_verified",
  "approval_required",
  "activatable",
  "active",
  "healthy",
  "failed",
  "quarantined",
  "rolled_back",
]);
const NEXT = new Map([
  ["observed", new Set(["diagnosed", "failed"])],
  ["diagnosed", new Set(["proposed", "failed"])],
  ["proposed", new Set(["staged", "failed"])],
  ["staged", new Set(["shadow_verified", "failed"])],
  ["shadow_verified", new Set(["approval_required", "activatable", "failed"])],
  ["approval_required", new Set(["activatable", "failed"])],
  ["activatable", new Set(["active", "failed"])],
  ["active", new Set(["healthy", "failed"])],
  ["healthy", new Set(["observed", "failed"])],
  ["failed", new Set(["quarantined"])],
  ["quarantined", new Set(["rolled_back"])],
  ["rolled_back", new Set(["observed", "diagnosed"])],
]);
const PERMISSIONS = new Set([
  "read_local",
  "memory_read",
  "memory_write",
  "network",
  "data_source",
  "write_external",
  "send",
  "shell",
  "credential",
]);
const ELEVATED = new Set([
  "network",
  "data_source",
  "write_external",
  "send",
  "shell",
  "credential",
]);
const ACK_KEYS = new Set(["status", "message", "ready", "ack", "acknowledged"]);
const MAX_EVIDENCE = 32;
const MAX_EVENTS = 200;
const DEFAULT_WATCH_TURNS = 5;
const sleepCell = new Int32Array(new SharedArrayBuffer(4));

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(
      (key) => `${JSON.stringify(key)}:${canonical(value[key])}`,
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function nowIso() {
  return new Date().toISOString();
}

function slug(value) {
  const result = String(value || "capability")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .slice(0, 64);
  return SEGMENT.test(result) ? result : "capability";
}

function ensurePrivate(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  try { chmodSync(directory, 0o700); } catch {}
}

function assertNoSymlink(root, target) {
  const base = path.resolve(root);
  const resolved = path.resolve(target);
  if (resolved !== base && !resolved.startsWith(`${base}${path.sep}`)) {
    throw new Error("Adaptation path escapes its private root.");
  }
  let current = base;
  const relative = path.relative(base, resolved);
  for (const segment of relative ? relative.split(path.sep) : []) {
    current = path.join(current, segment);
    if (!existsSync(current)) continue;
    if (lstatSync(current).isSymbolicLink()) {
      throw new Error("Adaptation archives cannot traverse a symlink.");
    }
  }
}

function atomicWrite(filePath, bytes) {
  ensurePrivate(path.dirname(filePath));
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, bytes, { mode: 0o600, flag: "wx" });
    renameSync(temporary, filePath);
  } finally {
    try { rmSync(temporary, { force: true }); } catch {}
  }
}

function atomicJson(filePath, value) {
  atomicWrite(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function withFileLock(lockPath, callback) {
  const deadline = Date.now() + 5_000;
  let descriptor = null;
  while (descriptor === null) {
    try {
      descriptor = openSync(lockPath, "wx", 0o600);
      writeSync(descriptor, `${process.pid}\n`);
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw new Error("another adaptation is allocating a generation");
      }
      let stale = false;
      try {
        const owner = Number.parseInt(readFileSync(lockPath, "utf8"), 10);
        if (Number.isInteger(owner) && owner > 0) {
          try {
            process.kill(owner, 0);
          } catch (probeError) {
            stale = probeError?.code !== "EPERM";
          }
        } else {
          stale = Date.now() - statSync(lockPath).mtimeMs > 5_000;
        }
      } catch {
        stale = true;
      }
      if (stale) {
        try { unlinkSync(lockPath); } catch {}
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error("another adaptation is allocating a generation");
      }
      Atomics.wait(sleepCell, 0, 0, 25);
    }
  }
  try {
    return callback();
  } finally {
    closeSync(descriptor);
    try { unlinkSync(lockPath); } catch {}
  }
}

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function safePermissions(value) {
  const list = [...new Set((Array.isArray(value) ? value : []).map(String))].sort();
  if (list.some((item) => !PERMISSIONS.has(item))) {
    throw new Error("Candidate declares an unknown permission.");
  }
  return list;
}

function permissionDiff(previous = [], next = []) {
  const before = new Set(previous);
  const after = new Set(next);
  return {
    added: [...after].filter((item) => !before.has(item)).sort(),
    removed: [...before].filter((item) => !after.has(item)).sort(),
  };
}

function contractDigest(contract) {
  return sha256(canonical(contract));
}

function matchesSchema(value, schema) {
  if (!schema || typeof schema !== "object") return true;
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (schema.type) {
    const observed = value === null
      ? "null"
      : Array.isArray(value)
        ? "array"
        : typeof value === "number" && Number.isInteger(value)
          ? "integer"
          : typeof value;
    if (!types.includes(observed)
        && !(observed === "integer" && types.includes("number"))) {
      return false;
    }
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    if ((schema.required || []).some((key) => !Object.hasOwn(value, key))) {
      return false;
    }
    for (const [key, propertySchema] of Object.entries(schema.properties || {})) {
      if (Object.hasOwn(value, key) && !matchesSchema(value[key], propertySchema)) {
        return false;
      }
    }
  }
  if (Array.isArray(value) && schema.items) {
    return value.every((item) => matchesSchema(item, schema.items));
  }
  return true;
}

function validateContract(contract) {
  if (!contract || typeof contract !== "object" || Array.isArray(contract)) {
    throw new Error("A complete behavior contract is required.");
  }
  if (!String(contract.name || "").trim()) {
    throw new Error("Behavior contract needs a name.");
  }
  if (!contract.input_schema || typeof contract.input_schema !== "object") {
    throw new Error("Behavior contract needs input_schema.");
  }
  if (!contract.output_schema || typeof contract.output_schema !== "object") {
    throw new Error("Behavior contract needs output_schema.");
  }
  if (!Array.isArray(contract.cases) || contract.cases.length < 2
      || contract.cases.length > 20) {
    throw new Error("Behavior contract needs 2-20 bounded golden cases.");
  }
  for (const item of contract.cases) {
    if (!item || typeof item !== "object" || !String(item.id || "").trim()
        || !Object.hasOwn(item, "input") || !Object.hasOwn(item, "expect")) {
      throw new Error("Every behavior case needs id, input, and expect.");
    }
    if (!matchesSchema(item.input, contract.input_schema)) {
      throw new Error(`Behavior case ${item.id} does not match input_schema.`);
    }
  }
  return structuredClone(contract);
}

function looksLikeStaticAck(value) {
  let parsed = value;
  if (typeof parsed === "string") {
    try { parsed = JSON.parse(parsed); } catch { return false; }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
  const keys = Object.keys(parsed);
  return keys.length > 0 && keys.every((key) => ACK_KEYS.has(key))
    && ["ready", "ok", "accepted", "acknowledged"].includes(
      String(parsed.status || parsed.message || "").toLowerCase(),
    );
}

function verifyShadowResults(contract, results) {
  if (!Array.isArray(results) || results.length !== contract.cases.length) {
    return { ok: false, reason: "shadow runner did not return every contract case" };
  }
  const serialized = results.map((item) => canonical(item?.output));
  const allSame = new Set(serialized).size === 1;
  if (allSame && results.every((item) => looksLikeStaticAck(item?.output))) {
    return {
      ok: false,
      reason: "stub detector: meaningful inputs returned the same ready/ack envelope",
    };
  }
  for (let index = 0; index < results.length; index += 1) {
    const result = results[index];
    if (!result?.ok) {
      return {
        ok: false,
        reason: `contract case ${contract.cases[index].id} failed truthfully`,
      };
    }
    if (looksLikeStaticAck(result.output)) {
      return {
        ok: false,
        reason: `contract case ${contract.cases[index].id} returned a ready-only stub`,
      };
    }
    if (!matchesSchema(result.output, contract.output_schema)) {
      return {
        ok: false,
        reason: `contract case ${contract.cases[index].id} violates output_schema`,
      };
    }
  }
  return { ok: true };
}

function publicGeneration(generation) {
  if (!generation) return null;
  return structuredClone(generation);
}

export class TwinAdaptationController {
  constructor({
    root,
    twinKey,
    agentsDir,
    verifier = () => ({ ok: true }),
    shadowRunner = ({ contract }) => ({
      results: contract.cases.map((item) => ({
        ok: true,
        output: item.fixture_output ?? item.expect,
      })),
    }),
    loaderValidator = () => ({ ok: true }),
    healthRunner = null,
    autoActivateReadOnly = true,
    watchTurns = DEFAULT_WATCH_TURNS,
    clock = nowIso,
  } = {}) {
    if (!root || !twinKey || !agentsDir) {
      throw new Error("TwinAdaptationController needs root, twinKey, and agentsDir.");
    }
    this.root = path.resolve(root);
    this.twinKey = slug(twinKey);
    this.agentsDir = path.resolve(agentsDir);
    this.statePath = path.join(this.root, "adaptation.json");
    this.pointerPath = path.join(this.root, "ACTIVE.json");
    this.bindingPath = path.join(this.root, "memory-binding.json");
    this.verifier = verifier;
    this.shadowRunner = shadowRunner;
    this.loaderValidator = loaderValidator;
    this.healthRunner = typeof healthRunner === "function" ? healthRunner : null;
    this.autoActivateReadOnly = autoActivateReadOnly !== false;
    this.watchTurns = Math.max(1, Math.min(20, Number(watchTurns) || DEFAULT_WATCH_TURNS));
    this.clock = clock;
    if (existsSync(this.root) && lstatSync(this.root).isSymbolicLink()) {
      throw new Error("Twin adaptation root cannot be a symlink.");
    }
    ensurePrivate(this.root);
    this.state = this.#load();
    this.#reconcileArchivedGenerations();
  }

  #empty() {
    return {
      schema: SCHEMA,
      twin_key: this.twinKey,
      revision: 0,
      capabilities: {},
      memory_binding: {
        schema: "rapp-twin-memory-binding/1.0",
        namespace: `twin:${this.twinKey}:${sha256(this.twinKey).slice(0, 24)}`,
        recall: null,
        save: null,
        verified: false,
      },
      events: [],
    };
  }

  #load() {
    const current = readJson(this.statePath);
    if (current?.schema === SCHEMA && current.twin_key === this.twinKey) {
      return current;
    }
    const created = this.#empty();
    this.#save(created);
    return created;
  }

  #save(next = this.state) {
    next.revision = Number(next.revision || 0) + 1;
    next.events = (next.events || []).slice(-MAX_EVENTS);
    atomicJson(this.statePath, next);
    this.state = next;
  }

  #synchronize() {
    const current = readJson(this.statePath);
    if (current?.schema === SCHEMA && current.twin_key === this.twinKey
        && Number(current.revision || 0) > Number(this.state.revision || 0)) {
      this.state = current;
    }
  }

  #reconcileArchivedGenerations() {
      let changed = false;
      let capabilities = [];
      try {
        capabilities = readdirSync(path.join(this.root, "molts"), {
          withFileTypes: true,
        }).filter((item) => item.isDirectory());
      } catch {
        return;
      }
      for (const capability of capabilities) {
        let generations = [];
        try {
          generations = readdirSync(path.join(
            this.root,
            "molts",
            capability.name,
          ), { withFileTypes: true }).filter(
            (item) => item.isDirectory() && /^gen-\d+$/.test(item.name),
          );
        } catch {
          continue;
        }
        for (const directory of generations) {
          const meta = readJson(path.join(
            this.root,
            "molts",
            capability.name,
            directory.name,
            "molt.json",
          ));
          if (meta?.schema !== "rapp-twin-generation/1.0"
              || !HASH.test(String(meta.candidate_hash || ""))) {
            continue;
          }
          const entry = this.#entry(capability.name);
          if (entry.generations.some(
            (item) => item.candidate_hash === meta.candidate_hash,
          )) {
            continue;
          }
          entry.generations.push(meta);
          entry.generations.sort((left, right) => left.generation - right.generation);
          if (meta.verdict !== "verified") {
            entry.quarantine.push({
              candidate_hash: meta.candidate_hash,
              at: meta.created_at,
              lesson: "Recovered a quarantined generation after an interrupted stage.",
            });
          }
          try {
            this.#mirrorMolterGeneration(meta);
          } catch {
            entry.quarantine.push({
              candidate_hash: meta.candidate_hash,
              at: this.clock(),
              lesson: "Recovered archive could not reconcile with Molter state.",
            });
          }
          changed = true;
        }
      }
    if (changed) this.#save();
  }

  #entry(capability) {
    const key = slug(capability);
    const entry = this.state.capabilities[key] || {
      capability: key,
      state: null,
      evidence: [],
      diagnosis: null,
      proposal: null,
      generations: [],
      staged_hash: null,
      active_hash: null,
      last_known_good_hash: null,
      prior_active_hash: null,
      approval: null,
      quarantine: [],
      watch: null,
    };
    this.state.capabilities[key] = entry;
    return entry;
  }

  #event(capability, type, detail = {}) {
    this.state.events.push({
      at: this.clock(),
      capability: slug(capability),
      type,
      ...detail,
    });
  }

  #transition(entry, next, detail = {}) {
    if (!STATES.has(next)) throw new Error(`Unknown adaptation state ${next}.`);
    if (entry.state && !NEXT.get(entry.state)?.has(next)) {
      throw new Error(`Closed state machine refuses ${entry.state} -> ${next}.`);
    }
    entry.state = next;
    entry.updated_at = this.clock();
    this.#event(entry.capability, `state:${next}`, detail);
  }

  observe(capability, signal = {}) {
    this.#synchronize();
    const entry = this.#entry(capability);
    const type = String(signal.type || "");
    if (!SIGNALS.has(type)) throw new Error("Adaptation trigger is not a closed safe signal.");
    const explicit = type === "explicit_request" || type === "explicit_correction";
    const fingerprint = sha256(canonical({
      type,
      code: String(signal.code || "").slice(0, 80),
      tool: String(signal.tool || "").slice(0, 80),
    }));
    entry.evidence.push({
      at: this.clock(),
      type,
      fingerprint,
    });
    entry.evidence = entry.evidence.slice(-MAX_EVIDENCE);
    const repeated = entry.evidence.filter(
      (item) => item.type === type && item.fingerprint === fingerprint,
    ).length >= 2;
    if (!explicit && (!RUNTIME_SIGNALS.has(type) || !repeated)) {
      this.#event(capability, "evidence:bounded", { type, repeated: false });
      this.#save();
      return { accepted: false, reason: "runtime evidence must repeat before adaptation" };
    }
    if (entry.state === "healthy" || entry.state === "rolled_back") {
      this.#transition(entry, "observed", { trigger: type });
    } else if (!entry.state) {
      this.#transition(entry, "observed", { trigger: type });
    } else if (entry.state !== "observed") {
      throw new Error(`Adaptation is already ${entry.state}; it cannot free-run.`);
    }
    this.#save();
    return { accepted: true, state: entry.state };
  }

  diagnose(capability, inventory = {}) {
    this.#synchronize();
    const entry = this.#entry(capability);
    if (entry.state !== "observed") throw new Error("Diagnosis requires observed evidence.");
    const tools = [...new Set((inventory.tools || []).map(String))].sort();
    const requested = `${capability} ${inventory.request || ""}`.toLowerCase();
    const email = /\b(email|mail|outlook|inbox|message)\b/.test(requested);
    const memoryTools = tools.filter((name) => /memory|recall|remember/i.test(name));
    const hasDataPath = Boolean(inventory.has_data_path);
    const stub = Boolean(inventory.stub_detected);
    const workiq = (inventory.rar || []).find(
      (item) => [
        item.id,
        item.name,
        item.manifestName,
        item.manifest_name,
      ].some(
        (value) => String(value || "").toLowerCase() === "@kody-w/workiq",
      ),
    ) || (email ? {
      id: "@kody-w/workiq",
      sha256: inventory.workiq_sha256 || null,
      verified: true,
      permissions: ["network", "data_source", "credential"],
      mode: "read_only",
    } : null);
    const recommendation = email && workiq
      ? {
          strategy: "REUSE_BIND",
          capability_id: "@kody-w/workiq",
          catalog_id: workiq.id || "@kody-w/workiq",
          capability_hash: workiq.sha256
            || workiq.singletonSha256
            || workiq.singleton_sha256
            || null,
          mode: "read_only",
          reason: stub || !hasDataPath
            ? "The declared email capability has no verified data path; bind the existing WorkIQ reader instead of generating a duplicate."
            : "A verified read-only email capability already exists.",
        }
      : {
          strategy: hasDataPath ? "EXTEND" : "GENERATE",
          capability_id: null,
          capability_hash: null,
          mode: "least_privilege",
          reason: hasDataPath
            ? "The loaded capability has a proven data path but misses the requested behavior contract."
            : "No verified reusable capability was found; generation is the last resort.",
        };
    entry.diagnosis = {
      at: this.clock(),
      signals: {
        auth: String(inventory.auth || "unknown"),
        health: String(inventory.health || "unknown"),
        missing_binding: !hasDataPath,
        permissions_known: Array.isArray(inventory.permissions),
        stub,
      },
      tools,
      recommendation,
      memory: {
        bound: this.state.memory_binding.verified === true,
        loaded_tools: memoryTools,
        recommendation: memoryTools.length
          ? "VERIFY_EXISTING"
          : "BIND_EXISTING_MEMORY_AGENTS",
      },
    };
    this.#transition(entry, "diagnosed");
    this.#transition(entry, "proposed");
    entry.proposal = {
      ...recommendation,
      memory_binding: entry.diagnosis.memory.recommendation,
    };
    this.#save();
    return this.inspect(capability);
  }

  stage(capability, candidate = {}) {
    this.#synchronize();
    const entry = this.#entry(capability);
    if (entry.state !== "proposed") throw new Error("Staging requires a proposal.");
    const source = candidate.source == null ? null : String(candidate.source);
    const binding = candidate.binding && typeof candidate.binding === "object"
      ? structuredClone(candidate.binding)
      : null;
    if (!source && !binding) throw new Error("A source or pinned binding is required.");
    const contract = validateContract(candidate.behavior_contract);
    const permissions = safePermissions(candidate.permissions);
    if (permissions.includes("send") && candidate.send_approved !== true) {
      throw new Error("Email send/reply stays denied without a separate send approval.");
    }
    const active = this.#generation(entry, entry.active_hash);
    const baseHash = candidate.base_hash ?? entry.active_hash ?? null;
    if (baseHash !== (entry.active_hash ?? null)) {
      throw new Error("Stale base generation; diagnose against the current active head.");
    }
    const identity = sha256(canonical({
      base_hash: baseHash,
      behavior_contract: contract,
      binding,
      permissions,
      source_sha256: source ? sha256(source) : null,
    }));
    if (candidate.expected_hash && candidate.expected_hash !== identity) {
      throw new Error("Deterministic candidate identity does not match expected_hash.");
    }
    let archivedNumbers = [];
    try {
      archivedNumbers = readdirSync(
        path.join(this.root, "molts", entry.capability),
        { withFileTypes: true },
      ).filter(
        (item) => item.isDirectory() && /^gen-\d+$/.test(item.name),
      ).map((item) => Number.parseInt(item.name.slice(4), 10));
    } catch {}
    const generationNumber = Math.max(
      entry.generations.length - 1,
      ...archivedNumbers,
    ) + 1;
    const generationName = `gen-${String(generationNumber).padStart(3, "0")}`;
    const generationDirectory = path.join(
      this.root,
      "molts",
      entry.capability,
      generationName,
    );
    const sourceHash = source ? sha256(source) : null;
    const verification = source
      ? this.verifier(source, { binding, contract, permissions })
      : { ok: binding?.verified === true };
    const generation = {
      schema: "rapp-twin-generation/1.0",
      capability: entry.capability,
      generation: generationNumber,
      generation_name: generationName,
      candidate_hash: identity,
      source_sha256: sourceHash,
      sha256: sourceHash,
      base_hash: baseHash,
      parent: active?.generation ?? null,
      kind: binding ? "reuse_binding" : "adaptation",
      verdict: "pending",
      activation: "staged",
      detail: {
        tool_name: String(candidate.tool_name || entry.capability).slice(0, 120),
      },
      behavior_contract: contract,
      behavior_contract_hash: contractDigest(contract),
      permissions,
      binding,
      verification: {
        ast_import_smoke: verification?.ok === true,
        detail: String(verification?.error || verification?.reason || "verified").slice(0, 400),
      },
      created_at: this.clock(),
    };
    generation.permission_diff = permissionDiff(
      active?.permissions || [],
      permissions,
    );
    entry.generations.push(generation);
    entry.staged_hash = identity;
    entry.approval = null;
    this.#transition(entry, "staged", { candidate_hash: identity });
    if (verification?.ok !== true) {
      generation.verdict = "catastrophic";
      generation.activation = "quarantined";
      this.#archiveGeneration(generationDirectory, generation, source);
      this.#mirrorMolterGeneration(generation);
      this.#fail(entry, generation, `static/import/smoke verification failed: ${generation.verification.detail}`);
      try {
        this.#rollbackFailed(entry);
      } catch (error) {
        entry.quarantine.push({
          candidate_hash: generation.candidate_hash,
          at: this.clock(),
          lesson: `rollback failed closed: ${String(error?.message || error).slice(0, 300)}`,
        });
      }
      this.#save();
      return this.inspect(capability);
    }
    let shadow;
    try {
      shadow = this.shadowRunner({
        binding,
        contract: structuredClone(contract),
        permissions: [...permissions],
        source,
      });
    } catch (error) {
      shadow = { ok: false, reason: String(error?.message || error) };
    }
    const shadowGate = shadow?.ok === false
      ? shadow
      : verifyShadowResults(contract, shadow?.results);
    generation.shadow = {
      ok: shadowGate.ok === true,
      reason: String(shadowGate.reason || "verified").slice(0, 400),
    };
    generation.verdict = generation.shadow.ok ? "verified" : "catastrophic";
    generation.activation = generation.shadow.ok ? "staged" : "quarantined";
    this.#archiveGeneration(generationDirectory, generation, source);
    this.#mirrorMolterGeneration(generation);
    writeFileSync(
      path.join(generationDirectory, "shadow.json"),
      `${JSON.stringify(generation.shadow, null, 2)}\n`,
      { mode: 0o400, flag: "wx" },
    );
    if (!generation.shadow.ok) {
      this.#fail(entry, generation, `shadow verification failed: ${generation.shadow.reason}`);
      this.#rollbackFailed(entry);
      this.#save();
      return this.inspect(capability);
    }
    this.#transition(entry, "shadow_verified", { candidate_hash: identity });
    const diff = generation.permission_diff;
    const elevated = diff.added.some((item) => ELEVATED.has(item));
    const auto = this.autoActivateReadOnly && !elevated;
    this.#transition(entry, auto ? "activatable" : "approval_required", {
      candidate_hash: identity,
      permission_diff: diff,
    });
    this.#save();
    return this.inspect(capability);
  }

  approve(capability, approval = {}) {
    this.#synchronize();
    const entry = this.#entry(capability);
    if (entry.state !== "approval_required") {
      throw new Error("This candidate is not waiting for approval.");
    }
    const generation = this.#generation(entry, entry.staged_hash);
    if (approval.actor !== "human-ui" || approval.action_bound !== true) {
      throw new Error("Agents and semantic controls cannot approve elevated permissions.");
    }
    if (approval.candidate_hash !== generation.candidate_hash
        || approval.contract_hash !== generation.behavior_contract_hash
        || (approval.base_hash ?? null) !== (generation.base_hash ?? null)
        || canonical(approval.permission_diff) !== canonical(generation.permission_diff)) {
      throw new Error("Approval is stale or not bound to this exact candidate.");
    }
    entry.approval = {
      actor: "human-ui",
      at: this.clock(),
      candidate_hash: generation.candidate_hash,
      contract_hash: generation.behavior_contract_hash,
      base_hash: generation.base_hash,
      permission_diff: generation.permission_diff,
    };
    this.#transition(entry, "activatable", { approved: true });
    this.#save();
    return this.inspect(capability);
  }

  activate(capability, candidateHash) {
    this.#synchronize();
    const entry = this.#entry(capability);
    if (entry.state !== "activatable") throw new Error("Candidate is not activatable.");
    const generation = this.#generation(entry, candidateHash);
    if (!generation || generation.candidate_hash !== entry.staged_hash) {
      throw new Error("Activation requires the exact staged generation hash.");
    }
    if (generation.permission_diff?.added.some((item) => ELEVATED.has(item))
        && entry.approval?.candidate_hash !== generation.candidate_hash) {
      throw new Error("Elevated permission activation requires exact human approval.");
    }
    const previousHash = entry.active_hash;
    let materialized = false;
    try {
      if (!previousHash) this.#captureBaseline(entry, generation);
      this.#materialize(generation);
      materialized = true;
      const loaded = this.loaderValidator({
        agentsDir: this.agentsDir,
        generation: publicGeneration(generation),
      });
      if (loaded?.ok !== true) throw new Error(loaded?.error || "fresh loader validation failed");
      entry.prior_active_hash = previousHash;
      entry.active_hash = generation.candidate_hash;
      entry.last_known_good_hash = previousHash || entry.last_known_good_hash;
      this.#transition(entry, "active", { candidate_hash: generation.candidate_hash });
      let health;
      if (this.healthRunner) {
        health = this.healthRunner({
          contract: structuredClone(generation.behavior_contract),
          generation: publicGeneration(generation),
        });
      } else {
        const probe = this.shadowRunner({
          binding: structuredClone(generation.binding),
          contract: structuredClone(generation.behavior_contract),
          permissions: [...generation.permissions],
          source: this.#safeArchiveSource(generation)?.toString("utf8") || null,
        });
        health = probe?.ok === false
          ? probe
          : verifyShadowResults(generation.behavior_contract, probe?.results);
      }
      if (health?.ok !== true) throw new Error(health?.error || "post-activation probe failed");
      entry.last_known_good_hash = generation.candidate_hash;
      entry.watch = {
        remaining_turns: this.watchTurns,
        errors: 0,
        started_at: this.clock(),
      };
      this.#transition(entry, "healthy", { watch_turns: this.watchTurns });
      this.#writePointer(entry, generation);
      this.#setMolterLive(entry, generation);
      this.#save();
      return this.inspect(capability);
    } catch (error) {
      this.#fail(entry, generation, String(error?.message || error));
      if (materialized) {
        try {
          this.#rollbackFailed(entry);
        } catch (rollbackError) {
          entry.quarantine.push({
            candidate_hash: generation.candidate_hash,
            at: this.clock(),
            lesson: `rollback failed closed: ${String(
              rollbackError?.message || rollbackError,
            ).slice(0, 300)}`,
          });
        }
      } else {
        entry.staged_hash = null;
        entry.approval = null;
        this.#transition(entry, "rolled_back", {
          restored_hash: previousHash || null,
          materialized: false,
        });
      }
      this.#save();
      return this.inspect(capability);
    }
  }

  rollback(capability, reason = "user requested rollback") {
    this.#synchronize();
    const entry = this.#entry(capability);
    const current = this.#generation(entry, entry.active_hash);
    if (!current && entry.state !== "quarantined") {
      throw new Error("There is no active generation to roll back.");
    }
    if (entry.state !== "failed" && entry.state !== "quarantined") {
      this.#transition(entry, "failed", { reason: String(reason).slice(0, 200) });
      if (current) {
        entry.quarantine.push({
          candidate_hash: current.candidate_hash,
          at: this.clock(),
          lesson: String(reason).slice(0, 400),
        });
      }
      this.#transition(entry, "quarantined");
    } else if (entry.state === "failed") {
      this.#transition(entry, "quarantined");
    }
    try {
      this.#rollbackFailed(entry);
    } catch (error) {
      entry.quarantine.push({
        candidate_hash: current?.candidate_hash || entry.staged_hash,
        at: this.clock(),
        lesson: `rollback failed closed: ${String(error?.message || error).slice(0, 300)}`,
      });
    }
    this.#save();
    return this.inspect(capability);
  }

  recordRuntime(capability, signal = {}) {
    this.#synchronize();
    const entry = this.#entry(capability);
    if (entry.state !== "healthy" || !entry.watch) return this.inspect(capability);
    if (entry.watch.remaining_turns <= 0) {
      entry.watch = null;
      this.#save();
      return this.inspect(capability);
    }
    const type = String(signal.type || "");
    if (!RUNTIME_SIGNALS.has(type)) {
      entry.watch.remaining_turns = Math.max(0, entry.watch.remaining_turns - 1);
      if (entry.watch.remaining_turns === 0) entry.watch = null;
      this.#save();
      return this.inspect(capability);
    }
    entry.watch.errors += 1;
    this.#transition(entry, "failed", { trigger: type });
    const generation = this.#generation(entry, entry.active_hash);
    if (generation) {
      entry.quarantine.push({
        candidate_hash: generation.candidate_hash,
        at: this.clock(),
        lesson: `first-turn watch detected ${type}`,
      });
    }
    this.#transition(entry, "quarantined");
    try {
      this.#rollbackFailed(entry);
    } catch (error) {
      entry.quarantine.push({
        candidate_hash: generation?.candidate_hash || entry.staged_hash,
        at: this.clock(),
        lesson: `rollback failed closed: ${String(error?.message || error).slice(0, 300)}`,
      });
    }
    this.#save();
    return this.inspect(capability);
  }

  bindMemory({ recall, save, verified = false } = {}) {
    this.#synchronize();
    this.state.memory_binding = {
      ...this.state.memory_binding,
      recall: recall ? String(recall) : null,
      save: save ? String(save) : null,
      verified: verified === true && Boolean(recall && save),
      updated_at: this.clock(),
    };
    atomicJson(this.bindingPath, this.state.memory_binding);
    this.#event("memory", "memory-binding", {
      verified: this.state.memory_binding.verified,
    });
    this.#save();
    return structuredClone(this.state.memory_binding);
  }

  rehydrate() {
    this.#synchronize();
    const pointer = readJson(this.pointerPath);
    const heads = pointer?.schema === "rapp-twin-active-pointer/2.0"
      ? Object.values(pointer.heads || {})
      : (pointer?.candidate_hash ? [pointer] : []);
    if (!heads.length) {
      return { ok: true, restored: [] };
    }
    const restored = [];
    const fileSnapshots = new Map();
    const memorySnapshot = structuredClone(this.state.memory_binding);
    try {
      for (const head of heads) {
        if (!HASH.test(String(head?.candidate_hash || ""))) {
          throw new Error("active pointer has an invalid candidate hash");
        }
        const entry = Object.values(this.state.capabilities).find(
          (item) => item.capability === head.capability
            && item.active_hash === head.candidate_hash
            && ["healthy", "rolled_back"].includes(item.state),
        );
        const generation = entry && this.#generation(entry, head.candidate_hash);
        if (!generation || generation.source_sha256 !== head.source_sha256) {
          throw new Error("active pointer has no healthy generation");
        }
        if (generation.source_sha256) {
          const filename = `${slug(generation.capability).replaceAll("-", "_")}_agent.py`;
          const destination = path.join(this.agentsDir, filename);
          if (!fileSnapshots.has(destination)) {
            if (existsSync(destination)) {
              const stat = lstatSync(destination);
              if (stat.isSymbolicLink() || !stat.isFile()) {
                throw new Error("rehydration target is not an ordinary file");
              }
              fileSnapshots.set(destination, readFileSync(destination));
            } else {
              fileSnapshots.set(destination, null);
            }
          }
        }
        this.#materialize(generation);
        restored.push(generation.candidate_hash);
      }
      const loaded = this.loaderValidator({
        agentsDir: this.agentsDir,
        generations: heads,
      });
      if (loaded?.ok !== true) throw new Error(loaded?.error || "loader validation failed");
      return { ok: true, restored };
    } catch (error) {
      for (const [destination, bytes] of fileSnapshots) {
        if (bytes === null) rmSync(destination, { force: true });
        else atomicWrite(destination, bytes);
      }
      this.state.memory_binding = memorySnapshot;
      atomicJson(this.bindingPath, memorySnapshot);
      const head = heads.find((item) => !restored.includes(item.candidate_hash))
        || heads.at(-1);
      const entry = Object.values(this.state.capabilities).find(
        (item) => item.capability === head?.capability,
      );
      const generation = entry && this.#generation(entry, head?.candidate_hash);
      if (!entry || !generation) {
        return { ok: false, restored: [], reason: String(error?.message || error) };
      }
      this.#transition(entry, "failed", { reason: "restart rehydration failed" });
      entry.quarantine.push({
        candidate_hash: generation.candidate_hash,
        at: this.clock(),
        lesson: String(error?.message || error).slice(0, 400),
      });
      this.#transition(entry, "quarantined");
      this.#rollbackFailed(entry);
      this.#save();
      return { ok: false, restored: [], reason: String(error?.message || error) };
    }
  }

  inspect(capability = null) {
    this.#synchronize();
    if (capability) {
      const entry = this.#entry(capability);
      return {
        schema: SCHEMA,
        twin_key: this.twinKey,
        memory_binding: structuredClone(this.state.memory_binding),
        capability: {
          ...structuredClone(entry),
          generations: entry.generations.map(publicGeneration),
        },
      };
    }
    return {
      schema: SCHEMA,
      twin_key: this.twinKey,
      memory_binding: structuredClone(this.state.memory_binding),
      capabilities: Object.fromEntries(
        Object.entries(this.state.capabilities).map(([key, entry]) => [
          key,
          {
            capability: key,
            state: entry.state,
            staged_hash: entry.staged_hash,
            active_hash: entry.active_hash,
            last_known_good_hash: entry.last_known_good_hash,
            diagnosis: structuredClone(entry.diagnosis),
            proposal: structuredClone(entry.proposal),
            generations: entry.generations.map(publicGeneration),
            quarantine: structuredClone(entry.quarantine),
            watch: structuredClone(entry.watch),
          },
        ]),
      ),
    };
  }

  #archiveGeneration(directory, generation, source) {
    assertNoSymlink(this.root, path.dirname(directory));
    ensurePrivate(path.dirname(directory));
    try {
      mkdirSync(directory, { mode: 0o700 });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      if (lstatSync(directory).isSymbolicLink()) {
        throw new Error("Immutable generation slot is a symlink.");
      }
      const existing = readJson(path.join(directory, "molt.json"));
      if (existing?.candidate_hash !== generation.candidate_hash) {
        throw new Error("Immutable generation slot already contains different bytes.");
      }
      return;
    }
    try {
      if (source) writeFileSync(path.join(directory, "agent.py"), source, { mode: 0o400, flag: "wx" });
      writeFileSync(
        path.join(directory, "molt.json"),
        `${JSON.stringify(generation, null, 2)}\n`,
        { mode: 0o400, flag: "wx" },
      );
    } catch (error) {
      rmSync(directory, { recursive: true, force: true });
      throw error;
    }
  }

  #generation(entry, hash) {
    return hash
      ? entry.generations.find((item) => item.candidate_hash === hash) || null
      : null;
  }

  #mirrorMolterGeneration(generation) {
    const statePath = path.join(this.root, "state.json");
    withFileLock(path.join(this.root, ".state.lock"), () => {
      const state = readJson(statePath, { capabilities: {} });
      if (!state.capabilities || typeof state.capabilities !== "object") {
        state.capabilities = {};
      }
      const entry = state.capabilities[generation.capability] || {
        live_generation: null,
        molts: [],
        quarantine: [],
      };
      while (entry.molts.length < generation.generation) {
        const missingNumber = entry.molts.length;
        const archived = readJson(path.join(
          this.root,
          "molts",
          generation.capability,
          `gen-${String(missingNumber).padStart(3, "0")}`,
          "molt.json",
        ));
        if (!archived || archived.generation !== missingNumber) {
          throw new Error("Molter generation history has a missing immutable slot.");
        }
        entry.molts.push(archived);
      }
      const existing = entry.molts[generation.generation];
      if (existing && existing.sha256 !== generation.sha256) {
        throw new Error("Molter generation replay has a different content hash.");
      }
      if (!existing) entry.molts.push(structuredClone(generation));
      if (generation.verdict !== "verified") {
        entry.quarantine = [...(entry.quarantine || []), {
          generation: generation.generation,
          sha256: generation.sha256,
          at: generation.created_at,
          lesson: generation.verification.detail,
        }].slice(-100);
      }
      state.capabilities[generation.capability] = entry;
      atomicJson(statePath, state);
    });
  }

  #setMolterLive(entry, generation) {
    const statePath = path.join(this.root, "state.json");
    withFileLock(path.join(this.root, ".state.lock"), () => {
      const state = readJson(statePath, { capabilities: {} });
      const capability = state.capabilities?.[entry.capability];
      if (!capability || capability.molts?.[generation.generation]?.sha256
          !== generation.sha256) {
        throw new Error("Molter state does not contain the exact generation.");
      }
      capability.prior_live_generation = capability.live_generation ?? null;
      capability.live_generation = generation.generation;
      capability.last_known_good_generation = generation.generation;
      capability.activated_generations = [
        ...new Set([
          ...(capability.activated_generations || []),
          generation.generation,
        ]),
      ].sort((left, right) => left - right);
      capability.live_file = generation.live_file || null;
      capability.live_tool = generation.detail?.tool_name || entry.capability;
      capability.live_sha256 = generation.source_sha256;
      atomicJson(statePath, state);
    });
  }

  #writePointer(entry, generation) {
    const current = readJson(this.pointerPath, {});
    const heads = current?.schema === "rapp-twin-active-pointer/2.0"
      ? { ...(current.heads || {}) }
      : {};
    if (current?.candidate_hash && current.capability) {
      heads[current.capability] = {
        capability: current.capability,
        candidate_hash: current.candidate_hash,
        source_sha256: current.source_sha256,
        behavior_contract_hash: current.behavior_contract_hash,
        permissions: current.permissions || [],
      };
    }
    heads[entry.capability] = {
      capability: entry.capability,
      candidate_hash: generation.candidate_hash,
      source_sha256: generation.source_sha256,
      behavior_contract_hash: generation.behavior_contract_hash,
      permissions: generation.permissions,
    };
    atomicJson(this.pointerPath, {
      schema: "rapp-twin-active-pointer/2.0",
      heads,
    });
  }

  #removePointer(capability) {
    const current = readJson(this.pointerPath, {});
    const heads = current?.schema === "rapp-twin-active-pointer/2.0"
      ? { ...(current.heads || {}) }
      : {};
    if (current?.candidate_hash && current.capability !== capability) {
      heads[current.capability] = current;
    }
    delete heads[capability];
    if (Object.keys(heads).length) {
      atomicJson(this.pointerPath, {
        schema: "rapp-twin-active-pointer/2.0",
        heads,
      });
    } else {
      rmSync(this.pointerPath, { force: true });
    }
  }

  #safeArchiveSource(generation) {
    if (!generation.source_sha256) return null;
    const sourcePath = path.join(
      this.root,
      "molts",
      generation.capability,
      generation.generation_name,
      "agent.py",
    );
    const expectedRoot = path.join(this.root, "molts") + path.sep;
    const resolved = path.resolve(sourcePath);
    if (!resolved.startsWith(expectedRoot)) throw new Error("Generation path escapes the archive.");
    const stat = lstatSync(resolved);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error("Generation source must be an ordinary immutable file.");
    }

    const source = readFileSync(resolved);
    if (sha256(source) !== generation.source_sha256) {
      throw new Error("Archived generation hash is tampered.");
    }
    return source;
  }

  #captureBaseline(entry, generation) {
    if (entry.baseline) return;
    const baselineDirectory = path.join(
      this.root,
      "baselines",
      entry.capability,
    );
    assertNoSymlink(this.root, baselineDirectory);
    ensurePrivate(baselineDirectory);
    const filename = generation.source_sha256
      ? `${slug(generation.capability).replaceAll("-", "_")}_agent.py`
      : null;
    const livePath = filename ? path.join(this.agentsDir, filename) : null;
    let sourceSha256 = null;
    if (livePath && existsSync(livePath)) {
      const stat = lstatSync(livePath);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new Error("Existing live capability baseline is not an ordinary file.");
      }
      const source = readFileSync(livePath);
      sourceSha256 = sha256(source);
      const archived = path.join(baselineDirectory, "agent.py");
      if (!existsSync(archived)) {
        writeFileSync(archived, source, { mode: 0o400, flag: "wx" });
      }
    }
    entry.baseline = {
      schema: "rapp-twin-adaptation-baseline/1.0",
      filename,
      source_sha256: sourceSha256,
      memory_binding: structuredClone(this.state.memory_binding),
      captured_at: this.clock(),
    };
    const metaPath = path.join(baselineDirectory, "baseline.json");
    if (!existsSync(metaPath)) {
      writeFileSync(
        metaPath,
        `${JSON.stringify(entry.baseline, null, 2)}\n`,
        { mode: 0o400, flag: "wx" },
      );
    }
    this.#save();
  }

  #restoreBaseline(entry, failed) {
    const baseline = entry.baseline;
    const filename = baseline?.filename
      || failed?.live_file
      || (failed?.source_sha256
        ? `${slug(entry.capability).replaceAll("-", "_")}_agent.py`
        : null);
    if (filename) {
      const destination = path.join(this.agentsDir, filename);
      if (baseline?.source_sha256) {
        const archived = path.join(
          this.root,
          "baselines",
          entry.capability,
          "agent.py",
        );
        const source = readFileSync(archived);
        if (sha256(source) !== baseline.source_sha256) {
          throw new Error("Pre-adaptation baseline hash is tampered.");
        }
        atomicWrite(destination, source);
      } else {
        rmSync(destination, { force: true });
      }
    }
    if (baseline?.memory_binding) {
      this.state.memory_binding = structuredClone(baseline.memory_binding);
      atomicJson(this.bindingPath, this.state.memory_binding);
    }
    entry.active_hash = null;
    this.#removePointer(entry.capability);
  }

  #materialize(generation) {
    if (generation.binding?.memory) {
      this.bindMemory(generation.binding.memory);
    }
    const source = this.#safeArchiveSource(generation);
    if (!source) return;
    ensurePrivate(this.agentsDir);
    const filename = `${slug(generation.capability).replaceAll("-", "_")}_agent.py`;
    const destination = path.join(this.agentsDir, filename);
    atomicWrite(destination, source);
    generation.live_file = filename;
  }

  #fail(entry, generation, reason) {
    this.#transition(entry, "failed", { reason: String(reason).slice(0, 400) });
    entry.quarantine.push({
      candidate_hash: generation?.candidate_hash || entry.staged_hash,
      at: this.clock(),
      lesson: String(reason).slice(0, 400),
    });
    this.#transition(entry, "quarantined");
  }

  #rollbackFailed(entry) {
    const failed = this.#generation(entry, entry.active_hash || entry.staged_hash);
    const targetHash = entry.prior_active_hash
      || (entry.last_known_good_hash !== failed?.candidate_hash
        ? entry.last_known_good_hash
        : null);
    const target = this.#generation(entry, targetHash);
    let restored = false;
    try {
      if (target) {
        this.#materialize(target);
        entry.active_hash = target.candidate_hash;
        entry.last_known_good_hash = target.candidate_hash;
        this.#writePointer(entry, target);
        this.#setMolterLive(entry, target);
      } else {
        this.#restoreBaseline(entry, failed);
        const statePath = path.join(this.root, "state.json");
        withFileLock(path.join(this.root, ".state.lock"), () => {
          const state = readJson(statePath, { capabilities: {} });
          const capability = state.capabilities?.[entry.capability];
          if (capability) {
            capability.live_generation = null;
            capability.live_file = null;
            capability.live_tool = null;
            capability.live_sha256 = null;
            atomicJson(statePath, state);
          }
        });
      }
      restored = true;
    } finally {
      entry.staged_hash = null;
      entry.approval = null;
      entry.watch = null;
      if (restored) {
        this.#transition(entry, "rolled_back", { restored_hash: targetHash || null });
      }
    }
  }
}

export function tester123EmailContract() {
  return {
    name: "read_only_email",
    input_schema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
    output_schema: {
      type: "object",
      required: ["status"],
      properties: {
        status: {
          type: "string",
          enum: ["success", "no_data", "auth_required", "unavailable"],
        },
        messages: { type: "array" },
      },
    },
    cases: [
      {
        id: "provider-has-mail",
        input: { query: "latest email", provider_fixture: "has_data" },
        expect: { status: "success", minimum_messages: 1 },
        fixture_output: {
          status: "success",
          messages: [{
            id: "fixture-1",
            subject: "Quarterly planning",
            from: "sender@example.invalid",
            received_at: "2026-01-01T12:00:00Z",
          }],
        },
      },
      {
        id: "provider-no-mail",
        input: { query: "email from nobody", provider_fixture: "no_data" },
        expect: { status: "no_data" },
        fixture_output: { status: "no_data", messages: [] },
      },
      {
        id: "provider-auth-missing",
        input: { query: "latest email", provider_fixture: "auth_required" },
        expect: { status: "auth_required" },
        fixture_output: { status: "auth_required", messages: [] },
      },
    ],
  };
}

export const twinAdaptationInternals = {
  canonical,
  looksLikeStaticAck,
  permissionDiff,
  sha256,
  slug,
  validateContract,
  verifyShadowResults,
};
