import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { App } from "../src/App";
import { AgentComputer } from "../src/AgentComputer";
import { FixtureClient, testHostState } from "./fixture";
import { inventoryInstructions, lockedInventoryPhrases } from "./inventory-instructions";

async function open(client = new FixtureClient()) {
  render(<App client={client} />);
  await screen.findByRole("heading", { name: "Finance studio Twin", level: 1 });
  await waitFor(() => expect(screen.getByRole("button", { name: "New task" })).toBeEnabled());
  return { client, user: userEvent.setup() };
}
const computerPanel = () => within(screen.getByRole("region", { name: "Agent computer" }));
const composer = () => screen.getByRole("textbox", { name: "Message your Work Twin" });

describe("pasted instruction documents are primary intake", () => {
  it("preserves a long Markdown block and locked phrases verbatim from paste through reviewed agent creation", async () => {
    const { client, user } = await open();
    expect(inventoryInstructions.length).toBeGreaterThan(8000);
    await user.click(composer()); await user.paste(inventoryInstructions);
    expect(composer()).toHaveValue(inventoryInstructions);
    expect(composer()).not.toHaveAttribute("maxlength");
    await user.click(screen.getByRole("button", { name: "Send" }));
    const card = await screen.findByRole("article", { name: "Agent proposal" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(client.host.state.conversations.finance!.turns[0]!.content).toBe(inventoryInstructions);
    expect((client.calls.find((item) => item.method === "twin.message")!.params as { message: string }).message).toBe(inventoryInstructions);
    const proposed = client.host.state.conversations.finance!.proposals[0]!;
    expect(proposed).toMatchObject({ missing: [], readyForReview: true, draft: {
      name: "Inventory Visibility Agent", instructions: inventoryInstructions, computerPolicy: "none", approvalPolicy: "always", enabled: true,
    } });
    if (proposed.kind !== "agent") throw new Error("Expected the complete agent proposal.");
    const provider = client.host.state.providers.find((item) => item.id === proposed.draft!.providerId)!;
    expect(provider.models).toContain(proposed.draft!.model);
    for (const phrase of lockedInventoryPhrases) expect(proposed.draft!.instructions).toContain(phrase);
    await user.click(within(card).getByRole("button", { name: "Review details" }));
    const review = within(screen.getByRole("dialog", { name: "Review agent proposal" }));
    expect(review.getByLabelText("Agent name")).toHaveValue("Inventory Visibility Agent");
    expect(review.getByLabelText("Agent instructions")).toHaveValue(inventoryInstructions);
    expect(review.getByLabelText("Agent instructions")).toHaveAttribute("readonly");
    await user.click(review.getByText("Suggested routines · disabled drafts"));
    expect(review.getByText("Every day at 09:00 · UTC · Disabled draft")).toBeVisible();
    await user.clear(review.getByLabelText("Role"));
    await user.type(review.getByLabelText("Role"), "Inventory evidence operations");
    await user.click(review.getByRole("button", { name: "Approve & apply agent" }));
    await waitFor(() => expect(client.workspace.agents.some((agent) => agent.name === "Inventory Visibility Agent")).toBe(true));
    expect(client.workspace.agents.find((agent) => agent.name === "Inventory Visibility Agent")!.instructions).toBe(inventoryInstructions);
    const routines = Object.values(client.host.state.workspaces).flatMap((workspace) => workspace.automations);
    expect(routines.find((routine) => routine.name === "Inventory exception review")).toMatchObject({ enabled: false, nextRunAt: null });
  });
  it("keeps oversized input intact, reports its limit, and never silently truncates or sends it", async () => {
    const { client, user } = await open();
    const document = "# Inventory instructions\n" + "x".repeat(64_001);
    await user.click(composer()); await user.paste(document);
    expect(composer()).toHaveValue(document);
    expect(screen.getByRole("alert")).toHaveTextContent("has not been truncated or sent");
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    expect(client.calls.some((call) => call.method === "twin.message")).toBe(false);
  });
  it("does not re-enter or truncate the canonical document when sending a follow-up", async () => {
    const { client, user } = await open();
    await user.click(composer()); await user.paste(inventoryInstructions);
    await user.click(screen.getByRole("button", { name: "Send" }));
    await screen.findByRole("article", { name: "Agent proposal" });
    await user.type(composer(), "Create a task to review supplier invoices.");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await screen.findByRole("article", { name: "Task proposal" });
    const followup = client.calls.filter((call) => call.method === "twin.message").at(-1)!.params as { history: { content: string }[] };
    expect(followup.history.every((turn) => turn.content.length <= 8000)).toBe(true);
    expect(client.host.state.conversations.finance!.turns[0]!.content).toBe(inventoryInstructions);
  });
});

describe("one shared agent computer with workspace-scoped activation and leases", () => {
  it("fails closed when activation binding is absent or belongs to another workspace", () => {
    const state = testHostState(), workspace = state.catalog.workspaces[0]!;
    for (const binding of [undefined, { id: "other", enabled: true, computerPolicy: "control" as const, approvalPolicy: "always" as const }]) {
      const view = render(<AgentComputer workspace={workspace} snapshot={state.workspaces.finance!} connected busy={false}
        operation={null} error="" needsRefresh={false} start={() => { throw new Error("Must not start an unbound computer."); }}
        stop={() => {}} refresh={() => {}} askTwin={() => {}}
        computer={{ ...state.computer, workspace: binding, state: "running", verified: true, verifiedAt: new Date().toISOString(),
          evidenceIds: ["foreign-evidence"], display: { state: "available", detail: "Foreign display" } }} />);
      expect(screen.getByRole("button", { name: "Start agent computer" })).toBeDisabled();
      expect(screen.queryByText("Local broker integrity verified")).not.toBeInTheDocument();
      expect(screen.queryByText("Foreign display")).not.toBeInTheDocument();
      expect(screen.getByText("Not enabled for this workspace")).toBeVisible();
      view.unmount();
    }
  });
  it("starts through the scoped broker control and never reuses activation or leases after switching", async () => {
    const { client, user } = await open(new FixtureClient(testHostState(["Finance studio", "Retail studio"])));
    await user.click(computerPanel().getByRole("button", { name: "Start agent computer" }));
    await waitFor(() => expect(client.host.state.computerEnabled).toEqual(["finance"]));
    expect(computerPanel().getByText("Enabled for this workspace")).toBeVisible();
    expect(computerPanel().getByText("Always require human approval")).toBeVisible();
    expect(computerPanel().getByText("Display unavailable")).toBeVisible();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Open workspace Retail studio" }));
    await screen.findByRole("heading", { name: "Retail studio Twin", level: 1 });
    await waitFor(() => expect(computerPanel().getByRole("button", { name: "Start agent computer" })).toBeEnabled());
    expect(computerPanel().getByText("Not enabled for this workspace")).toBeVisible();
    await user.click(computerPanel().getByRole("button", { name: "Start agent computer" }));
    await waitFor(() => expect(client.host.computerLeases).toHaveLength(2));
    expect(client.host.computerLeases[0]!.leaseId).not.toBe(client.host.computerLeases[1]!.leaseId);
    expect(client.calls.filter((call) => call.method === "computer.start").map((call) => call.params)).toEqual([
      { workspaceId: "finance" }, { workspaceId: "business-2" },
    ]);
    expect(client.calls.some((call) => /shell|vm\.|exec/.test(call.method))).toBe(false);
  });
  it("shows only the selected workspace's active lease and never exposes a sibling's lease identifiers", async () => {
    const state = testHostState(["Finance studio", "Retail studio"]);
    const leaseId = crypto.randomUUID();
    state.computer = { ...state.computer, state: "running",
      lease: { state: "held", id: leaseId, workspaceId: "finance", agentId: "finance-lead", agentWorkspaceId: "finance-execution", operation: "executing" } };
    const { user } = await open(new FixtureClient(state));
    expect(computerPanel().getByText(leaseId)).toBeVisible();
    expect(computerPanel().getByText("Operations analyst")).toBeVisible();
    expect(computerPanel().getByRole("button", { name: "Start agent computer" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Open workspace Retail studio" }));
    await screen.findByRole("heading", { name: "Retail studio Twin", level: 1 });
    expect(await computerPanel().findByText("Reserved elsewhere — no lease shared here")).toBeVisible();
    expect(computerPanel().queryByText(leaseId)).not.toBeInTheDocument();
    expect(computerPanel().queryByText("finance-execution")).not.toBeInTheDocument();
    expect(computerPanel().getByRole("button", { name: "Start agent computer" })).toBeDisabled();
  });
  it("shows starting without inventing running, and ignores the old operation when navigating away", async () => {
    const client = new FixtureClient(testHostState(["Finance studio", "Retail studio"]));
    let release!: () => void;
    client.computerGate = new Promise<void>((resolve) => { release = resolve; });
    const { user } = await open(client);
    await user.click(computerPanel().getByRole("button", { name: "Start agent computer" }));
    expect(await computerPanel().findByText("Starting")).toBeVisible();
    expect(computerPanel().queryByText("Enabled for this workspace")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Open workspace Retail studio" }));
    await screen.findByRole("heading", { name: "Retail studio Twin", level: 1 });
    await act(async () => { release(); });
    await waitFor(() => expect(client.host.computerLeases).toHaveLength(1));
    expect(client.host.computerLeases[0]!.workspaceId).toBe("finance");
    expect(computerPanel().queryByText("Enabled for this workspace")).not.toBeInTheDocument();
    expect(computerPanel().queryByText("Starting agent computer…")).not.toBeInTheDocument();
  });
  it("blocks replay when the broker reports an unresolved lease", async () => {
    const state = testHostState();
    state.computer = { ...state.computer, state: "unresolved",
      lease: { state: "unresolved", id: null, workspaceId: null, agentId: null, agentWorkspaceId: null, operation: null } };
    const { client } = await open(new FixtureClient(state));
    expect(computerPanel().getByText("Unresolved")).toBeVisible();
    expect(computerPanel().getByRole("button", { name: "Start agent computer" })).toBeDisabled();
    expect(computerPanel().getByText(/Do not replay it or reuse a lease/)).toBeVisible();
    expect(client.calls.some((call) => call.method === "computer.start")).toBe(false);
  });
});
