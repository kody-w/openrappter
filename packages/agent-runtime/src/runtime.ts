import { ModelProviderError, parseModelResponse } from "@rapp-work/model-provider";
import type { ModelMessage, ModelResponse, ToolCall } from "@rapp-work/model-provider";
import type { JsonObject, JsonValue, WorkCommand, WorkCommitResult, WorkspaceScope } from "@rapp-work/work-service";
import { abortable, Semaphore } from "./concurrency.js";
import { bounded, json, name, record, WorkServiceAgentDefinitions } from "./definitions.js";
import { AgentRuntimeError } from "./types.js";
import type {
  AgentDefinition, AuthorizedTool, RunRequest, RunResult, RuntimeDependencies,
} from "./types.js";

interface ActiveRun {
  readonly controller: AbortController;
  readonly pending: Set<Promise<unknown>>;
  readonly agentKey: string;
  policyMaxRuns?: number;
}

class UnresolvedStep extends AgentRuntimeError {
  constructor() { super("unresolved_step"); }
}

export class AgentRuntime {
  readonly definitions: WorkServiceAgentDefinitions;
  private readonly active = new Map<string, ActiveRun>();
  private readonly tools = new Map<string, AuthorizedTool>();
  private readonly toolSlots: Semaphore;

  constructor(private readonly dependencies: RuntimeDependencies) {
    if (!dependencies.work || !dependencies.provider || !Array.isArray(dependencies.tools)
      || !dependencies.limits) throw new AgentRuntimeError("missing_mandatory_port");
    const limits = dependencies.limits;
    if (!bounded(limits.maxConcurrentRuns, 64) || !bounded(limits.maxConcurrentTools, 64)
      || !bounded(limits.maxStepsPerRun, 1_000) || !bounded(limits.maxToolCallsPerRun, 1_000, 0)
      || !bounded(limits.maxDurationMs, 3_600_000) || !bounded(limits.maxOutputTokens, 131_072)) {
      throw new AgentRuntimeError("invalid_runtime_limits");
    }
    this.dependencies = { ...dependencies, limits: Object.freeze({ ...limits }) };
    for (const tool of dependencies.tools) {
      if (!tool || !name(tool.description?.name) || this.tools.has(tool.description.name)
        || typeof tool.validate !== "function" || typeof tool.execute !== "function") {
        throw new AgentRuntimeError("invalid_tool_registry");
      }
      this.tools.set(tool.description.name, {
        description: structuredClone(tool.description),
        validate: tool.validate.bind(tool),
        execute: tool.execute.bind(tool),
      });
    }
    this.toolSlots = new Semaphore(limits.maxConcurrentTools);
    this.definitions = new WorkServiceAgentDefinitions(dependencies.work);
  }

  get activeRunCount(): number { return this.active.size; }

  async settlePending(): Promise<void> {
    await Promise.allSettled([...this.active.values()].flatMap((run) => [...run.pending]));
  }

  private async track<T>(run: ActiveRun, operation: () => Promise<T>): Promise<T> {
    run.controller.signal.throwIfAborted();
    const pending = operation();
    run.pending.add(pending);
    pending.then(
      () => run.pending.delete(pending),
      () => run.pending.delete(pending),
    );
    return abortable(pending, run.controller.signal);
  }

  private command(request: RunRequest, suffix: string, operation: string, payload: JsonValue): WorkCommand {
    return {
      scope: request.scope, idempotencyKey: `run/${encodeURIComponent(request.runId)}/${suffix}`, operation, payload,
      resources: [
        { kind: "agent", id: request.scope.agentId }, { kind: "workspace", id: request.scope.workspaceId },
        { kind: "task", id: request.taskId }, { kind: "run", id: request.runId },
      ],
    };
  }

  private checkCommit(result: WorkCommitResult): asserts result is Extract<WorkCommitResult, { state: "committed" }> {
    if (result.state !== "committed") throw new UnresolvedStep();
    if (result.status === "denied") throw new AgentRuntimeError("authorization_denied");
    if (result.status === "cancelled") throw new AgentRuntimeError("cancelled");
  }

  async inspectRun(capability: object, scope: WorkspaceScope, runId: string): Promise<RunResult | undefined> {
    if (!name(runId)) throw new AgentRuntimeError("invalid_run");
    const projection = await this.dependencies.work.project<RunResult | undefined>(capability, scope, {
      initial: () => undefined,
      apply: (result, committed) => {
        if (committed.status !== "succeeded") return result;
        for (const event of committed.events) {
          if (event.runId !== runId) continue;
          if (committed.command.operation === "agent.run.start" && event.type === "agent.run.started") {
            result = { runId, status: "unresolved", reason: "run_without_terminal", steps: 0, toolCalls: 0 };
          } else if (committed.command.operation === "agent.run.finish" && event.type === "agent.run.finished") {
            if (!record(event.result) || event.result.runId !== runId
              || !["succeeded", "failed", "cancelled"].includes(String(event.result.status))
              || !bounded(event.result.steps, 1_000, 0) || !bounded(event.result.toolCalls, 1_000, 0)) {
              throw new AgentRuntimeError("invalid_run_history");
            }
            result = { ...(event.result as unknown as RunResult), proof: committed.proof };
          }
        }
        return result;
      },
    });
    return projection.value;
  }

  async run(capability: object, input: RunRequest): Promise<RunResult> {
    if (!input.scope || !name(input.scope.agentId) || !name(input.scope.workspaceId)
      || !name(input.runId) || !name(input.taskId) || typeof input.input !== "string"
      || input.input.length > 131_072) throw new AgentRuntimeError("invalid_run");
    const request: RunRequest = {
      scope: Object.freeze({ ...input.scope }), runId: input.runId, taskId: input.taskId, input: input.input,
    };
    const empty = { runId: request.runId, steps: 0, toolCalls: 0 };
    if (input.signal?.aborted) return { ...empty, status: "cancelled", reason: "cancelled_before_start" };
    const agentKey = JSON.stringify([request.scope.workspaceId, request.scope.agentId]);
    const key = JSON.stringify([request.scope.workspaceId, request.scope.agentId, request.runId]);
    if (this.active.has(key)) throw new AgentRuntimeError("run_already_active");
    if (this.active.size >= this.dependencies.limits.maxConcurrentRuns) {
      throw new AgentRuntimeError("runtime_busy");
    }
    const sameAgent = [...this.active.values()].filter((run) => run.agentKey === agentKey);
    if (sameAgent.some((run) => run.policyMaxRuns !== undefined && sameAgent.length >= run.policyMaxRuns)) {
      throw new AgentRuntimeError("agent_busy");
    }
    const active: ActiveRun = { controller: new AbortController(), pending: new Set(), agentKey };
    this.active.set(key, active);
    const cancel = () => active.controller.abort("cancelled");
    input.signal?.addEventListener("abort", cancel, { once: true });
    const began = Date.now();
    let timer = setTimeout(() => active.controller.abort("deadline_exceeded"), this.dependencies.limits.maxDurationMs);
    let started = false;
    let steps = 0;
    let toolCalls = 0;
    const signal = active.controller.signal;
    const unresolved = (reason: string): RunResult => ({
      runId: request.runId, status: "unresolved", steps, toolCalls, reason,
    });
    const finish = async (status: "succeeded" | "failed" | "cancelled", detail: { output?: string; reason?: string }, settledCancellation = false): Promise<RunResult> => {
      const result: RunResult = { runId: request.runId, status, steps, toolCalls, ...detail };
      const commit = () => this.dependencies.work.commit(capability,
        this.command(request, "finish", "agent.run.finish", result as unknown as JsonValue),
        async () => ({
          status: "succeeded", value: result as unknown as JsonValue,
          receipts: [{ kind: "runtime-terminal", runId: request.runId }],
          events: [{ type: "agent.run.finished", runId: request.runId, result: result as unknown as JsonObject }],
        }), { signal: settledCancellation ? new AbortController().signal : signal });
      const committed = settledCancellation ? await commit() : await this.track(active, commit);
      this.checkCommit(committed);
      if (committed.status !== "succeeded") throw new UnresolvedStep();
      return { ...result, proof: committed.proof, replayed: committed.replayed };
    };
    try {
      const persisted = await this.track(active, () => this.definitions.load(capability, request.scope));
      if (!persisted || !persisted.definition.enabled) throw new AgentRuntimeError("agent_not_enabled");
      const definition = persisted.definition;
      active.policyMaxRuns = definition.policy.maxConcurrentRuns;
      if (definition.policy.workspaceId !== request.scope.workspaceId) throw new AgentRuntimeError("workspace_policy_denied");
      if ([...this.active.values()].filter((run) => run.agentKey === agentKey).length > definition.policy.maxConcurrentRuns) {
        throw new AgentRuntimeError("agent_busy");
      }
      for (const allowed of definition.policy.allowedTools) {
        if (!this.tools.has(allowed)) throw new AgentRuntimeError("required_tool_unavailable");
      }
      clearTimeout(timer);
      const remaining = Math.min(definition.policy.maxDurationMs, this.dependencies.limits.maxDurationMs) - (Date.now() - began);
      if (remaining <= 0) active.controller.abort("deadline_exceeded");
      else timer = setTimeout(() => active.controller.abort("deadline_exceeded"), remaining);
      const start = await this.track(active, () => this.dependencies.work.commit(capability,
        this.command(request, "start", "agent.run.start", {
          runId: request.runId, taskId: request.taskId, input: request.input, definitionRef: persisted.revision,
        }), async () => ({
          status: "succeeded", value: { runId: request.runId },
          receipts: [{ kind: "runtime-start", definitionRef: persisted.revision }],
          events: [{ type: "agent.run.started", runId: request.runId, definitionRef: persisted.revision }],
        }), { signal }));
      this.checkCommit(start);
      if (start.status !== "succeeded") throw new UnresolvedStep();
      started = true;
      if (start.replayed) {
        const previous = await this.track(active, () => this.inspectRun(capability, request.scope, request.runId));
        return { ...(previous ?? unresolved("run_without_terminal")), replayed: true };
      }
      const messages: ModelMessage[] = [
        { role: "system", content: definition.instructions },
        { role: "user", content: request.input },
      ];
      const seenCallIds = new Set<string>();
      const maxSteps = Math.min(definition.policy.maxSteps, this.dependencies.limits.maxStepsPerRun);
      const maxCalls = Math.min(definition.policy.maxToolCalls, this.dependencies.limits.maxToolCallsPerRun);
      while (steps < maxSteps) {
        signal.throwIfAborted();
        const step = steps++;
        const response = await this.modelStep(capability, request, definition, messages, step, active);
        if (response.kind === "final") return await finish("succeeded", { output: response.text });
        if (toolCalls + response.calls.length > maxCalls) return await finish("failed", { reason: "tool_budget_exhausted" });
        for (const call of response.calls) {
          if (!definition.policy.allowedTools.includes(call.name) || !this.tools.has(call.name)) {
            return await finish("failed", { reason: "tool_policy_denied" });
          }
          if (seenCallIds.has(call.id)) return await finish("failed", { reason: "duplicate_tool_call" });
          seenCallIds.add(call.id);
          try { this.tools.get(call.name)!.validate(json(call.input)); }
          catch { return await finish("failed", { reason: "invalid_tool_input" }); }
        }
        messages.push({ role: "assistant", calls: response.calls });
        const results: ModelMessage[] = new Array(response.calls.length);
        let next = 0;
        const worker = async () => {
          while (next < response.calls.length) {
            signal.throwIfAborted();
            const index = next++;
            const call = response.calls[index]!;
            toolCalls++;
            try {
              const result = await this.toolStep(capability, request, call, step, active);
              results[index] = {
                role: "tool", callId: call.id,
                content: JSON.stringify({ status: result.status, value: result.value }),
              };
            } catch (error) {
              active.controller.abort(error instanceof UnresolvedStep ? "unresolved_step" : "tool_batch_stopped");
              throw error;
            }
          }
        };
        const concurrency = Math.min(definition.policy.maxConcurrentTools, this.dependencies.limits.maxConcurrentTools);
        await Promise.all(Array.from({ length: Math.min(concurrency, response.calls.length) }, worker));
        messages.push(...results);
      }
      return await finish("failed", { reason: "step_budget_exhausted" });
    } catch (error) {
      if (signal.aborted) {
        if (!started && active.pending.size === 0) return { ...empty, status: "cancelled", reason: "cancelled_before_start" };
        if (started && signal.reason !== "deadline_exceeded" && signal.reason !== "unresolved_step") {
          let grace: ReturnType<typeof setTimeout> | undefined;
          try {
            const settled = await Promise.race([
              Promise.allSettled([...active.pending]).then(() => true),
              new Promise<boolean>((resolve) => { grace = setTimeout(() => resolve(false), 2000); }),
            ]);
            if (settled) {
              const snapshot = await this.dependencies.work.read(capability, request.scope);
              const uncertain = snapshot.commands.some((entry) => entry.state === "unresolved"
                && entry.command.idempotencyKey.startsWith(`run/${encodeURIComponent(request.runId)}/`));
              if (!uncertain) return await finish(signal.reason === "tool_batch_stopped" ? "failed" : "cancelled",
                { reason: signal.reason === "tool_batch_stopped" ? "tool_batch_stopped" : "cancelled_after_acknowledgement" }, true);
            }
          } catch { /* Only complete, read-back outcomes can confirm cancellation. */ }
          finally { clearTimeout(grace); }
        }
        return unresolved(signal.reason === "deadline_exceeded" ? "deadline_unconfirmed" : "cancellation_unconfirmed");
      }
      if (error instanceof UnresolvedStep) return unresolved("unresolved_step");
      if (!started) throw error;
      if (active.pending.size > 0) return unresolved("effect_unconfirmed");
      try {
        return await finish(error instanceof AgentRuntimeError && error.code === "cancelled" ? "cancelled" : "failed", {
          reason: error instanceof AgentRuntimeError ? error.code : "runtime_failure",
        });
      } catch { return unresolved("terminal_unconfirmed"); }
    } finally {
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", cancel);
      // An uncooperative provider/tool retains its real concurrency slot after cancellation.
      if (active.pending.size === 0) this.active.delete(key);
      else void Promise.allSettled([...active.pending]).then(() => this.active.delete(key));
    }
  }

  private async modelStep(
    capability: object, request: RunRequest, definition: AgentDefinition,
    messages: readonly ModelMessage[], step: number, active: ActiveRun,
  ): Promise<ModelResponse> {
    const maxOutputTokens = Math.min(definition.policy.maxOutputTokens, this.dependencies.limits.maxOutputTokens);
    const descriptions = definition.policy.allowedTools.map((tool) => this.tools.get(tool)!.description);
    const result = await this.track(active, () => this.dependencies.work.commit(capability,
      this.command(request, `model:${step}`, "model.complete", {
        model: definition.model, messages: json(messages), tools: json(descriptions), maxOutputTokens,
      }), async ({ signal }) => {
        try {
          const response = parseModelResponse(await this.dependencies.provider.complete({
            model: definition.model, messages: structuredClone(messages),
            tools: structuredClone(descriptions), maxOutputTokens, signal,
          }));
          return {
            status: "succeeded", value: json(response), events: [],
            receipts: [{ kind: "model-response", provider: this.dependencies.provider.id, step }],
          };
        } catch (error) {
          if (!(error instanceof ModelProviderError)) throw error;
          return {
            status: error.code === "cancelled" ? "cancelled" : "failed",
            value: { code: error.code }, events: [],
            receipts: [{ kind: "model-error", provider: this.dependencies.provider.id, code: error.code, step }],
          };
        }
      }, { signal: active.controller.signal }));
    this.checkCommit(result);
    if (result.status !== "succeeded") throw new AgentRuntimeError("model_failed");
    return parseModelResponse(result.value);
  }

  private async toolStep(
    capability: object, request: RunRequest, call: ToolCall, step: number, active: ActiveRun,
  ): Promise<Extract<WorkCommitResult, { state: "committed" }>> {
    const tool = this.tools.get(call.name)!;
    const result = await this.track(active, () => this.dependencies.work.commit(capability,
        this.command(request, `tool:${step}:${call.id}`, "tool.execute", {
          name: call.name, input: json(call.input), callId: call.id, runId: request.runId,
        }), async (context) => this.toolSlots.run(active.controller.signal, () => tool.execute(json(call.input), {
          ...context, capability, scope: request.scope, taskId: request.taskId, runId: request.runId,
        })), { signal: active.controller.signal }));
    this.checkCommit(result);
    return result;
  }
}
