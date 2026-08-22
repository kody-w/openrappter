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
export const TRANSPLANT_DEMO_ID = "live-organ-transplant" as const;
export const TRANSPLANT_AGENT_NAME = "ChecksumAgent" as const;
export const TRANSPLANT_RUNTIME_ENTRYPOINT =
  "typescript/dist/demo/live-organ-transplant.js" as const;
export const TRANSPLANT_GATEWAY_MODULE =
  "typescript/dist/gateway/server.js" as const;
export const TRANSPLANT_PYTHON_BRIDGE_MODULE =
  "typescript/dist/agents/PythonAgent.js" as const;

export const REQUIRED_TRANSPLANT_EVENT_KINDS = [
  "demo.transplant.started",
  "demo.agent.import.accepted",
  "agent.execute.completed",
  "demo.agent.candidate.rejected",
  "demo.transplant.completed",
] as const;

export const REQUIRED_TRANSPLANT_CHECK_IDS = [
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
    sourceSha256: string | null;
    todo: string;
  };
  dependencies: {
    node: string;
    python: string;
    model: "none";
    externalNetwork: "forbidden";
    loopbackGateway: true;
  };
  runtimeLimits: {
    commandTimeoutMs: number;
    missingPythonTimeoutMs: number;
    demoMaxElapsedMs: number;
  };
  missingPython: {
    environmentVariable: "OPENRAPPTER_PYTHON";
    executable: string;
    expectedExitCode: number;
  };
  artifacts: {
    evidenceRoot: string;
  };
  claims: string[];
  forbiddenClaims: string[];
}

export interface TransplantArtifactDescriptor {
  path: string;
  sha256: string;
  sizeBytes: number;
}

export interface TransplantRuntimeEvidence {
  mode: "compiled-javascript";
  entrypoint: typeof TRANSPLANT_RUNTIME_ENTRYPOINT;
  entrypointSha256: string;
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
  externalRequestCount: number;
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
  reopened: boolean;
  database: TransplantArtifactDescriptor;
  export: TransplantArtifactDescriptor;
  exportSchema: "openrappter-flight-export/1.0";
  exportedAt: string;
  eventCount: number;
  events: FlightEvent[];
  reloadedEventIds: string[];
}

export interface LiveOrganTransplantSuccessResult {
  schema: typeof TRANSPLANT_RESULT_SCHEMA;
  status: "success";
  demo: typeof TRANSPLANT_DEMO_ID;
  command: string;
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
  reason: "python-unavailable";
  pythonExecutable: string;
  message: string;
  sandboxed: boolean;
  preservationBoundary: string;
  elapsedMs: number;
  providerCalls: number;
  modelCalls: number;
  externalNetworkRequests: number;
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

export interface LiveOrganTransplantObservations {
  executedCommand: string;
  successExitCode: number | null;
  missingPythonExitCode: number | null;
  successRecordCount: number;
  missingPythonRecordCount: number;
  successRecordCanonical: boolean;
  missingPythonRecordCanonical: boolean;
  successElapsedMs: number;
  missingPythonElapsedMs: number;
  artifacts: {
    runtimeEntrypoint: TransplantArtifactObservation;
    flightDatabase: TransplantArtifactObservation;
    flightExport: TransplantArtifactObservation;
  };
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

function isIsoTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Number.isFinite(Date.parse(value))
  );
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
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
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
    ]) ||
    value.schema !== TRANSPLANT_MANIFEST_SCHEMA ||
    value.version !== 1 ||
    value.demo !== TRANSPLANT_DEMO_ID ||
    !isManifestCommand(value.command) ||
    typeof value.input !== "string" ||
    value.input.length === 0 ||
    !isSha256(value.expectedSha256) ||
    !isRecord(value.fixture) ||
    !hasOnlyKeys(value.fixture, ["filename", "sourceSha256", "todo"]) ||
    typeof value.fixture.filename !== "string" ||
    !value.fixture.filename.endsWith(".py") ||
    !(
      value.fixture.sourceSha256 === null ||
      isSha256(value.fixture.sourceSha256)
    ) ||
    typeof value.fixture.todo !== "string" ||
    value.fixture.todo.length === 0 ||
    !isRecord(value.dependencies) ||
    !hasOnlyKeys(value.dependencies, [
      "node",
      "python",
      "model",
      "externalNetwork",
      "loopbackGateway",
    ]) ||
    typeof value.dependencies.node !== "string" ||
    typeof value.dependencies.python !== "string" ||
    value.dependencies.model !== "none" ||
    value.dependencies.externalNetwork !== "forbidden" ||
    value.dependencies.loopbackGateway !== true ||
    !isRecord(value.runtimeLimits) ||
    !hasOnlyKeys(value.runtimeLimits, [
      "commandTimeoutMs",
      "missingPythonTimeoutMs",
      "demoMaxElapsedMs",
    ]) ||
    !isPositiveInteger(value.runtimeLimits.commandTimeoutMs) ||
    !isPositiveInteger(value.runtimeLimits.missingPythonTimeoutMs) ||
    !isPositiveInteger(value.runtimeLimits.demoMaxElapsedMs) ||
    value.runtimeLimits.demoMaxElapsedMs >
      value.runtimeLimits.commandTimeoutMs ||
    !isRecord(value.missingPython) ||
    !hasOnlyKeys(value.missingPython, [
      "environmentVariable",
      "executable",
      "expectedExitCode",
    ]) ||
    value.missingPython.environmentVariable !== "OPENRAPPTER_PYTHON" ||
    typeof value.missingPython.executable !== "string" ||
    value.missingPython.executable.length === 0 ||
    !isNonNegativeInteger(value.missingPython.expectedExitCode) ||
    !isRecord(value.artifacts) ||
    !hasOnlyKeys(value.artifacts, ["evidenceRoot"]) ||
    typeof value.artifacts.evidenceRoot !== "string" ||
    value.artifacts.evidenceRoot.length === 0 ||
    !isStringArray(value.claims) ||
    value.claims.length === 0 ||
    !isStringArray(value.forbiddenClaims) ||
    value.forbiddenClaims.length === 0
  ) {
    return false;
  }
  return true;
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

function isRuntimeEvidence(value: unknown): value is TransplantRuntimeEvidence {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      "mode",
      "entrypoint",
      "entrypointSha256",
      "typescriptRuntimeLoaderUsed",
      "nodeVersion",
      "elapsedMs",
    ]) &&
    value.mode === "compiled-javascript" &&
    value.entrypoint === TRANSPLANT_RUNTIME_ENTRYPOINT &&
    isSha256(value.entrypointSha256) &&
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
      "externalRequestCount",
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
    isNonNegativeInteger(value.externalRequestCount) &&
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

function isFlightEvent(value: unknown): value is FlightEvent {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, FLIGHT_EVENT_KEYS) &&
    value.schema === FLIGHT_EVENT_SCHEMA &&
    typeof value.id === "string" &&
    value.id.length > 0 &&
    isPositiveInteger(value.sequence) &&
    typeof value.kind === "string" &&
    value.kind.length > 0 &&
    typeof value.source === "string" &&
    value.source.length > 0 &&
    (value.status === "started" ||
      value.status === "success" ||
      value.status === "error" ||
      value.status === "decision" ||
      value.status === "info") &&
    typeof value.traceId === "string" &&
    value.traceId.length > 0 &&
    (value.parentId === null || typeof value.parentId === "string") &&
    (value.sessionId === undefined || typeof value.sessionId === "string") &&
    (value.workspaceId === undefined ||
      typeof value.workspaceId === "string") &&
    (value.providerId === undefined || typeof value.providerId === "string") &&
    (value.model === undefined || typeof value.model === "string") &&
    (value.agentName === undefined || typeof value.agentName === "string") &&
    (value.toolName === undefined || typeof value.toolName === "string") &&
    isIsoTimestamp(value.timestamp) &&
    (value.durationMs === undefined || isNonNegativeNumber(value.durationMs)) &&
    isRecord(value.metadata) &&
    isJsonValue(value.metadata) &&
    (value.payload === undefined || isJsonValue(value.payload)) &&
    isSha256(value.contentHash)
  );
}

function isFlightRecorderEvidence(
  value: unknown,
): value is TransplantFlightRecorderEvidence {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      "enabled",
      "persisted",
      "reopened",
      "database",
      "export",
      "exportSchema",
      "exportedAt",
      "eventCount",
      "events",
      "reloadedEventIds",
    ]) &&
    typeof value.enabled === "boolean" &&
    typeof value.persisted === "boolean" &&
    typeof value.reopened === "boolean" &&
    isArtifactDescriptor(value.database) &&
    isArtifactDescriptor(value.export) &&
    value.exportSchema === "openrappter-flight-export/1.0" &&
    isIsoTimestamp(value.exportedAt) &&
    isPositiveInteger(value.eventCount) &&
    Array.isArray(value.events) &&
    value.events.every(isFlightEvent) &&
    isStringArray(value.reloadedEventIds)
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
      "reason",
      "pythonExecutable",
      "message",
      "sandboxed",
      "preservationBoundary",
      "elapsedMs",
      "providerCalls",
      "modelCalls",
      "externalNetworkRequests",
      "evidence",
    ]) &&
    value.schema === TRANSPLANT_RESULT_SCHEMA &&
    value.status === "python-unavailable" &&
    value.demo === TRANSPLANT_DEMO_ID &&
    typeof value.command === "string" &&
    value.command.length > 0 &&
    value.reason === "python-unavailable" &&
    typeof value.pythonExecutable === "string" &&
    value.pythonExecutable.length > 0 &&
    typeof value.message === "string" &&
    typeof value.sandboxed === "boolean" &&
    typeof value.preservationBoundary === "string" &&
    isNonNegativeNumber(value.elapsedMs) &&
    isNonNegativeInteger(value.providerCalls) &&
    isNonNegativeInteger(value.modelCalls) &&
    isNonNegativeInteger(value.externalNetworkRequests) &&
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
      "successElapsedMs",
      "missingPythonElapsedMs",
      "artifacts",
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
    isNonNegativeNumber(value.successElapsedMs) &&
    isNonNegativeNumber(value.missingPythonElapsedMs) &&
    isRecord(value.artifacts) &&
    hasOnlyKeys(value.artifacts, [
      "runtimeEntrypoint",
      "flightDatabase",
      "flightExport",
    ]) &&
    isArtifactObservation(value.artifacts.runtimeEntrypoint) &&
    isArtifactObservation(value.artifacts.flightDatabase) &&
    isArtifactObservation(value.artifacts.flightExport) &&
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

function isFlightExport(value: unknown): value is {
  schema: "openrappter-flight-export/1.0";
  exportedAt: string;
  events: FlightEvent[];
} {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["schema", "exportedAt", "events"]) &&
    value.schema === "openrappter-flight-export/1.0" &&
    isIsoTimestamp(value.exportedAt) &&
    Array.isArray(value.events) &&
    value.events.every(isFlightEvent)
  );
}

function pathIsInsideEvidenceRoot(
  path: string,
  manifest: LiveOrganTransplantManifest,
): boolean {
  const root = manifest.artifacts.evidenceRoot.replace(/\/+$/, "");
  return path.startsWith(`${root}/`) && !path.includes("..");
}

function flightRecorderIsValid(
  result: LiveOrganTransplantSuccessResult,
  manifest: LiveOrganTransplantManifest,
  observations: LiveOrganTransplantObservations,
): boolean {
  const flight = result.flightRecorder;
  const events = flight.events;
  const ids = events.map((event) => event.id);
  const uniqueIds = new Set(ids);
  const traces = new Set(events.map((event) => event.traceId));
  const kinds = new Set(events.map((event) => event.kind));
  const executionCount = events.filter(
    (event) => event.kind === "agent.execute.completed",
  ).length;
  const exported = observations.artifacts.flightExport.json;

  return (
    flight.enabled &&
    flight.persisted &&
    flight.reopened &&
    flight.eventCount === events.length &&
    events.length >= 6 &&
    uniqueIds.size === events.length &&
    traces.size === 1 &&
    events.every((event, index) => event.sequence === index + 1) &&
    events.every(verifyFlightEventHash) &&
    REQUIRED_TRANSPLANT_EVENT_KINDS.every((kind) => kinds.has(kind)) &&
    executionCount >= 2 &&
    isDeepStrictEqual(flight.reloadedEventIds, ids) &&
    pathIsInsideEvidenceRoot(flight.database.path, manifest) &&
    pathIsInsideEvidenceRoot(flight.export.path, manifest) &&
    artifactMatches(flight.database, observations.artifacts.flightDatabase) &&
    artifactMatches(flight.export, observations.artifacts.flightExport) &&
    isFlightExport(exported) &&
    exported.schema === flight.exportSchema &&
    exported.exportedAt === flight.exportedAt &&
    isDeepStrictEqual(exported.events, events)
  );
}

function noProviderOrModelEvents(
  result: LiveOrganTransplantSuccessResult,
): boolean {
  return (
    result.providerUsage.providerCalls === 0 &&
    result.providerUsage.modelCalls === 0 &&
    result.flightRecorder.events.every(
      (event) =>
        event.providerId === undefined &&
        event.model === undefined &&
        !event.kind.startsWith("provider.") &&
        !event.kind.startsWith("model."),
    )
  );
}

function loopbackTrafficOnly(
  result: LiveOrganTransplantSuccessResult,
): boolean {
  const gateway = result.gateway;
  if (
    gateway.bind !== "loopback" ||
    gateway.address !== "127.0.0.1" ||
    gateway.externalRequestCount !== 0 ||
    gateway.requests.length !== 2 ||
    gateway.baseUrl !== `http://127.0.0.1:${gateway.port}`
  ) {
    return false;
  }
  return gateway.requests.every((request) => {
    try {
      const parsed = new URL(request.url);
      return (
        parsed.protocol === "http:" &&
        parsed.hostname === "127.0.0.1" &&
        parsed.port === String(gateway.port) &&
        parsed.pathname === "/agents/import" &&
        request.hostname === "127.0.0.1" &&
        request.path === "/agents/import" &&
        request.method === "POST"
      );
    } catch {
      return false;
    }
  });
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
            sizeBytes: observations.artifacts.runtimeEntrypoint.sizeBytes ?? 0,
          },
          observations.artifacts.runtimeEntrypoint,
        ) &&
        (observations.artifacts.runtimeEntrypoint.sizeBytes ?? 0) > 0,
      ),
      "compiled JavaScript entrypoint must exist and match its measured hash",
    ),
    check(
      "host-identity-preserved",
      Boolean(
        result &&
        result.host.pidBefore === result.host.pidAfter &&
        result.host.startIdentityBefore === result.host.startIdentityAfter,
      ),
      "PID and process-start identity must remain unchanged",
    ),
    check(
      "authenticated-http-import",
      Boolean(
        result &&
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
        result.imports.accepted.committed,
      ),
      "production GatewayServer import route must accept an authenticated POST",
    ),
    check(
      "python-agent-bridge",
      Boolean(
        result &&
        result.agent.name === TRANSPLANT_AGENT_NAME &&
        result.agent.bridgeClass === "PythonAgent" &&
        result.agent.bridgeModule === TRANSPLANT_PYTHON_BRIDGE_MODULE &&
        result.agent.registryClass === "AgentRegistry",
      ),
      "ChecksumAgent must be Python-backed and resolved by AgentRegistry",
    ),
    check(
      "known-vector-first-execution",
      Boolean(
        result &&
        manifest &&
        result.executions.first.input === manifest.input &&
        result.executions.first.output.algorithm === "sha256" &&
        result.executions.first.output.digest === manifest.expectedSha256,
      ),
      "first execution must match the manifest SHA-256 known vector",
    ),
    check(
      "bad-candidate-rejected-before-commit",
      Boolean(
        result &&
        invalidReplacement &&
        invalidReplacement.status === 400 &&
        invalidReplacement.authenticated &&
        result.imports.rejected.httpStatus === 400 &&
        result.imports.rejected.responseStatus === "error" &&
        result.imports.rejected.rejectedBeforeCommit &&
        result.imports.rejected.committed === false &&
        result.imports.rejected.filename === result.imports.accepted.filename,
      ),
      "contract-invalid candidate must receive HTTP 400 before commit",
    ),
    check(
      "previous-generation-preserved",
      Boolean(
        result &&
        result.preservation.previousGenerationPreserved &&
        result.agent.sourceSha256Before === result.agent.sourceSha256After &&
        result.agent.objectIdentityBefore ===
          result.agent.objectIdentityAfter &&
        result.agent.registryInstanceIdBefore ===
          result.agent.registryInstanceIdAfter &&
        result.imports.rejected.candidateSourceSha256 !==
          result.agent.sourceSha256Before,
      ),
      "previous source bytes and live registry object must remain active",
    ),
    check(
      "deterministic-second-execution",
      Boolean(
        result &&
        isDeepStrictEqual(
          transplantDeterministicCore(
            result.agent.name,
            result.executions.first,
          ),
          transplantDeterministicCore(
            result.agent.name,
            result.executions.second,
          ),
        ),
      ),
      "second deterministic core must equal the first; timing and identities are excluded",
    ),
    check(
      "flight-recorder-integrity",
      Boolean(
        result &&
        manifest &&
        observations &&
        flightRecorderIsValid(result, manifest, observations),
      ),
      "persisted and reopened Flight Recorder artifacts and event hashes must verify",
    ),
    check(
      "no-provider-model-events",
      Boolean(result && noProviderOrModelEvents(result)),
      "provider/model counters and Flight Recorder events must remain zero",
    ),
    check(
      "loopback-only-traffic",
      Boolean(result && loopbackTrafficOnly(result)),
      "all gateway traffic must be HTTP loopback with no external requests",
    ),
    check(
      "unsandboxed-file-boundary",
      Boolean(
        result &&
        result.preservation.sandboxed === false &&
        result.preservation.preservationBoundary === "file-only",
      ),
      "result must state sandboxed:false and preservationBoundary:file-only",
    ),
    check(
      "bounded-runtime",
      Boolean(
        result &&
        missingPythonResult &&
        manifest &&
        observations &&
        result.runtime.elapsedMs <= manifest.runtimeLimits.demoMaxElapsedMs &&
        result.executions.first.elapsedMs <=
          manifest.runtimeLimits.demoMaxElapsedMs &&
        result.executions.second.elapsedMs <=
          manifest.runtimeLimits.demoMaxElapsedMs &&
        missingPythonResult.elapsedMs <=
          manifest.runtimeLimits.missingPythonTimeoutMs &&
        observations.successElapsedMs <=
          manifest.runtimeLimits.commandTimeoutMs &&
        observations.missingPythonElapsedMs <=
          manifest.runtimeLimits.missingPythonTimeoutMs,
      ),
      "runtime and both command scenarios must stay within manifest deadlines",
    ),
    check(
      "missing-python-controlled",
      Boolean(
        missingPythonResult &&
        manifest &&
        observations &&
        observations.missingPythonExitCode ===
          manifest.missingPython.expectedExitCode &&
        observations.missingPythonRecordCount === 1 &&
        observations.missingPythonRecordCanonical &&
        missingPythonResult.reason === "python-unavailable" &&
        missingPythonResult.pythonExecutable ===
          manifest.missingPython.executable &&
        /python/i.test(missingPythonResult.message) &&
        missingPythonResult.sandboxed === false &&
        missingPythonResult.preservationBoundary === "file-only" &&
        missingPythonResult.providerCalls === 0 &&
        missingPythonResult.modelCalls === 0 &&
        missingPythonResult.externalNetworkRequests === 0,
      ),
      "missing Python must produce one controlled, explicit, non-model result",
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
        result.evidence.missing.length === 0 &&
        result.evidence.skipped.length === 0 &&
        missingPythonResult.evidence.missing.length === 0 &&
        missingPythonResult.evidence.skipped.length === 0 &&
        observations.missingEvidence.length === 0 &&
        observations.skippedEvidence.length === 0,
      ),
      "missing or skipped evidence is always a failure",
    ),
    check(
      "fixture-source-hash-pinned",
      Boolean(
        result &&
        manifest &&
        isSha256(manifest.fixture.sourceSha256) &&
        manifest.fixture.sourceSha256 === result.agent.sourceSha256Before &&
        manifest.fixture.sourceSha256 ===
          result.imports.accepted.candidateSourceSha256 &&
        manifest.fixture.filename === result.agent.filename,
      ),
      "manifest fixture source hash must be a real SHA-256 pin matching the accepted source",
    ),
  ];

  return {
    pass: checks.every((entry) => entry.pass),
    checks,
  };
}
