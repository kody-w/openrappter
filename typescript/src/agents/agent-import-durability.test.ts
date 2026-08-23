import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  FlightRecorder,
  setFlightRecorder,
} from "../flight-recorder/recorder.js";
import { AgentRegistry } from "./AgentRegistry.js";
import { importAgentFile } from "./agent-import.js";

let dir = "";
let registry: AgentRegistry;
let recorder: FlightRecorder;
let previousRecorder: FlightRecorder;

function pythonAgent(
  className: string,
  agentName: string,
  description: string,
): Buffer {
  return Buffer.from(`
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

function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function artifacts(): Promise<string[]> {
  return (await fs.readdir(dir)).filter((entry) =>
    entry.startsWith(".agent-import-"),
  );
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-import-durability-"));
  registry = new AgentRegistry(path.join(dir, "__no_builtins__"), dir);
  recorder = new FlightRecorder({
    enabled: true,
    inMemory: true,
    privacy: { recordIO: true },
  });
  await recorder.initialize();
  previousRecorder = setFlightRecorder(recorder);
});

afterEach(async () => {
  vi.restoreAllMocks();
  setFlightRecorder(previousRecorder);
  await recorder.close();
  await fs.rm(dir, { recursive: true, force: true });
});

describe("privileged import Flight durability", () => {
  it("does not create a stage, target, or registry entry without a durable start", async () => {
    const realRecord = recorder.record.bind(recorder);
    vi.spyOn(recorder, "record").mockImplementation(async (input) =>
      input.kind === "agent.import.started" ? null : realRecord(input),
    );
    const result = await importAgentFile(
      "no_start_agent.py",
      pythonAgent("NoStartAgent", "NoStart", "must never be inspected"),
      registry,
      { dir },
    );

    expect(result).toMatchObject({
      status: "error",
      committed: false,
      rejectedBeforeCommit: true,
      commitState: "not-committed",
      errorCode: "IMPORT_PROVENANCE_START_FAILED",
    });
    await expect(
      fs.access(path.join(dir, "no_start_agent.py")),
    ).rejects.toThrow();
    expect(await registry.getAgent("NoStart")).toBeUndefined();
    expect(await artifacts()).toEqual([]);
  });

  it("cleans private artifacts and preserves the old generation when commit evidence fails", async () => {
    const original = pythonAgent(
      "CommitBarrierAgent",
      "CommitBarrier",
      "generation before commit barrier",
    );
    await importAgentFile("commit_barrier_agent.py", original, registry, {
      dir,
    });
    const held = await registry.getAgent("CommitBarrier");
    const target = path.join(dir, "commit_barrier_agent.py");
    const realRecord = recorder.record.bind(recorder);
    vi.spyOn(recorder, "record").mockImplementation(async (input) =>
      input.kind === "agent.import.commit.started"
        ? null
        : realRecord(input),
    );

    const result = await importAgentFile(
      "commit_barrier_agent.py",
      pythonAgent(
        "CommitBarrierAgent",
        "CommitBarrier",
        "candidate must not commit",
      ),
      registry,
      { dir },
    );

    expect(result).toMatchObject({
      status: "error",
      committed: false,
      rejectedBeforeCommit: true,
      commitState: "not-committed",
      errorCode: "IMPORT_PROVENANCE_COMMIT_FAILED",
      activeSourceSha256: digest(original),
    });
    expect(await fs.readFile(target)).toEqual(original);
    expect(await registry.getAgent("CommitBarrier")).toBe(held);
    expect(await artifacts()).toEqual([]);
  }, 15_000);

  it("rolls activation back before reporting a terminal evidence failure", async () => {
    const original = pythonAgent(
      "TerminalBarrierAgent",
      "TerminalBarrier",
      "generation before terminal barrier",
    );
    await importAgentFile("terminal_barrier_agent.py", original, registry, {
      dir,
    });
    const held = await registry.getAgent("TerminalBarrier");
    const target = path.join(dir, "terminal_barrier_agent.py");
    const realRecord = recorder.record.bind(recorder);
    let failCompleted = true;
    vi.spyOn(recorder, "record").mockImplementation(async (input) => {
      if (input.kind === "agent.import.completed" && failCompleted) {
        failCompleted = false;
        return null;
      }
      return realRecord(input);
    });

    const result = await importAgentFile(
      "terminal_barrier_agent.py",
      pythonAgent(
        "TerminalBarrierAgent",
        "TerminalBarrier",
        "candidate reached activation",
      ),
      registry,
      { dir },
    );

    expect(result).toMatchObject({
      status: "error",
      committed: false,
      rejectedBeforeCommit: false,
      commitState: "restored",
      retrySafe: true,
      errorCode: "IMPORT_PROVENANCE_TERMINAL_FAILED",
      activeSourceSha256: digest(original),
    });
    expect(await fs.readFile(target)).toEqual(original);
    expect(await registry.getAgent("TerminalBarrier")).toBe(held);
    const events = await recorder.query({ source: "agent-import" });
    expect(events.filter((event) =>
      event.kind === "agent.import.completed",
    )).toHaveLength(1);
    expect([...events].reverse().find((event) =>
      event.kind === "agent.import.failed",
    )).toMatchObject({
      metadata: {
        activeSourceSha256: digest(original),
        commitState: "restored",
        errorCode: "IMPORT_PROVENANCE_TERMINAL_FAILED",
      },
    });
    expect(await artifacts()).toEqual([]);
  }, 15_000);

  it("restores an independent snapshot when an old-inode writer races failed activation", async () => {
    const original = pythonAgent(
      "OldInodeAgent",
      "OldInode",
      "independent snapshot generation",
    );
    await importAgentFile("old_inode_agent.py", original, registry, { dir });
    const target = path.join(dir, "old_inode_agent.py");
    const held = await registry.getAgent("OldInode");
    const oldInode = await fs.open(target, "r+");
    const originalReload = registry.reloadUserAgents.bind(registry);
    registry.reloadUserAgents = async () => {
      await oldInode.write(
        Buffer.from("CONCURRENT_OLD_INODE_WRITER"),
        0,
        "CONCURRENT_OLD_INODE_WRITER".length,
        0,
      );
      await oldInode.sync();
      throw new Error("activation failed after old inode mutation");
    };

    let result;
    try {
      result = await importAgentFile(
        "old_inode_agent.py",
        pythonAgent("OldInodeAgent", "OldInode", "candidate generation"),
        registry,
        { dir },
      );
    } finally {
      registry.reloadUserAgents = originalReload;
      await oldInode.close();
    }

    expect(result).toMatchObject({
      status: "error",
      committed: false,
      commitState: "restored",
      retrySafe: true,
      activeSourceSha256: digest(original),
    });
    expect(await fs.readFile(target)).toEqual(original);
    expect(await registry.getAgent("OldInode")).toBe(held);
    const failed = (await recorder.query({
      source: "agent-import",
      kind: "agent.import.failed",
      order: "desc",
      limit: 1,
    }))[0];
    expect(failed).toMatchObject({
      metadata: {
        committed: false,
        activeSourceSha256: digest(original),
        activeGeneration: "present",
        commitState: "restored",
      },
    });
    expect(await artifacts()).toEqual([]);
  }, 15_000);
});
