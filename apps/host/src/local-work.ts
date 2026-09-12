import { createHash, randomUUID } from "node:crypto";
import { WorkServiceAgentDefinitions, type AgentDefinition } from "@rapp-work/agent-runtime";
import { approvalFromFrames } from "@rapp-work/security";
import { isVerifiedChain } from "@rapp-work/rapp1";
import type { CommittedCommand, JsonObject, WorkspaceScope } from "@rapp-work/work-service";
import {
  agentInputSchema, agentSchema, approvalSchema, artifactSchema, automationInputSchema, automationSchema,
  runSchema, settingsSchema, snapshotSchema, taskInputSchema, taskSchema,
  type Agent, type AgentInput, type Approval, type AutomationInput, type Run, type Settings, type Snapshot, type Task,
} from "./contracts.js";
import { conflict, notFound, unavailable, HostError } from "./errors.js";
import type { ProviderPort, RequestContext, RuntimePort, StoragePort, WorkPort } from "./ports.js";
import { emptyWorkspace } from "./storage.js";
import { committed, digest, json, LocalPersistence, proofReceipt } from "./persistence.js";

export const agentScope = (agent: Agent): WorkspaceScope => ({ agentId: agent.id, workspaceId: agent.workspaceId });
export const commandKey = (operation: string, context: RequestContext): string => `${operation}/${digest(context.requestId)}`;
export function definitionFor(agent: Agent): AgentDefinition {
  return {
    id: agent.id, workspaceId: agent.workspaceId, name: agent.name, instructions: agent.instructions,
    model: agent.model || "unconfigured", enabled: agent.enabled,
    policy: {
      workspaceId: agent.workspaceId,
      allowedTools: agent.computerPolicy === "none" ? [] : agent.computerPolicy === "read-only" ? ["guest.read"] : ["guest.read", "guest.execute"],
      maxSteps: 12, maxToolCalls: 12, maxConcurrentRuns: 1, maxConcurrentTools: 1,
      maxDurationMs: 300_000, maxOutputTokens: 8192,
    },
  };
}
const succeeded = (commands: readonly ({ state: string } | CommittedCommand)[]): CommittedCommand[] =>
  commands.filter((entry): entry is CommittedCommand => entry.state === "committed" && (entry as CommittedCommand).status === "succeeded");

/** Human-facing projections are rebuilt from each agent's own verified commands. */
export class LocalWork implements WorkPort, StoragePort {
  private mutation: Promise<unknown> = Promise.resolve();
  private initialized = false;
  constructor(readonly persistence: LocalPersistence) {}
  check = () => this.persistence.check();
  subscribe: WorkPort["subscribe"] = (listener) => this.persistence.subscribe(listener);
  async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.persistence.initialize();
    const snapshot = await this.read(this.persistence.owner.catalog.workspaceId);
    for (const run of snapshot.runs.filter((item) => ["running", "awaiting_approval"].includes(item.state))) {
      await this.saveRun({ ...run, state: "unresolved", verification: "not_checked",
        summary: "The previous host stopped without a verified terminal outcome. Execution will not be replayed.",
      }, `run/interrupted/${run.id}`);
    }
    this.initialized = true;
  }
  async close(): Promise<void> {
    await this.mutation;
    await this.persistence.close();
  }
  assertContext(context: RequestContext): void {
    const owner = this.persistence.owner;
    if (context.principal.id !== owner.id || context.principal.workspaceId !== owner.catalog.workspaceId) {
      throw new HostError(-32003, "This request is not the local workspace owner.");
    }
  }
  private serialized<T>(context: RequestContext, action: () => Promise<T>): Promise<T> {
    this.assertContext(context);
    const operation = this.mutation.then(action);
    this.mutation = operation.then(() => undefined, () => undefined);
    return operation;
  }
  snapshot(context: RequestContext): Promise<Snapshot> {
    this.assertContext(context);
    return this.read(context.principal.workspaceId);
  }
  async read(workspaceId: string): Promise<Snapshot> {
    const p = this.persistence;
    const owner = p.owner;
    if (workspaceId !== owner.catalog.workspaceId) throw new HostError(-32003, "This is not the owner catalog.");
    const catalog = await p.read(owner.catalog);
    const agents = new Map<string, WorkspaceScope>();
    const tasks = new Map<string, WorkspaceScope>();
    const result = emptyWorkspace(workspaceId);
    result.ownerId = owner.id;
    for (const command of succeeded(catalog.commands)) for (const event of command.events) {
      if (event.type === "catalog.agent") {
        const scope = event.scope as unknown as WorkspaceScope;
        p.register(scope); agents.set(scope.agentId, scope);
      } else if (event.type === "catalog.task") {
        tasks.set(String(event.id), event.scope as unknown as WorkspaceScope);
      } else if (event.type === "ui.settings.saved") result.settings = settingsSchema.parse(event.settings);
    }
    const taskValues = new Map<string, Task>();
    const runValues = new Map<string, Run>();
    const approvalValues = new Map<string, Approval>();
    const artifactValues = new Map<string, Snapshot["artifacts"][number]>();
    const automationValues = new Map<string, Snapshot["automations"][number]>();
    const streams = await Promise.all([owner.catalog, ...agents.values()].map(async (scope) => ({
      scope, history: scope.workspaceId === owner.catalog.workspaceId ? catalog : await p.read(scope),
    })));
    for (const { scope, history } of streams) {
      result.revision += p.revision(scope);
      for (const command of succeeded(history.commands)) for (const event of command.events) {
        if (event.type === "ui.agent.saved") {
          const agent = agentSchema.parse(event.agent);
          this.assertOwner(scope, agent.id, agent.workspaceId);
          if (agents.get(agent.id)?.workspaceId === scope.workspaceId) {
            const previous = result.agents.findIndex((item) => item.id === agent.id);
            if (previous < 0) result.agents.push(agent); else result.agents[previous] = agent;
          }
        } else if (event.type === "ui.task.saved") {
          const task = taskSchema.parse(event.task);
          if (task.agentId !== null) this.assertOwner(scope, task.agentId, task.workspaceId!);
          else if (scope.workspaceId !== owner.catalog.workspaceId || task.workspaceId !== null) throw new Error("Unowned task.");
          if (tasks.get(task.id)?.workspaceId === scope.workspaceId) taskValues.set(task.id, task);
        } else if (event.type === "ui.run.saved") {
          const run = runSchema.parse(event.run); this.assertOwner(scope, run.agentId, run.workspaceId); runValues.set(run.id, run);
        } else if (event.type === "ui.approval.saved") {
          const approval = approvalSchema.parse(event.approval);
          this.assertOwner(scope, approval.agentId, approval.workspaceId); approvalValues.set(approval.id, approval);
        } else if (event.type === "ui.artifact.saved") {
          const artifact = artifactSchema.parse(event.artifact);
          this.assertOwner(scope, artifact.agentId, artifact.workspaceId); artifactValues.set(artifact.id, artifact);
        } else if (event.type === "ui.automation.saved") {
          const automation = automationSchema.parse(event.automation);
          this.assertOwner(scope, automation.agentId, automation.workspaceId); automationValues.set(automation.id, automation);
        }
      }
      const selected = [...approvalValues.values()].filter((item) => item.workspaceId === scope.workspaceId);
      if (selected.length) {
        const scanned = await (await p.workspace(scope)).scan();
        if (!isVerifiedChain(scanned.streams.memory) || !isVerifiedChain(scanned.streams.body)) throw new Error("Approval chains are missing.");
        for (const approval of selected) {
          const state = approvalFromFrames(scanned.streams.memory, scanned.streams.body, approval.id);
          if (state.operationHash !== approval.operationHash || state.agentId !== approval.agentId
            || state.workspaceId !== approval.workspaceId || state.taskId !== approval.taskId) throw new Error("Approval scope mismatch.");
          // A consumed receipt is authoritative; a pending UI decision never grants permission.
          approvalValues.set(approval.id, { ...approval, consumedBy: state.consumedBy });
        }
      }
    }
    result.tasks = [...taskValues.values()];
    result.runs = [...runValues.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    result.approvals = [...approvalValues.values()];
    result.artifacts = [...artifactValues.values()];
    result.automations = [...automationValues.values()];
    for (const task of result.tasks) {
      const run = result.runs.find((item) => item.taskId === task.id);
      if (run) {
        if (run.agentId !== task.agentId || run.workspaceId !== task.workspaceId) throw new Error("Run and task ownership differ.");
        task.state = run.state; task.updatedAt = run.finishedAt ?? task.updatedAt;
      }
    }
    return snapshotSchema.parse(result);
  }
  private assertOwner(scope: WorkspaceScope, agentId: string, workspaceId: string): void {
    if (scope.agentId !== agentId || scope.workspaceId !== workspaceId) throw new Error("Projection belongs to a different agent workspace.");
  }
  saveAgent(context: RequestContext, raw: AgentInput): Promise<Agent> {
    return this.serialized(context, async () => {
      const input = agentInputSchema.parse(raw);
      const p = this.persistence;
      if (input.id === p.owner.catalog.agentId || input.id === p.owner.computer.agentId
        || (input.providerId !== null && input.providerId !== "github-copilot")) conflict("Choose a supported agent and provider identity.");
      const existing = (await this.snapshot(context)).agents.find((item) => item.id === input.id);
      const key = commandKey("agent/save", context);
      const result = committed(await p.commit(p.owner.catalog, key, "host.agent.save", input, async ({ intentRef }) => {
        const current = await this.snapshot(context);
        if (current.runs.some((run) => run.agentId === input.id && ["running", "awaiting_approval", "unresolved"].includes(run.state))) {
          return { status: "failed", value: { code: "agent_busy" }, receipts: [{ kind: "no-effect" }], events: [] };
        }
        const scope = existing ? agentScope(existing) : { agentId: input.id, workspaceId: `workspace-${randomUUID()}` };
        if (!existing) await p.mint(scope);
        const agent = agentSchema.parse({ ...input, workspaceId: scope.workspaceId, updatedAt: new Date().toISOString() });
        const definition = committed(await new WorkServiceAgentDefinitions(p.work).save(
          await p.capability(scope), definitionFor(agent), `definition/${intentRef}`,
        ));
        const saved = committed(await p.commit(scope, `agent/save/${intentRef}`, "host.agent.definition", { agent: input }, async () => ({
          status: "succeeded", value: json(agent), receipts: [proofReceipt(definition)],
          events: [{ type: "ui.agent.saved", agent: json(agent) }],
        })));
        return { status: "succeeded", value: json(agent), receipts: [proofReceipt(saved)],
          events: [{ type: "catalog.agent", scope: json(scope) }] };
      }));
      p.changed("agents", input.id);
      return agentSchema.parse(result.value);
    });
  }
  createTask: WorkPort["createTask"] = (context, raw) => this.serialized(context, async () => {
    const input = taskInputSchema.parse(raw);
    const p = this.persistence;
    const result = committed(await p.commit(p.owner.catalog, `task/create/${input.requestId}`, "host.task.create", input, async ({ intentRef }) => {
      const snapshot = await this.snapshot(context);
      const agent = input.agentId ? snapshot.agents.find((item) => item.id === input.agentId) ?? notFound() : undefined;
      const scope = agent ? agentScope(agent) : p.owner.catalog;
      const { requestId, ...fields } = input;
      const task: Task = { ...fields, id: requestId, workspaceId: agent?.workspaceId ?? null,
        state: "queued", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      const saved = committed(await p.commit(scope, `task/create/${intentRef}`, "task.create", input, async () => ({
        status: "succeeded", value: json(task), receipts: [{ kind: "task-created" }],
        events: [{ type: "ui.task.saved", task: json(task) }],
      }), [{ kind: "task", id: task.id }]));
      return { status: "succeeded", value: json(task), receipts: [proofReceipt(saved)],
        events: [{ type: "catalog.task", id: task.id, scope: json(scope) }] };
    }));
    return taskSchema.parse(result.value);
  });
  assignTask: WorkPort["assignTask"] = (context, input) => this.serialized(context, async () => {
    const p = this.persistence;
    const result = committed(await p.commit(p.owner.catalog, commandKey("task/assign", context), "host.task.assign", input, async ({ intentRef }) => {
      const current = await this.snapshot(context);
      const task = current.tasks.find((item) => item.id === input.id) ?? notFound();
      const agent = current.agents.find((item) => item.id === input.agentId && item.enabled) ?? notFound();
      if (current.runs.some((run) => run.taskId === task.id)) {
        return { status: "failed", value: { code: "task_ownership_fixed_after_run" }, receipts: [{ kind: "no-effect" }], events: [] };
      }
      const scope = agentScope(agent);
      const assigned: Task = { ...task, agentId: agent.id, workspaceId: agent.workspaceId, updatedAt: new Date().toISOString() };
      const saved = committed(await p.commit(scope, `task/assign/${intentRef}`, "task.assign", input, async () => ({
        status: "succeeded", value: json(assigned), receipts: [{ kind: "owner-assignment", previousWorkspaceId: task.workspaceId }],
        events: [{ type: "ui.task.saved", task: json(assigned) }],
      }), [{ kind: "task", id: task.id }]));
      return { status: "succeeded", value: json(assigned), receipts: [proofReceipt(saved)],
        events: [{ type: "catalog.task", id: task.id, scope: json(scope) }] };
    }));
    return taskSchema.parse(result.value);
  });
  updateSettings(context: RequestContext, input: Settings): Promise<Settings> {
    return this.serialized(context, async () => {
      const settings = settingsSchema.parse(input);
      return settingsSchema.parse(committed(await this.persistence.commit(this.persistence.owner.catalog,
        commandKey("settings/update", context), "host.settings.update", settings, async () => ({
          status: "succeeded", value: json(settings), receipts: [{ kind: "settings-updated" }],
          events: [{ type: "ui.settings.saved", settings: json(settings) }],
        }))).value);
    });
  }
  startRun(context: RequestContext, id: string, runtime: RuntimePort, provider: ProviderPort): Promise<Run> {
    return this.serialized(context, async () => {
      const snapshot = await this.snapshot(context);
      const task = snapshot.tasks.find((item) => item.id === id) ?? notFound();
      const runId = digest({ requestId: context.requestId, taskId: id }).slice(0, 32);
      const previous = snapshot.runs.find((run) => run.id === runId);
      if (previous) return previous;
      if (!["queued", "failed", "cancelled"].includes(task.state)) conflict("This task is active, completed, or unresolved.");
      const agent = snapshot.agents.find((item) => item.id === task.agentId && item.enabled) ?? notFound();
      if (agent.workspaceId !== task.workspaceId) conflict("The task is not in this agent's workspace.");
      const selected = (await provider.list(context)).find((item) => item.id === agent.providerId);
      if (!selected?.configured || !selected.models.includes(agent.model)) unavailable("The agent's authenticated provider");
      return runtime.start(context, {
        runId, task, settings: snapshot.settings,
        agent: { ...agent, approvalPolicy: snapshot.settings.work.approvalPolicy === "always" ? "always" : agent.approvalPolicy },
      });
    });
  }
  async cancelRun(context: RequestContext, id: string, runtime: RuntimePort): Promise<Run> {
    this.assertContext(context);
    const run = (await this.snapshot(context)).runs.find((item) => item.id === id) ?? notFound();
    return runtime.cancel(context, run);
  }
  async decideApproval(context: RequestContext, input: Parameters<WorkPort["decideApproval"]>[1], runtime: RuntimePort): Promise<Approval> {
    this.assertContext(context);
    const current = await this.snapshot(context);
    const approval = current.approvals.find((item) => item.id === input.id) ?? notFound();
    if (approval.state === input.decision && approval.decisionReason === input.reason) return approval;
    const run = current.runs.find((item) => item.id === approval.runId) ?? notFound();
    if (run.state !== "awaiting_approval") conflict("The approval does not belong to an active waiting run.");
    await runtime.decide(context, { approval, decision: input.decision, reason: input.reason });
    return (await this.snapshot(context)).approvals.find((item) => item.id === input.id) ?? notFound();
  }
  async saveRun(run: Run, key: string, receipts: readonly JsonObject[] = [{ kind: "runtime-state" }]): Promise<Run> {
    const scope = { agentId: run.agentId, workspaceId: run.workspaceId };
    const result = committed(await this.persistence.commit(scope, key, "host.run.update", { run: json(run) }, async () => ({
      status: "succeeded", value: json(run), receipts, events: [{ type: "ui.run.saved", run: json(run) }],
    }), [{ kind: "task", id: run.taskId }, { kind: "run", id: run.id }]));
    return runSchema.parse(result.value);
  }
  async readArtifact(context: RequestContext, id: string) {
    const artifact = (await this.snapshot(context)).artifacts.find((item) => item.id === id) ?? notFound();
    const workspace = await this.persistence.workspace({ agentId: artifact.agentId, workspaceId: artifact.workspaceId });
    const bytes = await workspace.readArtifact(workspace.artifact(`${artifact.id}.data`, ["read"]));
    if (bytes.length !== artifact.bytes || digestBytes(bytes) !== artifact.sha256) throw new Error("Artifact bytes do not match canonical registration.");
    return { artifact, content: bytes.toString("utf8") };
  }
  saveAutomation(context: RequestContext, raw: AutomationInput, runtime: RuntimePort) {
    return this.serialized(context, async () => {
      const input = automationInputSchema.parse(raw);
      const snapshot = await this.snapshot(context);
      const agent = snapshot.agents.find((item) => item.id === input.agentId) ?? notFound();
      if (snapshot.automations.some((item) => item.id === input.id && item.agentId !== input.agentId)) {
        conflict("An automation belongs to one agent workspace. Create a new schedule to change ownership.");
      }
      if (input.enabled && !agent.enabled) conflict("Enable the assigned agent first.");
      const scheduling = await runtime.schedule(context, input);
      const automation = { ...input, workspaceId: agent.workspaceId, ...scheduling, updatedAt: new Date().toISOString() };
      const result = committed(await this.persistence.commit(agentScope(agent), commandKey("automation/save", context),
        "host.automation.save", input, async () => ({
          status: "succeeded", value: json(automation), receipts: [{ kind: "schedule-configured" }],
          events: [{ type: "ui.automation.saved", automation: json(automation) }],
        })));
      this.persistence.changed("automations", input.id);
      return automationSchema.parse(result.value);
    });
  }
}

export const digestBytes = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
