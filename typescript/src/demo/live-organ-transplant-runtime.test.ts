import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  PythonAgent,
  introspectPythonAgents,
} from "../agents/PythonAgent.js";
import {
  TRANSPLANT_RESULT_PREFIX,
  isLiveOrganTransplantMissingPythonResult,
} from "./live-organ-transplant-contract.js";
import {
  TRANSPLANT_AUTHORITY_NOTICE,
  TRANSPLANT_RECEIPT_FILENAMES,
  detectPythonExecutable,
  loadLiveOrganTransplantManifest,
  renderLiveOrganTransplantOutput,
  runLiveOrganTransplant,
} from "./live-organ-transplant.js";

const REPOSITORY_ROOT = path.resolve(
  fileURLToPath(new URL("../../../", import.meta.url)),
);
const SCRATCH_ROOT = path.join(
  REPOSITORY_ROOT,
  ".test-scratch",
  "live-organ-transplant-runtime-tests",
);
const VALID_FIXTURE = path.join(
  REPOSITORY_ROOT,
  "typescript",
  "src",
  "demo",
  "fixtures",
  "checksum_agent.py",
);
const INVALID_FIXTURE = path.join(
  REPOSITORY_ROOT,
  "typescript",
  "src",
  "demo",
  "fixtures",
  "checksum_agent_invalid.py",
);

const ENVIRONMENT_KEYS = [
  "OPENRAPPTER_HOME",
  "OPENRAPPTER_PYTHON",
  "OPENRAPPTER_TRANSPLANT_EVIDENCE_DIRECTORY",
  "OPENRAPPTER_TRANSPLANT_RUNTIME_PID_HANDOFF",
  "OPENRAPPTER_TRANSPLANT_SCENARIO_NONCE",
] as const;

let scratch = "";
let previousEnvironment: Partial<Record<(typeof ENVIRONMENT_KEYS)[number], string>>;

function hashFile(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function prefixCount(value: string): number {
  return value.split(TRANSPLANT_RESULT_PREFIX).length - 1;
}

function assertPrivateTree(directory: string): void {
  const walk = (current: string): void => {
    const currentStat = lstatSync(current);
    expect(currentStat.isSymbolicLink()).toBe(false);
    expect(currentStat.mode & 0o777).toBe(0o700);
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(target);
      } else {
        const stat = lstatSync(target);
        expect(stat.isSymbolicLink()).toBe(false);
        expect(stat.mode & 0o777).toBe(0o600);
      }
    }
  };
  walk(directory);
}

function configureMissingPythonScenario(): {
  evidenceDirectory: string;
  handoffPath: string;
  missingPython: string;
} {
  const evidenceDirectory = path.join(scratch, "evidence");
  const handoffPath = path.join(evidenceDirectory, "runtime-pid.json");
  const missingPython = path.join(scratch, "missing-python");
  process.env.OPENRAPPTER_HOME = path.join(scratch, "home");
  process.env.OPENRAPPTER_PYTHON = missingPython;
  process.env.OPENRAPPTER_TRANSPLANT_EVIDENCE_DIRECTORY =
    evidenceDirectory;
  process.env.OPENRAPPTER_TRANSPLANT_RUNTIME_PID_HANDOFF = handoffPath;
  process.env.OPENRAPPTER_TRANSPLANT_SCENARIO_NONCE =
    "runtime-test-missing-python";
  return { evidenceDirectory, handoffPath, missingPython };
}

beforeEach(() => {
  mkdirSync(SCRATCH_ROOT, { recursive: true, mode: 0o700 });
  scratch = mkdtempSync(path.join(SCRATCH_ROOT, "case-"));
  previousEnvironment = Object.fromEntries(
    ENVIRONMENT_KEYS.flatMap((key) =>
      process.env[key] === undefined ? [] : [[key, process.env[key]!]],
    ),
  );
});

afterEach(() => {
  for (const key of ENVIRONMENT_KEYS) {
    const previous = previousEnvironment[key];
    if (previous === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = previous;
    }
  }
  rmSync(scratch, { recursive: true, force: true });
});

describe("live organ transplant runtime", () => {
  it("executes the valid single-file Python BasicAgent with the exact output contract", async () => {
    const manifest = loadLiveOrganTransplantManifest();
    const detection = await detectPythonExecutable(undefined);
    expect(detection.available).toBe(true);
    if (!detection.available) return;

    const source = readFileSync(VALID_FIXTURE, "utf8");
    expect(source).not.toMatch(
      /\b(?:open|os|pathlib|requests|socket|subprocess|urllib)\b/,
    );
    const introspection = await introspectPythonAgents(VALID_FIXTURE, {
      python: detection.executable,
      timeoutMs: 5_000,
    });
    expect(introspection.ok).toBe(true);
    if (!introspection.ok) return;
    expect(introspection.agents).toEqual([
      {
        name: "ChecksumAgent",
        description:
          "Deterministically computes the SHA-256 digest of a query.",
        parameters: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "UTF-8 text to hash.",
            },
          },
          required: ["query"],
        },
      },
    ]);

    const agent = new PythonAgent(
      VALID_FIXTURE,
      introspection.agents[0]!,
      {
        python: detection.executable,
        timeoutMs: 5_000,
      },
    );
    const raw = await agent.execute({ query: manifest.input });
    expect(raw).toBe(
      JSON.stringify({
        status: "success",
        output: {
          algorithm: "sha256",
          digest: manifest.expectedSha256,
        },
      }),
    );
    expect(hashFile(VALID_FIXTURE)).toBe(
      manifest.fixture.sourceSha256,
    );
  });

  it("keeps the invalid fixture inert and contract-invalid", async () => {
    const manifest = loadLiveOrganTransplantManifest();
    const detection = await detectPythonExecutable(undefined);
    expect(detection.available).toBe(true);
    if (!detection.available) return;
    const before = readFileSync(INVALID_FIXTURE);
    expect(before.toString("utf8")).not.toMatch(/\bclass\b|\bimport\b|\(/);

    const introspection = await introspectPythonAgents(INVALID_FIXTURE, {
      python: detection.executable,
      timeoutMs: 5_000,
    });
    expect(introspection).toMatchObject({
      ok: false,
      error: expect.stringMatching(/no BasicAgent subclass found/i),
    });
    expect(readFileSync(INVALID_FIXTURE)).toEqual(before);
    expect(hashFile(INVALID_FIXTURE)).toBe(
      manifest.fixture.invalidSourceSha256,
    );
  });

  it("returns exit 69 with one canonical record, authority copy, and private artifacts when Python is missing", async () => {
    const { evidenceDirectory, handoffPath, missingPython } =
      configureMissingPythonScenario();
    const outcome = await runLiveOrganTransplant();

    expect(outcome.exitCode).toBe(69);
    expect(outcome.result).toMatchObject({
      status: "python-unavailable",
      pythonExecutable: missingPython,
      sandboxed: false,
      preservationBoundary: "file-only",
      providerCalls: 0,
      modelCalls: 0,
      evidence: { missing: [], skipped: [] },
    });
    expect(isLiveOrganTransplantMissingPythonResult(outcome.result)).toBe(
      true,
    );
    expect(
      isLiveOrganTransplantMissingPythonResult({
        ...outcome.result,
        unexpected: true,
      }),
    ).toBe(false);

    const output = renderLiveOrganTransplantOutput(outcome, true);
    expect(prefixCount(output)).toBe(1);
    expect(output.trimEnd().endsWith(outcome.record)).toBe(true);
    expect(output).toContain(TRANSPLANT_AUTHORITY_NOTICE);
    expect(outcome.narrative).toHaveLength(6);
    expect(
      outcome.narrative.every((line, index) =>
        line.startsWith(`[${index + 1}/6]`),
      ),
    ).toBe(true);

    const receiptJson = readFileSync(
      path.join(evidenceDirectory, "receipt.json"),
      "utf8",
    );
    expect(JSON.parse(receiptJson)).toEqual(outcome.result);
    expect(
      readFileSync(path.join(evidenceDirectory, "receipt.txt"), "utf8"),
    ).toContain(TRANSPLANT_AUTHORITY_NOTICE);
    expect(
      readFileSync(path.join(evidenceDirectory, "transcript.txt"), "utf8"),
    ).toContain(TRANSPLANT_AUTHORITY_NOTICE);
    expect(
      JSON.parse(readFileSync(handoffPath, "utf8")),
    ).toEqual({
      schema: "openrappter-runtime-pid/1.0",
      nonce: "runtime-test-missing-python",
      pid: process.pid,
    });
    for (const file of TRANSPLANT_RECEIPT_FILENAMES) {
      expect(existsSync(path.join(evidenceDirectory, file))).toBe(true);
    }
    assertPrivateTree(evidenceDirectory);
  });

  it("does not overwrite or stale-reuse an existing PID handoff", async () => {
    const { handoffPath } = configureMissingPythonScenario();
    const first = await runLiveOrganTransplant();
    const handoffBefore = readFileSync(handoffPath);

    await expect(runLiveOrganTransplant()).rejects.toThrow();
    expect(readFileSync(handoffPath)).toEqual(handoffBefore);
    expect(prefixCount(first.record)).toBe(1);

    rmSync(scratch, { recursive: true, force: true });
    expect(existsSync(scratch)).toBe(false);
    scratch = path.join(SCRATCH_ROOT, "already-cleaned");
  });
});
