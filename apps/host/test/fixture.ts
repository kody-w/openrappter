import { randomBytes } from "node:crypto";
import { vi } from "vitest";
import { emptyWorkspace } from "../src/storage.js";
import { createWorkService } from "../src/work.js";
import { ownerPermissions, tokenSecurity } from "../src/local.js";
import type { HostServices, Principal, ProjectionStoragePort } from "../src/ports.js";
import type { Snapshot } from "../src/contracts.js";

export const token = randomBytes(48).toString("base64url");
export const owner: Principal = { id: "test-owner", workspaceId: "test-workspace", permissions: ownerPermissions };
export class MemoryStorage implements ProjectionStoragePort {
  data = new Map<string, Snapshot>();
  private queue: Promise<unknown> = Promise.resolve();
  async initialize() {}
  async check() { return { state: "ready" as const, detail: "Injected test storage." }; }
  async read(workspace: string) { await this.queue; return structuredClone(this.data.get(workspace) ?? emptyWorkspace(workspace)); }
  transact<T>(workspace: string, update: (draft: Snapshot) => T | Promise<T>): Promise<T> {
    const next = this.queue.then(async () => {
      const draft = structuredClone(this.data.get(workspace) ?? emptyWorkspace(workspace));
      const result = await update(draft);
      draft.revision++;
      this.data.set(workspace, draft);
      return structuredClone(result);
    });
    this.queue = next.catch(() => {});
    return next;
  }
}
export function fixture(): HostServices & { storage: MemoryStorage } {
  const storage = new MemoryStorage();
  const ready = async () => ({ state: "ready" as const, detail: "Injected test service." });
  return {
    storage, security: tokenSecurity(token, owner), work: createWorkService(storage),
    runtime: {
      check: ready,
      start: vi.fn(async (_, { runId, task, agent }) => ({
        id: runId, taskId: task.id, agentId: agent.id, workspaceId: agent.workspaceId, state: "running" as const,
        startedAt: new Date().toISOString(), finishedAt: null, summary: "Accepted by injected runtime.",
        verification: "not_checked" as const, evidenceIds: [],
      })),
      cancel: vi.fn(async (_, run) => ({ ...run, state: "cancelled" as const, finishedAt: new Date().toISOString() })),
      decide: vi.fn(async () => {}),
      schedule: vi.fn(async (_, automation) => ({ nextRunAt: automation.enabled ? new Date(Date.now() + 60000).toISOString() : null })),
    },
    provider: {
      check: ready,
      async list() { return [{ id: "test-provider", name: "Test provider", configured: true, availability: "ready", authentication: "authenticated", models: ["test-model"], detail: "Injected." }]; },
      async configure(_, { id }) { return { id, name: "Test provider", configured: true, availability: "ready", authentication: "authenticated", models: ["test-model"], detail: "Injected." }; },
    },
    computer: {
      check: ready,
      async inspect() { return { state: "stopped", detail: "Injected test service.", verified: false, verifiedAt: null, evidenceIds: [], capabilities: { view: true, control: true } }; },
      async start(context) { return { ...await this.inspect(context), state: "running", verified: false }; },
      async stop(context) { return this.inspect(context); },
    },
    diagnostics: { check: ready, async snapshot() { return { capturedAt: new Date().toISOString(), entries: [] }; }, record: vi.fn() },
  };
}
export const agent = {
  id: "agent-one", name: "Operations analyst", role: "Operations", instructions: "Review assigned tasks.",
  providerId: "test-provider", model: "test-model", computerPolicy: "none" as const,
  approvalPolicy: "always" as const, enabled: true,
};
