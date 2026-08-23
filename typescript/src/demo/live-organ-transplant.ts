#!/usr/bin/env node

import { execFile } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fchmodSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { AgentRegistry } from "../agents/AgentRegistry.js";
import {
  importAgentFile,
  type ImportResult,
} from "../agents/agent-import.js";
import { PythonAgent } from "../agents/PythonAgent.js";
import {
  FlightRecorder,
  setFlightRecorder,
} from "../flight-recorder/recorder.js";
import type {
  FlightEvent,
  FlightExport,
} from "../flight-recorder/types.js";
import { GatewayServer } from "../gateway/server.js";
import { openrappterPath } from "../infra/openrappter-home.js";
import {
  TRANSPLANT_AGENT_NAME,
  TRANSPLANT_DEMO_ID,
  TRANSPLANT_GATEWAY_MODULE,
  TRANSPLANT_PYTHON_BRIDGE_MODULE,
  TRANSPLANT_RESULT_PREFIX,
  TRANSPLANT_RESULT_SCHEMA,
  TRANSPLANT_RUNTIME_ENTRYPOINT,
  canonicalJson,
  evaluateTransplantCausalTrace,
  formatTransplantResultRecord,
  isLiveOrganTransplantManifest,
  isLiveOrganTransplantMissingPythonResult,
  isLiveOrganTransplantSuccessResult,
  type LiveOrganTransplantManifest,
  type LiveOrganTransplantMissingPythonResult,
  type LiveOrganTransplantResult,
  type LiveOrganTransplantSuccessResult,
  type TransplantExecutionEvidence,
  type TransplantGatewayRequestEvidence,
} from "./live-organ-transplant-contract.js";

export const TRANSPLANT_AUTHORITY_NOTICE =
  "AUTHORITY NOTICE: Python executes as the logged-in OS user with filesystem/network/environment/subprocess authority. The subprocess is NOT a sandbox. File preservation cannot undo external side effects.";

export const TRANSPLANT_RECEIPT_FILENAMES = [
  "receipt.txt",
  "receipt.json",
  "transcript.txt",
] as const;

const MODULE_PATH = fileURLToPath(import.meta.url);
const TYPESCRIPT_ROOT = path.resolve(path.dirname(MODULE_PATH), "../..");
const REPOSITORY_ROOT = path.dirname(TYPESCRIPT_ROOT);
const MANIFEST_PATH = path.join(
  TYPESCRIPT_ROOT,
  "src",
  "demo",
  "live-organ-transplant.manifest.json",
);
const PYTHON_PROBE_TIMEOUT_MS = 2_500;
const GATEWAY_REQUEST_TIMEOUT_MS = 10_000;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

interface PythonAvailable {
  available: true;
  executable: string;
  version: string;
}

interface PythonUnavailable {
  available: false;
  executable: string;
}

export type PythonDetection = PythonAvailable | PythonUnavailable;

export interface LiveOrganTransplantRunOutcome {
  result: LiveOrganTransplantResult;
  exitCode: number;
  narrative: string[];
  record: string;
}

interface ImportProvenance {
  scenarioNonce?: string;
  nonce?: string;
  requestId?: string;
  traceId?: string;
  parentId?: string | null;
}

interface ImportExchange {
  body: Record<string, unknown>;
  request: TransplantGatewayRequestEvidence;
}

interface StrictChecksumResult {
  status: "success";
  output: {
    algorithm: "sha256";
    digest: string;
  };
}

interface TraceEvidence {
  requests: TransplantGatewayRequestEvidence[];
  gatewayPort: number;
  registryIdentityBefore: string;
  registryIdentityAfter: string;
  objectIdentityBefore: string;
  objectIdentityAfter: string;
  sourceSha256Before: string;
  sourceSha256After: string;
  accepted: {
    body: Record<string, unknown>;
    committed: boolean;
  };
  rejected: {
    body: Record<string, unknown>;
    rejectedBeforeCommit: boolean;
    committed: boolean;
    errorCode: string;
  };
  first: TransplantExecutionEvidence;
  second: TransplantExecutionEvidence;
}

class ReferenceIdentity {
  private readonly values = new WeakMap<object, string>();
  private next = 1;

  token(value: object, kind: string): string {
    const existing = this.values.get(value);
    if (existing) return existing;
    const token = `${kind}-reference:${process.pid}:${this.next}`;
    this.next += 1;
    this.values.set(value, token);
    return token;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return (
    actual.length === wanted.length &&
    actual.every((entry, index) => entry === wanted[index])
  );
}

function sha256(bytes: string | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function fixturePath(relativePath: string): string {
  const resolved = path.resolve(REPOSITORY_ROOT, relativePath);
  const relative = path.relative(REPOSITORY_ROOT, resolved);
  if (
    relative === "" ||
    relative.startsWith("..") ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`Fixture path escapes the repository: ${relativePath}`);
  }
  return resolved;
}

export function loadLiveOrganTransplantManifest(): LiveOrganTransplantManifest {
  const parsed: unknown = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
  if (!isLiveOrganTransplantManifest(parsed)) {
    throw new Error("Live organ transplant manifest is invalid.");
  }
  if (
    parsed.fixture.sourceSha256 === null ||
    parsed.fixture.invalidSourceSha256 === null
  ) {
    throw new Error("Live organ transplant fixture hashes are not pinned.");
  }
  return parsed;
}

function ensurePrivateDirectory(directory: string): void {
  if (existsSync(directory)) {
    const existing = lstatSync(directory);
    if (!existing.isDirectory() || existing.isSymbolicLink()) {
      throw new Error(`Evidence path is not a private directory: ${directory}`);
    }
  } else {
    mkdirSync(directory, {
      recursive: true,
      mode: PRIVATE_DIRECTORY_MODE,
    });
  }
  chmodSync(directory, PRIVATE_DIRECTORY_MODE);
}

function pathIsInside(candidate: string, directory: string): boolean {
  const relative = path.relative(path.resolve(directory), path.resolve(candidate));
  return (
    relative !== "" &&
    !relative.startsWith("..") &&
    !path.isAbsolute(relative)
  );
}

function freshHumanEvidenceDirectory(nonce: string): string {
  const root = openrappterPath("demo-runs", TRANSPLANT_DEMO_ID);
  ensurePrivateDirectory(root);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const safeNonce = nonce.replace(/[^A-Za-z0-9_-]/g, "_");
  const directory = path.join(root, `${timestamp}-${safeNonce}`);
  mkdirSync(directory, { mode: PRIVATE_DIRECTORY_MODE });
  chmodSync(directory, PRIVATE_DIRECTORY_MODE);
  return directory;
}

function resolveScenario(manifest: LiveOrganTransplantManifest): {
  nonce: string;
  evidenceDirectory: string;
  runtimePidHandoffPath: string;
} {
  const nonceEnvironment =
    manifest.artifacts.nonceEnvironmentVariable;
  const directoryEnvironment =
    manifest.artifacts.directoryEnvironmentVariable;
  const handoffEnvironment =
    manifest.artifacts.runtimePidHandoffEnvironmentVariable;
  const nonce =
    process.env[nonceEnvironment]?.trim() || randomUUID();
  const configuredDirectory = process.env[directoryEnvironment]?.trim();
  const evidenceDirectory = configuredDirectory
    ? path.resolve(configuredDirectory)
    : freshHumanEvidenceDirectory(nonce);
  ensurePrivateDirectory(evidenceDirectory);

  const configuredHandoff = process.env[handoffEnvironment]?.trim();
  const runtimePidHandoffPath = configuredHandoff
    ? path.resolve(configuredHandoff)
    : path.join(
        evidenceDirectory,
        manifest.artifacts.runtimePidHandoffFilename,
      );
  if (!pathIsInside(runtimePidHandoffPath, evidenceDirectory)) {
    throw new Error(
      "Runtime PID handoff must be inside the scenario evidence directory.",
    );
  }
  ensurePrivateDirectory(path.dirname(runtimePidHandoffPath));
  return { nonce, evidenceDirectory, runtimePidHandoffPath };
}

function writePrivateExclusive(file: string, contents: string): void {
  const descriptor = openSync(file, "wx", PRIVATE_FILE_MODE);
  try {
    fchmodSync(descriptor, PRIVATE_FILE_MODE);
    writeFileSync(descriptor, contents, { encoding: "utf8" });
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function writeRuntimePidHandoff(
  handoffPath: string,
  nonce: string,
): void {
  writePrivateExclusive(
    handoffPath,
    canonicalJson({
      schema: "openrappter-runtime-pid/1.0",
      nonce,
      pid: process.pid,
    }),
  );
}

function probePython(
  executable: string,
): Promise<{ ok: true; version: string } | { ok: false }> {
  return new Promise((resolve) => {
    execFile(
      executable,
      ["--version"],
      {
        timeout: PYTHON_PROBE_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 4_096,
      },
      (error, stdout, stderr) => {
        if (error) {
          resolve({ ok: false });
          return;
        }
        const output = `${stdout}\n${stderr}`.trim();
        const match = /\bPython\s+(\d+)\.(\d+)(?:\.(\d+))?\b/.exec(output);
        if (!match) {
          resolve({ ok: false });
          return;
        }
        const major = Number.parseInt(match[1]!, 10);
        const minor = Number.parseInt(match[2]!, 10);
        if (major < 3 || (major === 3 && minor < 10)) {
          resolve({ ok: false });
          return;
        }
        resolve({ ok: true, version: match[0] });
      },
    );
  });
}

export async function detectPythonExecutable(
  configured = process.env.OPENRAPPTER_PYTHON,
): Promise<PythonDetection> {
  const explicit = configured?.trim();
  const candidates = explicit ? [explicit] : ["python3", "python"];
  for (const executable of candidates) {
    const probe = await probePython(executable);
    if (probe.ok) {
      return {
        available: true,
        executable,
        version: probe.version,
      };
    }
  }
  return {
    available: false,
    executable: explicit || candidates[0]!,
  };
}

function verifyFixtureHashes(
  manifest: LiveOrganTransplantManifest,
): {
  validPath: string;
  invalidPath: string;
  validBytes: Buffer;
  invalidBytes: Buffer;
  validHash: string;
  invalidHash: string;
} {
  const validPath = fixturePath(manifest.fixture.bundledPath);
  const invalidPath = fixturePath(manifest.fixture.invalidBundledPath);
  const validBytes = readFileSync(validPath);
  const invalidBytes = readFileSync(invalidPath);
  const validHash = sha256(validBytes);
  const invalidHash = sha256(invalidBytes);
  if (validHash !== manifest.fixture.sourceSha256) {
    throw new Error("Bundled ChecksumAgent does not match its manifest hash.");
  }
  if (invalidHash !== manifest.fixture.invalidSourceSha256) {
    throw new Error(
      "Bundled invalid fixture does not match its manifest hash.",
    );
  }
  if (validHash === invalidHash) {
    throw new Error("Valid and invalid fixture bytes must differ.");
  }
  return {
    validPath,
    invalidPath,
    validBytes,
    invalidBytes,
    validHash,
    invalidHash,
  };
}

function processStartIdentity(): string {
  return `node-start:${process.pid}:${performance.timeOrigin.toFixed(3)}`;
}

function statIdentity(file: string): string {
  const stat = statSync(file, { bigint: true });
  return [
    stat.dev,
    stat.ino,
    stat.mode,
    stat.size,
    stat.mtimeNs,
    stat.ctimeNs,
  ].join(":");
}

function parseImportBody(raw: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed) || typeof parsed.status !== "string") {
    throw new Error("Gateway importer returned a malformed JSON response.");
  }
  return parsed;
}

async function postImport(
  input: {
    baseUrl: string;
    token: string;
    filename: string;
    contents: Buffer;
    nonce: string;
    requestId: string;
    traceId: string;
    purpose: TransplantGatewayRequestEvidence["purpose"];
    candidateSourceSha256: string;
  },
): Promise<ImportExchange> {
  const url = new URL("/agents/import", input.baseUrl);
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    GATEWAY_REQUEST_TIMEOUT_MS,
  );
  timeout.unref();
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        authorization: ["Bearer", input.token].join(" "),
        connection: "close",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        filename: input.filename,
        contents: input.contents.toString("utf8"),
        scenarioNonce: input.nonce,
        requestId: input.requestId,
        traceId: input.traceId,
      }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
  const body = parseImportBody(await response.text());
  return {
    body,
    request: {
      purpose: input.purpose,
      url: url.href,
      hostname: url.hostname,
      method: "POST",
      path: url.pathname,
      status: response.status,
      authenticated: true,
      authorization: "bearer-token",
      requestId: input.requestId,
      scenarioNonce: input.nonce,
      filename: input.filename,
      candidateSourceSha256: input.candidateSourceSha256,
    },
  };
}

function strictChecksumResult(raw: string): StrictChecksumResult {
  const parsed: unknown = JSON.parse(raw);
  if (
    !isRecord(parsed) ||
    !hasExactKeys(parsed, ["status", "output"]) ||
    parsed.status !== "success" ||
    !isRecord(parsed.output) ||
    !hasExactKeys(parsed.output, ["algorithm", "digest"]) ||
    parsed.output.algorithm !== "sha256" ||
    typeof parsed.output.digest !== "string" ||
    !/^[0-9a-f]{64}$/.test(parsed.output.digest)
  ) {
    throw new Error(
      "ChecksumAgent did not return the exact success/output digest contract.",
    );
  }
  return parsed as unknown as StrictChecksumResult;
}

async function executeHeldAgent(
  agent: PythonAgent,
  query: string,
): Promise<TransplantExecutionEvidence> {
  const started = performance.now();
  const raw = await agent.execute({ query });
  const result = strictChecksumResult(raw);
  return {
    input: query,
    output: {
      algorithm: result.output.algorithm,
      digest: result.output.digest,
    },
    elapsedMs: Math.ceil(performance.now() - started),
  };
}

function responseString(
  body: Record<string, unknown>,
  key: string,
  fallback: string,
): string {
  return typeof body[key] === "string" && body[key].length > 0
    ? body[key]
    : fallback;
}

function responseBoolean(
  body: Record<string, unknown>,
  key: string,
): boolean | undefined {
  return typeof body[key] === "boolean" ? body[key] : undefined;
}

function requireRecorded(
  event: FlightEvent | null,
  kind: string,
): asserts event is FlightEvent {
  if (!event) {
    throw new Error(`Flight Recorder did not persist ${kind}.`);
  }
}

function compatibleImporter(
  registry: AgentRegistry,
  agentsDirectory: string,
): (
  filename: string,
  contents: Buffer,
  provenance?: unknown,
) => Promise<ImportResult> {
  type ImportWithProvenance = (
    filename: string,
    contents: Buffer,
    registry: AgentRegistry,
    options: Record<string, unknown>,
    provenance?: unknown,
  ) => Promise<ImportResult>;
  const productionImport =
    importAgentFile as unknown as ImportWithProvenance;

  return async (filename, contents, rawProvenance) => {
    const provenance = isRecord(rawProvenance)
      ? (rawProvenance as ImportProvenance)
      : undefined;
    const options: Record<string, unknown> = {
      dir: agentsDirectory,
      ...(provenance
        ? {
            provenance,
            requestProvenance: provenance,
            scenarioNonce: provenance.scenarioNonce,
            nonce: provenance.nonce ?? provenance.scenarioNonce,
            requestId: provenance.requestId,
            traceId: provenance.traceId,
            parentId: provenance.parentId,
          }
        : {}),
    };
    return productionImport(
      filename,
      contents,
      registry,
      options,
      provenance,
    );
  };
}

async function runCausalTrace(input: {
  recorder: FlightRecorder;
  registry: AgentRegistry;
  gateway: GatewayServer;
  token: string;
  traceId: string;
  nonce: string;
  manifest: LiveOrganTransplantManifest;
  validBytes: Buffer;
  invalidBytes: Buffer;
  validHash: string;
  invalidHash: string;
  identities: ReferenceIdentity;
}): Promise<TraceEvidence> {
  const baseUrl = `http://127.0.0.1:${input.gateway.port}`;
  const requests: TransplantGatewayRequestEvidence[] = [];
  const registryIdentityBefore = input.identities.token(
    input.registry,
    "AgentRegistry",
  );
  let captured: TraceEvidence | undefined;

  await input.recorder.runTrace({ traceId: input.traceId }, async () => {
    const started = await input.recorder.record({
      kind: "demo.transplant.started",
      source: TRANSPLANT_DEMO_ID,
      status: "started",
      metadata: { nonce: input.nonce },
    });
    requireRecorded(started, "demo.transplant.started");
    const authorization = await input.recorder.record({
      kind: "agent.import.authorization.started",
      source: "agent-import-authorizer",
      status: "started",
      metadata: { nonce: input.nonce, mode: "caller-supplied" },
    });
    requireRecorded(authorization, "agent.import.authorization.started");

    const acceptedExchange = await postImport({
      baseUrl,
      token: input.token,
      filename: input.manifest.fixture.filename,
      contents: input.validBytes,
      nonce: input.nonce,
      requestId: `valid-${randomUUID()}`,
      traceId: input.traceId,
      purpose: "valid-import",
      candidateSourceSha256: input.validHash,
    });
    requests.push(acceptedExchange.request);
    if (
      acceptedExchange.request.status !== 200 ||
      acceptedExchange.body.status !== "ok"
    ) {
      throw new Error("The valid ChecksumAgent import was not accepted.");
    }

    const resolved = await input.registry.getAgent(TRANSPLANT_AGENT_NAME);
    if (!(resolved instanceof PythonAgent)) {
      throw new Error(
        `${TRANSPLANT_AGENT_NAME} did not resolve as the production PythonAgent bridge.`,
      );
    }
    const heldAgentReference = resolved;
    const objectIdentityBefore = input.identities.token(
      heldAgentReference,
      "PythonAgent",
    );
    const expectedTarget = path.resolve(
      path.dirname(resolved.sourceFile),
      input.manifest.fixture.filename,
    );
    if (path.resolve(resolved.sourceFile) !== expectedTarget) {
      throw new Error("Resolved PythonAgent source filename is unexpected.");
    }
    chmodSync(resolved.sourceFile, PRIVATE_FILE_MODE);
    const sourceSha256Before = sha256(readFileSync(resolved.sourceFile));
    if (sourceSha256Before !== input.validHash) {
      throw new Error("Committed PythonAgent bytes differ from the donor.");
    }
    if (
      responseBoolean(acceptedExchange.body, "committed") === false
    ) {
      throw new Error("Gateway response denied committing the valid donor.");
    }

    const first = await executeHeldAgent(
      heldAgentReference,
      input.manifest.input,
    );
    if (first.output.digest !== input.manifest.expectedSha256) {
      throw new Error("The first ChecksumAgent execution missed the known vector.");
    }

    const targetStatBefore = statIdentity(resolved.sourceFile);
    const rejectedExchange = await postImport({
      baseUrl,
      token: input.token,
      filename: input.manifest.fixture.filename,
      contents: input.invalidBytes,
      nonce: input.nonce,
      requestId: `invalid-${randomUUID()}`,
      traceId: input.traceId,
      purpose: "invalid-replacement",
      candidateSourceSha256: input.invalidHash,
    });
    requests.push(rejectedExchange.request);
    if (
      rejectedExchange.request.status !== 400 ||
      rejectedExchange.body.status !== "error"
    ) {
      throw new Error("The contract-invalid candidate was not rejected.");
    }

    const second = await executeHeldAgent(
      heldAgentReference,
      input.manifest.input,
    );
    const activeAfter = await input.registry.getAgent(TRANSPLANT_AGENT_NAME);
    const sourceSha256After = sha256(readFileSync(resolved.sourceFile));
    const targetStatAfter = statIdentity(resolved.sourceFile);
    const registryIdentityAfter = input.identities.token(
      input.registry,
      "AgentRegistry",
    );
    const objectIdentityAfter =
      activeAfter && typeof activeAfter === "object"
        ? input.identities.token(activeAfter, "PythonAgent")
        : "";
    const committed = sourceSha256After === input.invalidHash;
    const rejectedBeforeCommit =
      activeAfter === heldAgentReference &&
      sourceSha256After === sourceSha256Before &&
      targetStatAfter === targetStatBefore &&
      responseBoolean(rejectedExchange.body, "committed") !== true &&
      responseBoolean(
        rejectedExchange.body,
        "rejectedBeforeCommit",
      ) !== false;

    if (!rejectedBeforeCommit || committed) {
      throw new Error(
        "The invalid candidate changed committed bytes, metadata, or live identity.",
      );
    }
    if (
      registryIdentityBefore !== registryIdentityAfter ||
      objectIdentityBefore !== objectIdentityAfter
    ) {
      throw new Error("Registry or held PythonAgent identity changed.");
    }
    if (
      second.output.digest !== first.output.digest ||
      second.output.digest !== input.manifest.expectedSha256
    ) {
      throw new Error("The held PythonAgent changed after candidate rejection.");
    }

    const authorizationCompleted = await input.recorder.record({
      kind: "agent.import.authorization.completed",
      source: "agent-import-authorizer",
      status: "success",
      metadata: { nonce: input.nonce, mode: "caller-supplied" },
    });
    requireRecorded(
      authorizationCompleted,
      "agent.import.authorization.completed",
    );

    const completed = await input.recorder.record({
      kind: "demo.transplant.completed",
      source: TRANSPLANT_DEMO_ID,
      status: "success",
      metadata: { nonce: input.nonce },
    });
    requireRecorded(completed, "demo.transplant.completed");

    captured = {
      requests,
      gatewayPort: input.gateway.port,
      registryIdentityBefore,
      registryIdentityAfter,
      objectIdentityBefore,
      objectIdentityAfter,
      sourceSha256Before,
      sourceSha256After,
      accepted: {
        body: acceptedExchange.body,
        committed: true,
      },
      rejected: {
        body: rejectedExchange.body,
        rejectedBeforeCommit,
        committed,
        errorCode: responseString(
          rejectedExchange.body,
          "errorCode",
          "contract-invalid-candidate",
        ),
      },
      first,
      second,
    };
  });

  if (!captured) {
    throw new Error("The causal transplant trace did not complete.");
  }
  return captured;
}

function artifactDescriptor(file: string): {
  path: string;
  sha256: string;
  sizeBytes: number;
} {
  const bytes = readFileSync(file);
  if (bytes.length === 0) {
    throw new Error(`Required artifact is empty: ${file}`);
  }
  return {
    path: file,
    sha256: sha256(bytes),
    sizeBytes: bytes.length,
  };
}

function assertNoProviderOrModelEvents(events: readonly FlightEvent[]): void {
  const offending = events.filter(
    (event) =>
      event.providerId !== undefined ||
      event.model !== undefined ||
      event.kind.startsWith("provider.") ||
      event.kind.startsWith("model."),
  );
  if (offending.length > 0) {
    throw new Error("The model-free trace contains provider or model activity.");
  }
}

function successNarrative(
  result: LiveOrganTransplantSuccessResult,
): string[] {
  const digest = result.executions.first.output.digest;
  return [
    `[1/6] DONOR VERIFIED — ${result.agent.filename} matches its pinned SHA-256 source.`,
    `[2/6] THEATER ONLINE — authenticated loopback GatewayServer listening on 127.0.0.1:${result.gateway.port}.`,
    `[3/6] TRANSPLANT ACCEPTED — ${result.agent.name} is live through the production PythonAgent bridge.`,
    `[4/6] FIRST PULSE — sha256(${JSON.stringify(result.executions.first.input)}) = ${digest}.`,
    `[5/6] REJECTION TEST — the invalid candidate was refused before commit; the held PythonAgent produced ${result.executions.second.output.digest}.`,
    `[6/6] FLIGHT SEALED — ${result.flightRecorder.eventCount} events persisted under trace ${result.flightRecorder.traceId}.`,
  ];
}

function missingPythonNarrative(
  result: LiveOrganTransplantMissingPythonResult,
): string[] {
  return [
    "[1/6] DONOR VERIFIED — bundled fixture hashes are pinned.",
    "[2/6] THEATER CHECK — this runtime supports macOS, Linux, and WSL.",
    `[3/6] INTERPRETER CHECK — ${result.pythonExecutable} did not provide Python >=3.10.`,
    "[4/6] TRANSPLANT PAUSED — no agent import or execution was attempted.",
    "[5/6] MODEL LEDGER — provider calls: 0; model calls: 0.",
    `[6/6] RECEIPT SEALED — controlled result written in ${result.scenario.evidenceDirectory}.`,
  ];
}

export function transplantNarrative(
  result: LiveOrganTransplantResult,
): string[] {
  return result.status === "success"
    ? successNarrative(result)
    : missingPythonNarrative(result);
}

function writeReceipts(
  result: LiveOrganTransplantResult,
  narrative: readonly string[],
): void {
  const directory = result.scenario.evidenceDirectory;
  const record = formatTransplantResultRecord(result);
  const receiptText = [
    "OPENRAPPTER LIVE ORGAN TRANSPLANT RECEIPT",
    `status: ${result.status}`,
    `scenario nonce: ${result.scenario.nonce}`,
    `command: ${result.command}`,
    ...(result.status === "success"
      ? [
          `trace id: ${result.flightRecorder.traceId}`,
          `active source sha256: ${result.agent.sourceSha256After}`,
          `digest: ${result.executions.second.output.digest}`,
        ]
      : [`python executable: ${result.pythonExecutable}`]),
    TRANSPLANT_AUTHORITY_NOTICE,
    "",
  ].join("\n");
  const transcript = [
    ...narrative,
    TRANSPLANT_AUTHORITY_NOTICE,
    record,
    "",
  ].join("\n");
  writePrivateExclusive(
    path.join(directory, "receipt.json"),
    canonicalJson(result),
  );
  writePrivateExclusive(
    path.join(directory, "receipt.txt"),
    receiptText,
  );
  writePrivateExclusive(
    path.join(directory, "transcript.txt"),
    transcript,
  );
}

function finishOutcome(
  result: LiveOrganTransplantResult,
  exitCode: number,
): LiveOrganTransplantRunOutcome {
  const narrative = transplantNarrative(result);
  writeReceipts(result, narrative);
  return {
    result,
    exitCode,
    narrative,
    record: formatTransplantResultRecord(result),
  };
}

function buildMissingPythonResult(input: {
  manifest: LiveOrganTransplantManifest;
  nonce: string;
  evidenceDirectory: string;
  pythonExecutable: string;
  elapsedMs: number;
}): LiveOrganTransplantMissingPythonResult {
  const result: LiveOrganTransplantMissingPythonResult = {
    schema: TRANSPLANT_RESULT_SCHEMA,
    status: "python-unavailable",
    demo: TRANSPLANT_DEMO_ID,
    command: input.manifest.command.display,
    scenario: {
      nonce: input.nonce,
      evidenceDirectory: input.evidenceDirectory,
    },
    reason: "python-unavailable",
    pythonExecutable: input.pythonExecutable,
    message: "Python >=3.10 is unavailable.",
    sandboxed: false,
    preservationBoundary: "file-only",
    elapsedMs: input.elapsedMs,
    providerCalls: 0,
    modelCalls: 0,
    evidence: {
      missing: [],
      skipped: [],
    },
  };
  if (!isLiveOrganTransplantMissingPythonResult(result)) {
    throw new Error("Controlled missing-Python result failed its type guard.");
  }
  return result;
}

export async function runLiveOrganTransplant(): Promise<LiveOrganTransplantRunOutcome> {
  const runtimeStarted = performance.now();
  const manifest = loadLiveOrganTransplantManifest();
  const scenario = resolveScenario(manifest);
  writeRuntimePidHandoff(
    scenario.runtimePidHandoffPath,
    scenario.nonce,
  );

  if (process.platform !== "darwin" && process.platform !== "linux") {
    throw new Error(
      `Unsupported platform ${process.platform}; use macOS, Linux, or WSL.`,
    );
  }

  const fixtures = verifyFixtureHashes(manifest);
  const python = await detectPythonExecutable();
  if (!python.available) {
    const elapsedMs = Math.ceil(performance.now() - runtimeStarted);
    if (elapsedMs > manifest.runtimeLimits.missingPythonTimeoutMs) {
      throw new Error(
        `Missing-Python detection exceeded ${manifest.runtimeLimits.missingPythonTimeoutMs}ms.`,
      );
    }
    const result = buildMissingPythonResult({
      manifest,
      nonce: scenario.nonce,
      evidenceDirectory: scenario.evidenceDirectory,
      pythonExecutable: python.executable,
      elapsedMs,
    });
    return finishOutcome(
      result,
      manifest.missingPython.expectedExitCode,
    );
  }
  const originalPython = process.env.OPENRAPPTER_PYTHON;
  const pidBefore = process.pid;
  const startIdentityBefore = processStartIdentity();
  const identities = new ReferenceIdentity();
  const traceId = `transplant-${randomUUID()}`;
  const databasePath = path.join(
    scenario.evidenceDirectory,
    "flight-recorder.db",
  );
  const exportPath = path.join(
    scenario.evidenceDirectory,
    "flight-recorder.export.json",
  );
  const builtinsDirectory = path.join(
    scenario.evidenceDirectory,
    "builtins",
  );
  const agentsDirectory = path.join(
    scenario.evidenceDirectory,
    "agents",
  );
  const gatewayDirectory = path.join(
    scenario.evidenceDirectory,
    "gateway",
  );
  for (const directory of [
    builtinsDirectory,
    agentsDirectory,
    gatewayDirectory,
  ]) {
    ensurePrivateDirectory(directory);
  }

  const token = randomBytes(32).toString("hex");
  let recorder: FlightRecorder | null = null;
  let gateway: GatewayServer | null = null;
  let previousRecorder: FlightRecorder | null = null;
  let recorderInstalled = false;
  let traceEvidence: TraceEvidence | undefined;
  let flightExport: FlightExport | undefined;
  let recordedEvents: FlightEvent[] | undefined;
  let primaryFailure: unknown;
  let pythonEnvironmentInstalled = false;

  try {
    process.env.OPENRAPPTER_PYTHON = python.executable;
    pythonEnvironmentInstalled = true;
    recorder = new FlightRecorder({
      databasePath,
      privacy: {
        recordIO: true,
        redactedValues: [token],
      },
    });
    await recorder.initialize();
    const health = await recorder.health();
    if (!health.enabled || !health.initialized || health.errorCount !== 0) {
      throw new Error(
        `Flight Recorder failed to initialize: ${health.lastError ?? "unknown error"}`,
      );
    }

    const registry = new AgentRegistry(
      builtinsDirectory,
      agentsDirectory,
    );
    gateway = new GatewayServer({
      port: 0,
      bind: "loopback",
      auth: { mode: "token", tokens: [token] },
      heartbeatInterval: 60_000,
      shutdownTimeoutMs: 2_000,
      dataDir: gatewayDirectory,
    });
    gateway.setAgentFilesRoot(agentsDirectory);
    gateway.setAgentImporter(
      compatibleImporter(registry, agentsDirectory),
    );
    await gateway.start();
    if (gateway.port <= 0) {
      throw new Error("GatewayServer did not bind an ephemeral loopback port.");
    }

    previousRecorder = setFlightRecorder(recorder);
    recorderInstalled = true;
    traceEvidence = await runCausalTrace({
      recorder,
      registry,
      gateway,
      token,
      traceId,
      nonce: scenario.nonce,
      manifest,
      validBytes: fixtures.validBytes,
      invalidBytes: fixtures.invalidBytes,
      validHash: fixtures.validHash,
      invalidHash: fixtures.invalidHash,
      identities,
    });
    recordedEvents = await recorder.query({
      traceId,
      order: "asc",
    });
    const causal = evaluateTransplantCausalTrace(recordedEvents, {
      traceId,
      nonce: scenario.nonce,
      runtimePid: process.pid,
      validFixtureSha256: fixtures.validHash,
      invalidFixtureSha256: fixtures.invalidHash,
      filename: manifest.fixture.filename,
      agentName: TRANSPLANT_AGENT_NAME,
      digest: manifest.expectedSha256,
    });
    if (!causal.pass) {
      throw new Error(
        `Production causal trace failed: ${causal.failures.join("; ")} `
        + `(trace owner PID ${causal.ownerPid ?? "missing"}, `
        + `runtime PID ${process.pid})`,
      );
    }
    flightExport = await recorder.exportTrace(traceId) ?? undefined;
    if (!flightExport) {
      throw new Error("Flight Recorder did not export the transplant trace.");
    }
    assertNoProviderOrModelEvents(flightExport.events);
    const exportJson = canonicalJson(flightExport);
    if (exportJson.includes(token)) {
      throw new Error("Gateway credential appeared in the Flight export.");
    }
    writePrivateExclusive(exportPath, exportJson);
  } catch (error) {
    primaryFailure = error;
    throw error;
  } finally {
    const cleanupFailures: unknown[] = [];
    if (recorderInstalled && previousRecorder) {
      try {
        setFlightRecorder(previousRecorder);
      } catch (error) {
        cleanupFailures.push(error);
      }
      recorderInstalled = false;
      previousRecorder = null;
    }
    if (gateway) {
      try {
        await gateway.stop();
      } catch (error) {
        cleanupFailures.push(error);
      }
      gateway = null;
    }
    if (recorder) {
      try {
        await recorder.close();
      } catch (error) {
        cleanupFailures.push(error);
      }
      recorder = null;
    }
    if (pythonEnvironmentInstalled) {
      if (originalPython === undefined) {
        delete process.env.OPENRAPPTER_PYTHON;
      } else {
        process.env.OPENRAPPTER_PYTHON = originalPython;
      }
      pythonEnvironmentInstalled = false;
    }
    if (cleanupFailures.length > 0) {
      throw new AggregateError(
        primaryFailure === undefined
          ? cleanupFailures
          : [primaryFailure, ...cleanupFailures],
        "Live organ transplant resource cleanup failed.",
      );
    }
  }

  if (!traceEvidence || !flightExport || !recordedEvents) {
    throw new Error("Live organ transplant evidence was not completed.");
  }
  chmodSync(databasePath, PRIVATE_FILE_MODE);
  chmodSync(exportPath, PRIVATE_FILE_MODE);
  const pidAfter = process.pid;
  const startIdentityAfter = processStartIdentity();
  if (
    pidAfter !== pidBefore ||
    startIdentityAfter !== startIdentityBefore
  ) {
    throw new Error("The TypeScript host process identity changed.");
  }
  const compiledEntrypoint = path.resolve(
    REPOSITORY_ROOT,
    TRANSPLANT_RUNTIME_ENTRYPOINT,
  );
  if (path.resolve(MODULE_PATH) !== compiledEntrypoint) {
    throw new Error(
      "The live organ transplant must run from its compiled JavaScript entrypoint.",
    );
  }
  const runtimeArtifact = artifactDescriptor(MODULE_PATH);
  const databaseArtifact = artifactDescriptor(databasePath);
  const exportArtifact = artifactDescriptor(exportPath);
  const elapsedMs = Math.ceil(performance.now() - runtimeStarted);
  if (elapsedMs > manifest.runtimeLimits.demoMaxElapsedMs) {
    throw new Error(
      `Live organ transplant exceeded ${manifest.runtimeLimits.demoMaxElapsedMs}ms.`,
    );
  }

  const result: LiveOrganTransplantSuccessResult = {
    schema: TRANSPLANT_RESULT_SCHEMA,
    status: "success",
    demo: TRANSPLANT_DEMO_ID,
    command: manifest.command.display,
    scenario: {
      nonce: scenario.nonce,
      evidenceDirectory: scenario.evidenceDirectory,
    },
    runtime: {
      mode: "compiled-javascript",
      entrypoint: TRANSPLANT_RUNTIME_ENTRYPOINT,
      entrypointSha256: runtimeArtifact.sha256,
      entrypointSizeBytes: runtimeArtifact.sizeBytes,
      typescriptRuntimeLoaderUsed: false,
      nodeVersion: process.version,
      elapsedMs,
    },
    host: {
      pidBefore,
      pidAfter,
      startIdentityBefore,
      startIdentityAfter,
      runtimePidHandoffPath: scenario.runtimePidHandoffPath,
    },
    gateway: {
      serverClass: "GatewayServer",
      serverModule: TRANSPLANT_GATEWAY_MODULE,
      bind: "loopback",
      address: "127.0.0.1",
      port: traceEvidence.gatewayPort,
      baseUrl: `http://127.0.0.1:${traceEvidence.gatewayPort}`,
      authMode: "token",
      productionImportRoute: true,
      requests: traceEvidence.requests,
    },
    agent: {
      name: TRANSPLANT_AGENT_NAME,
      filename: manifest.fixture.filename,
      bridgeClass: "PythonAgent",
      bridgeModule: TRANSPLANT_PYTHON_BRIDGE_MODULE,
      registryClass: "AgentRegistry",
      registryInstanceIdBefore:
        traceEvidence.registryIdentityBefore,
      registryInstanceIdAfter:
        traceEvidence.registryIdentityAfter,
      sourceSha256Before: traceEvidence.sourceSha256Before,
      sourceSha256After: traceEvidence.sourceSha256After,
      objectIdentityBefore: traceEvidence.objectIdentityBefore,
      objectIdentityAfter: traceEvidence.objectIdentityAfter,
    },
    imports: {
      accepted: {
        filename: manifest.fixture.filename,
        candidateSourceSha256: fixtures.validHash,
        httpStatus: traceEvidence.requests[0]!.status,
        responseStatus: responseString(
          traceEvidence.accepted.body,
          "status",
          "ok",
        ),
        committed: traceEvidence.accepted.committed,
      },
      rejected: {
        filename: manifest.fixture.filename,
        candidateSourceSha256: fixtures.invalidHash,
        httpStatus: traceEvidence.requests[1]!.status,
        responseStatus: responseString(
          traceEvidence.rejected.body,
          "status",
          "error",
        ),
        rejectedBeforeCommit:
          traceEvidence.rejected.rejectedBeforeCommit,
        committed: traceEvidence.rejected.committed,
        errorCode: traceEvidence.rejected.errorCode,
      },
    },
    executions: {
      first: traceEvidence.first,
      second: traceEvidence.second,
    },
    preservation: {
      sandboxed: false,
      preservationBoundary: "file-only",
      previousGenerationPreserved: true,
    },
    flightRecorder: {
      enabled: true,
      persisted: true,
      traceId,
      database: databaseArtifact,
      export: exportArtifact,
      exportSchema: flightExport.schema,
      exportedAt: flightExport.exportedAt,
      eventCount: recordedEvents.length,
      events: recordedEvents,
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
  if (!isLiveOrganTransplantSuccessResult(result)) {
    throw new Error("Success result failed its strict contract guard.");
  }
  return finishOutcome(result, 0);
}

export function renderLiveOrganTransplantOutput(
  outcome: LiveOrganTransplantRunOutcome,
  humanReadable: boolean,
): string {
  return [
    ...(humanReadable
      ? [...outcome.narrative, TRANSPLANT_AUTHORITY_NOTICE]
      : []),
    outcome.record,
    "",
  ].join("\n");
}

export function emitLiveOrganTransplantOutcome(
  outcome: LiveOrganTransplantRunOutcome,
  humanReadable = Boolean(process.stdout.isTTY && process.env.CI !== "1"),
): void {
  process.stdout.write(
    renderLiveOrganTransplantOutput(outcome, humanReadable),
  );
}

function errorMessage(error: unknown): string {
  const message =
    error instanceof Error ? error.message : String(error);
  return message.replaceAll(
    TRANSPLANT_RESULT_PREFIX,
    "[transplant-result-prefix]",
  );
}

function invokedDirectly(): boolean {
  return (
    typeof process.argv[1] === "string" &&
    path.resolve(process.argv[1]) === path.resolve(MODULE_PATH)
  );
}

if (invokedDirectly()) {
  try {
    const outcome = await runLiveOrganTransplant();
    emitLiveOrganTransplantOutcome(outcome);
    process.exitCode = outcome.exitCode;
  } catch (error) {
    process.stderr.write(`Live organ transplant failed: ${errorMessage(error)}\n`);
    process.exitCode = 1;
  }
}
