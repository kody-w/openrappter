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
  REQUIRED_TRANSPLANT_PROBE_TEST_NAMES,
  TRANSPLANT_GATEWAY_MODULE,
  TRANSPLANT_INTEGRATION_TEST,
  TRANSPLANT_INVALID_FIXTURE,
  TRANSPLANT_PROBE_SCHEMA,
  TRANSPLANT_PYTHON_BRIDGE_MODULE,
  TRANSPLANT_RESULT_SCHEMA,
  TRANSPLANT_RUNTIME_ENTRYPOINT,
  TRANSPLANT_VALID_FIXTURE,
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

const PINNED_MUTATION_IDS = [
  "extra-result-field",
  "success-exit-nonzero",
  "success-record-count-drift",
  "success-record-noncanonical",
  "runtime-artifact-hash-mismatch",
  "runtime-mode-drift",
  "runtime-entrypoint-drift",
  "runtime-reported-size-drift",
  "runtime-loader-used",
  "runtime-observation-missing",
  "runtime-observation-path-drift",
  "runtime-observation-hash-drift",
  "runtime-observation-size-mismatch",
  "runtime-observation-empty",
  "success-nonce-mismatch",
  "success-directory-mismatch",
  "missing-nonce-mismatch",
  "missing-nonce-reused",
  "missing-directory-mismatch",
  "scenario-directory-reused",
  "success-directory-not-empty",
  "missing-directory-not-empty",
  "frozen-not-captured",
  "frozen-empty",
  "frozen-changed-after-causal-read",
  "frozen-changed-after-missing",
  "database-export-path-alias",
  "database-path-outside-success",
  "export-path-outside-success",
  "display-pid-changed",
  "display-start-identity-changed",
  "probe-pid-changed",
  "probe-gateway-reference-changed",
  "probe-registry-reference-changed",
  "probe-registry-count-two",
  "display-auth-mode-drift",
  "display-server-class-drift",
  "display-server-module-drift",
  "display-auth-header-drift",
  "display-valid-method-drift",
  "display-valid-path-drift",
  "display-valid-auth-false",
  "display-route-false",
  "display-valid-status",
  "accepted-status",
  "accepted-response",
  "accepted-committed-false",
  "probe-auth-mode",
  "probe-server-class-drift",
  "probe-registry-class-drift",
  "probe-auth-scheme",
  "probe-unauth-status",
  "probe-unauth-importer-called",
  "probe-total-importer-count",
  "probe-accepted-status",
  "display-bridge-class-drift",
  "display-agent-name-drift",
  "display-bridge-module-drift",
  "display-registry-class-drift",
  "probe-agent-class-drift",
  "probe-bridge-module-drift",
  "probe-source-file-drift",
  "first-input-drift",
  "first-algorithm-drift",
  "first-digest-corrupted",
  "probe-first-input-drift",
  "probe-first-algorithm-drift",
  "probe-first-digest-corrupted",
  "invalid-request-status",
  "invalid-request-unauthenticated",
  "invalid-request-auth-header-drift",
  "invalid-request-method-drift",
  "invalid-request-path-drift",
  "rejected-http-status",
  "rejected-response-status",
  "rejected-before-commit-false",
  "rejected-committed-true",
  "rejected-filename-drift",
  "probe-rejected-status",
  "probe-rejected-before-commit-false",
  "probe-rejected-committed-true",
  "probe-target-bytes-changed",
  "probe-target-stat-changed",
  "previous-preserved-false",
  "previous-source-bytes-changed",
  "previous-object-identity-changed",
  "previous-registry-identity-changed",
  "candidate-equals-committed",
  "probe-object-reference-changed",
  "probe-agent-registry-reference-changed",
  "probe-source-bytes-changed",
  "probe-candidate-equals-committed",
  "second-execution-diverged",
  "second-execution-input-drift",
  "second-execution-algorithm-drift",
  "probe-second-execution-diverged",
  "probe-second-execution-input-drift",
  "probe-second-execution-algorithm-drift",
  "probe-operation-order-swapped",
  "flight-disabled",
  "flight-not-persisted",
  "flight-event-count-drift",
  "flight-too-few-events",
  "flight-event-hash-corrupted",
  "flight-event-id-drift",
  "flight-required-kind-missing",
  "causal-order-swap",
  "causal-wrong-nonce",
  "causal-wrong-trace-id",
  "causal-broken-parent-chain",
  "causal-wrong-valid-hash",
  "causal-wrong-invalid-hash",
  "causal-wrong-active-hash",
  "causal-wrong-first-digest",
  "causal-wrong-second-digest",
  "causal-wrong-agent-name",
  "causal-wrong-bridge-class",
  "causal-wrong-owner-pid",
  "causal-wrong-runtime-handoff-pid",
  "causal-unrelated-trace-substitution",
  "causal-nonmonotonic-sequence",
  "causal-import-failed-status-drift",
  "causal-second-execution-before-rejection",
  "causal-missing-trace-started",
  "causal-missing-demo-started",
  "causal-missing-valid-import-started",
  "causal-missing-valid-import-completed",
  "causal-missing-first-execute-started",
  "causal-missing-first-execute-completed",
  "causal-missing-invalid-import-started",
  "causal-missing-invalid-import-failed",
  "causal-missing-second-execute-started",
  "causal-missing-second-execute-completed",
  "causal-missing-demo-completed",
  "causal-missing-trace-completed",
  "database-artifact-path-drift",
  "database-artifact-size-drift",
  "database-artifact-hash-drift",
  "export-artifact-path-drift",
  "export-artifact-size-drift",
  "export-artifact-hash-drift",
  "probe-flight-path-alias",
  "probe-database-path-drift",
  "probe-export-path-drift",
  "probe-database-hash-drift",
  "probe-expected-database-hash-drift",
  "probe-export-hash-drift",
  "probe-expected-export-hash-drift",
  "probe-reopen-false",
  "probe-production-validation-false",
  "probe-content-hash-validation-false",
  "probe-reopened-ids-drift",
  "probe-exported-ids-drift",
  "probe-persisted-ids-drift",
  "probe-reopened-hashes-drift",
  "probe-exported-hashes-drift",
  "probe-persisted-hashes-drift",
  "provider-counter-incremented",
  "model-counter-incremented",
  "missing-provider-counter-incremented",
  "missing-model-counter-incremented",
  "provider-event-recorded",
  "model-event-recorded",
  "probe-model-dependency-added",
  "probe-provider-event-count",
  "probe-model-event-count",
  "display-address-not-loopback",
  "display-bind-not-loopback",
  "display-port-drift",
  "display-base-url-not-loopback",
  "display-request-count-drift",
  "display-request-url-not-loopback",
  "display-request-hostname-not-loopback",
  "probe-request-url-not-loopback",
  "probe-request-count-drift",
  "success-marked-sandboxed",
  "success-boundary-drift",
  "missing-marked-sandboxed",
  "missing-boundary-drift",
  "runtime-self-deadline-exceeded",
  "first-execution-deadline-exceeded",
  "second-execution-deadline-exceeded",
  "missing-self-deadline-exceeded",
  "observed-success-deadline-exceeded",
  "observed-missing-deadline-exceeded",
  "success-timeout-observed",
  "missing-timeout-observed",
  "success-child-pid-missing",
  "success-spawn-unobserved",
  "success-exit-unobserved",
  "success-close-and-fallback-unobserved",
  "success-group-termination-unattempted",
  "success-group-termination-incomplete",
  "success-pipes-not-destroyed",
  "missing-expected-exit-zero",
  "missing-observed-exit-zero",
  "missing-record-count-drift",
  "missing-record-noncanonical",
  "missing-reason-drift",
  "missing-executable-drift",
  "missing-message-uncontrolled",
  "manifest-command-display-drift",
  "observed-command-drift",
  "success-command-drift",
  "missing-command-drift",
  "result-missing-evidence",
  "result-skipped-evidence",
  "missing-result-missing-evidence",
  "missing-result-skipped-evidence",
  "observation-missing-evidence",
  "observation-skipped-evidence",
  "probe-report-total-drift",
  "probe-report-passed-drift",
  "probe-report-failed",
  "probe-report-skipped",
  "probe-report-name-set-drift",
  "probe-report-passed-names-drift",
  "fixture-collection-missing",
  "process-collection-missing",
  "gateway-collection-missing",
  "agent-collection-missing",
  "execution-collection-missing",
  "rejection-collection-missing",
  "flight-collection-missing",
  "provider-collection-missing",
  "fixture-valid-pin-null",
  "fixture-invalid-pin-null",
  "accepted-fixture-link-drift",
  "rejected-fixture-link-drift",
  "agent-fixture-filename-drift",
  "probe-valid-fixture-path-drift",
  "probe-invalid-fixture-path-drift",
  "probe-valid-fixture-hash-drift",
  "probe-invalid-fixture-hash-drift",
  "probe-manifest-valid-hash-drift",
  "probe-manifest-invalid-hash-drift",
  "probe-agent-source-hash-drift",
  "result-agent-source-hash-drift",
] as const;

type MutationId = (typeof PINNED_MUTATION_IDS)[number];

interface MutationProbe {
  id: MutationId;
  expectedCheckId: LiveOrganTransplantCheckId;
  exactFailureIds?: readonly LiveOrganTransplantCheckId[];
  coupling?: string;
  mutate(input: LiveOrganTransplantEvaluationInput): void;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function resolvedManifest(): LiveOrganTransplantManifest {
  return {
    ...manifestJson,
    fixture: {
      ...manifestJson.fixture,
      sourceSha256: sha256("bundled-checksum-agent-source"),
      invalidSourceSha256: sha256("bundled-invalid-checksum-agent-source"),
    },
  };
}

function makeFlightEvent(
  sequence: number,
  kind: string,
  status: FlightEventStatus,
  options: {
    parentId: string | null;
    source?: string;
    metadata?: Record<string, unknown>;
    payload?: unknown;
    agentName?: string;
  },
): FlightEvent {
  const body: Omit<FlightEvent, "contentHash"> = {
    schema: FLIGHT_EVENT_SCHEMA,
    id: `flight-event-${sequence}`,
    sequence,
    traceId: "transplant-trace",
    parentId: options.parentId,
    timestamp: `2026-08-22T01:41:${String(sequence).padStart(2, "0")}.000Z`,
    kind,
    source: options.source ?? "live-organ-transplant",
    status,
    metadata: options.metadata ?? {},
    ...(options.payload === undefined ? {} : { payload: options.payload }),
    ...(options.agentName === undefined
      ? {}
      : { agentName: options.agentName }),
  };
  return {
    ...body,
    contentHash: computeFlightEventHash(body),
  };
}

function makeFlightEvents(
  nonce: string,
  validHash: string,
  invalidHash: string,
  digest: string,
): FlightEvent[] {
  const root = "flight-event-1";
  return [
    makeFlightEvent(1, "trace.started", "started", {
      parentId: null,
      source: "runtime",
      metadata: { nested: false, ownerPid: 4242 },
    }),
    makeFlightEvent(2, "demo.transplant.started", "started", {
      parentId: root,
      metadata: { nonce },
    }),
    makeFlightEvent(3, "agent.import.started", "started", {
      parentId: root,
      metadata: { candidateSourceSha256: validHash },
    }),
    makeFlightEvent(4, "agent.import.completed", "success", {
      parentId: "flight-event-3",
      agentName: "ChecksumAgent",
      metadata: {
        candidateSourceSha256: validHash,
        activeSourceSha256: validHash,
        bridgeClass: "PythonAgent",
      },
    }),
    makeFlightEvent(5, "agent.execute.started", "started", {
      parentId: root,
      agentName: "ChecksumAgent",
    }),
    makeFlightEvent(6, "agent.execute.completed", "success", {
      parentId: "flight-event-5",
      agentName: "ChecksumAgent",
      payload: { result: { output: { algorithm: "sha256", digest } } },
    }),
    makeFlightEvent(7, "agent.import.started", "started", {
      parentId: root,
      metadata: { candidateSourceSha256: invalidHash },
    }),
    makeFlightEvent(8, "agent.import.failed", "error", {
      parentId: "flight-event-7",
      agentName: "ChecksumAgent",
      metadata: {
        candidateSourceSha256: invalidHash,
        activeSourceSha256: validHash,
        rejectedBeforeCommit: true,
      },
    }),
    makeFlightEvent(9, "agent.execute.started", "started", {
      parentId: root,
      agentName: "ChecksumAgent",
    }),
    makeFlightEvent(10, "agent.execute.completed", "success", {
      parentId: "flight-event-9",
      agentName: "ChecksumAgent",
      payload: { result: { output: { algorithm: "sha256", digest } } },
    }),
    makeFlightEvent(11, "demo.transplant.completed", "success", {
      parentId: root,
      metadata: { nonce },
    }),
    makeFlightEvent(12, "trace.completed", "success", {
      parentId: root,
      source: "runtime",
    }),
  ];
}

function exportableEvents(events: FlightEvent[]): FlightEvent[] {
  return events.map((event) => {
    if (event.kind !== "trace.started") return event;
    const metadata = { ...event.metadata };
    delete metadata.ownerPid;
    const { contentHash: _hash, ...body } = event;
    const exportable = { ...body, metadata };
    return {
      ...exportable,
      contentHash: computeFlightEventHash(exportable),
    };
  });
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
  const invalidFixtureHash = manifest.fixture.invalidSourceSha256;
  if (fixtureHash === null || invalidFixtureHash === null) {
    throw new Error("Synthetic fixture hashes must be resolved.");
  }
  const runtimeHash = sha256("compiled-runtime-bytes");
  const databaseHash = sha256("sqlite-flight-database-bytes");
  const successNonce = "success-nonce";
  const probeNonce = "probe-nonce";
  const missingNonce = "missing-nonce";
  const events = makeFlightEvents(
    successNonce,
    fixtureHash,
    invalidFixtureHash,
    manifest.expectedSha256,
  );
  const persistedEvents = exportableEvents(events);
  const probeEvents = makeFlightEvents(
    probeNonce,
    fixtureHash,
    invalidFixtureHash,
    manifest.expectedSha256,
  );
  const probePersistedEvents = exportableEvents(probeEvents);
  const exportedAt = "2026-08-22T01:42:00.000Z";
  const exported = flightExportJson(exportedAt, persistedEvents);
  const exportBytes = canonicalJson(exported);
  const exportHash = sha256(exportBytes);
  const evidenceRoot = `${manifest.artifacts.evidenceRoot}/synthetic-green`;
  const missingEvidenceRoot = `${manifest.artifacts.evidenceRoot}/synthetic-missing`;
  const probeEvidenceRoot = `${manifest.artifacts.evidenceRoot}/synthetic-probe`;
  const databasePath = `${evidenceRoot}/flight-recorder.db`;
  const exportPath = `${evidenceRoot}/flight-recorder.json`;
  const runtimePidHandoffPath = `${evidenceRoot}/runtime-pid.json`;
  const gatewayBaseUrl = "http://127.0.0.1:43191";
  const controlledMissingPythonExecutable = `${missingEvidenceRoot}/missing-python`;

  const result: LiveOrganTransplantSuccessResult = {
    schema: TRANSPLANT_RESULT_SCHEMA,
    status: "success",
    demo: "live-organ-transplant",
    command: manifest.command.display,
    scenario: {
      nonce: successNonce,
      evidenceDirectory: evidenceRoot,
    },
    runtime: {
      mode: "compiled-javascript",
      entrypoint: TRANSPLANT_RUNTIME_ENTRYPOINT,
      entrypointSha256: runtimeHash,
      entrypointSizeBytes: 4096,
      typescriptRuntimeLoaderUsed: false,
      nodeVersion: "20.9.0",
      elapsedMs: 850,
    },
    host: {
      pidBefore: 4242,
      pidAfter: 4242,
      startIdentityBefore: "host-start-identity",
      startIdentityAfter: "host-start-identity",
      runtimePidHandoffPath,
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
        candidateSourceSha256: invalidFixtureHash,
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
      traceId: "transplant-trace",
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
    scenario: {
      nonce: missingNonce,
      evidenceDirectory: missingEvidenceRoot,
    },
    reason: "python-unavailable",
    pythonExecutable: controlledMissingPythonExecutable,
    message: "Python >=3.10 is unavailable.",
    sandboxed: false,
    preservationBoundary: "file-only",
    elapsedMs: 20,
    providerCalls: 0,
    modelCalls: 0,
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
    controlledMissingPythonExecutable,
    probeScenario: {
      nonce: probeNonce,
      evidenceDirectory: probeEvidenceRoot,
      startedEmpty: true,
      childPid: 4200,
      spawnObserved: true,
      exitObserved: true,
      closeObserved: true,
      timedOut: false,
      forcedSettled: false,
      groupTerminationAttempted: true,
      groupTerminationCompleted: true,
      pipesDestroyed: true,
      elapsedMs: 1800,
    },
    successScenario: {
      nonce: successNonce,
      evidenceDirectory: evidenceRoot,
      startedEmpty: true,
      childPid: 4201,
      spawnObserved: true,
      exitObserved: true,
      closeObserved: true,
      timedOut: false,
      forcedSettled: false,
      groupTerminationAttempted: true,
      groupTerminationCompleted: true,
      pipesDestroyed: true,
      elapsedMs: 2500,
    },
    missingPythonScenario: {
      nonce: missingNonce,
      evidenceDirectory: missingEvidenceRoot,
      startedEmpty: true,
      childPid: 4202,
      spawnObserved: true,
      exitObserved: true,
      closeObserved: true,
      timedOut: false,
      forcedSettled: false,
      groupTerminationAttempted: true,
      groupTerminationCompleted: true,
      pipesDestroyed: true,
      elapsedMs: 2200,
    },
    frozenSuccessEvidence: {
      captured: true,
      fileCount: 3,
      inventorySha256: sha256("frozen-success-inventory"),
      unchangedAfterCausalRead: true,
      unchangedAfterMissingPython: true,
    },
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
      runtimePidHandoff: {
        path: runtimePidHandoffPath,
        exists: true,
        sha256: sha256("runtime-pid-handoff"),
        schema: "openrappter-runtime-pid/1.0",
        nonce: successNonce,
        pid: 4242,
      },
      validFixture: {
        path: TRANSPLANT_VALID_FIXTURE,
        exists: true,
        sizeBytes: 128,
        sha256: fixtureHash,
        json: null,
      },
      invalidFixture: {
        path: TRANSPLANT_INVALID_FIXTURE,
        exists: true,
        sizeBytes: 96,
        sha256: invalidFixtureHash,
        json: null,
      },
    },
    exactCommandFlight: {
      databaseReopened: true,
      productionExportValidated: true,
      databaseEvents: structuredClone(events),
      persistedExportEvents: structuredClone(persistedEvents),
      reopenedExportEvents: structuredClone(persistedEvents),
      validatorEvents: structuredClone(persistedEvents),
    },
    probeReport: {
      testFile: TRANSPLANT_INTEGRATION_TEST,
      totalTests: REQUIRED_TRANSPLANT_PROBE_TEST_NAMES.length,
      passedTests: REQUIRED_TRANSPLANT_PROBE_TEST_NAMES.length,
      failedTests: 0,
      skippedTests: 0,
      exactTestNames: true,
      passedTestNames: [...REQUIRED_TRANSPLANT_PROBE_TEST_NAMES],
    },
    independentProbe: {
      schema: TRANSPLANT_PROBE_SCHEMA,
      nonce: probeNonce,
      collections: {
        fixtures: true,
        process: true,
        gateway: true,
        agent: true,
        executions: true,
        rejection: true,
        flight: true,
        provider: true,
      },
      process: {
        pidBefore: 4242,
        pidAfter: 4242,
        gatewayReferenceStable: true,
        registryReferenceStable: true,
        registryConstructorCount: 1,
      },
      gateway: {
        serverClass: "GatewayServer",
        registryClass: "AgentRegistry",
        authMode: "token",
        authorizationScheme: "Bearer",
        unauthenticatedStatus: 401,
        unauthenticatedImporterCalls: 0,
        totalImporterCalls: 2,
        acceptedStatus: 200,
        rejectedStatus: 400,
        requestUrls: [
          `${gatewayBaseUrl}/agents/import`,
          `${gatewayBaseUrl}/agents/import`,
          `${gatewayBaseUrl}/agents/import`,
        ],
      },
      fixtures: {
        validPath: TRANSPLANT_VALID_FIXTURE,
        invalidPath: TRANSPLANT_INVALID_FIXTURE,
        validSha256: fixtureHash,
        invalidSha256: invalidFixtureHash,
        manifestValidSha256: fixtureHash,
        manifestInvalidSha256: invalidFixtureHash,
      },
      agent: {
        className: "PythonAgent",
        bridgeModule: TRANSPLANT_PYTHON_BRIDGE_MODULE,
        sourceFile: `${evidenceRoot}/${manifest.fixture.filename}`,
        sourceSha256Before: fixtureHash,
        sourceSha256After: fixtureHash,
        objectReferenceStable: true,
        registryReferenceStable: true,
      },
      executions: structuredClone(result.executions),
      operationOrder: [
        "valid-import",
        "first-execution",
        "invalid-import",
        "second-execution",
      ],
      rejection: {
        rejectedBeforeCommit: true,
        committed: false,
        targetBytesUnchanged: true,
        targetStatUnchanged: true,
        candidateDiffersFromCommitted: true,
      },
      flight: {
        databasePath: `${probeEvidenceRoot}/flight-recorder.db`,
        exportPath: `${probeEvidenceRoot}/flight-recorder.json`,
        pathsDistinct: true,
        databaseSha256: databaseHash,
        exportSha256: exportHash,
        expectedDatabaseSha256: databaseHash,
        expectedExportSha256: exportHash,
        reopenedQuerySucceeded: true,
        productionValidationPassed: true,
        persistedEventIds: probePersistedEvents.map((event) => event.id),
        reopenedEventIds: probeEvents.map((event) => event.id),
        productionExportEventIds: probePersistedEvents.map((event) => event.id),
        persistedContentHashes: probePersistedEvents.map(
          (event) => event.contentHash,
        ),
        reopenedContentHashes: probeEvents.map((event) => event.contentHash),
        productionExportContentHashes: probePersistedEvents.map(
          (event) => event.contentHash,
        ),
        allContentHashesValid: true,
        events: probeEvents,
        causalStepIds: [
          "trace-started",
          "demo-started",
          "valid-import-started",
          "valid-import-completed",
          "first-execute-started",
          "first-execute-completed",
          "invalid-import-started",
          "invalid-import-failed",
          "second-execute-started",
          "second-execute-completed",
          "demo-completed",
          "trace-completed",
        ],
      },
      provider: {
        manifestModelDependency: "none",
        providerEventCount: 0,
        modelEventCount: 0,
      },
    },
    missingEvidence: [],
    skippedEvidence: [],
  };

  return { manifest, result, missingPythonResult, observations };
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

function requireMissing(
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

function refreshFlightExport(input: LiveOrganTransplantEvaluationInput): void {
  const result = requireResult(input);
  const observations = requireObservations(input);
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

function mutateExactCommandEvent(
  input: LiveOrganTransplantEvaluationInput,
  predicate: (event: FlightEvent, index: number) => boolean,
  mutate: (event: FlightEvent) => Omit<FlightEvent, "contentHash">,
): void {
  const events = requireObservations(input).exactCommandFlight.databaseEvents;
  const index = events.findIndex(predicate);
  if (index < 0) throw new Error("Required exact-command event is missing.");
  const body = mutate(events[index]!);
  events[index] = {
    ...body,
    contentHash: computeFlightEventHash(body),
  };
}

function removeExactCommandEvent(
  input: LiveOrganTransplantEvaluationInput,
  kind: string,
  occurrence = 0,
): void {
  const observations = requireObservations(input);
  let seen = 0;
  const index = observations.exactCommandFlight.databaseEvents.findIndex(
    (event) => {
      if (event.kind !== kind) return false;
      const matches = seen === occurrence;
      seen += 1;
      return matches;
    },
  );
  if (index < 0) throw new Error(`Missing ${kind} occurrence ${occurrence}.`);
  observations.exactCommandFlight.databaseEvents.splice(index, 1);
}

function request(
  result: LiveOrganTransplantSuccessResult,
  purpose: "valid-import" | "invalid-replacement",
) {
  const found = result.gateway.requests.find(
    (entry) => entry.purpose === purpose,
  );
  if (!found) throw new Error(`${purpose} request is required.`);
  return found;
}

function mutation(
  id: MutationId,
  expectedCheckId: LiveOrganTransplantCheckId,
  mutate: MutationProbe["mutate"],
  options: {
    exactFailureIds?: readonly LiveOrganTransplantCheckId[];
    coupling?: string;
  } = {},
): MutationProbe {
  return { id, expectedCheckId, mutate, ...options };
}

const exact = (
  check: LiveOrganTransplantCheckId,
): { exactFailureIds: readonly LiveOrganTransplantCheckId[] } => ({
  exactFailureIds: [check],
});

const strictCoupling = {
  coupling:
    "Changing a strict literal removes the shared result/manifest from downstream evaluation; the intended central check must still be among the failures.",
};

const DOCUMENTED_CAUSAL_COUPLINGS: Partial<Record<MutationId, string>> = {
  "display-valid-status":
    "The authenticated response status is also bound to the exact command import-completed event.",
  "first-digest-corrupted":
    "The first result digest is shared by known-vector, deterministic, and exact-command causal checks.",
  "probe-first-digest-corrupted":
    "The probe result digest is shared by known-vector, deterministic, and probe-causal completeness checks.",
  "invalid-request-status":
    "The invalid HTTP status is also bound to the exact command import-failed event.",
  "rejected-before-commit-false":
    "The result rejection flag is also bound to import-failed causal metadata.",
  "rejected-committed-true":
    "The result commit flag is also bound to import-failed causal metadata.",
  "previous-source-bytes-changed":
    "The active source hash is shared by preservation and exact-command causal linkage.",
  "candidate-equals-committed":
    "The rejected candidate hash is shared by preservation, fixture pins, and exact-command causal linkage.",
  "result-agent-source-hash-drift":
    "The reported active source hash is shared by preservation, fixture pins, and exact-command causal linkage.",
  "second-execution-diverged":
    "The post-rejection digest is shared by deterministic and exact-command causal checks.",
  "provider-counter-incremented":
    "Provider counters are checked both directly and against the exact command trace.",
  "model-counter-incremented":
    "Model counters are checked both directly and against the exact command trace.",
  "accepted-fixture-link-drift":
    "The accepted candidate hash is shared by fixture pins and exact-command import events.",
  "rejected-fixture-link-drift":
    "The rejected candidate hash is shared by fixture pins and exact-command import events.",
  "probe-valid-fixture-hash-drift":
    "The probe fixture hash is shared by fixture pins and probe-causal completeness.",
  "probe-invalid-fixture-hash-drift":
    "The probe invalid hash is shared by fixture pins and probe-causal completeness.",
};

const MUTATIONS: readonly MutationProbe[] = [
  mutation(
    "extra-result-field",
    "result-schema",
    (input) => {
      input.result = { ...requireResult(input), unexpected: true };
    },
    exact("result-schema"),
  ),
  mutation(
    "success-exit-nonzero",
    "result-schema",
    (input) => {
      requireObservations(input).successExitCode = 1;
    },
    exact("result-schema"),
  ),
  mutation(
    "success-record-count-drift",
    "result-schema",
    (input) => {
      requireObservations(input).successRecordCount = 2;
    },
    exact("result-schema"),
  ),
  mutation(
    "success-record-noncanonical",
    "result-schema",
    (input) => {
      requireObservations(input).successRecordCanonical = false;
    },
    exact("result-schema"),
  ),
  mutation(
    "runtime-artifact-hash-mismatch",
    "compiled-runtime",
    (input) => {
      requireResult(input).runtime.entrypointSha256 =
        sha256("different-runtime");
    },
    exact("compiled-runtime"),
  ),
  mutation(
    "runtime-mode-drift",
    "compiled-runtime",
    (input) => {
      requireResult(input).runtime.mode =
        "typescript-loader" as "compiled-javascript";
    },
    strictCoupling,
  ),
  mutation(
    "runtime-entrypoint-drift",
    "compiled-runtime",
    (input) => {
      requireResult(input).runtime.entrypoint =
        "typescript/dist/demo/other.js" as typeof TRANSPLANT_RUNTIME_ENTRYPOINT;
    },
    strictCoupling,
  ),
  mutation(
    "runtime-reported-size-drift",
    "compiled-runtime",
    (input) => {
      requireResult(input).runtime.entrypointSizeBytes = 1;
    },
    exact("compiled-runtime"),
  ),
  mutation(
    "runtime-loader-used",
    "compiled-runtime",
    (input) => {
      requireResult(input).runtime.typescriptRuntimeLoaderUsed = true;
    },
    exact("compiled-runtime"),
  ),
  mutation(
    "runtime-observation-missing",
    "compiled-runtime",
    (input) => {
      requireObservations(input).artifacts.runtimeEntrypoint.exists = false;
    },
    exact("compiled-runtime"),
  ),
  mutation(
    "runtime-observation-path-drift",
    "compiled-runtime",
    (input) => {
      requireObservations(input).artifacts.runtimeEntrypoint.path += ".other";
    },
    exact("compiled-runtime"),
  ),
  mutation(
    "runtime-observation-hash-drift",
    "compiled-runtime",
    (input) => {
      requireObservations(input).artifacts.runtimeEntrypoint.sha256 =
        sha256("other-runtime");
    },
    exact("compiled-runtime"),
  ),
  mutation(
    "runtime-observation-size-mismatch",
    "compiled-runtime",
    (input) => {
      requireObservations(input).artifacts.runtimeEntrypoint.sizeBytes = 1;
    },
    exact("compiled-runtime"),
  ),
  mutation(
    "runtime-observation-empty",
    "compiled-runtime",
    (input) => {
      requireObservations(input).artifacts.runtimeEntrypoint.sizeBytes = 0;
    },
    exact("compiled-runtime"),
  ),
  mutation(
    "success-nonce-mismatch",
    "isolated-scenario-evidence",
    (input) => {
      requireResult(input).scenario.nonce = "different-success-nonce";
    },
    exact("isolated-scenario-evidence"),
  ),
  mutation(
    "success-directory-mismatch",
    "isolated-scenario-evidence",
    (input) => {
      requireResult(input).scenario.evidenceDirectory += ".other";
    },
    exact("isolated-scenario-evidence"),
  ),
  mutation(
    "missing-nonce-mismatch",
    "isolated-scenario-evidence",
    (input) => {
      requireMissing(input).scenario.nonce = "different-missing-nonce";
    },
    exact("isolated-scenario-evidence"),
  ),
  mutation(
    "missing-nonce-reused",
    "isolated-scenario-evidence",
    (input) => {
      const observations = requireObservations(input);
      requireMissing(input).scenario.nonce = observations.successScenario.nonce;
      observations.missingPythonScenario.nonce =
        observations.successScenario.nonce;
    },
    exact("isolated-scenario-evidence"),
  ),
  mutation(
    "missing-directory-mismatch",
    "isolated-scenario-evidence",
    (input) => {
      requireMissing(input).scenario.evidenceDirectory += ".other";
    },
    exact("isolated-scenario-evidence"),
  ),
  mutation(
    "scenario-directory-reused",
    "isolated-scenario-evidence",
    (input) => {
      const observations = requireObservations(input);
      requireMissing(input).scenario.evidenceDirectory =
        observations.successScenario.evidenceDirectory;
      observations.missingPythonScenario.evidenceDirectory =
        observations.successScenario.evidenceDirectory;
    },
    exact("isolated-scenario-evidence"),
  ),
  mutation(
    "success-directory-not-empty",
    "isolated-scenario-evidence",
    (input) => {
      requireObservations(input).successScenario.startedEmpty = false;
    },
    exact("isolated-scenario-evidence"),
  ),
  mutation(
    "missing-directory-not-empty",
    "isolated-scenario-evidence",
    (input) => {
      requireObservations(input).missingPythonScenario.startedEmpty = false;
    },
    exact("isolated-scenario-evidence"),
  ),
  mutation(
    "frozen-not-captured",
    "isolated-scenario-evidence",
    (input) => {
      requireObservations(input).frozenSuccessEvidence.captured = false;
    },
    exact("isolated-scenario-evidence"),
  ),
  mutation(
    "frozen-empty",
    "isolated-scenario-evidence",
    (input) => {
      requireObservations(input).frozenSuccessEvidence.fileCount = 0;
    },
    exact("isolated-scenario-evidence"),
  ),
  mutation(
    "frozen-changed-after-causal-read",
    "isolated-scenario-evidence",
    (input) => {
      requireObservations(
        input,
      ).frozenSuccessEvidence.unchangedAfterCausalRead = false;
    },
    exact("isolated-scenario-evidence"),
  ),
  mutation(
    "frozen-changed-after-missing",
    "isolated-scenario-evidence",
    (input) => {
      requireObservations(
        input,
      ).frozenSuccessEvidence.unchangedAfterMissingPython = false;
    },
    exact("isolated-scenario-evidence"),
  ),
  mutation(
    "database-export-path-alias",
    "isolated-scenario-evidence",
    (input) => {
      const result = requireResult(input);
      result.flightRecorder.export.path = result.flightRecorder.database.path;
    },
    {
      exactFailureIds: [
        "isolated-scenario-evidence",
        "flight-recorder-integrity",
      ],
    },
  ),
  mutation(
    "database-path-outside-success",
    "isolated-scenario-evidence",
    (input) => {
      const result = requireResult(input);
      const observations = requireObservations(input);
      const outside = `${requireManifest(input).artifacts.evidenceRoot}/outside/flight.db`;
      result.flightRecorder.database.path = outside;
      observations.artifacts.flightDatabase.path = outside;
    },
    exact("isolated-scenario-evidence"),
  ),
  mutation(
    "export-path-outside-success",
    "isolated-scenario-evidence",
    (input) => {
      const result = requireResult(input);
      const observations = requireObservations(input);
      const outside = `${requireManifest(input).artifacts.evidenceRoot}/outside/flight.json`;
      result.flightRecorder.export.path = outside;
      observations.artifacts.flightExport.path = outside;
    },
    exact("isolated-scenario-evidence"),
  ),
  mutation(
    "display-pid-changed",
    "host-identity-preserved",
    (input) => {
      requireResult(input).host.pidAfter += 1;
    },
    exact("host-identity-preserved"),
  ),
  mutation(
    "display-start-identity-changed",
    "host-identity-preserved",
    (input) => {
      requireResult(input).host.startIdentityAfter = "different-start";
    },
    exact("host-identity-preserved"),
  ),
  mutation(
    "probe-pid-changed",
    "host-identity-preserved",
    (input) => {
      requireObservations(input).independentProbe.process.pidAfter += 1;
    },
    exact("host-identity-preserved"),
  ),
  mutation(
    "probe-gateway-reference-changed",
    "host-identity-preserved",
    (input) => {
      requireObservations(
        input,
      ).independentProbe.process.gatewayReferenceStable = false;
    },
    exact("host-identity-preserved"),
  ),
  mutation(
    "probe-registry-reference-changed",
    "host-identity-preserved",
    (input) => {
      requireObservations(
        input,
      ).independentProbe.process.registryReferenceStable = false;
    },
    exact("host-identity-preserved"),
  ),
  mutation(
    "probe-registry-count-two",
    "host-identity-preserved",
    (input) => {
      requireObservations(
        input,
      ).independentProbe.process.registryConstructorCount = 2;
    },
    exact("host-identity-preserved"),
  ),
  mutation(
    "display-auth-mode-drift",
    "authenticated-http-import",
    (input) => {
      requireResult(input).gateway.authMode = "none" as "token";
    },
    strictCoupling,
  ),
  mutation(
    "display-server-class-drift",
    "authenticated-http-import",
    (input) => {
      requireResult(input).gateway.serverClass =
        "OtherServer" as "GatewayServer";
    },
    strictCoupling,
  ),
  mutation(
    "display-server-module-drift",
    "authenticated-http-import",
    (input) => {
      requireResult(input).gateway.serverModule =
        "typescript/dist/gateway/other.js";
    },
    exact("authenticated-http-import"),
  ),
  mutation(
    "display-auth-header-drift",
    "authenticated-http-import",
    (input) => {
      request(requireResult(input), "valid-import").authorization =
        "query-token";
    },
    exact("authenticated-http-import"),
  ),
  mutation(
    "display-valid-method-drift",
    "authenticated-http-import",
    (input) => {
      request(requireResult(input), "valid-import").method = "PUT";
    },
    {
      exactFailureIds: [
        "authenticated-http-import",
        "loopback-gateway-requests",
      ],
    },
  ),
  mutation(
    "display-valid-path-drift",
    "authenticated-http-import",
    (input) => {
      request(requireResult(input), "valid-import").path = "/other";
    },
    {
      exactFailureIds: [
        "authenticated-http-import",
        "loopback-gateway-requests",
      ],
    },
  ),
  mutation(
    "display-valid-auth-false",
    "authenticated-http-import",
    (input) => {
      request(requireResult(input), "valid-import").authenticated = false;
    },
    exact("authenticated-http-import"),
  ),
  mutation(
    "display-route-false",
    "authenticated-http-import",
    (input) => {
      requireResult(input).gateway.productionImportRoute = false;
    },
    exact("authenticated-http-import"),
  ),
  mutation(
    "display-valid-status",
    "authenticated-http-import",
    (input) => {
      request(requireResult(input), "valid-import").status = 201;
    },
    exact("authenticated-http-import"),
  ),
  mutation(
    "accepted-status",
    "authenticated-http-import",
    (input) => {
      requireResult(input).imports.accepted.httpStatus = 201;
    },
    exact("authenticated-http-import"),
  ),
  mutation(
    "accepted-response",
    "authenticated-http-import",
    (input) => {
      requireResult(input).imports.accepted.responseStatus = "accepted";
    },
    exact("authenticated-http-import"),
  ),
  mutation(
    "accepted-committed-false",
    "authenticated-http-import",
    (input) => {
      requireResult(input).imports.accepted.committed = false;
    },
    exact("authenticated-http-import"),
  ),
  mutation(
    "probe-auth-mode",
    "authenticated-http-import",
    (input) => {
      requireObservations(input).independentProbe.gateway.authMode = "none";
    },
    exact("authenticated-http-import"),
  ),
  mutation(
    "probe-server-class-drift",
    "authenticated-http-import",
    (input) => {
      requireObservations(input).independentProbe.gateway.serverClass =
        "OtherServer";
    },
    exact("authenticated-http-import"),
  ),
  mutation(
    "probe-registry-class-drift",
    "authenticated-http-import",
    (input) => {
      requireObservations(input).independentProbe.gateway.registryClass =
        "OtherRegistry";
    },
    exact("authenticated-http-import"),
  ),
  mutation(
    "probe-auth-scheme",
    "authenticated-http-import",
    (input) => {
      requireObservations(input).independentProbe.gateway.authorizationScheme =
        "Query";
    },
    exact("authenticated-http-import"),
  ),
  mutation(
    "probe-unauth-status",
    "authenticated-http-import",
    (input) => {
      requireObservations(
        input,
      ).independentProbe.gateway.unauthenticatedStatus = 200;
    },
    exact("authenticated-http-import"),
  ),
  mutation(
    "probe-unauth-importer-called",
    "authenticated-http-import",
    (input) => {
      requireObservations(
        input,
      ).independentProbe.gateway.unauthenticatedImporterCalls = 1;
    },
    exact("authenticated-http-import"),
  ),
  mutation(
    "probe-total-importer-count",
    "authenticated-http-import",
    (input) => {
      requireObservations(input).independentProbe.gateway.totalImporterCalls =
        3;
    },
    exact("authenticated-http-import"),
  ),
  mutation(
    "probe-accepted-status",
    "authenticated-http-import",
    (input) => {
      requireObservations(input).independentProbe.gateway.acceptedStatus = 201;
    },
    exact("authenticated-http-import"),
  ),
  mutation(
    "display-bridge-class-drift",
    "python-agent-bridge",
    (input) => {
      requireResult(input).agent.bridgeClass = "NativeAgent" as "PythonAgent";
    },
    strictCoupling,
  ),
  mutation(
    "display-agent-name-drift",
    "python-agent-bridge",
    (input) => {
      requireResult(input).agent.name = "OtherAgent" as "ChecksumAgent";
    },
    strictCoupling,
  ),
  mutation(
    "display-bridge-module-drift",
    "python-agent-bridge",
    (input) => {
      requireResult(input).agent.bridgeModule =
        "typescript/dist/agents/NativeAgent.js";
    },
    exact("python-agent-bridge"),
  ),
  mutation(
    "display-registry-class-drift",
    "python-agent-bridge",
    (input) => {
      requireResult(input).agent.registryClass =
        "OtherRegistry" as "AgentRegistry";
    },
    strictCoupling,
  ),
  mutation(
    "probe-agent-class-drift",
    "python-agent-bridge",
    (input) => {
      requireObservations(input).independentProbe.agent.className =
        "NotPythonAgent";
    },
    exact("python-agent-bridge"),
  ),
  mutation(
    "probe-bridge-module-drift",
    "python-agent-bridge",
    (input) => {
      requireObservations(input).independentProbe.agent.bridgeModule =
        "typescript/dist/agents/NotPythonAgent.js";
    },
    exact("python-agent-bridge"),
  ),
  mutation(
    "probe-source-file-drift",
    "python-agent-bridge",
    (input) => {
      requireObservations(input).independentProbe.agent.sourceFile =
        "/state/not-the-fixture.py";
    },
    exact("python-agent-bridge"),
  ),
  mutation(
    "first-input-drift",
    "known-vector-first-execution",
    (input) => {
      requireResult(input).executions.first.input = "wrong-input";
    },
    {
      exactFailureIds: [
        "known-vector-first-execution",
        "deterministic-second-execution",
      ],
    },
  ),
  mutation(
    "first-algorithm-drift",
    "known-vector-first-execution",
    (input) => {
      requireResult(input).executions.first.output.algorithm = "md5";
    },
    {
      exactFailureIds: [
        "known-vector-first-execution",
        "deterministic-second-execution",
      ],
    },
  ),
  mutation(
    "first-digest-corrupted",
    "known-vector-first-execution",
    (input) => {
      requireResult(input).executions.first.output.digest = sha256("wrong");
    },
    {
      exactFailureIds: [
        "known-vector-first-execution",
        "deterministic-second-execution",
      ],
    },
  ),
  mutation(
    "probe-first-input-drift",
    "known-vector-first-execution",
    (input) => {
      requireObservations(input).independentProbe.executions.first.input =
        "wrong-input";
    },
    {
      exactFailureIds: [
        "known-vector-first-execution",
        "deterministic-second-execution",
      ],
    },
  ),
  mutation(
    "probe-first-algorithm-drift",
    "known-vector-first-execution",
    (input) => {
      requireObservations(
        input,
      ).independentProbe.executions.first.output.algorithm = "md5";
    },
    {
      exactFailureIds: [
        "known-vector-first-execution",
        "deterministic-second-execution",
      ],
    },
  ),
  mutation(
    "probe-first-digest-corrupted",
    "known-vector-first-execution",
    (input) => {
      requireObservations(
        input,
      ).independentProbe.executions.first.output.digest = sha256("wrong");
    },
    {
      exactFailureIds: [
        "known-vector-first-execution",
        "deterministic-second-execution",
      ],
    },
  ),
  mutation(
    "invalid-request-status",
    "bad-candidate-rejected-before-commit",
    (input) => {
      request(requireResult(input), "invalid-replacement").status = 409;
    },
    exact("bad-candidate-rejected-before-commit"),
  ),
  mutation(
    "invalid-request-unauthenticated",
    "bad-candidate-rejected-before-commit",
    (input) => {
      request(requireResult(input), "invalid-replacement").authenticated =
        false;
    },
    exact("bad-candidate-rejected-before-commit"),
  ),
  mutation(
    "invalid-request-auth-header-drift",
    "bad-candidate-rejected-before-commit",
    (input) => {
      request(requireResult(input), "invalid-replacement").authorization =
        "query-token";
    },
    exact("bad-candidate-rejected-before-commit"),
  ),
  mutation(
    "invalid-request-method-drift",
    "bad-candidate-rejected-before-commit",
    (input) => {
      request(requireResult(input), "invalid-replacement").method = "PUT";
    },
    {
      exactFailureIds: [
        "bad-candidate-rejected-before-commit",
        "loopback-gateway-requests",
      ],
    },
  ),
  mutation(
    "invalid-request-path-drift",
    "bad-candidate-rejected-before-commit",
    (input) => {
      request(requireResult(input), "invalid-replacement").path = "/other";
    },
    {
      exactFailureIds: [
        "bad-candidate-rejected-before-commit",
        "loopback-gateway-requests",
      ],
    },
  ),
  mutation(
    "rejected-http-status",
    "bad-candidate-rejected-before-commit",
    (input) => {
      requireResult(input).imports.rejected.httpStatus = 409;
    },
    exact("bad-candidate-rejected-before-commit"),
  ),
  mutation(
    "rejected-response-status",
    "bad-candidate-rejected-before-commit",
    (input) => {
      requireResult(input).imports.rejected.responseStatus = "accepted";
    },
    exact("bad-candidate-rejected-before-commit"),
  ),
  mutation(
    "rejected-before-commit-false",
    "bad-candidate-rejected-before-commit",
    (input) => {
      requireResult(input).imports.rejected.rejectedBeforeCommit = false;
    },
    exact("bad-candidate-rejected-before-commit"),
  ),
  mutation(
    "rejected-committed-true",
    "bad-candidate-rejected-before-commit",
    (input) => {
      requireResult(input).imports.rejected.committed = true;
    },
    exact("bad-candidate-rejected-before-commit"),
  ),
  mutation(
    "rejected-filename-drift",
    "bad-candidate-rejected-before-commit",
    (input) => {
      requireResult(input).imports.rejected.filename = "other_agent.py";
    },
    exact("bad-candidate-rejected-before-commit"),
  ),
  mutation(
    "probe-rejected-status",
    "bad-candidate-rejected-before-commit",
    (input) => {
      requireObservations(input).independentProbe.gateway.rejectedStatus = 409;
    },
    exact("bad-candidate-rejected-before-commit"),
  ),
  mutation(
    "probe-rejected-before-commit-false",
    "bad-candidate-rejected-before-commit",
    (input) => {
      requireObservations(
        input,
      ).independentProbe.rejection.rejectedBeforeCommit = false;
    },
    exact("bad-candidate-rejected-before-commit"),
  ),
  mutation(
    "probe-rejected-committed-true",
    "bad-candidate-rejected-before-commit",
    (input) => {
      requireObservations(input).independentProbe.rejection.committed = true;
    },
    exact("bad-candidate-rejected-before-commit"),
  ),
  mutation(
    "probe-target-bytes-changed",
    "bad-candidate-rejected-before-commit",
    (input) => {
      requireObservations(
        input,
      ).independentProbe.rejection.targetBytesUnchanged = false;
    },
    exact("bad-candidate-rejected-before-commit"),
  ),
  mutation(
    "probe-target-stat-changed",
    "bad-candidate-rejected-before-commit",
    (input) => {
      requireObservations(
        input,
      ).independentProbe.rejection.targetStatUnchanged = false;
    },
    exact("bad-candidate-rejected-before-commit"),
  ),
  mutation(
    "previous-preserved-false",
    "previous-generation-preserved",
    (input) => {
      requireResult(input).preservation.previousGenerationPreserved = false;
    },
    exact("previous-generation-preserved"),
  ),
  mutation(
    "previous-source-bytes-changed",
    "previous-generation-preserved",
    (input) => {
      requireResult(input).agent.sourceSha256After = sha256("changed-source");
    },
    exact("previous-generation-preserved"),
  ),
  mutation(
    "previous-object-identity-changed",
    "previous-generation-preserved",
    (input) => {
      requireResult(input).agent.objectIdentityAfter = "replacement-object";
    },
    exact("previous-generation-preserved"),
  ),
  mutation(
    "previous-registry-identity-changed",
    "previous-generation-preserved",
    (input) => {
      requireResult(input).agent.registryInstanceIdAfter =
        "replacement-registry";
    },
    exact("previous-generation-preserved"),
  ),
  mutation(
    "candidate-equals-committed",
    "previous-generation-preserved",
    (input) => {
      const result = requireResult(input);
      result.imports.rejected.candidateSourceSha256 =
        result.agent.sourceSha256Before;
    },
    {
      exactFailureIds: [
        "previous-generation-preserved",
        "fixture-source-hash-pinned",
      ],
    },
  ),
  mutation(
    "probe-object-reference-changed",
    "previous-generation-preserved",
    (input) => {
      requireObservations(input).independentProbe.agent.objectReferenceStable =
        false;
    },
    exact("previous-generation-preserved"),
  ),
  mutation(
    "probe-agent-registry-reference-changed",
    "previous-generation-preserved",
    (input) => {
      requireObservations(
        input,
      ).independentProbe.agent.registryReferenceStable = false;
    },
    exact("previous-generation-preserved"),
  ),
  mutation(
    "probe-source-bytes-changed",
    "previous-generation-preserved",
    (input) => {
      requireObservations(input).independentProbe.agent.sourceSha256After =
        sha256("changed-source");
    },
    exact("previous-generation-preserved"),
  ),
  mutation(
    "probe-candidate-equals-committed",
    "previous-generation-preserved",
    (input) => {
      requireObservations(
        input,
      ).independentProbe.rejection.candidateDiffersFromCommitted = false;
    },
    exact("previous-generation-preserved"),
  ),
  mutation(
    "second-execution-diverged",
    "deterministic-second-execution",
    (input) => {
      requireResult(input).executions.second.output.digest =
        sha256("divergent-second");
    },
    exact("deterministic-second-execution"),
  ),
  mutation(
    "second-execution-input-drift",
    "deterministic-second-execution",
    (input) => {
      requireResult(input).executions.second.input = "other-input";
    },
    exact("deterministic-second-execution"),
  ),
  mutation(
    "second-execution-algorithm-drift",
    "deterministic-second-execution",
    (input) => {
      requireResult(input).executions.second.output.algorithm = "md5";
    },
    exact("deterministic-second-execution"),
  ),
  mutation(
    "probe-second-execution-diverged",
    "deterministic-second-execution",
    (input) => {
      requireObservations(
        input,
      ).independentProbe.executions.second.output.digest =
        sha256("divergent-second");
    },
    exact("deterministic-second-execution"),
  ),
  mutation(
    "probe-second-execution-input-drift",
    "deterministic-second-execution",
    (input) => {
      requireObservations(input).independentProbe.executions.second.input =
        "other-input";
    },
    exact("deterministic-second-execution"),
  ),
  mutation(
    "probe-second-execution-algorithm-drift",
    "deterministic-second-execution",
    (input) => {
      requireObservations(
        input,
      ).independentProbe.executions.second.output.algorithm = "md5";
    },
    exact("deterministic-second-execution"),
  ),
  mutation(
    "probe-operation-order-swapped",
    "deterministic-second-execution",
    (input) => {
      const order = requireObservations(input).independentProbe.operationOrder;
      [order[1], order[2]] = [order[2]!, order[1]!];
    },
    exact("deterministic-second-execution"),
  ),
  mutation(
    "flight-disabled",
    "flight-recorder-integrity",
    (input) => {
      requireResult(input).flightRecorder.enabled = false;
    },
    exact("flight-recorder-integrity"),
  ),
  mutation(
    "flight-not-persisted",
    "flight-recorder-integrity",
    (input) => {
      requireResult(input).flightRecorder.persisted = false;
    },
    exact("flight-recorder-integrity"),
  ),
  mutation(
    "flight-event-count-drift",
    "flight-recorder-integrity",
    (input) => {
      requireResult(input).flightRecorder.eventCount += 1;
    },
    exact("flight-recorder-integrity"),
  ),
  mutation(
    "flight-too-few-events",
    "flight-recorder-integrity",
    (input) => {
      const result = requireResult(input);
      result.flightRecorder.events = result.flightRecorder.events.slice(0, 5);
      result.flightRecorder.eventCount = 5;
      refreshFlightExport(input);
    },
    exact("flight-recorder-integrity"),
  ),
  mutation(
    "flight-event-hash-corrupted",
    "flight-recorder-integrity",
    (input) => {
      requireResult(input).flightRecorder.events[0]!.contentHash =
        sha256("corrupt-hash");
    },
    strictCoupling,
  ),
  mutation(
    "flight-event-id-drift",
    "flight-recorder-integrity",
    (input) => {
      const result = requireResult(input);
      const { contentHash: _hash, ...body } = result.flightRecorder.events[0]!;
      const changed = { ...body, id: "different-flight-event-id" };
      result.flightRecorder.events[0] = {
        ...changed,
        contentHash: computeFlightEventHash(changed),
      };
      refreshFlightExport(input);
    },
    exact("flight-recorder-integrity"),
  ),
  mutation(
    "flight-required-kind-missing",
    "flight-recorder-integrity",
    (input) => {
      const result = requireResult(input);
      const { contentHash: _hash, ...body } = result.flightRecorder.events[0]!;
      const changed = { ...body, kind: "demo.unrelated" };
      result.flightRecorder.events[0] = {
        ...changed,
        contentHash: computeFlightEventHash(changed),
      };
      refreshFlightExport(input);
    },
    exact("flight-recorder-integrity"),
  ),
  mutation(
    "causal-order-swap",
    "exact-command-causal-trace",
    (input) => {
      const events =
        requireObservations(input).exactCommandFlight.databaseEvents;
      [events[4], events[6]] = [events[6]!, events[4]!];
    },
    {
      exactFailureIds: [
        "flight-recorder-integrity",
        "exact-command-causal-trace",
      ],
    },
  ),
  mutation(
    "causal-wrong-nonce",
    "exact-command-causal-trace",
    (input) => {
      mutateExactCommandEvent(
        input,
        (event) => event.kind === "demo.transplant.started",
        (event) => {
          const { contentHash: _hash, ...body } = event;
          return { ...body, metadata: { ...body.metadata, nonce: "wrong" } };
        },
      );
    },
    {
      exactFailureIds: [
        "flight-recorder-integrity",
        "exact-command-causal-trace",
      ],
    },
  ),
  mutation(
    "causal-wrong-trace-id",
    "exact-command-causal-trace",
    (input) => {
      mutateExactCommandEvent(
        input,
        (_event, index) => index === 5,
        (event) => {
          const { contentHash: _hash, ...body } = event;
          return { ...body, traceId: "wrong-trace" };
        },
      );
    },
    {
      exactFailureIds: [
        "flight-recorder-integrity",
        "exact-command-causal-trace",
      ],
    },
  ),
  mutation(
    "causal-broken-parent-chain",
    "exact-command-causal-trace",
    (input) => {
      mutateExactCommandEvent(
        input,
        (event) => event.kind === "agent.import.failed",
        (event) => {
          const { contentHash: _hash, ...body } = event;
          return { ...body, parentId: "unrelated-parent" };
        },
      );
    },
    {
      exactFailureIds: [
        "flight-recorder-integrity",
        "exact-command-causal-trace",
      ],
    },
  ),
  mutation(
    "causal-wrong-valid-hash",
    "exact-command-causal-trace",
    (input) => {
      mutateExactCommandEvent(
        input,
        (event) =>
          event.kind === "agent.import.started" && event.sequence === 3,
        (event) => {
          const { contentHash: _hash, ...body } = event;
          return {
            ...body,
            metadata: {
              ...body.metadata,
              candidateSourceSha256: sha256("wrong-valid"),
            },
          };
        },
      );
    },
    {
      exactFailureIds: [
        "flight-recorder-integrity",
        "exact-command-causal-trace",
      ],
    },
  ),
  mutation(
    "causal-wrong-invalid-hash",
    "exact-command-causal-trace",
    (input) => {
      mutateExactCommandEvent(
        input,
        (event) =>
          event.kind === "agent.import.started" && event.sequence === 7,
        (event) => {
          const { contentHash: _hash, ...body } = event;
          return {
            ...body,
            metadata: {
              ...body.metadata,
              candidateSourceSha256: sha256("wrong-invalid"),
            },
          };
        },
      );
    },
    {
      exactFailureIds: [
        "flight-recorder-integrity",
        "exact-command-causal-trace",
      ],
    },
  ),
  mutation(
    "causal-wrong-active-hash",
    "exact-command-causal-trace",
    (input) => {
      mutateExactCommandEvent(
        input,
        (event) => event.kind === "agent.import.failed",
        (event) => {
          const { contentHash: _hash, ...body } = event;
          return {
            ...body,
            metadata: {
              ...body.metadata,
              activeSourceSha256: sha256("wrong-active"),
            },
          };
        },
      );
    },
    {
      exactFailureIds: [
        "flight-recorder-integrity",
        "exact-command-causal-trace",
      ],
    },
  ),
  mutation(
    "causal-wrong-first-digest",
    "exact-command-causal-trace",
    (input) => {
      mutateExactCommandEvent(
        input,
        (event) =>
          event.kind === "agent.execute.completed" && event.sequence === 6,
        (event) => {
          const { contentHash: _hash, ...body } = event;
          return {
            ...body,
            payload: { result: { digest: sha256("wrong-first") } },
          };
        },
      );
    },
    {
      exactFailureIds: [
        "flight-recorder-integrity",
        "exact-command-causal-trace",
      ],
    },
  ),
  mutation(
    "causal-wrong-second-digest",
    "exact-command-causal-trace",
    (input) => {
      mutateExactCommandEvent(
        input,
        (event) =>
          event.kind === "agent.execute.completed" && event.sequence === 10,
        (event) => {
          const { contentHash: _hash, ...body } = event;
          return {
            ...body,
            payload: { result: { digest: sha256("wrong-second") } },
          };
        },
      );
    },
    {
      exactFailureIds: [
        "flight-recorder-integrity",
        "exact-command-causal-trace",
      ],
    },
  ),
  mutation(
    "causal-wrong-agent-name",
    "exact-command-causal-trace",
    (input) => {
      mutateExactCommandEvent(
        input,
        (event) => event.kind === "agent.execute.completed",
        (event) => {
          const { contentHash: _hash, ...body } = event;
          return { ...body, agentName: "OtherAgent" };
        },
      );
    },
    {
      exactFailureIds: [
        "flight-recorder-integrity",
        "exact-command-causal-trace",
      ],
    },
  ),
  mutation(
    "causal-wrong-bridge-class",
    "exact-command-causal-trace",
    (input) => {
      mutateExactCommandEvent(
        input,
        (event) => event.kind === "agent.import.completed",
        (event) => {
          const { contentHash: _hash, ...body } = event;
          return {
            ...body,
            metadata: { ...body.metadata, bridgeClass: "NativeAgent" },
          };
        },
      );
    },
    {
      exactFailureIds: [
        "flight-recorder-integrity",
        "exact-command-causal-trace",
      ],
    },
  ),
  mutation(
    "causal-wrong-owner-pid",
    "exact-command-causal-trace",
    (input) => {
      mutateExactCommandEvent(
        input,
        (event) => event.kind === "trace.started",
        (event) => {
          const { contentHash: _hash, ...body } = event;
          return { ...body, metadata: { ...body.metadata, ownerPid: 9999 } };
        },
      );
    },
    {
      exactFailureIds: [
        "host-identity-preserved",
        "flight-recorder-integrity",
        "exact-command-causal-trace",
      ],
    },
  ),
  mutation(
    "causal-wrong-runtime-handoff-pid",
    "exact-command-causal-trace",
    (input) => {
      requireObservations(input).artifacts.runtimePidHandoff.pid = 9999;
    },
    {
      exactFailureIds: [
        "host-identity-preserved",
        "exact-command-causal-trace",
      ],
    },
  ),
  mutation(
    "causal-unrelated-trace-substitution",
    "exact-command-causal-trace",
    (input) => {
      const observations = requireObservations(input);
      observations.exactCommandFlight.databaseEvents =
        observations.exactCommandFlight.databaseEvents.map((event) => {
          const { contentHash: _hash, ...body } = event;
          const changed = { ...body, traceId: "unrelated-trace" };
          return {
            ...changed,
            contentHash: computeFlightEventHash(changed),
          };
        });
    },
    {
      exactFailureIds: [
        "flight-recorder-integrity",
        "exact-command-causal-trace",
      ],
    },
  ),
  mutation(
    "causal-nonmonotonic-sequence",
    "exact-command-causal-trace",
    (input) => {
      mutateExactCommandEvent(
        input,
        (_event, index) => index === 5,
        (event) => {
          const { contentHash: _hash, ...body } = event;
          return { ...body, sequence: 2 };
        },
      );
    },
    {
      exactFailureIds: [
        "flight-recorder-integrity",
        "exact-command-causal-trace",
      ],
    },
  ),
  mutation(
    "causal-import-failed-status-drift",
    "exact-command-causal-trace",
    (input) => {
      mutateExactCommandEvent(
        input,
        (event) => event.kind === "agent.import.failed",
        (event) => {
          const { contentHash: _hash, ...body } = event;
          return { ...body, status: "success" };
        },
      );
    },
    {
      exactFailureIds: [
        "flight-recorder-integrity",
        "exact-command-causal-trace",
      ],
    },
  ),
  mutation(
    "causal-second-execution-before-rejection",
    "exact-command-causal-trace",
    (input) => {
      const events =
        requireObservations(input).exactCommandFlight.databaseEvents;
      const secondExecution = events.splice(8, 2);
      events.splice(6, 0, ...secondExecution);
    },
    {
      exactFailureIds: [
        "flight-recorder-integrity",
        "exact-command-causal-trace",
      ],
    },
  ),
  ...(
    [
      ["causal-missing-trace-started", "trace.started", 0, true],
      ["causal-missing-demo-started", "demo.transplant.started", 0, false],
      ["causal-missing-valid-import-started", "agent.import.started", 0, false],
      [
        "causal-missing-valid-import-completed",
        "agent.import.completed",
        0,
        false,
      ],
      [
        "causal-missing-first-execute-started",
        "agent.execute.started",
        0,
        false,
      ],
      [
        "causal-missing-first-execute-completed",
        "agent.execute.completed",
        0,
        false,
      ],
      [
        "causal-missing-invalid-import-started",
        "agent.import.started",
        1,
        false,
      ],
      ["causal-missing-invalid-import-failed", "agent.import.failed", 0, false],
      [
        "causal-missing-second-execute-started",
        "agent.execute.started",
        1,
        false,
      ],
      [
        "causal-missing-second-execute-completed",
        "agent.execute.completed",
        1,
        false,
      ],
      ["causal-missing-demo-completed", "demo.transplant.completed", 0, false],
      ["causal-missing-trace-completed", "trace.completed", 0, false],
    ] as const
  ).map(([id, kind, occurrence, removesOwner]) =>
    mutation(
      id,
      "exact-command-causal-trace",
      (input) => removeExactCommandEvent(input, kind, occurrence),
      {
        exactFailureIds: [
          ...(removesOwner ? (["host-identity-preserved"] as const) : []),
          "flight-recorder-integrity",
          "exact-command-causal-trace",
        ],
      },
    ),
  ),
  mutation(
    "database-artifact-path-drift",
    "flight-recorder-integrity",
    (input) => {
      requireObservations(input).artifacts.flightDatabase.path += ".other";
    },
    exact("flight-recorder-integrity"),
  ),
  mutation(
    "database-artifact-size-drift",
    "flight-recorder-integrity",
    (input) => {
      requireObservations(input).artifacts.flightDatabase.sizeBytes = 1;
    },
    exact("flight-recorder-integrity"),
  ),
  mutation(
    "database-artifact-hash-drift",
    "flight-recorder-integrity",
    (input) => {
      requireObservations(input).artifacts.flightDatabase.sha256 =
        sha256("other-database");
    },
    exact("flight-recorder-integrity"),
  ),
  mutation(
    "export-artifact-path-drift",
    "flight-recorder-integrity",
    (input) => {
      requireObservations(input).artifacts.flightExport.path += ".other";
    },
    exact("flight-recorder-integrity"),
  ),
  mutation(
    "export-artifact-size-drift",
    "flight-recorder-integrity",
    (input) => {
      requireObservations(input).artifacts.flightExport.sizeBytes = 1;
    },
    exact("flight-recorder-integrity"),
  ),
  mutation(
    "export-artifact-hash-drift",
    "flight-recorder-integrity",
    (input) => {
      requireObservations(input).artifacts.flightExport.sha256 =
        sha256("other-export");
    },
    exact("flight-recorder-integrity"),
  ),
  mutation(
    "probe-flight-path-alias",
    "complete-evidence",
    (input) => {
      const flight = requireObservations(input).independentProbe.flight;
      flight.exportPath = flight.databasePath;
    },
    exact("complete-evidence"),
  ),
  mutation(
    "probe-database-path-drift",
    "complete-evidence",
    (input) => {
      requireObservations(input).independentProbe.flight.databasePath =
        "/outside/probe.db";
    },
    exact("complete-evidence"),
  ),
  mutation(
    "probe-export-path-drift",
    "complete-evidence",
    (input) => {
      requireObservations(input).independentProbe.flight.exportPath =
        "/outside/probe.json";
    },
    exact("complete-evidence"),
  ),
  mutation(
    "probe-database-hash-drift",
    "complete-evidence",
    (input) => {
      requireObservations(input).independentProbe.flight.databaseSha256 =
        sha256("other-database");
    },
    exact("complete-evidence"),
  ),
  mutation(
    "probe-expected-database-hash-drift",
    "complete-evidence",
    (input) => {
      requireObservations(
        input,
      ).independentProbe.flight.expectedDatabaseSha256 = sha256(
        "other-expected-database",
      );
    },
    exact("complete-evidence"),
  ),
  mutation(
    "probe-export-hash-drift",
    "complete-evidence",
    (input) => {
      requireObservations(input).independentProbe.flight.exportSha256 =
        sha256("other-export");
    },
    exact("complete-evidence"),
  ),
  mutation(
    "probe-expected-export-hash-drift",
    "complete-evidence",
    (input) => {
      requireObservations(input).independentProbe.flight.expectedExportSha256 =
        sha256("other-expected-export");
    },
    exact("complete-evidence"),
  ),
  mutation(
    "probe-reopen-false",
    "complete-evidence",
    (input) => {
      requireObservations(
        input,
      ).independentProbe.flight.reopenedQuerySucceeded = false;
    },
    exact("complete-evidence"),
  ),
  mutation(
    "probe-production-validation-false",
    "complete-evidence",
    (input) => {
      requireObservations(
        input,
      ).independentProbe.flight.productionValidationPassed = false;
    },
    exact("complete-evidence"),
  ),
  mutation(
    "probe-content-hash-validation-false",
    "complete-evidence",
    (input) => {
      requireObservations(input).independentProbe.flight.allContentHashesValid =
        false;
    },
    exact("complete-evidence"),
  ),
  mutation(
    "probe-reopened-ids-drift",
    "complete-evidence",
    (input) => {
      requireObservations(input).independentProbe.flight.reopenedEventIds[0] =
        "different-id";
    },
    exact("complete-evidence"),
  ),
  mutation(
    "probe-exported-ids-drift",
    "complete-evidence",
    (input) => {
      requireObservations(
        input,
      ).independentProbe.flight.productionExportEventIds[0] = "different-id";
    },
    exact("complete-evidence"),
  ),
  mutation(
    "probe-persisted-ids-drift",
    "complete-evidence",
    (input) => {
      requireObservations(input).independentProbe.flight.persistedEventIds[0] =
        "different-id";
    },
    exact("complete-evidence"),
  ),
  mutation(
    "probe-reopened-hashes-drift",
    "complete-evidence",
    (input) => {
      requireObservations(
        input,
      ).independentProbe.flight.reopenedContentHashes[0] = sha256("different");
    },
    exact("complete-evidence"),
  ),
  mutation(
    "probe-exported-hashes-drift",
    "complete-evidence",
    (input) => {
      requireObservations(
        input,
      ).independentProbe.flight.productionExportContentHashes[0] =
        sha256("different");
    },
    exact("complete-evidence"),
  ),
  mutation(
    "probe-persisted-hashes-drift",
    "complete-evidence",
    (input) => {
      requireObservations(
        input,
      ).independentProbe.flight.persistedContentHashes[0] = sha256("different");
    },
    exact("complete-evidence"),
  ),
  mutation(
    "provider-counter-incremented",
    "no-provider-model-events",
    (input) => {
      requireResult(input).providerUsage.providerCalls = 1;
    },
    exact("no-provider-model-events"),
  ),
  mutation(
    "model-counter-incremented",
    "no-provider-model-events",
    (input) => {
      requireResult(input).providerUsage.modelCalls = 1;
    },
    exact("no-provider-model-events"),
  ),
  mutation(
    "missing-provider-counter-incremented",
    "no-provider-model-events",
    (input) => {
      requireMissing(input).providerCalls = 1;
    },
    {
      exactFailureIds: [
        "no-provider-model-events",
        "missing-python-controlled",
      ],
    },
  ),
  mutation(
    "missing-model-counter-incremented",
    "no-provider-model-events",
    (input) => {
      requireMissing(input).modelCalls = 1;
    },
    {
      exactFailureIds: [
        "no-provider-model-events",
        "missing-python-controlled",
      ],
    },
  ),
  mutation(
    "provider-event-recorded",
    "no-provider-model-events",
    (input) => {
      const result = requireResult(input);
      const { contentHash: _hash, ...body } = result.flightRecorder.events[0]!;
      const changed = { ...body, providerId: "unexpected-provider" };
      result.flightRecorder.events[0] = {
        ...changed,
        contentHash: computeFlightEventHash(changed),
      };
      refreshFlightExport(input);
    },
    {
      exactFailureIds: [
        "flight-recorder-integrity",
        "no-provider-model-events",
      ],
    },
  ),
  mutation(
    "model-event-recorded",
    "no-provider-model-events",
    (input) => {
      const result = requireResult(input);
      const { contentHash: _hash, ...body } = result.flightRecorder.events[0]!;
      const changed = { ...body, model: "unexpected-model" };
      result.flightRecorder.events[0] = {
        ...changed,
        contentHash: computeFlightEventHash(changed),
      };
      refreshFlightExport(input);
    },
    {
      exactFailureIds: [
        "flight-recorder-integrity",
        "no-provider-model-events",
      ],
    },
  ),
  mutation(
    "probe-model-dependency-added",
    "no-provider-model-events",
    (input) => {
      requireObservations(
        input,
      ).independentProbe.provider.manifestModelDependency = "required";
    },
    exact("no-provider-model-events"),
  ),
  mutation(
    "probe-provider-event-count",
    "no-provider-model-events",
    (input) => {
      requireObservations(input).independentProbe.provider.providerEventCount =
        1;
    },
    exact("no-provider-model-events"),
  ),
  mutation(
    "probe-model-event-count",
    "no-provider-model-events",
    (input) => {
      requireObservations(input).independentProbe.provider.modelEventCount = 1;
    },
    exact("no-provider-model-events"),
  ),
  mutation(
    "display-address-not-loopback",
    "loopback-gateway-requests",
    (input) => {
      requireResult(input).gateway.address = "0.0.0.0";
    },
    exact("loopback-gateway-requests"),
  ),
  mutation(
    "display-bind-not-loopback",
    "loopback-gateway-requests",
    (input) => {
      requireResult(input).gateway.bind = "all" as "loopback";
    },
    strictCoupling,
  ),
  mutation(
    "display-port-drift",
    "loopback-gateway-requests",
    (input) => {
      requireResult(input).gateway.port += 1;
    },
    exact("loopback-gateway-requests"),
  ),
  mutation(
    "display-base-url-not-loopback",
    "loopback-gateway-requests",
    (input) => {
      requireResult(input).gateway.baseUrl = "http://example.com";
    },
    exact("loopback-gateway-requests"),
  ),
  mutation(
    "display-request-count-drift",
    "loopback-gateway-requests",
    (input) => {
      const result = requireResult(input);
      result.gateway.requests.push({
        ...request(result, "valid-import"),
      });
    },
    exact("loopback-gateway-requests"),
  ),
  mutation(
    "display-request-url-not-loopback",
    "loopback-gateway-requests",
    (input) => {
      request(requireResult(input), "valid-import").url =
        "http://example.com/agents/import";
    },
    exact("loopback-gateway-requests"),
  ),
  mutation(
    "display-request-hostname-not-loopback",
    "loopback-gateway-requests",
    (input) => {
      request(requireResult(input), "valid-import").hostname = "example.com";
    },
    exact("loopback-gateway-requests"),
  ),
  mutation(
    "probe-request-url-not-loopback",
    "loopback-gateway-requests",
    (input) => {
      requireObservations(input).independentProbe.gateway.requestUrls[0] =
        "http://example.com/agents/import";
    },
    exact("loopback-gateway-requests"),
  ),
  mutation(
    "probe-request-count-drift",
    "loopback-gateway-requests",
    (input) => {
      requireObservations(input).independentProbe.gateway.requestUrls.pop();
    },
    exact("loopback-gateway-requests"),
  ),
  mutation(
    "success-marked-sandboxed",
    "unsandboxed-file-boundary",
    (input) => {
      requireResult(input).preservation.sandboxed = true;
    },
    exact("unsandboxed-file-boundary"),
  ),
  mutation(
    "success-boundary-drift",
    "unsandboxed-file-boundary",
    (input) => {
      requireResult(input).preservation.preservationBoundary = "process";
    },
    exact("unsandboxed-file-boundary"),
  ),
  mutation(
    "missing-marked-sandboxed",
    "unsandboxed-file-boundary",
    (input) => {
      requireMissing(input).sandboxed = true;
    },
    {
      exactFailureIds: [
        "unsandboxed-file-boundary",
        "missing-python-controlled",
      ],
    },
  ),
  mutation(
    "missing-boundary-drift",
    "unsandboxed-file-boundary",
    (input) => {
      requireMissing(input).preservationBoundary = "process";
    },
    {
      exactFailureIds: [
        "unsandboxed-file-boundary",
        "missing-python-controlled",
      ],
    },
  ),
  mutation(
    "runtime-self-deadline-exceeded",
    "bounded-runtime",
    (input) => {
      requireResult(input).runtime.elapsedMs = 30_001;
    },
    exact("bounded-runtime"),
  ),
  mutation(
    "first-execution-deadline-exceeded",
    "bounded-runtime",
    (input) => {
      requireResult(input).executions.first.elapsedMs = 30_001;
    },
    exact("bounded-runtime"),
  ),
  mutation(
    "second-execution-deadline-exceeded",
    "bounded-runtime",
    (input) => {
      requireResult(input).executions.second.elapsedMs = 30_001;
    },
    exact("bounded-runtime"),
  ),
  mutation(
    "missing-self-deadline-exceeded",
    "bounded-runtime",
    (input) => {
      requireMissing(input).elapsedMs = 30_001;
    },
    exact("bounded-runtime"),
  ),
  mutation(
    "observed-success-deadline-exceeded",
    "bounded-runtime",
    (input) => {
      requireObservations(input).successScenario.elapsedMs = 30_001;
    },
    exact("bounded-runtime"),
  ),
  mutation(
    "observed-missing-deadline-exceeded",
    "bounded-runtime",
    (input) => {
      requireObservations(input).missingPythonScenario.elapsedMs = 30_001;
    },
    exact("bounded-runtime"),
  ),
  mutation(
    "success-timeout-observed",
    "bounded-runtime",
    (input) => {
      requireObservations(input).successScenario.timedOut = true;
    },
    exact("bounded-runtime"),
  ),
  mutation(
    "missing-timeout-observed",
    "bounded-runtime",
    (input) => {
      requireObservations(input).missingPythonScenario.timedOut = true;
    },
    exact("bounded-runtime"),
  ),
  mutation(
    "success-child-pid-missing",
    "bounded-runtime",
    (input) => {
      requireObservations(input).successScenario.childPid = null;
    },
    {
      exactFailureIds: ["host-identity-preserved", "bounded-runtime"],
    },
  ),
  mutation(
    "success-spawn-unobserved",
    "bounded-runtime",
    (input) => {
      requireObservations(input).successScenario.spawnObserved = false;
    },
    {
      exactFailureIds: ["host-identity-preserved", "bounded-runtime"],
    },
  ),
  mutation(
    "success-exit-unobserved",
    "bounded-runtime",
    (input) => {
      requireObservations(input).successScenario.exitObserved = false;
    },
    exact("bounded-runtime"),
  ),
  mutation(
    "success-close-and-fallback-unobserved",
    "bounded-runtime",
    (input) => {
      const scenario = requireObservations(input).successScenario;
      scenario.closeObserved = false;
      scenario.forcedSettled = false;
    },
    exact("bounded-runtime"),
  ),
  mutation(
    "success-group-termination-unattempted",
    "bounded-runtime",
    (input) => {
      requireObservations(input).successScenario.groupTerminationAttempted =
        false;
    },
    exact("bounded-runtime"),
  ),
  mutation(
    "success-group-termination-incomplete",
    "bounded-runtime",
    (input) => {
      requireObservations(input).successScenario.groupTerminationCompleted =
        false;
    },
    exact("bounded-runtime"),
  ),
  mutation(
    "success-pipes-not-destroyed",
    "bounded-runtime",
    (input) => {
      requireObservations(input).successScenario.pipesDestroyed = false;
    },
    exact("bounded-runtime"),
  ),
  mutation(
    "missing-expected-exit-zero",
    "missing-python-controlled",
    (input) => {
      requireManifest(input).missingPython.expectedExitCode = 0;
    },
    strictCoupling,
  ),
  mutation(
    "missing-observed-exit-zero",
    "missing-python-controlled",
    (input) => {
      requireObservations(input).missingPythonExitCode = 0;
    },
    exact("missing-python-controlled"),
  ),
  mutation(
    "missing-record-count-drift",
    "missing-python-controlled",
    (input) => {
      requireObservations(input).missingPythonRecordCount = 2;
    },
    exact("missing-python-controlled"),
  ),
  mutation(
    "missing-record-noncanonical",
    "missing-python-controlled",
    (input) => {
      requireObservations(input).missingPythonRecordCanonical = false;
    },
    exact("missing-python-controlled"),
  ),
  mutation(
    "missing-reason-drift",
    "missing-python-controlled",
    (input) => {
      requireMissing(input).reason = "python-missing" as "python-unavailable";
    },
    strictCoupling,
  ),
  mutation(
    "missing-executable-drift",
    "missing-python-controlled",
    (input) => {
      requireMissing(input).pythonExecutable = "/other/missing-python";
    },
    exact("missing-python-controlled"),
  ),
  mutation(
    "missing-message-uncontrolled",
    "missing-python-controlled",
    (input) => {
      requireMissing(input).message = "Interpreter unavailable.";
    },
    exact("missing-python-controlled"),
  ),
  mutation(
    "manifest-command-display-drift",
    "exact-command-parity",
    (input) => {
      requireManifest(input).command.display = "npm run other --silent";
    },
    exact("exact-command-parity"),
  ),
  mutation(
    "observed-command-drift",
    "exact-command-parity",
    (input) => {
      requireObservations(input).executedCommand = "npm run other --silent";
    },
    exact("exact-command-parity"),
  ),
  mutation(
    "success-command-drift",
    "exact-command-parity",
    (input) => {
      requireResult(input).command = "npm run other --silent";
    },
    exact("exact-command-parity"),
  ),
  mutation(
    "missing-command-drift",
    "exact-command-parity",
    (input) => {
      requireMissing(input).command = "npm run other --silent";
    },
    exact("exact-command-parity"),
  ),
  mutation(
    "result-missing-evidence",
    "complete-evidence",
    (input) => {
      requireResult(input).evidence.missing.push("missing");
    },
    exact("complete-evidence"),
  ),
  mutation(
    "result-skipped-evidence",
    "complete-evidence",
    (input) => {
      requireResult(input).evidence.skipped.push("skipped");
    },
    exact("complete-evidence"),
  ),
  mutation(
    "missing-result-missing-evidence",
    "complete-evidence",
    (input) => {
      requireMissing(input).evidence.missing.push("missing");
    },
    exact("complete-evidence"),
  ),
  mutation(
    "missing-result-skipped-evidence",
    "complete-evidence",
    (input) => {
      requireMissing(input).evidence.skipped.push("skipped");
    },
    exact("complete-evidence"),
  ),
  mutation(
    "observation-missing-evidence",
    "complete-evidence",
    (input) => {
      requireObservations(input).missingEvidence.push("missing");
    },
    exact("complete-evidence"),
  ),
  mutation(
    "observation-skipped-evidence",
    "complete-evidence",
    (input) => {
      requireObservations(input).skippedEvidence.push("skipped");
    },
    exact("complete-evidence"),
  ),
  mutation(
    "probe-report-total-drift",
    "complete-evidence",
    (input) => {
      requireObservations(input).probeReport.totalTests -= 1;
    },
    exact("complete-evidence"),
  ),
  mutation(
    "probe-report-passed-drift",
    "complete-evidence",
    (input) => {
      requireObservations(input).probeReport.passedTests -= 1;
    },
    exact("complete-evidence"),
  ),
  mutation(
    "probe-report-failed",
    "complete-evidence",
    (input) => {
      requireObservations(input).probeReport.failedTests = 1;
    },
    exact("complete-evidence"),
  ),
  mutation(
    "probe-report-skipped",
    "complete-evidence",
    (input) => {
      requireObservations(input).probeReport.skippedTests = 1;
    },
    exact("complete-evidence"),
  ),
  mutation(
    "probe-report-name-set-drift",
    "complete-evidence",
    (input) => {
      requireObservations(input).probeReport.exactTestNames = false;
    },
    exact("complete-evidence"),
  ),
  mutation(
    "probe-report-passed-names-drift",
    "complete-evidence",
    (input) => {
      requireObservations(input).probeReport.passedTestNames.pop();
    },
    exact("complete-evidence"),
  ),
  ...(
    [
      ["fixture-collection-missing", "fixtures"],
      ["process-collection-missing", "process"],
      ["gateway-collection-missing", "gateway"],
      ["agent-collection-missing", "agent"],
      ["execution-collection-missing", "executions"],
      ["rejection-collection-missing", "rejection"],
      ["flight-collection-missing", "flight"],
      ["provider-collection-missing", "provider"],
    ] as const
  ).map(([id, key]) =>
    mutation(
      id,
      "complete-evidence",
      (input) => {
        requireObservations(input).independentProbe.collections[key] = false;
      },
      exact("complete-evidence"),
    ),
  ),
  mutation(
    "fixture-valid-pin-null",
    "fixture-source-hash-pinned",
    (input) => {
      requireManifest(input).fixture.sourceSha256 = null;
    },
    exact("fixture-source-hash-pinned"),
  ),
  mutation(
    "fixture-invalid-pin-null",
    "fixture-source-hash-pinned",
    (input) => {
      requireManifest(input).fixture.invalidSourceSha256 = null;
    },
    exact("fixture-source-hash-pinned"),
  ),
  mutation(
    "accepted-fixture-link-drift",
    "fixture-source-hash-pinned",
    (input) => {
      requireResult(input).imports.accepted.candidateSourceSha256 = sha256(
        "other-valid-fixture",
      );
    },
    exact("fixture-source-hash-pinned"),
  ),
  mutation(
    "rejected-fixture-link-drift",
    "fixture-source-hash-pinned",
    (input) => {
      requireResult(input).imports.rejected.candidateSourceSha256 = sha256(
        "other-invalid-fixture",
      );
    },
    exact("fixture-source-hash-pinned"),
  ),
  mutation(
    "agent-fixture-filename-drift",
    "fixture-source-hash-pinned",
    (input) => {
      requireResult(input).agent.filename = "other_agent.py";
    },
    {
      coupling:
        "The observed source-file suffix and fixture linkage both intentionally reject a renamed display fixture.",
    },
  ),
  mutation(
    "probe-valid-fixture-path-drift",
    "fixture-source-hash-pinned",
    (input) => {
      requireObservations(input).independentProbe.fixtures.validPath =
        "typescript/src/demo/fixtures/other.py";
    },
    exact("fixture-source-hash-pinned"),
  ),
  mutation(
    "probe-invalid-fixture-path-drift",
    "fixture-source-hash-pinned",
    (input) => {
      requireObservations(input).independentProbe.fixtures.invalidPath =
        "typescript/src/demo/fixtures/other_invalid.py";
    },
    exact("fixture-source-hash-pinned"),
  ),
  mutation(
    "probe-valid-fixture-hash-drift",
    "fixture-source-hash-pinned",
    (input) => {
      requireObservations(input).independentProbe.fixtures.validSha256 =
        sha256("other-valid");
    },
    exact("fixture-source-hash-pinned"),
  ),
  mutation(
    "probe-invalid-fixture-hash-drift",
    "fixture-source-hash-pinned",
    (input) => {
      requireObservations(input).independentProbe.fixtures.invalidSha256 =
        sha256("other-invalid");
    },
    exact("fixture-source-hash-pinned"),
  ),
  mutation(
    "probe-manifest-valid-hash-drift",
    "fixture-source-hash-pinned",
    (input) => {
      requireObservations(input).independentProbe.fixtures.manifestValidSha256 =
        sha256("other-valid");
    },
    exact("fixture-source-hash-pinned"),
  ),
  mutation(
    "probe-manifest-invalid-hash-drift",
    "fixture-source-hash-pinned",
    (input) => {
      requireObservations(
        input,
      ).independentProbe.fixtures.manifestInvalidSha256 =
        sha256("other-invalid");
    },
    exact("fixture-source-hash-pinned"),
  ),
  mutation(
    "probe-agent-source-hash-drift",
    "fixture-source-hash-pinned",
    (input) => {
      requireObservations(input).independentProbe.agent.sourceSha256Before =
        sha256("other-source");
    },
    {
      exactFailureIds: [
        "previous-generation-preserved",
        "fixture-source-hash-pinned",
      ],
    },
  ),
  mutation(
    "result-agent-source-hash-drift",
    "fixture-source-hash-pinned",
    (input) => {
      requireResult(input).agent.sourceSha256Before = sha256(
        "other-result-source",
      );
    },
    {
      exactFailureIds: [
        "previous-generation-preserved",
        "fixture-source-hash-pinned",
      ],
    },
  ),
];

describe("live organ transplant mutation gate", () => {
  it("starts from a fully green synthetic baseline", () => {
    const evaluation = evaluateLiveOrganTransplant(createBaseline());

    expect(evaluation.checks.map((entry) => entry.id)).toEqual(
      PINNED_CHECK_IDS,
    );
    expect(evaluation.checks.filter((entry) => !entry.pass)).toEqual([]);
    expect(evaluation.pass).toBe(true);
  });

  it("literally pins every check and every material predicate mutant", () => {
    expect(REQUIRED_TRANSPLANT_CHECK_IDS).toEqual(PINNED_CHECK_IDS);
    expect(MUTATIONS.map((entry) => entry.id)).toEqual(PINNED_MUTATION_IDS);
    expect(new Set(PINNED_MUTATION_IDS).size).toBe(PINNED_MUTATION_IDS.length);
    expect(MUTATIONS.length).toBeGreaterThan(150);
  });

  it.each(MUTATIONS)(
    "$id makes the intended central assertion red",
    ({ id, mutate, expectedCheckId, exactFailureIds, coupling }) => {
      const input = structuredClone(createBaseline());
      mutate(input);

      const evaluation = evaluateLiveOrganTransplant(input);
      const failed = evaluation.checks
        .filter((entry) => !entry.pass)
        .map((entry) => entry.id);

      expect(evaluation.pass).toBe(false);
      expect(failed).toContain(expectedCheckId);
      const documentedCausalCoupling = DOCUMENTED_CAUSAL_COUPLINGS[id];
      if (documentedCausalCoupling) {
        expect(documentedCausalCoupling.length).toBeGreaterThan(20);
        expect(failed.length).toBeGreaterThan(1);
      } else if (exactFailureIds) {
        expect(failed).toEqual(exactFailureIds);
      } else {
        expect(coupling).toBeTruthy();
      }
    },
  );
});
