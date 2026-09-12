import { randomUUID } from "node:crypto";
import {
  agentInputSchema, automationInputSchema, providerSchema, runSchema, settingsSchema, taskInputSchema,
  type AgentInput, type AutomationInput, type Check, type Settings, type TaskInput,
} from "./contracts.js";
import type { ProviderPort, RequestContext, RuntimePort, StoragePort, WorkPort } from "./ports.js";
import { conflict, notFound, unavailable } from "./errors.js";

export function createWorkService(storage: StoragePort): WorkPort {
  const now = () => new Date().toISOString();
  return {
    async check(): Promise<Check> { return storage.check(); },
    snapshot: ({ principal }) => storage.read(principal.workspaceId),
    createTask: (context, raw: TaskInput) => storage.transact(context.principal.workspaceId, (draft) => {
      const input = taskInputSchema.parse(raw);
      const previous = draft.tasks.find((item) => item.id === input.requestId);
      if (previous) {
        if (previous.title !== input.title || previous.instructions !== input.instructions ||
            previous.agentId !== input.agentId || previous.priority !== input.priority) {
          conflict("This request ID has already been used for another task.");
        }
        return previous;
      }
      if (input.agentId && !draft.agents.some((agent) => agent.id === input.agentId)) notFound();
      const { requestId, ...fields } = input;
      const task = { ...fields, id: requestId, state: "queued" as const, createdAt: now(), updatedAt: now() };
      draft.tasks.unshift(task);
      return task;
    }),
    assignTask: (context, input) => storage.transact(context.principal.workspaceId, (draft) => {
      const task = draft.tasks.find((item) => item.id === input.id) ?? notFound();
      if (!["queued", "failed", "cancelled"].includes(task.state)) conflict("Only inactive tasks can be reassigned.");
      if (!draft.agents.some((agent) => agent.id === input.agentId && agent.enabled)) conflict("Choose an enabled agent.");
      task.agentId = input.agentId;
      task.updatedAt = now();
      return task;
    }),
    saveAgent: (context, raw: AgentInput) => storage.transact(context.principal.workspaceId, (draft) => {
      const input = agentInputSchema.parse(raw);
      if (draft.runs.some((run) => run.agentId === input.id &&
          (run.state === "running" || run.state === "awaiting_approval"))) {
        conflict("Wait for this agent's active run to finish before changing its configuration.");
      }
      const agent = { ...input, updatedAt: now() };
      const index = draft.agents.findIndex((item) => item.id === agent.id);
      if (index === -1) draft.agents.push(agent); else draft.agents[index] = agent;
      return agent;
    }),
    saveAutomation: (context, raw: AutomationInput, runtime: RuntimePort) =>
      storage.transact(context.principal.workspaceId, async (draft) => {
        const input = automationInputSchema.parse(raw);
        if (!draft.agents.some((agent) => agent.id === input.agentId && (!input.enabled || agent.enabled))) {
          conflict("Choose an available agent for this schedule.");
        }
        const index = draft.automations.findIndex((item) => item.id === input.id);
        const previous = draft.automations[index];
        const scheduling = input.enabled || previous?.enabled
          ? await runtime.schedule(context, input) : { nextRunAt: null };
        const automation = { ...input, ...scheduling, updatedAt: now() };
        if (input.enabled && !automation.nextRunAt) {
          conflict("The runtime did not confirm a next scheduled run.");
        }
        if (index === -1) draft.automations.push(automation); else draft.automations[index] = automation;
        return automation;
      }),
    updateSettings: (context, input: Settings) => storage.transact(context.principal.workspaceId, (draft) => {
      draft.settings = settingsSchema.parse(input);
      return draft.settings;
    }),
    startRun: (context: RequestContext, id: string, runtime: RuntimePort, provider: ProviderPort) =>
      storage.transact(context.principal.workspaceId, async (draft) => {
        const task = draft.tasks.find((item) => item.id === id) ?? notFound();
        if (task.state !== "queued" && task.state !== "failed" && task.state !== "cancelled") {
          conflict("This task cannot be started in its current state.");
        }
        const agent = draft.agents.find((item) => item.id === task.agentId);
        if (!agent?.enabled) conflict("Assign an enabled agent before starting work.");
        if (!agent) return notFound();
        const providers = providerSchema.array().parse(await provider.list(context));
        const selected = providers.find((item) => item.id === agent.providerId);
        if (!selected?.configured || !selected.models.includes(agent.model)) unavailable("The agent's provider");
        if ((await runtime.check()).state !== "ready") unavailable("Runtime");
        const runId = randomUUID();
        const run = runSchema.parse(await runtime.start(context, {
          runId, task: structuredClone(task),
          agent: { ...structuredClone(agent), approvalPolicy: draft.settings.work.approvalPolicy === "always" ? "always" : agent.approvalPolicy },
          settings: structuredClone(draft.settings),
        }));
        if (run.id !== runId || run.taskId !== task.id || run.agentId !== agent.id) {
          conflict("The runtime returned an unrelated run.");
        }
        draft.runs.unshift(run);
        task.state = run.state;
        task.updatedAt = now();
        return run;
      }),
    cancelRun: (context, id, runtime) => storage.transact(context.principal.workspaceId, async (draft) => {
      const index = draft.runs.findIndex((run) => run.id === id);
      const current = draft.runs[index] ?? notFound();
      if (current.state !== "running" && current.state !== "awaiting_approval") {
        conflict("Only active runs can be cancelled.");
      }
      const cancelled = runSchema.parse(await runtime.cancel(context, structuredClone(current)));
      if (cancelled.id !== id || cancelled.taskId !== current.taskId ||
          cancelled.agentId !== current.agentId || cancelled.state !== "cancelled") {
        conflict("The runtime did not confirm cancellation of this run.");
      }
      draft.runs[index] = cancelled;
      const task = draft.tasks.find((item) => item.id === current.taskId) ?? notFound();
      task.state = "cancelled";
      task.updatedAt = now();
      return cancelled;
    }),
    decideApproval: (context, input, runtime) => storage.transact(context.principal.workspaceId, async (draft) => {
      const approval = draft.approvals.find((item) => item.id === input.id) ?? notFound();
      if (approval.state !== "pending") conflict("This approval has already been decided.");
      const run = draft.runs.find((item) => item.id === approval.runId) ?? notFound();
      if (run.state !== "awaiting_approval" || run.taskId !== approval.taskId) {
        conflict("This approval no longer belongs to a waiting run.");
      }
      await runtime.decide(context, { approval: structuredClone(approval), decision: input.decision, reason: input.reason });
      approval.state = input.decision;
      approval.decidedAt = now();
      approval.decisionReason = input.reason;
      // A decision is not evidence that execution has resumed or completed.
      return approval;
    }),
    async readArtifact() { return unavailable("Artifact content storage"); },
  };
}
