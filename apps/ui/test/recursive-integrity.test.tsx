import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { App } from "../src/App";
import { TaskForm } from "../src/forms";
import { FixtureClient, testAgent, testHostState } from "./fixture";
import { agentInputSchema, type TwinDraft } from "../src/model";

const composer = () => screen.getByRole("textbox", { name: "Message your Work Twin" });
async function open(client = new FixtureClient()) {
  render(<App client={client} />);
  await screen.findByText("Local host connected");
  await waitFor(() => expect(screen.queryByRole("status", { name: "Loading workspace" })).not.toBeInTheDocument());
  return { client, user: userEvent.setup() };
}
async function say(user: ReturnType<typeof userEvent.setup>, message: string) {
  await user.clear(composer()); await user.type(composer(), message);
  await user.click(screen.getByRole("button", { name: "Send" }));
}
const childAgents = () => within(screen.getByRole("region", { name: "Child agents" }));

describe("one recursive conversation-first shell", () => {
  it("refuses a child response that changes the agent's mint-once workspace identity", async () => {
    const client = new FixtureClient();
    const original = client.bridge.request;
    client.bridge.request = async (request) => {
      if (request.method !== "agents.openWorkspace") return original(request);
      const child = client.host.state.catalog.workspaces.find((workspace) => workspace.ownerAgentId === "finance-lead")!;
      return { ...child, id: "wrong-child", catalogScope: { ...child.catalogScope, workspaceId: "wrong-child" },
        lineage: ["finance", "wrong-child"] };
    };
    const { user } = await open(client);
    await user.click(childAgents().getByRole("button", { name: "Open Operations analyst's workspace" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("mint-once workspace identity changed");
    expect(screen.getByRole("heading", { name: "Finance studio Twin", level: 1 })).toBeVisible();
    expect(screen.getByRole("main")).toHaveAttribute("data-workspace-id", "finance");
  });
  it("opens agent-owned children, creates a nested child atomically, and navigates authoritative breadcrumbs", async () => {
    const { user, client } = await open();
    await user.click(childAgents().getByRole("button", { name: "Open Operations analyst's workspace" }));
    await screen.findByRole("heading", { name: "Operations analyst Twin", level: 1 });
    expect(screen.getByRole("main")).toHaveAttribute("data-workspace-depth", "1");
    expect(screen.getByText(/Owner: Operations analyst · Parent: Finance studio/)).toBeVisible();
    expect(childAgents().queryByRole("button", { name: "Open Operations analyst's workspace" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start agent computer" })).toBeVisible();
    await say(user, "Create an agent responsible for reconciliation.");
    const proposal = await screen.findByRole("article", { name: "Agent proposal" });
    await user.click(within(proposal).getByRole("button", { name: "Approve & create agent" }));
    await within(proposal).findByText("Applied", { exact: true });
    const child = client.host.state.catalog.workspaces.find((workspace) => workspace.parentWorkspaceId === "finance-execution")!;
    expect(child).toMatchObject({ ownerType: "agent", depth: 2, rootWorkspaceId: "finance" });
    expect(child.lineage).toEqual(["finance", "finance-execution", child.id]);
    await user.click(within(proposal).getByRole("button", { name: "Open this agent's child workspace" }));
    await screen.findByRole("heading", { name: "Finance analyst Twin", level: 1 });
    expect(screen.getByRole("main")).toHaveAttribute("data-workspace-depth", "2");
    expect(composer()).toHaveValue("");
    expect(screen.getByRole("log")).not.toHaveTextContent("Create an agent responsible for reconciliation.");
    await user.type(composer(), "Nested unsent input");
    await user.click(within(screen.getByRole("navigation", { name: "Workspace breadcrumb" })).getByRole("button", { name: "Finance studio" }));
    await screen.findByRole("heading", { name: "Finance studio Twin", level: 1 });
    expect(composer()).toHaveValue("");
    expect(client.host.state.conversations.finance!.turns).toHaveLength(0);
  });

  it("keeps sibling conversations, form state, computer activation and subscriptions isolated", async () => {
    const client = new FixtureClient();
    await client.call("agents.save", { ...agentInputSchema.strip().parse(testAgent), id: "second", name: "Second analyst", workspaceId: "finance" });
    const { user } = await open(client);
    await user.click(childAgents().getByRole("button", { name: "Open Operations analyst's workspace" }));
    await screen.findByRole("heading", { name: "Operations analyst Twin", level: 1 });
    await say(user, "Private first-child invoice review.");
    await user.click(await screen.findByRole("button", { name: "Review details" }));
    await user.clear(screen.getByLabelText("Task title")); await user.type(screen.getByLabelText("Task title"), "Unsaved child edit");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await user.click(screen.getByRole("button", { name: "Start agent computer" }));
    await waitFor(() => expect(client.host.state.computerEnabled).toContain("finance-execution"));
    await user.click(screen.getByRole("button", { name: "Open workspace Second analyst" }));
    await screen.findByRole("heading", { name: "Second analyst Twin", level: 1 });
    expect(screen.getByRole("log")).not.toHaveTextContent("Private first-child");
    expect(composer()).toHaveValue("");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByText("Not enabled for this workspace")).toBeVisible();
    const sibling = client.host.state.catalog.workspaces.find((workspace) => workspace.ownerAgentId === "second")!;
    await waitFor(() => expect([...client.host.subscriptions.values()].every((scope) => scope === sibling.id)).toBe(true));
  });

  it("enforces depth and inherited pause/archive state without repurposing a child workspace", async () => {
    const client = new FixtureClient();
    let parent = "finance-execution";
    for (let depth = 2; depth <= 4; depth++) {
      const agent = await client.call("agents.save", { ...agentInputSchema.strip().parse(testAgent), id: `depth-${depth}`, name: `Depth ${depth} agent`, workspaceId: parent });
      parent = agent.workspaceId;
    }
    window.localStorage.setItem("rapp-work:selected:test-owner:owner-catalog", parent);
    client.host.state.catalog.workspaces.find((workspace) => workspace.id === "finance")!.status = "paused";
    const { user } = await open(client);
    await screen.findByRole("heading", { name: "Depth 4 agent Twin", level: 1 });
    expect(screen.getByRole("button", { name: "New agent" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Start agent computer" })).toBeDisabled();
    expect(screen.getByText(/Depth 4 · paused/)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Back to parent workspace" }));
    await screen.findByRole("heading", { name: "Depth 3 agent Twin", level: 1 });
    const childId = parent;
    const owner = client.host.state.catalog.workspaces.find((workspace) => workspace.id === parent)!.ownerAgentId!;
    const parentId = client.host.state.catalog.workspaces.find((workspace) => workspace.id === parent)!.parentWorkspaceId!;
    await client.call("agents.retire", { workspaceId: parentId, id: owner });
    expect(client.host.state.catalog.workspaces.find((workspace) => workspace.id === childId)!.status).toBe("archived");
    expect(client.host.state.workspaces[parentId]!.agents.find((agent) => agent.id === owner)!.workspaceId).toBe(childId);
  });

  it("shows only exact conversation/proposal-linked evolution receipts and keeps suggested routines disabled", async () => {
    const { client, user } = await open(new FixtureClient(testHostState(["Finance studio", "Retail studio"])));
    client.host.evolution = {
      twinSummary: "Inventory evidence workspace", defaultFocus: "work",
      sections: [{ id: "exceptions", title: "Evidence exceptions", description: "Only records in this workspace.", kind: "tasks", taskIds: [] }],
      suggestedRoutines: [{ id: "suggested-review", name: "Suggested evidence review", taskTitle: "Review exceptions",
        instructions: "Preserve evidence references.", agentId: "finance-lead", cadence: { kind: "daily", at: "09:00", timezone: "UTC" }, enabled: false }],
    };
    await say(user, "Organize this evidence and prepare a task.");
    const organization = await screen.findByRole("region", { name: "Conversation-organized workspace" });
    expect(within(organization).getByText("Workspace evolved from this conversation")).toBeVisible();
    expect(within(organization).getByText("Evidence exceptions")).toBeVisible();
    expect(client.workspace.automations).toHaveLength(0);
    await user.click(within(organization).getByText("Canonical evolution references"));
    const refs = client.host.state.conversations.finance!.events.find((event) => event.kind === "evolution")!.references!;
    expect(within(organization).getByText(refs.conversationFrameHash)).toBeVisible();
    expect(within(organization).getByText(refs.proposalFrameHash)).toBeVisible();
    await user.click(within(organization).getByRole("button", { name: "Discuss this routine" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect((composer() as HTMLTextAreaElement).value).toContain("disabled suggestion");
    await user.click(screen.getByRole("button", { name: "Open workspace Retail studio" }));
    await screen.findByRole("heading", { name: "Retail studio Twin", level: 1 });
    expect(screen.queryByText("Workspace evolved from this conversation")).not.toBeInTheDocument();
  });
});

describe("canonical integrity is a required review gate", () => {
  it.each(["unverified", "unavailable"] as const)("blocks %s proposals even if the fields are complete and ready", async (state) => {
    const client = new FixtureClient();
    const proposal = client.host.makeDraft({ workspaceId: "finance", message: "Review invoices.", target: "task", history: [] });
    client.host.nextDraft = { ...proposal, basis: { ...proposal.basis!, verification: { state, detail: "Canonical scan not verified." } } };
    const { user } = await open(client);
    await say(user, "Review invoices.");
    const card = await screen.findByRole("article", { name: "Task proposal" });
    expect(within(card).getByText(state === "unverified" ? "Unverified proposal" : "Verification unavailable")).toBeVisible();
    expect(within(card).queryByRole("button", { name: "Review details" })).not.toBeInTheDocument();
    expect(within(card).queryByRole("button", { name: "Approve & create task" })).not.toBeInTheDocument();
    expect(client.calls.some((call) => call.method === "twin.applyProposal")).toBe(false);
  });
  it("rejects a mutable form when the supplied verified proof belongs to another workspace", () => {
    const client = new FixtureClient();
    const proposal = client.host.makeDraft({ workspaceId: "finance", message: "Review invoices.", target: "task", history: [] });
    if (proposal.kind !== "task" || proposal.basis?.verification?.state !== "verified") throw new Error("Expected fixture proof.");
    const foreign = { ...proposal, basis: { ...proposal.basis, verification: { ...proposal.basis.verification, workspaceId: "other" } } } as TwinDraft;
    const view = render(<TaskForm source="twin" proposal={foreign} draft={proposal.draft} agents={client.workspace.agents}
      onSave={async () => true} onClose={() => {}} busy={false} error="" />);
    expect(view.container.querySelector("form")).toBeNull();
    expect(screen.getByRole("alert")).toBeVisible();
  });
});
