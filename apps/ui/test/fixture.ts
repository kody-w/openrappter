import { z } from "zod";
import { rpcContracts, serviceNames, snapshotSchema, statusSchema, type RpcInput, type RpcMethod, type RpcResult } from "../src/model";
import type { HostState, WorkClient } from "../src/client";

export const timestamp = "2026-09-11T12:00:00.000Z";
export const testAgent = {
  id: "test-agent", name: "Operations analyst", role: "Finance operations", instructions: "Review evidence and flag exceptions.",
  providerId: "test-provider", model: "test-model", computerPolicy: "none" as const,
  approvalPolicy: "always" as const, enabled: true, workspaceId: "agent-workspace", updatedAt: timestamp,
};
export function testWorkspace() {
  return snapshotSchema.parse({
    ownerId: "test-owner", workspaceId: "test-workspace", revision: 0, agents: [], tasks: [], runs: [], approvals: [], artifacts: [], automations: [],
    settings: {
      workspaceName: "Operations", appearance: { theme: "system", density: "comfortable" },
      work: { defaultPriority: "normal", approvalPolicy: "always" },
      notifications: { approvals: true, completedRuns: true },
    },
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
export class FixtureClient implements WorkClient {
  workspace = testWorkspace();
  status = testStatus();
  calls: { method: string; params: unknown }[] = [];
  connection: ((state: HostState) => void) | undefined;
  listeners = new Set<() => void>();
  content = '{"review":"Evidence from an injected test service."}';
  async call<M extends RpcMethod>(method: M, params: RpcInput<M>): Promise<RpcResult<M>> {
    this.calls.push({ method, params });
    const fields = rpcContracts[method].input.parse(params);
    let result: unknown;
    const object = fields as Record<string, unknown>;
    const now = new Date().toISOString();
    switch (method) {
      case "work.snapshot": result = structuredClone(this.workspace); break;
      case "system.status": result = this.status; break;
      case "providers.list": result = this.status.ready ? [{ id: "test-provider", name: "Injected provider", configured: true,
        availability: "ready", authentication: "authenticated", models: ["test-model"], detail: "Test service." }] : []; break;
      case "computer.inspect": result = { state: "unavailable", detail: "No computer service connected.", verified: false, verifiedAt: null, evidenceIds: [], capabilities: { view: false, control: false } }; break;
      case "diagnostics.get": result = { capturedAt: timestamp, entries: [] }; break;
      case "agents.save": {
        const input = rpcContracts["agents.save"].input.parse(params);
        const agent = { ...input, workspaceId: this.workspace.agents.find((agent) => agent.id === input.id)?.workspaceId ?? crypto.randomUUID(), updatedAt: now };
        const index = this.workspace.agents.findIndex((item) => item.id === agent.id);
        if (index === -1) this.workspace.agents.push(agent); else this.workspace.agents[index] = agent;
        result = agent; break;
      }
      case "work.createTask": {
        const input = rpcContracts["work.createTask"].input.parse(params);
        const { requestId, ...rest } = input;
        const task = { ...rest, workspaceId: this.workspace.agents.find((agent) => agent.id === rest.agentId)?.workspaceId ?? null,
          id: requestId, state: "queued" as const, createdAt: now, updatedAt: now };
        this.workspace.tasks.unshift(task); result = task; break;
      }
      case "work.assignTask": {
        const task = this.workspace.tasks.find((task) => task.id === object.id)!;
        task.agentId = String(object.agentId);
        task.workspaceId = this.workspace.agents.find((agent) => agent.id === task.agentId)!.workspaceId; result = task; break;
      }
      case "runs.start": {
        if (!this.status.ready) throw new Error("Runtime is not configured.");
        const task = this.workspace.tasks.find((task) => task.id === object.id)!;
        const run = {
          id: crypto.randomUUID(), taskId: task.id, agentId: task.agentId!, workspaceId: task.workspaceId!, state: "running" as const,
          startedAt: now, finishedAt: null, summary: "Injected runtime accepted the task.",
          verification: "not_checked" as const, evidenceIds: [],
        };
        this.workspace.runs.unshift(run); task.state = "running"; result = run; break;
      }
      case "runs.cancel": {
        const run = this.workspace.runs.find((run) => run.id === object.id)!;
        run.state = "cancelled"; run.finishedAt = now;
        this.workspace.tasks.find((task) => task.id === run.taskId)!.state = "cancelled";
        result = run; break;
      }
      case "approvals.decide": {
        const input = rpcContracts["approvals.decide"].input.parse(params);
        const approval = this.workspace.approvals.find((item) => item.id === input.id)!;
        approval.state = input.decision; approval.decisionReason = input.reason; approval.decidedAt = now;
        result = approval; break;
      }
      case "automations.save": {
        const input = rpcContracts["automations.save"].input.parse(params);
        if (input.enabled && !this.status.ready) throw new Error("Scheduling runtime is not configured.");
        const automation = { ...input, workspaceId: this.workspace.agents.find((agent) => agent.id === input.agentId)!.workspaceId,
          updatedAt: now, nextRunAt: input.enabled ? now : null };
        const index = this.workspace.automations.findIndex((item) => item.id === input.id);
        if (index === -1) this.workspace.automations.push(automation); else this.workspace.automations[index] = automation;
        result = automation; break;
      }
      case "settings.update": this.workspace.settings = rpcContracts["settings.update"].input.parse(params); result = this.workspace.settings; break;
      case "artifacts.read": result = { artifact: this.workspace.artifacts.find((item) => item.id === object.id), content: this.content }; break;
      default: throw new Error(`Unimplemented test method ${method}`);
    }
    return rpcContracts[method].output.parse(result) as RpcResult<M>;
  }
  async subscribe(_scope: unknown, changed: () => void) {
    this.listeners.add(changed);
    return () => { this.listeners.delete(changed); };
  }
  onConnection(changed: (state: HostState) => void) {
    this.connection = changed;
    return () => { this.connection = undefined; };
  }
}
export function populatedClient() {
  const client = new FixtureClient();
  client.status = testStatus(true);
  client.workspace.agents.push(testAgent);
  client.workspace.tasks.push({
    id: "test-task", title: "Review supplier invoices", instructions: "Check invoices against purchase orders.",
    agentId: testAgent.id, workspaceId: testAgent.workspaceId, priority: "high", state: "awaiting_approval", createdAt: timestamp, updatedAt: timestamp,
  });
  client.workspace.runs.push({
    id: "test-run", taskId: "test-task", agentId: testAgent.id, workspaceId: testAgent.workspaceId, state: "awaiting_approval",
    startedAt: timestamp, finishedAt: null, summary: "An external action needs your review.", verification: "not_checked", evidenceIds: [],
  });
  client.workspace.approvals.push({
    id: "test-approval", runId: "test-run", taskId: "test-task", action: "Send invoice summary",
    agentId: testAgent.id, workspaceId: testAgent.workspaceId, operationHash: "a".repeat(64), consumedBy: null,
    expiresAt: "2099-01-01T00:00:00.000Z",
    reason: "This action sends financial data to the approved reviewer.", risk: "high", state: "pending",
    createdAt: timestamp, decidedAt: null, decisionReason: "",
  });
  client.workspace.artifacts.push({
    id: "test-artifact", taskId: "test-task", runId: "test-run", name: "Invoice review.json",
    agentId: testAgent.id, workspaceId: testAgent.workspaceId,
    mediaType: "application/json", bytes: 52, createdAt: timestamp, evidence: true, sha256: "a".repeat(64),
  });
  return client;
}
export type InferredFixture = z.infer<typeof snapshotSchema>;
