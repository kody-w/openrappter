import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  REQUIRED_TRANSPLANT_CHECK_IDS,
  REQUIRED_TRANSPLANT_CAUSAL_STEPS,
  REQUIRED_TRANSPLANT_PROBE_TEST_NAMES,
  TRANSPLANT_RESULT_PREFIX,
  TRANSPLANT_RESULT_SCHEMA,
  canonicalJson,
  evaluateLiveOrganTransplant,
  formatTransplantResultRecord,
  isLiveOrganTransplantManifest,
  isLiveOrganTransplantMissingPythonResult,
  transplantDeterministicCore,
  type LiveOrganTransplantCheckId,
  type LiveOrganTransplantManifest,
  type LiveOrganTransplantMissingPythonResult,
  type TransplantExecutionEvidence,
} from "../../demo/live-organ-transplant-contract.js";

function loadManifest(): LiveOrganTransplantManifest {
  const value: unknown = JSON.parse(
    readFileSync(
      new URL(
        "../../demo/live-organ-transplant.manifest.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  if (!isLiveOrganTransplantManifest(value)) {
    throw new Error("Live organ transplant manifest is invalid.");
  }
  return value;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((entry) => typeof entry === "string")
  );
}

function loadPackageScripts(): Record<string, string> {
  const value: unknown = JSON.parse(
    readFileSync(new URL("../../../package.json", import.meta.url), "utf8"),
  );
  if (
    typeof value !== "object" ||
    value === null ||
    !("scripts" in value) ||
    !isStringRecord(value.scripts)
  ) {
    throw new Error("package.json scripts are invalid.");
  }
  return value.scripts;
}

const manifestJson = loadManifest();
const packageScripts = loadPackageScripts();

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
] as const satisfies readonly LiveOrganTransplantCheckId[];

const PINNED_PROBE_TEST_NAMES = [
  "live organ transplant independent observer hashes both bundled fixtures before importing either one",
  "live organ transplant independent observer keeps one real GatewayServer and one real AgentRegistry object in one host process",
  "live organ transplant independent observer proves the bearer header gates the real HTTP importer",
  "live organ transplant independent observer resolves the imported object as the real PythonAgent bridge",
  "live organ transplant independent observer executes the actual PythonAgent twice with the pinned digest",
  "live organ transplant independent observer rejects the invalid replacement before committed bytes or live identity change",
  "live organ transplant independent observer reopens the database with the production ledger and exactly matches the production export",
  "live organ transplant independent observer observes loopback gateway requests and no provider or model activity",
] as const;

const PINNED_CAUSAL_STEP_IDS = [
  "trace-started",
  "demo-started",
  "valid-gateway-started",
  "valid-import-started",
  "valid-import-completed",
  "valid-gateway-completed",
  "first-execute-started",
  "first-execute-completed",
  "invalid-gateway-started",
  "invalid-import-started",
  "invalid-import-failed",
  "invalid-gateway-failed",
  "second-execute-started",
  "second-execute-completed",
  "demo-completed",
  "trace-completed",
] as const;

function controlledMissingPythonResult(): LiveOrganTransplantMissingPythonResult {
  return {
    schema: TRANSPLANT_RESULT_SCHEMA,
    status: "python-unavailable",
    demo: "live-organ-transplant",
    command: manifestJson.command.display,
    scenario: {
      nonce: "missing-python-nonce",
      evidenceDirectory: "/repository/.test-scratch/missing-python",
    },
    reason: "python-unavailable",
    pythonExecutable: "/repository/.test-scratch/missing-python/missing-python",
    message: "Python >=3.10 is unavailable.",
    sandboxed: false,
    preservationBoundary: "file-only",
    elapsedMs: 12,
    providerCalls: 0,
    modelCalls: 0,
    evidence: {
      missing: [],
      skipped: [],
    },
  };
}

describe("live organ transplant manifest", () => {
  it("is a strict, versioned manifest with the pinned known vector", () => {
    expect(isLiveOrganTransplantManifest(manifestJson)).toBe(true);
    expect(manifestJson.schema).toBe(
      "openrappter-live-organ-transplant-manifest/1.0",
    );
    expect(manifestJson.version).toBe(1);
    expect(manifestJson.supportedPlatforms).toEqual(["darwin", "linux"]);
    expect(
      isLiveOrganTransplantManifest({
        ...manifestJson,
        supportedPlatforms: ["win32"],
      }),
    ).toBe(false);
    expect(createHash("sha256").update(manifestJson.input).digest("hex")).toBe(
      manifestJson.expectedSha256,
    );
    expect(manifestJson.dependencies).toEqual({
      node: ">=20.9.0",
      python: ">=3.10",
      model: "none",
      loopbackGateway: true,
    });
    expect(manifestJson.runtimeLimits).toEqual({
      commandTimeoutMs: 30_000,
      missingPythonTimeoutMs: 30_000,
      demoMaxElapsedMs: 30_000,
    });
    expect(manifestJson.missingPython.expectedExitCode).toBe(69);
    expect(manifestJson.artifacts.runtimePidHandoffOpenFlag).toBe("wx");
  });

  it("keeps the literal command identical to the package scripts", () => {
    expect(manifestJson.command).toEqual({
      executable: "npm",
      args: ["run", "demo:transplant", "--silent"],
      display: "npm run demo:transplant --silent",
      workingDirectory: "typescript",
    });
    expect(packageScripts["predemo:transplant"]).toBe(
      "npm run build:server --silent",
    );
    expect(packageScripts["demo:transplant"]).toBe(
      "node dist/demo/live-organ-transplant.js",
    );
    expect(packageScripts["gate:transplant"]).toBe(
      "node ../tools/live-organ-transplant-gate.mjs",
    );
    expect(packageScripts["test:transplant:gate"]).toContain(
      "live-organ-transplant-gate-orchestration.test.ts",
    );
  });

  it("pins both bundled fixtures to their exact reviewed bytes", () => {
    expect(manifestJson.fixture.bundledPath).toBe(
      "typescript/src/demo/fixtures/checksum_agent.py",
    );
    expect(manifestJson.fixture.invalidBundledPath).toBe(
      "typescript/src/demo/fixtures/checksum_agent_invalid.py",
    );
    const validHash = createHash("sha256")
      .update(
        readFileSync(
          new URL("../../demo/fixtures/checksum_agent.py", import.meta.url),
        ),
      )
      .digest("hex");
    const invalidHash = createHash("sha256")
      .update(
        readFileSync(
          new URL(
            "../../demo/fixtures/checksum_agent_invalid.py",
            import.meta.url,
          ),
        ),
      )
      .digest("hex");

    expect(manifestJson.fixture.sourceSha256).toBe(
      "7a060eb2fad9a6aaa16678ad050d6fb4f39a977745d02d7215a5f214b1890318",
    );
    expect(manifestJson.fixture.invalidSourceSha256).toBe(
      "53eee48a3b4ba4ce2573fe19a452b36e3917ffc68a50d08af3ae0e38a9f3d463",
    );
    expect(manifestJson.fixture.sourceSha256).toBe(validHash);
    expect(manifestJson.fixture.invalidSourceSha256).toBe(invalidHash);
    expect(manifestJson.fixture.todo).not.toMatch(/TODO|deliberately fails/i);
  });

  it("states the unsandboxed boundary without overstating the demo", () => {
    expect(manifestJson.claims).toContain(
      "Python execution is not sandboxed and the preservation boundary is file-only.",
    );
    expect(manifestJson.forbiddenClaims).toEqual([
      "in-process Python execution",
      "post-commit restoration terminology for candidate rejection",
      "zero-downtime guarantees",
      "crash-recovery guarantees",
      "replay guarantees",
      "air-gap guarantees",
      "enforced egress controls",
      "escaped-process prevention",
      "enforced process containment",
      "process containment guarantees",
      "native Windows support",
      "Python sandboxing",
      "arbitrary-Python safety",
    ]);
  });
});

describe("live organ transplant result records", () => {
  it("accepts only the complete controlled missing-Python shape", () => {
    const result = controlledMissingPythonResult();

    expect(isLiveOrganTransplantMissingPythonResult(result)).toBe(true);
    expect(
      isLiveOrganTransplantMissingPythonResult({ ...result, unexpected: true }),
    ).toBe(false);
    expect(
      isLiveOrganTransplantMissingPythonResult({
        ...result,
        evidence: { missing: [], skipped: [undefined] },
      }),
    ).toBe(false);
  });

  it("emits one canonical prefixed JSON record", () => {
    const result = controlledMissingPythonResult();
    const record = formatTransplantResultRecord(result);

    expect(record.startsWith(TRANSPLANT_RESULT_PREFIX)).toBe(true);
    expect(record.split(TRANSPLANT_RESULT_PREFIX)).toHaveLength(2);
    expect(record).toBe(`${TRANSPLANT_RESULT_PREFIX}${canonicalJson(result)}`);
    expect(JSON.parse(record.slice(TRANSPLANT_RESULT_PREFIX.length))).toEqual(
      result,
    );
  });

  it("sorts object keys recursively and rejects non-JSON evidence", () => {
    expect(canonicalJson({ z: 1, a: { y: 2, b: 3 } })).toBe(
      '{"a":{"b":3,"y":2},"z":1}',
    );
    expect(() => canonicalJson({ durationMs: Number.NaN })).toThrow(
      /finite JSON values/,
    );
    expect(() => canonicalJson({ missing: undefined })).toThrow(
      /finite JSON values/,
    );
  });

  it("keeps timings and runtime identities outside deterministic comparison", () => {
    const first: TransplantExecutionEvidence = {
      input: manifestJson.input,
      output: {
        algorithm: "sha256",
        digest: manifestJson.expectedSha256,
      },
      elapsedMs: 1,
    };
    const second: TransplantExecutionEvidence = {
      ...first,
      elapsedMs: 999,
    };

    expect(transplantDeterministicCore("ChecksumAgent", first)).toEqual(
      transplantDeterministicCore("ChecksumAgent", second),
    );
    expect(transplantDeterministicCore("ChecksumAgent", first)).toEqual({
      agentName: "ChecksumAgent",
      input: manifestJson.input,
      algorithm: "sha256",
      digest: manifestJson.expectedSha256,
    });
  });
});

describe("live organ transplant evaluator surface", () => {
  it("pins every required check ID literally and exposes no skip state", () => {
    expect(REQUIRED_TRANSPLANT_CHECK_IDS).toEqual(PINNED_CHECK_IDS);
    expect(REQUIRED_TRANSPLANT_PROBE_TEST_NAMES).toEqual(
      PINNED_PROBE_TEST_NAMES,
    );
    expect(REQUIRED_TRANSPLANT_CAUSAL_STEPS.map((step) => step.id)).toEqual(
      PINNED_CAUSAL_STEP_IDS,
    );

    const evaluation = evaluateLiveOrganTransplant({
      manifest: manifestJson,
      result: null,
      missingPythonResult: null,
      observations: null,
    });

    expect(evaluation.checks.map((entry) => entry.id)).toEqual(
      PINNED_CHECK_IDS,
    );
    expect(evaluation.checks.every((entry) => entry.pass === false)).toBe(true);
    expect(
      evaluation.checks.every(
        (entry) => Object.keys(entry).sort().join(",") === "detail,id,pass",
      ),
    ).toBe(true);
  });
});
