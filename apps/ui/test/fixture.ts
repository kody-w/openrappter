import { BridgeClient, type DesktopBridge, type WorkClient, type HostState } from "../src/client";
import {
  serviceNames, snapshotSchema, statusSchema, type Agent, type EventScope, type RpcInput, type RpcMethod, type RpcResult,
  type Snapshot, type TwinConversation, type TwinDraft, type TwinMessageRequest, type WorkspaceInput, type WorkspaceList,
  type Provider, type Computer, type Status, type TwinApplyResult,
} from "../src/model";

export const timestamp = "2026-09-12T12:00:00.000Z";
export const testAgent: Agent = {
  id: "finance-lead", name: "Operations analyst", role: "Finance operations", instructions: "Review evidence and flag exceptions.",
  providerId: "test-provider", model: "test-model", computerPolicy: "none",
  approvalPolicy: "always", enabled: true, workspaceId: "finance-execution", updatedAt: timestamp,
};
export function testWorkspace(id = "finance", name = "Finance studio"): Snapshot {
  return snapshotSchema.parse({
    ownerId: "test-owner", workspaceId: id, revision: 0, agents: [], tasks: [], runs: [], approvals: [], artifacts: [], automations: [],
    settings: { workspaceName: name, appearance: { theme: "system", density: "comfortable" },
      work: { defaultPriority: "normal", approvalPolicy: "always" }, notifications: { approvals: true, completedRuns: true } },
  });
}
export function testStatus(ready = true): Status {
  return statusSchema.parse({
    product: "RAPP Work", protocolVersion: 1, ready,
    checks: Object.fromEntries(serviceNames.map((name) => [name, { state: ready ? "ready" : "unavailable", detail: "Injected test service, not real execution." }])),
  });
}
export interface TestHostState {
  catalog: WorkspaceList;
  workspaces: Record<string, Snapshot>;
  conversations: Record<string, TwinConversation>;
  receipts: Record<string, TwinApplyResult>;
  status: Status;
  providers: Provider[];
  computer: Computer;
}
export function testHostState(names: string[] = ["Finance studio"]): TestHostState {
  const state: TestHostState = {
    catalog: { ownerId: "test-owner", conciergeWorkspaceId: "owner-catalog", workspaces: [] },
    workspaces: {}, conversations: { concierge: { workspaceId: null, revision: 7, turns: [], proposals: [], events: [] } }, receipts: {},
    status: testStatus(),
    providers: [{ id: "test-provider", name: "Injected provider", configured: true, availability: "ready",
      authentication: "authenticated", models: ["test-model"], detail: "Test-only provider. No inference is performed." }],
    computer: { state: "unavailable", detail: "No computer is connected. This test does not exercise a virtual machine.",
      verified: false, verifiedAt: null, evidenceIds: [], capabilities: { view: false, control: false } },
  };
  for (const [index, name] of names.entries()) {
    const id = index === 0 ? "finance" : `business-${index + 1}`;
    state.catalog.workspaces.push({
      id, ownerId: "test-owner", parentWorkspaceId: "owner-catalog", catalogScope: { agentId: `${id}-catalog`, workspaceId: id },
      leadAgentId: `${id}-lead`, name, purpose: `Run ${name} with clear outcomes and reviewed evidence.`,
      twin: { name: `${name} Twin`, instructions: `Help operate ${name}. Draft complete work and require human review.` },
      approvalPolicy: "always", computerPolicy: "none", revision: 0, createdAt: timestamp, updatedAt: timestamp,
    });
    state.workspaces[id] = testWorkspace(id, name);
    state.workspaces[id]!.agents.push({ ...testAgent, id: `${id}-lead`, workspaceId: `${id}-execution` });
    state.conversations[id] = { workspaceId: id, revision: 7, turns: [], proposals: [], events: [] };
  }
  return state;
}

// This entire function is serializable into a browser test. It never enters the production bundle.
export function createTestHost({ seed, install = false }: { seed: TestHostState; install?: boolean }) {
  const storageKey = "rapp-work-browser-test-only-v2";
  const state: TestHostState = install ? JSON.parse(localStorage.getItem(storageKey) ?? JSON.stringify(seed)) : structuredClone(seed);
  const calls: { method: string; params: unknown }[] = [];
  const listeners = new Set<(event: unknown) => void>();
  const subscriptions = new Map<string, string>();
  const now = () => new Date().toISOString();
  const conversation = (workspaceId: string | null) => {
    const value = state.conversations[workspaceId ?? "concierge"];
    if (!value || value.workspaceId !== workspaceId) throw new Error("Unknown conversation scope.");
    return value;
  };
  const workspace = (id: string) => {
    const value = state.workspaces[id];
    if (!value) throw new Error("Unknown workspace.");
    return value;
  };
  const persist = (workspaceId: string | null) => {
    if (install) localStorage.setItem(storageKey, JSON.stringify(state));
    for (const [subscriptionId, scope] of subscriptions) if (scope === workspaceId) for (const listener of listeners) listener({
      type: "events", subscriptionId, events: [{ id: crypto.randomUUID(), area: "work", entityId: "workspace", kind: "updated", at: now() }], cursor: "test-scoped-cursor",
    });
  };
  const event = (workspaceId: string | null, proposalId: string, kind: "accept" | "dismiss", detail: string) => {
    const current = conversation(workspaceId);
    current.events.push({ id: crypto.randomUUID(), workspaceId, proposalId, kind, actorId: state.catalog.ownerId, detail, createdAt: now() });
    current.revision++;
    persist(workspaceId);
  };
  const inputForWorkspace = (name: string): WorkspaceInput => {
    const agentId = crypto.randomUUID();
    return {
      requestId: crypto.randomUUID(), name, purpose: `Run ${name} with reviewed invoices, accountable agents, and safe daily routines.`,
      twin: { name: `${name} Twin`, instructions: "Draft complete proposals from conversation. Keep approvals explicit and retain evidence." },
      approvalPolicy: "always", computerPolicy: "none",
      leadAgent: { id: agentId, name: "Operations analyst", role: "Finance operations",
        instructions: "Review invoices, keep records, and flag exceptions for human review.", providerId: "test-provider",
        model: "test-model", computerPolicy: "none", approvalPolicy: "always", enabled: true },
      starterTask: null, starterRoutines: [],
    };
  };
  const createWorkspace = (input: WorkspaceInput) => {
    const id = `business-${crypto.randomUUID()}`;
    const summary = {
      id, ownerId: state.catalog.ownerId, parentWorkspaceId: state.catalog.conciergeWorkspaceId,
      catalogScope: { agentId: `catalog-${input.leadAgent.id}`, workspaceId: id }, leadAgentId: input.leadAgent.id,
      name: input.name, purpose: input.purpose, twin: input.twin, approvalPolicy: input.approvalPolicy,
      computerPolicy: input.computerPolicy, revision: 0, createdAt: now(), updatedAt: now(),
    };
    state.catalog.workspaces.push(summary);
    state.workspaces[id] = {
      ownerId: summary.ownerId, workspaceId: id, revision: 0,
      agents: [{ ...input.leadAgent, workspaceId: `execution-${input.leadAgent.id}`, updatedAt: now() }],
      tasks: input.starterTask ? [{ id: input.starterTask.requestId, title: input.starterTask.title,
        instructions: input.starterTask.instructions, agentId: input.leadAgent.id, workspaceId: `execution-${input.leadAgent.id}`,
        priority: input.starterTask.priority, state: "queued", createdAt: now(), updatedAt: now() }] : [],
      runs: [], approvals: [], artifacts: [], automations: input.starterRoutines.map((routine) => ({
        ...routine, workspaceId: `execution-${input.leadAgent.id}`, updatedAt: now(), nextRunAt: routine.enabled ? now() : null,
      })),
      settings: { workspaceName: input.name, appearance: { theme: "system", density: "comfortable" },
        work: { defaultPriority: "normal", approvalPolicy: input.approvalPolicy }, notifications: { approvals: true, completedRuns: true } },
    };
    state.conversations[id] = { workspaceId: id, revision: 0, turns: [], proposals: [], events: [] };
    persist(null);
    return summary;
  };
  const makeDraft = (input: TwinMessageRequest): TwinDraft => {
    const current = conversation(input.workspaceId);
    const selected = input.workspaceId ? workspace(input.workspaceId) : null;
    const text = input.message.toLowerCase();
    let kind: TwinDraft["kind"] = input.workspaceId === null ? "workspace"
      : input.target && input.target !== "auto" && input.target !== "workspace" ? input.target
      : /approval|approve|deny/.test(text) ? "approval"
      : /settings|theme|dark|density/.test(text) ? "settings"
      : /routine|every day|daily|schedule/.test(text) ? "automation"
      : /agent|analyst/.test(text) ? "agent" : "task";
    let draft: Record<string, unknown> | null;
    let missing: string[] = [];
    let summary: string;
    if (/help me plan|not sure|something useful/.test(text)) {
      kind = "clarification"; draft = null; missing = ["What outcome should the task produce?", "When do you need the result?"];
      summary = "Two details will help me draft the right work.";
    } else if (kind === "workspace") {
      const name = /retail/.test(text) ? "Retail studio" : "Finance studio";
      draft = inputForWorkspace(name); summary = `Create ${name} as an independent business workspace.`;
    } else if (kind === "task") {
      draft = { requestId: crypto.randomUUID(), title: "Review supplier invoices",
        instructions: "Compare supplier invoices with purchase orders. Report exceptions and cite source documents. Do not send payments.",
        agentId: selected!.agents[0]?.id ?? null, priority: /urgent|high priority/.test(text) ? "high" : "normal" };
      summary = "Draft an invoice review with clear evidence and no payment authority.";
    } else if (kind === "agent") {
      draft = { id: crypto.randomUUID(), name: "Finance analyst", role: "Invoice and procurement review",
        instructions: "Review supplier invoices and cite source evidence. Never initiate payments. Escalate exceptions to the owner.",
        providerId: "test-provider", model: "test-model", computerPolicy: "none", approvalPolicy: "always", enabled: true };
      summary = "Add a finance analyst with explicit responsibilities and safe defaults.";
    } else if (kind === "automation") {
      draft = { id: crypto.randomUUID(), name: "Morning finance review", taskTitle: "Review daily invoice exceptions",
        instructions: "Review new invoices, retain evidence, and report exceptions only.", agentId: selected!.agents[0]!.id,
        cadence: { kind: "daily", at: "09:00", timezone: "America/New_York" }, enabled: false };
      summary = "Save a daily 9am finance review as a disabled routine for review.";
    } else if (kind === "settings") {
      draft = { appearance: { theme: "dark", density: "compact" } };
      summary = "Use a compact dark workspace while preserving your other settings.";
    } else {
      const approval = selected!.approvals[0]!;
      draft = { approvalId: approval.id, operationHash: approval.operationHash,
        recommendation: "deny", reason: "Confirm the reviewer and the financial data scope before sending." };
      summary = "Recommend denying until the recipient and scope are confirmed.";
    }
    return { id: crypto.randomUUID(), workspaceId: input.workspaceId, kind, draft, summary,
      assistantMessage: kind === "clarification" ? "I can draft that. First, tell me the outcome and timing." : "I've drafted the details from your request. Nothing has been created or approved yet.",
      confidence: 0.93, readyForReview: kind !== "clarification", missing,
      basis: { schema: "rapp-work/twin-basis/1", ownerId: state.catalog.ownerId, workspaceId: input.workspaceId,
        revision: current.revision + 1, heads: [{ scope: { agentId: "test-catalog", workspaceId: input.workspaceId ?? "owner-catalog" },
          heads: { body: null, memory: null, swarm: null } }], optionsHash: "b".repeat(64), proposalHash: "a".repeat(64) },
      createdAt: now() };
  };
  const host = {
    state, calls, subscriptions, listeners, makeDraft,
    nextDraft: null as TwinDraft | null,
    failure: "" as string,
    content: '{"source":"Injected test evidence","result":"Review required"}',
    connection(value: HostState) { for (const listener of listeners) listener({ type: "host", ...value }); },
    async hostState() { return { state: "online", detail: "Injected test host." }; },
    onEvent(callback: (event: unknown) => void) { listeners.add(callback); return () => { listeners.delete(callback); }; },
    async request({ method, params }: { method: string; params: unknown }): Promise<unknown> {
      calls.push({ method, params });
      const input = params as Record<string, any>;
      const id = input.workspaceId as string | null;
      switch (method) {
        case "system.status": return structuredClone(state.status);
        case "workspaces.list": return structuredClone(state.catalog);
        case "workspaces.create": return createWorkspace(input as WorkspaceInput);
        case "workspaces.open": return structuredClone({ workspace: state.catalog.workspaces.find((item) => item.id === id),
          snapshot: workspace(id!), twin: conversation(id), routines: workspace(id!).automations, computer: state.computer });
        case "work.snapshot": return structuredClone(workspace(id!));
        case "twin.conversation": return structuredClone(conversation(id));
        case "providers.list": return structuredClone(state.providers);
        case "computer.inspect": return structuredClone(state.computer);
        case "diagnostics.get": return { capturedAt: now(), entries: [] };
        case "events.subscribe": {
          const subscriptionId = crypto.randomUUID(); subscriptions.set(subscriptionId, id!);
          return { subscriptionId, events: [], cursor: "test-scoped-cursor" };
        }
        case "events.unsubscribe": return { removed: subscriptions.get(input.subscriptionId) === id && subscriptions.delete(input.subscriptionId) };
        case "twin.message": {
          if (host.failure) throw new Error(host.failure);
          const current = conversation(id);
          if (input.contextRevision !== undefined && input.contextRevision !== current.revision) throw new Error("The workspace context changed. Refresh it before continuing.");
          const proposal = host.nextDraft ?? makeDraft(input as TwinMessageRequest); host.nextDraft = null;
          current.turns.push({ id: crypto.randomUUID(), workspaceId: id, role: "user", content: input.message, proposalId: null, createdAt: now() },
            { id: crypto.randomUUID(), workspaceId: id, role: "assistant", content: proposal.assistantMessage, proposalId: proposal.id, createdAt: now() });
          current.proposals.push(proposal); current.revision += 2; persist(id); return structuredClone(proposal);
        }
        case "twin.dismissProposal": event(id, input.id, "dismiss", input.reason); return structuredClone(conversation(id));
        case "twin.applyProposal": {
          if (state.receipts[input.id]) return structuredClone(state.receipts[input.id]);
          const current = conversation(id);
          const proposal = current.proposals.find((item) => item.id === input.id)!;
          if (!proposal || !proposal.readyForReview || proposal.kind === "approval" || proposal.kind === "clarification") throw new Error("Only complete non-approval proposals can be applied.");
          if (current.events.some((item) => item.proposalId === proposal.id && item.kind === "dismiss")) throw new Error("This proposal has been dismissed.");
          if (proposal.basis?.proposalHash !== input.proposalHash) throw new Error("Proposal hash mismatch.");
          if (current.revision !== Number(proposal.basis?.revision) + 1) throw new Error("This proposal is stale. Ask the Twin for a new draft.");
          const draft = input.editedDraft ?? proposal.draft;
          let result: unknown;
          if (proposal.kind === "workspace") result = createWorkspace(draft);
          else if (proposal.kind === "settings") {
            const saved = workspace(id!).settings;
            result = await host.request({ method: "settings.update", params: {
              workspaceId: id, ...saved, ...draft, appearance: { ...saved.appearance, ...draft.appearance },
              work: { ...saved.work, ...draft.work }, notifications: { ...saved.notifications, ...draft.notifications },
            } });
          } else result = await host.request({ method: proposal.kind === "task" ? "work.createTask" : proposal.kind === "agent" ? "agents.save" : "automations.save", params: { ...draft, workspaceId: id } });
          const receipt: TwinApplyResult = { id: proposal.id, workspaceId: id, kind: proposal.kind, status: "applied", result: result as Record<string, unknown>, createdAt: now() };
          state.receipts[proposal.id] = receipt; event(id, proposal.id, "accept", "Owner accepted the draft."); return structuredClone(receipt);
        }
        case "agents.save": {
          const selected = workspace(id!);
          const { workspaceId: _binding, ...fields } = input;
          const agent = { ...fields, workspaceId: selected.agents.find((item) => item.id === fields.id)?.workspaceId ?? `execution-${fields.id}`, updatedAt: now() } as Agent;
          const index = selected.agents.findIndex((item) => item.id === agent.id);
          if (index >= 0) selected.agents[index] = agent; else selected.agents.push(agent);
          selected.revision++; persist(id); return structuredClone(agent);
        }
        case "work.createTask": {
          const selected = workspace(id!);
          const { workspaceId: _binding, requestId, ...fields } = input;
          const task = { ...fields, id: requestId, workspaceId: selected.agents.find((item) => item.id === fields.agentId)?.workspaceId ?? null,
            state: "queued", createdAt: now(), updatedAt: now() } as Snapshot["tasks"][number];
          selected.tasks.push(task); selected.revision++; persist(id); return structuredClone(task);
        }
        case "work.assignTask": {
          const selected = workspace(id!), task = selected.tasks.find((item) => item.id === input.id)!;
          const agent = selected.agents.find((item) => item.id === input.agentId)!;
          if (!agent || selected.runs.some((run) => run.taskId === task.id)) throw new Error("This assignment cannot change.");
          task.agentId = agent.id; task.workspaceId = agent.workspaceId;
          selected.revision++; persist(id); return structuredClone(task);
        }
        case "automations.save": {
          const selected = workspace(id!);
          if (input.enabled && !state.status.ready) throw new Error("Scheduling runtime is not configured.");
          const { workspaceId: _binding, ...fields } = input;
          const automation = { ...fields, workspaceId: selected.agents.find((item) => item.id === fields.agentId)!.workspaceId,
            updatedAt: now(), nextRunAt: fields.enabled ? now() : null } as Snapshot["automations"][number];
          const index = selected.automations.findIndex((item) => item.id === automation.id);
          if (index >= 0) selected.automations[index] = automation; else selected.automations.push(automation);
          selected.revision++; persist(id); return structuredClone(automation);
        }
        case "settings.update": {
          const selected = workspace(id!); const { workspaceId: _binding, ...fields } = input;
          selected.settings = fields as Snapshot["settings"]; selected.revision++;
          state.catalog.workspaces.find((item) => item.id === id)!.name = selected.settings.workspaceName;
          persist(id); return structuredClone(selected.settings);
        }
        case "approvals.decide": {
          const selected = workspace(id!); const approval = selected.approvals.find((item) => item.id === input.id)!;
          if (approval.state !== "pending" || approval.consumedBy) throw new Error("This approval is no longer pending.");
          approval.state = input.decision; approval.decisionReason = input.reason; approval.decidedAt = now();
          selected.revision++; persist(id); return structuredClone(approval);
        }
        case "artifacts.read": return { artifact: structuredClone(workspace(id!).artifacts.find((item) => item.id === input.id)), content: host.content };
        case "runs.start": {
          const selected = workspace(id!); const task = selected.tasks.find((item) => item.id === input.id)!;
          const run = { id: crypto.randomUUID(), taskId: task.id, agentId: task.agentId!, workspaceId: task.workspaceId!, state: "running" as const,
            startedAt: now(), finishedAt: null, summary: "Injected test runtime accepted the task.", verification: "not_checked" as const, evidenceIds: [] };
          selected.runs.push(run); task.state = "running"; persist(id); return structuredClone(run);
        }
        case "runs.cancel": {
          const selected = workspace(id!); const run = selected.runs.find((item) => item.id === input.id)!;
          run.state = "cancelled"; run.finishedAt = now(); selected.tasks.find((item) => item.id === run.taskId)!.state = "cancelled";
          persist(id); return structuredClone(run);
        }
        default: throw new Error(`Unimplemented test method ${method}`);
      }
    },
  };
  if (install) {
    Object.defineProperty(window, "__testHost", { value: host });
    window.rappWork = { request: host.request.bind(host), onEvent: host.onEvent.bind(host), hostState: host.hostState };
  }
  return host;
}
export type TestHost = ReturnType<typeof createTestHost>;
declare global { interface Window { __testHost?: TestHost } }
export class FixtureClient implements WorkClient {
  readonly host: TestHost;
  readonly bridge: DesktopBridge;
  private client: BridgeClient;
  messageGate: Promise<void> | null = null;
  constructor(seed = testHostState()) {
    this.host = createTestHost({ seed });
    this.bridge = {
      request: async (input) => { if (input.method === "twin.message" && this.messageGate) await this.messageGate; return this.host.request(input); },
      hostState: this.host.hostState, onEvent: this.host.onEvent,
    };
    this.client = new BridgeClient(this.bridge);
  }
  get workspace() { return this.host.state.workspaces.finance!; }
  get calls() { return this.host.calls; }
  call<M extends RpcMethod>(method: M, params: RpcInput<M>): Promise<RpcResult<M>> { return this.client.call(method, params); }
  subscribe(scope: EventScope, changed: () => void) { return this.client.subscribe(scope, changed); }
  onConnection(changed: (state: HostState) => void) { return this.client.onConnection(changed); }
}
export function populatedClient(names = ["Finance studio"]) {
  const client = new FixtureClient(testHostState(names));
  const snapshot = client.workspace;
  snapshot.tasks.push({ id: "test-task", title: "Review supplier invoices", instructions: "Check invoices against purchase orders.",
    agentId: testAgent.id, workspaceId: testAgent.workspaceId, priority: "high", state: "awaiting_approval", createdAt: timestamp, updatedAt: timestamp });
  snapshot.runs.push({ id: "test-run", taskId: "test-task", agentId: testAgent.id, workspaceId: testAgent.workspaceId, state: "awaiting_approval",
    startedAt: timestamp, finishedAt: null, summary: "An external action needs your review.", verification: "not_checked", evidenceIds: [] });
  snapshot.approvals.push({ id: "test-approval", runId: "test-run", taskId: "test-task", action: "Send invoice summary",
    agentId: testAgent.id, workspaceId: testAgent.workspaceId, operationHash: "a".repeat(64), consumedBy: null, expiresAt: "2099-01-01T00:00:00.000Z",
    reason: "This action sends financial data to the reviewer.", risk: "high", state: "pending", createdAt: timestamp, decidedAt: null, decisionReason: "" });
  snapshot.artifacts.push({ id: "test-artifact", taskId: "test-task", runId: "test-run", name: "Invoice review.json",
    agentId: testAgent.id, workspaceId: testAgent.workspaceId, mediaType: "application/json", bytes: 52, createdAt: timestamp, evidence: true, sha256: "a".repeat(64) });
  return client;
}
