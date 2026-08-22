import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  FlightRecorder,
  setFlightRecorder,
} from "../flight-recorder/recorder.js";
import { AgentRegistry } from "./AgentRegistry.js";
import { importAgentFile, withAgentImportProvenance } from "./agent-import.js";

type ImportResultValue = Awaited<ReturnType<typeof importAgentFile>>;

let dir = "";
let registry: AgentRegistry;

function pythonAgent(
  className: string,
  agentName: string,
  description: string,
  preamble = "",
): Buffer {
  return Buffer.from(`${preamble}
from agents.basic_agent import BasicAgent
import json

class ${className}(BasicAgent):
    def __init__(self):
        self.name = ${JSON.stringify(agentName)}
        self.metadata = {
            "name": self.name,
            "description": ${JSON.stringify(description)},
            "parameters": {"type": "object", "properties": {}, "required": []}
        }
        super().__init__(name=self.name, metadata=self.metadata)

    def perform(self, **kwargs):
        return json.dumps({"status": "success", "result": ${JSON.stringify(description)}})
`);
}

function javascriptAgent(agentName: string, description: string): Buffer {
  return Buffer.from(`
export function createAgent(BasicAgent) {
  return class ImportedAgent extends BasicAgent {
    constructor() {
      super(${JSON.stringify(agentName)}, {
        name: ${JSON.stringify(agentName)},
        description: ${JSON.stringify(description)},
        parameters: { type: 'object', properties: {}, required: [] }
      });
    }

    async perform() {
      return JSON.stringify({ status: 'success', result: ${JSON.stringify(description)} });
    }
  };
}
`);
}

function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function statIdentity(file: string): Promise<string> {
  const stat = await fs.stat(file, { bigint: true });
  return [
    stat.dev,
    stat.ino,
    stat.mode,
    stat.size,
    stat.mtimeNs,
    stat.ctimeNs,
  ].join(":");
}

async function transactionArtifacts(): Promise<string[]> {
  return (await fs.readdir(dir)).filter((entry) =>
    entry.startsWith(".agent-import-"),
  );
}

function timedPythonAgent(options: {
  className: string;
  agentName: string;
  marker: string;
  token: string;
  delaySeconds?: number;
}): Buffer {
  const delay = options.delaySeconds ?? 0.35;
  const preamble = `
import time
if str(__file__).endswith('.py.stage'):
    with open(${JSON.stringify(options.marker)}, 'a', encoding='utf-8') as marker:
        marker.write(${JSON.stringify(`${options.token}|start|`)} + str(time.time_ns()) + '\\n')
        marker.flush()
    time.sleep(${delay})
    with open(${JSON.stringify(options.marker)}, 'a', encoding='utf-8') as marker:
        marker.write(${JSON.stringify(`${options.token}|end|`)} + str(time.time_ns()) + '\\n')
        marker.flush()
`;
  return pythonAgent(
    options.className,
    options.agentName,
    `${options.agentName} timed candidate.`,
    preamble,
  );
}

async function readIntervals(
  marker: string,
): Promise<Map<string, { start: bigint; end: bigint }>> {
  const intervals = new Map<string, { start?: bigint; end?: bigint }>();
  const lines = (await fs.readFile(marker, "utf8")).trim().split("\n");
  for (const line of lines) {
    const [token, phase, rawTimestamp] = line.split("|");
    if (!token || !phase || !rawTimestamp) continue;
    const interval = intervals.get(token) ?? {};
    if (phase === "start") interval.start = BigInt(rawTimestamp);
    if (phase === "end") interval.end = BigInt(rawTimestamp);
    intervals.set(token, interval);
  }

  const complete = new Map<string, { start: bigint; end: bigint }>();
  for (const [token, interval] of intervals) {
    if (interval.start !== undefined && interval.end !== undefined) {
      complete.set(token, {
        start: interval.start,
        end: interval.end,
      });
    }
  }
  return complete;
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-import-transaction-"));
  registry = new AgentRegistry(path.join(dir, "__no_builtins__"), dir);
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("transactional replacement", () => {
  it("rejects before touching target identity or its held live object", async () => {
    const original = pythonAgent(
      "StableAgent",
      "Stable",
      "original generation",
    );
    const installed = await importAgentFile(
      "stable_agent.py",
      original,
      registry,
      { dir },
    );
    expect(installed.status).toBe("ok");

    const target = path.join(dir, "stable_agent.py");
    const identityBefore = await statIdentity(target);
    const held = await registry.getAgent("Stable");
    expect(held).toBeDefined();

    const invalid = Buffer.from(
      "FLAGSHIP_REJECTED_SOURCE_MUST_NEVER_APPEAR_IN_FLIGHT = (\n",
    );
    const result = await importAgentFile("stable_agent.py", invalid, registry, {
      dir,
    });

    expect(result).toMatchObject({
      status: "error",
      committed: false,
      rejectedBeforeCommit: true,
      candidateSourceSha256: digest(invalid),
      activeSourceSha256: digest(original),
      errorCode: "IMPORT_CANDIDATE_INVALID",
    });
    expect(await statIdentity(target)).toBe(identityBefore);
    expect(await fs.readFile(target)).toEqual(original);
    expect(await registry.getAgent("Stable")).toBe(held);
    expect(await held!.perform({})).toContain("original generation");
    expect(await transactionArtifacts()).toEqual([]);
  }, 15_000);

  it("atomically restores disk and the exact registry generation when activation throws", async () => {
    const original = pythonAgent("RollbackAgent", "Rollback", "generation one");
    await importAgentFile("rollback_agent.py", original, registry, { dir });
    const target = path.join(dir, "rollback_agent.py");
    const held = await registry.getAgent("Rollback");
    const originalReload = registry.reloadUserAgents.bind(registry);
    registry.reloadUserAgents = async () => {
      throw new Error("injected activation failure");
    };

    let result: ImportResultValue;
    try {
      result = await importAgentFile(
        "rollback_agent.py",
        pythonAgent("RollbackAgent", "Rollback", "generation two"),
        registry,
        { dir },
      );
    } finally {
      registry.reloadUserAgents = originalReload;
    }

    expect(result).toMatchObject({
      status: "error",
      committed: false,
      rejectedBeforeCommit: false,
      errorCode: "IMPORT_ACTIVATION_FAILED",
      activeSourceSha256: digest(original),
    });
    expect(await fs.readFile(target)).toEqual(original);
    expect(await registry.getAgent("Rollback")).toBe(held);
    expect(await held!.perform({})).toContain("generation one");
    expect(await transactionArtifacts()).toEqual([]);
  });

  it("rolls a new install back when registry verification cannot find it", async () => {
    const originalReload = registry.reloadUserAgents.bind(registry);
    registry.reloadUserAgents = async () => [];
    let result: ImportResultValue;
    try {
      result = await importAgentFile(
        "missing_agent.py",
        pythonAgent("MissingAgent", "Missing", "must be verified"),
        registry,
        { dir },
      );
    } finally {
      registry.reloadUserAgents = originalReload;
    }

    expect(result).toMatchObject({
      status: "error",
      committed: false,
      rejectedBeforeCommit: false,
      errorCode: "IMPORT_REGISTRY_VERIFICATION_FAILED",
    });
    await expect(
      fs.access(path.join(dir, "missing_agent.py")),
    ).rejects.toThrow();
    expect(await registry.getAgent("Missing")).toBeUndefined();
    expect(await transactionArtifacts()).toEqual([]);
  });

  it("keeps JavaScript factory imports loadable across same-file replacement", async () => {
    await fs.writeFile(path.join(dir, "package.json"), '{"type":"module"}\n', {
      mode: 0o600,
    });
    const first = await importAgentFile(
      "factory_agent.js",
      javascriptAgent("Factory", "factory version one"),
      registry,
      { dir },
    );
    const second = await importAgentFile(
      "factory_agent.js",
      javascriptAgent("Factory", "factory version two"),
      registry,
      { dir },
    );

    expect(first).toMatchObject({ status: "ok", committed: true });
    expect(second, second.error).toMatchObject({
      status: "ok",
      committed: true,
      replaced: true,
    });
    const active = await registry.getAgent("Factory");
    expect(active?.metadata.description).toBe("factory version two");
    expect(await active!.perform({})).toContain("factory version two");
    expect(await transactionArtifacts()).toEqual([]);
  });
});

describe("per-target serialization", () => {
  it("does not overlap candidate validation for one resolved target", async () => {
    const marker = path.join(dir, "same-target.log");
    const [first, second] = await Promise.all([
      importAgentFile(
        "serialized_agent.py",
        timedPythonAgent({
          className: "SerializedAgent",
          agentName: "Serialized",
          marker,
          token: "first",
        }),
        registry,
        { dir },
      ),
      importAgentFile(
        "serialized_agent.py",
        timedPythonAgent({
          className: "SerializedAgent",
          agentName: "Serialized",
          marker,
          token: "second",
        }),
        registry,
        { dir },
      ),
    ]);

    expect(first.status).toBe("ok");
    expect(second.status).toBe("ok");
    const intervals = await readIntervals(marker);
    const a = intervals.get("first");
    const b = intervals.get("second");
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(a!.end <= b!.start || b!.end <= a!.start).toBe(true);
    expect(await transactionArtifacts()).toEqual([]);
  }, 60_000);

  it("allows validation for distinct resolved targets to overlap", async () => {
    const marker = path.join(dir, "distinct-targets.log");
    const [first, second] = await Promise.all([
      importAgentFile(
        "parallel_a_agent.py",
        timedPythonAgent({
          className: "ParallelAAgent",
          agentName: "ParallelA",
          marker,
          token: "a",
          delaySeconds: 0.5,
        }),
        registry,
        { dir },
      ),
      importAgentFile(
        "parallel_b_agent.py",
        timedPythonAgent({
          className: "ParallelBAgent",
          agentName: "ParallelB",
          marker,
          token: "b",
          delaySeconds: 0.5,
        }),
        registry,
        { dir },
      ),
    ]);

    expect(first.status).toBe("ok");
    expect(second.status).toBe("ok");
    const intervals = await readIntervals(marker);
    const a = intervals.get("a");
    const b = intervals.get("b");
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(a!.start < b!.end && b!.start < a!.end).toBe(true);
    expect(await transactionArtifacts()).toEqual([]);
  }, 60_000);
});

describe("private staging", () => {
  it.skipIf(process.platform === "win32")(
    "uses mode 0600 even under a permissive process umask",
    async () => {
      const marker = path.join(dir, "stage-mode.txt");
      const preamble = `
import os
if str(__file__).endswith('.py.stage'):
    with open(${JSON.stringify(marker)}, 'w', encoding='utf-8') as marker:
        marker.write(oct(os.stat(__file__).st_mode & 0o777))
`;
      const previousUmask = process.umask(0o000);
      let result: ImportResultValue;
      try {
        result = await importAgentFile(
          "private_agent.py",
          pythonAgent("PrivateAgent", "Private", "private stage", preamble),
          registry,
          { dir },
        );
      } finally {
        process.umask(previousUmask);
      }

      expect(result.status).toBe("ok");
      expect(await fs.readFile(marker, "utf8")).toBe("0o600");
      expect(await transactionArtifacts()).toEqual([]);
    },
  );
});

describe("causal import events", () => {
  it("parents request-scoped hashes without ever recording source bytes", async () => {
    const recorder = new FlightRecorder({
      inMemory: true,
      privacy: { recordIO: true },
    });
    await recorder.initialize();
    const previousRecorder = setFlightRecorder(recorder);
    const traceId = `agent-import-${randomUUID()}`;
    const nonce = `nonce-${randomUUID()}`;
    const validRequestId = `valid-${randomUUID()}`;
    const invalidRequestId = `invalid-${randomUUID()}`;
    const valid = pythonAgent(
      "EventAgent",
      "EventCapability",
      "event generation",
    );
    const invalid = Buffer.from("FLIGHT_SOURCE_LEAK_SENTINEL_9f630289 = (\n");

    try {
      const validParent = await recorder.record({
        kind: "gateway.agent.import.started",
        source: "gateway",
        status: "started",
        traceId,
      });
      expect(validParent).not.toBeNull();
      const accepted = await withAgentImportProvenance(
        {
          traceId,
          scenarioNonce: nonce,
          requestId: validRequestId,
          candidateSourceSha256: digest(valid),
          gatewayParentEventId: validParent!.id,
        },
        () => importAgentFile("event_agent.py", valid, registry, { dir }),
      );
      expect(accepted.status).toBe("ok");

      const invalidParent = await recorder.record({
        kind: "gateway.agent.import.started",
        source: "gateway",
        status: "started",
        traceId,
      });
      expect(invalidParent).not.toBeNull();
      const rejected = await withAgentImportProvenance(
        {
          traceId,
          scenarioNonce: nonce,
          requestId: invalidRequestId,
          candidateSourceSha256: digest(invalid),
          gatewayParentEventId: invalidParent!.id,
        },
        () => importAgentFile("event_agent.py", invalid, registry, { dir }),
      );
      expect(rejected.status).toBe("error");

      const events = await recorder.query({
        traceId,
        source: "agent-import",
        order: "asc",
      });
      expect(events.map((event) => event.kind)).toEqual([
        "agent.import.started",
        "agent.import.completed",
        "agent.import.started",
        "agent.import.failed",
      ]);
      const [validStarted, validCompleted, invalidStarted, invalidFailed] =
        events;
      expect(validStarted).toMatchObject({
        parentId: validParent!.id,
        status: "started",
        metadata: {
          requestId: validRequestId,
          nonce,
          filename: "event_agent.py",
          candidateSourceSha256: digest(valid),
        },
      });
      expect(validCompleted).toMatchObject({
        parentId: validStarted!.id,
        status: "success",
        agentName: "EventCapability",
        metadata: {
          requestId: validRequestId,
          candidateSourceSha256: digest(valid),
          activeSourceSha256: digest(valid),
          bridgeClass: "PythonAgent",
        },
      });
      expect(invalidStarted).toMatchObject({
        parentId: invalidParent!.id,
        status: "started",
        metadata: {
          requestId: invalidRequestId,
          nonce,
          filename: "event_agent.py",
          candidateSourceSha256: digest(invalid),
        },
      });
      expect(invalidFailed).toMatchObject({
        parentId: invalidStarted!.id,
        status: "error",
        agentName: "EventCapability",
        metadata: {
          requestId: invalidRequestId,
          candidateSourceSha256: digest(invalid),
          activeSourceSha256: digest(valid),
          rejectedBeforeCommit: true,
        },
      });
      expect(events.filter((event) => event.status === "error")).toHaveLength(
        1,
      );
      const serialized = JSON.stringify(events);
      expect(serialized).not.toContain("FLIGHT_SOURCE_LEAK_SENTINEL_9f630289");
      expect(serialized).not.toContain("class EventAgent");
    } finally {
      setFlightRecorder(previousRecorder);
      await recorder.close();
    }
  });
});
