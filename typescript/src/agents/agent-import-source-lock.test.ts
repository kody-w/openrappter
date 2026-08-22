import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  canonicalAgentSourcePath,
  withAgentSourceReadLock,
  withAgentSourceWriteLock,
} from "./BasicAgent.js";
import { PythonAgent } from "./PythonAgent.js";

let dir = "";

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-source-lock-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("per-source read/write fencing", () => {
  it("collapses existing case aliases when the filesystem aliases them", async () => {
    const mixedCase = path.join(dir, "MiXeD_Source.py");
    const alternateCase = path.join(dir, "mixed_source.py");
    await fs.writeFile(mixedCase, "source", { mode: 0o600 });
    const aliases = await fs
      .lstat(alternateCase)
      .then(() => true)
      .catch(() => false);

    expect(
      canonicalAgentSourcePath(mixedCase) ===
        canonicalAgentSourcePath(alternateCase),
    ).toBe(aliases);

    let releaseFirst = (): void => {};
    let signalFirst = (): void => {};
    const firstEntered = new Promise<void>((resolve) => {
      signalFirst = resolve;
    });
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = withAgentSourceWriteLock(mixedCase, async () => {
      signalFirst();
      await firstGate;
      return "mixed complete";
    });
    await firstEntered;

    let alternateSettled = false;
    const alternate = withAgentSourceWriteLock(alternateCase, async () => {
      alternateSettled = true;
      return "alternate complete";
    });
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 50);
    });
    expect(alternateSettled).toBe(!aliases);

    releaseFirst();
    await expect(first).resolves.toBe("mixed complete");
    await expect(alternate).resolves.toBe("alternate complete");
  });

  it("collapses existing Unicode normalization aliases when the filesystem aliases them", async () => {
    const composed = path.join(dir, "Caf\u00e9_Source.py");
    const decomposed = path.join(dir, "Cafe\u0301_Source.py");
    await fs.writeFile(composed, "source", { mode: 0o600 });
    const aliases = await fs
      .lstat(decomposed)
      .then(() => true)
      .catch(() => false);

    expect(
      canonicalAgentSourcePath(composed) ===
        canonicalAgentSourcePath(decomposed),
    ).toBe(aliases);
  });

  it("does not serialize writers for different source paths", async () => {
    const firstSource = path.join(dir, "first_agent.py");
    const secondSource = path.join(dir, "second_agent.py");
    await Promise.all([
      fs.writeFile(firstSource, "first", { mode: 0o600 }),
      fs.writeFile(secondSource, "second", { mode: 0o600 }),
    ]);
    let releaseFirst = (): void => {};
    let signalFirst = (): void => {};
    const firstEntered = new Promise<void>((resolve) => {
      signalFirst = resolve;
    });
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = withAgentSourceWriteLock(firstSource, async () => {
      signalFirst();
      await firstGate;
      return "first complete";
    });

    await firstEntered;
    await expect(
      withAgentSourceWriteLock(secondSource, async () => "second complete"),
    ).resolves.toBe("second complete");
    releaseFirst();
    await expect(first).resolves.toBe("first complete");
  });

  it("releases read and write ownership when operations throw", async () => {
    const source = path.join(dir, "throwing_agent.py");
    await fs.writeFile(source, "source", { mode: 0o600 });

    await expect(
      withAgentSourceReadLock(source, async () => {
        throw new Error("reader failed");
      }),
    ).rejects.toThrow("reader failed");
    await expect(
      withAgentSourceWriteLock(source, async () => "writer acquired"),
    ).resolves.toBe("writer acquired");

    await expect(
      withAgentSourceWriteLock(source, async () => {
        throw new Error("writer failed");
      }),
    ).rejects.toThrow("writer failed");
    await expect(
      withAgentSourceReadLock(source, async () => "reader reacquired"),
    ).resolves.toBe("reader reacquired");
  });

  it("releases PythonAgent read ownership after subprocess timeout", async () => {
    const source = path.join(dir, "slow_agent.py");
    await fs.writeFile(
      source,
      `from agents.basic_agent import BasicAgent
import time

class SlowAgent(BasicAgent):
    def __init__(self):
        self.name = 'Slow'
        self.metadata = {
            "name": self.name,
            "description": "Sleeps past its execution timeout.",
            "parameters": {"type": "object", "properties": {}, "required": []}
        }
        super().__init__(name=self.name, metadata=self.metadata)

    def perform(self, **kwargs):
        time.sleep(5)
        return "too late"
`,
      { mode: 0o600 },
    );
    const agent = new PythonAgent(
      source,
      {
        name: "Slow",
        description: "Sleeps past its execution timeout.",
        parameters: { type: "object", properties: {}, required: [] },
      },
      { timeoutMs: 50 },
    );

    expect(await agent.perform({})).toContain("timed out");
    let timeout: NodeJS.Timeout | undefined;
    try {
      await expect(
        Promise.race([
          withAgentSourceWriteLock(source, async () => "writer acquired"),
          new Promise<string>((_resolve, reject) => {
            timeout = setTimeout(() => {
              reject(new Error("writer remained blocked after timeout"));
            }, 1_000);
          }),
        ]),
      ).resolves.toBe("writer acquired");
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }, 10_000);
});
