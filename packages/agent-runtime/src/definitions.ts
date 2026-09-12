import type { JsonObject, JsonValue, WorkCommitResult, WorkServicePort, WorkspaceScope } from "@rapp-work/work-service";
import { AgentRuntimeError } from "./types.js";
import type { AgentDefinition, PersistedAgentDefinition } from "./types.js";

export function name(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/u.test(value);
}

export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

export function bounded(value: unknown, maximum: number, minimum = 1): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

export function parseDefinition(input: unknown): AgentDefinition {
  if (!record(input) || !name(input.id) || !name(input.workspaceId) || !name(input.model)
    || typeof input.name !== "string" || input.name.length < 1 || input.name.length > 200
    || typeof input.instructions !== "string" || input.instructions.length > 32_768
    || typeof input.enabled !== "boolean" || !record(input.policy)) {
    throw new AgentRuntimeError("invalid_agent_definition");
  }
  const policy = input.policy;
  if (policy.workspaceId !== input.workspaceId || !Array.isArray(policy.allowedTools)
    || policy.allowedTools.length > 128 || !policy.allowedTools.every(name)
    || new Set(policy.allowedTools).size !== policy.allowedTools.length
    || !bounded(policy.maxSteps, 1_000) || !bounded(policy.maxToolCalls, 1_000, 0)
    || !bounded(policy.maxConcurrentRuns, 64) || !bounded(policy.maxConcurrentTools, 64)
    || !bounded(policy.maxDurationMs, 3_600_000) || !bounded(policy.maxOutputTokens, 131_072)) {
    throw new AgentRuntimeError("invalid_agent_policy");
  }
  return Object.freeze({
    id: input.id, workspaceId: input.workspaceId, name: input.name,
    instructions: input.instructions, model: input.model, enabled: input.enabled,
    policy: Object.freeze({
      workspaceId: input.workspaceId, allowedTools: Object.freeze([...policy.allowedTools]),
      maxSteps: policy.maxSteps, maxToolCalls: policy.maxToolCalls,
      maxConcurrentRuns: policy.maxConcurrentRuns, maxConcurrentTools: policy.maxConcurrentTools,
      maxDurationMs: policy.maxDurationMs, maxOutputTokens: policy.maxOutputTokens,
    }),
  });
}

export class WorkServiceAgentDefinitions {
  constructor(private readonly work: WorkServicePort) {}

  async save(capability: object, input: AgentDefinition, idempotencyKey: string): Promise<WorkCommitResult> {
    const definition = parseDefinition(input);
    const scope = { agentId: definition.id, workspaceId: definition.workspaceId };
    const data = definition as unknown as JsonObject;
    return this.work.commit(capability, {
      scope, idempotencyKey, operation: "agent.define", payload: { definition: data },
      resources: [{ kind: "agent", id: scope.agentId }, { kind: "workspace", id: scope.workspaceId }],
    }, async () => ({
      status: "succeeded", value: { agentId: definition.id }, receipts: [{ kind: "agent-definition" }],
      events: [{ type: "agent.defined", definition: data }],
    }));
  }

  async load(capability: object, scope: WorkspaceScope): Promise<PersistedAgentDefinition | undefined> {
    const projection = await this.work.project<PersistedAgentDefinition | undefined>(capability, scope, {
      initial: () => undefined,
      apply: (current, committed) => {
        if (committed.command.operation !== "agent.define" || committed.status !== "succeeded") return current;
        for (const event of committed.events) {
          if (event.type !== "agent.defined") continue;
          const definition = parseDefinition(event.definition);
          if (definition.id !== scope.agentId || definition.workspaceId !== scope.workspaceId
            || !record(committed.command.payload)
            || JSON.stringify(definition) !== JSON.stringify(parseDefinition(committed.command.payload.definition))) {
            throw new AgentRuntimeError("invalid_persisted_definition");
          }
          current = { definition, revision: committed.proof.outcomeRef, proof: committed.proof };
        }
        return current;
      },
    });
    return projection.value;
  }
}

export function json(value: unknown): JsonValue {
  const seen = new Set<object>();
  function check(input: unknown, depth: number): void {
    if (input === null || typeof input === "boolean" || typeof input === "string") return;
    if (typeof input === "number" && Number.isFinite(input)) return;
    if (depth > 32 || typeof input !== "object" || input === null || seen.has(input)
      || (!record(input) && !Array.isArray(input))) throw new AgentRuntimeError("invalid_tool_input");
    seen.add(input);
    for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(input))) {
      if (!("value" in descriptor)) throw new AgentRuntimeError("invalid_tool_input");
      check(descriptor.value, depth + 1);
    }
    seen.delete(input);
  }
  check(value, 0);
  return structuredClone(value) as JsonValue;
}
