#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const RESULT_PREFIX = "OPENRAPPTER_TRANSPLANT_RESULT=";
const GATE_REPORT_PREFIX = "OPENRAPPTER_TRANSPLANT_GATE_REPORT=";
const DEMO_HARD_DEADLINE_MS = 30_000;
const BUILD_HARD_DEADLINE_MS = 120_000;
const MAX_CAPTURE_BYTES = 10 * 1024 * 1024;
const TERMINATION_GRACE_MS = 250;
const CLOSE_SETTLEMENT_GRACE_MS = 250;
const HARD_SETTLEMENT_FALLBACK_MS = 2_000;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GATE_PATH = fileURLToPath(import.meta.url);
const TYPESCRIPT_ROOT = path.join(ROOT, "typescript");
const MANIFEST_PATH = path.join(
  TYPESCRIPT_ROOT,
  "src",
  "demo",
  "live-organ-transplant.manifest.json",
);
const CONTRACT_PATH = path.join(
  TYPESCRIPT_ROOT,
  "dist",
  "demo",
  "live-organ-transplant-contract.js",
);
const INTEGRATION_TEST_PATH = path.join(
  TYPESCRIPT_ROOT,
  "src",
  "__tests__",
  "integration",
  "live-organ-transplant.integration.test.ts",
);
const PACKAGE_PATH = path.join(TYPESCRIPT_ROOT, "package.json");
const PACKAGE_LOCK_PATH = path.join(TYPESCRIPT_ROOT, "package-lock.json");
const VITEST_ENTRYPOINT = path.join(
  TYPESCRIPT_ROOT,
  "node_modules",
  "vitest",
  "vitest.mjs",
);
const VITEST_PACKAGE_ROOT = path.join(
  TYPESCRIPT_ROOT,
  "node_modules",
  "vitest",
);
const VITEST_SUPPORT_ROOT = path.join(
  TYPESCRIPT_ROOT,
  "node_modules",
  "@vitest",
);
const VITE_PACKAGE_ROOT = path.join(TYPESCRIPT_ROOT, "node_modules", "vite");

const PINNED_CHECK_IDS = [
  "result-schema",
  "compiled-runtime",
  "isolated-scenario-evidence",
  "host-identity-preserved",
  "authenticated-http-import",
  "python-agent-bridge",
  "known-vector-first-execution",
  "bad-candidate-rejected-before-commit",
  "previous-generation-preserved",
  "deterministic-second-execution",
  "flight-recorder-integrity",
  "exact-command-causal-trace",
  "no-provider-model-events",
  "loopback-gateway-requests",
  "unsandboxed-file-boundary",
  "bounded-runtime",
  "missing-python-controlled",
  "exact-command-parity",
  "complete-evidence",
  "fixture-source-hash-pinned",
];

const PINNED_PROBE_TEST_NAMES = [
  "live organ transplant independent observer hashes both bundled fixtures before importing either one",
  "live organ transplant independent observer keeps one real GatewayServer and one real AgentRegistry object in one host process",
  "live organ transplant independent observer proves the bearer header gates the real HTTP importer",
  "live organ transplant independent observer resolves the imported object as the real PythonAgent bridge",
  "live organ transplant independent observer executes the actual PythonAgent twice with the pinned digest",
  "live organ transplant independent observer rejects the invalid replacement before committed bytes or live identity change",
  "live organ transplant independent observer reopens the database with the production ledger and exactly matches the production export",
  "live organ transplant independent observer observes loopback gateway requests and no provider or model activity",
];

const results = [];
export const TRANSPLANT_GATE_PHASE_ORDER = [
  "independent-probe",
  "success-command",
  "missing-python-command",
];

export class GatePhaseTracker {
  #position = 0;

  enter(phase) {
    const expected = TRANSPLANT_GATE_PHASE_ORDER[this.#position];
    if (phase !== expected) {
      throw new Error(
        `Gate phase order violation: expected ${expected ?? "completion"}, got ${phase}`,
      );
    }
    this.#position += 1;
  }

  complete() {
    return this.#position === TRANSPLANT_GATE_PHASE_ORDER.length;
  }
}

function req(name, pass, detail = "") {
  results.push({ name, pass: Boolean(pass), detail });
  console.log(
    `${pass ? " PASS" : "*FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`,
  );
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function hashFile(file) {
  return sha256(readFileSync(file));
}

function hashFileOrEmpty(file) {
  try {
    return hashFile(file);
  } catch {
    return "";
  }
}

function hashTreeOrEmpty(directory) {
  try {
    return snapshotDirectory(directory).inventorySha256;
  } catch {
    return "";
  }
}

function hashInstalledTreeOrEmpty(directory) {
  try {
    const entries = [];
    const walk = (current, prefix) => {
      for (const entry of readdirSync(current, { withFileTypes: true }).sort(
        (left, right) => left.name.localeCompare(right.name),
      )) {
        const fullPath = path.join(current, entry.name);
        const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isSymbolicLink()) {
          entries.push({
            path: relativePath,
            symlink: readlinkSync(fullPath),
          });
        } else if (entry.isDirectory()) {
          walk(fullPath, relativePath);
        } else if (entry.isFile()) {
          const bytes = readFileSync(fullPath);
          entries.push({
            path: relativePath,
            sizeBytes: bytes.length,
            sha256: sha256(bytes),
          });
        }
      }
    };
    walk(directory, "");
    return sha256(JSON.stringify(entries));
  } catch {
    return "";
  }
}

function trustedFileHashes() {
  return {
    gate: hashFileOrEmpty(GATE_PATH),
    contract: hashFileOrEmpty(CONTRACT_PATH),
    integrationTest: hashFileOrEmpty(INTEGRATION_TEST_PATH),
    manifest: hashFileOrEmpty(MANIFEST_PATH),
    package: hashFileOrEmpty(PACKAGE_PATH),
    packageLock: hashFileOrEmpty(PACKAGE_LOCK_PATH),
    vitestEntrypoint: hashFileOrEmpty(VITEST_ENTRYPOINT),
    vitestPackageTree: hashInstalledTreeOrEmpty(VITEST_PACKAGE_ROOT),
    vitestSupportTree: hashInstalledTreeOrEmpty(VITEST_SUPPORT_ROOT),
    vitePackageTree: hashInstalledTreeOrEmpty(VITE_PACKAGE_ROOT),
    sourceTree: hashTreeOrEmpty(path.join(TYPESCRIPT_ROOT, "src")),
    compiledTree: hashTreeOrEmpty(path.join(TYPESCRIPT_ROOT, "dist")),
  };
}

function hashesMatch(left, right) {
  return Object.keys(left).every((key) => left[key] === right[key]);
}

function readManifest() {
  const parsed = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
  if (
    !isRecord(parsed) ||
    !Array.isArray(parsed.supportedPlatforms) ||
    JSON.stringify(parsed.supportedPlatforms) !==
      JSON.stringify(["darwin", "linux"]) ||
    !isRecord(parsed.command) ||
    typeof parsed.command.executable !== "string" ||
    !Array.isArray(parsed.command.args) ||
    !parsed.command.args.every((entry) => typeof entry === "string") ||
    typeof parsed.command.display !== "string" ||
    typeof parsed.command.workingDirectory !== "string" ||
    !isRecord(parsed.runtimeLimits) ||
    parsed.runtimeLimits.commandTimeoutMs !== DEMO_HARD_DEADLINE_MS ||
    parsed.runtimeLimits.missingPythonTimeoutMs !== DEMO_HARD_DEADLINE_MS ||
    parsed.runtimeLimits.demoMaxElapsedMs !== DEMO_HARD_DEADLINE_MS ||
    !isRecord(parsed.missingPython) ||
    parsed.missingPython.environmentVariable !== "OPENRAPPTER_PYTHON" ||
    typeof parsed.missingPython.executableBasename !== "string" ||
    !Number.isInteger(parsed.missingPython.expectedExitCode) ||
    parsed.missingPython.expectedExitCode === 0 ||
    !isRecord(parsed.artifacts) ||
    typeof parsed.artifacts.evidenceRoot !== "string" ||
    typeof parsed.artifacts.directoryEnvironmentVariable !== "string" ||
    typeof parsed.artifacts.nonceEnvironmentVariable !== "string" ||
    typeof parsed.artifacts.runtimePidHandoffEnvironmentVariable !== "string" ||
    typeof parsed.artifacts.runtimePidHandoffFilename !== "string" ||
    parsed.artifacts.runtimePidHandoffOpenFlag !== "wx"
  ) {
    throw new Error(
      "Manifest command, exact 30-second limits, nonzero missing-Python exit, or artifact controls are invalid.",
    );
  }
  return parsed;
}

function resolveInsideRoot(value) {
  if (typeof value !== "string" || path.isAbsolute(value)) return null;
  const resolved = path.resolve(ROOT, value);
  const relative = path.relative(ROOT, resolved);
  if (
    relative === "" ||
    relative.startsWith("..") ||
    path.isAbsolute(relative)
  ) {
    return null;
  }
  return resolved;
}

function resolveReportedPath(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  const resolved = path.isAbsolute(value)
    ? path.resolve(value)
    : path.resolve(ROOT, value);
  const relative = path.relative(ROOT, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return resolved;
}

function directoryIsEmpty(directory) {
  return readdirSync(directory).length === 0;
}

async function terminateSpecificTree(child) {
  if (typeof child.pid !== "number") return false;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    try {
      process.kill(child.pid, "SIGTERM");
    } catch {
      // The direct child exited; descendants in its group may also be gone.
    }
  }
  await new Promise((resolve) => setTimeout(resolve, TERMINATION_GRACE_MS));
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    try {
      process.kill(child.pid, "SIGKILL");
    } catch {
      // The exact process tree already exited.
    }
  }
  return true;
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function linuxProcessIdentity(pid) {
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = raw
      .slice(raw.lastIndexOf(")") + 2)
      .trim()
      .split(/\s+/);
    return {
      pid,
      ppid: Number(fields[1]),
      pgid: Number(fields[2]),
    };
  } catch {
    return null;
  }
}

function darwinProcessIdentity(pid) {
  return new Promise((resolve) => {
    const child = spawn(
      "ps",
      ["-o", "pid=", "-o", "ppid=", "-o", "pgid=", "-p", String(pid)],
      { shell: false, stdio: ["ignore", "pipe", "ignore"] },
    );
    let output = "";
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // The bounded ps observation already exited.
      }
      finish(null);
    }, 500);
    child.stdout.on("data", (chunk) => {
      output += chunk.toString("utf8");
    });
    child.once("error", () => finish(null));
    child.once("close", () => {
      const fields = output.trim().split(/\s+/).map(Number);
      finish(
        fields.length === 3 && fields.every(Number.isInteger)
          ? { pid: fields[0], ppid: fields[1], pgid: fields[2] }
          : null,
      );
    });
  });
}

async function processIdentity(pid) {
  return process.platform === "linux"
    ? linuxProcessIdentity(pid)
    : darwinProcessIdentity(pid);
}

async function observeRuntimeRelationship(runtimePid, directChildPid) {
  const observedAtMs = Date.now();
  const alive = processIsAlive(runtimePid);
  const identity = alive ? await processIdentity(runtimePid) : null;
  let ancestryMatches = false;
  let cursor = identity;
  const visited = new Set();
  const ancestryDeadline = Date.now() + 750;
  for (
    let depth = 0;
    cursor && depth < 64 && Date.now() < ancestryDeadline;
    depth += 1
  ) {
    if (cursor.pid === directChildPid || cursor.ppid === directChildPid) {
      ancestryMatches = true;
      break;
    }
    if (
      cursor.ppid <= 1 ||
      cursor.ppid === cursor.pid ||
      visited.has(cursor.ppid)
    ) {
      break;
    }
    visited.add(cursor.ppid);
    cursor = await processIdentity(cursor.ppid);
  }
  return {
    runtimePid,
    runtimePidObservedWhileAlive: alive && identity !== null,
    runtimeAliveAtObservation: alive,
    runtimePgid: identity?.pgid ?? null,
    runtimeGroupMatches: identity?.pgid === directChildPid,
    runtimeAncestryMatches: ancestryMatches,
    runtimeObservedAtMs: observedAtMs,
  };
}

export function runProcess(executable, args, options) {
  return new Promise((resolve) => {
    const started = performance.now();
    const startedAtMs = Date.now();
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: {
        ...process.env,
        CI: "1",
        ...options.environment,
      },
      detached: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let capturedBytes = 0;
    let timedOut = false;
    let captureExceeded = false;
    let spawnError = null;
    let spawnObserved = false;
    let exitObserved = false;
    let closeObserved = false;
    let exitCode = null;
    let exitSignal = null;
    let forcedSettled = false;
    let groupTerminationAttempted = false;
    let groupTerminationCompleted = false;
    let pipesDestroyed = false;
    let finished = false;
    let terminationPromise = null;
    let settleTimer = null;
    let handoffPollTimer = null;
    let runtimeObservationPromise = null;
    let runtimeObservation = {
      runtimePid: null,
      runtimePidObservedWhileAlive: false,
      runtimeAliveAtObservation: false,
      runtimePgid: null,
      runtimeGroupMatches: false,
      runtimeAncestryMatches: false,
      runtimeObservedAtMs: null,
    };

    const pollRuntimeHandoff = () => {
      if (
        runtimeObservationPromise ||
        !options.runtimePidHandoffPath ||
        typeof child.pid !== "number"
      ) {
        return;
      }
      try {
        const handoff = JSON.parse(
          readFileSync(options.runtimePidHandoffPath, "utf8"),
        );
        if (
          handoff.schema !== "openrappter-runtime-pid/1.0" ||
          handoff.nonce !== options.runtimePidNonce ||
          !Number.isInteger(handoff.pid) ||
          handoff.pid <= 0
        ) {
          return;
        }
        runtimeObservationPromise = observeRuntimeRelationship(
          handoff.pid,
          child.pid,
        ).then((observation) => {
          runtimeObservation = observation;
        });
      } catch {
        // The O_EXCL handoff may not exist or may still be mid-write.
      }
    };

    const destroyInheritedPipes = () => {
      if (pipesDestroyed) return;
      pipesDestroyed = true;
      child.stdout?.destroy();
      child.stderr?.destroy();
    };

    const finalize = (forced) => {
      if (finished) return;
      finished = true;
      forcedSettled ||= forced;
      clearTimeout(timeoutTimer);
      clearTimeout(absoluteFallbackTimer);
      if (handoffPollTimer) clearInterval(handoffPollTimer);
      if (settleTimer) clearTimeout(settleTimer);
      pollRuntimeHandoff();
      void (async () => {
        if (runtimeObservationPromise) {
          await Promise.race([
            runtimeObservationPromise,
            new Promise((settle) => setTimeout(settle, 1_000)),
          ]);
        }
        resolve({
          childPid: typeof child.pid === "number" ? child.pid : null,
          status: typeof exitCode === "number" ? exitCode : null,
          signal: exitSignal,
          stdout,
          stderr,
          elapsedMs: Math.ceil(performance.now() - started),
          startedAtMs,
          finishedAtMs: Date.now(),
          spawnObserved,
          exitObserved,
          closeObserved,
          timedOut,
          forcedSettled,
          groupTerminationAttempted,
          groupTerminationCompleted,
          pipesDestroyed,
          captureExceeded,
          ...runtimeObservation,
          error:
            spawnError ??
            (timedOut
              ? new Error(`timed out after ${options.timeoutMs}ms`)
              : captureExceeded
                ? new Error(`captured more than ${MAX_CAPTURE_BYTES} bytes`)
                : forced
                  ? new Error("hard process settlement fallback was required")
                  : null),
        });
      })();
    };

    const beginSettlement = (reason) => {
      if (reason === "timeout") timedOut = true;
      if (reason === "capture") captureExceeded = true;
      if (!terminationPromise) {
        groupTerminationAttempted = typeof child.pid === "number";
        const terminateTree = options.terminateTree ?? terminateSpecificTree;
        terminationPromise = Promise.resolve(terminateTree(child))
          .catch(() => false)
          .then((completed) => {
            groupTerminationCompleted = completed;
            destroyInheritedPipes();
          });
      }
      void terminationPromise.then(() => {
        if (finished) return;
        if (closeObserved) {
          finalize(false);
          return;
        }
        if (!settleTimer) {
          settleTimer = setTimeout(
            () => finalize(true),
            options.settleGraceMs ?? CLOSE_SETTLEMENT_GRACE_MS,
          );
        }
      });
    };

    const capture = (target, chunk) => {
      capturedBytes += chunk.length;
      if (capturedBytes > MAX_CAPTURE_BYTES) {
        beginSettlement("capture");
        return target;
      }
      return target + chunk.toString("utf8");
    };

    child.stdout?.on("data", (chunk) => {
      stdout = capture(stdout, chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr = capture(stderr, chunk);
    });
    child.once("spawn", () => {
      spawnObserved = true;
      pollRuntimeHandoff();
    });
    child.once("error", (error) => {
      spawnError = error;
      beginSettlement("spawn-error");
    });
    child.once("exit", (status, signal) => {
      exitObserved = true;
      exitCode = typeof status === "number" ? status : exitCode;
      exitSignal = signal ?? exitSignal;
      clearTimeout(timeoutTimer);
      beginSettlement("direct-exit");
    });
    child.once("close", (status, signal) => {
      closeObserved = true;
      exitCode = typeof status === "number" ? status : exitCode;
      exitSignal = signal ?? exitSignal;
      clearTimeout(timeoutTimer);
      beginSettlement("close");
    });

    const timeoutTimer = setTimeout(() => {
      beginSettlement("timeout");
    }, options.timeoutMs);
    const absoluteFallbackTimer = setTimeout(
      () => {
        beginSettlement("hard-fallback");
        destroyInheritedPipes();
        finalize(true);
      },
      options.timeoutMs +
        (options.hardFallbackMs ?? HARD_SETTLEMENT_FALLBACK_MS),
    );
    if (options.runtimePidHandoffPath) {
      handoffPollTimer = setInterval(pollRuntimeHandoff, 10);
    }
  });
}

function prefixOccurrences(value) {
  let count = 0;
  let offset = 0;
  while (true) {
    const found = value.indexOf(RESULT_PREFIX, offset);
    if (found < 0) return count;
    count += 1;
    offset = found + RESULT_PREFIX.length;
  }
}

function parseRecord(run) {
  const lines = run.stdout.split(/\r?\n/);
  const matchingLines = lines.filter((line) => line.startsWith(RESULT_PREFIX));
  const stdoutOccurrences = prefixOccurrences(run.stdout);
  const stderrOccurrences = prefixOccurrences(run.stderr);
  let value = null;
  let error = "";
  if (
    matchingLines.length !== 1 ||
    stdoutOccurrences !== 1 ||
    stderrOccurrences !== 0
  ) {
    error =
      `expected one stdout prefix and none on stderr; ` +
      `lines=${matchingLines.length}, stdout=${stdoutOccurrences}, ` +
      `stderr=${stderrOccurrences}`;
  } else {
    try {
      value = JSON.parse(matchingLines[0].slice(RESULT_PREFIX.length));
    } catch (caught) {
      error = `prefixed payload is not JSON: ${String(caught)}`;
    }
  }
  return {
    count: stdoutOccurrences + stderrOccurrences,
    stdoutCount: stdoutOccurrences,
    stderrCount: stderrOccurrences,
    line: matchingLines.length === 1 ? matchingLines[0] : "",
    value,
    error,
  };
}

function hasNonzeroSkips(output) {
  return (
    /\b[1-9]\d*\s+skipped\b/i.test(output) ||
    /\bskipped\s+[1-9]\d*\b/i.test(output)
  );
}

function nestedString(value, keys) {
  let current = value;
  for (const key of keys) {
    if (!isRecord(current)) return "";
    current = current[key];
  }
  return typeof current === "string" ? current : "";
}

function inspectArtifact(
  reportedPath,
  { parseJson = false, allowedRoot = null, missingEvidence, label },
) {
  const observation = {
    path: typeof reportedPath === "string" ? reportedPath : "",
    exists: false,
    sizeBytes: null,
    sha256: null,
    json: null,
  };
  const resolved = resolveReportedPath(reportedPath);
  const allowed = allowedRoot ? path.resolve(allowedRoot) : ROOT;
  if (
    !resolved ||
    (resolved !== allowed && !resolved.startsWith(`${allowed}${path.sep}`))
  ) {
    missingEvidence.push(`${label} path is outside its unique scenario root`);
    return observation;
  }
  if (!existsSync(resolved)) {
    missingEvidence.push(`${label} is missing`);
    return observation;
  }
  const stat = lstatSync(resolved);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    missingEvidence.push(`${label} is not a regular non-symlink file`);
    return observation;
  }
  const real = realpathSync(resolved);
  if (real !== allowed && !real.startsWith(`${allowed}${path.sep}`)) {
    missingEvidence.push(`${label} resolves outside its unique scenario root`);
    return observation;
  }
  const bytes = readFileSync(real);
  observation.exists = true;
  observation.sizeBytes = bytes.length;
  observation.sha256 = sha256(bytes);
  if (parseJson) {
    try {
      observation.json = JSON.parse(bytes.toString("utf8"));
    } catch {
      missingEvidence.push(`${label} is not valid JSON`);
    }
  }
  return observation;
}

function snapshotDirectory(directory) {
  const entries = [];
  function walk(current, relativePrefix) {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort(
      (left, right) => left.name.localeCompare(right.name),
    )) {
      const full = path.join(current, entry.name);
      const relative = relativePrefix
        ? `${relativePrefix}/${entry.name}`
        : entry.name;
      const stat = lstatSync(full);
      if (stat.isSymbolicLink()) {
        throw new Error(`success evidence contains symlink: ${relative}`);
      }
      if (entry.isDirectory()) {
        walk(full, relative);
      } else if (entry.isFile()) {
        const bytes = readFileSync(full);
        entries.push({
          path: relative,
          sizeBytes: bytes.length,
          sha256: sha256(bytes),
        });
      } else {
        throw new Error(`success evidence is not regular: ${relative}`);
      }
    }
  }
  walk(directory, "");
  const encoded = JSON.stringify(entries);
  return {
    entries,
    fileCount: entries.length,
    inventorySha256: sha256(encoded),
  };
}

function snapshotsEqual(left, right) {
  return (
    left.inventorySha256 === right.inventorySha256 &&
    JSON.stringify(left.entries) === JSON.stringify(right.entries)
  );
}

function emptyProbe(nonce) {
  const zero = "0".repeat(64);
  const execution = {
    input: "",
    output: { algorithm: "", digest: "" },
    elapsedMs: 0,
  };
  return {
    schema: "openrappter-live-organ-transplant-probe/1.0",
    nonce,
    collections: {
      fixtures: false,
      process: false,
      gateway: false,
      agent: false,
      executions: false,
      rejection: false,
      flight: false,
      provider: false,
    },
    process: {
      pidBefore: 1,
      pidAfter: 1,
      gatewayReferenceStable: false,
      registryReferenceStable: false,
      registryConstructorCount: 1,
    },
    gateway: {
      serverClass: "",
      registryClass: "",
      authMode: "",
      authorizationScheme: "",
      unauthenticatedStatus: 0,
      unauthenticatedImporterCalls: 0,
      totalImporterCalls: 0,
      acceptedStatus: 0,
      rejectedStatus: 0,
      requestUrls: [],
    },
    fixtures: {
      validPath: "typescript/src/demo/fixtures/checksum_agent.py",
      invalidPath: "typescript/src/demo/fixtures/checksum_agent_invalid.py",
      validSha256: zero,
      invalidSha256: zero,
      manifestValidSha256: null,
      manifestInvalidSha256: null,
    },
    agent: {
      className: "",
      bridgeModule: "",
      sourceFile: "",
      sourceSha256Before: zero,
      sourceSha256After: zero,
      objectReferenceStable: false,
      registryReferenceStable: false,
    },
    executions: {
      first: structuredClone(execution),
      second: structuredClone(execution),
    },
    operationOrder: [],
    rejection: {
      rejectedBeforeCommit: false,
      committed: false,
      targetBytesUnchanged: false,
      targetStatUnchanged: false,
      candidateDiffersFromCommitted: false,
    },
    flight: {
      databasePath: "",
      exportPath: "",
      pathsDistinct: false,
      databaseSha256: zero,
      exportSha256: zero,
      expectedDatabaseSha256: zero,
      expectedExportSha256: zero,
      reopenedQuerySucceeded: false,
      productionValidationPassed: false,
      persistedEventIds: [],
      reopenedEventIds: [],
      productionExportEventIds: [],
      persistedContentHashes: [],
      reopenedContentHashes: [],
      productionExportContentHashes: [],
      allContentHashesValid: false,
      events: [],
      causalStepIds: [],
    },
    provider: {
      manifestModelDependency: "",
      providerEventCount: 0,
      modelEventCount: 0,
    },
  };
}

function parseVitestReport(reportPath, missingEvidence) {
  const fallback = {
    testFile:
      "src/__tests__/integration/live-organ-transplant.integration.test.ts",
    totalTests: 0,
    passedTests: 0,
    failedTests: 0,
    skippedTests: 0,
    exactTestNames: false,
    passedTestNames: [],
  };
  if (!existsSync(reportPath)) {
    missingEvidence.push("independent probe Vitest JSON report is missing");
    return fallback;
  }
  try {
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    const assertions = (report.testResults ?? []).flatMap(
      (suite) => suite.assertionResults ?? [],
    );
    const allNames = assertions.map(
      (assertion) => assertion.fullName ?? assertion.title ?? "",
    );
    const passedNames = assertions
      .filter((assertion) => assertion.status === "passed")
      .map((assertion) => assertion.fullName ?? assertion.title ?? "");
    const skippedTests = assertions.filter(
      (assertion) =>
        assertion.status === "pending" ||
        assertion.status === "skipped" ||
        assertion.status === "todo",
    ).length;
    return {
      testFile:
        "src/__tests__/integration/live-organ-transplant.integration.test.ts",
      totalTests: Number(report.numTotalTests ?? assertions.length),
      passedTests: Number(report.numPassedTests ?? passedNames.length),
      failedTests: Number(
        report.numFailedTests ??
          assertions.filter((assertion) => assertion.status === "failed")
            .length,
      ),
      skippedTests,
      exactTestNames:
        JSON.stringify(allNames) === JSON.stringify(PINNED_PROBE_TEST_NAMES),
      passedTestNames: passedNames,
    };
  } catch (error) {
    missingEvidence.push(
      `independent probe Vitest JSON report is invalid: ${String(error)}`,
    );
    return fallback;
  }
}

function readProbeEvidence(probeOutput, nonce, missingEvidence) {
  if (!existsSync(probeOutput)) {
    missingEvidence.push("independent observer evidence record is missing");
    return emptyProbe(nonce);
  }
  try {
    return JSON.parse(readFileSync(probeOutput, "utf8"));
  } catch (error) {
    missingEvidence.push(
      `independent observer evidence record is invalid: ${String(error)}`,
    );
    return emptyProbe(nonce);
  }
}

function printFailureOutput(label, run) {
  if (run.status === 0 && !run.error) return;
  const output = `${run.stdout}\n${run.stderr}`.trim();
  if (output.length > 0) {
    console.log(`\n--- ${label} output (tail) ---`);
    console.log(output.slice(-4000));
  }
}

function scenarioObservation(nonce, evidenceDirectory, startedEmpty, run) {
  return {
    nonce,
    evidenceDirectory,
    startedEmpty,
    childPid: run.childPid,
    spawnObserved: run.spawnObserved,
    exitObserved: run.exitObserved,
    closeObserved: run.closeObserved,
    timedOut: run.timedOut,
    forcedSettled: run.forcedSettled,
    groupTerminationAttempted: run.groupTerminationAttempted,
    groupTerminationCompleted: run.groupTerminationCompleted,
    pipesDestroyed: run.pipesDestroyed,
    runtimePid: run.runtimePid,
    runtimePidObservedWhileAlive: run.runtimePidObservedWhileAlive,
    runtimeAliveAtObservation: run.runtimeAliveAtObservation,
    runtimePgid: run.runtimePgid,
    runtimeGroupMatches: run.runtimeGroupMatches,
    runtimeAncestryMatches: run.runtimeAncestryMatches,
    runtimeObservedAtMs: run.runtimeObservedAtMs,
    startedAtMs: run.startedAtMs,
    finishedAtMs: run.finishedAtMs,
    elapsedMs: run.elapsedMs,
  };
}

function processSettled(run) {
  return (
    run.childPid !== null &&
    run.spawnObserved &&
    run.exitObserved &&
    (run.closeObserved || run.forcedSettled) &&
    run.groupTerminationAttempted &&
    run.groupTerminationCompleted &&
    run.pipesDestroyed
  );
}

function emptyCausalWitness() {
  return {
    databaseReopened: false,
    productionExportValidated: false,
    databaseEvents: [],
    persistedExportEvents: [],
    reopenedExportEvents: [],
    validatorEvents: [],
  };
}

function inspectRuntimePidHandoff(
  handoffPath,
  nonce,
  successDirectory,
  successRun,
  missingEvidence,
) {
  const artifact = inspectArtifact(handoffPath, {
    parseJson: true,
    allowedRoot: successDirectory,
    missingEvidence,
    label: "runtime PID handoff",
  });
  const observation = {
    path: handoffPath,
    exists: artifact.exists,
    sha256: artifact.sha256,
    schema: "",
    nonce: "",
    pid: null,
  };
  const payload = artifact.json;
  const resolved = resolveReportedPath(handoffPath);
  const fileStat =
    resolved && existsSync(resolved) ? lstatSync(resolved) : null;
  if (
    !fileStat ||
    fileStat.mtimeMs < successRun.startedAtMs - 1_000 ||
    fileStat.mtimeMs > successRun.finishedAtMs + 1_000
  ) {
    missingEvidence.push(
      "runtime PID handoff was not freshly created during the exact command",
    );
  }
  if (
    !isRecord(payload) ||
    Object.keys(payload).sort().join(",") !== "nonce,pid,schema" ||
    payload.schema !== "openrappter-runtime-pid/1.0" ||
    payload.nonce !== nonce ||
    !Number.isInteger(payload.pid) ||
    payload.pid <= 0
  ) {
    missingEvidence.push(
      "runtime PID handoff must be exact schema/nonce/positive PID JSON",
    );
    return observation;
  }
  observation.schema = payload.schema;
  observation.nonce = payload.nonce;
  observation.pid = payload.pid;
  return observation;
}

async function reopenExactCommandFlight(
  Ledger,
  databaseObservation,
  exportObservation,
  traceId,
  witnessDirectory,
  missingEvidence,
) {
  if (
    !databaseObservation.exists ||
    !exportObservation.exists ||
    databaseObservation.path === exportObservation.path
  ) {
    missingEvidence.push(
      "exact command Flight database/export are unavailable or aliased",
    );
    return emptyCausalWitness();
  }
  mkdirSync(witnessDirectory, { recursive: false, mode: 0o700 });
  const databaseCopy = path.join(witnessDirectory, "exact-command.db");
  const exportCopy = path.join(witnessDirectory, "exact-command.json");
  copyFileSync(resolveReportedPath(databaseObservation.path), databaseCopy);
  copyFileSync(resolveReportedPath(exportObservation.path), exportCopy);
  if (
    hashFile(databaseCopy) !== databaseObservation.sha256 ||
    hashFile(exportCopy) !== exportObservation.sha256
  ) {
    missingEvidence.push("frozen Flight witness copy hash mismatch");
    return emptyCausalWitness();
  }

  const persisted = JSON.parse(readFileSync(exportCopy, "utf8"));
  const reopened = new Ledger({ databasePath: databaseCopy });
  const validator = new Ledger({ inMemory: true });
  try {
    await reopened.initialize();
    const allEvents = await reopened.query({ limit: 10_000 });
    const databaseEvents = traceId
      ? await reopened.query({ traceId, order: "asc", limit: 10_000 })
      : [];
    const reopenedExport = await reopened.export(traceId ? { traceId } : {});
    await validator.initialize();
    const imported = await validator.import(persisted);
    const validatorEvents = traceId
      ? await validator.query({ traceId, order: "asc", limit: 10_000 })
      : [];
    const persistedEvents = Array.isArray(persisted.events)
      ? persisted.events
      : [];
    return {
      databaseReopened:
        traceId.length > 0 &&
        allEvents.length === databaseEvents.length &&
        allEvents.every((event) => event.traceId === traceId),
      productionExportValidated:
        imported === validatorEvents.length &&
        JSON.stringify(persistedEvents) === JSON.stringify(validatorEvents) &&
        JSON.stringify(persistedEvents) ===
          JSON.stringify(reopenedExport.events),
      databaseEvents,
      persistedExportEvents: persistedEvents,
      reopenedExportEvents: reopenedExport.events,
      validatorEvents,
    };
  } catch (error) {
    missingEvidence.push(
      `exact command Flight reopen/validation failed: ${String(error)}`,
    );
    return emptyCausalWitness();
  } finally {
    await Promise.allSettled([reopened.close(), validator.close()]);
  }
}

function pruneFailedGateRuns(evidenceBase, keep = 5) {
  const failedRuns = readdirSync(evidenceBase, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        entry.name.startsWith("gate-") &&
        existsSync(path.join(evidenceBase, entry.name, ".gate-failed")),
    )
    .map((entry) => {
      const fullPath = path.join(evidenceBase, entry.name);
      return { fullPath, mtimeMs: lstatSync(fullPath).mtimeMs };
    })
    .sort((left, right) => right.mtimeMs - left.mtimeMs);
  for (const stale of failedRuns.slice(keep)) {
    rmSync(stale.fullPath, { recursive: true, force: true });
  }
}

export function finalizeGateRunRoot(runRoot, failedNames) {
  if (!runRoot) return null;
  rmSync(path.join(runRoot, ".gate-active"), { force: true });
  if (failedNames.length === 0) {
    rmSync(runRoot, { recursive: true, force: true });
    return null;
  }
  const failedMarker = path.join(runRoot, ".gate-failed");
  if (!existsSync(failedMarker)) {
    writeFileSync(
      failedMarker,
      JSON.stringify({
        failedAt: new Date().toISOString(),
        failedChecks: failedNames,
      }),
      { flag: "wx", mode: 0o600 },
    );
  }
  return runRoot;
}

let gateRunRoot = "";

async function main() {
  let manifest;
  try {
    manifest = readManifest();
    req("manifest is readable and structurally runnable", true, MANIFEST_PATH);
  } catch (error) {
    req("manifest is readable and structurally runnable", false, String(error));
    return;
  }
  const platformSupported = manifest.supportedPlatforms.includes(
    process.platform,
  );
  req(
    "host platform is supported",
    platformSupported,
    platformSupported
      ? `${process.platform} (macOS/Linux/WSL scope)`
      : `${process.platform} is unsupported; native Windows is deferred`,
  );
  if (!platformSupported) return;

  const workingDirectory = resolveInsideRoot(manifest.command.workingDirectory);
  const evidenceBase = resolveInsideRoot(manifest.artifacts.evidenceRoot);
  if (!workingDirectory || !evidenceBase) {
    req(
      "manifest paths stay inside repository",
      false,
      "working directory or evidence root escaped",
    );
    return;
  }
  req("manifest paths stay inside repository", true);

  const buildRun = await runProcess(
    "npm",
    ["run", "build:server", "--silent"],
    {
      cwd: TYPESCRIPT_ROOT,
      environment: {},
      timeoutMs: BUILD_HARD_DEADLINE_MS,
    },
  );
  req(
    "preflight build produced the evaluator",
    buildRun.status === 0 && !buildRun.error && existsSync(CONTRACT_PATH),
    buildRun.error?.message ?? `exit=${buildRun.status}`,
  );
  if (buildRun.status !== 0 || buildRun.error || !existsSync(CONTRACT_PATH)) {
    printFailureOutput("preflight build", buildRun);
    return;
  }

  const trustedHashes = trustedFileHashes();
  let contract;
  try {
    contract = await import(
      `${pathToFileURL(CONTRACT_PATH).href}?trusted=${trustedHashes.contract}`
    );
    req("compiled evaluator loaded before process under test", true);
  } catch (error) {
    req(
      "compiled evaluator loaded before process under test",
      false,
      String(error),
    );
    return;
  }

  const moduleIdsPinned =
    JSON.stringify(contract.REQUIRED_TRANSPLANT_CHECK_IDS) ===
    JSON.stringify(PINNED_CHECK_IDS);
  const nullEvaluationIds = contract
    .evaluateLiveOrganTransplant({
      manifest: null,
      result: null,
      missingPythonResult: null,
      observations: null,
    })
    .checks.map((entry) => entry.id);
  const evaluatorIdsPinned =
    JSON.stringify(nullEvaluationIds) === JSON.stringify(PINNED_CHECK_IDS);
  req(
    "trusted evaluator matches literal gate-owned check IDs",
    moduleIdsPinned && evaluatorIdsPinned,
    `${nullEvaluationIds.length}/${PINNED_CHECK_IDS.length} checks`,
  );
  req(
    "compiled evaluator hash pinned before process under test",
    /^[0-9a-f]{64}$/.test(trustedHashes.contract),
    trustedHashes.contract,
  );
  const moduleProbeNamesPinned =
    JSON.stringify(contract.REQUIRED_TRANSPLANT_PROBE_TEST_NAMES) ===
    JSON.stringify(PINNED_PROBE_TEST_NAMES);
  req(
    "trusted evaluator matches literal gate-owned probe test names",
    moduleProbeNamesPinned,
    `${PINNED_PROBE_TEST_NAMES.length} tests`,
  );
  req(
    "resolved Vitest entrypoint and installed package trees are pinned",
    [
      trustedHashes.vitestEntrypoint,
      trustedHashes.vitestPackageTree,
      trustedHashes.vitestSupportTree,
      trustedHashes.vitePackageTree,
    ].every((hash) => /^[0-9a-f]{64}$/.test(hash)),
  );

  let TrustedLedger;
  try {
    const ledgerModule = await import(
      `${pathToFileURL(path.join(TYPESCRIPT_ROOT, "dist", "flight-recorder", "ledger.js")).href}?trusted=${trustedHashes.compiledTree}`
    );
    TrustedLedger = ledgerModule.SQLiteFlightLedger;
  } catch (error) {
    req(
      "trusted production Flight ledger loaded before scenarios",
      false,
      String(error),
    );
    return;
  }
  req(
    "trusted production Flight ledger loaded before scenarios",
    typeof TrustedLedger === "function",
  );

  mkdirSync(evidenceBase, { recursive: true, mode: 0o700 });
  pruneFailedGateRuns(evidenceBase);
  const runRoot = path.join(evidenceBase, `gate-${Date.now()}-${randomUUID()}`);
  mkdirSync(runRoot, { recursive: false, mode: 0o700 });
  gateRunRoot = runRoot;
  writeFileSync(
    path.join(runRoot, ".gate-active"),
    JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
    { flag: "wx", mode: 0o600 },
  );
  const successDirectory = path.join(runRoot, "success");
  const missingDirectory = path.join(runRoot, "missing-python");
  const probeDirectory = path.join(runRoot, "independent-probe");
  const witnessDirectory = path.join(runRoot, "exact-command-witness");
  const missingEvidence = [];
  const skippedEvidence = [];
  const phaseTracker = new GatePhaseTracker();
  const probeNonce = randomUUID();
  const successNonce = randomUUID();
  const missingNonce = randomUUID();

  const validFixture = inspectArtifact(manifest.fixture.bundledPath, {
    missingEvidence,
    label: "bundled valid fixture",
  });
  const invalidFixture = inspectArtifact(manifest.fixture.invalidBundledPath, {
    missingEvidence,
    label: "bundled invalid fixture",
  });

  mkdirSync(probeDirectory, { recursive: false, mode: 0o700 });
  const probeStartedEmpty = directoryIsEmpty(probeDirectory);
  const probeReportPath = path.join(probeDirectory, "vitest-report.json");
  const probeOutputPath = path.join(probeDirectory, "observer-evidence.json");
  const probeStateDirectory = path.join(probeDirectory, "state");
  mkdirSync(probeStateDirectory, { recursive: false, mode: 0o700 });
  phaseTracker.enter("independent-probe");
  const probeRun = await runProcess(
    process.execPath,
    [
      VITEST_ENTRYPOINT,
      "run",
      "src/__tests__/integration/live-organ-transplant.integration.test.ts",
      "--reporter=json",
      `--outputFile=${probeReportPath}`,
    ],
    {
      cwd: TYPESCRIPT_ROOT,
      environment: {
        OPENRAPPTER_TRANSPLANT_SCENARIO_NONCE: probeNonce,
        OPENRAPPTER_TRANSPLANT_PROBE_OUTPUT: probeOutputPath,
        OPENRAPPTER_TRANSPLANT_PROBE_STATE_DIRECTORY: probeStateDirectory,
        OPENRAPPTER_HOME: path.join(probeDirectory, "home"),
      },
      timeoutMs: DEMO_HARD_DEADLINE_MS,
    },
  );
  const probeReport = parseVitestReport(probeReportPath, missingEvidence);
  const independentProbe = readProbeEvidence(
    probeOutputPath,
    probeNonce,
    missingEvidence,
  );
  req(
    "exact independent integration test ran before demo with machine-readable output",
    probeReport.totalTests === PINNED_PROBE_TEST_NAMES.length &&
      probeReport.exactTestNames,
    `${probeReport.passedTests}/${probeReport.totalTests} passed`,
  );
  req(
    "independent integration test has zero failures and zero skips",
    probeRun.status === 0 &&
      probeReport.failedTests === 0 &&
      probeReport.skippedTests === 0 &&
      probeReport.passedTests === PINNED_PROBE_TEST_NAMES.length,
    `exit=${probeRun.status}, failed=${probeReport.failedTests}, skipped=${probeReport.skippedTests}`,
  );
  req(
    "independent probe direct child and known process group settled",
    processSettled(probeRun),
    `pid=${probeRun.childPid}, exit=${probeRun.exitObserved}, close=${probeRun.closeObserved}, forced=${probeRun.forcedSettled}`,
  );
  const hashesAfterProbe = trustedFileHashes();
  req(
    "trusted judge and installed test runner trees are unchanged immediately after probe",
    hashesMatch(trustedHashes, hashesAfterProbe),
  );

  mkdirSync(successDirectory, { recursive: false, mode: 0o700 });
  const successStartedEmpty = directoryIsEmpty(successDirectory);
  const runtimePidHandoffPath = path.join(
    successDirectory,
    manifest.artifacts.runtimePidHandoffFilename,
  );
  req(
    "runtime PID handoff path is absent before exact command",
    !existsSync(runtimePidHandoffPath),
    runtimePidHandoffPath,
  );
  phaseTracker.enter("success-command");
  const successRun = await runProcess(
    manifest.command.executable,
    manifest.command.args,
    {
      cwd: workingDirectory,
      environment: {
        [manifest.artifacts.directoryEnvironmentVariable]: successDirectory,
        [manifest.artifacts.nonceEnvironmentVariable]: successNonce,
        [manifest.artifacts.runtimePidHandoffEnvironmentVariable]:
          runtimePidHandoffPath,
        OPENRAPPTER_HOME: path.join(successDirectory, "home"),
      },
      timeoutMs: Math.min(
        manifest.runtimeLimits.demoMaxElapsedMs,
        DEMO_HARD_DEADLINE_MS,
      ),
      runtimePidHandoffPath,
      runtimePidNonce: successNonce,
    },
  );
  const successRecord = parseRecord(successRun);
  const hashesAfterSuccess = trustedFileHashes();
  req(
    "trusted gate, evaluator, observer, manifest, and command bytes unchanged immediately after success",
    hashesMatch(trustedHashes, hashesAfterSuccess),
  );
  req(
    "literal success command met the independent 30-second deadline",
    !successRun.error &&
      !successRun.timedOut &&
      successRun.elapsedMs <= DEMO_HARD_DEADLINE_MS,
    successRun.error?.message ?? `${successRun.elapsedMs}ms`,
  );
  req(
    "success direct child and known process group settled",
    processSettled(successRun),
    `pid=${successRun.childPid}, exit=${successRun.exitObserved}, close=${successRun.closeObserved}, forced=${successRun.forcedSettled}`,
  );
  req(
    "literal success command exited zero",
    successRun.status === 0,
    `exit=${successRun.status}`,
  );
  req(
    "success command emitted exactly one stdout record",
    successRecord.stdoutCount === 1 &&
      successRecord.stderrCount === 0 &&
      successRecord.error === "",
    successRecord.error || "one stdout record",
  );

  if (successRecord.error) missingEvidence.push(successRecord.error);
  if (hasNonzeroSkips(`${successRun.stdout}\n${successRun.stderr}`)) {
    skippedEvidence.push("success command reported a nonzero skipped count");
  }
  let successCanonical = false;
  try {
    successCanonical =
      successRecord.line ===
      `${RESULT_PREFIX}${contract.canonicalJson(successRecord.value)}`;
  } catch {
    successCanonical = false;
  }
  if (!successCanonical) {
    missingEvidence.push("success record is not canonical");
  }

  let frozenSuccess;
  let successFreezeCaptured = true;
  try {
    frozenSuccess = snapshotDirectory(successDirectory);
  } catch (error) {
    successFreezeCaptured = false;
    missingEvidence.push(
      `success evidence could not be frozen: ${String(error)}`,
    );
    frozenSuccess = {
      entries: [],
      fileCount: 0,
      inventorySha256: sha256("[]"),
    };
  }

  const databasePath = nestedString(successRecord.value, [
    "flightRecorder",
    "database",
    "path",
  ]);
  const exportPath = nestedString(successRecord.value, [
    "flightRecorder",
    "export",
    "path",
  ]);
  const resultTraceId = nestedString(successRecord.value, [
    "flightRecorder",
    "traceId",
  ]);
  const flightDatabase = inspectArtifact(databasePath, {
    allowedRoot: successDirectory,
    missingEvidence,
    label: "Flight Recorder database",
  });
  const flightExport = inspectArtifact(exportPath, {
    parseJson: true,
    allowedRoot: successDirectory,
    missingEvidence,
    label: "Flight Recorder export",
  });
  const runtimePath =
    contract.TRANSPLANT_RUNTIME_ENTRYPOINT ??
    "typescript/dist/demo/live-organ-transplant.js";
  const runtimeEntrypoint = inspectArtifact(runtimePath, {
    missingEvidence,
    label: "compiled runtime entrypoint",
  });

  const runtimePidHandoff = inspectRuntimePidHandoff(
    runtimePidHandoffPath,
    successNonce,
    successDirectory,
    successRun,
    missingEvidence,
  );
  const exactCommandFlight = await reopenExactCommandFlight(
    TrustedLedger,
    flightDatabase,
    flightExport,
    resultTraceId,
    witnessDirectory,
    missingEvidence,
  );

  let unchangedAfterCausalRead = false;
  try {
    unchangedAfterCausalRead = snapshotsEqual(
      frozenSuccess,
      snapshotDirectory(successDirectory),
    );
  } catch (error) {
    missingEvidence.push(
      `success evidence changed or became unreadable after causal read: ${String(error)}`,
    );
  }

  mkdirSync(missingDirectory, { recursive: false, mode: 0o700 });
  const missingStartedEmpty = directoryIsEmpty(missingDirectory);
  const controlledMissingExecutable = path.join(
    missingDirectory,
    manifest.missingPython.executableBasename,
  );
  const missingDirectoryEmptyImmediatelyBefore =
    directoryIsEmpty(missingDirectory);
  const missingExecutableAbsentImmediatelyBefore = !existsSync(
    controlledMissingExecutable,
  );
  req(
    "empty missing-Python state and absent interpreter rechecked immediately before scenario",
    missingDirectoryEmptyImmediatelyBefore &&
      missingExecutableAbsentImmediatelyBefore,
    controlledMissingExecutable,
  );
  phaseTracker.enter("missing-python-command");
  const missingPythonRun = await runProcess(
    manifest.command.executable,
    manifest.command.args,
    {
      cwd: workingDirectory,
      environment: {
        [manifest.artifacts.directoryEnvironmentVariable]: missingDirectory,
        [manifest.artifacts.nonceEnvironmentVariable]: missingNonce,
        [manifest.missingPython.environmentVariable]:
          controlledMissingExecutable,
        OPENRAPPTER_HOME: path.join(missingDirectory, "home"),
      },
      timeoutMs: Math.min(
        manifest.runtimeLimits.demoMaxElapsedMs,
        DEMO_HARD_DEADLINE_MS,
      ),
    },
  );
  const missingPythonRecord = parseRecord(missingPythonRun);
  req(
    "literal missing-Python command met the independent 30-second deadline",
    !missingPythonRun.error &&
      !missingPythonRun.timedOut &&
      missingPythonRun.elapsedMs <= DEMO_HARD_DEADLINE_MS,
    missingPythonRun.error?.message ?? `${missingPythonRun.elapsedMs}ms`,
  );
  req(
    "missing-Python direct child and known process group settled",
    processSettled(missingPythonRun),
    `pid=${missingPythonRun.childPid}, exit=${missingPythonRun.exitObserved}, close=${missingPythonRun.closeObserved}, forced=${missingPythonRun.forcedSettled}`,
  );
  req(
    "literal missing-Python command used the controlled nonzero exit",
    missingPythonRun.status === manifest.missingPython.expectedExitCode &&
      manifest.missingPython.expectedExitCode !== 0,
    `exit=${missingPythonRun.status}`,
  );
  req(
    "missing-Python command emitted exactly one stdout record",
    missingPythonRecord.stdoutCount === 1 &&
      missingPythonRecord.stderrCount === 0 &&
      missingPythonRecord.error === "",
    missingPythonRecord.error || "one stdout record",
  );
  if (missingPythonRecord.error) {
    missingEvidence.push(missingPythonRecord.error);
  }
  if (
    hasNonzeroSkips(`${missingPythonRun.stdout}\n${missingPythonRun.stderr}`)
  ) {
    skippedEvidence.push(
      "missing-Python command reported a nonzero skipped count",
    );
  }
  let missingCanonical = false;
  try {
    missingCanonical =
      missingPythonRecord.line ===
      `${RESULT_PREFIX}${contract.canonicalJson(missingPythonRecord.value)}`;
  } catch {
    missingCanonical = false;
  }
  if (!missingCanonical) {
    missingEvidence.push("missing-Python record is not canonical");
  }

  let unchangedAfterMissing = false;
  try {
    unchangedAfterMissing = snapshotsEqual(
      frozenSuccess,
      snapshotDirectory(successDirectory),
    );
  } catch (error) {
    missingEvidence.push(
      `success evidence changed or became unreadable after missing-Python run: ${String(error)}`,
    );
  }
  req(
    "later scenarios did not replace frozen success evidence",
    unchangedAfterCausalRead && unchangedAfterMissing,
    frozenSuccess.inventorySha256,
  );
  req(
    "gate executed probe, success, and missing-Python in literal order",
    phaseTracker.complete(),
    TRANSPLANT_GATE_PHASE_ORDER.join(" -> "),
  );

  const postHashes = existsSync(CONTRACT_PATH)
    ? trustedFileHashes()
    : { ...trustedHashes, contract: "" };
  req(
    "trusted evaluator bytes unchanged after processes under test",
    postHashes.contract === trustedHashes.contract,
    postHashes.contract,
  );
  req(
    "pinned observer, manifest, and public command bytes unchanged",
    hashesMatch(trustedHashes, postHashes),
  );

  const observations = {
    executedCommand: manifest.command.display,
    successExitCode: successRun.status,
    missingPythonExitCode: missingPythonRun.status,
    successRecordCount: successRecord.count,
    missingPythonRecordCount: missingPythonRecord.count,
    successRecordCanonical: successCanonical,
    missingPythonRecordCanonical: missingCanonical,
    controlledMissingPythonExecutable: controlledMissingExecutable,
    probeScenario: scenarioObservation(
      probeNonce,
      probeDirectory,
      probeStartedEmpty,
      probeRun,
    ),
    successScenario: scenarioObservation(
      successNonce,
      successDirectory,
      successStartedEmpty,
      successRun,
    ),
    missingPythonScenario: scenarioObservation(
      missingNonce,
      missingDirectory,
      missingStartedEmpty && missingDirectoryEmptyImmediatelyBefore,
      missingPythonRun,
    ),
    frozenSuccessEvidence: {
      captured: successFreezeCaptured,
      fileCount: frozenSuccess.fileCount,
      inventorySha256: frozenSuccess.inventorySha256,
      unchangedAfterCausalRead,
      unchangedAfterMissingPython: unchangedAfterMissing,
    },
    artifacts: {
      runtimeEntrypoint,
      flightDatabase,
      flightExport,
      runtimePidHandoff,
      validFixture,
      invalidFixture,
    },
    exactCommandFlight,
    probeReport,
    independentProbe,
    missingEvidence,
    skippedEvidence,
  };

  const manifestValid = contract.isLiveOrganTransplantManifest(manifest);
  req(
    "manifest satisfies the trusted compiled strict schema",
    manifestValid,
    manifestValid ? manifest.schema : "strict schema mismatch",
  );
  const evaluation = contract.evaluateLiveOrganTransplant({
    manifest,
    result: successRecord.value,
    missingPythonResult: missingPythonRecord.value,
    observations,
  });
  const returnedIds = evaluation.checks.map((entry) => entry.id);
  req(
    "evaluator returned the literal gate-owned check surface",
    JSON.stringify(returnedIds) === JSON.stringify(PINNED_CHECK_IDS),
    `${returnedIds.length}/${PINNED_CHECK_IDS.length} checks`,
  );
  for (const entry of evaluation.checks) {
    req(entry.id, entry.pass, entry.detail);
  }

  printFailureOutput("success command", successRun);
  printFailureOutput("independent integration probe", probeRun);
  printFailureOutput("missing-Python command", missingPythonRun);
}

async function runGateCli() {
  try {
    await main();
  } catch (error) {
    req("gate completed without crashing", false, String(error));
  }

  const failed = results.filter((entry) => !entry.pass);
  const preservedEvidencePath = finalizeGateRunRoot(
    gateRunRoot,
    failed.map((entry) => entry.name),
  );
  gateRunRoot = preservedEvidencePath ?? "";
  if (preservedEvidencePath) {
    console.log(`\nPRESERVED FAILED GATE EVIDENCE: ${preservedEvidencePath}`);
  }

  console.log(`\n${"=".repeat(72)}`);
  console.log(
    failed.length === 0
      ? `LIVE ORGAN TRANSPLANT ACCEPTED — ${results.length}/${results.length} pass`
      : `LIVE ORGAN TRANSPLANT NOT ACCEPTED — ${failed.length} of ${results.length} failing`,
  );
  console.log("=".repeat(72));
  console.log(
    `${GATE_REPORT_PREFIX}${JSON.stringify({
      schema: "openrappter-live-organ-transplant-gate/1.0",
      pass: failed.length === 0,
      total: results.length,
      failed: failed.map((entry) => entry.name),
      evidencePath: gateRunRoot || null,
      checks: results,
    })}`,
  );
  return failed.length === 0 ? 0 : 1;
}

const invokedDirectly =
  typeof process.argv[1] === "string" &&
  path.resolve(process.argv[1]) === path.resolve(GATE_PATH);
if (invokedDirectly) {
  process.exit(await runGateCli());
}
