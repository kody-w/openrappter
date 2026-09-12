import {
  agentInputSchema, automationInputSchema, computerSchema, rpcContracts, serviceNames, settingsSchema, snapshotSchema,
  statusSchema, taskInputSchema, twinDraftSchema, workspaceInputSchema, workspaceSummarySchema,
  type Computer, type RpcInput, type RpcMethod, type RpcResult, type Snapshot, type TwinConversation, type TwinDraft,
  type TwinMessageRequest, type TwinProposal, type WorkspaceSummary,
} from "../src/model";
import type { HostState, WorkClient } from "../src/client";

export const timestamp = "2026-09-12T12:00:00.000Z";
export const testAgent = {
  id: "test-agent", name: "Operations analyst", role: "Finance operations", instructions: "Review evidence and flag exceptions.",
  providerId: "github-copilot", model: "gpt-6-astra", computerPolicy: "none" as const,
  approvalPolicy: "always" as const, enabled: true, workspaceId: "agent-workspace", updatedAt: timestamp,
};
export function testWorkspace(id = "test-workspace", name = "Operations") {
  return snapshotSchema.parse({
    ownerId: "test-owner", workspaceId: id, revision: 0, agents: [], tasks: [], runs: [], approvals: [], artifacts: [], automations: [],
    settings: { workspaceName: name, appearance: { theme: "system", density: "comfortable" },
      work: { defaultPriority: "normal", approvalPolicy: "always" }, notifications: { approvals: true, completedRuns: true } },
  });
}
export function testStatus(ready = false) {
  return statusSchema.parse({
    product: "RAPP Work", protocolVersion: 1, ready,
    checks: Object.fromEntries(serviceNames.map((name) => [name, {
      state: ready || ["storage", "security", "work", "diagnostics"].includes(name) ? "ready" : "unavailable",
      detail: ready ? "Injected test service." : "Test adapter is not configured.",
    }])),
  });
}
export function summaryFor(snapshot: Snapshot): WorkspaceSummary {
  return workspaceSummarySchema.parse({
    id: snapshot.workspaceId, ownerId: snapshot.ownerId, parentWorkspaceId: "test-concierge",
    catalogScope: { workspaceId: snapshot.workspaceId, agentId: `twin-${snapshot.workspaceId}` },
    name: snapshot.settings.workspaceName, purpose: `Work for ${snapshot.settings.workspaceName}.`,
    twin: { name: `${snapshot.settings.workspaceName} Twin`, instructions: "Generate complete drafts for human review." },
    leadAgentId: snapshot.agents[0]?.id ?? "test-lead", approvalPolicy: snapshot.settings.work.approvalPolicy,
    computerPolicy: "control", revision: snapshot.revision, createdAt: timestamp, updatedAt: timestamp,
  });
}
const emptyConversation = (workspaceId: string | null): TwinConversation => ({ workspaceId, revision: 0, turns: [], proposals: [], events: [] });
export function draftFor(kind: Exclude<TwinProposal["kind"], "clarification">, draft: unknown, workspaceId: string | null = "test-workspace"): TwinDraft {
  return twinDraftSchema.parse({
    id: crypto.randomUUID(), workspaceId, kind, assistantMessage: "I prepared the complete draft for your review.",
    summary: "Complete proposed work; nothing has been applied.", confidence: 0.95, readyForReview: true, missing: [], draft,
    basis: {
      schema: "rapp-work/twin-basis/1", ownerId: "test-owner", workspaceId, revision: 0,
      heads: [{ scope: { agentId: "test-twin", workspaceId: workspaceId ?? "test-concierge" }, heads: { body: null, memory: null, swarm: null } }],
      proposalHash: "a".repeat(64), optionsHash: "b".repeat(64),
    }, createdAt: timestamp,
  });
}
export class FixtureClient implements WorkClient {
  workspace = testWorkspace();
  workspaces = new Map<string, Snapshot>([[this.workspace.workspaceId, this.workspace]]);
  conversations = new Map<string | null, TwinConversation>([[null, emptyConversation(null)], [this.workspace.workspaceId, emptyConversation(this.workspace.workspaceId)]]);
  status = testStatus();
  calls: { method: string; params: unknown }[] = [];
  connection: ((state: HostState) => void) | undefined;
  listeners = new Set<() => void>();
  content = '{"review":"Evidence from an injected test service."}';
  propose: ((request: TwinMessageRequest) => TwinDraft | Promise<TwinDraft>) | undefined;
  machineState: Computer["state"] = "unavailable";
  enabled = new Set<string>();
  activeLease: { workspaceId: string; id: string } | null = null;
  startGate: Promise<void> | undefined;
  addWorkspace(id: string, name: string) {
    const snapshot = testWorkspace(id, name); this.workspaces.set(id, snapshot); this.conversations.set(id, emptyConversation(id));
    return snapshot;
  }
  computer(workspaceId: string | null): Computer {
    const snapshot = workspaceId ? this.workspaces.get(workspaceId) : undefined;
    const own = this.activeLease?.workspaceId === workspaceId;
    return computerSchema.parse({
      state: this.machineState, detail: "Injected shared computer status.", verified: this.machineState === "running",
      verifiedAt: this.machineState === "running" ? timestamp : null,
      evidenceIds: this.machineState === "running" ? ["test-computer-evidence"] : [],
      capabilities: { view: this.machineState !== "unavailable" && this.machineState !== "unresolved", control: this.machineState !== "unavailable" && this.machineState !== "unresolved" },
      workspace: snapshot ? { id: snapshot.workspaceId, enabled: this.enabled.has(snapshot.workspaceId) && this.machineState === "running",
        approvalPolicy: snapshot.settings.work.approvalPolicy, computerPolicy: "control" } : null,
      lease: { state: this.machineState === "unresolved" ? "unresolved" : this.activeLease ? own ? "held" : "other-workspace" : "idle",
        id: own ? this.activeLease!.id : null, workspaceId: own ? workspaceId : null,
        agentId: own ? `twin-${workspaceId}` : null, agentWorkspaceId: own ? workspaceId : null,
        operation: this.activeLease ? "starting" : null },
      display: { state: "unavailable", detail: "No verified display stream in the injected test service." },
    });
  }
  private saveAgent(snapshot: Snapshot, raw: unknown) {
    const input = agentInputSchema.parse(raw);
    const agent = { ...input, workspaceId: snapshot.agents.find((item) => item.id === input.id)?.workspaceId ?? crypto.randomUUID(), updatedAt: timestamp };
    const index = snapshot.agents.findIndex((item) => item.id === input.id);
    if (index === -1) snapshot.agents.push(agent); else snapshot.agents[index] = agent;
    return agent;
  }
  private saveRoutine(snapshot: Snapshot, raw: unknown) {
    const input = automationInputSchema.parse(raw);
    const agent = snapshot.agents.find((item) => item.id === input.agentId);
    if (!agent) throw new Error("Agent not in this workspace.");
    const routine = { ...input, workspaceId: agent.workspaceId, updatedAt: timestamp, nextRunAt: input.enabled ? "2099-01-01T09:00:00.000Z" : null };
    const index = snapshot.automations.findIndex((item) => item.id === input.id);
    if (index === -1) snapshot.automations.push(routine); else snapshot.automations[index] = routine;
    return routine;
  }
  async call<M extends RpcMethod>(method: M, params: RpcInput<M>): Promise<RpcResult<M>> {
    this.calls.push({ method, params: structuredClone(params) });
    const fields = rpcContracts[method].input.parse(params) as Record<string, unknown>;
    const workspaceId = fields.workspaceId as string | null | undefined;
    if (workspaceId && !this.workspaces.has(workspaceId)) throw new Error("Workspace not authorized.");
    const snapshot = workspaceId ? this.workspaces.get(workspaceId) : undefined;
    const conversation = this.conversations.get(workspaceId ?? null)!;
    const { workspaceId: _workspaceId, ...data } = fields;
    let result: unknown;
    switch (method) {
      case "system.status": result = this.status; break;
      case "workspaces.list": result = { ownerId: "test-owner", conciergeWorkspaceId: "test-concierge", workspaces: [...this.workspaces.values()].map(summaryFor) }; break;
      case "workspaces.open": result = { workspace: summaryFor(snapshot!), snapshot: structuredClone(snapshot!), twin: structuredClone(conversation),
        routines: snapshot!.automations, computer: this.computer(workspaceId!) }; break;
      case "work.snapshot": result = structuredClone(snapshot); break;
      case "twin.conversation": result = structuredClone(conversation); break;
      case "providers.list": result = this.status.ready ? [{ id: "github-copilot", name: "Injected Copilot", configured: true,
        availability: "ready", authentication: "authenticated", models: ["gpt-6-astra"], detail: "Injected model service.",
        modelOptions: [{ model: "gpt-6-astra", reasoningEfforts: ["max"], maxContextWindowTokens: 1_048_576 }] }] : []; break;
      case "computer.inspect": result = this.computer(workspaceId ?? null); break;
      case "computer.start": {
        if (this.machineState === "unavailable" || this.machineState === "unresolved") throw new Error("Computer unavailable.");
        this.machineState = "starting"; this.activeLease = { workspaceId: workspaceId!, id: crypto.randomUUID() };
        this.listeners.forEach((listener) => listener());
        await this.startGate;
        this.machineState = "running"; this.activeLease = null; this.enabled.add(workspaceId!);
        this.listeners.forEach((listener) => listener());
        result = this.computer(workspaceId!); break;
      }
      case "computer.stop": this.machineState = "stopped"; this.enabled.clear(); result = this.computer(workspaceId!); break;
      case "diagnostics.get": result = { capturedAt: timestamp, entries: [] }; break;
      case "twin.message": {
        if (!this.propose) throw new Error("No injected model response; no draft was generated.");
        const request = rpcContracts["twin.message"].input.parse(params);
        const proposal = twinDraftSchema.parse(await this.propose(request));
        if (proposal.workspaceId !== workspaceId) throw new Error("Foreign proposal.");
        conversation.turns.push({ id: crypto.randomUUID(), workspaceId: workspaceId!, role: "user", content: request.message, proposalId: null, createdAt: timestamp },
          { id: crypto.randomUUID(), workspaceId: workspaceId!, role: "assistant", content: proposal.assistantMessage, proposalId: proposal.id, createdAt: timestamp });
        conversation.proposals.push(proposal);
        conversation.events.push({ id: crypto.randomUUID(), workspaceId: workspaceId!, kind: "proposal", actorId: "test-owner", proposalId: proposal.id, detail: proposal.summary, createdAt: timestamp });
        conversation.revision++; result = proposal; break;
      }
      case "twin.dismissProposal": conversation.events.push({ id: crypto.randomUUID(), workspaceId: workspaceId!, kind: "dismiss",
        actorId: "test-owner", proposalId: String(fields.id), detail: "Dismissed.", createdAt: timestamp }); result = conversation; break;
      case "twin.applyProposal": {
        const proposal = conversation.proposals.find((item) => item.id === fields.id && item.basis?.proposalHash === fields.proposalHash);
        if (!proposal || !proposal.readyForReview || proposal.kind === "approval") throw new Error("No applicable reviewed proposal.");
        const draft = (fields.editedDraft ?? proposal.draft) as Record<string, unknown>;
        let applied: unknown;
        switch (proposal.kind) {
          case "agent": {
            const { suggestedRoutines, ...input } = draft;
            applied = this.saveAgent(snapshot!, input);
            if (Array.isArray(suggestedRoutines)) for (const routine of suggestedRoutines) this.saveRoutine(snapshot!, routine);
            break;
          }
          case "task": {
            const input = taskInputSchema.parse(draft), { requestId, ...fields } = input;
            const task = { ...fields, id: requestId, workspaceId: snapshot!.agents.find((agent) => agent.id === input.agentId)?.workspaceId ?? null,
              state: "queued" as const, createdAt: timestamp, updatedAt: timestamp };
            snapshot!.tasks.unshift(task); applied = task; break;
          }
          case "automation": applied = this.saveRoutine(snapshot!, draft); break;
          case "settings": {
            const { computerPolicy: _computerPolicy, ...patch } = draft;
            snapshot!.settings = settingsSchema.parse({ ...snapshot!.settings, ...patch });
            applied = snapshot!.settings; break;
          }
          case "workspace": {
            const input = workspaceInputSchema.parse(draft), id = `business-${crypto.randomUUID()}`;
            const created = this.addWorkspace(id, input.name);
            this.saveAgent(created, input.leadAgent);
            applied = summaryFor(created); break;
          }
          default: throw new Error("No applicable draft.");
        }
        conversation.events.push({ id: crypto.randomUUID(), workspaceId: workspaceId!, kind: "accept", actorId: "test-owner",
          proposalId: proposal.id, detail: "Accepted.", createdAt: timestamp });
        result = { id: proposal.id, workspaceId: proposal.workspaceId, kind: proposal.kind, status: "applied", result: applied, createdAt: timestamp };
        break;
      }
      case "agents.save": result = this.saveAgent(snapshot!, data); break;
      case "automations.save": result = this.saveRoutine(snapshot!, data); break;
      case "work.assignTask": {
        const task = snapshot!.tasks.find((item) => item.id === data.id)!;
        const agent = snapshot!.agents.find((item) => item.id === data.agentId)!;
        task.agentId = agent.id; task.workspaceId = agent.workspaceId; result = task; break;
      }
      case "runs.start": {
        const task = snapshot!.tasks.find((item) => item.id === data.id)!;
        const run = { id: crypto.randomUUID(), taskId: task.id, agentId: task.agentId!, workspaceId: task.workspaceId!,
          state: "running" as const, startedAt: timestamp, finishedAt: null, summary: "Injected runtime accepted this work.",
          verification: "not_checked" as const, evidenceIds: [] };
        snapshot!.runs.unshift(run); task.state = "running"; result = run; break;
      }
      case "runs.cancel": {
        const run = snapshot!.runs.find((item) => item.id === data.id)!;
        run.state = "cancelled"; run.finishedAt = timestamp;
        snapshot!.tasks.find((item) => item.id === run.taskId)!.state = "cancelled"; result = run; break;
      }
      case "approvals.decide": {
        const input = rpcContracts["approvals.decide"].input.parse(params);
        const approval = snapshot!.approvals.find((item) => item.id === input.id)!;
        approval.state = input.decision; approval.decisionReason = input.reason; approval.decidedAt = timestamp; result = approval; break;
      }
      case "artifacts.read": result = { artifact: snapshot!.artifacts.find((item) => item.id === data.id), content: this.content }; break;
      default: throw new Error(`Unimplemented injected method ${method}`);
    }
    return rpcContracts[method].output.parse(result) as RpcResult<M>;
  }
  async subscribe(_workspaceId: string, _scope: unknown, changed: () => void) {
    this.listeners.add(changed); return () => { this.listeners.delete(changed); };
  }
  onConnection(changed: (state: HostState) => void) {
    this.connection = changed; return () => { this.connection = undefined; };
  }
}
export function populatedClient() {
  const client = new FixtureClient(); client.status = testStatus(true); client.workspace.agents.push(testAgent);
  client.workspace.tasks.push({
    id: "test-task", title: "Review supplier invoices", instructions: "Check invoices against purchase orders.",
    agentId: testAgent.id, workspaceId: testAgent.workspaceId, priority: "high", state: "awaiting_approval", createdAt: timestamp, updatedAt: timestamp,
  });
  client.workspace.runs.push({
    id: "test-run", taskId: "test-task", agentId: testAgent.id, workspaceId: testAgent.workspaceId, state: "awaiting_approval",
    startedAt: timestamp, finishedAt: null, summary: "An external action needs review.", verification: "not_checked", evidenceIds: [],
  });
  client.workspace.approvals.push({
    id: "test-approval", runId: "test-run", taskId: "test-task", action: "Send invoice summary",
    agentId: testAgent.id, workspaceId: testAgent.workspaceId, operationHash: "a".repeat(64), consumedBy: null,
    expiresAt: "2099-01-01T00:00:00.000Z", reason: "This action sends financial data to the approved reviewer.",
    risk: "high", state: "pending", createdAt: timestamp, decidedAt: null, decisionReason: "",
  });
  client.workspace.artifacts.push({
    id: "test-artifact", taskId: "test-task", runId: "test-run", name: "Invoice review.json",
    agentId: testAgent.id, workspaceId: testAgent.workspaceId, mediaType: "application/json",
    bytes: 52, createdAt: timestamp, evidence: true, sha256: "a".repeat(64),
  });
  return client;
}
export type InferredFixture = Snapshot;
