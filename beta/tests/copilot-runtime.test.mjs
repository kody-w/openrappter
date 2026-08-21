import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CopilotRuntime,
  copilotPackageName,
  readGitHubTokenFile,
  withTimeout,
} from "../electron/copilot-runtime.mjs";

test("Copilot package selection follows platform and architecture", () => {
  assert.equal(
    copilotPackageName("darwin", "arm64"),
    "@github/copilot-darwin-arm64",
  );
  assert.equal(
    copilotPackageName("win32", "x64"),
    "@github/copilot-win32-x64",
  );
  assert.equal(
    copilotPackageName("linux", "x64"),
    "@github/copilot-linux-x64",
  );
});

test("Copilot startup timeout rejects a hung runtime", async () => {
  await assert.rejects(
    withTimeout(new Promise(() => {}), "test runtime", 5),
    /test runtime did not start within 5ms/,
  );
});

test("Copilot startup timeout preserves successful results", async () => {
  assert.equal(await withTimeout(Promise.resolve("ready"), "test runtime", 50), "ready");
});

test("Copilot runtime reads the protected Brainstem device token", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "brainstem-token-"));
  const tokenFile = path.join(directory, ".copilot_token");
  try {
    writeFileSync(tokenFile, JSON.stringify({
      access_token: "ghu_example",
      refresh_token: "hidden",
    }));
    assert.equal(readGitHubTokenFile(tokenFile), "ghu_example");
    writeFileSync(tokenFile, "{not json");
    assert.equal(readGitHubTokenFile(tokenFile), null);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Copilot runtime loads the scripted fake Surgeon client", async (t) => {
  const runtime = new CopilotRuntime({
    env: {
      BRAINSTEM_BETA_SURGEON_RUNTIME: "fake",
      BRAINSTEM_BETA_SURGEON_SCRIPT_JSON: JSON.stringify({
        sessions: [{
          match: { prompt: "delegate" },
          turns: [
            {
              tool: {
                name: "delegate_to_brainstem",
                arguments: { prompt: "hello from fake" },
              },
            },
            { final: "delegation complete" },
          ],
        }],
      }),
    },
  });
  t.after(() => runtime.stop());

  const status = await runtime.start();
  assert.deepEqual(status, {
    available: true,
    authenticated: true,
    login: "frontier-e2e",
    cliPath: null,
  });

  const events = [];
  const calls = [];
  const session = await runtime.createSession({
    tools: [{
      name: "delegate_to_brainstem",
      handler: async (args) => {
        calls.push(args);
        return "ok";
      },
    }],
  });
  session.on((event) => events.push(event.type));
  const response = await session.sendAndWait({ prompt: "delegate" });
  assert.equal(response.data.content, "delegation complete");
  assert.deepEqual(calls, [{ prompt: "hello from fake" }]);
  assert.deepEqual(events, [
    "tool.execution_start",
    "tool.execution_complete",
  ]);
});

test("fake Surgeon concurrent mode starts both tool calls before completing", async (t) => {
  const runtime = new CopilotRuntime({
    env: {
      BRAINSTEM_BETA_SURGEON_RUNTIME: "fake",
      BRAINSTEM_BETA_SURGEON_SCRIPT_JSON: JSON.stringify({
        mode: "concurrent",
        concurrency: 2,
        sessions: [
          {
            match: { prompt: "first" },
            turns: [
              { tool: { name: "delegate", arguments: { marker: "first" } } },
              { final: "first reply" },
            ],
          },
          {
            match: { prompt: "second" },
            turns: [
              { tool: { name: "delegate", arguments: { marker: "second" } } },
              { final: "second reply" },
            ],
          },
        ],
      }),
    },
  });
  t.after(() => runtime.stop());
  await runtime.start();

  const order = [];
  let release;
  const released = new Promise((resolve) => {
    release = resolve;
  });
  const config = {
    tools: [{
      name: "delegate",
      handler: async ({ marker }) => {
        order.push(`start:${marker}`);
        if (order.length === 2) release();
        await released;
        order.push(`end:${marker}`);
      },
    }],
  };
  const first = await runtime.createSession(config);
  const second = await runtime.createSession(config);
  const replies = await Promise.all([
    first.sendAndWait({ prompt: "first" }),
    second.sendAndWait({ prompt: "second" }),
  ]);

  assert.deepEqual(order, [
    "start:first",
    "start:second",
    "end:first",
    "end:second",
  ]);
  assert.deepEqual(
    replies.map((reply) => reply.data.content),
    ["first reply", "second reply"],
  );
});
