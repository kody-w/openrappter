import { createHash, randomUUID } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AgentRegistry } from "../../agents/AgentRegistry.js";
import { importAgentFile } from "../../agents/agent-import.js";
import { PythonAgent } from "../../agents/PythonAgent.js";
import {
  REQUIRED_TRANSPLANT_CAUSAL_STEPS,
  TRANSPLANT_AGENT_NAME,
  TRANSPLANT_GATEWAY_MODULE,
  TRANSPLANT_INVALID_FIXTURE,
  TRANSPLANT_PROBE_SCHEMA,
  TRANSPLANT_PYTHON_BRIDGE_MODULE,
  TRANSPLANT_VALID_FIXTURE,
  canonicalJson,
  evaluateTransplantCausalTrace,
  isLiveOrganTransplantManifest,
  type LiveOrganTransplantManifest,
  type TransplantExecutionEvidence,
  type TransplantIndependentProbeEvidence,
} from "../../demo/live-organ-transplant-contract.js";
import { verifyFlightEventHash } from "../../flight-recorder/integrity.js";
import { SQLiteFlightLedger } from "../../flight-recorder/ledger.js";
import {
  FlightRecorder,
  setFlightRecorder,
} from "../../flight-recorder/recorder.js";
import {
  type FlightEvent,
  type FlightExport,
  type FlightTraceContext,
} from "../../flight-recorder/types.js";
import { GatewayServer } from "../../gateway/server.js";

interface FlightProbeInput {
  originalDatabasePath: string;
  originalExportPath: string;
  copiedDatabasePath: string;
  copiedExportPath: string;
  databaseSha256: string;
  exportSha256: string;
}

const ZERO_HASH = "0".repeat(64);
const TEST_ROOT = path.resolve(
  fileURLToPath(new URL("../../../../", import.meta.url)),
);
const VALID_FIXTURE_PATH = path.join(TEST_ROOT, TRANSPLANT_VALID_FIXTURE);
const INVALID_FIXTURE_PATH = path.join(TEST_ROOT, TRANSPLANT_INVALID_FIXTURE);
const MANIFEST_PATH = fileURLToPath(
  new URL("../../demo/live-organ-transplant.manifest.json", import.meta.url),
);

let gateway: GatewayServer | null = null;
let recorder: FlightRecorder | null = null;
let previousRecorder: FlightRecorder | null = null;
let stateDirectory = "";
let setupError = "";
const probe = emptyProbe();

function sha256(bytes: string | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function loadManifest(): LiveOrganTransplantManifest {
  const value: unknown = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
  if (!isLiveOrganTransplantManifest(value)) {
    throw new Error("Live organ transplant manifest is invalid.");
  }
  return value;
}

function readBundledFixtures(): {
  valid: Buffer;
  invalid: Buffer;
} {
  let valid: Buffer | null = null;
  let invalid: Buffer | null = null;
  const errors: string[] = [];
  try {
    valid = readFileSync(VALID_FIXTURE_PATH);
  } catch (error) {
    errors.push(`${TRANSPLANT_VALID_FIXTURE}: ${String(error)}`);
  }
  try {
    invalid = readFileSync(INVALID_FIXTURE_PATH);
  } catch (error) {
    errors.push(`${TRANSPLANT_INVALID_FIXTURE}: ${String(error)}`);
  }
  if (!valid || !invalid) {
    throw new Error(`Bundled fixture read failed:\n${errors.join("\n")}`);
  }
  return { valid, invalid };
}

function emptyExecution(): TransplantExecutionEvidence {
  return {
    input: "",
    output: { algorithm: "", digest: "" },
    elapsedMs: 0,
  };
}

function emptyProbe(): TransplantIndependentProbeEvidence {
  return {
    schema: TRANSPLANT_PROBE_SCHEMA,
    nonce: process.env.OPENRAPPTER_TRANSPLANT_SCENARIO_NONCE ?? "unset",
    collections: {
      fixtures: false,
      process: false,
      gateway: false,
      agent: false,
      executions: false,
      rejection: false,
      flight: false,
      provider: false,
    },
    process: {
      pidBefore: process.pid,
      pidAfter: process.pid,
      gatewayReferenceStable: false,
      registryReferenceStable: false,
      registryConstructorCount: 1,
    },
    gateway: {
      serverClass: "",
      registryClass: "",
      authMode: "",
      authorizationScheme: "",
      unauthenticatedStatus: 0,
      unauthenticatedImporterCalls: 0,
      totalImporterCalls: 0,
      acceptedStatus: 0,
      rejectedStatus: 0,
      requestUrls: [],
    },
    fixtures: {
      validPath: TRANSPLANT_VALID_FIXTURE,
      invalidPath: TRANSPLANT_INVALID_FIXTURE,
      validSha256: ZERO_HASH,
      invalidSha256: ZERO_HASH,
      manifestValidSha256: null,
      manifestInvalidSha256: null,
    },
    agent: {
      className: "",
      bridgeModule: TRANSPLANT_PYTHON_BRIDGE_MODULE,
      sourceFile: "",
      sourceSha256Before: ZERO_HASH,
      sourceSha256After: ZERO_HASH,
      objectReferenceStable: false,
      registryReferenceStable: false,
    },
    executions: {
      first: emptyExecution(),
      second: emptyExecution(),
    },
    operationOrder: [],
    rejection: {
      rejectedBeforeCommit: false,
      committed: false,
      targetBytesUnchanged: false,
      targetStatUnchanged: false,
      candidateDiffersFromCommitted: false,
    },
    flight: {
      databasePath: "",
      exportPath: "",
      pathsDistinct: false,
      databaseSha256: ZERO_HASH,
      exportSha256: ZERO_HASH,
      expectedDatabaseSha256: ZERO_HASH,
      expectedExportSha256: ZERO_HASH,
      reopenedQuerySucceeded: false,
      productionValidationPassed: false,
      persistedEventIds: [],
      reopenedEventIds: [],
      productionExportEventIds: [],
      persistedContentHashes: [],
      reopenedContentHashes: [],
      productionExportContentHashes: [],
      allContentHashesValid: false,
      events: [],
      causalStepIds: [],
    },
    provider: {
      manifestModelDependency: "",
      providerEventCount: 0,
      modelEventCount: 0,
    },
  };
}

function scratchDirectory(): string {
  const configured = process.env.OPENRAPPTER_TRANSPLANT_PROBE_STATE_DIRECTORY;
  const base = configured
    ? path.resolve(configured)
    : path.join(
        TEST_ROOT,
        ".test-scratch",
        "live-organ-transplant-integration",
      );
  const allowed = path.join(TEST_ROOT, ".test-scratch");
  const relative = path.relative(allowed, base);
  if (
    relative === "" ||
    relative.startsWith("..") ||
    path.isAbsolute(relative)
  ) {
    throw new Error(
      `Probe state directory must be a child of ${allowed}; got ${base}`,
    );
  }
  mkdirSync(base, { recursive: true, mode: 0o700 });
  return mkdtempSync(path.join(base, "observer-"));
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

function findDigest(
  value: unknown,
  depth = 0,
): {
  algorithm: string;
  digest: string;
} | null {
  if (depth > 5) return null;
  if (typeof value === "string") {
    try {
      return findDigest(JSON.parse(value), depth + 1);
    } catch {
      return null;
    }
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.algorithm === "string" &&
    typeof record.digest === "string"
  ) {
    return { algorithm: record.algorithm, digest: record.digest };
  }
  for (const key of ["output", "result", "data"]) {
    const found = findDigest(record[key], depth + 1);
    if (found) return found;
  }
  return null;
}

async function executePythonAgent(
  agent: PythonAgent,
  input: string,
): Promise<TransplantExecutionEvidence> {
  const started = performance.now();
  const raw = await agent.execute({ query: input });
  const output = findDigest(raw);
  if (!output) {
    throw new Error(
      `PythonAgent result did not contain algorithm/digest: ${raw.slice(0, 300)}`,
    );
  }
  return {
    input,
    output,
    elapsedMs: Math.ceil(performance.now() - started),
  };
}

async function postImport(
  baseUrl: string,
  filename: string,
  contents: Buffer,
  token?: string,
): Promise<Response> {
  probe.gateway.requestUrls.push(`${baseUrl}/agents/import`);
  return fetch(`${baseUrl}/agents/import`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      filename,
      contents: contents.toString("utf8"),
    }),
  });
}

function ids(events: FlightEvent[]): string[] {
  return events.map((event) => event.id);
}

function hashes(events: FlightEvent[]): string[] {
  return events.map((event) => event.contentHash);
}

async function collectFlightEvidence(input: FlightProbeInput): Promise<void> {
  const databaseBytes = readFileSync(input.copiedDatabasePath);
  const exportBytes = readFileSync(input.copiedExportPath);
  const savedExport: unknown = JSON.parse(exportBytes.toString("utf8"));
  const reopened = new SQLiteFlightLedger({
    databasePath: input.copiedDatabasePath,
  });
  const validator = new SQLiteFlightLedger({ inMemory: true });
  let reopenedEvents: FlightEvent[] = [];
  let productionExport: FlightExport | null = null;
  let validatedEvents: FlightEvent[] = [];

  try {
    await reopened.initialize();
    reopenedEvents = await reopened.query({ limit: 10_000 });
    productionExport = await reopened.export();
    probe.flight.reopenedQuerySucceeded = true;

    await validator.initialize();
    const imported = await validator.import(savedExport as FlightExport);
    validatedEvents = await validator.query({ limit: 10_000 });
    probe.flight.productionValidationPassed =
      imported === validatedEvents.length;
  } finally {
    await Promise.all([reopened.close(), validator.close()]);
  }

  if (!productionExport) {
    throw new Error("Production ledger did not generate an export.");
  }
  const persisted = (savedExport as FlightExport).events;
  probe.flight = {
    databasePath: input.originalDatabasePath,
    exportPath: input.originalExportPath,
    pathsDistinct:
      path.resolve(input.originalDatabasePath) !==
        path.resolve(input.originalExportPath) &&
      path.resolve(input.copiedDatabasePath) !==
        path.resolve(input.copiedExportPath),
    databaseSha256: sha256(databaseBytes),
    exportSha256: sha256(exportBytes),
    expectedDatabaseSha256: input.databaseSha256,
    expectedExportSha256: input.exportSha256,
    reopenedQuerySucceeded: probe.flight.reopenedQuerySucceeded,
    productionValidationPassed:
      probe.flight.productionValidationPassed &&
      canonicalJson(validatedEvents) === canonicalJson(persisted),
    persistedEventIds: ids(persisted),
    reopenedEventIds: ids(reopenedEvents),
    productionExportEventIds: ids(productionExport.events),
    persistedContentHashes: hashes(persisted),
    reopenedContentHashes: hashes(reopenedEvents),
    productionExportContentHashes: hashes(productionExport.events),
    allContentHashesValid: [
      ...persisted,
      ...reopenedEvents,
      ...productionExport.events,
    ].every(verifyFlightEventHash),
    events: reopenedEvents,
    causalStepIds: [],
  };
  probe.provider.providerEventCount = reopenedEvents.filter(
    (event) =>
      event.providerId !== undefined || event.kind.startsWith("provider."),
  ).length;
  probe.provider.modelEventCount = reopenedEvents.filter(
    (event) => event.model !== undefined || event.kind.startsWith("model."),
  ).length;
  probe.collections.flight = true;
  probe.collections.provider = true;
}

beforeAll(async () => {
  const pidBefore = process.pid;
  let registryConstructorCount = 0;
  try {
    const manifest = loadManifest();
    const { valid: validFixture, invalid: invalidFixture } =
      readBundledFixtures();
    probe.fixtures = {
      validPath: TRANSPLANT_VALID_FIXTURE,
      invalidPath: TRANSPLANT_INVALID_FIXTURE,
      validSha256: sha256(validFixture),
      invalidSha256: sha256(invalidFixture),
      manifestValidSha256: manifest.fixture.sourceSha256,
      manifestInvalidSha256: manifest.fixture.invalidSourceSha256,
    };
    probe.provider.manifestModelDependency = manifest.dependencies.model;
    probe.collections.fixtures = true;

    stateDirectory = scratchDirectory();
    const builtinsDirectory = path.join(stateDirectory, "builtins");
    const agentsDirectory = path.join(stateDirectory, "agents");
    const gatewayDataDirectory = path.join(stateDirectory, "gateway");
    const flightDirectory = path.join(stateDirectory, "flight");
    mkdirSync(builtinsDirectory, { recursive: true, mode: 0o700 });
    mkdirSync(agentsDirectory, { recursive: true, mode: 0o700 });
    mkdirSync(gatewayDataDirectory, { recursive: true, mode: 0o700 });
    mkdirSync(flightDirectory, { recursive: true, mode: 0o700 });
    const databasePath = path.join(flightDirectory, "flight-recorder.db");
    const exportPath = path.join(flightDirectory, "flight-recorder.json");
    recorder = new FlightRecorder({
      databasePath,
      privacy: { recordIO: true },
    });
    await recorder.initialize();
    previousRecorder = setFlightRecorder(recorder);

    const registry = new AgentRegistry(builtinsDirectory, agentsDirectory);
    registryConstructorCount += 1;
    const heldRegistryReference = registry;
    const token = `transplant-${randomUUID()}`;
    gateway = new GatewayServer({
      port: 0,
      bind: "loopback",
      auth: { mode: "token", tokens: [token] },
      heartbeatInterval: 60_000,
      dataDir: gatewayDataDirectory,
    });
    const heldGatewayReference = gateway;
    let importerCalls = 0;
    const importerRegistryReferences: AgentRegistry[] = [];
    let traceContext: FlightTraceContext | undefined;
    gateway.setAgentFilesRoot(agentsDirectory);
    gateway.setAgentImporter(async (filename, contents) => {
      importerCalls += 1;
      importerRegistryReferences.push(registry);
      if (!traceContext || !recorder) {
        throw new Error("Probe importer requires the active causal trace.");
      }
      return recorder.withTraceContext(traceContext, () =>
        importAgentFile(filename, contents, registry, {
          dir: agentsDirectory,
        }),
      );
    });
    await gateway.start();
    const baseUrl = `http://127.0.0.1:${gateway.port}`;
    const traceId = `probe-transplant-${randomUUID()}`;

    await recorder.runTrace({ traceId }, async () => {
      traceContext = recorder?.currentTrace();
      if (!traceContext) {
        throw new Error("FlightRecorder did not expose the active trace.");
      }
      await recorder?.record({
        kind: "demo.transplant.started",
        source: "live-organ-transplant-independent-observer",
        status: "started",
        metadata: { nonce: probe.nonce },
      });

      const unauthenticated = await postImport(
        baseUrl,
        manifest.fixture.filename,
        validFixture,
      );
      probe.gateway.unauthenticatedStatus = unauthenticated.status;
      probe.gateway.unauthenticatedImporterCalls = importerCalls;
      await unauthenticated.arrayBuffer();

      const accepted = await postImport(
        baseUrl,
        manifest.fixture.filename,
        validFixture,
        token,
      );
      probe.gateway.acceptedStatus = accepted.status;
      await accepted.arrayBuffer();
      probe.operationOrder.push("valid-import");

      const resolved = await registry.getAgent(TRANSPLANT_AGENT_NAME);
      if (!(resolved instanceof PythonAgent)) {
        throw new Error(
          `Expected ${TRANSPLANT_AGENT_NAME} to resolve as PythonAgent; got ${resolved?.constructor.name ?? "missing"}.`,
        );
      }
      const heldAgentReference = resolved;
      const target = resolved.sourceFile;
      const sourceHashBefore = sha256(readFileSync(target));
      probe.agent = {
        className: resolved.constructor.name,
        bridgeModule: TRANSPLANT_PYTHON_BRIDGE_MODULE,
        sourceFile: target,
        sourceSha256Before: sourceHashBefore,
        sourceSha256After: sourceHashBefore,
        objectReferenceStable: false,
        registryReferenceStable: false,
      };
      probe.collections.agent = true;

      probe.executions.first = await executePythonAgent(
        heldAgentReference,
        manifest.input,
      );
      probe.operationOrder.push("first-execution");
      const targetStatBefore = statIdentity(target);

      const rejected = await postImport(
        baseUrl,
        manifest.fixture.filename,
        invalidFixture,
        token,
      );
      probe.gateway.rejectedStatus = rejected.status;
      await rejected.arrayBuffer();
      probe.operationOrder.push("invalid-import");

      probe.executions.second = await executePythonAgent(
        heldAgentReference,
        manifest.input,
      );
      probe.operationOrder.push("second-execution");
      probe.collections.executions = true;

      const afterAgent = await registry.getAgent(TRANSPLANT_AGENT_NAME);
      const sourceHashAfter = sha256(readFileSync(target));
      const targetStatAfter = statIdentity(target);
      const invalidHash = sha256(invalidFixture);
      const targetBytesUnchanged = sourceHashBefore === sourceHashAfter;
      const targetStatUnchanged = targetStatBefore === targetStatAfter;
      probe.agent.sourceSha256After = sourceHashAfter;
      probe.agent.objectReferenceStable = afterAgent === heldAgentReference;
      probe.agent.registryReferenceStable =
        heldRegistryReference === registry &&
        importerRegistryReferences.every((entry) => entry === registry);
      probe.rejection = {
        rejectedBeforeCommit:
          rejected.status === 400 &&
          targetBytesUnchanged &&
          targetStatUnchanged,
        committed: sourceHashAfter === invalidHash,
        targetBytesUnchanged,
        targetStatUnchanged,
        candidateDiffersFromCommitted: invalidHash !== sourceHashBefore,
      };
      probe.collections.rejection = true;
      probe.gateway.totalImporterCalls = importerCalls;

      await recorder?.record({
        kind: "demo.transplant.completed",
        source: "live-organ-transplant-independent-observer",
        status: "success",
        metadata: { nonce: probe.nonce },
      });
    });

    const flightExport = await recorder.export();
    if (!flightExport) {
      throw new Error("FlightRecorder did not produce the probe export.");
    }
    writeFileSync(exportPath, canonicalJson(flightExport), {
      encoding: "utf8",
      mode: 0o600,
    });
    setFlightRecorder(previousRecorder);
    previousRecorder = null;
    await recorder.close();
    recorder = null;

    probe.gateway = {
      ...probe.gateway,
      serverClass: gateway.constructor.name,
      registryClass: registry.constructor.name,
      authMode: "token",
      authorizationScheme: "Bearer",
      totalImporterCalls: importerCalls,
    };
    probe.collections.gateway = true;

    probe.process = {
      pidBefore,
      pidAfter: process.pid,
      gatewayReferenceStable: gateway === heldGatewayReference,
      registryReferenceStable: registry === heldRegistryReference,
      registryConstructorCount,
    };
    probe.collections.process = true;

    await collectFlightEvidence({
      originalDatabasePath: databasePath,
      originalExportPath: exportPath,
      copiedDatabasePath: databasePath,
      copiedExportPath: exportPath,
      databaseSha256: sha256(readFileSync(databasePath)),
      exportSha256: sha256(readFileSync(exportPath)),
    });
    const causal = evaluateTransplantCausalTrace(probe.flight.events, {
      traceId,
      nonce: probe.nonce,
      runtimePid: process.pid,
      validFixtureSha256: probe.fixtures.validSha256,
      invalidFixtureSha256: probe.fixtures.invalidSha256,
      agentName: TRANSPLANT_AGENT_NAME,
      digest: manifest.expectedSha256,
    });
    probe.flight.causalStepIds = causal.semanticStepIds;
  } catch (error) {
    setupError =
      error instanceof Error ? (error.stack ?? error.message) : String(error);
  }
});

afterAll(async () => {
  probe.process.pidAfter = process.pid;
  if (previousRecorder) {
    setFlightRecorder(previousRecorder);
    previousRecorder = null;
  }
  if (recorder) {
    await recorder.close();
    recorder = null;
  }
  if (gateway) {
    await gateway.stop();
    gateway = null;
  }
  const output = process.env.OPENRAPPTER_TRANSPLANT_PROBE_OUTPUT;
  if (output) {
    mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
    writeFileSync(output, `${canonicalJson(probe)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  }
  if (stateDirectory) {
    rmSync(stateDirectory, { recursive: true, force: true });
  }
});

function observed(): TransplantIndependentProbeEvidence {
  expect(setupError, setupError || "integration setup completed").toBe("");
  return probe;
}

describe("live organ transplant independent observer", () => {
  it("hashes both bundled fixtures before importing either one", () => {
    const evidence = observed();
    expect(evidence.collections.fixtures).toBe(true);
    expect(evidence.fixtures).toMatchObject({
      validPath: TRANSPLANT_VALID_FIXTURE,
      invalidPath: TRANSPLANT_INVALID_FIXTURE,
    });
    expect(evidence.fixtures.validSha256).toBe(
      evidence.fixtures.manifestValidSha256,
    );
    expect(evidence.fixtures.invalidSha256).toBe(
      evidence.fixtures.manifestInvalidSha256,
    );
    expect(evidence.fixtures.validSha256).not.toBe(
      evidence.fixtures.invalidSha256,
    );
  });

  it("keeps one real GatewayServer and one real AgentRegistry object in one host process", () => {
    const evidence = observed();
    expect(evidence.collections.process).toBe(true);
    expect(evidence.process).toMatchObject({
      pidAfter: evidence.process.pidBefore,
      gatewayReferenceStable: true,
      registryReferenceStable: true,
      registryConstructorCount: 1,
    });
    expect(evidence.gateway.serverClass).toBe(GatewayServer.name);
    expect(evidence.gateway.registryClass).toBe(AgentRegistry.name);
  });

  it("proves the bearer header gates the real HTTP importer", () => {
    const evidence = observed();
    expect(evidence.collections.gateway).toBe(true);
    expect(evidence.gateway).toMatchObject({
      authMode: "token",
      authorizationScheme: "Bearer",
      unauthenticatedStatus: 401,
      unauthenticatedImporterCalls: 0,
      totalImporterCalls: 2,
      acceptedStatus: 200,
      rejectedStatus: 400,
    });
  });

  it("resolves the imported object as the real PythonAgent bridge", () => {
    const evidence = observed();
    expect(evidence.collections.agent).toBe(true);
    expect(evidence.agent.className).toBe(PythonAgent.name);
    expect(evidence.agent.bridgeModule).toBe(TRANSPLANT_PYTHON_BRIDGE_MODULE);
    expect(path.basename(evidence.agent.sourceFile)).toBe("checksum_agent.py");
    expect(TRANSPLANT_GATEWAY_MODULE).toBe("typescript/dist/gateway/server.js");
  });

  it("executes the actual PythonAgent twice with the pinned digest", () => {
    const evidence = observed();
    const manifest = loadManifest();
    expect(evidence.collections.executions).toBe(true);
    expect(evidence.executions.first).toMatchObject({
      input: manifest.input,
      output: {
        algorithm: "sha256",
        digest: manifest.expectedSha256,
      },
    });
    expect(evidence.executions.second).toMatchObject({
      input: manifest.input,
      output: {
        algorithm: "sha256",
        digest: manifest.expectedSha256,
      },
    });
    expect(evidence.operationOrder).toEqual([
      "valid-import",
      "first-execution",
      "invalid-import",
      "second-execution",
    ]);
  });

  it("rejects the invalid replacement before committed bytes or live identity change", () => {
    const evidence = observed();
    expect(evidence.collections.rejection).toBe(true);
    expect(evidence.rejection).toEqual({
      rejectedBeforeCommit: true,
      committed: false,
      targetBytesUnchanged: true,
      targetStatUnchanged: true,
      candidateDiffersFromCommitted: true,
    });
    expect(evidence.agent).toMatchObject({
      sourceSha256After: evidence.agent.sourceSha256Before,
      objectReferenceStable: true,
      registryReferenceStable: true,
    });
  });

  it("reopens the database with the production ledger and exactly matches the production export", () => {
    const evidence = observed();
    const manifest = loadManifest();
    expect(evidence.collections.flight).toBe(true);
    expect(evidence.flight).toMatchObject({
      pathsDistinct: true,
      reopenedQuerySucceeded: true,
      productionValidationPassed: true,
      allContentHashesValid: true,
      databaseSha256: evidence.flight.expectedDatabaseSha256,
      exportSha256: evidence.flight.expectedExportSha256,
    });
    expect(evidence.flight.reopenedEventIds).toEqual(
      evidence.flight.persistedEventIds,
    );
    expect(evidence.flight.productionExportEventIds).toEqual(
      evidence.flight.persistedEventIds,
    );
    expect(evidence.flight.productionExportContentHashes).toEqual(
      evidence.flight.persistedContentHashes,
    );
    const causal = evaluateTransplantCausalTrace(evidence.flight.events, {
      traceId: evidence.flight.events[0]?.traceId ?? "",
      nonce: evidence.nonce,
      runtimePid: evidence.process.pidBefore,
      validFixtureSha256: evidence.fixtures.validSha256,
      invalidFixtureSha256: evidence.fixtures.invalidSha256,
      agentName: TRANSPLANT_AGENT_NAME,
      digest: manifest.expectedSha256,
    });
    expect(causal.failures).toEqual([]);
    expect(evidence.flight.causalStepIds).toEqual(
      REQUIRED_TRANSPLANT_CAUSAL_STEPS.map((step) => step.id),
    );
  });

  it("observes loopback gateway requests and no provider or model activity", () => {
    const evidence = observed();
    expect(evidence.collections.provider).toBe(true);
    expect(evidence.provider).toEqual({
      manifestModelDependency: "none",
      providerEventCount: 0,
      modelEventCount: 0,
    });
    expect(evidence.gateway.requestUrls).toHaveLength(3);
    for (const requestUrl of evidence.gateway.requestUrls) {
      const parsed = new URL(requestUrl);
      expect(parsed.protocol).toBe("http:");
      expect(parsed.hostname).toBe("127.0.0.1");
      expect(parsed.pathname).toBe("/agents/import");
    }
  });
});
