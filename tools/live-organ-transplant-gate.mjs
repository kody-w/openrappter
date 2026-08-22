#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const RESULT_PREFIX = "OPENRAPPTER_TRANSPLANT_RESULT=";
const ABSOLUTE_HARD_DEADLINE_MS = 180_000;
const MAX_CAPTURE_BYTES = 10 * 1024 * 1024;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST_PATH = path.join(
  ROOT,
  "typescript",
  "src",
  "demo",
  "live-organ-transplant.manifest.json",
);
const CONTRACT_PATH = path.join(
  ROOT,
  "typescript",
  "dist",
  "demo",
  "live-organ-transplant-contract.js",
);
const results = [];

function req(name, pass, detail = "") {
  results.push({ name, pass: Boolean(pass), detail });
  console.log(
    `${pass ? " PASS" : "*FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`,
  );
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readManifest() {
  const parsed = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
  if (
    !isRecord(parsed) ||
    !isRecord(parsed.command) ||
    typeof parsed.command.executable !== "string" ||
    !Array.isArray(parsed.command.args) ||
    !parsed.command.args.every((entry) => typeof entry === "string") ||
    typeof parsed.command.display !== "string" ||
    typeof parsed.command.workingDirectory !== "string" ||
    !isRecord(parsed.runtimeLimits) ||
    !Number.isInteger(parsed.runtimeLimits.commandTimeoutMs) ||
    !Number.isInteger(parsed.runtimeLimits.missingPythonTimeoutMs) ||
    !isRecord(parsed.missingPython) ||
    typeof parsed.missingPython.environmentVariable !== "string" ||
    typeof parsed.missingPython.executable !== "string" ||
    !Number.isInteger(parsed.missingPython.expectedExitCode) ||
    !isRecord(parsed.artifacts) ||
    typeof parsed.artifacts.evidenceRoot !== "string"
  ) {
    throw new Error(
      "Manifest command, limits, or missing-Python scenario is invalid.",
    );
  }
  return parsed;
}

function resolveInsideRoot(relativePath) {
  if (typeof relativePath !== "string" || path.isAbsolute(relativePath)) {
    return null;
  }
  const resolved = path.resolve(ROOT, relativePath);
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

function boundedDeadline(value) {
  return Math.min(Math.max(1, value), ABSOLUTE_HARD_DEADLINE_MS);
}

function runScenario(manifest, environment, timeoutMs) {
  const cwd = resolveInsideRoot(manifest.command.workingDirectory);
  if (!cwd) {
    return {
      status: null,
      stdout: "",
      stderr: "",
      elapsedMs: 0,
      error: new Error("Manifest working directory escapes the repository."),
    };
  }
  const started = performance.now();
  const child = spawnSync(manifest.command.executable, manifest.command.args, {
    cwd,
    env: {
      ...process.env,
      CI: "1",
      ...environment,
    },
    encoding: "utf8",
    timeout: boundedDeadline(timeoutMs),
    maxBuffer: MAX_CAPTURE_BYTES,
    shell: false,
  });
  return {
    status: typeof child.status === "number" ? child.status : null,
    stdout: child.stdout ?? "",
    stderr: child.stderr ?? "",
    elapsedMs: Math.ceil(performance.now() - started),
    error: child.error ?? null,
  };
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
    path: reportedPath,
    exists: false,
    sizeBytes: null,
    sha256: null,
    json: null,
  };
  const resolved = resolveInsideRoot(reportedPath);
  const allowed = allowedRoot ? resolveInsideRoot(allowedRoot) : ROOT;
  if (
    !resolved ||
    !allowed ||
    (resolved !== allowed && !resolved.startsWith(`${allowed}${path.sep}`))
  ) {
    missingEvidence.push(`${label} path is outside its allowed root`);
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
    missingEvidence.push(`${label} resolves outside its allowed root`);
    return observation;
  }
  const bytes = readFileSync(real);
  observation.exists = true;
  observation.sizeBytes = bytes.length;
  observation.sha256 = createHash("sha256").update(bytes).digest("hex");
  if (parseJson) {
    try {
      observation.json = JSON.parse(bytes.toString("utf8"));
    } catch {
      missingEvidence.push(`${label} is not valid JSON`);
    }
  }
  return observation;
}

function printFailureOutput(label, run) {
  if (run.status === 0 && !run.error) return;
  const output = `${run.stdout}\n${run.stderr}`.trim();
  if (output.length > 0) {
    console.log(`\n--- ${label} output (tail) ---`);
    console.log(output.slice(-4000));
  }
}

let manifest;
try {
  manifest = readManifest();
  req("manifest is readable and structurally runnable", true, MANIFEST_PATH);
} catch (error) {
  req("manifest is readable and structurally runnable", false, String(error));
  console.log("\nLIVE ORGAN TRANSPLANT NOT ACCEPTED — manifest unavailable");
  process.exit(1);
}

const workingDirectory = resolveInsideRoot(manifest.command.workingDirectory);
const missingExecutable = workingDirectory
  ? path.resolve(workingDirectory, manifest.missingPython.executable)
  : "";
req(
  "controlled missing-Python executable is genuinely absent",
  Boolean(missingExecutable) && !existsSync(missingExecutable),
  manifest.missingPython.executable,
);

const successRun = runScenario(
  manifest,
  {},
  manifest.runtimeLimits.commandTimeoutMs,
);
const missingPythonRun = runScenario(
  manifest,
  {
    [manifest.missingPython.environmentVariable]:
      manifest.missingPython.executable,
  },
  manifest.runtimeLimits.missingPythonTimeoutMs,
);
const successRecord = parseRecord(successRun);
const missingPythonRecord = parseRecord(missingPythonRun);
const combinedOutput =
  `${successRun.stdout}\n${successRun.stderr}\n` +
  `${missingPythonRun.stdout}\n${missingPythonRun.stderr}`;
const outputHasSkips = hasNonzeroSkips(combinedOutput);

req(
  "literal success command met its hard deadline",
  !successRun.error,
  successRun.error ? successRun.error.message : `${successRun.elapsedMs}ms`,
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
req(
  "literal missing-Python command met its hard deadline",
  !missingPythonRun.error,
  missingPythonRun.error
    ? missingPythonRun.error.message
    : `${missingPythonRun.elapsedMs}ms`,
);
req(
  "literal missing-Python command used the controlled exit",
  missingPythonRun.status === manifest.missingPython.expectedExitCode,
  `exit=${missingPythonRun.status}`,
);
req(
  "missing-Python command emitted exactly one stdout record",
  missingPythonRecord.stdoutCount === 1 &&
    missingPythonRecord.stderrCount === 0 &&
    missingPythonRecord.error === "",
  missingPythonRecord.error || "one stdout record",
);
req(
  "command output contains zero nonzero skipped counts",
  !outputHasSkips,
  outputHasSkips ? "unexpected skipped checks reported" : "none",
);

let contract = null;
try {
  contract = await import(
    `${pathToFileURL(CONTRACT_PATH).href}?gate=${Date.now()}`
  );
  req("compiled contract evaluator is available", true, CONTRACT_PATH);
} catch (error) {
  req("compiled contract evaluator is available", false, String(error));
}

if (contract) {
  const manifestValid = contract.isLiveOrganTransplantManifest(manifest);
  req(
    "manifest satisfies the compiled strict schema",
    manifestValid,
    manifestValid ? manifest.schema : "strict schema mismatch",
  );

  let successCanonical = false;
  let missingCanonical = false;
  try {
    successCanonical =
      successRecord.line ===
      `${RESULT_PREFIX}${contract.canonicalJson(successRecord.value)}`;
  } catch {
    successCanonical = false;
  }
  try {
    missingCanonical =
      missingPythonRecord.line ===
      `${RESULT_PREFIX}${contract.canonicalJson(missingPythonRecord.value)}`;
  } catch {
    missingCanonical = false;
  }

  const missingEvidence = [];
  const skippedEvidence = outputHasSkips
    ? ["command output reported a nonzero skipped count"]
    : [];
  if (successRecord.error) missingEvidence.push(successRecord.error);
  if (missingPythonRecord.error)
    missingEvidence.push(missingPythonRecord.error);
  if (!successCanonical)
    missingEvidence.push("success record is not canonical");
  if (!missingCanonical) {
    missingEvidence.push("missing-Python record is not canonical");
  }

  const evidenceRoot = manifest.artifacts.evidenceRoot;
  const runtimePath = contract.TRANSPLANT_RUNTIME_ENTRYPOINT;
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
  const observations = {
    executedCommand: manifest.command.display,
    successExitCode: successRun.status,
    missingPythonExitCode: missingPythonRun.status,
    successRecordCount: successRecord.count,
    missingPythonRecordCount: missingPythonRecord.count,
    successRecordCanonical: successCanonical,
    missingPythonRecordCanonical: missingCanonical,
    successElapsedMs: successRun.elapsedMs,
    missingPythonElapsedMs: missingPythonRun.elapsedMs,
    artifacts: {
      runtimeEntrypoint: inspectArtifact(runtimePath, {
        missingEvidence,
        label: "compiled runtime entrypoint",
      }),
      flightDatabase: inspectArtifact(databasePath, {
        allowedRoot: evidenceRoot,
        missingEvidence,
        label: "Flight Recorder database",
      }),
      flightExport: inspectArtifact(exportPath, {
        parseJson: true,
        allowedRoot: evidenceRoot,
        missingEvidence,
        label: "Flight Recorder export",
      }),
    },
    missingEvidence,
    skippedEvidence,
  };

  const evaluation = contract.evaluateLiveOrganTransplant({
    manifest,
    result: successRecord.value,
    missingPythonResult: missingPythonRecord.value,
    observations,
  });
  const returnedIds = evaluation.checks.map((entry) => entry.id);
  req(
    "evaluator returned the complete pinned check surface",
    JSON.stringify(returnedIds) ===
      JSON.stringify(contract.REQUIRED_TRANSPLANT_CHECK_IDS),
    `${returnedIds.length} checks`,
  );
  for (const entry of evaluation.checks) {
    req(entry.id, entry.pass, entry.detail);
  }
}

printFailureOutput("success command", successRun);
printFailureOutput("missing-Python command", missingPythonRun);

const failed = results.filter((entry) => !entry.pass);
console.log(`\n${"=".repeat(72)}`);
console.log(
  failed.length === 0
    ? `LIVE ORGAN TRANSPLANT ACCEPTED — ${results.length}/${results.length} pass`
    : `LIVE ORGAN TRANSPLANT NOT ACCEPTED — ${failed.length} of ${results.length} failing`,
);
console.log("=".repeat(72));
process.exit(failed.length === 0 ? 0 : 1);
