/**
 * Transactional hot import for user-supplied agents.
 *
 * A candidate is written to a private, exclusively-created staging file beside
 * its target, validated from there, and only then atomically renamed into
 * place. The live file and registry are one generation: if activation fails,
 * both are restored before the importer reports failure.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

import {
  ensureFlightRecorderFromEnv,
  getFlightRecorder,
} from "../flight-recorder/recorder.js";
import type { FlightEvent } from "../flight-recorder/types.js";
import { openrappterPath } from "../infra/openrappter-home.js";
import { markAgentSourceFile, type AgentRegistry } from "./AgentRegistry.js";
import {
  BasicAgent,
  canonicalAgentSourcePath,
  withAgentSourceWriteLock,
} from "./BasicAgent.js";
import { PythonAgent, runnerPath } from "./PythonAgent.js";

export interface AgentImportProvenance {
  traceId: string;
  scenarioNonce: string;
  requestId: string;
  candidateSourceSha256: string;
  gatewayParentEventId: string;
}

const provenanceStorage = new AsyncLocalStorage<AgentImportProvenance>();

export function withAgentImportProvenance<T>(
  provenance: AgentImportProvenance,
  operation: () => Promise<T>,
): Promise<T> {
  return provenanceStorage.run({ ...provenance }, operation);
}

export type AgentImportCommitState =
  | "not-committed"
  | "committed"
  | "restored"
  | "unknown";

export interface ImportResult {
  status: "ok" | "error";
  /** What the organism can now do — the capability names, not the filename. */
  learned?: { name: string; description: string }[];
  file?: string;
  error?: string;
  /** True when an existing agent owned by this same file was replaced. */
  replaced?: boolean;
  /** True only when the candidate is the active on-disk generation. */
  committed?: boolean;
  /** Distinguishes a validation refusal from a post-commit activation failure. */
  rejectedBeforeCommit?: boolean;
  candidateSourceSha256?: string;
  activeSourceSha256?: string;
  errorCode?: string;
  /** Durable candidate disposition; use with `retrySafe`, not `status` alone. */
  commitState: AgentImportCommitState;
  /** True only when submitting the same candidate again cannot overwrite a commit. */
  retrySafe: boolean;
  /** Non-secret operator guidance for a successful commit needing cleanup. */
  warning?: string;
}

type ImportRegistry = Pick<AgentRegistry, "reloadUserAgents" | "getAllAgents">;

interface CandidateAgent {
  name: string;
  description: string;
  parameters: unknown;
}

interface CandidateValidation {
  ok: true;
  agents: CandidateAgent[];
  bridgeClass: string;
  instances?: Map<string, BasicAgent>;
}

interface CandidateRejection {
  ok: false;
  error: string;
}

interface ImportOutcome {
  result: ImportResult;
  agentName?: string;
  bridgeClass?: string;
}

interface PreviousGeneration {
  bytes: Buffer | null;
  sourceSha256?: string;
  owned: Map<string, BasicAgent>;
}

/** Base-class filenames that are scaffolding, not capabilities. */
const PROTECTED = new Set([
  "basic_agent.py",
  "BasicAgent.ts",
  "BasicAgent.js",
  "__init__.py",
]);

const PYTHON_STAGE_SUFFIX = ".py.stage";
const targetLocks = new Map<string, Promise<void>>();
/** Registry mutations share a namespace even when target files differ. */
const registryLocks = new WeakMap<ImportRegistry, Promise<void>>();

/**
 * Filename sanitiser.
 *
 * A dropped name is attacker-controlled in the general case, so it is reduced
 * to a leaf name and a conservative character set before it is ever joined to
 * a directory. `..` and separators cannot survive this.
 */
export function safeAgentFilename(raw: string): string {
  const leaf = path.basename(raw).replace(/[^A-Za-z0-9._-]/g, "_");
  return leaf.replace(/^\.+/, "") || "agent.py";
}

/** Where user agents live. Matches the registry's default. */
export function userAgentsDir(): string {
  return openrappterPath("agents");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function systemErrorCode(error: unknown): string | undefined {
  if (!isRecord(error)) return undefined;
  const code = error.code;
  return typeof code === "string" ? code : undefined;
}

function errorDescription(error: unknown): string {
  if (error instanceof AggregateError) {
    const details = Array.from(error.errors, (entry) =>
      errorDescription(entry),
    ).join("; ");
    return details ? `${error.message}: ${details}` : error.message;
  }
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  return String(error);
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function readIfExists(file: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(file);
  } catch (error) {
    if (systemErrorCode(error) === "ENOENT") return null;
    throw error;
  }
}

function sameFilePath(left: string, right: string): boolean {
  return canonicalAgentSourcePath(left) === canonicalAgentSourcePath(right);
}

function sourceFileOf(agent: BasicAgent): string | undefined {
  if (agent instanceof PythonAgent) {
    return canonicalAgentSourcePath(agent.sourceFile);
  }
  const marker = Object.getOwnPropertyDescriptor(agent, "sourceFile");
  if (
    !marker ||
    marker.enumerable ||
    marker.writable ||
    marker.configurable ||
    typeof marker.value !== "string"
  ) {
    return undefined;
  }
  return canonicalAgentSourcePath(marker.value);
}

function uniqueAgentNames(agents: CandidateAgent[]): string[] {
  return [...new Set(agents.map((agent) => agent.name))];
}

function failureOutcome(options: {
  candidateSourceSha256: string;
  error: string;
  errorCode: string;
  rejectedBeforeCommit: boolean;
  committed?: boolean;
  activeSourceSha256?: string;
  agentName?: string;
  commitState?: AgentImportCommitState;
  retrySafe?: boolean;
}): ImportOutcome {
  const commitState =
    options.commitState ??
    (options.rejectedBeforeCommit
      ? "not-committed"
      : options.committed
        ? "committed"
        : "unknown");
  const retrySafe = options.retrySafe ?? options.rejectedBeforeCommit;
  return {
    result: {
      status: "error",
      error: options.error,
      errorCode: options.errorCode,
      committed: options.committed ?? false,
      rejectedBeforeCommit: options.rejectedBeforeCommit,
      commitState,
      retrySafe,
      candidateSourceSha256: options.candidateSourceSha256,
      ...(options.activeSourceSha256 === undefined
        ? {}
        : { activeSourceSha256: options.activeSourceSha256 }),
    },
    ...(options.agentName === undefined
      ? {}
      : { agentName: options.agentName }),
  };
}

function committedOutcome(options: {
  candidate: CandidateValidation;
  candidateSourceSha256: string;
  filename: string;
  previous: PreviousGeneration;
  warning?: string;
  errorCode?: string;
}): ImportOutcome {
  return {
    result: {
      status: "ok",
      file: options.filename,
      replaced: options.previous.owned.size > 0,
      committed: true,
      rejectedBeforeCommit: false,
      commitState: "committed",
      retrySafe: false,
      candidateSourceSha256: options.candidateSourceSha256,
      activeSourceSha256: options.candidateSourceSha256,
      learned: options.candidate.agents.map(({ name, description }) => ({
        name,
        description,
      })),
      ...(options.warning === undefined ? {} : { warning: options.warning }),
      ...(options.errorCode === undefined
        ? {}
        : { errorCode: options.errorCode }),
    },
    agentName: options.candidate.agents[0]?.name,
    bridgeClass: options.candidate.bridgeClass,
  };
}

async function withTargetLock<T>(
  target: string,
  operation: () => Promise<T>,
): Promise<T> {
  const predecessor = targetLocks.get(target);
  let release = (): void => {};
  const lock = new Promise<void>((resolve) => {
    release = resolve;
  });
  targetLocks.set(target, lock);

  if (predecessor) await predecessor;
  try {
    return await operation();
  } finally {
    release();
    if (targetLocks.get(target) === lock) {
      targetLocks.delete(target);
    }
  }
}

async function withRegistryLock<T>(
  registry: ImportRegistry,
  operation: () => Promise<T>,
): Promise<T> {
  const predecessor = registryLocks.get(registry);
  let release = (): void => {};
  const lock = new Promise<void>((resolve) => {
    release = resolve;
  });
  registryLocks.set(registry, lock);

  if (predecessor) await predecessor;
  try {
    return await operation();
  } finally {
    release();
    if (registryLocks.get(registry) === lock) {
      registryLocks.delete(registry);
    }
  }
}

async function createPrivateStage(
  target: string,
  contents: Buffer,
  javascript: boolean,
): Promise<string> {
  const directory = path.dirname(target);
  const suffix = javascript ? ".js" : PYTHON_STAGE_SUFFIX;

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const stage = path.join(
      directory,
      `.agent-import-${randomUUID()}${suffix}`,
    );
    let handle: Awaited<ReturnType<typeof fs.open>>;
    try {
      handle = await fs.open(stage, "wx", 0o600);
    } catch (error) {
      if (systemErrorCode(error) === "EEXIST") continue;
      throw error;
    }

    let closed = false;
    try {
      // chmod after open makes the private mode exact even under a hostile
      // permissive umask; the descriptor was already created with no broad bits.
      await handle.chmod(0o600);
      await handle.writeFile(contents);
      await handle.sync();
      await handle.close();
      closed = true;
      return stage;
    } catch (error) {
      const failures: unknown[] = [error];
      if (!closed) {
        try {
          await handle.close();
        } catch (closeError) {
          failures.push(closeError);
        }
      }
      try {
        await fs.rm(stage, { force: true });
      } catch (cleanupError) {
        failures.push(cleanupError);
      }
      throw new AggregateError(
        failures,
        `Could not create private staging file for ${path.basename(target)}`,
      );
    }
  }

  throw new Error(
    `Could not reserve an exclusive staging file for ${path.basename(target)}.`,
  );
}

async function removeArtifact(
  artifact: string | undefined,
  label: string,
): Promise<string | undefined> {
  if (!artifact) return undefined;
  try {
    await fs.rm(artifact, { force: true });
    return undefined;
  } catch (error) {
    return `${label} cleanup failed (${errorDescription(error)})`;
  }
}

async function rejectBeforeCommit(options: {
  stage?: string;
  backup?: string;
  candidateSourceSha256: string;
  activeSourceSha256?: string;
  error: string;
  errorCode: string;
  agentName?: string;
}): Promise<ImportOutcome> {
  const cleanupFailures = (
    await Promise.all([
      removeArtifact(options.stage, "candidate stage"),
      removeArtifact(options.backup, "previous-generation backup"),
    ])
  ).filter((entry): entry is string => entry !== undefined);

  if (cleanupFailures.length > 0) {
    return failureOutcome({
      candidateSourceSha256: options.candidateSourceSha256,
      activeSourceSha256: options.activeSourceSha256,
      agentName: options.agentName,
      errorCode: "IMPORT_STAGE_CLEANUP_FAILED",
      rejectedBeforeCommit: true,
      error: `${options.error} ${cleanupFailures.join("; ")}.`,
    });
  }

  return failureOutcome({
    candidateSourceSha256: options.candidateSourceSha256,
    activeSourceSha256: options.activeSourceSha256,
    agentName: options.agentName,
    errorCode: options.errorCode,
    rejectedBeforeCommit: true,
    error: options.error,
  });
}

function runStagedPython(
  file: string,
  timeoutMs = 20_000,
): Promise<{ stdout: string; stderr: string; code: number }> {
  const python = process.env.OPENRAPPTER_PYTHON ?? "python3";
  const bootstrap = [
    "import importlib.machinery, runpy, sys",
    `importlib.machinery.SOURCE_SUFFIXES.append(${JSON.stringify(PYTHON_STAGE_SUFFIX)})`,
    "runner = sys.argv[1]",
    'sys.argv = [runner, "introspect", sys.argv[2]]',
    'runpy.run_path(runner, run_name="__main__")',
  ].join("; ");

  return new Promise((resolve) => {
    const child = spawn(python, ["-c", bootstrap, runnerPath(), file], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (code: number, additionalError = ""): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        code,
        stdout,
        stderr: additionalError ? `${stderr}\n${additionalError}` : stderr,
      });
    };

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(124, `timed out after ${timeoutMs}ms`);
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      finish(127, errorDescription(error));
    });
    child.on("close", (code) => {
      finish(code ?? 0);
    });
  });
}

async function validateStagedPython(
  stage: string,
): Promise<CandidateValidation | CandidateRejection> {
  const { stdout, stderr } = await runStagedPython(stage);
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    const detail = stderr.trim().split("\n").slice(-3).join(" ").slice(0, 300);
    return {
      ok: false,
      error: detail || "python produced no output",
    };
  }

  if (!isRecord(parsed)) {
    return {
      ok: false,
      error: "python returned an invalid introspection result",
    };
  }
  if (parsed.status === "error") {
    return {
      ok: false,
      error:
        typeof parsed.error === "string"
          ? parsed.error
          : "python rejected the candidate",
    };
  }
  if (parsed.status !== "ok" || !Array.isArray(parsed.agents)) {
    return {
      ok: false,
      error: "python returned an invalid introspection result",
    };
  }

  const agents: CandidateAgent[] = [];
  for (const descriptor of parsed.agents) {
    if (
      !isRecord(descriptor) ||
      typeof descriptor.name !== "string" ||
      descriptor.name.trim() === ""
    ) {
      return { ok: false, error: "an agent has no valid capability name" };
    }
    agents.push({
      name: descriptor.name,
      description:
        typeof descriptor.description === "string"
          ? descriptor.description
          : "",
      parameters: descriptor.parameters ?? {
        type: "object",
        properties: {},
        required: [],
      },
    });
  }
  if (agents.length === 0) {
    return { ok: false, error: "no agent classes found in file" };
  }

  return {
    ok: true,
    agents,
    bridgeClass: PythonAgent.name,
  };
}

async function validateJavaScript(
  file: string,
): Promise<CandidateValidation | CandidateRejection> {
  try {
    const loaded: unknown = await import(
      `${pathToFileURL(file).href}?import-validation=${randomUUID()}`
    );
    if (!isRecord(loaded) || typeof loaded.createAgent !== "function") {
      return {
        ok: false,
        error: "it does not export createAgent(BasicAgent)",
      };
    }

    const AgentClass: unknown = Reflect.apply(loaded.createAgent, undefined, [
      BasicAgent,
    ]);
    if (typeof AgentClass !== "function") {
      return {
        ok: false,
        error: "createAgent(BasicAgent) did not return an agent class",
      };
    }

    const instance: unknown = Reflect.construct(AgentClass, []);
    if (!(instance instanceof BasicAgent)) {
      return {
        ok: false,
        error: "createAgent(BasicAgent) did not construct a BasicAgent",
      };
    }
    if (typeof instance.name !== "string" || instance.name.trim() === "") {
      return { ok: false, error: "the factory agent has no capability name" };
    }
    markAgentSourceFile(instance, file);

    return {
      ok: true,
      agents: [
        {
          name: instance.name,
          description: instance.metadata?.description ?? "",
          parameters: instance.metadata?.parameters ?? {
            type: "object",
            properties: {},
            required: [],
          },
        },
      ],
      bridgeClass: instance.constructor.name || BasicAgent.name,
      instances: new Map([[instance.name, instance]]),
    };
  } catch (error) {
    return { ok: false, error: errorDescription(error) };
  }
}

async function validateCandidate(
  stage: string,
  javascript: boolean,
): Promise<CandidateValidation | CandidateRejection> {
  return javascript ? validateJavaScript(stage) : validateStagedPython(stage);
}

async function previousGeneration(
  target: string,
  javascript: boolean,
  live: Map<string, BasicAgent>,
): Promise<
  | { ok: true; generation: PreviousGeneration }
  | { ok: false; bytes: Buffer; error: string }
> {
  const bytes = await readIfExists(target);
  const sourceSha256 = bytes === null ? undefined : sha256(bytes);
  const owned = new Map<string, BasicAgent>();

  if (!javascript) {
    for (const [agentName, agent] of live) {
      const sourceFile = sourceFileOf(agent);
      if (sourceFile && sameFilePath(sourceFile, target)) {
        owned.set(agentName, agent);
      }
    }
    return {
      ok: true,
      generation: { bytes, sourceSha256, owned },
    };
  }

  if (bytes !== null) {
    const validation = await validateJavaScript(target);
    if (!validation.ok) {
      return {
        ok: false,
        bytes,
        error: `the existing JavaScript generation could not be identified safely (${validation.error})`,
      };
    }
    for (const agentName of uniqueAgentNames(validation.agents)) {
      const agent = live.get(agentName);
      const sourceFile = agent ? sourceFileOf(agent) : undefined;
      if (agent && sourceFile && sameFilePath(sourceFile, target)) {
        owned.set(agentName, agent);
      }
    }
  }

  return {
    ok: true,
    generation: { bytes, sourceSha256, owned },
  };
}

async function createPreviousGenerationBackup(target: string): Promise<string> {
  const directory = path.dirname(target);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const backup = path.join(directory, `.agent-import-${randomUUID()}.backup`);
    try {
      // A hard link preserves the exact old inode while rename installs the
      // candidate at the target path.
      await fs.link(target, backup);
      return backup;
    } catch (error) {
      if (systemErrorCode(error) === "EEXIST") continue;
      throw error;
    }
  }
  throw new Error(
    `Could not reserve a previous-generation backup for ${path.basename(target)}.`,
  );
}

function verifyActivatedRegistry(options: {
  after: Map<string, BasicAgent>;
  candidate: CandidateValidation;
  previous: PreviousGeneration;
  target: string;
  javascript: boolean;
}): string[] {
  const failures: string[] = [];

  for (const descriptor of options.candidate.agents) {
    const active = options.after.get(descriptor.name);
    if (!active) {
      failures.push(`${descriptor.name} is missing`);
      continue;
    }
    if (options.previous.owned.get(descriptor.name) === active) {
      failures.push(`${descriptor.name} still refers to the previous object`);
    }
    if (active.metadata?.description !== descriptor.description) {
      failures.push(
        `${descriptor.name} metadata does not match the candidate ` +
          `(${JSON.stringify(active.metadata?.description)} !== ` +
          `${JSON.stringify(descriptor.description)})`,
      );
    }
    if (
      !isDeepStrictEqual(active.metadata?.parameters, descriptor.parameters)
    ) {
      failures.push(
        `${descriptor.name} parameter metadata does not match the candidate`,
      );
    }
    if (!options.javascript && !(active instanceof PythonAgent)) {
      failures.push(`${descriptor.name} is not a PythonAgent`);
      continue;
    }
    const sourceFile = sourceFileOf(active);
    if (!sourceFile) {
      failures.push(`${descriptor.name} has no canonical source marker`);
    } else if (!sameFilePath(sourceFile, options.target)) {
      failures.push(`${descriptor.name} is registered from another file`);
    }
  }

  return failures;
}

async function restoreRegistryGeneration(options: {
  registry: ImportRegistry;
  snapshot: Map<string, BasicAgent>;
}): Promise<string[]> {
  const failures: string[] = [];

  try {
    const live = await options.registry.getAllAgents();
    // One synchronous map mutation restores the exact namespace snapshot; no
    // registry reader can observe the clear and repopulation between turns.
    live.clear();
    for (const [name, agent] of options.snapshot) {
      live.set(name, agent);
    }

    if (live.size !== options.snapshot.size) {
      failures.push("registry size did not recover its previous snapshot");
    }
    for (const [name, agent] of options.snapshot) {
      if (live.get(name) !== agent) {
        failures.push(`${name} did not recover its previous live object`);
      }
    }
  } catch (error) {
    failures.push(errorDescription(error));
  }

  return failures;
}

async function rollbackCommittedCandidate(options: {
  activationError: string;
  activationErrorCode: string;
  backup?: string;
  candidate: CandidateValidation;
  candidateSourceSha256: string;
  previous: PreviousGeneration;
  registry: ImportRegistry;
  registrySnapshot: Map<string, BasicAgent>;
  target: string;
}): Promise<ImportOutcome> {
  const rollbackFailures: string[] = [];
  let diskRestored = false;

  try {
    if (options.previous.bytes === null) {
      await fs.rm(options.target, { force: true });
    } else if (options.backup) {
      await fs.rename(options.backup, options.target);
    } else {
      throw new Error("the previous-generation backup is missing");
    }
    diskRestored = true;
  } catch (error) {
    rollbackFailures.push(`disk restore failed (${errorDescription(error)})`);
  }

  if (diskRestored) {
    rollbackFailures.push(
      ...(await restoreRegistryGeneration({
        registry: options.registry,
        snapshot: options.registrySnapshot,
      })),
    );
  }

  if (rollbackFailures.length > 0) {
    return failureOutcome({
      candidateSourceSha256: options.candidateSourceSha256,
      activeSourceSha256: diskRestored
        ? options.previous.sourceSha256
        : options.candidateSourceSha256,
      agentName:
        options.previous.owned.keys().next().value ??
        options.candidate.agents[0]?.name,
      errorCode: "IMPORT_ROLLBACK_FAILED",
      rejectedBeforeCommit: false,
      committed: !diskRestored,
      commitState: "unknown",
      retrySafe: false,
      error:
        `${options.activationError} Rollback was incomplete: ` +
        `${rollbackFailures.join("; ")}.`,
    });
  }

  return failureOutcome({
    candidateSourceSha256: options.candidateSourceSha256,
    activeSourceSha256: options.previous.sourceSha256,
    agentName:
      options.previous.owned.keys().next().value ??
      options.candidate.agents[0]?.name,
    errorCode: options.activationErrorCode,
    rejectedBeforeCommit: false,
    committed: false,
    commitState: "restored",
    retrySafe: true,
    error: `${options.activationError} The previous generation was restored.`,
  });
}

function removeDisappearedAgents(
  live: Map<string, BasicAgent>,
  previous: PreviousGeneration,
  candidate: CandidateValidation,
): void {
  const candidateNames = new Set(uniqueAgentNames(candidate.agents));
  for (const oldName of previous.owned.keys()) {
    if (!candidateNames.has(oldName)) live.delete(oldName);
  }
}

async function activateCommittedCandidate(options: {
  backup?: string;
  candidate: CandidateValidation;
  candidateSourceSha256: string;
  filename: string;
  javascript: boolean;
  previous: PreviousGeneration;
  registry: ImportRegistry;
  registrySnapshot: Map<string, BasicAgent>;
  target: string;
}): Promise<ImportOutcome> {
  let activationError: string | undefined;
  let activationErrorCode = "IMPORT_ACTIVATION_FAILED";
  let activatedLive: Map<string, BasicAgent> | undefined;

  try {
    if (options.javascript) {
      // Validate the committed URL as well as the staged bytes. This catches
      // factories that depend on import.meta.url, and avoids AgentRegistry's
      // millisecond cache key reusing a prior same-file factory generation.
      await options.registry.reloadUserAgents();
      const committed = await validateJavaScript(options.target);
      if (!committed.ok) {
        activationError =
          `${options.filename} was committed but its final JavaScript URL ` +
          `did not load (${committed.error})`;
      } else if (
        JSON.stringify(committed.agents) !==
        JSON.stringify(options.candidate.agents)
      ) {
        activationError =
          `${options.filename} changed capability metadata between staging ` +
          "and final activation";
      } else if (!committed.instances) {
        activationError = `${options.filename} loaded without a JavaScript agent instance`;
      } else {
        const after = await options.registry.getAllAgents();
        for (const [agentName, instance] of committed.instances) {
          after.set(agentName, instance);
        }
        const verifiedLive = await options.registry.getAllAgents();
        activatedLive = verifiedLive;
        const verificationFailures = verifyActivatedRegistry({
          after: verifiedLive,
          candidate: options.candidate,
          previous: options.previous,
          target: options.target,
          javascript: true,
        });
        if (verificationFailures.length > 0) {
          activationErrorCode = "IMPORT_REGISTRY_VERIFICATION_FAILED";
          activationError =
            `${options.filename} was committed but registry verification failed ` +
            `(${verificationFailures.join("; ")})`;
        }
      }
    } else {
      await options.registry.reloadUserAgents();
      const after = await options.registry.getAllAgents();
      activatedLive = after;
      const verificationFailures = verifyActivatedRegistry({
        after,
        candidate: options.candidate,
        previous: options.previous,
        target: options.target,
        javascript: false,
      });
      if (verificationFailures.length > 0) {
        activationErrorCode = "IMPORT_REGISTRY_VERIFICATION_FAILED";
        activationError =
          `${options.filename} was committed but registry verification failed ` +
          `(${verificationFailures.join("; ")})`;
      }
    }
  } catch (error) {
    activationError =
      `${options.filename} was committed but registry activation failed ` +
      `(${errorDescription(error)})`;
  }

  if (!activationError) {
    try {
      const activeSourceSha256 = sha256(await fs.readFile(options.target));
      if (activeSourceSha256 !== options.candidateSourceSha256) {
        activationErrorCode = "IMPORT_ACTIVE_SOURCE_VERIFICATION_FAILED";
        activationError = `${options.filename} changed before activation could be verified`;
      }
    } catch (error) {
      activationErrorCode = "IMPORT_ACTIVE_SOURCE_VERIFICATION_FAILED";
      activationError =
        `${options.filename} could not be read after activation ` +
        `(${errorDescription(error)})`;
    }
  }

  if (!activationError) {
    if (!activatedLive) {
      activationErrorCode = "IMPORT_REGISTRY_VERIFICATION_FAILED";
      activationError = `${options.filename} did not expose an activated registry map`;
    } else {
      removeDisappearedAgents(
        activatedLive,
        options.previous,
        options.candidate,
      );
    }
  }

  if (activationError) {
    return rollbackCommittedCandidate({
      activationError,
      activationErrorCode,
      backup: options.backup,
      candidate: options.candidate,
      candidateSourceSha256: options.candidateSourceSha256,
      previous: options.previous,
      registry: options.registry,
      registrySnapshot: options.registrySnapshot,
      target: options.target,
    });
  }

  const cleanupFailure = await removeArtifact(
    options.backup,
    "previous-generation backup",
  );
  if (cleanupFailure) {
    return committedOutcome({
      candidate: options.candidate,
      candidateSourceSha256: options.candidateSourceSha256,
      filename: options.filename,
      previous: options.previous,
      errorCode: "IMPORT_POST_COMMIT_CLEANUP_FAILED",
      warning:
        `${options.filename} is active, but its previous-generation backup ` +
        "could not be removed. Do not retry this import; check directory permissions and remove the leftover .agent-import-*.backup file.",
    });
  }

  return committedOutcome({
    candidate: options.candidate,
    candidateSourceSha256: options.candidateSourceSha256,
    filename: options.filename,
    previous: options.previous,
  });
}

async function performLockedImport(options: {
  filename: string;
  contents: Buffer;
  candidateSourceSha256: string;
  javascript: boolean;
  registry: ImportRegistry;
  target: string;
}): Promise<ImportOutcome> {
  const live = await options.registry.getAllAgents();
  const registrySnapshot = new Map(live);
  const previousResult = await previousGeneration(
    options.target,
    options.javascript,
    live,
  );
  if (!previousResult.ok) {
    return failureOutcome({
      candidateSourceSha256: options.candidateSourceSha256,
      activeSourceSha256: sha256(previousResult.bytes),
      errorCode: "IMPORT_EXISTING_GENERATION_UNVERIFIABLE",
      rejectedBeforeCommit: true,
      error:
        `${options.filename} was not changed because ` +
        `${previousResult.error}.`,
    });
  }
  const previous = previousResult.generation;
  const preservedAgentName = previous.owned.keys().next().value;

  if (options.contents.length === 0) {
    return failureOutcome({
      candidateSourceSha256: options.candidateSourceSha256,
      activeSourceSha256: previous.sourceSha256,
      agentName: preservedAgentName,
      errorCode: "IMPORT_EMPTY_FILE",
      rejectedBeforeCommit: true,
      error: `${options.filename} is empty.`,
    });
  }

  const stage = await createPrivateStage(
    options.target,
    options.contents,
    options.javascript,
  );
  const candidate = await validateCandidate(stage, options.javascript);
  if (!candidate.ok) {
    return rejectBeforeCommit({
      stage,
      candidateSourceSha256: options.candidateSourceSha256,
      activeSourceSha256: previous.sourceSha256,
      agentName: preservedAgentName,
      errorCode: "IMPORT_CANDIDATE_INVALID",
      error: previous.bytes
        ? `${options.filename} did not load as an agent (${candidate.error}). The working version was kept.`
        : `${options.filename} did not load as an agent: ${candidate.error}`,
    });
  }

  const candidateNames = uniqueAgentNames(candidate.agents);
  if (candidateNames.length !== candidate.agents.length) {
    return rejectBeforeCommit({
      stage,
      candidateSourceSha256: options.candidateSourceSha256,
      activeSourceSha256: previous.sourceSha256,
      agentName: preservedAgentName,
      errorCode: "IMPORT_DUPLICATE_CAPABILITY",
      error: `${options.filename} defines the same capability name more than once.`,
    });
  }

  const authoritativeLive = await options.registry.getAllAgents();
  const clashes = candidateNames.filter((agentName) => {
    const existing = authoritativeLive.get(agentName);
    return existing !== undefined && previous.owned.get(agentName) !== existing;
  });
  if (clashes.length > 0) {
    return rejectBeforeCommit({
      stage,
      candidateSourceSha256: options.candidateSourceSha256,
      activeSourceSha256: previous.sourceSha256,
      agentName: clashes[0],
      errorCode: "IMPORT_NAME_COLLISION",
      error:
        `${clashes.join(", ")} already exists. Rename the agent inside ` +
        `${options.filename} or remove the one that is installed.`,
    });
  }

  let backup: string | undefined;
  try {
    if (previous.bytes !== null) {
      backup = await createPreviousGenerationBackup(options.target);
      const backupBytes = await fs.readFile(backup);
      if (sha256(backupBytes) !== previous.sourceSha256) {
        return rejectBeforeCommit({
          stage,
          backup,
          candidateSourceSha256: options.candidateSourceSha256,
          activeSourceSha256: sha256(backupBytes),
          agentName: preservedAgentName,
          errorCode: "IMPORT_TARGET_CHANGED",
          error: `${options.filename} changed while its replacement was being prepared.`,
        });
      }
    }
  } catch (error) {
    return rejectBeforeCommit({
      stage,
      backup,
      candidateSourceSha256: options.candidateSourceSha256,
      activeSourceSha256: previous.sourceSha256,
      agentName: preservedAgentName,
      errorCode: "IMPORT_COMMIT_FAILED",
      error:
        `${options.filename} was validated but could not be committed ` +
        `(${errorDescription(error)}).`,
    });
  }

  return withAgentSourceWriteLock(options.target, async () => {
    let committed = false;
    try {
      await fs.rename(stage, options.target);
      committed = true;
      return await activateCommittedCandidate({
        backup,
        candidate,
        candidateSourceSha256: options.candidateSourceSha256,
        filename: options.filename,
        javascript: options.javascript,
        previous,
        registry: options.registry,
        registrySnapshot,
        target: options.target,
      });
    } catch (error) {
      if (!committed) {
        return rejectBeforeCommit({
          stage,
          backup,
          candidateSourceSha256: options.candidateSourceSha256,
          activeSourceSha256: previous.sourceSha256,
          agentName: preservedAgentName,
          errorCode: "IMPORT_COMMIT_FAILED",
          error:
            `${options.filename} was validated but could not be committed ` +
            `(${errorDescription(error)}).`,
        });
      }
      return rollbackCommittedCandidate({
        activationError:
          `${options.filename} was committed but activation threw unexpectedly ` +
          `(${errorDescription(error)})`,
        activationErrorCode: "IMPORT_ACTIVATION_FAILED",
        backup,
        candidate,
        candidateSourceSha256: options.candidateSourceSha256,
        previous,
        registry: options.registry,
        registrySnapshot,
        target: options.target,
      });
    }
  });
}

function provenanceMetadata(
  provenance: AgentImportProvenance | undefined,
): Record<string, unknown> {
  if (!provenance) return {};
  return {
    requestId: provenance.requestId,
    nonce: provenance.scenarioNonce,
  };
}

async function recordImportTerminal(
  started: FlightEvent | null,
  outcome: ImportOutcome,
  provenance: AgentImportProvenance | undefined,
): Promise<void> {
  if (!started) return;
  const recorder = getFlightRecorder();
  const result = outcome.result;
  const common = {
    ...provenanceMetadata(provenance),
    candidateSourceSha256: result.candidateSourceSha256,
    ...(result.activeSourceSha256 === undefined
      ? {}
      : { activeSourceSha256: result.activeSourceSha256 }),
    commitState: result.commitState,
    retrySafe: result.retrySafe,
  };

  if (result.status === "ok") {
    await recorder.record({
      kind: "agent.import.completed",
      source: "agent-import",
      status: "success",
      traceId: started.traceId,
      parentId: started.id,
      agentName: outcome.agentName,
      metadata: {
        ...common,
        bridgeClass: outcome.bridgeClass,
        committed: result.committed ?? false,
        errorCode: result.errorCode,
      },
    });
    return;
  }

  await recorder.record({
    kind: "agent.import.failed",
    source: "agent-import",
    status: "error",
    traceId: started.traceId,
    parentId: started.id,
    agentName: outcome.agentName,
    metadata: {
      ...common,
      committed: result.committed ?? false,
      rejectedBeforeCommit: result.rejectedBeforeCommit ?? false,
      errorCode: result.errorCode,
    },
  });
}

/**
 * Stage, validate, atomically commit, and activate a dropped agent.
 *
 * `registry` is required: an install that does not reach the running registry
 * is not a hot-load, and this function is the only thing that can honestly
 * report that the capability is live.
 */
export async function importAgentFile(
  originalName: string,
  contents: Buffer,
  registry: ImportRegistry,
  opts: { dir?: string } = {},
): Promise<ImportResult> {
  const dir = opts.dir ?? userAgentsDir();
  const name = safeAgentFilename(originalName);
  const candidateSourceSha256 = sha256(contents);
  const provenance = provenanceStorage.getStore();

  await ensureFlightRecorderFromEnv();
  const recorder = getFlightRecorder();
  const started = await recorder.record({
    kind: "agent.import.started",
    source: "agent-import",
    status: "started",
    ...(provenance?.traceId ? { traceId: provenance.traceId } : {}),
    ...(provenance?.gatewayParentEventId
      ? { parentId: provenance.gatewayParentEventId }
      : {}),
    metadata: {
      ...provenanceMetadata(provenance),
      filename: name,
      candidateSourceSha256,
    },
  });

  let outcome: ImportOutcome;
  if (!name.endsWith(".py") && !name.endsWith(".js")) {
    outcome = failureOutcome({
      candidateSourceSha256,
      errorCode: "IMPORT_UNSUPPORTED_EXTENSION",
      rejectedBeforeCommit: true,
      error: `${name} is not an agent — only .py and .js files can be installed.`,
    });
  } else if (PROTECTED.has(name)) {
    outcome = failureOutcome({
      candidateSourceSha256,
      errorCode: "IMPORT_PROTECTED_FILE",
      rejectedBeforeCommit: true,
      error: `${name} is shared scaffolding, not a capability, and cannot be replaced.`,
    });
  } else if (name.endsWith(".js") && !name.endsWith("_agent.js")) {
    outcome = failureOutcome({
      candidateSourceSha256,
      errorCode: "IMPORT_INVALID_JAVASCRIPT_FILENAME",
      rejectedBeforeCommit: true,
      error:
        `JavaScript agents must be named *_agent.js (got ${name}) ` +
        "so the registry can find them.",
    });
  } else {
    try {
      await fs.mkdir(dir, { recursive: true });
      const target = path.resolve(dir, name);
      const resolvedDirectory = await fs.realpath(path.dirname(target));
      const lockTarget = path.join(resolvedDirectory, path.basename(target));
      outcome = await withTargetLock(lockTarget, () =>
        withRegistryLock(registry, () =>
          performLockedImport({
            filename: name,
            contents,
            candidateSourceSha256,
            javascript: name.endsWith(".js"),
            registry,
            target,
          }),
        ),
      );
    } catch (error) {
      outcome = failureOutcome({
        candidateSourceSha256,
        errorCode: "IMPORT_TRANSACTION_FAILED",
        rejectedBeforeCommit: true,
        error: `${name} could not be imported (${errorDescription(error)}).`,
      });
    }
  }

  await recordImportTerminal(started, outcome, provenance);
  return outcome.result;
}
