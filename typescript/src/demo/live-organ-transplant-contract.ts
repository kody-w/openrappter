import { isDeepStrictEqual } from "node:util";

import { verifyFlightEventHash } from "../flight-recorder/integrity.js";
import {
  FLIGHT_EVENT_SCHEMA,
  type FlightEvent,
} from "../flight-recorder/types.js";

export const TRANSPLANT_RESULT_PREFIX =
  "OPENRAPPTER_TRANSPLANT_RESULT=" as const;
export const TRANSPLANT_RESULT_SCHEMA =
  "openrappter-live-organ-transplant-result/1.0" as const;
export const TRANSPLANT_MANIFEST_SCHEMA =
  "openrappter-live-organ-transplant-manifest/1.0" as const;
export const TRANSPLANT_PROBE_SCHEMA =
  "openrappter-live-organ-transplant-probe/1.0" as const;
export const TRANSPLANT_DEMO_ID = "live-organ-transplant" as const;
export const TRANSPLANT_AGENT_NAME = "ChecksumAgent" as const;
export const TRANSPLANT_RUNTIME_ENTRYPOINT =
  "typescript/dist/demo/live-organ-transplant.js" as const;
export const TRANSPLANT_GATEWAY_MODULE =
  "typescript/dist/gateway/server.js" as const;
export const TRANSPLANT_PYTHON_BRIDGE_MODULE =
  "typescript/dist/agents/PythonAgent.js" as const;
export const TRANSPLANT_INTEGRATION_TEST =
  "src/__tests__/integration/live-organ-transplant.integration.test.ts" as const;
export const TRANSPLANT_VALID_FIXTURE =
  "typescript/src/demo/fixtures/checksum_agent.py" as const;
export const TRANSPLANT_INVALID_FIXTURE =
  "typescript/src/demo/fixtures/checksum_agent_invalid.py" as const;

export const REQUIRED_TRANSPLANT_EVENT_KINDS = [
  "demo.transplant.started",
  "demo.agent.import.accepted",
  "agent.execute.completed",
  "demo.agent.candidate.rejected",
  "demo.transplant.completed",
] as const;

export const REQUIRED_TRANSPLANT_PROBE_TEST_NAMES = [
  "live organ transplant independent observer hashes both bundled fixtures before importing either one",
  "live organ transplant independent observer keeps one real GatewayServer and one real AgentRegistry object in one host process",
  "live organ transplant independent observer proves the bearer header gates the real HTTP importer",
  "live organ transplant independent observer resolves the imported object as the real PythonAgent bridge",
  "live organ transplant independent observer executes the actual PythonAgent twice with the pinned digest",
  "live organ transplant independent observer rejects the invalid replacement before committed bytes or live identity change",
  "live organ transplant independent observer reopens the database with the production ledger and exactly matches the production export",
  "live organ transplant independent observer observes loopback gateway requests and no provider or model activity",
] as const;

export const REQUIRED_TRANSPLANT_CHECK_IDS = [
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
  "no-provider-model-events",
  "loopback-gateway-requests",
  "unsandboxed-file-boundary",
  "bounded-runtime",
  "missing-python-controlled",
  "exact-command-parity",
  "complete-evidence",
  "fixture-source-hash-pinned",
] as const;

export type LiveOrganTransplantCheckId =
  (typeof REQUIRED_TRANSPLANT_CHECK_IDS)[number];

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface LiveOrganTransplantManifest {
  schema: typeof TRANSPLANT_MANIFEST_SCHEMA;
  version: number;
  demo: typeof TRANSPLANT_DEMO_ID;
  command: {
    executable: string;
    args: string[];
    display: string;
    workingDirectory: string;
  };
  input: string;
  expectedSha256: string;
  fixture: {
    filename: string;
    bundledPath: typeof TRANSPLANT_VALID_FIXTURE;
    invalidBundledPath: typeof TRANSPLANT_INVALID_FIXTURE;
    sourceSha256: string | null;
    invalidSourceSha256: string | null;
    todo: string;
  };
  dependencies: {
    node: string;
    python: string;
    model: "none";
    loopbackGateway: true;
  };
  runtimeLimits: {
    commandTimeoutMs: 30_000;
    missingPythonTimeoutMs: 30_000;
    demoMaxElapsedMs: 30_000;
  };
  missingPython: {
    environmentVariable: "OPENRAPPTER_PYTHON";
    executableBasename: string;
    expectedExitCode: number;
  };
  artifacts: {
    evidenceRoot: string;
    directoryEnvironmentVariable: "OPENRAPPTER_TRANSPLANT_EVIDENCE_DIRECTORY";
    nonceEnvironmentVariable: "OPENRAPPTER_TRANSPLANT_SCENARIO_NONCE";
  };
  claims: string[];
  forbiddenClaims: string[];
}

export interface TransplantArtifactDescriptor {
  path: string;
  sha256: string;
  sizeBytes: number;
}

export interface TransplantScenarioEvidence {
  nonce: string;
  evidenceDirectory: string;
}

export interface TransplantRuntimeEvidence {
  mode: "compiled-javascript";
  entrypoint: typeof TRANSPLANT_RUNTIME_ENTRYPOINT;
  entrypointSha256: string;
  entrypointSizeBytes: number;
  typescriptRuntimeLoaderUsed: boolean;
  nodeVersion: string;
  elapsedMs: number;
}

export interface TransplantHostEvidence {
  pidBefore: number;
  pidAfter: number;
  startIdentityBefore: string;
  startIdentityAfter: string;
}

export type TransplantGatewayRequestPurpose =
  | "valid-import"
  | "invalid-replacement";

export interface TransplantGatewayRequestEvidence {
  purpose: TransplantGatewayRequestPurpose;
  url: string;
  hostname: string;
  method: string;
  path: string;
  status: number;
  authenticated: boolean;
  authorization: string;
}

export interface TransplantGatewayEvidence {
  serverClass: "GatewayServer";
  serverModule: string;
  bind: "loopback";
  address: string;
  port: number;
  baseUrl: string;
  authMode: "token";
  productionImportRoute: boolean;
  requests: TransplantGatewayRequestEvidence[];
}

export interface TransplantAgentEvidence {
  name: typeof TRANSPLANT_AGENT_NAME;
  filename: string;
  bridgeClass: "PythonAgent";
  bridgeModule: string;
  registryClass: "AgentRegistry";
  registryInstanceIdBefore: string;
  registryInstanceIdAfter: string;
  sourceSha256Before: string;
  sourceSha256After: string;
  objectIdentityBefore: string;
  objectIdentityAfter: string;
}

export interface TransplantAcceptedImportEvidence {
  filename: string;
  candidateSourceSha256: string;
  httpStatus: number;
  responseStatus: string;
  committed: boolean;
}

export interface TransplantRejectedImportEvidence {
  filename: string;
  candidateSourceSha256: string;
  httpStatus: number;
  responseStatus: string;
  rejectedBeforeCommit: boolean;
  committed: boolean;
  errorCode: string;
}

export interface TransplantExecutionEvidence {
  input: string;
  output: {
    algorithm: string;
    digest: string;
  };
  elapsedMs: number;
}

export interface TransplantFlightRecorderEvidence {
  enabled: boolean;
  persisted: boolean;
  database: TransplantArtifactDescriptor;
  export: TransplantArtifactDescriptor;
  exportSchema: "openrappter-flight-export/1.0";
  exportedAt: string;
  eventCount: number;
  events: FlightEvent[];
}

export interface LiveOrganTransplantSuccessResult {
  schema: typeof TRANSPLANT_RESULT_SCHEMA;
  status: "success";
  demo: typeof TRANSPLANT_DEMO_ID;
  command: string;
  scenario: TransplantScenarioEvidence;
  runtime: TransplantRuntimeEvidence;
  host: TransplantHostEvidence;
  gateway: TransplantGatewayEvidence;
  agent: TransplantAgentEvidence;
  imports: {
    accepted: TransplantAcceptedImportEvidence;
    rejected: TransplantRejectedImportEvidence;
  };
  executions: {
    first: TransplantExecutionEvidence;
    second: TransplantExecutionEvidence;
  };
  preservation: {
    sandboxed: boolean;
    preservationBoundary: string;
    previousGenerationPreserved: boolean;
  };
  flightRecorder: TransplantFlightRecorderEvidence;
  providerUsage: {
    providerCalls: number;
    modelCalls: number;
  };
  evidence: {
    missing: string[];
    skipped: string[];
  };
}

export interface LiveOrganTransplantMissingPythonResult {
  schema: typeof TRANSPLANT_RESULT_SCHEMA;
  status: "python-unavailable";
  demo: typeof TRANSPLANT_DEMO_ID;
  command: string;
  scenario: TransplantScenarioEvidence;
  reason: "python-unavailable";
  pythonExecutable: string;
  message: string;
  sandboxed: boolean;
  preservationBoundary: string;
  elapsedMs: number;
  providerCalls: number;
  modelCalls: number;
  evidence: {
    missing: string[];
    skipped: string[];
  };
}

export type LiveOrganTransplantResult =
  | LiveOrganTransplantSuccessResult
  | LiveOrganTransplantMissingPythonResult;

export interface TransplantArtifactObservation {
  path: string;
  exists: boolean;
  sizeBytes: number | null;
  sha256: string | null;
  json: JsonValue | null;
}

export interface TransplantScenarioObservation {
  nonce: string;
  evidenceDirectory: string;
  startedEmpty: boolean;
  timedOut: boolean;
  elapsedMs: number;
}

export interface TransplantProbeReport {
  testFile: typeof TRANSPLANT_INTEGRATION_TEST;
  totalTests: number;
  passedTests: number;
  failedTests: number;
  skippedTests: number;
  exactTestNames: boolean;
  passedTestNames: string[];
}

export interface TransplantIndependentProbeEvidence {
  schema: typeof TRANSPLANT_PROBE_SCHEMA;
  nonce: string;
  collections: {
    fixtures: boolean;
    process: boolean;
    gateway: boolean;
    agent: boolean;
    executions: boolean;
    rejection: boolean;
    flight: boolean;
    provider: boolean;
  };
  process: {
    pidBefore: number;
    pidAfter: number;
    gatewayReferenceStable: boolean;
    registryReferenceStable: boolean;
    registryConstructorCount: number;
  };
  gateway: {
    serverClass: string;
    registryClass: string;
    authMode: string;
    authorizationScheme: string;
    unauthenticatedStatus: number;
    unauthenticatedImporterCalls: number;
    totalImporterCalls: number;
    acceptedStatus: number;
    rejectedStatus: number;
    requestUrls: string[];
  };
  fixtures: {
    validPath: string;
    invalidPath: string;
    validSha256: string;
    invalidSha256: string;
    manifestValidSha256: string | null;
    manifestInvalidSha256: string | null;
  };
  agent: {
    className: string;
    bridgeModule: string;
    sourceFile: string;
    sourceSha256Before: string;
    sourceSha256After: string;
    objectReferenceStable: boolean;
    registryReferenceStable: boolean;
  };
  executions: {
    first: TransplantExecutionEvidence;
    second: TransplantExecutionEvidence;
  };
  rejection: {
    rejectedBeforeCommit: boolean;
    committed: boolean;
    targetBytesUnchanged: boolean;
    targetStatUnchanged: boolean;
    candidateDiffersFromCommitted: boolean;
  };
  flight: {
    databasePath: string;
    exportPath: string;
    pathsDistinct: boolean;
    databaseSha256: string;
    exportSha256: string;
    expectedDatabaseSha256: string;
    expectedExportSha256: string;
    reopenedQuerySucceeded: boolean;
    productionValidationPassed: boolean;
    persistedEventIds: string[];
    reopenedEventIds: string[];
    productionExportEventIds: string[];
    persistedContentHashes: string[];
    reopenedContentHashes: string[];
    productionExportContentHashes: string[];
    allContentHashesValid: boolean;
  };
  provider: {
    manifestModelDependency: string;
    providerEventCount: number;
    modelEventCount: number;
  };
}

export interface LiveOrganTransplantObservations {
  executedCommand: string;
  successExitCode: number | null;
  missingPythonExitCode: number | null;
  successRecordCount: number;
  missingPythonRecordCount: number;
  successRecordCanonical: boolean;
  missingPythonRecordCanonical: boolean;
  controlledMissingPythonExecutable: string;
  successScenario: TransplantScenarioObservation;
  missingPythonScenario: TransplantScenarioObservation;
  frozenSuccessEvidence: {
    captured: boolean;
    fileCount: number;
    inventorySha256: string;
    unchangedAfterProbe: boolean;
    unchangedAfterMissingPython: boolean;
  };
  artifacts: {
    runtimeEntrypoint: TransplantArtifactObservation;
    flightDatabase: TransplantArtifactObservation;
    flightExport: TransplantArtifactObservation;
  };
  probeReport: TransplantProbeReport;
  independentProbe: TransplantIndependentProbeEvidence;
  missingEvidence: string[];
  skippedEvidence: string[];
}

export interface LiveOrganTransplantEvaluationInput {
  manifest: unknown;
  result: unknown;
  missingPythonResult: unknown;
  observations: unknown;
}

export interface LiveOrganTransplantCheck {
  id: LiveOrganTransplantCheckId;
  pass: boolean;
  detail: string;
}

export interface LiveOrganTransplantEvaluation {
  pass: boolean;
  checks: LiveOrganTransplantCheck[];
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const FLIGHT_EVENT_KEYS = [
  "schema",
  "id",
  "sequence",
  "kind",
  "source",
  "status",
  "traceId",
  "parentId",
  "sessionId",
  "workspaceId",
  "providerId",
  "model",
  "agentName",
  "toolName",
  "timestamp",
  "durationMs",
  "metadata",
  "payload",
  "contentHash",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  const keys = new Set(allowed);
  return Object.keys(value).every((key) => keys.has(key));
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNonNegativeNumber(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && isNonNegativeNumber(value);
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && isFiniteNumber(value) && value > 0;
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === "string")
  );
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && SHA256_PATTERN.test(value);
}

export function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (!isRecord(value)) return false;
  return Object.values(value).every(isJsonValue);
}

function isManifestCommand(
  value: unknown,
): value is LiveOrganTransplantManifest["command"] {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["executable", "args", "display", "workingDirectory"]) &&
    typeof value.executable === "string" &&
    value.executable.length > 0 &&
    isStringArray(value.args) &&
    value.args.length > 0 &&
    typeof value.display === "string" &&
    value.display.length > 0 &&
    typeof value.workingDirectory === "string" &&
    value.workingDirectory.length > 0
  );
}

export function isLiveOrganTransplantManifest(
  value: unknown,
): value is LiveOrganTransplantManifest {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      "schema",
      "version",
      "demo",
      "command",
      "input",
      "expectedSha256",
      "fixture",
      "dependencies",
      "runtimeLimits",
      "missingPython",
      "artifacts",
      "claims",
      "forbiddenClaims",
    ]) &&
    value.schema === TRANSPLANT_MANIFEST_SCHEMA &&
    value.version === 1 &&
    value.demo === TRANSPLANT_DEMO_ID &&
    isManifestCommand(value.command) &&
    typeof value.input === "string" &&
    value.input.length > 0 &&
    isSha256(value.expectedSha256) &&
    isRecord(value.fixture) &&
    hasOnlyKeys(value.fixture, [
      "filename",
      "bundledPath",
      "invalidBundledPath",
      "sourceSha256",
      "invalidSourceSha256",
      "todo",
    ]) &&
    typeof value.fixture.filename === "string" &&
    value.fixture.filename.endsWith(".py") &&
    value.fixture.bundledPath === TRANSPLANT_VALID_FIXTURE &&
    value.fixture.invalidBundledPath === TRANSPLANT_INVALID_FIXTURE &&
    (value.fixture.sourceSha256 === null ||
      isSha256(value.fixture.sourceSha256)) &&
    (value.fixture.invalidSourceSha256 === null ||
      isSha256(value.fixture.invalidSourceSha256)) &&
    typeof value.fixture.todo === "string" &&
    value.fixture.todo.length > 0 &&
    isRecord(value.dependencies) &&
    hasOnlyKeys(value.dependencies, [
      "node",
      "python",
      "model",
      "loopbackGateway",
    ]) &&
    typeof value.dependencies.node === "string" &&
    typeof value.dependencies.python === "string" &&
    value.dependencies.model === "none" &&
    value.dependencies.loopbackGateway === true &&
    isRecord(value.runtimeLimits) &&
    hasOnlyKeys(value.runtimeLimits, [
      "commandTimeoutMs",
      "missingPythonTimeoutMs",
      "demoMaxElapsedMs",
    ]) &&
    value.runtimeLimits.commandTimeoutMs === 30_000 &&
    value.runtimeLimits.missingPythonTimeoutMs === 30_000 &&
    value.runtimeLimits.demoMaxElapsedMs === 30_000 &&
    isRecord(value.missingPython) &&
    hasOnlyKeys(value.missingPython, [
      "environmentVariable",
      "executableBasename",
      "expectedExitCode",
    ]) &&
    value.missingPython.environmentVariable === "OPENRAPPTER_PYTHON" &&
    typeof value.missingPython.executableBasename === "string" &&
    /^[A-Za-z0-9._-]+$/.test(value.missingPython.executableBasename) &&
    isPositiveInteger(value.missingPython.expectedExitCode) &&
    isRecord(value.artifacts) &&
    hasOnlyKeys(value.artifacts, [
      "evidenceRoot",
      "directoryEnvironmentVariable",
      "nonceEnvironmentVariable",
    ]) &&
    typeof value.artifacts.evidenceRoot === "string" &&
    value.artifacts.evidenceRoot.length > 0 &&
    value.artifacts.directoryEnvironmentVariable ===
      "OPENRAPPTER_TRANSPLANT_EVIDENCE_DIRECTORY" &&
    value.artifacts.nonceEnvironmentVariable ===
      "OPENRAPPTER_TRANSPLANT_SCENARIO_NONCE" &&
    isStringArray(value.claims) &&
    value.claims.length > 0 &&
    isStringArray(value.forbiddenClaims) &&
    value.forbiddenClaims.includes("air-gap guarantees") &&
    value.forbiddenClaims.includes("enforced egress controls")
  );
}

function isArtifactDescriptor(
  value: unknown,
): value is TransplantArtifactDescriptor {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["path", "sha256", "sizeBytes"]) &&
    typeof value.path === "string" &&
    value.path.length > 0 &&
    isSha256(value.sha256) &&
    isPositiveInteger(value.sizeBytes)
  );
}

function isScenarioEvidence(
  value: unknown,
): value is TransplantScenarioEvidence {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["nonce", "evidenceDirectory"]) &&
    typeof value.nonce === "string" &&
    value.nonce.length > 0 &&
    typeof value.evidenceDirectory === "string" &&
    value.evidenceDirectory.length > 0
  );
}

function isRuntimeEvidence(value: unknown): value is TransplantRuntimeEvidence {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      "mode",
      "entrypoint",
      "entrypointSha256",
      "entrypointSizeBytes",
      "typescriptRuntimeLoaderUsed",
      "nodeVersion",
      "elapsedMs",
    ]) &&
    value.mode === "compiled-javascript" &&
    value.entrypoint === TRANSPLANT_RUNTIME_ENTRYPOINT &&
    isSha256(value.entrypointSha256) &&
    isPositiveInteger(value.entrypointSizeBytes) &&
    typeof value.typescriptRuntimeLoaderUsed === "boolean" &&
    typeof value.nodeVersion === "string" &&
    value.nodeVersion.length > 0 &&
    isNonNegativeNumber(value.elapsedMs)
  );
}

function isHostEvidence(value: unknown): value is TransplantHostEvidence {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      "pidBefore",
      "pidAfter",
      "startIdentityBefore",
      "startIdentityAfter",
    ]) &&
    isPositiveInteger(value.pidBefore) &&
    isPositiveInteger(value.pidAfter) &&
    typeof value.startIdentityBefore === "string" &&
    value.startIdentityBefore.length > 0 &&
    typeof value.startIdentityAfter === "string" &&
    value.startIdentityAfter.length > 0
  );
}

function isGatewayRequestEvidence(
  value: unknown,
): value is TransplantGatewayRequestEvidence {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      "purpose",
      "url",
      "hostname",
      "method",
      "path",
      "status",
      "authenticated",
      "authorization",
    ]) &&
    (value.purpose === "valid-import" ||
      value.purpose === "invalid-replacement") &&
    typeof value.url === "string" &&
    typeof value.hostname === "string" &&
    typeof value.method === "string" &&
    typeof value.path === "string" &&
    isNonNegativeInteger(value.status) &&
    typeof value.authenticated === "boolean" &&
    typeof value.authorization === "string"
  );
}

function isGatewayEvidence(value: unknown): value is TransplantGatewayEvidence {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      "serverClass",
      "serverModule",
      "bind",
      "address",
      "port",
      "baseUrl",
      "authMode",
      "productionImportRoute",
      "requests",
    ]) &&
    value.serverClass === "GatewayServer" &&
    typeof value.serverModule === "string" &&
    value.bind === "loopback" &&
    typeof value.address === "string" &&
    isPositiveInteger(value.port) &&
    typeof value.baseUrl === "string" &&
    value.authMode === "token" &&
    typeof value.productionImportRoute === "boolean" &&
    Array.isArray(value.requests) &&
    value.requests.every(isGatewayRequestEvidence)
  );
}

function isAgentEvidence(value: unknown): value is TransplantAgentEvidence {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      "name",
      "filename",
      "bridgeClass",
      "bridgeModule",
      "registryClass",
      "registryInstanceIdBefore",
      "registryInstanceIdAfter",
      "sourceSha256Before",
      "sourceSha256After",
      "objectIdentityBefore",
      "objectIdentityAfter",
    ]) &&
    value.name === TRANSPLANT_AGENT_NAME &&
    typeof value.filename === "string" &&
    value.filename.endsWith(".py") &&
    value.bridgeClass === "PythonAgent" &&
    typeof value.bridgeModule === "string" &&
    value.registryClass === "AgentRegistry" &&
    typeof value.registryInstanceIdBefore === "string" &&
    value.registryInstanceIdBefore.length > 0 &&
    typeof value.registryInstanceIdAfter === "string" &&
    value.registryInstanceIdAfter.length > 0 &&
    isSha256(value.sourceSha256Before) &&
    isSha256(value.sourceSha256After) &&
    typeof value.objectIdentityBefore === "string" &&
    value.objectIdentityBefore.length > 0 &&
    typeof value.objectIdentityAfter === "string" &&
    value.objectIdentityAfter.length > 0
  );
}

function isAcceptedImportEvidence(
  value: unknown,
): value is TransplantAcceptedImportEvidence {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      "filename",
      "candidateSourceSha256",
      "httpStatus",
      "responseStatus",
      "committed",
    ]) &&
    typeof value.filename === "string" &&
    isSha256(value.candidateSourceSha256) &&
    isNonNegativeInteger(value.httpStatus) &&
    typeof value.responseStatus === "string" &&
    typeof value.committed === "boolean"
  );
}

function isRejectedImportEvidence(
  value: unknown,
): value is TransplantRejectedImportEvidence {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      "filename",
      "candidateSourceSha256",
      "httpStatus",
      "responseStatus",
      "rejectedBeforeCommit",
      "committed",
      "errorCode",
    ]) &&
    typeof value.filename === "string" &&
    isSha256(value.candidateSourceSha256) &&
    isNonNegativeInteger(value.httpStatus) &&
    typeof value.responseStatus === "string" &&
    typeof value.rejectedBeforeCommit === "boolean" &&
    typeof value.committed === "boolean" &&
    typeof value.errorCode === "string" &&
    value.errorCode.length > 0
  );
}

function isExecutionEvidence(
  value: unknown,
): value is TransplantExecutionEvidence {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["input", "output", "elapsedMs"]) &&
    typeof value.input === "string" &&
    isRecord(value.output) &&
    hasOnlyKeys(value.output, ["algorithm", "digest"]) &&
    typeof value.output.algorithm === "string" &&
    typeof value.output.digest === "string" &&
    isNonNegativeNumber(value.elapsedMs)
  );
}

function isFlightEventDisplayEvidence(value: unknown): value is FlightEvent {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, FLIGHT_EVENT_KEYS) ||
    value.schema !== FLIGHT_EVENT_SCHEMA ||
    typeof value.id !== "string" ||
    value.id.length === 0 ||
    !isPositiveInteger(value.sequence) ||
    typeof value.kind !== "string" ||
    typeof value.source !== "string" ||
    typeof value.status !== "string" ||
    typeof value.traceId !== "string" ||
    !(value.parentId === null || typeof value.parentId === "string") ||
    typeof value.timestamp !== "string" ||
    !isRecord(value.metadata) ||
    !isJsonValue(value.metadata) ||
    !isSha256(value.contentHash)
  ) {
    return false;
  }
  try {
    return verifyFlightEventHash(value as unknown as FlightEvent);
  } catch {
    return false;
  }
}

function isFlightRecorderEvidence(
  value: unknown,
): value is TransplantFlightRecorderEvidence {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      "enabled",
      "persisted",
      "database",
      "export",
      "exportSchema",
      "exportedAt",
      "eventCount",
      "events",
    ]) &&
    typeof value.enabled === "boolean" &&
    typeof value.persisted === "boolean" &&
    isArtifactDescriptor(value.database) &&
    isArtifactDescriptor(value.export) &&
    value.exportSchema === "openrappter-flight-export/1.0" &&
    typeof value.exportedAt === "string" &&
    value.exportedAt.length > 0 &&
    isPositiveInteger(value.eventCount) &&
    Array.isArray(value.events) &&
    value.events.every(isFlightEventDisplayEvidence)
  );
}

function isSuccessResultShape(
  value: unknown,
  exactRootKeys: boolean,
): value is LiveOrganTransplantSuccessResult {
  if (!isRecord(value) || !isJsonValue(value)) return false;
  if (
    exactRootKeys &&
    !hasOnlyKeys(value, [
      "schema",
      "status",
      "demo",
      "command",
      "scenario",
      "runtime",
      "host",
      "gateway",
      "agent",
      "imports",
      "executions",
      "preservation",
      "flightRecorder",
      "providerUsage",
      "evidence",
    ])
  ) {
    return false;
  }
  return (
    value.schema === TRANSPLANT_RESULT_SCHEMA &&
    value.status === "success" &&
    value.demo === TRANSPLANT_DEMO_ID &&
    typeof value.command === "string" &&
    value.command.length > 0 &&
    isScenarioEvidence(value.scenario) &&
    isRuntimeEvidence(value.runtime) &&
    isHostEvidence(value.host) &&
    isGatewayEvidence(value.gateway) &&
    isAgentEvidence(value.agent) &&
    isRecord(value.imports) &&
    hasOnlyKeys(value.imports, ["accepted", "rejected"]) &&
    isAcceptedImportEvidence(value.imports.accepted) &&
    isRejectedImportEvidence(value.imports.rejected) &&
    isRecord(value.executions) &&
    hasOnlyKeys(value.executions, ["first", "second"]) &&
    isExecutionEvidence(value.executions.first) &&
    isExecutionEvidence(value.executions.second) &&
    isRecord(value.preservation) &&
    hasOnlyKeys(value.preservation, [
      "sandboxed",
      "preservationBoundary",
      "previousGenerationPreserved",
    ]) &&
    typeof value.preservation.sandboxed === "boolean" &&
    typeof value.preservation.preservationBoundary === "string" &&
    typeof value.preservation.previousGenerationPreserved === "boolean" &&
    isFlightRecorderEvidence(value.flightRecorder) &&
    isRecord(value.providerUsage) &&
    hasOnlyKeys(value.providerUsage, ["providerCalls", "modelCalls"]) &&
    isNonNegativeInteger(value.providerUsage.providerCalls) &&
    isNonNegativeInteger(value.providerUsage.modelCalls) &&
    isRecord(value.evidence) &&
    hasOnlyKeys(value.evidence, ["missing", "skipped"]) &&
    isStringArray(value.evidence.missing) &&
    isStringArray(value.evidence.skipped)
  );
}

export function isLiveOrganTransplantSuccessResult(
  value: unknown,
): value is LiveOrganTransplantSuccessResult {
  return isSuccessResultShape(value, true);
}

export function isLiveOrganTransplantMissingPythonResult(
  value: unknown,
): value is LiveOrganTransplantMissingPythonResult {
  return (
    isRecord(value) &&
    isJsonValue(value) &&
    hasOnlyKeys(value, [
      "schema",
      "status",
      "demo",
      "command",
      "scenario",
      "reason",
      "pythonExecutable",
      "message",
      "sandboxed",
      "preservationBoundary",
      "elapsedMs",
      "providerCalls",
      "modelCalls",
      "evidence",
    ]) &&
    value.schema === TRANSPLANT_RESULT_SCHEMA &&
    value.status === "python-unavailable" &&
    value.demo === TRANSPLANT_DEMO_ID &&
    typeof value.command === "string" &&
    value.command.length > 0 &&
    isScenarioEvidence(value.scenario) &&
    value.reason === "python-unavailable" &&
    typeof value.pythonExecutable === "string" &&
    value.pythonExecutable.length > 0 &&
    typeof value.message === "string" &&
    typeof value.sandboxed === "boolean" &&
    typeof value.preservationBoundary === "string" &&
    isNonNegativeNumber(value.elapsedMs) &&
    isNonNegativeInteger(value.providerCalls) &&
    isNonNegativeInteger(value.modelCalls) &&
    isRecord(value.evidence) &&
    hasOnlyKeys(value.evidence, ["missing", "skipped"]) &&
    isStringArray(value.evidence.missing) &&
    isStringArray(value.evidence.skipped)
  );
}

function isArtifactObservation(
  value: unknown,
): value is TransplantArtifactObservation {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["path", "exists", "sizeBytes", "sha256", "json"]) &&
    typeof value.path === "string" &&
    typeof value.exists === "boolean" &&
    (value.sizeBytes === null || isNonNegativeInteger(value.sizeBytes)) &&
    (value.sha256 === null || isSha256(value.sha256)) &&
    (value.json === null || isJsonValue(value.json))
  );
}

function isScenarioObservation(
  value: unknown,
): value is TransplantScenarioObservation {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      "nonce",
      "evidenceDirectory",
      "startedEmpty",
      "timedOut",
      "elapsedMs",
    ]) &&
    typeof value.nonce === "string" &&
    value.nonce.length > 0 &&
    typeof value.evidenceDirectory === "string" &&
    value.evidenceDirectory.length > 0 &&
    typeof value.startedEmpty === "boolean" &&
    typeof value.timedOut === "boolean" &&
    isNonNegativeNumber(value.elapsedMs)
  );
}

function isProbeReport(value: unknown): value is TransplantProbeReport {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      "testFile",
      "totalTests",
      "passedTests",
      "failedTests",
      "skippedTests",
      "exactTestNames",
      "passedTestNames",
    ]) &&
    value.testFile === TRANSPLANT_INTEGRATION_TEST &&
    isNonNegativeInteger(value.totalTests) &&
    isNonNegativeInteger(value.passedTests) &&
    isNonNegativeInteger(value.failedTests) &&
    isNonNegativeInteger(value.skippedTests) &&
    typeof value.exactTestNames === "boolean" &&
    isStringArray(value.passedTestNames)
  );
}

function isCollections(
  value: unknown,
): value is TransplantIndependentProbeEvidence["collections"] {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      "fixtures",
      "process",
      "gateway",
      "agent",
      "executions",
      "rejection",
      "flight",
      "provider",
    ]) &&
    Object.values(value).every((entry) => typeof entry === "boolean")
  );
}

export function isTransplantIndependentProbeEvidence(
  value: unknown,
): value is TransplantIndependentProbeEvidence {
  if (
    !isRecord(value) ||
    !isJsonValue(value) ||
    !hasOnlyKeys(value, [
      "schema",
      "nonce",
      "collections",
      "process",
      "gateway",
      "fixtures",
      "agent",
      "executions",
      "rejection",
      "flight",
      "provider",
    ]) ||
    value.schema !== TRANSPLANT_PROBE_SCHEMA ||
    typeof value.nonce !== "string" ||
    value.nonce.length === 0 ||
    !isCollections(value.collections)
  ) {
    return false;
  }

  const processEvidence = value.process;
  const gateway = value.gateway;
  const fixtures = value.fixtures;
  const agent = value.agent;
  const executions = value.executions;
  const rejection = value.rejection;
  const flight = value.flight;
  const provider = value.provider;
  return (
    isRecord(processEvidence) &&
    hasOnlyKeys(processEvidence, [
      "pidBefore",
      "pidAfter",
      "gatewayReferenceStable",
      "registryReferenceStable",
      "registryConstructorCount",
    ]) &&
    isPositiveInteger(processEvidence.pidBefore) &&
    isPositiveInteger(processEvidence.pidAfter) &&
    typeof processEvidence.gatewayReferenceStable === "boolean" &&
    typeof processEvidence.registryReferenceStable === "boolean" &&
    isPositiveInteger(processEvidence.registryConstructorCount) &&
    isRecord(gateway) &&
    hasOnlyKeys(gateway, [
      "serverClass",
      "registryClass",
      "authMode",
      "authorizationScheme",
      "unauthenticatedStatus",
      "unauthenticatedImporterCalls",
      "totalImporterCalls",
      "acceptedStatus",
      "rejectedStatus",
      "requestUrls",
    ]) &&
    typeof gateway.serverClass === "string" &&
    typeof gateway.registryClass === "string" &&
    typeof gateway.authMode === "string" &&
    typeof gateway.authorizationScheme === "string" &&
    isNonNegativeInteger(gateway.unauthenticatedStatus) &&
    isNonNegativeInteger(gateway.unauthenticatedImporterCalls) &&
    isNonNegativeInteger(gateway.totalImporterCalls) &&
    isNonNegativeInteger(gateway.acceptedStatus) &&
    isNonNegativeInteger(gateway.rejectedStatus) &&
    isStringArray(gateway.requestUrls) &&
    isRecord(fixtures) &&
    hasOnlyKeys(fixtures, [
      "validPath",
      "invalidPath",
      "validSha256",
      "invalidSha256",
      "manifestValidSha256",
      "manifestInvalidSha256",
    ]) &&
    typeof fixtures.validPath === "string" &&
    typeof fixtures.invalidPath === "string" &&
    isSha256(fixtures.validSha256) &&
    isSha256(fixtures.invalidSha256) &&
    (fixtures.manifestValidSha256 === null ||
      isSha256(fixtures.manifestValidSha256)) &&
    (fixtures.manifestInvalidSha256 === null ||
      isSha256(fixtures.manifestInvalidSha256)) &&
    isRecord(agent) &&
    hasOnlyKeys(agent, [
      "className",
      "bridgeModule",
      "sourceFile",
      "sourceSha256Before",
      "sourceSha256After",
      "objectReferenceStable",
      "registryReferenceStable",
    ]) &&
    typeof agent.className === "string" &&
    typeof agent.bridgeModule === "string" &&
    typeof agent.sourceFile === "string" &&
    isSha256(agent.sourceSha256Before) &&
    isSha256(agent.sourceSha256After) &&
    typeof agent.objectReferenceStable === "boolean" &&
    typeof agent.registryReferenceStable === "boolean" &&
    isRecord(executions) &&
    hasOnlyKeys(executions, ["first", "second"]) &&
    isExecutionEvidence(executions.first) &&
    isExecutionEvidence(executions.second) &&
    isRecord(rejection) &&
    hasOnlyKeys(rejection, [
      "rejectedBeforeCommit",
      "committed",
      "targetBytesUnchanged",
      "targetStatUnchanged",
      "candidateDiffersFromCommitted",
    ]) &&
    Object.values(rejection).every((entry) => typeof entry === "boolean") &&
    isRecord(flight) &&
    hasOnlyKeys(flight, [
      "databasePath",
      "exportPath",
      "pathsDistinct",
      "databaseSha256",
      "exportSha256",
      "expectedDatabaseSha256",
      "expectedExportSha256",
      "reopenedQuerySucceeded",
      "productionValidationPassed",
      "persistedEventIds",
      "reopenedEventIds",
      "productionExportEventIds",
      "persistedContentHashes",
      "reopenedContentHashes",
      "productionExportContentHashes",
      "allContentHashesValid",
    ]) &&
    typeof flight.databasePath === "string" &&
    typeof flight.exportPath === "string" &&
    typeof flight.pathsDistinct === "boolean" &&
    isSha256(flight.databaseSha256) &&
    isSha256(flight.exportSha256) &&
    isSha256(flight.expectedDatabaseSha256) &&
    isSha256(flight.expectedExportSha256) &&
    typeof flight.reopenedQuerySucceeded === "boolean" &&
    typeof flight.productionValidationPassed === "boolean" &&
    isStringArray(flight.persistedEventIds) &&
    isStringArray(flight.reopenedEventIds) &&
    isStringArray(flight.productionExportEventIds) &&
    isStringArray(flight.persistedContentHashes) &&
    isStringArray(flight.reopenedContentHashes) &&
    isStringArray(flight.productionExportContentHashes) &&
    typeof flight.allContentHashesValid === "boolean" &&
    isRecord(provider) &&
    hasOnlyKeys(provider, [
      "manifestModelDependency",
      "providerEventCount",
      "modelEventCount",
    ]) &&
    typeof provider.manifestModelDependency === "string" &&
    isNonNegativeInteger(provider.providerEventCount) &&
    isNonNegativeInteger(provider.modelEventCount)
  );
}

export function isLiveOrganTransplantObservations(
  value: unknown,
): value is LiveOrganTransplantObservations {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      "executedCommand",
      "successExitCode",
      "missingPythonExitCode",
      "successRecordCount",
      "missingPythonRecordCount",
      "successRecordCanonical",
      "missingPythonRecordCanonical",
      "controlledMissingPythonExecutable",
      "successScenario",
      "missingPythonScenario",
      "frozenSuccessEvidence",
      "artifacts",
      "probeReport",
      "independentProbe",
      "missingEvidence",
      "skippedEvidence",
    ]) &&
    typeof value.executedCommand === "string" &&
    (value.successExitCode === null ||
      isNonNegativeInteger(value.successExitCode)) &&
    (value.missingPythonExitCode === null ||
      isNonNegativeInteger(value.missingPythonExitCode)) &&
    isNonNegativeInteger(value.successRecordCount) &&
    isNonNegativeInteger(value.missingPythonRecordCount) &&
    typeof value.successRecordCanonical === "boolean" &&
    typeof value.missingPythonRecordCanonical === "boolean" &&
    typeof value.controlledMissingPythonExecutable === "string" &&
    isScenarioObservation(value.successScenario) &&
    isScenarioObservation(value.missingPythonScenario) &&
    isRecord(value.frozenSuccessEvidence) &&
    hasOnlyKeys(value.frozenSuccessEvidence, [
      "captured",
      "fileCount",
      "inventorySha256",
      "unchangedAfterProbe",
      "unchangedAfterMissingPython",
    ]) &&
    typeof value.frozenSuccessEvidence.captured === "boolean" &&
    isNonNegativeInteger(value.frozenSuccessEvidence.fileCount) &&
    isSha256(value.frozenSuccessEvidence.inventorySha256) &&
    typeof value.frozenSuccessEvidence.unchangedAfterProbe === "boolean" &&
    typeof value.frozenSuccessEvidence.unchangedAfterMissingPython ===
      "boolean" &&
    isRecord(value.artifacts) &&
    hasOnlyKeys(value.artifacts, [
      "runtimeEntrypoint",
      "flightDatabase",
      "flightExport",
    ]) &&
    isArtifactObservation(value.artifacts.runtimeEntrypoint) &&
    isArtifactObservation(value.artifacts.flightDatabase) &&
    isArtifactObservation(value.artifacts.flightExport) &&
    isProbeReport(value.probeReport) &&
    isTransplantIndependentProbeEvidence(value.independentProbe) &&
    isStringArray(value.missingEvidence) &&
    isStringArray(value.skippedEvidence)
  );
}

function canonicalize(value: JsonValue): string {
  if (value === null) return "null";
  if (typeof value === "boolean" || typeof value === "number") {
    const encoded = JSON.stringify(value);
    if (encoded === undefined)
      throw new TypeError("Value is not JSON serializable.");
    return encoded;
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  const keys = Object.keys(value).sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`)
    .join(",")}}`;
}

export function canonicalJson(value: unknown): string {
  if (!isJsonValue(value)) {
    throw new TypeError(
      "Transplant records must contain only finite JSON values.",
    );
  }
  return canonicalize(value);
}

export function formatTransplantResultRecord(
  result: LiveOrganTransplantResult,
): string {
  return `${TRANSPLANT_RESULT_PREFIX}${canonicalJson(result)}`;
}

export function transplantDeterministicCore(
  agentName: string,
  execution: TransplantExecutionEvidence,
): {
  agentName: string;
  input: string;
  algorithm: string;
  digest: string;
} {
  return {
    agentName,
    input: execution.input,
    algorithm: execution.output.algorithm,
    digest: execution.output.digest,
  };
}

function commandDisplay(manifest: LiveOrganTransplantManifest): string {
  return [manifest.command.executable, ...manifest.command.args].join(" ");
}

function findGatewayRequest(
  result: LiveOrganTransplantSuccessResult,
  purpose: TransplantGatewayRequestPurpose,
): TransplantGatewayRequestEvidence | undefined {
  return result.gateway.requests.find((request) => request.purpose === purpose);
}

function artifactMatches(
  descriptor: TransplantArtifactDescriptor,
  observation: TransplantArtifactObservation,
): boolean {
  return (
    observation.exists &&
    observation.path === descriptor.path &&
    observation.sizeBytes === descriptor.sizeBytes &&
    observation.sha256 === descriptor.sha256
  );
}

function pathIsInside(pathValue: string, directory: string): boolean {
  const normalizedDirectory = directory.replace(/[\\/]+$/, "");
  return (
    pathValue !== normalizedDirectory &&
    (pathValue.startsWith(`${normalizedDirectory}/`) ||
      pathValue.startsWith(`${normalizedDirectory}\\`)) &&
    !pathValue.split(/[\\/]/).includes("..")
  );
}

function loopbackRequest(value: {
  url: string;
  hostname?: string;
  path?: string;
  method?: string;
}): boolean {
  try {
    const parsed = new URL(value.url);
    return (
      parsed.protocol === "http:" &&
      parsed.hostname === "127.0.0.1" &&
      (value.hostname === undefined || value.hostname === "127.0.0.1") &&
      (value.path === undefined || value.path === "/agents/import") &&
      (value.method === undefined || value.method === "POST")
    );
  } catch {
    return false;
  }
}

function exactProbeReport(report: TransplantProbeReport): boolean {
  return (
    report.testFile === TRANSPLANT_INTEGRATION_TEST &&
    report.totalTests === REQUIRED_TRANSPLANT_PROBE_TEST_NAMES.length &&
    report.passedTests === REQUIRED_TRANSPLANT_PROBE_TEST_NAMES.length &&
    report.failedTests === 0 &&
    report.skippedTests === 0 &&
    report.exactTestNames &&
    isDeepStrictEqual(
      report.passedTestNames,
      REQUIRED_TRANSPLANT_PROBE_TEST_NAMES,
    )
  );
}

function completeCollections(
  collections: TransplantIndependentProbeEvidence["collections"],
): boolean {
  return Object.values(collections).every((entry) => entry === true);
}

function check(
  id: LiveOrganTransplantCheckId,
  pass: boolean,
  detail: string,
): LiveOrganTransplantCheck {
  return { id, pass, detail };
}

export function evaluateLiveOrganTransplant(
  input: LiveOrganTransplantEvaluationInput,
): LiveOrganTransplantEvaluation {
  const manifest = isLiveOrganTransplantManifest(input.manifest)
    ? input.manifest
    : undefined;
  const strictResult = isLiveOrganTransplantSuccessResult(input.result);
  const result = isSuccessResultShape(input.result, false)
    ? input.result
    : undefined;
  const missingPythonResult = isLiveOrganTransplantMissingPythonResult(
    input.missingPythonResult,
  )
    ? input.missingPythonResult
    : undefined;
  const observations = isLiveOrganTransplantObservations(input.observations)
    ? input.observations
    : undefined;
  const probe = observations?.independentProbe;
  const validImport = result
    ? findGatewayRequest(result, "valid-import")
    : undefined;
  const invalidReplacement = result
    ? findGatewayRequest(result, "invalid-replacement")
    : undefined;

  const checks: LiveOrganTransplantCheck[] = [
    check(
      "result-schema",
      Boolean(
        strictResult &&
        observations &&
        observations.successExitCode === 0 &&
        observations.successRecordCount === 1 &&
        observations.successRecordCanonical,
      ),
      strictResult
        ? "success result is strict, canonical, singular, and exited cleanly"
        : "success result does not satisfy the strict schema",
    ),
    check(
      "compiled-runtime",
      Boolean(
        result &&
        observations &&
        result.runtime.mode === "compiled-javascript" &&
        result.runtime.entrypoint === TRANSPLANT_RUNTIME_ENTRYPOINT &&
        result.runtime.typescriptRuntimeLoaderUsed === false &&
        artifactMatches(
          {
            path: result.runtime.entrypoint,
            sha256: result.runtime.entrypointSha256,
            sizeBytes: result.runtime.entrypointSizeBytes,
          },
          observations.artifacts.runtimeEntrypoint,
        ) &&
        (observations.artifacts.runtimeEntrypoint.sizeBytes ?? 0) > 0,
      ),
      "compiled JavaScript entrypoint must exist and match gate-hashed bytes",
    ),
    check(
      "isolated-scenario-evidence",
      Boolean(
        result &&
        missingPythonResult &&
        observations &&
        result.scenario.nonce === observations.successScenario.nonce &&
        result.scenario.evidenceDirectory ===
          observations.successScenario.evidenceDirectory &&
        missingPythonResult.scenario.nonce ===
          observations.missingPythonScenario.nonce &&
        missingPythonResult.scenario.evidenceDirectory ===
          observations.missingPythonScenario.evidenceDirectory &&
        observations.successScenario.startedEmpty &&
        observations.missingPythonScenario.startedEmpty &&
        observations.successScenario.nonce !==
          observations.missingPythonScenario.nonce &&
        observations.successScenario.evidenceDirectory !==
          observations.missingPythonScenario.evidenceDirectory &&
        observations.frozenSuccessEvidence.captured &&
        observations.frozenSuccessEvidence.fileCount > 0 &&
        observations.frozenSuccessEvidence.unchangedAfterProbe &&
        observations.frozenSuccessEvidence.unchangedAfterMissingPython &&
        pathIsInside(
          result.flightRecorder.database.path,
          observations.successScenario.evidenceDirectory,
        ) &&
        pathIsInside(
          result.flightRecorder.export.path,
          observations.successScenario.evidenceDirectory,
        ) &&
        result.flightRecorder.database.path !==
          result.flightRecorder.export.path,
      ),
      "unique empty scenario directories and nonces must remain isolated and frozen",
    ),
    check(
      "host-identity-preserved",
      Boolean(
        result &&
        probe &&
        result.host.pidBefore === result.host.pidAfter &&
        result.host.startIdentityBefore === result.host.startIdentityAfter &&
        probe.process.pidBefore === probe.process.pidAfter &&
        probe.process.gatewayReferenceStable &&
        probe.process.registryReferenceStable &&
        probe.process.registryConstructorCount === 1,
      ),
      "display PID/start identity and independently held server/registry references must stay stable",
    ),
    check(
      "authenticated-http-import",
      Boolean(
        result &&
        probe &&
        validImport &&
        result.gateway.serverClass === "GatewayServer" &&
        result.gateway.serverModule === TRANSPLANT_GATEWAY_MODULE &&
        result.gateway.authMode === "token" &&
        result.gateway.productionImportRoute &&
        validImport.authenticated &&
        validImport.authorization === "bearer-token" &&
        validImport.method === "POST" &&
        validImport.path === "/agents/import" &&
        validImport.status === 200 &&
        result.imports.accepted.httpStatus === 200 &&
        result.imports.accepted.responseStatus === "ok" &&
        result.imports.accepted.committed &&
        probe.gateway.serverClass === "GatewayServer" &&
        probe.gateway.registryClass === "AgentRegistry" &&
        probe.gateway.authMode === "token" &&
        probe.gateway.authorizationScheme === "Bearer" &&
        probe.gateway.unauthenticatedStatus === 401 &&
        probe.gateway.unauthenticatedImporterCalls === 0 &&
        probe.gateway.totalImporterCalls === 2 &&
        probe.gateway.acceptedStatus === 200,
      ),
      "pinned observer must send the bearer-authenticated POST itself after a 401 control",
    ),
    check(
      "python-agent-bridge",
      Boolean(
        result &&
        probe &&
        result.agent.name === TRANSPLANT_AGENT_NAME &&
        result.agent.bridgeClass === "PythonAgent" &&
        result.agent.bridgeModule === TRANSPLANT_PYTHON_BRIDGE_MODULE &&
        result.agent.registryClass === "AgentRegistry" &&
        probe.agent.className === "PythonAgent" &&
        probe.agent.bridgeModule === TRANSPLANT_PYTHON_BRIDGE_MODULE &&
        probe.agent.sourceFile.endsWith(result.agent.filename),
      ),
      "observer must hold the actual PythonAgent resolved from the one real registry",
    ),
    check(
      "known-vector-first-execution",
      Boolean(
        result &&
        manifest &&
        probe &&
        result.executions.first.input === manifest.input &&
        result.executions.first.output.algorithm === "sha256" &&
        result.executions.first.output.digest === manifest.expectedSha256 &&
        probe.executions.first.input === manifest.input &&
        probe.executions.first.output.algorithm === "sha256" &&
        probe.executions.first.output.digest === manifest.expectedSha256,
      ),
      "demo and actual independently executed PythonAgent must match the known vector",
    ),
    check(
      "bad-candidate-rejected-before-commit",
      Boolean(
        result &&
        probe &&
        invalidReplacement &&
        invalidReplacement.status === 400 &&
        invalidReplacement.authenticated &&
        invalidReplacement.authorization === "bearer-token" &&
        invalidReplacement.method === "POST" &&
        invalidReplacement.path === "/agents/import" &&
        result.imports.rejected.httpStatus === 400 &&
        result.imports.rejected.responseStatus === "error" &&
        result.imports.rejected.rejectedBeforeCommit &&
        result.imports.rejected.committed === false &&
        result.imports.rejected.filename === result.imports.accepted.filename &&
        probe.gateway.rejectedStatus === 400 &&
        probe.rejection.rejectedBeforeCommit &&
        probe.rejection.committed === false &&
        probe.rejection.targetBytesUnchanged &&
        probe.rejection.targetStatUnchanged,
      ),
      "invalid fixture must be rejected before any committed file metadata or bytes change",
    ),
    check(
      "previous-generation-preserved",
      Boolean(
        result &&
        probe &&
        result.preservation.previousGenerationPreserved &&
        result.agent.sourceSha256Before === result.agent.sourceSha256After &&
        result.agent.objectIdentityBefore ===
          result.agent.objectIdentityAfter &&
        result.agent.registryInstanceIdBefore ===
          result.agent.registryInstanceIdAfter &&
        result.imports.rejected.candidateSourceSha256 !==
          result.agent.sourceSha256Before &&
        probe.agent.objectReferenceStable &&
        probe.agent.registryReferenceStable &&
        probe.agent.sourceSha256Before === probe.agent.sourceSha256After &&
        probe.rejection.candidateDiffersFromCommitted,
      ),
      "actual source bytes plus live object and registry references must remain active",
    ),
    check(
      "deterministic-second-execution",
      Boolean(
        result &&
        probe &&
        isDeepStrictEqual(
          transplantDeterministicCore(
            result.agent.name,
            result.executions.first,
          ),
          transplantDeterministicCore(
            result.agent.name,
            result.executions.second,
          ),
        ) &&
        isDeepStrictEqual(
          transplantDeterministicCore(
            TRANSPLANT_AGENT_NAME,
            probe.executions.first,
          ),
          transplantDeterministicCore(
            TRANSPLANT_AGENT_NAME,
            probe.executions.second,
          ),
        ),
      ),
      "actual PythonAgent and display evidence must produce the same deterministic core twice",
    ),
    check(
      "flight-recorder-integrity",
      Boolean(
        result &&
        observations &&
        probe &&
        result.flightRecorder.enabled &&
        result.flightRecorder.persisted &&
        result.flightRecorder.database.path !==
          result.flightRecorder.export.path &&
        result.flightRecorder.eventCount ===
          result.flightRecorder.events.length &&
        result.flightRecorder.events.length >= 6 &&
        result.flightRecorder.events.every(isFlightEventDisplayEvidence) &&
        REQUIRED_TRANSPLANT_EVENT_KINDS.every((kind) =>
          result.flightRecorder.events.some((event) => event.kind === kind),
        ) &&
        artifactMatches(
          result.flightRecorder.database,
          observations.artifacts.flightDatabase,
        ) &&
        artifactMatches(
          result.flightRecorder.export,
          observations.artifacts.flightExport,
        ) &&
        probe.flight.pathsDistinct &&
        probe.flight.databasePath !== probe.flight.exportPath &&
        probe.flight.databasePath === result.flightRecorder.database.path &&
        probe.flight.exportPath === result.flightRecorder.export.path &&
        probe.flight.databaseSha256 === probe.flight.expectedDatabaseSha256 &&
        probe.flight.exportSha256 === probe.flight.expectedExportSha256 &&
        probe.flight.reopenedQuerySucceeded &&
        probe.flight.productionValidationPassed &&
        probe.flight.allContentHashesValid &&
        isDeepStrictEqual(
          result.flightRecorder.events.map((event) => event.id),
          probe.flight.persistedEventIds,
        ) &&
        isDeepStrictEqual(
          result.flightRecorder.events.map((event) => event.contentHash),
          probe.flight.persistedContentHashes,
        ) &&
        isDeepStrictEqual(
          probe.flight.persistedEventIds,
          probe.flight.reopenedEventIds,
        ) &&
        isDeepStrictEqual(
          probe.flight.persistedEventIds,
          probe.flight.productionExportEventIds,
        ) &&
        isDeepStrictEqual(
          probe.flight.persistedContentHashes,
          probe.flight.reopenedContentHashes,
        ) &&
        isDeepStrictEqual(
          probe.flight.persistedContentHashes,
          probe.flight.productionExportContentHashes,
        ),
      ),
      "production ledger reopen, validator import, IDs, hashes, and distinct export must agree exactly",
    ),
    check(
      "no-provider-model-events",
      Boolean(
        result &&
        missingPythonResult &&
        manifest &&
        probe &&
        manifest.dependencies.model === "none" &&
        result.providerUsage.providerCalls === 0 &&
        result.providerUsage.modelCalls === 0 &&
        missingPythonResult.providerCalls === 0 &&
        missingPythonResult.modelCalls === 0 &&
        result.flightRecorder.events.every(
          (event) =>
            event.providerId === undefined &&
            event.model === undefined &&
            !event.kind.startsWith("provider.") &&
            !event.kind.startsWith("model."),
        ) &&
        probe.provider.manifestModelDependency === "none" &&
        probe.provider.providerEventCount === 0 &&
        probe.provider.modelEventCount === 0,
      ),
      "digest-pinned donor must need no provider/model and persisted events must show none",
    ),
    check(
      "loopback-gateway-requests",
      Boolean(
        result &&
        probe &&
        result.gateway.bind === "loopback" &&
        result.gateway.address === "127.0.0.1" &&
        result.gateway.requests.length === 2 &&
        result.gateway.baseUrl === `http://127.0.0.1:${result.gateway.port}` &&
        result.gateway.requests.every(loopbackRequest) &&
        probe.gateway.requestUrls.length === 3 &&
        probe.gateway.requestUrls.every((url) => loopbackRequest({ url })),
      ),
      "only observed gateway requests are claimed loopback; OS egress is not claimed",
    ),
    check(
      "unsandboxed-file-boundary",
      Boolean(
        result &&
        missingPythonResult &&
        result.preservation.sandboxed === false &&
        result.preservation.preservationBoundary === "file-only" &&
        missingPythonResult.sandboxed === false &&
        missingPythonResult.preservationBoundary === "file-only",
      ),
      "both scenarios must state sandboxed:false and preservationBoundary:file-only",
    ),
    check(
      "bounded-runtime",
      Boolean(
        result &&
        missingPythonResult &&
        manifest &&
        observations &&
        manifest.runtimeLimits.demoMaxElapsedMs === 30_000 &&
        result.runtime.elapsedMs <= 30_000 &&
        result.executions.first.elapsedMs <= 30_000 &&
        result.executions.second.elapsedMs <= 30_000 &&
        missingPythonResult.elapsedMs <= 30_000 &&
        observations.successScenario.elapsedMs <= 30_000 &&
        observations.missingPythonScenario.elapsedMs <= 30_000 &&
        !observations.successScenario.timedOut &&
        !observations.missingPythonScenario.timedOut,
      ),
      "independent wall clock and all display timings must stay within 30 seconds",
    ),
    check(
      "missing-python-controlled",
      Boolean(
        missingPythonResult &&
        manifest &&
        observations &&
        manifest.missingPython.expectedExitCode !== 0 &&
        observations.missingPythonExitCode ===
          manifest.missingPython.expectedExitCode &&
        observations.missingPythonRecordCount === 1 &&
        observations.missingPythonRecordCanonical &&
        missingPythonResult.reason === "python-unavailable" &&
        missingPythonResult.pythonExecutable ===
          observations.controlledMissingPythonExecutable &&
        /python/i.test(missingPythonResult.message) &&
        missingPythonResult.sandboxed === false &&
        missingPythonResult.preservationBoundary === "file-only" &&
        missingPythonResult.providerCalls === 0 &&
        missingPythonResult.modelCalls === 0,
      ),
      "absent interpreter must be rechecked and produce one canonical nonzero controlled exit",
    ),
    check(
      "exact-command-parity",
      Boolean(
        result &&
        missingPythonResult &&
        manifest &&
        observations &&
        commandDisplay(manifest) === manifest.command.display &&
        observations.executedCommand === manifest.command.display &&
        result.command === manifest.command.display &&
        missingPythonResult.command === manifest.command.display,
      ),
      "manifest, gate observation, success, and missing-Python command must match exactly",
    ),
    check(
      "complete-evidence",
      Boolean(
        result &&
        missingPythonResult &&
        observations &&
        probe &&
        result.evidence.missing.length === 0 &&
        result.evidence.skipped.length === 0 &&
        missingPythonResult.evidence.missing.length === 0 &&
        missingPythonResult.evidence.skipped.length === 0 &&
        observations.missingEvidence.length === 0 &&
        observations.skippedEvidence.length === 0 &&
        exactProbeReport(observations.probeReport) &&
        completeCollections(probe.collections) &&
        probe.nonce === observations.successScenario.nonce,
      ),
      "all literal probe tests and every evidence collection must pass with zero skips",
    ),
    check(
      "fixture-source-hash-pinned",
      Boolean(
        result &&
        manifest &&
        probe &&
        isSha256(manifest.fixture.sourceSha256) &&
        isSha256(manifest.fixture.invalidSourceSha256) &&
        manifest.fixture.sourceSha256 === result.agent.sourceSha256Before &&
        manifest.fixture.sourceSha256 ===
          result.imports.accepted.candidateSourceSha256 &&
        manifest.fixture.invalidSourceSha256 ===
          result.imports.rejected.candidateSourceSha256 &&
        manifest.fixture.filename === result.agent.filename &&
        probe.fixtures.validPath === manifest.fixture.bundledPath &&
        probe.fixtures.invalidPath === manifest.fixture.invalidBundledPath &&
        probe.fixtures.validSha256 === manifest.fixture.sourceSha256 &&
        probe.fixtures.invalidSha256 === manifest.fixture.invalidSourceSha256 &&
        probe.fixtures.manifestValidSha256 === manifest.fixture.sourceSha256 &&
        probe.fixtures.manifestInvalidSha256 ===
          manifest.fixture.invalidSourceSha256 &&
        probe.agent.sourceSha256Before === manifest.fixture.sourceSha256,
      ),
      "observer must hash both literal bundled fixtures and link them to accepted/rejected bytes",
    ),
  ];

  return {
    pass: checks.every((entry) => entry.pass),
    checks,
  };
}
