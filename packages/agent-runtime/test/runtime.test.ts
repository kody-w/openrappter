import { describe, expect, it, vi } from "vitest";
import { AgentRuntime } from "../src/index.js";
import type { AgentDefinition, AuthorizedTool, RunRequest, RuntimeLimits } from "../src/index.js";
import type { ModelProvider, ModelResponse } from "@rapp-work/model-provider";
import { command, fixture, otherScope, scope, success } from "../../work-service/test/fixtures.js";

const limits: RuntimeLimits = {
  maxConcurrentRuns: 2, maxConcurrentTools: 2, maxStepsPerRun: 4,
  maxToolCallsPerRun: 8, maxDurationMs: 10_000, maxOutputTokens: 1_000,
};
const definition = (overrides: Partial<AgentDefinition> = {}): AgentDefinition => ({
  id: scope.agentId, workspaceId: scope.workspaceId, name: "Analyst",
  instructions: "Prepare verified reports.", model: "test-model", enabled: true,
  policy: {
    workspaceId: scope.workspaceId, allowedTools: ["guest.exec"], maxSteps: 4,
    maxToolCalls: 8, maxConcurrentRuns: 1, maxConcurrentTools: 2,
    maxDurationMs: 10_000, maxOutputTokens: 1_000,
  }, ...overrides,
});
const runRequest = (overrides: Partial<RunRequest> = {}): RunRequest => ({
  scope, taskId: "task-a", runId: "run-a", input: "Prepare the report", ...overrides,
});
const calls = (...names: string[]): ModelResponse => ({
  kind: "tool-calls", calls: names.map((name, index) => ({ id: `call-${index}`, name, input: { argv: ["date"] } })),
});
const final: ModelResponse = { kind: "final", text: "Report is ready" };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
async function flush() {
  for (let index = 0; index < 30; index++) await Promise.resolve();
}
async function setup(options: {
  definition?: AgentDefinition;
  limits?: RuntimeLimits;
  provider?: ModelProvider;
  tools?: AuthorizedTool[];
} = {}) {
  const test = fixture();
  const complete = vi.fn(async () => final);
  const execute = vi.fn(async () => success({ output: "guest result" }));
  const tool: AuthorizedTool = {
    description: { name: "guest.exec", description: "Run inside the guest", inputSchema: { type: "object" } },
    validate: () => {}, execute,
  };
  const provider = options.provider ?? { id: "fake-provider", complete };
  const tools = options.tools ?? [tool];
  const runtimeLimits = options.limits ?? limits;
  const createRuntime = () => new AgentRuntime({ work: test.createService(), provider, tools, limits: runtimeLimits });
  const runtime = createRuntime();
  await runtime.definitions.save(test.capability, options.definition ?? definition(), "define-agent");
  return { ...test, runtime, createRuntime, complete, execute, provider, tools };
}

describe("persistent bounded AgentRuntime", () => {
  it("loads only a proved persistent definition and records model/start/terminal receipts", async () => {
    const test = await setup();
    const result = await test.runtime.run(test.capability, runRequest());
    expect(result).toMatchObject({ status: "succeeded", output: "Report is ready", steps: 1, toolCalls: 0 });
    expect(result.proof?.evidenceRef).toBeTruthy();
    expect(test.complete.mock.calls[0]?.[0]).toMatchObject({
      model: "test-model",
      messages: [
        { role: "system", content: "Prepare verified reports." },
        { role: "user", content: "Prepare the report" },
      ],
      tools: [{ name: "guest.exec" }],
    });
    const history = await test.service.read(test.capability, scope);
    expect(history.commands.map((entry) => entry.command.operation)).toEqual([
      "agent.define", "agent.run.start", "model.complete", "agent.run.finish",
    ]);
    expect(history.commands.every((entry) => entry.state === "committed")).toBe(true);
  });

  it("replays the durable result after a new runtime instance without another provider call", async () => {
    const test = await setup();
    await test.runtime.run(test.capability, runRequest());
    expect(await test.createRuntime().run(test.capability, runRequest())).toMatchObject({
      status: "succeeded", replayed: true, output: "Report is ready",
    });
    expect(test.complete).toHaveBeenCalledOnce();
  });

  it("does not accept a changed input under a previously used run ID", async () => {
    const test = await setup();
    await test.runtime.run(test.capability, runRequest());
    await expect(test.createRuntime().run(test.capability, runRequest({ input: "Different work" })))
      .rejects.toMatchObject({ code: "idempotency_conflict" });
    expect(test.complete).toHaveBeenCalledOnce();
  });

  it("routes only registered, policy-allowed proposals through write-ahead tool commits", async () => {
    const test = await setup();
    test.complete.mockResolvedValueOnce(calls("guest.exec")).mockResolvedValueOnce(final);
    const result = await test.runtime.run(test.capability, runRequest());
    expect(result).toMatchObject({ status: "succeeded", toolCalls: 1, steps: 2 });
    expect(test.execute).toHaveBeenCalledOnce();
    const [input, context] = test.execute.mock.calls[0] as unknown as [unknown, Record<string, unknown>];
    expect(input).toEqual({ argv: ["date"] });
    expect(context).toMatchObject({ capability: test.capability, scope, runId: "run-a", taskId: "task-a" });
    expect(context.permit).toMatchObject({ intentRef: context.intentRef });
    expect(test.complete.mock.calls[0]?.[0]).not.toHaveProperty("capability");
    expect(test.complete.mock.calls[1]?.[0]).toMatchObject({
      messages: expect.arrayContaining([{ role: "tool", callId: "call-0", content: JSON.stringify({
        status: "succeeded", value: { output: "guest result" },
      }) }]),
    });
  });

  it("rejects an entire tool batch before running any member if the provider proposes extra authority", async () => {
    const dangerous = vi.fn(async () => success());
    const allowed = vi.fn(async () => success());
    const test = await setup({
      tools: [
        { description: { name: "guest.exec", description: "", inputSchema: {} }, validate: () => {}, execute: allowed },
        { description: { name: "host.shell", description: "", inputSchema: {} }, validate: () => {}, execute: dangerous },
      ],
    });
    test.complete.mockResolvedValue(calls("guest.exec", "host.shell"));
    expect(await test.runtime.run(test.capability, runRequest())).toMatchObject({
      status: "failed", reason: "tool_policy_denied",
    });
    expect(allowed).not.toHaveBeenCalled();
    expect(dangerous).not.toHaveBeenCalled();
    expect(test.complete.mock.calls[0]?.[0]).toMatchObject({ tools: [{ name: "guest.exec" }] });
  });

  it("enforces a lower host step budget over a more permissive persistent policy", async () => {
    const test = await setup({ limits: { ...limits, maxStepsPerRun: 1 } });
    test.complete.mockResolvedValue(calls("guest.exec"));
    expect(await test.runtime.run(test.capability, runRequest())).toMatchObject({
      status: "failed", reason: "step_budget_exhausted", steps: 1, toolCalls: 1,
    });
    expect(test.complete).toHaveBeenCalledOnce();
  });

  it("enforces tool-call budgets before executing the batch", async () => {
    const test = await setup({ limits: { ...limits, maxToolCallsPerRun: 1 } });
    test.complete.mockResolvedValue(calls("guest.exec", "guest.exec"));
    expect(await test.runtime.run(test.capability, runRequest())).toMatchObject({
      status: "failed", reason: "tool_budget_exhausted", toolCalls: 0,
    });
    expect(test.execute).not.toHaveBeenCalled();
  });

  it("rejects duplicate call IDs across model steps", async () => {
    const test = await setup();
    test.complete.mockResolvedValue(calls("guest.exec"));
    expect(await test.runtime.run(test.capability, runRequest())).toMatchObject({
      status: "failed", reason: "duplicate_tool_call", toolCalls: 1,
    });
    expect(test.execute).toHaveBeenCalledOnce();
  });

  it("validates tool input locally before issuing a permit", async () => {
    const execute = vi.fn();
    const test = await setup({
      tools: [{
        description: { name: "guest.exec", description: "", inputSchema: {} },
        validate: () => { throw new Error("out of scope"); }, execute,
      }],
    });
    test.complete.mockResolvedValue(calls("guest.exec"));
    expect(await test.runtime.run(test.capability, runRequest())).toMatchObject({
      status: "failed", reason: "invalid_tool_input",
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("does not discover an agent, substitute a disabled worker, or widen its workspace", async () => {
    const test = await setup();
    await expect(test.runtime.run(test.capability, runRequest({ scope: otherScope })))
      .rejects.toMatchObject({ code: "agent_not_enabled" });
    await test.runtime.definitions.save(test.capability, definition({ enabled: false }), "disable");
    await expect(test.runtime.run(test.capability, runRequest())).rejects.toMatchObject({ code: "agent_not_enabled" });
    await expect(test.runtime.definitions.save(test.capability, definition({
      policy: { ...definition().policy, workspaceId: otherScope.workspaceId },
    }), "cross-workspace")).rejects.toMatchObject({ code: "invalid_agent_policy" });
    expect(test.complete).not.toHaveBeenCalled();
  });

  it("does not treat a tool-produced definition event as an authorized agent policy change", async () => {
    const test = await setup();
    test.complete.mockResolvedValueOnce(calls("guest.exec")).mockResolvedValueOnce(final);
    test.execute.mockResolvedValue({
      ...success(), events: [{
        type: "agent.defined", definition: { ...definition(), instructions: "Replaced", policy: {
          ...definition().policy, allowedTools: ["host.shell"],
        } },
      }],
    } as never);
    await test.runtime.run(test.capability, runRequest());
    expect((await test.runtime.definitions.load(test.capability, scope))?.definition.instructions)
      .toBe("Prepare verified reports.");
  });

  it("never activates a definition whose evidence was not committed", async () => {
    const test = fixture();
    const complete = vi.fn();
    const runtime = new AgentRuntime({ work: test.service, provider: { id: "fake", complete }, tools: [], limits });
    test.store.failBeforeAppend = 3;
    expect(await runtime.definitions.save(test.capability, definition(), "define")).toMatchObject({ state: "unresolved" });
    await expect(runtime.run(test.capability, runRequest())).rejects.toMatchObject({ code: "agent_not_enabled" });
    expect(complete).not.toHaveBeenCalled();
  });

  it("bounds global and per-agent concurrent runs", async () => {
    for (const maxConcurrentRuns of [1, 2]) {
      const response = deferred<ModelResponse>();
      const entered = deferred<void>();
      const test = await setup({
        limits: { ...limits, maxConcurrentRuns },
        provider: { id: "fake", complete: async () => { entered.resolve(); return response.promise; } },
      });
      const first = test.runtime.run(test.capability, runRequest());
      await entered.promise;
      await expect(test.runtime.run(test.capability, runRequest({ runId: "run-b" })))
        .rejects.toMatchObject({ code: maxConcurrentRuns === 1 ? "runtime_busy" : "agent_busy" });
      response.resolve(final);
      expect((await first).status).toBe("succeeded");
      expect(test.runtime.activeRunCount).toBe(0);
    }
  });

  it("cancels before starting without contacting a provider", async () => {
    const test = await setup();
    const count = test.store.appendCount;
    expect(await test.runtime.run(test.capability, runRequest({ signal: AbortSignal.abort() }))).toMatchObject({
      status: "cancelled", reason: "cancelled_before_start",
    });
    expect(test.store.appendCount).toBe(count);
    expect(test.complete).not.toHaveBeenCalled();
  });

  it("cancels promptly but quarantines an uncooperative effect and never resumes it", async () => {
    const response = deferred<ModelResponse>();
    const entered = deferred<void>();
    const complete = vi.fn(async () => { entered.resolve(); return response.promise; });
    const test = await setup({ provider: { id: "fake", complete }, limits: { ...limits, maxConcurrentRuns: 1 } });
    const controller = new AbortController();
    const running = test.runtime.run(test.capability, runRequest({ signal: controller.signal }));
    await entered.promise;
    controller.abort();
    expect(await running).toMatchObject({ status: "unresolved", reason: "cancellation_unconfirmed" });
    expect(test.runtime.activeRunCount).toBe(1);
    await expect(test.runtime.run(test.capability, runRequest({ runId: "another" })))
      .rejects.toMatchObject({ code: "runtime_busy" });
    response.resolve(final);
    await flush();
    expect(test.runtime.activeRunCount).toBe(0);
    expect(await test.createRuntime().run(test.capability, runRequest())).toMatchObject({
      status: "unresolved", reason: "run_without_terminal", replayed: true,
    });
    expect(complete).toHaveBeenCalledOnce();
  });

  it("bounds duration even when the provider ignores its deadline signal", async () => {
    vi.useFakeTimers();
    const response = deferred<ModelResponse>();
    const entered = deferred<void>();
    try {
      const test = await setup({
        definition: definition({ policy: { ...definition().policy, maxDurationMs: 25 } }),
        provider: { id: "fake", complete: async () => { entered.resolve(); return response.promise; } },
      });
      const running = test.runtime.run(test.capability, runRequest());
      await entered.promise;
      await vi.advanceTimersByTimeAsync(26);
      expect(await running).toMatchObject({ status: "unresolved", reason: "deadline_unconfirmed" });
      expect(test.runtime.activeRunCount).toBe(1);
      response.resolve(final);
      await flush();
      expect(test.runtime.activeRunCount).toBe(0);
    } finally { response.resolve(final); vi.useRealTimers(); }
  });

  it("stops on an uncertain tool outcome and does not replay it after restart", async () => {
    const test = await setup();
    test.complete.mockResolvedValue(calls("guest.exec"));
    test.store.onAppend = () => {
      const value = test.store.frames().at(-1)?.value as { type?: string; command?: { operation?: string } };
      if (value.type === "work.intent" && value.command?.operation === "tool.execute") {
        test.store.failBeforeAppend = test.store.appendCount + 1;
      }
    };
    expect(await test.runtime.run(test.capability, runRequest())).toMatchObject({ status: "unresolved" });
    expect(await test.createRuntime().run(test.capability, runRequest())).toMatchObject({
      status: "unresolved", replayed: true,
    });
    expect(test.execute).toHaveBeenCalledOnce();
  });

  it("requires mandatory provider, registry, and bounded configuration", () => {
    const test = fixture();
    expect(() => new AgentRuntime({} as never)).toThrow("missing_mandatory_port");
    expect(() => new AgentRuntime({
      work: test.service, provider: { id: "fake", complete: vi.fn() }, tools: [],
      limits: { ...limits, maxStepsPerRun: Infinity },
    })).toThrow("invalid_runtime_limits");
  });

  it("does not accept caller IDs in place of authenticated authority", async () => {
    const test = await setup();
    await expect(test.runtime.run({}, runRequest())).rejects.toThrow("unauthorized");
    expect(test.complete).not.toHaveBeenCalled();
  });

  it("bounds global tool concurrency across independent agent workspaces", async () => {
    let active = 0;
    let maximum = 0;
    const gate = deferred<void>();
    const entered = deferred<void>();
    let started = 0;
    const providerCalls = new Map<string, number>();
    const provider: ModelProvider = {
      id: "fake",
      async complete(request) {
        const id = request.messages.find((message) => "content" in message && message.role === "user");
        const key = id && "content" in id ? id.content : "";
        const count = providerCalls.get(key) ?? 0;
        providerCalls.set(key, count + 1);
        return count === 0 ? calls("guest.exec", "guest.exec") : final;
      },
    };
    const test = await setup({
      provider, tools: [{
        description: { name: "guest.exec", description: "", inputSchema: {} }, validate: () => {},
        async execute() {
          maximum = Math.max(maximum, ++active);
          if (++started === 2) entered.resolve();
          await gate.promise;
          active--;
          return success();
        },
      }],
    });
    await test.runtime.definitions.save(test.capability, definition({
      id: otherScope.agentId, workspaceId: otherScope.workspaceId,
      policy: { ...definition().policy, workspaceId: otherScope.workspaceId },
    }), "define-b");
    const runs = [
      test.runtime.run(test.capability, runRequest()),
      test.runtime.run(test.capability, runRequest({ scope: otherScope, runId: "run-b", input: "Second report" })),
    ];
    await entered.promise;
    expect(maximum).toBe(2);
    gate.resolve();
    expect((await Promise.all(runs)).map((result) => result.status)).toEqual(["succeeded", "succeeded"]);
    expect(maximum).toBeLessThanOrEqual(2);
  });
});
