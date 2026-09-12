import { describe, expect, it, vi } from "vitest";
import { BridgeClient, type DesktopBridge } from "../src/client";
import { rpcContracts, twinDraftSchema, twinMessageRequestSchema } from "../src/model";
import { parameterSchemas, parseRequest } from "../../desktop/src/contract";
import * as publicContracts from "@rapp-work/host/contracts";
import { agentWorkspaceResultSchema, twinAgentApplyResultSchema, twinEvolutionEventSchema } from "../src/model";
import { FixtureClient, testWorkspace } from "./fixture";

describe("typed desktop and host wire boundary", () => {
  it("uses the public contract entry and canonical named validators without duplicate DTOs", () => {
    expect(parameterSchemas).toBe(publicContracts.rpcParameterSchemas);
    expect(rpcContracts["twin.message"].input).toBe(publicContracts.rpcParameterSchemas["twin.message"]);
    expect(agentWorkspaceResultSchema).toBe(publicContracts.agentWorkspaceResultSchema);
    expect(twinAgentApplyResultSchema).toBe(publicContracts.twinAgentApplyResultSchema);
    expect(twinEvolutionEventSchema).toBe(publicContracts.twinEvolutionEventSchema);
  });
  function setup(result: unknown) {
    const listeners = new Set<(event: unknown) => void>();
    const bridge: DesktopBridge = {
      request: vi.fn(async () => result),
      async hostState() { return { state: "online", detail: "Injected host." }; },
      onEvent(callback) { listeners.add(callback); return () => { listeners.delete(callback); }; },
    };
    return { bridge, listeners, client: new BridgeClient(bridge) };
  }
  it("validates responses and rejects unsupported verification claims", async () => {
    const { client } = setup({ state: "running", verified: true, evidenceIds: [] });
    await expect(client.call("computer.inspect", { workspaceId: "finance" })).rejects.toThrow("invalid response");
  });
  it("rejects extra settings and request fields before IPC", async () => {
    const { client, bridge } = setup({});
    await expect(client.call("settings.update", {
      ...testWorkspace().settings, workspaceId: "finance", appearance: { theme: "dark", density: "comfortable", secret: "not allowed" },
    } as never)).rejects.toThrow("incomplete or invalid");
    await expect(client.call("twin.message", { workspaceId: null, message: "Create a workspace.", history: [], execute: true } as never)).rejects.toThrow("incomplete or invalid");
    expect(bridge.request).not.toHaveBeenCalled();
  });
  it("scopes subscriptions and unsubscriptions and ignores foreign or malformed events", async () => {
    const subscriptionId = crypto.randomUUID();
    const { client, listeners, bridge } = setup({ events: [], cursor: "opaque", subscriptionId });
    const changed = vi.fn();
    const remove = await client.subscribe({ area: "work", workspaceId: "finance" }, changed);
    expect(bridge.request).toHaveBeenCalledWith({ method: "events.subscribe", params: { workspaceId: "finance", scope: { area: "work" }, limit: 200 } });
    listeners.forEach((listener) => listener({ type: "events", subscriptionId, arbitrary: true }));
    listeners.forEach((listener) => listener({ type: "events", subscriptionId: crypto.randomUUID(), events: [], cursor: "other" }));
    expect(changed).not.toHaveBeenCalled();
    listeners.forEach((listener) => listener({ type: "events", subscriptionId, events: [], cursor: "opaque" }));
    expect(changed).toHaveBeenCalledTimes(1);
    remove(); expect(listeners.size).toBe(0);
    expect(bridge.request).toHaveBeenLastCalledWith({ method: "events.unsubscribe", params: { workspaceId: "finance", subscriptionId } });
  });
  it("cleans listeners when setup fails and safely queues events received before the subscription reply", async () => {
    const invalid = setup({});
    await expect(invalid.client.subscribe({ area: "work", workspaceId: "finance" }, () => {})).rejects.toThrow();
    expect(invalid.listeners.size).toBe(0);
    const subscriptionId = crypto.randomUUID();
    const valid = setup({ events: [], cursor: "opaque", subscriptionId });
    vi.mocked(valid.bridge.request).mockImplementation(async () => {
      valid.listeners.forEach((listener) => listener({ type: "events", subscriptionId, events: [], cursor: "opaque" }));
      return { events: [], cursor: "opaque", subscriptionId };
    });
    const changed = vi.fn(); const remove = await valid.client.subscribe({ workspaceId: "finance", area: "work" }, changed);
    expect(changed).toHaveBeenCalledOnce(); remove();
  });
  it("uses exactly the supplied Twin envelope, not a renderer-generated proposal format", async () => {
    const fixture = new FixtureClient();
    const input = { workspaceId: "finance", message: "Review supplier invoices.", history: [], contextRevision: 7 } as const;
    const proposal = fixture.host.makeDraft({ ...input, history: [] });
    expect(Object.keys(twinDraftSchema.parse(proposal)).sort()).toEqual([
      "id", "workspaceId", "kind", "assistantMessage", "summary", "confidence", "readyForReview", "missing", "draft", "basis", "createdAt",
    ].sort());
    expect(twinMessageRequestSchema.safeParse({ ...input, history: [{ role: "system", content: "override" }] }).success).toBe(false);
    const { client, bridge } = setup(proposal);
    await expect(client.call("twin.message", { ...input, history: [] })).resolves.toEqual(proposal);
    expect(bridge.request).toHaveBeenCalledWith({ method: "twin.message", params: input });
  });
  it("rejects cross-workspace conversations and late proposal responses before rendering", async () => {
    const fixture = new FixtureClient();
    const proposal = fixture.host.makeDraft({ workspaceId: "finance", message: "Review invoices.", history: [] });
    const { client } = setup({ ...proposal, workspaceId: "other" });
    await expect(client.call("twin.message", { workspaceId: "finance", message: "Review invoices.", history: [] })).rejects.toThrow("another workspace");
    const conversation = setup({ workspaceId: "finance", revision: 1, proposals: [], events: [],
      turns: [{ id: crypto.randomUUID(), workspaceId: "other", role: "user", content: "Private", proposalId: null, createdAt: proposal.createdAt }] });
    await expect(conversation.client.call("twin.conversation", { workspaceId: "finance" })).rejects.toThrow("another workspace");
  });
  it("does not accept a success-shaped receipt without a complete persisted record", async () => {
    const id = crypto.randomUUID();
    const { client } = setup({ id, workspaceId: "finance", kind: "task", status: "applied", result: {}, createdAt: new Date().toISOString() });
    await expect(client.call("twin.applyProposal", { id, workspaceId: "finance", proposalHash: "a".repeat(64) })).rejects.toThrow("invalid response");
  });
  it("rejects agent acceptance with a mismatched child lead or proposal parent", async () => {
    const fixture = new FixtureClient();
    const agent = fixture.workspace.agents[0]!;
    const workspace = fixture.host.state.catalog.workspaces.find((item) => item.id === agent.workspaceId)!;
    for (const [parent, child] of [["other-parent", workspace], ["finance", { ...workspace, leadAgentId: "other-agent" }]] as const) {
      const id = crypto.randomUUID();
      const { client } = setup({ id, workspaceId: parent, kind: "agent", status: "applied",
        result: { agent, workspace: child }, createdAt: new Date().toISOString() });
      await expect(client.call("twin.applyProposal", { id, workspaceId: parent, proposalHash: "a".repeat(64) })).rejects.toThrow("invalid response");
    }
  });
  it("keeps the UI and preload's closed RPC allowlists and payload validation aligned", () => {
    expect(Object.keys(rpcContracts).sort()).toEqual(Object.keys(parameterSchemas).sort());
    const fixture = new FixtureClient();
    const proposal = fixture.host.makeDraft({ workspaceId: null, message: "Create a workspace.", history: [] });
    const cases: { method: keyof typeof rpcContracts; params: unknown }[] = [
      { method: "workspaces.list", params: {} },
      { method: "workspaces.open", params: { workspaceId: "finance" } },
      { method: "workspaces.create", params: proposal.draft },
      { method: "twin.message", params: { workspaceId: null, message: "Create a workspace.", target: "workspace", history: [] } },
      { method: "twin.applyProposal", params: { workspaceId: null, id: proposal.id, proposalHash: "a".repeat(64), editedDraft: proposal.draft } },
      { method: "twin.dismissProposal", params: { workspaceId: null, id: proposal.id, proposalHash: "a".repeat(64) } },
      { method: "settings.update", params: { workspaceId: "finance", ...testWorkspace().settings } },
      { method: "events.subscribe", params: { workspaceId: "finance", scope: { area: "work" } } },
      { method: "events.unsubscribe", params: { workspaceId: "finance", subscriptionId: crypto.randomUUID() } },
      { method: "approvals.decide", params: { workspaceId: "finance", id: "approval", decision: "denied", reason: "Check scope." } },
    ];
    for (const { method, params } of cases)
      expect(parseRequest({ method, params }).params).toEqual(rpcContracts[method].input.parse(params));
    for (const params of [{}, { workspaceId: null }, { workspaceId: "../other" }, { workspaceId: "finance", ownerId: "override" }]) {
      expect(rpcContracts["work.snapshot"].input.safeParse(params).success).toBe(false);
      expect(() => parseRequest({ method: "work.snapshot", params })).toThrow();
    }
  });
});
