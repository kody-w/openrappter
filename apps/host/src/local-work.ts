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
  emptyOrganization, MAX_WORKSPACE_AGENTS, MAX_WORKSPACE_DEPTH, workspaceOrganizationSchema,
  type WorkspaceInput, type WorkspaceDetails, type WorkspaceSummary, type WorkspaceList,
  type WorkspaceChildren, type WorkspaceTree, type WorkspaceBreadcrumb,
} from "./contracts.js";
import { conflict, notFound, unavailable, HostError } from "./errors.js";
import type { Permission, Principal, ProviderPort, RequestContext, RuntimePort, StoragePort, WorkPort } from "./ports.js";
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
    if (!this.persistence.isHuman(context.principal)) {
      throw new HostError(-32003, "This request is not the local workspace owner.");
    }
  }
  assertConcierge(context: RequestContext): WorkspaceScope {
    this.assertOwner(context);
    if (context.workspaceId !== null) throw new HostError(-32003, "Explicit owner concierge context is required.");
    return this.persistence.owner.catalog;
  }
  assertContext(context: RequestContext, permission: Permission = "work:read"): WorkspaceScope {
    if (typeof context.workspaceId !== "string") throw new HostError(-32003, "Select an authorized business workspace.");
    if (!this.persistence.canAccess(context.principal, context.workspaceId, permission)) {
      throw new HostError(-32003, "The authenticated actor does not have this exact workspace lineage permission.");
    }
    return this.persistence.businessScope(context.workspaceId);
  }
  contextScope(context: RequestContext): WorkspaceScope {
    return context.workspaceId === null ? this.assertConcierge(context) : this.assertContext(context);
  }
  exclusive<T>(context: RequestContext, action: () => Promise<T>, concierge = false): Promise<T> {
    const scope = concierge ? this.assertConcierge(context) : this.assertContext(context);
    const lockId = concierge ? scope.workspaceId : this.persistence.workspaceInfo(scope.workspaceId).rootWorkspaceId;
    if (!concierge && this.persistence.workspaceInfo(scope.workspaceId).lineage.some((id) => this.persistence.workspaceInfo(id).status === "archived")) {
      throw new HostError(-32009, "Archived workspace lineages are read-only.");
    }
    const inherited = this.transaction.getStore();
    if (inherited?.active && inherited.workspaceId === lockId) return this.persistence.withActor(context.principal, action);
    const operation = (this.mutations.get(lockId) ?? Promise.resolve()).then(async () => {
      const transaction = { workspaceId: lockId, active: true };
      try { return await this.transaction.run(transaction, () => this.persistence.withActor(context.principal, action)); }
      finally { transaction.active = false; }
    });
    const settled = operation.then(() => undefined, () => undefined);
    this.mutations.set(lockId, settled);
    void settled.then(() => {
      if (this.mutations.get(lockId) === settled) this.mutations.delete(lockId);
    });
    return operation;
  }
  private serialized<T>(context: RequestContext, action: () => Promise<T>, permission: Permission = "work:write"): Promise<T> {
    this.assertContext(context, permission);
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
    const workspace = p.workspaceInfo(workspaceId);
    const catalog = await p.read(business);
    const agents = new Map<string, WorkspaceScope>();
    const tasks = new Map<string, WorkspaceScope>();
    const routines = new Map<string, WorkspaceScope>();
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
      } else if (event.type === "catalog.task.removed") {
        tasks.delete(String(event.id));
      } else if (event.type === "catalog.automation") {
        if (event.parentWorkspaceId !== workspaceId) throw new Error("Routine parent ownership differs.");
        routines.set(String(event.id), event.scope as unknown as WorkspaceScope);
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
          if (agents.get(agent.id)?.workspaceId === scope.workspaceId || (scope.workspaceId === workspaceId && agent.id === workspace.ownerAgentId)) {
            const previous = result.agents.findIndex((item) => item.id === agent.id);
            if (previous < 0) result.agents.push(agent); else result.agents[previous] = agent;
          }
        } else if (event.type === "ui.task.saved") {
          const task = taskSchema.parse(event.task);
          if (task.agentId !== null) this.assertAgentOwner(scope, task.agentId, task.workspaceId!);
          else if (scope.workspaceId !== workspaceId || task.workspaceId !== null) throw new Error("Unowned task.");
          if (tasks.get(task.id)?.workspaceId === scope.workspaceId) taskValues.set(task.id, task);
        } else if (event.type === "ui.run.saved") {
          const run = runSchema.parse(event.run); this.assertAgentOwner(scope, run.agentId, run.workspaceId);
          if (tasks.get(run.taskId)?.workspaceId === scope.workspaceId) runValues.set(run.id, run);
        } else if (event.type === "ui.approval.saved") {
          const approval = approvalSchema.parse(event.approval);
          this.assertAgentOwner(scope, approval.agentId, approval.workspaceId);
          if (tasks.get(approval.taskId)?.workspaceId === scope.workspaceId) approvalValues.set(approval.id, approval);
        } else if (event.type === "ui.artifact.saved") {
          const artifact = artifactSchema.parse(event.artifact);
          this.assertAgentOwner(scope, artifact.agentId, artifact.workspaceId);
          if (tasks.get(artifact.taskId)?.workspaceId === scope.workspaceId) artifactValues.set(artifact.id, artifact);
        } else if (event.type === "ui.automation.saved") {
          const automation = automationSchema.parse(event.automation);
          this.assertAgentOwner(scope, automation.agentId, automation.workspaceId);
          if (routines.get(automation.id)?.workspaceId === scope.workspaceId) automationValues.set(automation.id, automation);
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
  async children(context: RequestContext): Promise<WorkspaceChildren> {
    const parent = await this.workspace(context);
    return { parent, children: await Promise.all(this.persistence.childrenOf(parent.id)
      .filter((id) => this.persistence.canAccess(context.principal, id, "work:read"))
      .map((workspaceId) => this.workspace({ ...context, workspaceId }))) };
  }
  async tree(context: RequestContext): Promise<WorkspaceTree> {
    const base = context.workspaceId === null ? null : await this.workspace(context);
    if (!base) this.assertConcierge(context);
    const ids = this.persistence.businessIds().filter((id) => {
      const metadata = this.persistence.workspaceInfo(id);
      return (!base || base.lineage.every((parent, index) => metadata.lineage[index] === parent))
        && this.persistence.canAccess(context.principal, id, "work:read");
    });
    const nodes = await Promise.all(ids.map(async (workspaceId) => ({
      workspace: await this.workspace({ ...context, workspaceId }),
      children: this.persistence.childrenOf(workspaceId).filter((id) => ids.includes(id)),
    })));
    return { maxDepth: MAX_WORKSPACE_DEPTH, roots: nodes.filter((node) => !ids.includes(node.workspace.parentWorkspaceId ?? "")).map((node) => node.workspace.id), nodes };
  }
  async breadcrumb(context: RequestContext): Promise<WorkspaceBreadcrumb> {
    const workspace = await this.workspaceMetadata(context);
    return { workspaceId: workspace.id, ancestors: workspace.lineage.map((id) => {
      const item = this.persistence.workspaceInfo(id);
      return { id, name: item.name, ownerType: item.ownerType, ownerAgentId: item.ownerAgentId, depth: item.depth };
    }) };
  }
  async agentWorkspace(context: RequestContext, id: string): Promise<WorkspaceSummary> {
    const parent = this.assertContext(context);
    const agent = (await this.snapshot(context)).agents.find((item) => item.id === id) ?? notFound();
    if (agent.workspaceId !== parent.workspaceId) this.persistence.assertChild(agentScope(agent), parent.workspaceId);
    return this.workspace({ ...context, workspaceId: agent.workspaceId });
  }
  async agentPrincipal(context: RequestContext, id: string): Promise<Principal> {
    const parent = this.assertContext(context, "agents:write");
    const child = await this.agentWorkspace(context, id);
    const capability = await this.persistence.scopedCapability(context.principal, parent.workspaceId, "agents:write");
    return this.persistence.issueAgentPrincipal(capability, parent, child.catalogScope);
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
      if (event.type === "workspace.evolved" && selected) selected = { ...selected, organization: workspaceOrganizationSchema.parse(event.organization), updatedAt: String(event.at) };
    }
    const registered = this.persistence.workspaceInfo(scope.workspaceId);
    if (!selected || selected.ownerId !== this.persistence.owner.id || selected.id !== scope.workspaceId
      || selected.parentWorkspaceId !== registered.parentWorkspaceId || digest(selected.lineage) !== digest(registered.lineage)
      || selected.catalogScope.agentId !== scope.agentId) throw new Error("No verified workspace lineage identity.");
    return selected;
  }
  private validateAgentPolicy(agent: AgentInput, workspace: Pick<WorkspaceDetails, "computerPolicy" | "approvalPolicy">): void {
    const rank = { none: 0, "read-only": 1, control: 2 };
    if (rank[agent.computerPolicy] > rank[workspace.computerPolicy]) conflict("The agent exceeds the business computer policy.");
  }
  lineagePolicy(workspaceId: string): Pick<WorkspaceDetails, "computerPolicy" | "approvalPolicy"> {
    const lineage = this.persistence.workspaceInfo(workspaceId).lineage.map((id) => this.persistence.workspaceInfo(id));
    const rank = { none: 0, "read-only": 1, control: 2 };
    return {
      computerPolicy: lineage.reduce((policy, item) => rank[item.computerPolicy] < rank[policy] ? item.computerPolicy : policy, "control" as WorkspaceDetails["computerPolicy"]),
      approvalPolicy: lineage.some((item) => item.approvalPolicy === "always") ? "always" : "on-risk",
    };
  }
  private async persistAgent(scope: WorkspaceScope, agent: Agent, key: string, workspace?: WorkspaceSummary): Promise<CommittedCommand> {
    const p = this.persistence;
    const definition = committed(await new WorkServiceAgentDefinitions(p.work).save(
      await p.capability(scope), definitionFor(agent), `definition/${key}`,
    ));
    return committed(await p.commit(scope, `agent/save/${key}`, "host.agent.definition", { agent: json(agent) }, async (): Promise<EffectOutcome> => ({
      status: "succeeded", value: json(agent), receipts: [proofReceipt(definition)],
      events: [{ type: "ui.agent.saved", agent: json(agent) }, ...(workspace ? [{ type: "workspace.saved", workspace: json(workspace) }] : [])],
    })));
  }
  private async persistTask(scope: WorkspaceScope, input: Parameters<WorkPort["createTask"]>[1], key: string, agent?: Agent): Promise<CommittedCommand> {
    const { requestId, ...fields } = input;
    const task: Task = { ...fields, id: requestId, workspaceId: agent?.workspaceId ?? null,
      state: "queued", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    return committed(await this.persistence.commit(scope, `task/create/${key}`, "task.create", input, async (): Promise<EffectOutcome> => ({
      status: "succeeded", value: json(task), receipts: [{ kind: "task-created" }],
      events: [{ type: "ui.task.saved", task: json(task) },
        { type: "catalog.task", id: task.id, scope: json(scope), parentWorkspaceId: scope.workspaceId }],
    }), [{ kind: "task", id: task.id }]));
  }
  private childWorkspace(parent: WorkspaceSummary, agent: Agent): WorkspaceSummary {
    const now = new Date().toISOString();
    const policy = parent.approvalPolicy === "always" || agent.approvalPolicy === "always" ? "always" : "on-risk";
    return workspaceSummarySchema.parse({
      id: agent.workspaceId, ownerId: parent.ownerId, ownerType: "agent", ownerAgentId: agent.id,
      parentWorkspaceId: parent.id, rootWorkspaceId: parent.rootWorkspaceId,
      lineage: [...parent.lineage, agent.workspaceId], depth: parent.depth + 1,
      status: agent.enabled ? "active" : "paused", parentAccess: "inspect",
      catalogScope: agentScope(agent), leadAgentId: agent.id, name: agent.name,
      purpose: agent.role || `Dedicated work owned by ${agent.name}.`,
      twin: { name: `${agent.name.slice(0, 155)} Twin`,
        instructions: "Organize this agent's own workspace from conversation. Follow its owner instructions and inherited restrictions. Draft complete work for review; never act as the parent or a sibling." },
      approvalPolicy: policy, computerPolicy: agent.computerPolicy,
      organization: emptyOrganization(), revision: 0, createdAt: now, updatedAt: now,
    });
  }
  private async provisionAgent(parent: WorkspaceSummary, agent: Agent, key: string): Promise<{ workspace: WorkspaceSummary; proof: CommittedCommand }> {
    const workspace = this.childWorkspace(parent, agent);
    await this.persistence.mintWorkspace(workspace);
    const proof = committed(await this.persistence.commit(agentScope(agent), `workspace/bootstrap/${key}`, "host.workspace.bootstrap",
      { parentWorkspaceId: parent.id, agent: json(agent) }, async (): Promise<EffectOutcome> => {
        const saved = await this.persistAgent(agentScope(agent), agent, key);
        return {
          status: "succeeded", value: json(workspace), receipts: [proofReceipt(saved)],
          events: [
            { type: "workspace.saved", workspace: json(workspace) },
            { type: "twin.identity.saved", identity: json(workspace.twin), parentWorkspaceId: workspace.id },
            { type: "ui.settings.saved", settings: json({ ...emptyWorkspace(workspace.id).settings,
              workspaceName: workspace.name, work: { defaultPriority: "normal", approvalPolicy: workspace.approvalPolicy } }) },
          ],
        };
      }));
    return { workspace, proof };
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
        const leadScope = { agentId: input.leadAgent.id, workspaceId: `workspace-${randomUUID()}` };
        const now = new Date().toISOString();
        const summary = workspaceSummarySchema.parse({
          name: input.name, purpose: input.purpose, twin: input.twin,
          approvalPolicy: input.approvalPolicy, computerPolicy: input.computerPolicy,
          id: scope.workspaceId, ownerId: p.owner.id, parentWorkspaceId: null,
          ownerType: "human", ownerAgentId: null, rootWorkspaceId: scope.workspaceId,
          lineage: [scope.workspaceId], depth: 0, status: "active", parentAccess: "none", organization: emptyOrganization(),
          catalogScope: scope, leadAgentId: input.leadAgent.id, createdAt: now, updatedAt: now, revision: 0,
        });
        await p.mintWorkspace(summary);
        const agent = agentSchema.parse({ ...input.leadAgent, workspaceId: leadScope.workspaceId, updatedAt: now });
        const bootstrap = committed(await p.commit(scope, `workspace/bootstrap/${intentRef}`, "host.workspace.bootstrap",
          input, async () => {
            const child = await this.provisionAgent(summary, agent, intentRef);
            const events: JsonObject[] = [
              { type: "workspace.saved", workspace: json(summary) },
              { type: "twin.identity.saved", identity: json(input.twin), parentWorkspaceId: summary.id },
              { type: "catalog.agent", scope: json(leadScope), parentWorkspaceId: summary.id },
              { type: "catalog.workspace", workspace: json(child.workspace) },
              { type: "ui.settings.saved", settings: json({
                ...emptyWorkspace(summary.id).settings, workspaceName: input.name,
                work: { defaultPriority: "normal", approvalPolicy: input.approvalPolicy },
              }) },
            ];
            const receipts: JsonObject[] = [proofReceipt(child.proof)];
            if (input.starterTask) {
              const task = await this.persistTask(leadScope, input.starterTask, intentRef, agent);
              receipts.push(proofReceipt(task));
              events.push({ type: "catalog.task", id: input.starterTask.requestId, scope: json(leadScope), parentWorkspaceId: summary.id });
            }
            for (const routine of input.starterRoutines) {
              const automation = automationSchema.parse({
                ...routine, workspaceId: leadScope.workspaceId, originWorkspaceId: summary.id, updatedAt: now,
                nextRunAt: routine.enabled ? nextSchedule(routine, Date.now()).toISOString() : null,
              });
              const savedRoutine = committed(await p.commit(leadScope, `automation/bootstrap/${intentRef}/${routine.id}`,
                "host.automation.save", routine, async (): Promise<EffectOutcome> => ({
                  status: "succeeded", value: json(automation), receipts: [{ kind: "schedule-configured" }],
                  events: [{ type: "ui.automation.saved", automation: json(automation) },
                    { type: "catalog.automation", id: automation.id, scope: json(leadScope), parentWorkspaceId: leadScope.workspaceId }],
                })));
              receipts.push(proofReceipt(savedRoutine));
              events.push({ type: "catalog.automation", id: automation.id, scope: json(leadScope), parentWorkspaceId: summary.id });
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
    this.assertOwner(context);
    return this.serialized(context, async () => {
      const input = workspaceDetailsSchema.parse(raw);
      const current = await this.workspace(context);
      const snapshot = await this.snapshot(context);
      const rank = { none: 0, "read-only": 1, control: 2 };
      if (current.parentWorkspaceId && rank[input.computerPolicy] > rank[this.lineagePolicy(current.parentWorkspaceId).computerPolicy]) {
        conflict("A child workspace cannot exceed its ancestor computer policy.");
      }
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
    }, "settings:write");
  }
  saveAgent(context: RequestContext, raw: AgentInput): Promise<Agent> {
    return this.serialized(context, async () => {
      const input = agentInputSchema.parse(raw);
      const p = this.persistence;
      const catalog = this.assertContext(context);
      const key = commandKey("agent/save", context);
      const replay = (await p.read(catalog)).commands.find((entry) => entry.command.idempotencyKey === key);
      if (replay) {
        if (digest(replay.command.payload) !== digest(input)) conflict("This agent command ID was already used for different work.");
        return agentSchema.parse(committed(replay).value);
      }
      if (input.id === p.owner.catalog.agentId || input.id === p.owner.computer.agentId
        || (input.providerId !== null && input.providerId !== "github-copilot")) conflict("Choose a supported agent and provider identity.");
      const existing = (await this.snapshot(context)).agents.find((item) => item.id === input.id);
      const parent = await this.workspace(context);
      if (input.id === parent.ownerAgentId) conflict("An agent's owner definition is managed in its parent workspace, not by impersonating the parent.");
      if (existing?.retiredAt) conflict("A retired agent and its dedicated workspace cannot be reassigned or re-enabled.");
      if (context.parentRevision !== undefined && context.parentRevision !== parent.revision) throw new HostError(-32015, "The parent workspace basis changed.");
      if (!existing && p.hasAgent(input.id)) throw new HostError(-32003, "This agent identity is not in the selected business.");
      if (!existing && (parent.depth >= MAX_WORKSPACE_DEPTH || p.childrenOf(parent.id).length >= MAX_WORKSPACE_AGENTS)) {
        conflict("The bounded child-workspace depth or agent count has been reached.");
      }
      this.validateAgentPolicy(input, this.lineagePolicy(parent.id));
      if (context.principal.kind === "agent") {
        const owner = (await this.snapshot(context)).agents.find((agent) => agent.id === parent.ownerAgentId) ?? notFound();
        const rank = { none: 0, "read-only": 1, control: 2 };
        if (input.providerId !== owner.providerId || input.model !== owner.model || rank[input.computerPolicy] > rank[owner.computerPolicy]
          || (owner.approvalPolicy === "always" && input.approvalPolicy !== "always")) {
          throw new HostError(-32003, "Sub-agents cannot expand the owning agent's provider, model, tools or approval policy.");
        }
      }
      const result = committed(await p.commit(catalog, key, "host.agent.save", input, async ({ intentRef }): Promise<EffectOutcome> => {
        const current = await this.snapshot(context);
        const ownedRuns = existing ? (await this.read(existing.workspaceId)).runs : current.runs;
        if (ownedRuns.some((run) => run.agentId === input.id && ["running", "awaiting_approval", "unresolved"].includes(run.state))) {
          return { status: "failed", value: { code: "agent_busy" }, receipts: [{ kind: "no-effect" }], events: [] };
        }
        const scope = existing ? agentScope(existing) : { agentId: input.id, workspaceId: `workspace-${randomUUID()}` };
        const agent = agentSchema.parse({ ...input, workspaceId: scope.workspaceId, updatedAt: new Date().toISOString() });
        if (!existing) {
          const child = await this.provisionAgent(parent, agent, intentRef);
          return { status: "succeeded", value: json(agent), receipts: [proofReceipt(child.proof)], events: [
            { type: "catalog.agent", scope: json(scope), parentWorkspaceId: catalog.workspaceId },
            { type: "catalog.workspace", workspace: json(child.workspace) },
          ] };
        }
        p.assertChild(scope, catalog.workspaceId);
        const workspace = p.workspaceInfo(scope.workspaceId);
        const saved = await this.persistAgent(scope, agent, intentRef, {
          ...workspace, name: workspace.name === existing.name ? agent.name : workspace.name,
          status: agent.enabled ? "active" : "paused", updatedAt: agent.updatedAt,
        });
        return { status: "succeeded", value: json(agent), receipts: [proofReceipt(saved)],
          events: [{ type: "catalog.agent", scope: json(scope), parentWorkspaceId: catalog.workspaceId }] };
      }));
      await p.refreshCatalog();
      p.changed("agents", input.id, catalog);
      return agentSchema.parse(result.value);
    }, "agents:write");
  }
  retireAgent(context: RequestContext, id: string): Promise<Agent> {
    return this.serialized(context, async () => {
      this.assertOwner(context);
      const parent = await this.workspace(context);
      if (context.parentRevision !== undefined && context.parentRevision !== parent.revision) throw new HostError(-32015, "The parent workspace basis changed.");
      const agent = (await this.snapshot(context)).agents.find((item) => item.id === id && item.workspaceId !== parent.id) ?? notFound();
      if (agent.retiredAt) return agent;
      const workspace = this.persistence.workspaceInfo(agent.workspaceId);
      const descendants = this.persistence.businessIds().filter((child) => this.persistence.workspaceInfo(child).lineage.includes(workspace.id));
      for (const child of descendants) {
        if ((await this.read(child)).runs.some((run) => ["running", "awaiting_approval", "unresolved"].includes(run.state))) {
          conflict("Resolve active work in this lineage before retiring its owner.");
        }
      }
      const retired = { ...agent, enabled: false, retiredAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      committed(await this.persistence.commit(parent.catalogScope, commandKey("agent/retire", context), "host.agent.retire", { id },
        async ({ intentRef }): Promise<EffectOutcome> => {
          const saved = await this.persistAgent(agentScope(agent), retired, intentRef,
            { ...workspace, status: "archived", updatedAt: retired.updatedAt });
          return { status: "succeeded", value: json(retired), receipts: [proofReceipt(saved)],
            events: [{ type: "catalog.agent.retired", id, workspaceId: agent.workspaceId }] };
        }));
      await this.persistence.refreshCatalog();
      return agentSchema.parse(retired);
    }, "agents:write");
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
      const saved = committed(await p.commit(scope, `task/assign/${intentRef}`, "task.assign", input, async (): Promise<EffectOutcome> => ({
        status: "succeeded", value: json(assigned), receipts: [{ kind: "owner-assignment", previousWorkspaceId: task.workspaceId }],
        events: [{ type: "ui.task.saved", task: json(assigned) },
          { type: "catalog.task", id: task.id, scope: json(scope), parentWorkspaceId: scope.workspaceId }],
      }), [{ kind: "task", id: task.id }]));
      const receipts = [proofReceipt(saved)];
      if (task.workspaceId && task.workspaceId !== scope.workspaceId && task.workspaceId !== catalog.workspaceId) {
        const previous = { agentId: task.agentId!, workspaceId: task.workspaceId };
        const released = committed(await p.commit(previous, `task/release/${intentRef}`, "task.release", { id: task.id }, async () => ({
          status: "succeeded", value: { id: task.id }, receipts: [{ kind: "assignment-released" }],
          events: [{ type: "catalog.task.removed", id: task.id }],
        })));
        receipts.push(proofReceipt(released));
      }
      return { status: "succeeded", value: json(assigned), receipts,
        events: [{ type: "catalog.task", id: task.id, scope: json(scope), parentWorkspaceId: catalog.workspaceId }] };
    }));
    return taskSchema.parse(result.value);
  });
  updateSettings(context: RequestContext, input: Settings): Promise<Settings> {
    this.assertOwner(context);
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
    }, "settings:write");
  }
  startRun(context: RequestContext, id: string, runtime: RuntimePort, provider: ProviderPort): Promise<Run> {
    return this.serialized(context, async () => {
      this.assertContext(context, "work:write");
      if (!this.persistence.activeLineage(context.workspaceId!)) conflict("This workspace or an ancestor is paused or archived.");
      const snapshot = await this.snapshot(context);
      const task = snapshot.tasks.find((item) => item.id === id) ?? notFound();
      const runId = digest({ requestId: context.requestId, taskId: id, workspaceId: context.workspaceId }).slice(0, 32);
      const previous = snapshot.runs.find((run) => run.id === runId);
      if (previous) return previous;
      if (!["queued", "failed", "cancelled"].includes(task.state)) conflict("This task is active, completed, or unresolved.");
      const agent = snapshot.agents.find((item) => item.id === task.agentId && item.enabled) ?? notFound();
      if (!this.persistence.activeLineage(agent.workspaceId)) conflict("The assigned agent's workspace lineage is paused or archived.");
      const policy = this.lineagePolicy(context.workspaceId!);
      this.validateAgentPolicy(agent, policy);
      if (agent.workspaceId !== task.workspaceId) conflict("The task is not in this agent's workspace.");
      const selected = (await provider.list(context)).find((item) => item.id === agent.providerId);
      if (!selected?.configured || !selected.models.includes(agent.model)) unavailable("The agent's authenticated provider");
      return runtime.start(context, {
        runId, task, settings: snapshot.settings,
        agent: { ...agent, approvalPolicy: policy.approvalPolicy === "always" || snapshot.settings.work.approvalPolicy === "always" ? "always" : agent.approvalPolicy },
      });
    }, "runtime:execute");
  }
  async cancelRun(context: RequestContext, id: string, runtime: RuntimePort): Promise<Run> {
    this.assertContext(context, "runtime:execute");
    const run = (await this.snapshot(context)).runs.find((item) => item.id === id) ?? notFound();
    return runtime.cancel(context, run);
  }
  async decideApproval(context: RequestContext, input: Parameters<WorkPort["decideApproval"]>[1], runtime: RuntimePort): Promise<Approval> {
    this.assertOwner(context);
    this.assertContext(context, "work:write");
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
      if (context.principal.kind === "agent" && input.enabled) throw new HostError(-32003, "Enabled schedules require an explicit human decision.");
      const snapshot = await this.snapshot(context);
      const agent = snapshot.agents.find((item) => item.id === input.agentId) ?? notFound();
      if (snapshot.automations.some((item) => item.id === input.id && item.agentId !== input.agentId)) {
        conflict("An automation belongs to one agent workspace. Create a new schedule to change ownership.");
      }
      if (input.enabled && !agent.enabled) conflict("Enable the assigned agent first.");
      const parent = this.assertContext(context);
      const result = committed(await this.persistence.commit(parent, commandKey("automation/save", context),
        "host.automation.configure", input, async ({ intentRef }): Promise<EffectOutcome> => {
          const scheduling = await runtime.schedule(context, input);
          const automation = { ...input, workspaceId: agent.workspaceId, originWorkspaceId: parent.workspaceId,
            ...scheduling, updatedAt: new Date().toISOString() };
          const saved = committed(await this.persistence.commit(agentScope(agent), `automation/save/${intentRef}`,
            "host.automation.save", input, async (): Promise<EffectOutcome> => ({
              status: "succeeded", value: json(automation), receipts: [{ kind: "schedule-configured" }],
              events: [{ type: "ui.automation.saved", automation: json(automation) },
                { type: "catalog.automation", id: automation.id, scope: json(agentScope(agent)), parentWorkspaceId: agent.workspaceId }],
            })));
          return { status: "succeeded", value: saved.value, receipts: [proofReceipt(saved)],
            events: [{ type: "catalog.automation", id: automation.id, scope: json(agentScope(agent)), parentWorkspaceId: parent.workspaceId }] };
        }));
      this.persistence.changed("automations", input.id, agentScope(agent));
      return automationSchema.parse(result.value);
    }, "automations:write");
  }
}

export const digestBytes = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
