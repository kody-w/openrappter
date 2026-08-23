import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  FlightRecorder,
  setFlightRecorder,
} from "../flight-recorder/recorder.js";
import { AgentRegistry } from "./AgentRegistry.js";
import { importAgentFile } from "./agent-import.js";

const closeables: FlightRecorder[] = [];
const directories: string[] = [];

function pythonAgent(name: string): Buffer {
  return Buffer.from(`
from agents.basic_agent import BasicAgent
import json

class ${name}Agent(BasicAgent):
    def __init__(self):
        self.name = ${JSON.stringify(name)}
        self.metadata = {
            "name": self.name,
            "description": "standalone lifecycle test",
            "parameters": {"type": "object", "properties": {}, "required": []}
        }
        super().__init__(name=self.name, metadata=self.metadata)

    def perform(self, **kwargs):
        return json.dumps({"status": "success", "result": "ok"})
`);
}

async function setup(retentionEvents: number): Promise<{
  dir: string;
  recorder: FlightRecorder;
  registry: AgentRegistry;
  restore: () => void;
}> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "import-lifecycle-"));
  directories.push(dir);
  const recorder = new FlightRecorder({
    enabled: true,
    inMemory: true,
    retentionEvents,
  });
  closeables.push(recorder);
  await recorder.initialize();
  const previous = setFlightRecorder(recorder);
  return {
    dir,
    recorder,
    registry: new AgentRegistry(path.join(dir, "__no_builtins__"), dir),
    restore: () => setFlightRecorder(previous),
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(closeables.splice(0).map((recorder) => recorder.close()));
  await Promise.all(
    directories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe.each([0, 1])(
  "standalone import lifecycle at retention %i",
  (retentionEvents) => {
    it("retains one complete start, commit, and terminal trace", async () => {
      const { dir, recorder, registry, restore } =
        await setup(retentionEvents);
      try {
        const result = await importAgentFile(
          "standalone_agent.py",
          pythonAgent("Standalone"),
          registry,
          { dir },
        );
        expect(result.status).toBe("ok");

        const events = await recorder.query({ order: "asc" });
        expect(new Set(events.map((event) => event.traceId)).size).toBe(1);
        expect(events.map((event) => event.kind)).toEqual([
          "trace.started",
          "agent.import.started",
          "agent.import.commit.started",
          "agent.import.completed",
          "trace.completed",
        ]);
        expect(events[0]).toMatchObject({
          metadata: {
            retentionProtected: true,
          },
        });
      } finally {
        restore();
      }
    }, 15_000);
  },
);

it("does not create import side effects when a lifecycle pin cannot be established", async () => {
  const { dir, recorder, registry, restore } = await setup(0);
  const realRecord = recorder.record.bind(recorder);
  vi.spyOn(recorder, "record").mockImplementation(async (input) =>
    input.kind === "trace.started" ? null : realRecord(input),
  );
  try {
    const result = await importAgentFile(
      "no_pin_agent.py",
      pythonAgent("NoPin"),
      registry,
      { dir },
    );
    expect(result).toMatchObject({
      status: "error",
      committed: false,
      rejectedBeforeCommit: true,
      errorCode: "IMPORT_LIFECYCLE_PIN_FAILED",
    });
    await expect(fs.access(path.join(dir, "no_pin_agent.py"))).rejects.toThrow();
    expect(await registry.getAgent("NoPin")).toBeUndefined();
    expect(
      (await fs.readdir(dir)).filter((entry) =>
        entry.startsWith(".agent-import-"),
      ),
    ).toEqual([]);
  } finally {
    restore();
  }
});

it("bounds retained protected traces across repeated failed standalone imports", async () => {
  const { dir, recorder, registry, restore } = await setup(0);
  try {
    for (let index = 0; index < 20; index += 1) {
      const result = await importAgentFile(
        `failed_${index}_agent.py`,
        Buffer.from("class Broken(\n"),
        registry,
        { dir },
      );
      expect(result.status).toBe("error");
    }

    const events = await recorder.query();
    expect(new Set(events.map((event) => event.traceId)).size).toBe(1);
    expect(events.map((event) => event.kind)).toEqual([
      "trace.started",
      "agent.import.started",
      "agent.import.failed",
      "trace.completed",
    ]);
    expect((await recorder.health()).eventCount).toBe(4);
  } finally {
    restore();
  }
}, 30_000);
