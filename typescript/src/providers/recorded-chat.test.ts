import { afterEach, describe, expect, it } from "vitest";
import {
  FlightRecorder,
  setFlightRecorder,
} from "../flight-recorder/recorder.js";
import { normalizeFlightSessionId } from "../flight-recorder/integrity.js";
import type { LLMProvider } from "./types.js";
import { chatWithFlightRecorder } from "./recorded-chat.js";

let recorder: FlightRecorder | undefined;
let previous: FlightRecorder | undefined;

afterEach(async () => {
  if (previous) setFlightRecorder(previous);
  await recorder?.close();
  recorder = undefined;
  previous = undefined;
});

async function installRecorder(
  options: ConstructorParameters<typeof FlightRecorder>[0] = {},
): Promise<FlightRecorder> {
  recorder = new FlightRecorder({
    enabled: true,
    inMemory: true,
    ...options,
  });
  await recorder.initialize();
  previous = setFlightRecorder(recorder);
  return recorder;
}

describe("chatWithFlightRecorder", () => {
  it("records a standalone provider attempt without changing the response", async () => {
    const active = await installRecorder();
    const response = {
      content: "answer",
      tool_calls: null,
      model: "resolved-model",
    };
    const provider: LLMProvider = {
      id: "recorded-provider",
      name: "Recorded Provider",
      async chat() {
        return response;
      },
      async isAvailable() {
        return true;
      },
    };

    const result = await chatWithFlightRecorder({
      provider,
      messages: [{ role: "user", content: "private prompt" }],
      options: { model: "auto" },
      source: "recorded-chat-test",
      scope: { sessionId: "conversation-id" },
      attributes: { phase: "probe" },
    });

    expect(result).toBe(response);
    const events = await active.query();
    const root = events.find((event) => event.kind === "trace.started")!;
    const started = events.find(
      (event) => event.kind === "provider.attempt.started",
    )!;
    const completed = events.find(
      (event) => event.kind === "provider.attempt.completed",
    )!;
    expect(started.parentId).toBe(root.id);
    expect(completed.parentId).toBe(started.id);
    expect(completed.model).toBe("resolved-model");
    expect(completed.metadata).toMatchObject({
      phase: "probe",
      modelPolicy: "auto",
    });
    expect(JSON.stringify(events)).not.toContain("private prompt");
  });

  it("records provider failure and rethrows the identical error", async () => {
    const active = await installRecorder();
    const original = new Error("private provider failure");
    const provider: LLMProvider = {
      id: "failing-provider",
      name: "Failing Provider",
      async chat() {
        throw original;
      },
      async isAvailable() {
        return true;
      },
    };

    await expect(
      chatWithFlightRecorder({
        provider,
        messages: [{ role: "user", content: "private prompt" }],
        source: "recorded-chat-test",
      }),
    ).rejects.toBe(original);

    const failed = (await active.query()).find(
      (event) => event.kind === "provider.attempt.failed",
    )!;
    expect(failed.providerId).toBe("failing-provider");
    expect(failed.metadata.errorName).toBe("Error");
    expect(JSON.stringify(failed)).not.toContain(original.message);
  });

  it("durably records provider failures with hostile error getters", async () => {
    const active = await installRecorder({
      identityKey: "88".repeat(32),
      privacy: { recordIO: true },
    });
    const hostile = Object.create(Error.prototype);
    for (const key of ["name", "message", "stack"]) {
      Object.defineProperty(hostile, key, {
        get() {
          throw new Error(`blocked ${key}`);
        },
      });
    }
    const provider: LLMProvider = {
      id: "hostile-provider",
      name: "Hostile Provider",
      async chat() {
        throw hostile;
      },
      async isAvailable() {
        return true;
      },
    };

    await expect(
      chatWithFlightRecorder({
        provider,
        messages: [{ role: "user", content: "hello" }],
        source: "recorded-chat-test",
      }),
    ).rejects.toBe(hostile);

    const failed = (await active.query()).find(
      (event) => event.kind === "provider.attempt.failed",
    );
    expect(failed).toBeDefined();
    expect(failed?.payload).toMatchObject({
      error: {
        name: "[unserializable]",
        message: "[unserializable]",
        stack: "[unserializable]",
      },
    });
  });

  it("does not mislabel an unanswered model policy as concrete identity", async () => {
    const active = await installRecorder();
    const provider: LLMProvider = {
      id: "fallback-provider",
      name: "Fallback Provider",
      async chat() {
        return { content: "fallback answer", tool_calls: null };
      },
      async isAvailable() {
        return true;
      },
    };

    await chatWithFlightRecorder({
      provider,
      messages: [{ role: "user", content: "hello" }],
      options: { model: "gpt-5.6-sol" },
      source: "recorded-chat-test",
    });

    const completed = (await active.query()).find(
      (event) => event.kind === "provider.attempt.completed",
    )!;
    expect(completed.model).toBeUndefined();
    expect(completed.metadata.modelPolicy).toBe("gpt-5.6-sol");
  });

  it("redacts structured tool arguments in provider responses", async () => {
    const active = await installRecorder();
    const provider: LLMProvider = {
      id: "tool-provider",
      name: "Tool Provider",
      async chat() {
        return {
          content: null,
          tool_calls: [
            {
              id: "call-1",
              type: "function",
              function: {
                name: "Missing",
                arguments: JSON.stringify({
                  password: "ordinary-secret-value",
                }),
              },
            },
          ],
        };
      },
      async isAvailable() {
        return true;
      },
    };

    const privateRecorder = new FlightRecorder({
      enabled: true,
      inMemory: true,
      identityKey: "55".repeat(32),
      privacy: { recordIO: true },
    });

    await privateRecorder.initialize();
    const current = setFlightRecorder(privateRecorder);
    try {
      await chatWithFlightRecorder({
        provider,
        messages: [{ role: "user", content: "hello" }],
        source: "recorded-chat-test",
      });
      const persisted = JSON.stringify(await privateRecorder.query());
      expect(persisted).not.toContain("ordinary-secret-value");
      expect(persisted).toContain("[redacted]");
    } finally {
      setFlightRecorder(current);
      await privateRecorder.close();
    }
    expect((await active.health()).eventCount).toBe(0);
  });

  it("redacts JSON provider content and agent log results", async () => {
    const privateRecorder = new FlightRecorder({
      enabled: true,
      inMemory: true,
      identityKey: "66".repeat(32),
      privacy: { recordIO: true },
    });

    await privateRecorder.initialize();
    const current = setFlightRecorder(privateRecorder);
    const provider: LLMProvider = {
      id: "json-provider",
      name: "JSON Provider",
      async chat() {
        return {
          content: JSON.stringify({
            password: "ordinary-secret-value",
          }),
          tool_calls: null,
          agent_logs: [
            `[Shell] ${JSON.stringify({
              password: "tool-result-secret",
            })}`,
            `[Shell] ERROR: ${JSON.stringify({
              password: "tool-error-secret",
            })}`,
          ],
        };
      },
      async isAvailable() {
        return true;
      },
    };
    try {
      await chatWithFlightRecorder({
        provider,
        messages: [
          {
            role: "user",
            content: JSON.stringify({
              password: "user-json-secret",
            }),
          },
        ],
        source: "recorded-chat-test",
      });
      const persisted = JSON.stringify(await privateRecorder.query());
      expect(persisted).not.toContain("ordinary-secret-value");
      expect(persisted).not.toContain("tool-result-secret");
      expect(persisted).not.toContain("tool-error-secret");
      expect(persisted).not.toContain("user-json-secret");
      expect(persisted).toContain("[redacted]");
    } finally {
      setFlightRecorder(current);
      await privateRecorder.close();
    }
  });

  it("applies supplied scope inside an existing trace", async () => {
    const active = await installRecorder({
      identityKey: "55".repeat(32),
    });
    const provider: LLMProvider = {
      id: "scoped-provider",
      name: "Scoped Provider",
      async chat() {
        return { content: "answer", tool_calls: null };
      },
      async isAvailable() {
        return true;
      },
    };

    await active.runTrace(
      { traceId: "outer-trace", sessionId: "outer-session" },
      async () => {
        await chatWithFlightRecorder({
          provider,
          messages: [{ role: "user", content: "hello" }],
          source: "recorded-chat-test",
          scope: { sessionId: "voice-thread-42" },
        });
      },
    );

    const scoped = (await active.query()).filter(
      (event) => event.providerId === "scoped-provider",
    );
    expect(scoped).not.toHaveLength(0);
    expect(new Set(scoped.map((event) => event.sessionId))).toEqual(
      new Set([
        normalizeFlightSessionId(
          "voice-thread-42",
          "55".repeat(32),
        ),
      ]),
    );
  });
});
