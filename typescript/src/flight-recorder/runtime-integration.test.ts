import { afterEach, describe, expect, it } from "vitest";
import { Assistant } from "../agents/Assistant.js";
import { BasicAgent } from "../agents/BasicAgent.js";
import { matchAndExecuteAgent } from "../chat.js";
import type { AgentMetadata } from "../agents/types.js";
import { CopilotCliDirectProvider } from "../providers/copilot-cli-direct.js";
import { ProviderRegistry } from "../providers/registry.js";
import type {
  LLMProvider,
  Message,
  ProviderResponse,
  StreamDelta,
} from "../providers/types.js";
import {
  FlightRecorder,
  getFlightRecorder,
  setFlightRecorder,
} from "./recorder.js";
import {
  normalizeFlightSessionId,
  normalizeFlightWorkspaceId,
} from "./integrity.js";
import type {
  FlightEvent,
  FlightEventQuery,
  FlightExport,
  FlightLedger,
} from "./types.js";

const TEST_IDENTITY_KEY = "22".repeat(32);

class MemoryFlightLedger implements FlightLedger {
  events: FlightEvent[] = [];

  async initialize(): Promise<void> {}
  async close(): Promise<void> {}

  async append(event: FlightEvent): Promise<void> {
    this.events.push(event);
  }

  async query(query: FlightEventQuery = {}): Promise<FlightEvent[]> {
    return this.events.filter((event) => {
      if (query.traceId && event.traceId !== query.traceId) return false;
      if (query.sessionId && event.sessionId !== query.sessionId) return false;
      if (query.source && event.source !== query.source) return false;
      if (query.providerId && event.providerId !== query.providerId)
        return false;
      if (query.agentName && event.agentName !== query.agentName) return false;
      if (query.toolName && event.toolName !== query.toolName) return false;
      if (query.status && event.status !== query.status) return false;
      if (query.kind) {
        const kinds = Array.isArray(query.kind) ? query.kind : [query.kind];
        if (!kinds.includes(event.kind)) return false;
      }
      return true;
    });
  }

  async count(): Promise<number> {
    return this.events.length;
  }

  async prune(keep: number): Promise<number> {
    const remove = Math.max(0, this.events.length - keep);
    this.events.splice(0, remove);
    return remove;
  }

  async export(query: FlightEventQuery = {}): Promise<FlightExport> {
    return {
      schema: "openrappter-flight-export/1.0",
      exportedAt: new Date().toISOString(),
      events: await this.query(query),
    };
  }

  async import(
    data: FlightExport,
    options?: { replace?: boolean },
  ): Promise<number> {
    if (options?.replace) this.events = [];
    this.events.push(...data.events);
    return data.events.length;
  }

  async clear(): Promise<void> {
    this.events = [];
  }
}

class RecordedAgent extends BasicAgent {
  constructor(name = "Recorded") {
    const metadata: AgentMetadata = {
      name,
      description: "Returns a deterministic result",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Input query" },
        },
        required: [],
      },
    };
    super(name, metadata);
  }

  async perform(kwargs: Record<string, unknown>): Promise<string> {
    return JSON.stringify({ status: "success", query: kwargs.query ?? null });
  }
}

class ErrorResultAgent extends RecordedAgent {
  override async perform(): Promise<string> {
    return JSON.stringify({ status: "error", message: "command failed" });
  }
}

class SecretResultAgent extends RecordedAgent {
  override async perform(): Promise<string> {
    return JSON.stringify({
      status: "success",
      password: "result-secret-value",
    });
  }
}

class FileResultAgent extends RecordedAgent {
  override async perform(): Promise<string> {
    return JSON.stringify({
      status: "success",
      path: "/repo/.env",
      content: "PRIVATE_VALUE=ordinary",
    });
  }
}

function provider(
  id: string,
  chat: LLMProvider["chat"],
  options: {
    available?: boolean;
    chatStream?: LLMProvider["chatStream"];
  } = {},
): LLMProvider {
  return {
    id,
    name: id,
    chat,
    chatStream: options.chatStream,
    isAvailable: async () => options.available ?? true,
  };
}

function assistant(
  llm: LLMProvider,
  agents: BasicAgent[] = [],
  workspaceDir = "/workspace/openrappter",
): Assistant {
  return new Assistant(new Map(agents.map((agent) => [agent.name, agent])), {
    provider: llm,
    model: "test-model",
    workspaceDir,
    loadWorkspaceContext: false,
    loadMemoryContext: false,
    useTwin: false,
  });
}

let previousRecorder: FlightRecorder | undefined;
let installedRecorder: FlightRecorder | undefined;

function installRecorder(
  enabled = true,
  privacy?: { recordIO?: boolean },
): MemoryFlightLedger {
  const ledger = new MemoryFlightLedger();
  installedRecorder = new FlightRecorder(
    { enabled, identityKey: TEST_IDENTITY_KEY, privacy },
    ledger,
  );
  previousRecorder = setFlightRecorder(installedRecorder);
  return ledger;
}

afterEach(async () => {
  if (previousRecorder) {
    setFlightRecorder(previousRecorder);
  }
  if (installedRecorder) {
    await installedRecorder.close();
  }
  previousRecorder = undefined;
  installedRecorder = undefined;
});

describe("Flight Recorder runtime integration", () => {
  it("keeps provider, tool, and agent events in one ordered Assistant trace", async () => {
    const ledger = installRecorder();
    const agent = new RecordedAgent();
    let calls = 0;
    const llm = provider("fixture-provider", async () => {
      calls += 1;
      if (calls === 1) {
        return {
          content: null,
          tool_calls: [
            {
              id: "tool-1",
              type: "function",
              function: { name: "Recorded", arguments: '{"query":"safe"}' },
            },
          ],
        };
      }
      return {
        content: "done",
        tool_calls: null,
        usage: { input_tokens: 12, output_tokens: 3 },
      };
    });

    const result = await assistant(llm, [agent]).getResponse(
      "run it",
      undefined,
      "private memory must not enter metadata",
      "conversation-145",
    );

    expect(result.content).toBe("done");
    const runtimeEvents = ledger.events.filter(
      (event) =>
        event.kind.startsWith("provider.") ||
        event.kind.startsWith("tool.") ||
        event.kind.startsWith("agent."),
    );
    expect(runtimeEvents.length).toBeGreaterThan(0);
    expect(new Set(runtimeEvents.map((event) => event.traceId))).toHaveLength(
      1,
    );
    expect(
      runtimeEvents.some(
        (event) => event.kind === "provider.attempt.completed",
      ),
    ).toBe(true);
    expect(
      runtimeEvents.some((event) => event.kind === "tool.call.completed"),
    ).toBe(true);
    expect(
      runtimeEvents.some((event) => event.kind === "agent.execute.completed"),
    ).toBe(true);
    expect(
      ledger.events.every((event, index) => event.sequence === index + 1),
    ).toBe(true);
    expect(
      ledger.events.every(
        (event) =>
          event.sessionId ===
          normalizeFlightSessionId(
            "conversation-145",
            TEST_IDENTITY_KEY,
          ),
      ),
    ).toBe(true);
    expect(
      ledger.events.every(
        (event) =>
          event.workspaceId ===
          normalizeFlightWorkspaceId("/workspace/openrappter"),
      ),
    ).toBe(true);
    expect(JSON.stringify(ledger.events)).not.toContain(
      "/workspace/openrappter",
    );
    expect(
      JSON.stringify(ledger.events.map((event) => event.metadata)),
    ).not.toContain("private memory must not enter metadata");

    const root = ledger.events.find((event) => event.kind === "trace.started")!;
    const providerStarted = ledger.events.find(
      (event) => event.kind === "provider.attempt.started",
    )!;
    const providerCompleted = ledger.events.find(
      (event) => event.kind === "provider.attempt.completed",
    )!;
    const toolStarted = ledger.events.find(
      (event) => event.kind === "tool.call.started",
    )!;
    const agentStarted = ledger.events.find(
      (event) => event.kind === "agent.execute.started",
    )!;
    const agentContext = ledger.events.find(
      (event) =>
        event.kind === "context.assembled" && event.source === "basic-agent",
    )!;
    const agentCompleted = ledger.events.find(
      (event) => event.kind === "agent.execute.completed",
    )!;
    const toolCompleted = ledger.events.find(
      (event) => event.kind === "tool.call.completed",
    )!;
    const traceCompleted = ledger.events.find(
      (event) => event.kind === "trace.completed",
    )!;

    expect(providerStarted.parentId).toBe(root.id);
    expect(providerCompleted.parentId).toBe(providerStarted.id);
    expect(toolStarted.parentId).toBe(providerCompleted.id);
    expect(agentStarted.parentId).toBe(toolStarted.id);
    expect(agentContext.parentId).toBe(agentStarted.id);
    expect(agentCompleted.parentId).toBe(agentStarted.id);
    expect(toolCompleted.parentId).toBe(toolStarted.id);
    expect(traceCompleted.parentId).toBe(root.id);
  });

  it("isolates concurrent Assistant turns by trace and session identity", async () => {
    const ledger = installRecorder();
    const llm = provider("concurrent-provider", async (messages) => {
      const text = messages.at(-1)?.content ?? "";
      await new Promise((resolve) =>
        setTimeout(resolve, text === "slow" ? 15 : 1),
      );
      return { content: text, tool_calls: null };
    });
    const instance = assistant(llm);

    const [slow, fast] = await Promise.all([
      instance.getResponse("slow", undefined, undefined, "session-slow"),
      instance.getResponse("fast", undefined, undefined, "session-fast"),
    ]);

    expect([slow.content, fast.content]).toEqual(["slow", "fast"]);
    const traceBySession = new Map<string, Set<string>>();
    for (const event of ledger.events) {
      const sessionId = event.sessionId ?? "";
      const traces = traceBySession.get(sessionId) ?? new Set<string>();
      traces.add(event.traceId);
      traceBySession.set(sessionId, traces);
    }
    const slowSession = normalizeFlightSessionId(
      "session-slow",
      TEST_IDENTITY_KEY,
    )!;
    const fastSession = normalizeFlightSessionId(
      "session-fast",
      TEST_IDENTITY_KEY,
    )!;
    expect(traceBySession.get(slowSession)?.size).toBe(1);
    expect(traceBySession.get(fastSession)?.size).toBe(1);
    const slowTrace = [...(traceBySession.get(slowSession) ?? [])][0];
    const fastTrace = [...(traceBySession.get(fastSession) ?? [])][0];
    expect(slowTrace).not.toBe(fastTrace);
    expect(
      ledger.events.every((event) =>
        event.traceId === slowTrace
          ? event.sessionId ===
            normalizeFlightSessionId("session-slow", TEST_IDENTITY_KEY)
          : event.sessionId ===
            normalizeFlightSessionId("session-fast", TEST_IDENTITY_KEY),
      ),
    ).toBe(true);
  });

  it("records provider failure and preserves the original Assistant error", async () => {
    const ledger = installRecorder();
    const original = new TypeError("provider exploded");
    const llm = provider("failing-provider", async () => {
      throw original;
    });

    let caught: unknown;
    try {
      await assistant(llm).getResponse(
        "fail",
        undefined,
        undefined,
        "failure-session",
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(original);
    const failed = ledger.events.find(
      (event) => event.kind === "provider.attempt.failed",
    );
    expect(failed?.providerId).toBe("failing-provider");
    expect(failed?.metadata.errorName).toBe("TypeError");
    expect(failed?.metadata.messageChars).toBe("provider exploded".length);
    expect(failed?.metadata.messageHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(failed)).not.toContain("provider exploded");
    expect(ledger.events.at(-1)?.kind).toBe("trace.failed");
  });

  it("never persists provider response bodies or embedded credentials in default metadata", async () => {
    const ledger = installRecorder();
    const githubToken = `ghp_${"s".repeat(32)}`;
    const bearer = `Bearer ${"t".repeat(32)}`;
    const original = new Error(
      `HTTP 401 body={"token":"${githubToken}"} Authorization: ${bearer}`,
    );
    const llm = provider("secret-failure-provider", async () => {
      throw original;
    });

    await expect(
      assistant(llm).getResponse(
        "fail safely",
        undefined,
        undefined,
        "secret-failure",
      ),
    ).rejects.toBe(original);

    const persisted = JSON.stringify(ledger.events);
    expect(persisted).not.toContain(githubToken);
    expect(persisted).not.toContain(bearer);
    expect(persisted).not.toContain("body=");
    const failed = ledger.events.find(
      (event) => event.kind === "provider.attempt.failed",
    );
    expect(failed?.metadata).toMatchObject({
      errorName: "Error",
      messageChars: original.message.length,
    });
    expect(failed?.metadata.messageHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("records failover rungs, unavailable providers, and final selection", async () => {
    const ledger = installRecorder();
    const registry = new ProviderRegistry();
    registry.register(
      provider(
        "offline",
        async () => {
          throw new Error("must not run");
        },
        { available: false },
      ),
    );
    registry.register(
      provider("primary", async () => {
        throw new Error("primary failed");
      }),
    );
    registry.register(
      provider("backup", async () => {
        await getFlightRecorder().record({
          kind: "provider.nested",
          source: "backup-provider",
        });
        return {
          content: "backup answer",
          tool_calls: null,
          model: "backup-resolved",
        };
      }),
    );

    const response = await registry.chatWithFailover(
      ["missing", "offline", "primary", "backup"],
      [{ role: "user", content: "hello" }],
      { model: "requested-model" },
      { maxRetries: 1, retryDelayMs: 0 },
    );

    expect(response.content).toBe("backup answer");
    const failures = ledger.events.filter(
      (event) => event.kind === "provider.attempt.failed",
    );
    expect(
      failures.some(
        (event) =>
          event.providerId === "missing" && event.metadata.reason === "missing",
      ),
    ).toBe(true);
    expect(
      failures.some(
        (event) =>
          event.providerId === "offline" &&
          event.metadata.reason === "unavailable",
      ),
    ).toBe(true);
    expect(failures.some((event) => event.providerId === "primary")).toBe(true);
    const startedProviders = ledger.events
      .filter((event) => event.kind === "provider.attempt.started")
      .map((event) => event.providerId);
    expect(startedProviders).toEqual(["primary", "primary", "backup"]);
    const selected = ledger.events.find(
      (event) => event.kind === "provider.selected",
    );
    expect(selected?.providerId).toBe("backup");
    expect(selected?.model).toBe("backup-resolved");
    expect(selected?.metadata.rung).toBe(4);
    expect(selected?.metadata.attempt).toBe(1);
    const backupStarted = ledger.events.find(
      (event) =>
        event.kind === "provider.attempt.started" &&
        event.providerId === "backup",
    )!;
    const backupCompleted = ledger.events.find(
      (event) =>
        event.kind === "provider.attempt.completed" &&
        event.providerId === "backup",
    )!;
    expect(backupCompleted.parentId).toBe(backupStarted.id);
    expect(
      ledger.events.find((event) => event.kind === "provider.nested")
        ?.parentId,
    ).toBe(backupStarted.id);
    expect(selected?.parentId).toBe(backupCompleted.id);
  });

  it("is behaviorally inert and appends no events when disabled", async () => {
    const ledger = installRecorder(false);
    const llm = provider("disabled-provider", async () => ({
      content: "unchanged",
      tool_calls: null,
    }));

    const result = await assistant(llm).getResponse(
      "hello",
      undefined,
      undefined,
      "disabled-session",
    );

    expect(result).toEqual({
      content: "unchanged",
      agentLogs: [],
      model: undefined,
      requestedModel: "test-model",
    });
    expect(ledger.events).toEqual([]);
  });

  it("records streaming provider lifecycle without changing deltas", async () => {
    const ledger = installRecorder();
    const deltas: string[] = [];
    const stream = async function* (
      _messages: Message[],
    ): AsyncGenerator<StreamDelta> {
      yield { content: "hel", done: false };
      yield { content: "lo", done: false };
      yield { done: true, model: "actual-stream-model" };
    };
    const llm = provider(
      "stream-provider",
      async (): Promise<ProviderResponse> => ({
        content: null,
        tool_calls: null,
      }),
      { chatStream: stream },
    );

    const result = await assistant(llm).getResponseStreaming(
      "stream",
      (delta) => deltas.push(delta),
      "stream-session",
    );

    expect(result.content).toBe("hello");
    expect(deltas).toEqual(["hel", "lo"]);
    const started = ledger.events.find(
      (event) => event.kind === "provider.attempt.started",
    );
    const completed = ledger.events.find(
      (event) => event.kind === "provider.attempt.completed",
    );
    expect(started?.metadata.streaming).toBe(true);
    expect(completed?.metadata.streaming).toBe(true);
    expect(completed?.model).toBe("actual-stream-model");
    expect(started?.traceId).toBe(completed?.traceId);
  });

  it("structures streaming tool history before payload redaction", async () => {
    const ledger = installRecorder(true, { recordIO: true });
    let round = 0;
    const stream = async function* (): AsyncGenerator<StreamDelta> {
      round += 1;
      if (round === 1) {
        yield {
          done: false,
          tool_calls: [
            {
              index: 0,
              id: "stream-call",
              type: "function",
              function: {
                name: "FileTool",
                arguments: JSON.stringify({ path: "/repo/.env" }),
              },
            },
          ],
        };
        yield { done: true };
        return;
      }
      yield { content: "done", done: false };
      yield { done: true };
    };
    const llm = provider(
      "stream-history",
      async () => ({ content: null, tool_calls: null }),
      { chatStream: stream },
    );
    const instance = assistant(llm, [new FileResultAgent("FileTool")]);

    await instance.getResponseStreaming(
      "read",
      () => {},
      "stream-history-session",
    );

    const persisted = JSON.stringify(ledger.events);
    expect(persisted).not.toContain("PRIVATE_VALUE=ordinary");
    expect(persisted).not.toContain("/repo/.env");
    expect(persisted).toContain("[excluded-path]");
  });

  it("does not report auto-routing policy as the model that answered", async () => {
    const ledger = installRecorder();
    const llm = provider("auto-provider", async () => ({
      content: "answer",
      tool_calls: null,
    }));
    const instance = new Assistant(new Map(), {
      provider: llm,
      model: "auto",
      loadWorkspaceContext: false,
      loadMemoryContext: false,
      useTwin: false,
    });

    await instance.getResponse(
      "route it",
      undefined,
      undefined,
      "auto-session",
    );

    const completed = ledger.events.find(
      (event) => event.kind === "provider.attempt.completed",
    );
    expect(completed?.model).toBeUndefined();
    expect(completed?.metadata.modelPolicy).toBe("auto");
  });

  it("records a concrete provider-reported model instead of the auto policy", async () => {
    const ledger = installRecorder();
    const llm = provider("resolved-provider", async () => ({
      content: "answer",
      tool_calls: null,
      model: "resolved-model-v2",
    }));
    const instance = new Assistant(new Map(), {
      provider: llm,
      model: "auto",
      loadWorkspaceContext: false,
      loadMemoryContext: false,
      useTwin: false,
    });

    await instance.getResponse(
      "route it",
      undefined,
      undefined,
      "resolved-session",
    );

    const completed = ledger.events.find(
      (event) => event.kind === "provider.attempt.completed",
    );
    expect(completed?.model).toBe("resolved-model-v2");
    expect(completed?.metadata.modelPolicy).toBe("auto");
  });

  it("preserves Copilot CLI auto policy when no Assistant model is explicitly set", async () => {
    const ledger = installRecorder();
    let receivedModel = "";
    const cli = new CopilotCliDirectProvider({
      runner: async (_executable, args) => {
        receivedModel = args[args.indexOf("--model") + 1];
        return { stdout: "cli answer", stderr: "" };
      },
    });

    const instance = new Assistant(new Map(), {
      provider: cli,
      loadWorkspaceContext: false,
      loadMemoryContext: false,
      useTwin: false,
    });

    expect(instance.getModel()).toBe("auto");
    const response = await instance.getResponse(
      "use auto",
      undefined,
      undefined,
      "cli-auto-session",
    );
    expect(response.content).toBe("cli answer");
    expect(receivedModel).toBe("auto");
    const completed = ledger.events.find(
      (event) => event.kind === "provider.attempt.completed",
    );
    expect(completed?.model).toBeUndefined();
    expect(completed?.metadata.modelPolicy).toBe("auto");
  });

  it("disables MCP child recording when the recorder cannot share storage", async () => {
    installRecorder();
    let childEnvironment: NodeJS.ProcessEnv | undefined;
    const cli = new CopilotCliDirectProvider({
      runner: async (_executable, _args, options) => {
        childEnvironment = options.env;
        return { stdout: "answer", stderr: "" };
      },
    });

    await getFlightRecorder().runTrace(
      { traceId: "mcp-parent-trace", sessionId: "private-session" },
      async () => {
        const parent = await getFlightRecorder().record({
          kind: "provider.attempt.started",
          source: "test",
        });
        await getFlightRecorder().withParent(parent?.id, () =>
          cli.chat([{ role: "user", content: "hello" }]),
        );
      },
    );

    expect(childEnvironment).toMatchObject({
      OPENRAPPTER_FLIGHT_RECORDER: "0",
    });
    expect(childEnvironment?.OPENRAPPTER_INVOCATION_REQUEST_ID).toMatch(
      /^[0-9a-f-]{36}$/i,
    );
  });

  it("updates model policy atomically when a live provider swap falls back to CLI auto", async () => {
    const ledger = installRecorder();
    const sdk = provider("copilot-sdk", async () => ({
      content: "sdk",
      tool_calls: null,
      model: "gpt-4.1",
    }));
    let receivedModel = "";
    const cli = new CopilotCliDirectProvider({
      runner: async (_executable, args) => {
        receivedModel = args[args.indexOf("--model") + 1];
        return { stdout: "cli answer", stderr: "" };
      },
    });
    const instance = new Assistant(new Map(), {
      provider: sdk,
      model: "gpt-4.1",
      loadWorkspaceContext: false,
      loadMemoryContext: false,
      useTwin: false,
    });

    instance.setProvider(cli, "auto");
    const response = await instance.getResponse(
      "fallback",
      undefined,
      undefined,
      "swapped-session",
    );

    expect(response.content).toBe("cli answer");
    expect(instance.getModel()).toBe("auto");
    expect(receivedModel).toBe("auto");
    const completed = ledger.events.find(
      (event) => event.kind === "provider.attempt.completed",
    );
    expect(completed?.providerId).toBe("copilot-cli-direct");
    expect(completed?.model).toBeUndefined();
    expect(completed?.metadata.modelPolicy).toBe("auto");
  });

  it("records keyword-routed CLI agent calls as tool-to-agent causal trees", async () => {
    const ledger = installRecorder();
    const agent = new RecordedAgent("Shell");

    const result = await getFlightRecorder().runTrace(
      { traceId: "keyword-route", sessionId: "cli" },
      () => matchAndExecuteAgent("run ls", new Map([["Shell", agent]])),
    );

    expect(result).toContain('"status":"success"');
    const events = ledger.events.filter(
      (event) => event.traceId === "keyword-route",
    );
    const root = events.find((event) => event.kind === "trace.started")!;
    const toolStarted = events.find((event) => event.kind === "tool.call.started")!;
    const agentStarted = events.find((event) => event.kind === "agent.execute.started")!;
    const toolCompleted = events.find(
      (event) => event.kind === "tool.call.completed",
    )!;
    expect(toolStarted.parentId).toBe(root.id);
    expect(agentStarted.parentId).toBe(toolStarted.id);
    expect(toolCompleted.parentId).toBe(toolStarted.id);
  });

  it("records error-shaped agent results as failed agent and tool events", async () => {
    const ledger = installRecorder();
    const agent = new ErrorResultAgent("Shell");

    const result = await getFlightRecorder().runTrace(
      { traceId: "error-result", sessionId: "cli" },
      () => matchAndExecuteAgent("run command", new Map([["Shell", agent]])),
    );

    expect(result).not.toBeNull();
    expect(JSON.parse(result!).status).toBe("error");
    const events = ledger.events.filter(
      (event) => event.traceId === "error-result",
    );
    expect(
      events.find((event) => event.kind === "agent.execute.failed")?.status,
    ).toBe("error");
    expect(
      events.find((event) => event.kind === "tool.call.failed")?.status,
    ).toBe("error");
    expect(
      events.some((event) => event.kind === "agent.execute.completed"),
    ).toBe(false);
  });

  it("records successful standalone agent results as structured payloads", async () => {
    const ledger = installRecorder(true, { recordIO: true });
    const agent = new SecretResultAgent("StandaloneSecret");

    await agent.execute({ query: "run" });

    const completed = ledger.events.find(
      (event) => event.kind === "agent.execute.completed",
    )!;
    expect(completed.payload).toEqual({
      result: {
        password: "[redacted]",
        status: "success",
      },
    });
  });

  it("records parsed tool arguments as structured redacted data", async () => {
    const ledger = installRecorder(true, { recordIO: true });
    const agent = new RecordedAgent("SafeTool");
    const llm = provider("tool-provider", async () => ({
      content: null,
      tool_calls: [
        {
          id: "call-1",
          type: "function",
          function: {
            name: "SafeTool",
            arguments: JSON.stringify({
              password: "correct horse battery staple",
              api_key: "ordinary-secret-value",
            }),
          },
        },
      ],
    }));
    const instance = assistant(llm, [agent]);

    await instance.getResponse("run", undefined, undefined, "tool-privacy");

    const started = ledger.events.find(
      (event) => event.kind === "tool.call.started",
    )!;
    expect(started.payload).toEqual({
      arguments: {
        api_key: "[redacted]",
        password: "[redacted]",
      },
    });
    expect(JSON.stringify(started)).not.toContain(
      "correct horse battery staple",
    );
  });

  it("redacts structured tool results in provider history and keyword routes", async () => {
    const ledger = installRecorder(true, { recordIO: true });
    const agent = new SecretResultAgent("Shell");
    let round = 0;
    const llm = provider("history-provider", async () => {
      round += 1;
      return round === 1
        ? {
            content: null,
            tool_calls: [
              {
                id: "call-1",
                type: "function",
                function: {
                  name: "Shell",
                  arguments: JSON.stringify({
                    password: "argument-secret-value",
                  }),
                },
              },
            ],
          }
        : { content: "done", tool_calls: null };
    });
    await assistant(llm, [agent]).getResponse(
      "run",
      undefined,
      undefined,
      "history-privacy",
    );
    await getFlightRecorder().runTrace(
      { traceId: "keyword-secret" },
      () => matchAndExecuteAgent("run command", new Map([["Shell", agent]])),
    );

    const persisted = JSON.stringify(ledger.events);
    expect(persisted).not.toContain("argument-secret-value");
    expect(persisted).not.toContain("result-secret-value");
    expect(persisted).toContain("[redacted]");
  });

  it("redacts unknown-agent structured arguments", async () => {
    const ledger = installRecorder(true, { recordIO: true });
    let round = 0;
    const llm = provider("unknown-tool-provider", async () => {
      round += 1;
      return round === 1
        ? {
            content: null,
            tool_calls: [
              {
                id: "missing-call",
                type: "function",
                function: {
                  name: "Missing",
                  arguments: JSON.stringify({
                    password: "ordinary-secret-value",
                  }),
                },
              },
            ],
          }
        : { content: "done", tool_calls: null };
    });

    await assistant(llm).getResponse(
      "run",
      undefined,
      undefined,
      "unknown-tool",
    );

    const persisted = JSON.stringify(ledger.events);
    expect(persisted).not.toContain("ordinary-secret-value");
    expect(persisted).toContain("[redacted]");
  });

  it("creates a root trace and summarizes context for standalone agent execution", async () => {
    const ledger = installRecorder();
    const agent = new RecordedAgent("Standalone");
    agent.sloshFilter = { exclude: ["memory_echoes"] };
    agent.sloshPrivacy = { redact: ["query_signals.hints"] };

    const result = await agent.execute({
      query: "standalone",
      upstream_slush: { source_agent: "upstream" },
    });

    expect(JSON.parse(result).status).toBe("success");
    expect(ledger.events[0].kind).toBe("trace.started");
    expect(ledger.events.at(-1)?.kind).toBe("trace.completed");
    const context = ledger.events.find(
      (event) => event.kind === "context.assembled",
    );
    expect(context?.source).toBe("basic-agent");
    expect(context?.metadata.filterExclude).toEqual(["memory_echoes"]);
    expect(context?.metadata.privacyRedactCount).toBe(1);
    expect(context?.metadata.hasUpstream).toBe(true);
  });
});
