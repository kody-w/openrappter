#!/usr/bin/env node
/**
 * Acceptance gate for OpenRappter Flight Recorder v1.
 *
 * This is the definition of "done" for openrappter#145. It never converts
 * "cannot measure" into a skip: missing files, missing dependencies, a crashed
 * test runner, or a skipped mutation probe all fail the gate.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TS = path.join(ROOT, "typescript");
const PY = path.join(ROOT, "python");
const results = [];

function req(name, pass, detail = "") {
  results.push({ name, pass: Boolean(pass), detail });
  console.log(
    `${pass ? " PASS" : "*FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`,
  );
}

function hasNonzeroSkips(output) {
  return (
    /\b[1-9]\d*\s+skipped\b/i.test(output) ||
    /\bskipped\s+[1-9]\d*\b/i.test(output)
  );
}

function run(name, command, args, cwd = TS) {
  const r = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    timeout: 600_000,
    env: { ...process.env, CI: "1" },
  });
  const out = `${r.stdout ?? ""}\n${r.stderr ?? ""}`.trim();
  const hasSkippedChecks = hasNonzeroSkips(out);
  req(
    name,
    !r.error && r.status === 0 && !hasSkippedChecks,
    r.error
      ? r.error.message
      : `exit=${r.status}${hasSkippedChecks ? ", skipped checks present" : ""}`,
  );
  if (r.status !== 0 || r.error || hasSkippedChecks) {
    console.log(out.slice(-4000));
  }
}

req(
  "gate distinguishes zero skipped checks from real skips",
  !hasNonzeroSkips("pass 24, skipped 0") && hasNonzeroSkips("Tests 3 skipped"),
);

const requiredTypeScript = [
  "src/flight-recorder/types.ts",
  "src/flight-recorder/integrity.ts",
  "src/flight-recorder/redaction.ts",
  "src/flight-recorder/ledger.ts",
  "src/flight-recorder/recorder.ts",
  "src/flight-recorder/index.ts",
  "src/flight-recorder/flight-recorder.test.ts",
  "src/flight-recorder/flight-recorder.mutation.test.ts",
  "src/flight-recorder/runtime-integration.test.ts",
  "src/flight-recorder/flight-recorder-cli.test.ts",
  "src/cli/flight-recorder.ts",
];
const requiredPython = [
  "openrappter/flight_recorder.py",
  "tests/test_flight_recorder.py",
];
const artifactPaths = [
  ...requiredTypeScript.map((rel) => path.join(TS, rel)),
  ...requiredPython.map((rel) => path.join(PY, rel)),
  path.join(ROOT, "contracts", "flight-recorder-vector.json"),
  path.join(ROOT, "docs", "release-notes-1.12.0-evolution.html"),
];
const missing = artifactPaths.filter((file) => !existsSync(file));
req(
  "complete release artifact surface exists",
  missing.length === 0,
  missing.length
    ? missing.map((file) => path.relative(ROOT, file)).join(", ")
    : `${artifactPaths.length} files`,
);

const sourceFiles = [
  ...requiredTypeScript
    .filter((p) => p.endsWith(".ts") && !p.endsWith(".test.ts"))
    .map((rel) => path.join(TS, rel)),
  path.join(PY, "openrappter", "flight_recorder.py"),
];
const unfinished = sourceFiles.filter(
  (file) =>
    existsSync(file) &&
    /\b(TODO|not implemented|throw new Error\(['"]TODO)/i.test(
      readFileSync(file, "utf8"),
    ),
);
req(
  "no unfinished implementation markers",
  unfinished.length === 0,
  unfinished.length
    ? unfinished.map((file) => path.relative(ROOT, file)).join(", ")
    : `${sourceFiles.length} sources`,
);

run("privacy + mutation probes", "npx", [
  "vitest",
  "run",
  "src/flight-recorder/redaction.test.ts",
  "src/flight-recorder/flight-recorder.mutation.test.ts",
]);
run("ledger integrity + retention probes", "npx", [
  "vitest",
  "run",
  "src/flight-recorder/ledger.test.ts",
  "src/flight-recorder/flight-recorder.test.ts",
]);
run("runtime causality + packaged CLI behavior", "npx", [
  "vitest",
  "run",
  "src/flight-recorder/runtime-integration.test.ts",
  "src/flight-recorder/flight-recorder-cli.test.ts",
]);
// Three platform/environment-only surfaces cannot run in this Linux gate:
//   - gateway conformance's fixed port 49184 is unavailable on origin/main too;
//   - Google Voice's live-Chrome suite requires an explicitly configured,
//     logged-in browser and deliberately skips all three tests without one.
//   - Windows ACL behavior runs as a required native windows-latest release job.
// Exclude exactly those proven baselines. Any other skip still fails `run()`.
run(
  "full regression suite (three proven platform baselines excluded)",
  "npx",
  [
    "vitest",
    "run",
    "--exclude",
    "src/gateway/__tests__/conformance.test.ts",
    "--exclude",
    "src/telephony/providers/google-voice-live.test.ts",
    "--exclude",
    "src/flight-recorder/windows-storage.test.ts",
  ],
);
run("TypeScript production build", "npm", ["run", "build", "--silent"]);
run("published-package smoke test", "npm", ["run", "test:package", "--silent"]);
run("TypeScript lint (zero errors)", "npm", ["run", "lint", "--silent"]);

const python = existsSync(path.join(PY, ".venv", "bin", "python"))
  ? path.join(PY, ".venv", "bin", "python")
  : (process.env.PYTHON ?? "python3");
run(
  "Python Flight Recorder behavior + mutation suite",
  python,
  ["-m", "pytest", "tests/test_flight_recorder.py", "-q"],
  PY,
);
run(
  "full Python regression suite",
  python,
  [
    "-m",
    "pytest",
    "-q",
    "--ignore=tests/test_flight_recorder_windows.py",
  ],
  PY,
);
run(
  "Python compile/import check",
  python,
  ["-m", "compileall", "-q", "openrappter"],
  PY,
);
run(
  "release identity and workflow assertions",
  process.execPath,
  ["--test", "scripts/release-preflight.test.mjs"],
  ROOT,
);
run(
  "1.13.0 release preflight identity",
  process.execPath,
  [
    "scripts/release-preflight.mjs",
    "--tag",
    "v1.13.0",
    "--typescript-runtime-version",
    "1.13.0",
    "--python-runtime-version",
    "1.13.0",
  ],
  ROOT,
);

const smokeRoot = mkdtempSync(
  path.join(os.tmpdir(), "openrappter-flight-gate-"),
);
try {
  const databasePath = path.join(smokeRoot, "flight.db");
  const smoke = spawnSync(
    process.execPath,
    ["dist/index.js", "flight", "status", "--json"],
    {
      cwd: TS,
      encoding: "utf8",
      timeout: 60_000,
      env: {
        ...process.env,
        OPENRAPPTER_FLIGHT_RECORDER: "1",
        OPENRAPPTER_FLIGHT_DB: databasePath,
        NODE_ENV: "production",
      },
    },
  );
  const output = `${smoke.stdout ?? ""}\n${smoke.stderr ?? ""}`;
  req(
    "cold-start CLI status uses a real private SQLite ledger",
    smoke.status === 0 &&
      /"initialized":\s*true/.test(output) &&
      existsSync(databasePath),
    `exit=${smoke.status}`,
  );
} finally {
  rmSync(smokeRoot, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${"=".repeat(68)}`);
console.log(
  failed.length === 0
    ? `FLIGHT RECORDER ACCEPTED — ${results.length}/${results.length} pass`
    : `NOT ACCEPTED — ${failed.length} of ${results.length} failing`,
);
console.log("=".repeat(68));
process.exit(failed.length === 0 ? 0 : 1);
