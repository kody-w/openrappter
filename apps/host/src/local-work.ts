import { createHash, randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { WorkServiceAgentDefinitions, type AgentDefinition } from "@rapp-work/agent-runtime";
import { approvalFromFrames } from "@rapp-work/security";
import { isVerifiedChain } from "@rapp-work/rapp1";
import type { CommittedCommand, EffectOutcome, JsonObject, WorkspaceScope } from "@rapp-work/work-service";
import {
  agentInputSchema, agentSchema, approvalSchema, artifactSchema, automationInputSchema, automationSchema,
  runSchema, settingsSchema, snapshotSchema, taskInputSchema, taskSchema,
  type Agent, type AgentInput, type Approval, type AutomationInput, type Run, type Settings, type Snapshot, type Task,
  workspaceDetailsSchema, workspaceInputSchema, workspaceSummarySchema,
  type WorkspaceInput, type WorkspaceDetails, type WorkspaceSummary, type WorkspaceList,
} from "./contracts.js";
import { conflict, notFound, unavailable, HostError } from "./errors.js";
import type { ProviderPort, RequestContext, RuntimePort, StoragePort, WorkPort } from "./ports.js";
import { emptyWorkspace } from "./storage.js";
import { committed, digest, json, LocalPersistence, proofReceipt } from "./persistence.js";
import { nextSchedule } from "./cadence.js";

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
  private readonly mutations = new Map<string, Promise<unknown>>();
  private readonly transaction = new AsyncLocalStorage<{ workspaceId: string; active: boolean }>();
  private initialized = false;
  constructor(readonly persistence: LocalPersistence) {}
  check = () => this.persistence.check();
  subscribe: WorkPort["subscribe"] = (listener) => this.persistence.subscribe(listener);
  async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.persistence.initialize();
    for (const workspaceId of this.persistence.businessIds()) {
      const snapshot = await this.read(workspaceId);
      for (const run of snapshot.runs.filter((item) => ["running", "awaiting_approval"].includes(item.state))) {
        await this.saveRun({ ...run, state: "unresolved", verification: "not_checked",
          summary: "The previous host stopped without a verified terminal outcome. Execution will not be replayed.",
        }, `run/interrupted/${run.id}`);
      }
    }
    this.initialized = true;
  }
  async close(): Promise<void> {
    await Promise.all(this.mutations.values());
    await this.persistence.close();
  }
  assertOwner(context: RequestContext): void {
    const owner = this.persistence.owner;
    if (context.principal.id !== owner.id || context.principal.workspaceId !== owner.catalog.workspaceId) {
      throw new HostError(-32003, "This request is not the local workspace owner.");
    }
  }
  assertConcierge(context: RequestContext): WorkspaceScope {
    this.assertOwner(context);
    if (context.workspaceId !== null) throw new HostError(-32003, "Explicit owner concierge context is required.");
    return this.persistence.owner.catalog;
  }
  assertContext(context: RequestContext): WorkspaceScope {
    this.assertOwner(context);
    if (typeof context.workspaceId !== "string") throw new HostError(-32003, "Select an authorized business workspace.");
    return this.persistence.businessScope(context.workspaceId);
  }
  contextScope(context: RequestContext): WorkspaceScope {
    return context.workspaceId === null ? this.assertConcierge(context) : this.assertContext(context);
  }
  exclusive<T>(context: RequestContext, action: () => Promise<T>, concierge = false): Promise<T> {
    const scope = concierge ? this.assertConcierge(context) : this.assertContext(context);
    const inherited = this.transaction.getStore();
    if (inherited?.active && inherited.workspaceId === scope.workspaceId) return action();
    const operation = (this.mutations.get(scope.workspaceId) ?? Promise.resolve()).then(async () => {
      const transaction = { workspaceId: scope.workspaceId, active: true };
      try { return await this.transaction.run(transaction, action); }
      finally { transaction.active = false; }
    });
    const settled = operation.then(() => undefined, () => undefined);
    this.mutations.set(scope.workspaceId, settled);
    void settled.then(() => {
      if (this.mutations.get(scope.workspaceId) === settled) this.mutations.delete(scope.workspaceId);
    });
    return operation;
  }
  private serialized<T>(context: RequestContext, action: () => Promise<T>): Promise<T> {
    return this.exclusive(context, action);
  }
  snapshot(context: RequestContext): Promise<Snapshot> {
    this.assertContext(context);
    return this.read(context.workspaceId!);
  }
  async read(workspaceId: string): Promise<Snapshot> {
    const p = this.persistence;
    const owner = p.owner;
    const business = p.businessScope(workspaceId);
    const catalog = await p.read(business);
    const agents = new Map<string, WorkspaceScope>();
    const tasks = new Map<string, WorkspaceScope>();
    const result = emptyWorkspace(workspaceId);
    result.ownerId = owner.id;
    for (const command of succeeded(catalog.commands)) for (const event of command.events) {
      if (event.type === "catalog.agent") {
        const scope = event.scope as unknown as WorkspaceScope;
        if (event.parentWorkspaceId !== workspaceId) throw new Error("Agent parent ownership differs.");
        p.register(scope, workspaceId); p.assertChild(scope, workspaceId); agents.set(scope.agentId, scope);
      } else if (event.type === "catalog.task") {
        if (event.parentWorkspaceId !== workspaceId) throw new Error("Task parent ownership differs.");
        tasks.set(String(event.id), event.scope as unknown as WorkspaceScope);
      } else if (event.type === "ui.settings.saved") result.settings = settingsSchema.parse(event.settings);
    }
    const taskValues = new Map<string, Task>();
    const runValues = new Map<string, Run>();
    const approvalValues = new Map<string, Approval>();
    const artifactValues = new Map<string, Snapshot["artifacts"][number]>();
    const automationValues = new Map<string, Snapshot["automations"][number]>();
    const streams = await Promise.all([business, ...agents.values()].map(async (scope) => ({
      scope, history: scope.workspaceId === workspaceId ? catalog : await p.read(scope),
    })));
    for (const { scope, history } of streams) {
      result.revision += p.revision(scope);
      for (const command of succeeded(history.commands)) for (const event of command.events) {
        if (event.type === "ui.agent.saved") {
          const agent = agentSchema.parse(event.agent);
          this.assertAgentOwner(scope, agent.id, agent.workspaceId);
          if (agents.get(agent.id)?.workspaceId === scope.workspaceId) {
            const previous = result.agents.findIndex((item) => item.id === agent.id);
            if (previous < 0) result.agents.push(agent); else result.agents[previous] = agent;
          }
        } else if (event.type === "ui.task.saved") {
          const task = taskSchema.parse(event.task);
          if (task.agentId !== null) this.assertAgentOwner(scope, task.agentId, task.workspaceId!);
          else if (scope.workspaceId !== workspaceId || task.workspaceId !== null) throw new Error("Unowned task.");
          if (tasks.get(task.id)?.workspaceId === scope.workspaceId) taskValues.set(task.id, task);
        } else if (event.type === "ui.run.saved") {
          const run = runSchema.parse(event.run); this.assertAgentOwner(scope, run.agentId, run.workspaceId); runValues.set(run.id, run);
        } else if (event.type === "ui.approval.saved") {
          const approval = approvalSchema.parse(event.approval);
          this.assertAgentOwner(scope, approval.agentId, approval.workspaceId); approvalValues.set(approval.id, approval);
        } else if (event.type === "ui.artifact.saved") {
          const artifact = artifactSchema.parse(event.artifact);
          this.assertAgentOwner(scope, artifact.agentId, artifact.workspaceId); artifactValues.set(artifact.id, artifact);
        } else if (event.type === "ui.automation.saved") {
          const automation = automationSchema.parse(event.automation);
          this.assertAgentOwner(scope, automation.agentId, automation.workspaceId); automationValues.set(automation.id, automation);
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
  private assertAgentOwner(scope: WorkspaceScope, agentId: string, workspaceId: string): void {
    if (scope.agentId !== agentId || scope.workspaceId !== workspaceId) throw new Error("Projection belongs to a different agent workspace.");
  }
  async listWorkspaces(context: RequestContext): Promise<WorkspaceList> {
    this.assertConcierge(context);
    await this.persistence.refreshCatalog();
    return {
      ownerId: this.persistence.owner.id,
      conciergeWorkspaceId: this.persistence.owner.catalog.workspaceId,
      workspaces: await Promise.all(this.persistence.businessIds().map((workspaceId) => this.workspace({ ...context, workspaceId }))),
    };
  }
  async workspace(context: RequestContext): Promise<WorkspaceSummary> {
    const selected = await this.workspaceMetadata(context);
    return { ...selected, revision: (await this.read(selected.id)).revision };
  }
  async workspaceMetadata(context: RequestContext): Promise<WorkspaceSummary> {
    const scope = this.assertContext(context);
    const history = await this.persistence.read(scope);
    let selected: WorkspaceSummary | undefined;
    for (const command of succeeded(history.commands)) for (const event of command.events) {
      if (event.type === "workspace.saved") selected = workspaceSummarySchema.parse(event.workspace);
    }
    if (!selected || selected.ownerId !== context.principal.id || selected.id !== scope.workspaceId
      || selected.parentWorkspaceId !== this.persistence.owner.catalog.workspaceId
      || selected.catalogScope.agentId !== scope.agentId) throw new Error("No verified business catalog identity.");
    return selected;
  }
  private validateAgentPolicy(agent: AgentInput, workspace: Pick<WorkspaceDetails, "computerPolicy" | "approvalPolicy">): void {
    const rank = { none: 0, "read-only": 1, control: 2 };
    if (rank[agent.computerPolicy] > rank[workspace.computerPolicy]) conflict("The agent exceeds the business computer policy.");
  }
  private async persistAgent(scope: WorkspaceScope, agent: Agent, key: string): Promise<CommittedCommand> {
    const p = this.persistence;
    const definition = committed(await new WorkServiceAgentDefinitions(p.work).save(
      await p.capability(scope), definitionFor(agent), `definition/${key}`,
    ));
    return committed(await p.commit(scope, `agent/save/${key}`, "host.agent.definition", { agent: json(agent) }, async () => ({
      status: "succeeded", value: json(agent), receipts: [proofReceipt(definition)],
      events: [{ type: "ui.agent.saved", agent: json(agent) }],
    })));
  }
  private async persistTask(scope: WorkspaceScope, input: Parameters<WorkPort["createTask"]>[1], key: string, agent?: Agent): Promise<CommittedCommand> {
    const { requestId, ...fields } = input;
    const task: Task = { ...fields, id: requestId, workspaceId: agent?.workspaceId ?? null,
      state: "queued", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    return committed(await this.persistence.commit(scope, `task/create/${key}`, "task.create", input, async () => ({
      status: "succeeded", value: json(task), receipts: [{ kind: "task-created" }],
      events: [{ type: "ui.task.saved", task: json(task) }],
    }), [{ kind: "task", id: task.id }]));
  }
  createWorkspace(context: RequestContext, raw: WorkspaceInput): Promise<WorkspaceSummary> {
    return this.exclusive(context, async () => {
      const input = workspaceInputSchema.parse(raw), p = this.persistence;
      const key = `workspace/create/${input.requestId}`;
      const previous = (await p.read(p.owner.catalog)).commands.find((entry) => entry.command.idempotencyKey === key);
      if (!previous && (p.hasAgent(input.leadAgent.id)
        || (input.leadAgent.providerId !== null && input.leadAgent.providerId !== "github-copilot"))) {
        conflict("Choose a new lead identity and a supported provider.");
      }
      const result = committed(await p.commit(p.owner.catalog, key, "host.workspace.create", input, async ({ intentRef }) => {
        const scope = { agentId: `twin-${randomUUID()}`, workspaceId: `business-${randomUUID()}` };
        await p.mintBusiness(scope);
        const leadScope = { agentId: input.leadAgent.id, workspaceId: `workspace-${randomUUID()}` };
        await p.mint(leadScope, scope.workspaceId);
        const now = new Date().toISOString();
        const summary = workspaceSummarySchema.parse({
          name: input.name, purpose: input.purpose, twin: input.twin,
          approvalPolicy: input.approvalPolicy, computerPolicy: input.computerPolicy,
          id: scope.workspaceId, ownerId: p.owner.id, parentWorkspaceId: p.owner.catalog.workspaceId,
          catalogScope: scope, leadAgentId: input.leadAgent.id, createdAt: now, updatedAt: now, revision: 0,
        });
        const agent = agentSchema.parse({ ...input.leadAgent, workspaceId: leadScope.workspaceId, updatedAt: now });
        const bootstrap = committed(await p.commit(scope, `workspace/bootstrap/${intentRef}`, "host.workspace.bootstrap",
          input, async () => {
            const saved = await this.persistAgent(leadScope, agent, intentRef);
            const events: JsonObject[] = [
              { type: "workspace.saved", workspace: json(summary) },
              { type: "twin.identity.saved", identity: json(input.twin), parentWorkspaceId: summary.id },
              { type: "catalog.agent", scope: json(leadScope), parentWorkspaceId: summary.id },
              { type: "ui.settings.saved", settings: json({
                ...emptyWorkspace(summary.id).settings, workspaceName: input.name,
                work: { defaultPriority: "normal", approvalPolicy: input.approvalPolicy },
              }) },
            ];
            const receipts: JsonObject[] = [proofReceipt(saved)];
            if (input.starterTask) {
              const task = await this.persistTask(leadScope, input.starterTask, intentRef, agent);
              receipts.push(proofReceipt(task));
              events.push({ type: "catalog.task", id: input.starterTask.requestId, scope: json(leadScope), parentWorkspaceId: summary.id });
            }
            for (const routine of input.starterRoutines) {
              const automation = automationSchema.parse({
                ...routine, workspaceId: leadScope.workspaceId, updatedAt: now,
                nextRunAt: routine.enabled ? nextSchedule(routine, Date.now()).toISOString() : null,
              });
              const savedRoutine = committed(await p.commit(leadScope, `automation/bootstrap/${intentRef}/${routine.id}`,
                "host.automation.save", routine, async () => ({
                  status: "succeeded", value: json(automation), receipts: [{ kind: "schedule-configured" }],
                  events: [{ type: "ui.automation.saved", automation: json(automation) }],
                })));
              receipts.push(proofReceipt(savedRoutine));
            }
            return { status: "succeeded", value: json(summary), events, receipts };
          }));
        return {
          status: "succeeded", value: json(summary), receipts: [proofReceipt(bootstrap)],
          events: [{ type: "catalog.workspace", workspace: json(summary) }],
        };
      }));
      try {
        await p.refreshCatalog();
        return await this.workspace({ ...context, workspaceId: workspaceSummarySchema.parse(result.value).id });
      } catch {
        throw new HostError(-32012, "Workspace publication read-back is unresolved. Creation will not be replayed.");
      }
    }, true);
  }
  updateWorkspace(context: RequestContext, raw: WorkspaceDetails): Promise<WorkspaceSummary> {
    return this.serialized(context, async () => {
      const input = workspaceDetailsSchema.parse(raw);
      const current = await this.workspace(context);
      const snapshot = await this.snapshot(context);
      const rank = { none: 0, "read-only": 1, control: 2 };
      if (snapshot.runs.some((run) => ["running", "awaiting_approval", "unresolved"].includes(run.state)
        && rank[snapshot.agents.find((agent) => agent.id === run.agentId)!.computerPolicy] > rank[input.computerPolicy])) {
        conflict("Resolve active work before reducing its computer policy.");
      }
      const workspace = { ...current, ...input, updatedAt: new Date().toISOString() };
      committed(await this.persistence.commit(this.assertContext(context), commandKey("workspace/update", context),
        "host.workspace.update", input, async (): Promise<EffectOutcome> => ({
          status: "succeeded", value: json(workspace), receipts: [{ kind: "workspace-updated" }],
          events: [
            { type: "workspace.saved", workspace: json(workspace) },
            { type: "twin.identity.saved", identity: json(input.twin), parentWorkspaceId: workspace.id },
            { type: "ui.settings.saved", settings: json({
              ...snapshot.settings, workspaceName: workspace.name,
              work: { ...snapshot.settings.work, approvalPolicy: workspace.approvalPolicy },
            }) },
          ],
        })));
      return this.workspace(context);
    });
  }
  saveAgent(context: RequestContext, raw: AgentInput): Promise<Agent> {
    return this.serialized(context, async () => {
      const input = agentInputSchema.parse(raw);
      const p = this.persistence;
      const catalog = this.assertContext(context);
      if (input.id === p.owner.catalog.agentId || input.id === p.owner.computer.agentId
        || (input.providerId !== null && input.providerId !== "github-copilot")) conflict("Choose a supported agent and provider identity.");
      const existing = (await this.snapshot(context)).agents.find((item) => item.id === input.id);
      if (!existing && p.hasAgent(input.id)) throw new HostError(-32003, "This agent identity is not in the selected business.");
      this.validateAgentPolicy(input, await this.workspace(context));
      const key = commandKey("agent/save", context);
      const result = committed(await p.commit(catalog, key, "host.agent.save", input, async ({ intentRef }) => {
        const current = await this.snapshot(context);
        if (current.runs.some((run) => run.agentId === input.id && ["running", "awaiting_approval", "unresolved"].includes(run.state))) {
          return { status: "failed", value: { code: "agent_busy" }, receipts: [{ kind: "no-effect" }], events: [] };
        }
        const scope = existing ? agentScope(existing) : { agentId: input.id, workspaceId: `workspace-${randomUUID()}` };
        if (!existing) await p.mint(scope, catalog.workspaceId);
        const agent = agentSchema.parse({ ...input, workspaceId: scope.workspaceId, updatedAt: new Date().toISOString() });
        const saved = await this.persistAgent(scope, agent, intentRef);
        return { status: "succeeded", value: json(agent), receipts: [proofReceipt(saved)],
          events: [{ type: "catalog.agent", scope: json(scope), parentWorkspaceId: catalog.workspaceId }] };
      }));
      p.changed("agents", input.id, catalog);
      return agentSchema.parse(result.value);
    });
  }
  createTask: WorkPort["createTask"] = (context, raw) => this.serialized(context, async () => {
    const input = taskInputSchema.parse(raw);
    const p = this.persistence;
    const catalog = this.assertContext(context);
    const snapshot = await this.snapshot(context);
    const agent = input.agentId ? snapshot.agents.find((item) => item.id === input.agentId) ?? notFound() : undefined;
    const result = committed(await p.commit(catalog, `task/create/${input.requestId}`, "host.task.create", input, async ({ intentRef }) => {
      const scope = agent ? agentScope(agent) : catalog;
      const saved = await this.persistTask(scope, input, intentRef, agent);
      return { status: "succeeded", value: saved.value, receipts: [proofReceipt(saved)],
        events: [{ type: "catalog.task", id: input.requestId, scope: json(scope), parentWorkspaceId: catalog.workspaceId }] };
    }));
    return taskSchema.parse(result.value);
  });
  assignTask: WorkPort["assignTask"] = (context, input) => this.serialized(context, async () => {
    const p = this.persistence;
    const catalog = this.assertContext(context);
    const selected = await this.snapshot(context);
    if (!selected.tasks.some((item) => item.id === input.id) || !selected.agents.some((item) => item.id === input.agentId)) notFound();
    const result = committed(await p.commit(catalog, commandKey("task/assign", context), "host.task.assign", input, async ({ intentRef }) => {
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
        events: [{ type: "catalog.task", id: task.id, scope: json(scope), parentWorkspaceId: catalog.workspaceId }] };
    }));
    return taskSchema.parse(result.value);
  });
  updateSettings(context: RequestContext, input: Settings): Promise<Settings> {
    return this.serialized(context, async () => {
      const settings = settingsSchema.parse(input);
      const workspace = await this.workspace(context);
      return settingsSchema.parse(committed(await this.persistence.commit(this.assertContext(context),
        commandKey("settings/update", context), "host.settings.update", settings, async (): Promise<EffectOutcome> => ({
          status: "succeeded", value: json(settings), receipts: [{ kind: "settings-updated" }],
          events: [
            { type: "ui.settings.saved", settings: json(settings) },
            { type: "workspace.saved", workspace: json({ ...workspace, name: settings.workspaceName,
              approvalPolicy: settings.work.approvalPolicy, updatedAt: new Date().toISOString() }) },
          ],
        }))).value);
    });
  }
  startRun(context: RequestContext, id: string, runtime: RuntimePort, provider: ProviderPort): Promise<Run> {
    return this.serialized(context, async () => {
      const snapshot = await this.snapshot(context);
      const task = snapshot.tasks.find((item) => item.id === id) ?? notFound();
      const runId = digest({ requestId: context.requestId, taskId: id, workspaceId: context.workspaceId }).slice(0, 32);
      const previous = snapshot.runs.find((run) => run.id === runId);
      if (previous) return previous;
      if (!["queued", "failed", "cancelled"].includes(task.state)) conflict("This task is active, completed, or unresolved.");
      const agent = snapshot.agents.find((item) => item.id === task.agentId && item.enabled) ?? notFound();
      this.validateAgentPolicy(agent, await this.workspace(context));
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
      this.persistence.changed("automations", input.id, agentScope(agent));
      return automationSchema.parse(result.value);
    });
  }
}

export const digestBytes = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
