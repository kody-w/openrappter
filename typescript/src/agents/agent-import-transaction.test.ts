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
import { BasicAgent, canonicalAgentSourcePath } from "./BasicAgent.js";
import { importAgentFile, withAgentImportProvenance } from "./agent-import.js";

type ImportResultValue = Awaited<ReturnType<typeof importAgentFile>>;

let dir = "";
let registry: AgentRegistry;
let testRecorder: FlightRecorder;
let previousTestRecorder: FlightRecorder;

class ForeignSharedAgent extends BasicAgent {
  constructor() {
    super("Shared", {
      name: "Shared",
      description: "foreign built-in capability",
      parameters: { type: "object", properties: {}, required: [] },
    });
  }

  async perform(_kwargs: Record<string, unknown>): Promise<string> {
    return JSON.stringify({
      status: "success",
      result: "foreign object remained callable",
    });
  }
}

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

function sabotageBackupWhenLoadedAs(filename: string): string {
  return `
import os
if os.path.basename(__file__) == ${JSON.stringify(filename)}:
    parent = os.path.dirname(__file__)
    for entry in os.listdir(parent):
        if entry.startswith('.agent-import-') and entry.endswith('.backup'):
            backup = os.path.join(parent, entry)
            if os.path.isfile(backup):
                os.unlink(backup)
                os.mkdir(backup)
                with open(os.path.join(backup, 'keep'), 'w', encoding='utf-8') as marker:
                    marker.write('force deterministic backup failure')
`;
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

async function transactionArtifacts(directory = dir): Promise<string[]> {
  return (await fs.readdir(directory)).filter((entry) =>
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

function blockNextReload(
  targetRegistry: AgentRegistry,
  failure?: Error,
): {
  reached: Promise<void>;
  release: () => void;
  restore: () => void;
} {
  const originalReload = targetRegistry.reloadUserAgents.bind(targetRegistry);
  let signalReached = (): void => {};
  let release = (): void => {};
  const reached = new Promise<void>((resolve) => {
    signalReached = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  targetRegistry.reloadUserAgents = async () => {
    signalReached();
    await gate;
    if (failure) throw failure;
    return originalReload();
  };

  return {
    reached,
    release,
    restore: () => {
      targetRegistry.reloadUserAgents = originalReload;
    },
  };
}

function settleFlag(promise: Promise<unknown>): () => boolean {
  let settled = false;
  void promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  return () => settled;
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-import-transaction-"));
  registry = new AgentRegistry(path.join(dir, "__no_builtins__"), dir);
  testRecorder = new FlightRecorder({ enabled: true, inMemory: true });
  await testRecorder.initialize();
  previousTestRecorder = setFlightRecorder(testRecorder);
});

afterEach(async () => {
  setFlightRecorder(previousTestRecorder);
  await testRecorder.close();
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
      commitState: "not-committed",
      retrySafe: true,
      activeGeneration: "present",
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
      commitState: "restored",
      retrySafe: true,
      activeGeneration: "present",
      errorCode: "IMPORT_ACTIVATION_FAILED",
      activeSourceSha256: digest(original),
    });
    expect(await fs.readFile(target)).toEqual(original);
    expect(await registry.getAgent("Rollback")).toBe(held);
    expect(await held!.perform({})).toContain("generation one");
    expect(await transactionArtifacts()).toEqual([]);
  }, 15_000);

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
      commitState: "restored",
      retrySafe: true,
      activeGeneration: "absent",
      errorCode: "IMPORT_REGISTRY_VERIFICATION_FAILED",
    });
    expect(result.activeSourceSha256).toBeUndefined();
    await expect(
      fs.access(path.join(dir, "missing_agent.py")),
    ).rejects.toThrow();
    expect(await registry.getAgent("Missing")).toBeUndefined();
    expect(await transactionArtifacts()).toEqual([]);
  }, 15_000);

  it("uses immutable source markers for JavaScript same-file replacement", async () => {
    await fs.writeFile(path.join(dir, "package.json"), '{"type":"module"}\n', {
      mode: 0o600,
    });
    const target = path.join(dir, "factory_agent.js");
    await fs.writeFile(
      target,
      javascriptAgent("Factory", "factory version one"),
      { mode: 0o600 },
    );
    expect(await registry.reloadUserAgents()).toContain("Factory");
    const original = await registry.getAgent("Factory");
    expect(original).toBeDefined();
    expect(Object.getOwnPropertyDescriptor(original!, "sourceFile")).toEqual({
      value: canonicalAgentSourcePath(target),
      enumerable: false,
      writable: false,
      configurable: false,
    });

    const second = await importAgentFile(
      "factory_agent.js",
      javascriptAgent("Factory", "factory version two"),
      registry,
      { dir },
    );

    expect(second, second.error).toMatchObject({
      status: "ok",
      committed: true,
      replaced: true,
    });
    const active = await registry.getAgent("Factory");
    expect(active).not.toBe(original);
    expect(active?.metadata.description).toBe("factory version two");
    expect(await active!.perform({})).toContain("factory version two");
    expect(Object.getOwnPropertyDescriptor(active!, "sourceFile")).toEqual({
      value: canonicalAgentSourcePath(target),
      enumerable: false,
      writable: false,
      configurable: false,
    });
    expect(await transactionArtifacts()).toEqual([]);
  });

  it("rejects a dormant JavaScript file from taking over a foreign live name", async () => {
    await fs.writeFile(path.join(dir, "package.json"), '{"type":"module"}\n', {
      mode: 0o600,
    });
    const target = path.join(dir, "dormant_agent.js");
    const dormant = javascriptAgent("Shared", "dormant file generation");
    await fs.writeFile(target, dormant, { mode: 0o600 });
    const identityBefore = await statIdentity(target);
    const foreign = new ForeignSharedAgent();
    const live = await registry.getAllAgents();
    live.set("Shared", foreign);

    const result = await importAgentFile(
      "dormant_agent.js",
      javascriptAgent("Shared", "takeover candidate"),
      registry,
      { dir },
    );

    expect(result).toMatchObject({
      status: "error",
      committed: false,
      rejectedBeforeCommit: true,
      errorCode: "IMPORT_NAME_COLLISION",
    });
    expect(await fs.readFile(target)).toEqual(dormant);
    expect(await statIdentity(target)).toBe(identityBefore);
    expect(await registry.getAgent("Shared")).toBe(foreign);
    expect(await foreign.perform({})).toContain(
      "foreign object remained callable",
    );
    expect(
      Object.getOwnPropertyDescriptor(foreign, "sourceFile"),
    ).toBeUndefined();
    expect(await transactionArtifacts()).toEqual([]);
  });

  it("rejects a symlink target without touching the linked file", async () => {
    await registry.getAllAgents();
    const externalDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "agent-import-external-"),
    );
    const external = path.join(externalDir, "external.py");
    const externalBytes = Buffer.from("external bytes must stay unchanged\n");
    const target = path.join(dir, "linked_agent.py");
    await fs.writeFile(external, externalBytes, { mode: 0o600 });
    await fs.symlink(external, target);
    const externalIdentity = await statIdentity(external);

    try {
      const result = await importAgentFile(
        "linked_agent.py",
        pythonAgent("LinkedAgent", "Linked", "must not install"),
        registry,
        { dir },
      );

      expect(result).toMatchObject({
        status: "error",
        committed: false,
        rejectedBeforeCommit: true,
        commitState: "not-committed",
        retrySafe: true,
        activeGeneration: "absent",
        errorCode: "IMPORT_INVALID_TARGET_TYPE",
      });
      expect(result.activeSourceSha256).toBeUndefined();
      expect((await fs.lstat(target)).isSymbolicLink()).toBe(true);
      expect(await fs.readlink(target)).toBe(external);
      expect(await fs.readFile(external)).toEqual(externalBytes);
      expect(await statIdentity(external)).toBe(externalIdentity);
      expect(await registry.getAgent("Linked")).toBeUndefined();
      expect(await transactionArtifacts()).toEqual([]);
    } finally {
      await fs.rm(externalDir, { recursive: true, force: true });
    }
  });
});

describe("live reader fencing and gapless activation", () => {
  it("holds execution until a failed activation restores the old generation", async () => {
    const original = pythonAgent(
      "FenceAgent",
      "Fence",
      "stable generation before rollback",
    );
    await importAgentFile("fence_agent.py", original, registry, { dir });
    const held = await registry.getAgent("Fence");
    expect(held).toBeDefined();
    expect(await held!.perform({})).toContain(
      "stable generation before rollback",
    );

    const blocked = blockNextReload(
      registry,
      new Error("injected blocked activation failure"),
    );
    const candidate = pythonAgent(
      "FenceAgent",
      "Fence",
      "unactivated candidate must never execute",
    );
    const importing = importAgentFile("fence_agent.py", candidate, registry, {
      dir,
    });

    let execution: Promise<string> | undefined;
    try {
      await blocked.reached;
      expect(await fs.readFile(path.join(dir, "fence_agent.py"))).toEqual(
        candidate,
      );
      for (let attempt = 0; attempt < 20; attempt += 1) {
        expect(await registry.getAgent("Fence")).toBe(held);
      }
      execution = held!.perform({});
      const executionSettled = settleFlag(execution);
      await wait(500);
      expect(executionSettled()).toBe(false);
    } finally {
      blocked.release();
      blocked.restore();
    }

    const result = await importing;
    expect(result).toMatchObject({
      status: "error",
      committed: false,
      rejectedBeforeCommit: false,
      commitState: "restored",
      retrySafe: true,
      activeGeneration: "present",
      errorCode: "IMPORT_ACTIVATION_FAILED",
    });
    if (!execution) throw new Error("held execution was not started");
    const output = await execution;
    expect(output).toContain("stable generation before rollback");
    expect(output).not.toContain("unactivated candidate must never execute");
    expect(await registry.getAgent("Fence")).toBe(held);
    expect(await fs.readFile(path.join(dir, "fence_agent.py"))).toEqual(
      original,
    );
  }, 60_000);

  it("holds execution until a successful activation commits the new generation", async () => {
    await importAgentFile(
      "fence_success_agent.py",
      pythonAgent(
        "FenceSuccessAgent",
        "FenceSuccess",
        "generation before success",
      ),
      registry,
      { dir },
    );
    const held = await registry.getAgent("FenceSuccess");
    expect(held).toBeDefined();

    const blocked = blockNextReload(registry);
    const candidate = pythonAgent(
      "FenceSuccessAgent",
      "FenceSuccess",
      "committed generation after success",
    );
    const importing = importAgentFile(
      "fence_success_agent.py",
      candidate,
      registry,
      { dir },
    );

    let execution: Promise<string> | undefined;
    try {
      await blocked.reached;
      expect(
        await fs.readFile(path.join(dir, "fence_success_agent.py")),
      ).toEqual(candidate);
      for (let attempt = 0; attempt < 20; attempt += 1) {
        expect(await registry.getAgent("FenceSuccess")).toBe(held);
      }
      execution = held!.perform({});
      const executionSettled = settleFlag(execution);
      await wait(500);
      expect(executionSettled()).toBe(false);
    } finally {
      blocked.release();
      blocked.restore();
    }

    const result = await importing;
    expect(result).toMatchObject({
      status: "ok",
      committed: true,
      commitState: "committed",
      retrySafe: false,
      activeGeneration: "present",
    });
    if (!execution) throw new Error("held execution was not started");
    expect(await execution).toContain("committed generation after success");
    const active = await registry.getAgent("FenceSuccess");
    expect(active).toBeDefined();
    expect(active).not.toBe(held);
    expect(await active!.perform({})).toContain(
      "committed generation after success",
    );
  }, 60_000);
});

describe("explicit commit states", () => {
  it("reports committed success rather than retryable error when backup cleanup fails", async () => {
    const target = path.join(dir, "cleanup_state_agent.py");
    await importAgentFile(
      "cleanup_state_agent.py",
      pythonAgent(
        "CleanupStateAgent",
        "CleanupState",
        "generation before cleanup warning",
      ),
      registry,
      { dir },
    );
    const candidate = pythonAgent(
      "CleanupStateAgent",
      "CleanupState",
      "committed despite cleanup warning",
      sabotageBackupWhenLoadedAs("cleanup_state_agent.py"),
    );

    const result = await importAgentFile(
      "cleanup_state_agent.py",
      candidate,
      registry,
      { dir },
    );

    expect(result).toMatchObject({
      status: "ok",
      committed: true,
      commitState: "committed",
      retrySafe: false,
      activeGeneration: "present",
      errorCode: "IMPORT_POST_COMMIT_CLEANUP_FAILED",
      activeSourceSha256: digest(candidate),
    });
    expect(result.warning).toMatch(/do not retry/i);
    expect(await fs.readFile(target)).toEqual(candidate);
    expect(
      await (await registry.getAgent("CleanupState"))!.perform({}),
    ).toContain("committed despite cleanup warning");
    const artifacts = await transactionArtifacts();
    expect(artifacts.some((entry) => entry.endsWith(".backup"))).toBe(true);
    for (const artifact of artifacts) {
      await fs.rm(path.join(dir, artifact), { recursive: true, force: true });
    }
    expect(await transactionArtifacts()).toEqual([]);
  }, 60_000);

  it("marks a candidate committed and unsafe when disk rollback fails", async () => {
    await importAgentFile(
      "rollback_committed_agent.py",
      pythonAgent(
        "RollbackCommittedAgent",
        "RollbackCommitted",
        "generation before incomplete rollback",
      ),
      registry,
      { dir },
    );
    const candidate = pythonAgent(
      "RollbackCommittedAgent",
      "RollbackCommitted",
      "candidate left committed after rollback failure",
      sabotageBackupWhenLoadedAs("rollback_committed_agent.py"),
    );
    const originalReload = registry.reloadUserAgents.bind(registry);
    registry.reloadUserAgents = async () => {
      await originalReload();
      throw new Error("injected failure after candidate activation");
    };

    let result: ImportResultValue;
    try {
      result = await importAgentFile(
        "rollback_committed_agent.py",
        candidate,
        registry,
        { dir },
      );
    } finally {
      registry.reloadUserAgents = originalReload;
    }

    expect(result).toMatchObject({
      status: "error",
      committed: true,
      rejectedBeforeCommit: false,
      commitState: "unknown",
      retrySafe: false,
      activeGeneration: "present",
      errorCode: "IMPORT_ROLLBACK_FAILED",
      activeSourceSha256: digest(candidate),
    });
    expect(
      await fs.readFile(path.join(dir, "rollback_committed_agent.py")),
    ).toEqual(candidate);
    expect(
      await (await registry.getAgent("RollbackCommitted"))!.perform({}),
    ).toContain("candidate left committed after rollback failure");
    const artifacts = await transactionArtifacts();
    expect(artifacts.some((entry) => entry.endsWith(".backup"))).toBe(true);
    for (const artifact of artifacts) {
      await fs.rm(path.join(dir, artifact), { recursive: true, force: true });
    }
  }, 60_000);

  it("marks an incomplete rollback unknown and unsafe to retry", async () => {
    const original = pythonAgent(
      "UnknownStateAgent",
      "UnknownState",
      "known generation before rollback",
    );
    await importAgentFile("unknown_state_agent.py", original, registry, {
      dir,
    });
    const held = await registry.getAgent("UnknownState");
    const originalReload = registry.reloadUserAgents.bind(registry);
    const originalGetAll = registry.getAllAgents.bind(registry);
    let failRegistryReads = false;
    registry.reloadUserAgents = async () => {
      failRegistryReads = true;
      throw new Error("injected activation failure before rollback");
    };
    registry.getAllAgents = async () => {
      if (failRegistryReads) {
        throw new Error("injected registry snapshot restore failure");
      }
      return originalGetAll();
    };

    let result: ImportResultValue;
    try {
      result = await importAgentFile(
        "unknown_state_agent.py",
        pythonAgent(
          "UnknownStateAgent",
          "UnknownState",
          "candidate that must roll back",
        ),
        registry,
        { dir },
      );
    } finally {
      registry.reloadUserAgents = originalReload;
      registry.getAllAgents = originalGetAll;
    }

    expect(result).toMatchObject({
      status: "error",
      committed: false,
      rejectedBeforeCommit: false,
      commitState: "unknown",
      retrySafe: false,
      activeGeneration: "present",
      errorCode: "IMPORT_ROLLBACK_FAILED",
      activeSourceSha256: digest(original),
    });
    expect(await fs.readFile(path.join(dir, "unknown_state_agent.py"))).toEqual(
      original,
    );
    expect(await registry.getAgent("UnknownState")).toBe(held);
  }, 60_000);
});

describe("target and registry serialization", () => {
  it("keeps concurrent alternate-case imports coherent on either filesystem model", async () => {
    const mixedName = "MiXeD_Case_agent.py";
    const alternateName = mixedName.toLowerCase();
    const mixedPath = path.join(dir, mixedName);
    const alternatePath = path.join(dir, alternateName);
    await importAgentFile(
      mixedName,
      pythonAgent(
        "OriginalCaseAgent",
        "OriginalCase",
        "original mixed-case generation",
      ),
      registry,
      { dir },
    );
    const aliases = await fs
      .lstat(alternatePath)
      .then(() => true)
      .catch(() => false);
    expect(
      canonicalAgentSourcePath(mixedPath) ===
        canonicalAgentSourcePath(alternatePath),
    ).toBe(aliases);

    let ready = 0;
    let release = (): void => {};
    const together = new Promise<void>((resolve) => {
      release = resolve;
    });
    const concurrentImport = async (
      filename: string,
      className: string,
      agentName: string,
      description: string,
    ): Promise<ImportResultValue> => {
      ready += 1;
      if (ready === 2) release();
      await together;
      return importAgentFile(
        filename,
        pythonAgent(className, agentName, description),
        registry,
        { dir },
      );
    };
    const results = await Promise.all([
      concurrentImport(
        mixedName,
        "MixedUpperAgent",
        "MixedUpper",
        "mixed upper generation",
      ),
      concurrentImport(
        alternateName,
        "MixedLowerAgent",
        "MixedLower",
        "mixed lower generation",
      ),
    ]);
    expect(results.every((result) => result.status === "ok")).toBe(true);
    expect(await registry.getAgent("OriginalCase")).toBeUndefined();

    const upper = await registry.getAgent("MixedUpper");
    const lower = await registry.getAgent("MixedLower");
    if (aliases) {
      expect([upper, lower].filter(Boolean)).toHaveLength(1);
      const active = upper ?? lower;
      expect(await active!.perform({})).toMatch(
        /mixed (upper|lower) generation/,
      );
      expect(
        (await fs.readdir(dir)).filter(
          (entry) => entry.toLowerCase() === alternateName,
        ),
      ).toHaveLength(1);
    } else {
      expect(upper).toBeDefined();
      expect(lower).toBeDefined();
      expect(await upper!.perform({})).toContain("mixed upper generation");
      expect(await lower!.perform({})).toContain("mixed lower generation");
      expect(canonicalAgentSourcePath(mixedPath)).not.toBe(
        canonicalAgentSourcePath(alternatePath),
      );
    }
    expect(await transactionArtifacts()).toEqual([]);
  }, 60_000);

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

  it("admits at most one synchronized import of a shared capability", async () => {
    let ready = 0;
    let release = (): void => {};
    const together = new Promise<void>((resolve) => {
      release = resolve;
    });
    const synchronizedImport = async (
      filename: string,
      className: string,
      description: string,
    ): Promise<ImportResultValue> => {
      ready += 1;
      if (ready === 2) release();
      await together;
      return importAgentFile(
        filename,
        pythonAgent(className, "Shared", description),
        registry,
        { dir },
      );
    };

    const filenames = ["shared_a_agent.py", "shared_b_agent.py"];
    const descriptions = ["shared candidate A", "shared candidate B"];
    const originalReload = registry.reloadUserAgents.bind(registry);
    let reloadCalls = 0;
    let releaseActivation = (): void => {};
    // Without registry serialization, holding the first activation lets both
    // transactions pass their empty collision snapshots and reach reload.
    const activationGate = new Promise<void>((resolve) => {
      releaseActivation = resolve;
    });
    const gateTimeout = setTimeout(releaseActivation, 1_000);
    registry.reloadUserAgents = async () => {
      reloadCalls += 1;
      if (reloadCalls === 2) releaseActivation();
      await activationGate;
      return originalReload();
    };

    let results: ImportResultValue[] = [];
    try {
      results = await Promise.all([
        synchronizedImport(filenames[0], "SharedAAgent", descriptions[0]),
        synchronizedImport(filenames[1], "SharedBAgent", descriptions[1]),
      ]);
    } finally {
      clearTimeout(gateTimeout);
      releaseActivation();
      registry.reloadUserAgents = originalReload;
    }

    const winnerIndex = results.findIndex((result) => result.status === "ok");
    const losers = results.filter((result) => result.status === "error");
    expect(reloadCalls).toBe(1);
    expect(results.filter((result) => result.status === "ok")).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0]).toMatchObject({
      committed: false,
      rejectedBeforeCommit: true,
      errorCode: "IMPORT_NAME_COLLISION",
    });
    if (winnerIndex < 0) throw new Error("shared import had no winner");

    const active = await registry.getAgent("Shared");
    expect(active).toBeDefined();
    expect(await active!.perform({})).toContain(descriptions[winnerIndex]);
    await expect(
      fs.access(path.join(dir, filenames[winnerIndex])),
    ).resolves.toBeUndefined();
    await expect(
      fs.access(path.join(dir, filenames[1 - winnerIndex])),
    ).rejects.toThrow();
    expect(await registry.getAgent("Shared")).toBe(active);
    expect(await transactionArtifacts()).toEqual([]);
  }, 60_000);

  it("does not serialize transactions owned by distinct registries", async () => {
    const otherDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "agent-import-other-registry-"),
    );
    const otherRegistry = new AgentRegistry(
      path.join(otherDir, "__no_builtins__"),
      otherDir,
    );
    const marker = path.join(dir, "distinct-registries.log");

    try {
      const [first, second] = await Promise.all([
        importAgentFile(
          "shared_agent.py",
          timedPythonAgent({
            className: "RegistryOneAgent",
            agentName: "Shared",
            marker,
            token: "registry-one",
            delaySeconds: 0.5,
          }),
          registry,
          { dir },
        ),
        importAgentFile(
          "shared_agent.py",
          timedPythonAgent({
            className: "RegistryTwoAgent",
            agentName: "Shared",
            marker,
            token: "registry-two",
            delaySeconds: 0.5,
          }),
          otherRegistry,
          { dir: otherDir },
        ),
      ]);

      expect(first.status).toBe("ok");
      expect(second.status).toBe("ok");
      const intervals = await readIntervals(marker);
      const firstInterval = intervals.get("registry-one");
      const secondInterval = intervals.get("registry-two");
      expect(firstInterval).toBeDefined();
      expect(secondInterval).toBeDefined();
      expect(
        firstInterval!.start < secondInterval!.end &&
          secondInterval!.start < firstInterval!.end,
      ).toBe(true);
      expect(await (await registry.getAgent("Shared"))!.perform({})).toContain(
        "Shared timed candidate.",
      );
      expect(
        await (await otherRegistry.getAgent("Shared"))!.perform({}),
      ).toContain("Shared timed candidate.");
      expect(await transactionArtifacts()).toEqual([]);
      expect(await transactionArtifacts(otherDir)).toEqual([]);
    } finally {
      await fs.rm(otherDir, { recursive: true, force: true });
    }
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
      await recorder.runTrace({ traceId }, async () => {
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
        "agent.import.commit.started",
        "agent.import.completed",
        "agent.import.started",
        "agent.import.failed",
      ]);
      const [
        validStarted,
        validCommitStarted,
        validCompleted,
        invalidStarted,
        invalidFailed,
      ] = events;
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
          committed: true,
          activeGeneration: "present",
          commitState: "committed",
          retrySafe: false,
        },
      });
      expect(validCommitStarted).toMatchObject({
        parentId: validStarted!.id,
        status: "started",
        metadata: {
          requestId: validRequestId,
          candidateSourceSha256: digest(valid),
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
          activeGeneration: "present",
          commitState: "not-committed",
          retrySafe: true,
        },
      });
      expect(events.filter((event) => event.status === "error")).toHaveLength(
        1,
      );
      const serialized = JSON.stringify(events);
      expect(serialized).not.toContain("FLIGHT_SOURCE_LEAK_SENTINEL_9f630289");
      expect(serialized).not.toContain("class EventAgent");
      });
    } finally {
      setFlightRecorder(previousRecorder);
      await recorder.close();
    }
  });
});
