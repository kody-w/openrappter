import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  REQUIRED_TRANSPLANT_CHECK_IDS,
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
  "host-identity-preserved",
  "authenticated-http-import",
  "python-agent-bridge",
  "known-vector-first-execution",
  "bad-candidate-rejected-before-commit",
  "previous-generation-preserved",
  "deterministic-second-execution",
  "flight-recorder-integrity",
  "no-provider-model-events",
  "loopback-only-traffic",
  "unsandboxed-file-boundary",
  "bounded-runtime",
  "missing-python-controlled",
  "exact-command-parity",
  "complete-evidence",
  "fixture-source-hash-pinned",
] as const satisfies readonly LiveOrganTransplantCheckId[];

function controlledMissingPythonResult(): LiveOrganTransplantMissingPythonResult {
  return {
    schema: TRANSPLANT_RESULT_SCHEMA,
    status: "python-unavailable",
    demo: "live-organ-transplant",
    command: manifestJson.command.display,
    reason: "python-unavailable",
    pythonExecutable: manifestJson.missingPython.executable,
    message: "Python >=3.10 is unavailable.",
    sandboxed: false,
    preservationBoundary: "file-only",
    elapsedMs: 12,
    providerCalls: 0,
    modelCalls: 0,
    externalNetworkRequests: 0,
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
    expect(createHash("sha256").update(manifestJson.input).digest("hex")).toBe(
      manifestJson.expectedSha256,
    );
    expect(manifestJson.dependencies).toEqual({
      node: ">=20.9.0",
      python: ">=3.10",
      model: "none",
      externalNetwork: "forbidden",
      loopbackGateway: true,
    });
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
  });

  it("exposes the deliberately failing fixture hash pin", () => {
    expect(manifestJson.fixture.sourceSha256).toBeNull();
    expect(manifestJson.fixture.todo).toMatch(
      /TODO\(runtime-builder\).*SHA-256.*deliberately fails/i,
    );
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
