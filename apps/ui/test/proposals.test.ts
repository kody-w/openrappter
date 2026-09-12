import { describe, expect, it } from "vitest";
import { conversationPhase, historyFor, prepareProposal, proposalDisposition } from "../src/proposals";
import { twinMessageRequestSchema, type TwinConversation, type TwinDraft } from "../src/model";
import { FixtureClient, populatedClient } from "./fixture";

describe("complete, scoped review preparation", () => {
  it.each(["task", "agent", "automation", "settings", "workspace"] as const)("never opens an incomplete %s draft", (kind) => {
    const client = new FixtureClient();
    const workspaceId = kind === "workspace" ? null : "finance";
    const draft = client.host.makeDraft({ workspaceId, message: "Create complete work.", target: kind, history: [] });
    const snapshot = workspaceId ? client.workspace : null;
    expect(prepareProposal(draft, workspaceId, snapshot)?.kind).toBe(kind);
    expect(prepareProposal({ ...draft, draft: {} }, workspaceId, snapshot)).toBeNull();
    expect(prepareProposal({ ...draft, readyForReview: false }, workspaceId, snapshot)).toBeNull();
    expect(prepareProposal({ ...draft, missing: ["The outcome is missing."] }, workspaceId, snapshot)).toBeNull();
    expect(prepareProposal({ ...draft, basis: null }, workspaceId, snapshot)).toBeNull();
  });
  it("uses saved settings to complete a small Twin patch without clearing unrelated preferences", () => {
    const client = new FixtureClient();
    client.workspace.settings.notifications.completedRuns = false;
    client.workspace.settings.work.defaultPriority = "high";
    const draft = client.host.makeDraft({ workspaceId: "finance", message: "Change to dark theme.", history: [] });
    const review = prepareProposal(draft, "finance", client.workspace);
    expect(review).toMatchObject({ kind: "settings", input: {
      workspaceName: "Finance studio", appearance: { theme: "dark", density: "compact" },
      work: { defaultPriority: "high", approvalPolicy: "always" }, notifications: { approvals: true, completedRuns: false },
    } });
  });
  it("rejects proposals and referenced agents from another workspace", () => {
    const client = new FixtureClient();
    const draft = client.host.makeDraft({ workspaceId: "finance", message: "Review invoices.", history: [] });
    expect(prepareProposal(draft, "other", client.workspace)).toBeNull();
    expect(prepareProposal({ ...draft, draft: { ...draft.draft, agentId: "other-agent" } }, "finance", client.workspace)).toBeNull();
    expect(prepareProposal({ ...draft, basis: { ...draft.basis, ownerId: "another-owner" } }, "finance", client.workspace)).toBeNull();
    expect(prepareProposal({ ...draft, workspaceId: null }, null, null)).toBeNull();
  });
  it("only reviews a still-pending, exact, unexpired operation and never treats a recommendation as an action", () => {
    const client = populatedClient();
    const draft = client.host.makeDraft({ workspaceId: "finance", message: "Review pending approval.", history: [] });
    expect(prepareProposal(draft, "finance", client.workspace)?.kind).toBe("approval");
    expect(prepareProposal({ ...draft, draft: { ...draft.draft, operationHash: "c".repeat(64) } }, "finance", client.workspace)).toBeNull();
    client.workspace.approvals[0]!.expiresAt = "2020-01-01T00:00:00.000Z";
    expect(prepareProposal(draft, "finance", client.workspace)).toBeNull();
    client.workspace.approvals[0]!.expiresAt = "2099-01-01T00:00:00.000Z";
    client.workspace.approvals[0]!.state = "approved";
    expect(prepareProposal(draft, "finance", client.workspace)).toBeNull();
  });
  it("derives proposal disposition only from a matching durable host event", () => {
    const client = new FixtureClient();
    const current = client.host.state.conversations.finance!;
    const id = crypto.randomUUID();
    expect(proposalDisposition(current, id)).toBeNull();
    current.events.push({ id: crypto.randomUUID(), workspaceId: "finance", proposalId: id, kind: "dismiss",
      actorId: "test-owner", detail: "Owner dismissed.", createdAt: new Date().toISOString() });
    expect(proposalDisposition(current, id)).toBe("Dismissed");
    expect(proposalDisposition(current, crypto.randomUUID())).toBeNull();
  });
  it("keeps multibyte messages and the most recent scoped history within the host byte bound", () => {
    const message = "界".repeat(8000);
    const conversation: TwinConversation = { workspaceId: "finance", revision: 2, proposals: [] as TwinDraft[], events: [],
      turns: Array.from({ length: 30 }, (_, index) => ({ id: crypto.randomUUID(), workspaceId: "finance",
        role: index % 2 ? "assistant" as const : "user" as const, content: `${index}: ${"界".repeat(7900)}`,
        proposalId: null, createdAt: new Date().toISOString() })) };
    const history = historyFor(conversation, message);
    expect(history.length).toBeLessThan(24);
    expect(history.at(-1)?.content).toMatch(/^29:/);
    expect(twinMessageRequestSchema.safeParse({ workspaceId: "finance", message, history, contextRevision: 2 }).success).toBe(true);
  });
  it("reports sidebar phases from scoped host turns and events, never an assumed runtime result", async () => {
    const client = new FixtureClient();
    expect(conversationPhase(client.host.state.conversations.finance!)).toBe("Saved workspace");
    await client.call("twin.message", { workspaceId: "finance", message: "Help me plan something useful.", history: [], contextRevision: 7 });
    expect(conversationPhase(client.host.state.conversations.finance!)).toBe("Needs your reply");
    const proposal = client.host.state.conversations.finance!.proposals[0]!;
    await client.call("twin.dismissProposal", { workspaceId: "finance", id: proposal.id, proposalHash: "a".repeat(64) });
    expect(conversationPhase(client.host.state.conversations.finance!)).toBe("Dismissed");
  });
});
