import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { computeFlightEventHash } from "../../flight-recorder/integrity.js";
import {
  FLIGHT_EVENT_SCHEMA,
  type FlightEvent,
  type FlightEventStatus,
} from "../../flight-recorder/types.js";
import {
  REQUIRED_TRANSPLANT_CHECK_IDS,
  TRANSPLANT_GATEWAY_MODULE,
  TRANSPLANT_PYTHON_BRIDGE_MODULE,
  TRANSPLANT_RESULT_SCHEMA,
  TRANSPLANT_RUNTIME_ENTRYPOINT,
  canonicalJson,
  evaluateLiveOrganTransplant,
  isJsonValue,
  isLiveOrganTransplantManifest,
  isLiveOrganTransplantMissingPythonResult,
  isLiveOrganTransplantObservations,
  isLiveOrganTransplantSuccessResult,
  type JsonValue,
  type LiveOrganTransplantCheckId,
  type LiveOrganTransplantEvaluationInput,
  type LiveOrganTransplantManifest,
  type LiveOrganTransplantMissingPythonResult,
  type LiveOrganTransplantObservations,
  type LiveOrganTransplantSuccessResult,
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

const manifestJson = loadManifest();

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

const PINNED_MUTATION_IDS = [
  "extra-result-field",
  "runtime-artifact-hash-mismatch",
  "host-pid-changed",
  "valid-import-unauthenticated",
  "python-bridge-module-drift",
  "known-vector-digest-corrupted",
  "invalid-candidate-not-http-400",
  "previous-source-bytes-changed",
  "second-execution-diverged",
  "persisted-database-hash-mismatch",
  "provider-event-recorded",
  "external-network-count-incremented",
  "python-marked-sandboxed",
  "runtime-deadline-exceeded",
  "missing-python-message-uncontrolled",
  "observed-command-drifted",
  "skipped-evidence-added",
  "fixture-source-hash-unpinned",
] as const;

type MutationId = (typeof PINNED_MUTATION_IDS)[number];

interface MutationProbe {
  id: MutationId;
  expectedCheckId: LiveOrganTransplantCheckId;
  mutate(input: LiveOrganTransplantEvaluationInput): void;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function resolvedManifest(): LiveOrganTransplantManifest {
  const value: unknown = manifestJson;
  if (!isLiveOrganTransplantManifest(value)) {
    throw new Error("Synthetic baseline requires a valid manifest.");
  }
  return {
    ...value,
    fixture: {
      ...value.fixture,
      sourceSha256: sha256("bundled-checksum-agent-source"),
    },
  };
}

function makeFlightEvent(
  sequence: number,
  kind: string,
  status: FlightEventStatus,
): FlightEvent {
  const body: Omit<FlightEvent, "contentHash"> = {
    schema: FLIGHT_EVENT_SCHEMA,
    id: `flight-event-${sequence}`,
    sequence,
    traceId: "transplant-trace",
    parentId: sequence === 1 ? null : `flight-event-${sequence - 1}`,
    timestamp: `2026-08-22T01:41:${String(sequence).padStart(2, "0")}.000Z`,
    kind,
    source: "live-organ-transplant",
    status,
    metadata: {
      demo: "live-organ-transplant",
      sequence,
    },
  };
  return {
    ...body,
    contentHash: computeFlightEventHash(body),
  };
}

function makeFlightEvents(): FlightEvent[] {
  return [
    makeFlightEvent(1, "demo.transplant.started", "started"),
    makeFlightEvent(2, "demo.agent.import.accepted", "success"),
    makeFlightEvent(3, "agent.execute.completed", "success"),
    makeFlightEvent(4, "demo.agent.candidate.rejected", "decision"),
    makeFlightEvent(5, "agent.execute.completed", "success"),
    makeFlightEvent(6, "demo.transplant.completed", "success"),
  ];
}

function flightExportJson(
  exportedAt: string,
  events: FlightEvent[],
): JsonValue {
  const value: unknown = {
    schema: "openrappter-flight-export/1.0",
    exportedAt,
    events,
  };
  if (!isJsonValue(value)) {
    throw new Error("Synthetic Flight Recorder export must be JSON.");
  }
  return value;
}

function createBaseline(): LiveOrganTransplantEvaluationInput {
  const manifest = resolvedManifest();
  const fixtureHash = manifest.fixture.sourceSha256;
  if (fixtureHash === null) {
    throw new Error("Synthetic baseline fixture hash must be resolved.");
  }
  const invalidCandidateHash = sha256("contract-invalid-candidate");
  const runtimeHash = sha256("compiled-runtime-bytes");
  const databaseHash = sha256("sqlite-flight-database-bytes");
  const events = makeFlightEvents();
  const exportedAt = "2026-08-22T01:42:00.000Z";
  const exported = flightExportJson(exportedAt, events);
  const exportBytes = canonicalJson(exported);
  const exportHash = sha256(exportBytes);
  const evidenceRoot = `${manifest.artifacts.evidenceRoot}/synthetic-green`;
  const databasePath = `${evidenceRoot}/flight-recorder.db`;
  const exportPath = `${evidenceRoot}/flight-recorder.json`;
  const gatewayBaseUrl = "http://127.0.0.1:43191";

  const result: LiveOrganTransplantSuccessResult = {
    schema: TRANSPLANT_RESULT_SCHEMA,
    status: "success",
    demo: "live-organ-transplant",
    command: manifest.command.display,
    runtime: {
      mode: "compiled-javascript",
      entrypoint: TRANSPLANT_RUNTIME_ENTRYPOINT,
      entrypointSha256: runtimeHash,
      typescriptRuntimeLoaderUsed: false,
      nodeVersion: "20.9.0",
      elapsedMs: 850,
    },
    host: {
      pidBefore: 4242,
      pidAfter: 4242,
      startIdentityBefore: "host-start-identity",
      startIdentityAfter: "host-start-identity",
    },
    gateway: {
      serverClass: "GatewayServer",
      serverModule: TRANSPLANT_GATEWAY_MODULE,
      bind: "loopback",
      address: "127.0.0.1",
      port: 43191,
      baseUrl: gatewayBaseUrl,
      authMode: "token",
      productionImportRoute: true,
      externalRequestCount: 0,
      requests: [
        {
          purpose: "valid-import",
          url: `${gatewayBaseUrl}/agents/import`,
          hostname: "127.0.0.1",
          method: "POST",
          path: "/agents/import",
          status: 200,
          authenticated: true,
          authorization: "bearer-token",
        },
        {
          purpose: "invalid-replacement",
          url: `${gatewayBaseUrl}/agents/import`,
          hostname: "127.0.0.1",
          method: "POST",
          path: "/agents/import",
          status: 400,
          authenticated: true,
          authorization: "bearer-token",
        },
      ],
    },
    agent: {
      name: "ChecksumAgent",
      filename: manifest.fixture.filename,
      bridgeClass: "PythonAgent",
      bridgeModule: TRANSPLANT_PYTHON_BRIDGE_MODULE,
      registryClass: "AgentRegistry",
      registryInstanceIdBefore: "registry-object-1",
      registryInstanceIdAfter: "registry-object-1",
      sourceSha256Before: fixtureHash,
      sourceSha256After: fixtureHash,
      objectIdentityBefore: "checksum-object-1",
      objectIdentityAfter: "checksum-object-1",
    },
    imports: {
      accepted: {
        filename: manifest.fixture.filename,
        candidateSourceSha256: fixtureHash,
        httpStatus: 200,
        responseStatus: "ok",
        committed: true,
      },
      rejected: {
        filename: manifest.fixture.filename,
        candidateSourceSha256: invalidCandidateHash,
        httpStatus: 400,
        responseStatus: "error",
        rejectedBeforeCommit: true,
        committed: false,
        errorCode: "agent-contract-invalid",
      },
    },
    executions: {
      first: {
        input: manifest.input,
        output: {
          algorithm: "sha256",
          digest: manifest.expectedSha256,
        },
        elapsedMs: 35,
      },
      second: {
        input: manifest.input,
        output: {
          algorithm: "sha256",
          digest: manifest.expectedSha256,
        },
        elapsedMs: 31,
      },
    },
    preservation: {
      sandboxed: false,
      preservationBoundary: "file-only",
      previousGenerationPreserved: true,
    },
    flightRecorder: {
      enabled: true,
      persisted: true,
      reopened: true,
      database: {
        path: databasePath,
        sha256: databaseHash,
        sizeBytes: 8192,
      },
      export: {
        path: exportPath,
        sha256: exportHash,
        sizeBytes: Buffer.byteLength(exportBytes),
      },
      exportSchema: "openrappter-flight-export/1.0",
      exportedAt,
      eventCount: events.length,
      events,
      reloadedEventIds: events.map((event) => event.id),
    },
    providerUsage: {
      providerCalls: 0,
      modelCalls: 0,
    },
    evidence: {
      missing: [],
      skipped: [],
    },
  };

  const missingPythonResult: LiveOrganTransplantMissingPythonResult = {
    schema: TRANSPLANT_RESULT_SCHEMA,
    status: "python-unavailable",
    demo: "live-organ-transplant",
    command: manifest.command.display,
    reason: "python-unavailable",
    pythonExecutable: manifest.missingPython.executable,
    message: "Python >=3.10 is unavailable.",
    sandboxed: false,
    preservationBoundary: "file-only",
    elapsedMs: 20,
    providerCalls: 0,
    modelCalls: 0,
    externalNetworkRequests: 0,
    evidence: {
      missing: [],
      skipped: [],
    },
  };

  const observations: LiveOrganTransplantObservations = {
    executedCommand: manifest.command.display,
    successExitCode: 0,
    missingPythonExitCode: manifest.missingPython.expectedExitCode,
    successRecordCount: 1,
    missingPythonRecordCount: 1,
    successRecordCanonical: true,
    missingPythonRecordCanonical: true,
    successElapsedMs: 2500,
    missingPythonElapsedMs: 2200,
    artifacts: {
      runtimeEntrypoint: {
        path: TRANSPLANT_RUNTIME_ENTRYPOINT,
        exists: true,
        sizeBytes: 4096,
        sha256: runtimeHash,
        json: null,
      },
      flightDatabase: {
        path: databasePath,
        exists: true,
        sizeBytes: 8192,
        sha256: databaseHash,
        json: null,
      },
      flightExport: {
        path: exportPath,
        exists: true,
        sizeBytes: Buffer.byteLength(exportBytes),
        sha256: exportHash,
        json: exported,
      },
    },
    missingEvidence: [],
    skippedEvidence: [],
  };

  return {
    manifest,
    result,
    missingPythonResult,
    observations,
  };
}

function requireManifest(
  input: LiveOrganTransplantEvaluationInput,
): LiveOrganTransplantManifest {
  if (!isLiveOrganTransplantManifest(input.manifest)) {
    throw new Error("Mutation requires a valid manifest.");
  }
  return input.manifest;
}

function requireResult(
  input: LiveOrganTransplantEvaluationInput,
): LiveOrganTransplantSuccessResult {
  if (!isLiveOrganTransplantSuccessResult(input.result)) {
    throw new Error("Mutation requires a valid success result.");
  }
  return input.result;
}

function requireMissingPythonResult(
  input: LiveOrganTransplantEvaluationInput,
): LiveOrganTransplantMissingPythonResult {
  if (!isLiveOrganTransplantMissingPythonResult(input.missingPythonResult)) {
    throw new Error("Mutation requires a valid missing-Python result.");
  }
  return input.missingPythonResult;
}

function requireObservations(
  input: LiveOrganTransplantEvaluationInput,
): LiveOrganTransplantObservations {
  if (!isLiveOrganTransplantObservations(input.observations)) {
    throw new Error("Mutation requires valid gate observations.");
  }
  return input.observations;
}

function refreshFlightExport(
  result: LiveOrganTransplantSuccessResult,
  observations: LiveOrganTransplantObservations,
): void {
  const exported = flightExportJson(
    result.flightRecorder.exportedAt,
    result.flightRecorder.events,
  );
  const bytes = canonicalJson(exported);
  const hash = sha256(bytes);
  result.flightRecorder.export.sha256 = hash;
  result.flightRecorder.export.sizeBytes = Buffer.byteLength(bytes);
  observations.artifacts.flightExport.sha256 = hash;
  observations.artifacts.flightExport.sizeBytes = Buffer.byteLength(bytes);
  observations.artifacts.flightExport.json = exported;
}

const MUTATIONS: readonly MutationProbe[] = [
  {
    id: "extra-result-field",
    expectedCheckId: "result-schema",
    mutate(input) {
      const result = requireResult(input);
      input.result = { ...result, unexpected: true };
    },
  },
  {
    id: "runtime-artifact-hash-mismatch",
    expectedCheckId: "compiled-runtime",
    mutate(input) {
      requireResult(input).runtime.entrypointSha256 = sha256(
        "different-runtime-bytes",
      );
    },
  },
  {
    id: "host-pid-changed",
    expectedCheckId: "host-identity-preserved",
    mutate(input) {
      requireResult(input).host.pidAfter += 1;
    },
  },
  {
    id: "valid-import-unauthenticated",
    expectedCheckId: "authenticated-http-import",
    mutate(input) {
      const request = requireResult(input).gateway.requests.find(
        (entry) => entry.purpose === "valid-import",
      );
      if (!request) throw new Error("Valid import request is required.");
      request.authenticated = false;
    },
  },
  {
    id: "python-bridge-module-drift",
    expectedCheckId: "python-agent-bridge",
    mutate(input) {
      requireResult(input).agent.bridgeModule =
        "typescript/dist/agents/NotPythonAgent.js";
    },
  },
  {
    id: "known-vector-digest-corrupted",
    expectedCheckId: "known-vector-first-execution",
    mutate(input) {
      const result = requireResult(input);
      const wrongDigest = sha256("wrong-deterministic-output");
      result.executions.first.output.digest = wrongDigest;
      result.executions.second.output.digest = wrongDigest;
    },
  },
  {
    id: "invalid-candidate-not-http-400",
    expectedCheckId: "bad-candidate-rejected-before-commit",
    mutate(input) {
      const result = requireResult(input);
      const request = result.gateway.requests.find(
        (entry) => entry.purpose === "invalid-replacement",
      );
      if (!request) throw new Error("Invalid replacement request is required.");
      request.status = 409;
      result.imports.rejected.httpStatus = 409;
    },
  },
  {
    id: "previous-source-bytes-changed",
    expectedCheckId: "previous-generation-preserved",
    mutate(input) {
      const result = requireResult(input);
      result.agent.sourceSha256After =
        result.imports.rejected.candidateSourceSha256;
    },
  },
  {
    id: "second-execution-diverged",
    expectedCheckId: "deterministic-second-execution",
    mutate(input) {
      requireResult(input).executions.second.output.digest = sha256(
        "divergent-second-output",
      );
    },
  },
  {
    id: "persisted-database-hash-mismatch",
    expectedCheckId: "flight-recorder-integrity",
    mutate(input) {
      requireObservations(input).artifacts.flightDatabase.sha256 = sha256(
        "different-database-bytes",
      );
    },
  },
  {
    id: "provider-event-recorded",
    expectedCheckId: "no-provider-model-events",
    mutate(input) {
      const result = requireResult(input);
      const observations = requireObservations(input);
      const event = result.flightRecorder.events[0];
      if (!event) throw new Error("Flight Recorder event is required.");
      const { contentHash: _previousHash, ...body } = event;
      const changedBody: Omit<FlightEvent, "contentHash"> = {
        ...body,
        providerId: "unexpected-provider",
      };
      result.flightRecorder.events[0] = {
        ...changedBody,
        contentHash: computeFlightEventHash(changedBody),
      };
      refreshFlightExport(result, observations);
    },
  },
  {
    id: "external-network-count-incremented",
    expectedCheckId: "loopback-only-traffic",
    mutate(input) {
      requireResult(input).gateway.externalRequestCount = 1;
    },
  },
  {
    id: "python-marked-sandboxed",
    expectedCheckId: "unsandboxed-file-boundary",
    mutate(input) {
      requireResult(input).preservation.sandboxed = true;
    },
  },
  {
    id: "runtime-deadline-exceeded",
    expectedCheckId: "bounded-runtime",
    mutate(input) {
      const manifest = requireManifest(input);
      requireResult(input).runtime.elapsedMs =
        manifest.runtimeLimits.demoMaxElapsedMs + 1;
      requireObservations(input).successElapsedMs =
        manifest.runtimeLimits.commandTimeoutMs + 1;
    },
  },
  {
    id: "missing-python-message-uncontrolled",
    expectedCheckId: "missing-python-controlled",
    mutate(input) {
      requireMissingPythonResult(input).message =
        "Required interpreter is unavailable.";
    },
  },
  {
    id: "observed-command-drifted",
    expectedCheckId: "exact-command-parity",
    mutate(input) {
      requireObservations(input).executedCommand =
        "npm run a-different-command --silent";
    },
  },
  {
    id: "skipped-evidence-added",
    expectedCheckId: "complete-evidence",
    mutate(input) {
      requireResult(input).evidence.skipped.push("unmeasured-object-identity");
    },
  },
  {
    id: "fixture-source-hash-unpinned",
    expectedCheckId: "fixture-source-hash-pinned",
    mutate(input) {
      requireManifest(input).fixture.sourceSha256 = null;
    },
  },
];

describe("live organ transplant mutation gate", () => {
  it("starts from a fully green synthetic baseline", () => {
    const evaluation = evaluateLiveOrganTransplant(createBaseline());

    expect(evaluation.pass).toBe(true);
    expect(evaluation.checks.map((entry) => entry.id)).toEqual(
      PINNED_CHECK_IDS,
    );
    expect(evaluation.checks.filter((entry) => !entry.pass)).toEqual([]);
  });

  it("pins every check and mutation independently of parametrized row count", () => {
    expect(REQUIRED_TRANSPLANT_CHECK_IDS).toEqual(PINNED_CHECK_IDS);
    expect(MUTATIONS.map((mutation) => mutation.id)).toEqual(
      PINNED_MUTATION_IDS,
    );
    expect(MUTATIONS.map((mutation) => mutation.expectedCheckId)).toEqual(
      PINNED_CHECK_IDS,
    );
    expect(new Set(PINNED_MUTATION_IDS).size).toBe(PINNED_MUTATION_IDS.length);
  });

  it.each(MUTATIONS)(
    "$id makes exactly $expectedCheckId fail",
    ({ mutate, expectedCheckId }) => {
      const input = structuredClone(createBaseline());
      mutate(input);

      const evaluation = evaluateLiveOrganTransplant(input);
      const failed = evaluation.checks
        .filter((entry) => !entry.pass)
        .map((entry) => entry.id);

      expect(evaluation.pass).toBe(false);
      expect(failed).toEqual([expectedCheckId]);
    },
  );
});
