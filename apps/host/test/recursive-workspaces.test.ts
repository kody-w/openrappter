import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isVerifiedChain } from "@rapp-work/rapp1";
import { MAX_WORKSPACE_AGENTS, MAX_WORKSPACE_DEPTH, twinEvolutionEventSchema, workspaceSummarySchema } from "../src/contracts.js";
import { agentScope } from "../src/local-work.js";
import { agentInput, productionFixture, until, workspaceInput } from "./production-fixture.js";

type Fixture = Awaited<ReturnType<typeof productionFixture>>;
const fixtures: Fixture[] = [];
afterEach(async () => { for (const f of fixtures.splice(0)) await f.close(); });
async function setup(directory?: string) {
  const f = await productionFixture(directory ? { directory } : {}); fixtures.push(f); return f;
}
async function rpcAs(f: Fixture, token: string, method: string, params: unknown) {
  const result = await fetch(`http://127.0.0.1:${f.host.port}/rpc`, {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: randomUUID(), method, params }),
  });
  return result.json() as Promise<{ result?: any; error?: { code: number; message: string } }>;
}
function blockCatalogRead(f: Fixture, workspaceId: string) {
  const persistence = f.services.persistence as unknown as {
    readCatalogSource(scope: { agentId: string; workspaceId: string }): Promise<unknown>;
  };
  const original = persistence.readCatalogSource.bind(persistence);
  let reached!: () => void, release!: () => void;
  const waiting = new Promise<void>((resolve) => { reached = resolve; });
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  let selected = false;
  const spy = vi.spyOn(persistence, "readCatalogSource").mockImplementation(async (scope) => {
    const history = await original(scope);
    if (!selected && scope.workspaceId === workspaceId) {
      selected = true; reached(); await blocked;
    }
    return history;
  });
  return { waiting, release, restore: () => spy.mockRestore() };
}
const hasCatalogAgent = (history: Awaited<ReturnType<Fixture["services"]["persistence"]["read"]>>, id: string) =>
  history.commands.some((command) => command.state === "committed" && command.status === "succeeded"
    && command.events.some((event) => event.type === "catalog.agent"
      && (event.scope as { agentId?: string }).agentId === id));
const hasArchivedWorkspace = (history: Awaited<ReturnType<Fixture["services"]["persistence"]["read"]>>) =>
  history.commands.some((command) => command.state === "committed" && command.status === "succeeded"
    && command.events.some((event) => event.type === "workspace.saved"
      && (event.workspace as { status?: string }).status === "archived"));

describe("recursive canonical workspace lineage", () => {
  it("creates one unique dedicated child per agent, supports recursive sub-agents, and rejects sibling/ancestor impersonation", async () => {
    const f = await setup(), p = f.services.persistence, root = f.workspace!;
    const a = await f.services.work.saveAgent(f.context(), { ...agentInput("agent-alpha"), model: "gpt-6-astra" });
    const b = await f.services.work.saveAgent(f.context(), { ...agentInput("agent-beta"), model: "gpt-6-astra" });
    const child = workspaceSummarySchema.parse((await f.rpc("agents.openWorkspace", { id: a.id })).result);
    expect(child).toMatchObject({ id: a.workspaceId, ownerType: "agent", ownerAgentId: a.id,
      parentWorkspaceId: root.id, rootWorkspaceId: root.id, depth: 1, lineage: [root.id, a.workspaceId] });
    const session = await f.services.createAgentSession(f.context(), a.id);
    const actor = { principal: session.principal, workspaceId: child.id, requestId: randomUUID() };
    const sub = await f.services.work.saveAgent(actor, { ...agentInput("alpha-sub-agent"), model: "gpt-6-astra" });
    const grandchild = await f.services.work.agentWorkspace(actor, sub.id);
    expect(grandchild).toMatchObject({ parentWorkspaceId: child.id, ownerAgentId: sub.id, depth: 2,
      rootWorkspaceId: root.id, lineage: [root.id, child.id, sub.workspaceId] });
    expect((await rpcAs(f, session.token, "work.snapshot", { workspaceId: child.id })).error).toBeUndefined();
    expect((await rpcAs(f, session.token, "work.snapshot", { workspaceId: grandchild.id })).error).toBeUndefined();
    for (const workspaceId of [root.id, b.workspaceId]) {
      expect((await rpcAs(f, session.token, "work.snapshot", { workspaceId })).error?.code).toBe(-32003);
    }
    expect(() => f.services.work.saveAgent({ ...actor, principal: { ...session.principal, id: root.ownerId,
      workspaceId: p.owner.catalog.workspaceId, kind: "human" } }, agentInput("forged"))).toThrow();
    const own = await p.scopedCapability(session.principal, child.id, "work:read");
    await expect(p.work.read(own, agentScope(b))).rejects.toThrow();
    const inspection = await p.scopedCapability(session.principal, grandchild.id, "work:read");
    await expect(p.work.read(inspection, root.catalogScope)).rejects.toThrow();
    await expect(p.work.commit(inspection, {
      scope: grandchild.catalogScope, idempotencyKey: "read-only-denied", operation: "host.task.create", payload: {},
      resources: [{ kind: "workspace", id: grandchild.id }],
    }, async () => ({ status: "succeeded", value: {}, receipts: [{ kind: "should-not-execute" }], events: [] }))).rejects.toThrow();
    await f.services.work.updateWorkspace(f.context(grandchild.id), {
      name: grandchild.name, purpose: grandchild.purpose, twin: grandchild.twin,
      approvalPolicy: grandchild.approvalPolicy, computerPolicy: grandchild.computerPolicy, parentAccess: "none",
    });
    expect((await rpcAs(f, session.token, "work.snapshot", { workspaceId: grandchild.id })).error?.code).toBe(-32003);
    await expect(p.work.read(inspection, grandchild.catalogScope)).rejects.toMatchObject({ code: -32003 });
    const repeat = await f.services.work.saveAgent(f.context(), { ...agentInput(a.id), model: "gpt-6-astra", name: "Alpha renamed" });
    expect(repeat.workspaceId).toBe(child.id);
    expect(p.childrenOf(root.id).filter((id) => p.workspaceInfo(id).ownerAgentId === a.id)).toEqual([child.id]);
    const tree = await f.services.work.tree({ ...f.catalogContext(), workspaceId: root.id });
    expect(tree.nodes.some((node) => node.workspace.id === sub.workspaceId && node.workspace.depth === 2)).toBe(true);
    const breadcrumb = await f.services.work.breadcrumb(f.context(sub.workspaceId));
    expect(breadcrumb.ancestors.map((node) => node.id)).toEqual([root.id, child.id, sub.workspaceId]);
  }, 180_000);

  it("bounds depth/count, rejects cycles and stale parent revisions, and never remints an agent workspace", async () => {
    const f = await setup(), p = f.services.persistence;
    let parent = f.workspace!;
    for (let depth = 1; depth <= MAX_WORKSPACE_DEPTH; depth++) {
      const agent = await f.services.work.saveAgent(f.context(parent.id), { ...agentInput(`depth-${depth}`), model: "gpt-6-astra" });
      parent = await f.services.work.agentWorkspace(f.context(parent.id), agent.id);
      expect(parent.depth).toBe(depth);
    }
    await expect(f.services.work.saveAgent(f.context(parent.id), agentInput("too-deep"))).rejects.toMatchObject({ code: -32009 });
    const root = f.workspace!;
    const count = vi.spyOn(p, "childrenOf").mockImplementation((id) =>
      id === root.id ? Array.from({ length: MAX_WORKSPACE_AGENTS }, (_, index) => `reserved-${index}`) : []);
    await expect(f.services.work.saveAgent(f.context(root.id), agentInput("too-many"))).rejects.toMatchObject({ code: -32009 });
    count.mockRestore();
    await expect(f.services.work.saveAgent({ ...f.context(root.id), parentRevision: 0 }, agentInput("stale-parent")))
      .rejects.toMatchObject({ code: -32015 });
    expect(workspaceSummarySchema.safeParse({ ...parent, lineage: [root.id, parent.id, parent.id], depth: 2 }).success).toBe(false);
    expect((await f.rpc("workspaces.update", { workspaceId: root.id, name: root.name, purpose: root.purpose,
      twin: root.twin, computerPolicy: root.computerPolicy, approvalPolicy: root.approvalPolicy,
      parentWorkspaceId: parent.id })).error?.code).toBe(-32602);
  }, 180_000);

  it("keeps internal tasks/conversation private to the selected child and persists safe evolution without executing schedules", async () => {
    const f = await setup();
    const a = await f.services.work.saveAgent(f.context(), { ...agentInput("private-alpha"), model: "gpt-6-astra" });
    const b = await f.services.work.saveAgent(f.context(), { ...agentInput("private-beta"), model: "gpt-6-astra" });
    const task = await f.services.work.createTask(f.context(a.workspaceId), { requestId: randomUUID(), title: "ALPHA-PRIVATE-TASK",
      instructions: "Use only Alpha evidence.", agentId: a.id, priority: "normal" });
    f.copilot.complete.mockImplementation(async (request) => {
      const message = request.messages[1];
      if (!message || !("content" in message)) throw new Error("Missing context.");
      const prompt = JSON.parse(message.content);
      expect(prompt.verifiedContext.workspace.lineage).toEqual([f.workspace!.id, a.workspaceId]);
      expect(JSON.stringify(prompt)).not.toContain("private-beta");
      return {
        kind: "clarification", assistantMessage: "I organized the evidence view. Which source should I review?",
        summary: "Source input still needed.", confidence: 0.9, readyForReview: false, missing: ["source"], draft: null,
        evolution: { twinSummary: "Alpha evidence workspace", sections: [{ id: "evidence-view", title: "Evidence to review",
          kind: "tasks", description: "Only this workspace's work.", taskIds: [task.id] }],
          suggestedRoutines: [{ id: prompt.allocatedIdentifiers.routineIds[0], name: "Suggested review", taskTitle: "Review evidence",
            instructions: "Review supplied evidence.", agentId: a.id, cadence: { kind: "interval", minutes: 60 }, enabled: false }],
          defaultFocus: "work" },
      };
    });
    expect((await f.rpc("twin.message", { workspaceId: a.workspaceId, message: "ALPHA-CONVERSATION: organize my internal evidence.", history: [] })).error).toBeUndefined();
    const evolved = await f.services.work.workspace(f.context(a.workspaceId));
    expect(evolved.organization.sections[0]!.taskIds).toEqual([task.id]);
    expect(evolved.organization.suggestedRoutines[0]!.enabled).toBe(false);
    expect((await f.services.work.snapshot(f.context(a.workspaceId))).automations).toEqual([]);
    expect((await f.services.work.snapshot(f.context())).tasks).toEqual([]);
    expect((await f.services.twin.conversation(f.context(b.workspaceId))).turns).toEqual([]);
    expect((await f.services.twin.conversation(f.context())).turns).toEqual([]);
    const evolution = twinEvolutionEventSchema.parse(
      (await f.services.twin.conversation(f.context(a.workspaceId))).events.find((event) => event.kind === "evolution"),
    );
    expect(evolution.workspaceId).toBe(a.workspaceId);
    const scan = await (await f.services.persistence.workspace(agentScope(a))).scan();
    expect(isVerifiedChain(scan.streams.body)).toBe(true);
    expect(JSON.stringify(scan.streams.body.frames)).toContain("workspace.evolved");
    for (const hash of [evolution.references.conversationFrameHash, evolution.references.proposalFrameHash,
      evolution.references.evolutionFrameHash]) {
      expect(scan.streams.memory.frames.some((frame) => frame.frame_hash === hash)).toBe(true);
    }
    await f.close(false); fixtures.splice(fixtures.indexOf(f), 1);
    const recovered = await setup(f.directory);
    expect((await recovered.services.work.workspace(recovered.context(a.workspaceId))).organization).toEqual(evolved.organization);
    expect((await recovered.services.twin.conversation(recovered.context(a.workspaceId))).turns[0]!.content).toContain("ALPHA-CONVERSATION");
    expect(recovered.copilot.complete).not.toHaveBeenCalled();
  }, 180_000);

  it("does not allow internal evolution or an agent identity to bypass external-effect gates", async () => {
    const f = await setup();
    const agent = await f.services.work.saveAgent(f.context(), { ...agentInput("guarded-agent"), model: "gpt-6-astra" });
    const session = await f.services.createAgentSession(f.context(), agent.id);
    const context = { principal: session.principal, workspaceId: agent.workspaceId, requestId: randomUUID() };
    const child = await f.services.work.workspace(context);
    expect(() => f.services.work.updateWorkspace(context, {
      name: child.name, purpose: child.purpose, twin: child.twin, computerPolicy: "control", approvalPolicy: "on-risk",
    })).toThrow();
    expect((await rpcAs(f, session.token, "computer.start", { workspaceId: child.id })).error?.code).toBe(-32003);
    expect((await rpcAs(f, session.token, "providers.configure", { workspaceId: child.id, id: "github-copilot", connectionRef: "copilot-cli" })).error?.code).toBe(-32003);
    await expect(f.services.work.saveAutomation(context, { id: "forbidden-schedule", name: "Unsafe", taskTitle: "Unsafe",
      instructions: "Do not activate.", agentId: agent.id, cadence: { kind: "interval", minutes: 15 }, enabled: true }, f.services.runtime))
      .rejects.toMatchObject({ code: -32003 });
    f.copilot.complete.mockResolvedValue({
      kind: "clarification", assistantMessage: "Organized.", summary: "Internal update.", confidence: 0.9,
      readyForReview: false, missing: ["source"], draft: null,
      evolution: { twinSummary: "Bad expansion", sections: [], suggestedRoutines: [], defaultFocus: "work", computerPolicy: "control" },
    });
    expect((await f.rpc("twin.message", { workspaceId: child.id, message: "Organize internal work.", history: [] })).error?.code).toBe(-32014);
    expect((await f.services.work.workspace(f.context(child.id))).organization.twinSummary).toBe("");
  }, 60_000);

  it("recovers the same durably reserved child after failed publication and restart", async () => {
    const f = await setup(), root = f.workspace!, id = "restart-reserved-agent";
    const before = await readdir(join(f.directory, "workspaces"));
    f.failAfterCommits(8);
    await expect(f.services.work.saveAgent(f.context(), agentInput(id))).rejects.toMatchObject({ code: -32012 });
    f.failPersistence(false);
    const staged = (await readdir(join(f.directory, "workspaces"))).filter((workspaceId) => !before.includes(workspaceId));
    expect(staged).toHaveLength(1);
    const orphanId = staged[0]!;
    const orphan = await (await f.services.persistence.workspace({ agentId: id, workspaceId: orphanId })).scan();
    expect(JSON.stringify(orphan.streams.body.frames)).toContain("host.workspace.bootstrap");
    await f.close(false); fixtures.splice(fixtures.indexOf(f), 1);

    const recovered = await setup(f.directory);
    expect(recovered.services.persistence.businessIds()).not.toContain(orphanId);
    const other = await recovered.services.work.createWorkspace(
      recovered.catalogContext(), workspaceInput("Reservation isolation", "reservation-isolation-lead"),
    );
    const beforeWrongParent = await readdir(join(recovered.directory, "workspaces"));
    await expect(recovered.services.work.saveAgent(recovered.context(other.id), agentInput(id)))
      .rejects.toMatchObject({ code: -32003 });
    expect(await readdir(join(recovered.directory, "workspaces"))).toEqual(beforeWrongParent);
    const agent = await recovered.services.work.saveAgent(recovered.context(root.id), agentInput(id));
    expect(agent.workspaceId).toBe(orphanId);
    expect(await recovered.services.work.agentWorkspace(recovered.context(root.id), id))
      .toMatchObject({ id: orphanId, parentWorkspaceId: root.id, ownerAgentId: id });
  }, 180_000);

  it("serializes a delayed catalog refresh with child creation and installs only validated source heads", async () => {
    const f = await setup(), p = f.services.persistence, root = f.workspace!, id = "refresh-create-agent";
    const gate = blockCatalogRead(f, root.id);
    try {
      const stale = p.refreshCatalog();
      await gate.waiting;
      let settled = false;
      const creating = f.services.work.saveAgent(f.context(), agentInput(id)).finally(() => { settled = true; });
      const published = await until(() => p.read(root.catalogScope), (history) => hasCatalogAgent(history, id));
      const event = published.commands.flatMap((command) => command.state === "committed" ? command.events : [])
        .find((entry) => entry.type === "catalog.agent" && (entry.scope as { agentId?: string }).agentId === id)!;
      const workspaceId = (event.scope as { workspaceId: string }).workspaceId;
      const settledBeforeRelease = settled;
      gate.release();
      await stale;
      expect(p.ownsBusiness(workspaceId)).toBe(true);
      const agent = await creating;
      expect(settledBeforeRelease).toBe(false);
      expect(agent.workspaceId).toBe(workspaceId);
      expect(p.businessIds()).toContain(workspaceId);
    } finally {
      gate.release();
      gate.restore();
    }
  }, 180_000);

  it("serializes a delayed catalog refresh with retirement and cannot restore stale authorization", async () => {
    const f = await setup(), p = f.services.persistence;
    const agent = await f.services.work.saveAgent(f.context(), agentInput("refresh-retire-agent"));
    const session = await f.services.createAgentSession(f.context(), agent.id);
    const gate = blockCatalogRead(f, agent.workspaceId);
    try {
      const stale = p.refreshCatalog();
      await gate.waiting;
      let settled = false;
      const retiring = f.services.work.retireAgent(f.context(), agent.id).finally(() => { settled = true; });
      await until(() => p.read(agentScope(agent)), hasArchivedWorkspace);
      const settledBeforeRelease = settled;
      gate.release();
      await stale;
      expect(p.workspaceInfo(agent.workspaceId).status).toBe("archived");
      expect(p.isAgent(session.principal)).toBe(false);
      await retiring;
      expect(settledBeforeRelease).toBe(false);
      expect(p.workspaceInfo(agent.workspaceId).status).toBe("archived");
    } finally {
      gate.release();
      gate.restore();
    }
  }, 180_000);

  it("leaves no published orphan on failed agent creation and archives retired ownership instead of reassigning it", async () => {
    const f = await setup(), root = f.workspace!;
    const before = f.services.persistence.businessIds();
    f.failAfterCommits(8);
    await expect(f.services.work.saveAgent(f.context(), agentInput("unpublished-agent"))).rejects.toMatchObject({ code: -32012 });
    f.failPersistence(false);
    expect(f.services.persistence.businessIds()).toEqual(before);
    expect((await f.services.work.snapshot(f.context())).agents.some((agent) => agent.id === "unpublished-agent")).toBe(false);
    const staged = (await readdir(join(f.directory, "workspaces"))).filter((id) => id.startsWith("workspace-") && !before.includes(id));
    for (const id of staged) expect((await f.rawRpc("work.snapshot", { workspaceId: id })).error?.code).toBe(-32003);
    const owner = await f.services.work.saveAgent(f.context(), agentInput("retire-owner"));
    const nested = await f.services.work.saveAgent(f.context(owner.workspaceId), agentInput("retire-child"));
    await f.services.work.retireAgent(f.context(), owner.id);
    expect(await f.services.work.workspace(f.context(owner.workspaceId))).toMatchObject({ id: owner.workspaceId, status: "archived", parentWorkspaceId: root.id });
    expect(f.services.persistence.activeLineage(nested.workspaceId)).toBe(false);
    await expect(f.services.work.saveAgent(f.context(), agentInput(owner.id))).rejects.toMatchObject({ code: -32009 });
    await f.close(false); fixtures.splice(fixtures.indexOf(f), 1);
    const recovered = await setup(f.directory);
    expect(recovered.services.persistence.businessIds()).not.toEqual(expect.arrayContaining(staged));
    expect(await recovered.services.work.agentWorkspace(recovered.context(), owner.id)).toMatchObject({ id: owner.workspaceId, status: "archived" });
  }, 180_000);
});
