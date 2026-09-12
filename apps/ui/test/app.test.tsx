import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { App } from "../src/App";
import { DisconnectedClient } from "../src/client";
import { workspaceInputSchema } from "../src/model";
import { AgentForm, AutomationForm, SavedTaskForm, SettingsForm, TaskForm, WorkspaceForm } from "../src/forms";
import { FixtureClient, populatedClient, testAgent, testHostState, testStatus } from "./fixture";

async function open(client = new FixtureClient()) {
  const rendered = render(<App client={client} />);
  await screen.findByText("Local host connected");
  await waitFor(() => expect(screen.queryByRole("status", { name: "Loading workspace" })).not.toBeInTheDocument());
  const user = userEvent.setup();
  return { ...rendered, client, user };
}
const composer = () => screen.getByRole("textbox", { name: "Message your Work Twin" });
async function say(user: ReturnType<typeof userEvent.setup>, message: string) {
  await user.clear(composer()); await user.type(composer(), message);
  await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).toBeEnabled());
  await user.click(screen.getByRole("button", { name: "Send" }));
}
const tools = () => within(screen.getByRole("navigation", { name: "Workspace tools" }));

describe("conversation-first business workspaces", () => {
  it("creates independent workspaces through the concierge, without a blank setup form", async () => {
    const { client, user } = await open(new FixtureClient(testHostState([])));
    await user.click(screen.getByRole("button", { name: "New workspace" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await waitFor(() => expect(composer()).toHaveFocus());
    await say(user, "Create a workspace for finance, with safe invoice reviews.");
    const card = await screen.findByRole("article", { name: "Workspace proposal" });
    expect(client.host.state.catalog.workspaces).toHaveLength(0);
    await user.click(within(card).getByRole("button", { name: "Review details" }));
    const review = within(screen.getByRole("dialog", { name: "Review workspace proposal" }));
    expect(review.getByLabelText("Workspace name")).toHaveValue("Finance studio");
    expect(review.getByLabelText("Workspace purpose")).not.toHaveValue("");
    expect(review.getByLabelText("Twin instructions")).not.toHaveValue("");
    expect(review.getByText(/Drafted by your Work Twin/)).toBeVisible();
    await user.click(review.getByRole("button", { name: "Approve & create workspace" }));
    await screen.findByRole("heading", { name: "Finance studio Twin", level: 1 });
    const finance = client.host.state.catalog.workspaces[0]!;
    expect(finance.id).not.toBe(finance.leadAgentId);
    expect(client.host.state.workspaces[finance.id]!.agents).toHaveLength(1);
    expect(client.host.state.conversations[finance.id]!.turns).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "New workspace" }));
    await say(user, "Create a workspace for retail operations.");
    await user.click(await screen.findByRole("button", { name: "Approve & create workspace" }));
    await screen.findByRole("heading", { name: "Retail studio Twin", level: 1 });
    expect(client.host.state.catalog.workspaces).toHaveLength(2);
    expect(new Set(client.host.state.catalog.workspaces.map((item) => item.id)).size).toBe(2);
    expect(screen.getByRole("navigation", { name: "Business workspaces" }).querySelectorAll("button")).toHaveLength(2);
  });

  it.each([
    ["Review supplier invoices tomorrow.", "Task", "Task title", "Review supplier invoices", "Approve & create task"],
    ["Create an agent for finance reviews.", "Agent", "Agent name", "Finance analyst", "Approve & create agent"],
    ["Create a daily routine to review invoices at 9am.", "Routine", "Routine name", "Morning finance review", "Approve & create routine"],
    ["Change settings to a compact dark theme.", "Settings", "Workspace name", "Finance studio", "Approve & apply settings"],
  ])("drafts and prefills %s", async (message, kind, field, value, action) => {
    const { user, client } = await open();
    await say(user, message);
    const card = await screen.findByRole("article", { name: `${kind} proposal` });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(client.calls.some((call) => call.method === "twin.applyProposal")).toBe(false);
    await user.click(within(card).getByRole("button", { name: "Review details" }));
    const dialog = within(screen.getByRole("dialog"));
    expect(dialog.getByLabelText(field)).toHaveValue(value);
    if (kind === "Settings") {
      expect(dialog.getByLabelText("Theme")).toHaveValue("dark");
      expect(dialog.getByLabelText("New approval requests")).toBeChecked();
      expect(dialog.getByLabelText("Require approval")).toHaveValue("always");
    }
    for (const control of screen.getByRole("dialog").querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input[required], textarea[required]"))
      expect(control.value.trim()).not.toBe("");
    await user.click(dialog.getByRole("button", { name: action }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(client.calls.some((call) => call.method === "twin.applyProposal")).toBe(true);
    expect(await within(card).findByText("Applied", { exact: true })).toBeVisible();
  });

  it("applies directly and never opens a review sheet unless requested", async () => {
    const { client, user } = await open();
    await say(user, "Create an urgent task to review supplier invoices.");
    await user.click(screen.getByRole("button", { name: "Approve & create task" }));
    await waitFor(() => expect(client.workspace.tasks).toHaveLength(1));
    expect(client.workspace.tasks[0]).toMatchObject({ title: "Review supplier invoices", priority: "high", state: "queued" });
    expect(client.workspace.runs).toHaveLength(0);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    const apply = client.calls.find((call) => call.method === "twin.applyProposal")!;
    expect(apply.params).toMatchObject({ workspaceId: "finance", proposalHash: "a".repeat(64) });
    expect(apply.params).not.toHaveProperty("editedDraft");
  });

  it("sends small review edits without losing the Twin's complete input or immutable identity", async () => {
    const { client, user } = await open();
    await say(user, "Review supplier invoices.");
    await user.click(screen.getByRole("button", { name: "Review details" }));
    const dialog = within(screen.getByRole("dialog"));
    await user.clear(dialog.getByLabelText("Task title"));
    await user.type(dialog.getByLabelText("Task title"), "Review September invoices");
    await user.selectOptions(dialog.getByLabelText("Priority"), "high");
    await user.click(dialog.getByRole("button", { name: "Approve & create task" }));
    await waitFor(() => expect(client.workspace.tasks[0]?.title).toBe("Review September invoices"));
    const input = client.calls.find((call) => call.method === "twin.applyProposal")!.params as Record<string, any>;
    expect(input.editedDraft).toMatchObject({ requestId: client.host.state.conversations.finance!.proposals[0]!.draft!.requestId,
      title: "Review September invoices", agentId: "finance-lead", priority: "high" });
    expect(input.editedDraft.instructions).toContain("Do not send payments");
  });

  it("uses follow-up questions and history instead of offering incomplete forms", async () => {
    const { user, client } = await open();
    await say(user, "Help me plan something useful.");
    expect(await screen.findByText("What outcome should the task produce?")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Review details" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Approve &/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Reply to Twin" }));
    await waitFor(() => expect(composer()).toHaveFocus());
    await say(user, "Review supplier invoices tomorrow.");
    expect(await screen.findByRole("article", { name: "Task proposal" })).toBeVisible();
    const input = client.calls.filter((call) => call.method === "twin.message").at(-1)!.params as Record<string, any>;
    expect(input.history.map((turn: { role: string }) => turn.role)).toEqual(["user", "assistant"]);
    expect(input.history[0].content).toBe("Help me plan something useful.");
    expect(input.contextRevision).toBe(9);
  });

  it("persists dismissal, never creates work, and keeps the conversation after reopening", async () => {
    const { user, client, unmount } = await open();
    await say(user, "Review supplier invoices.");
    await user.click(await screen.findByRole("button", { name: "Dismiss" }));
    await within(screen.getByRole("article", { name: "Task proposal" })).findByText("Dismissed", { exact: true });
    expect(client.workspace.tasks).toHaveLength(0);
    expect(screen.queryByRole("button", { name: "Approve & create task" })).not.toBeInTheDocument();
    unmount();
    await open(client);
    expect(await within(screen.getByRole("article", { name: "Task proposal" })).findByText("Dismissed", { exact: true })).toBeVisible();
    expect(within(screen.getByRole("button", { name: "Open workspace Finance studio" })).getByText("Dismissed", { exact: true })).toBeVisible();
    expect(screen.getByText("Review supplier invoices.", { exact: true })).toBeVisible();
  });

  it("makes every create control seed and focus the Twin, not open a blank form", async () => {
    const { user, client } = await open();
    for (const [name, seed] of [["New task", "Create a task to "], ["New agent", "Create an agent responsible for "], ["New routine", "Create a routine that "]]) {
      await user.click(screen.getByRole("button", { name }));
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(composer()).toHaveValue(seed); await waitFor(() => expect(composer()).toHaveFocus());
    }
    for (const [area, action] of [["Tasks", "New task with Twin"], ["Agents", "New agent with Twin"], ["Routines", "New routine with Twin"]]) {
      await user.click(tools().getByRole("button", { name: area }));
      const inspector = within(screen.getByRole("dialog"));
      expect(inspector.queryByRole("textbox", { name: /Task title|Agent name|Routine name/ })).not.toBeInTheDocument();
      await user.click(inspector.getByRole("button", { name: action }));
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      await waitFor(() => expect(composer()).toHaveFocus());
    }
    await user.click(tools().getByRole("button", { name: "Settings" }));
    expect(screen.queryByLabelText("Workspace name")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Change settings with Twin" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(composer()).toHaveValue("Change this workspace's settings to ");
    expect(client.calls.some((call) => ["agents.save", "work.createTask", "automations.save", "settings.update"].includes(call.method))).toBe(false);
  });

  it("only edits existing agents and settings from fully prefilled saved records", async () => {
    const { user, client } = await open();
    await user.click(tools().getByRole("button", { name: "Agents" }));
    await user.click(screen.getByRole("button", { name: "Configure agent" }));
    const dialog = within(screen.getByRole("dialog", { name: "Review saved agent" }));
    expect(dialog.getByLabelText("Agent name")).toHaveValue("Operations analyst");
    expect(dialog.getByText(/Prefilled from the saved workspace record/)).toBeVisible();
    await user.clear(dialog.getByLabelText("Role")); await user.type(dialog.getByLabelText("Role"), "Procurement");
    await user.click(dialog.getByRole("button", { name: "Save agent" }));
    await waitFor(() => expect(client.workspace.agents[0]?.role).toBe("Procurement"));
    expect(client.calls.find((call) => call.method === "agents.save")!.params).toMatchObject({ workspaceId: "finance", id: "finance-lead" });
  });

  it("preserves scoped assignment, explicit run start, and cancellation from saved task reviews", async () => {
    const client = new FixtureClient();
    client.workspace.agents.push({ ...testAgent, id: "second-agent", name: "Second analyst", workspaceId: "second-execution" });
    const { user } = await open(client);
    await say(user, "Review supplier invoices.");
    await user.click(await screen.findByRole("button", { name: "Approve & create task" }));
    await within(screen.getByRole("article", { name: "Task proposal" })).findByText("Applied", { exact: true });
    await user.click(tools().getByRole("button", { name: "Tasks" }));
    await user.click(screen.getByRole("button", { name: "Review saved task" }));
    const review = within(screen.getByRole("dialog", { name: "Review saved task" }));
    expect(review.getByLabelText("Task title")).toHaveValue("Review supplier invoices");
    expect(review.getByLabelText("Task title")).toHaveAttribute("readonly");
    expect(review.getByLabelText("Assign to")).toHaveValue("finance-lead");
    await user.selectOptions(review.getByLabelText("Assign to"), "second-agent");
    await user.click(review.getByRole("button", { name: "Save assignment" }));
    await waitFor(() => expect(client.workspace.tasks[0]!.agentId).toBe("second-agent"));
    expect(client.calls.find((call) => call.method === "work.assignTask")!.params).toMatchObject({ workspaceId: "finance", agentId: "second-agent" });
    await user.click(screen.getByRole("button", { name: "Start task" }));
    await waitFor(() => expect(client.workspace.runs[0]!.state).toBe("running"));
    expect(client.workspace.runs[0]!.verification).toBe("not_checked");
    await user.click(screen.getByRole("tab", { name: "Runs" }));
    await user.click(screen.getByRole("button", { name: "Cancel run" }));
    await user.click(within(screen.getByRole("dialog", { name: "Cancel this run?" })).getByRole("button", { name: "Cancel run" }));
    await waitFor(() => expect(client.workspace.runs[0]!.state).toBe("cancelled"));
    expect(client.calls.find((call) => call.method === "runs.cancel")!.params).toMatchObject({ workspaceId: "finance" });
  });

  it("keeps existing routine reviews prefilled and reports failed activation without inventing a next run", async () => {
    const { client, user } = await open();
    await say(user, "Create a daily routine to review invoices.");
    await user.click(await screen.findByRole("button", { name: "Approve & create routine" }));
    await within(screen.getByRole("article", { name: "Routine proposal" })).findByText("Applied", { exact: true });
    client.host.state.status = testStatus(false);
    await user.click(tools().getByRole("button", { name: "Routines" }));
    await user.click(screen.getByRole("button", { name: "Review routine" }));
    const review = within(screen.getByRole("dialog", { name: "Review saved routine" }));
    expect(review.getByLabelText("Routine name")).toHaveValue("Morning finance review");
    expect(review.getByLabelText("Local time")).toHaveValue("09:00");
    await user.click(review.getByLabelText("Enable this routine"));
    await user.click(review.getByRole("button", { name: "Save routine" }));
    expect(await review.findByRole("alert")).toHaveTextContent("Scheduling runtime is not configured");
    expect(client.workspace.automations[0]).toMatchObject({ enabled: false, nextRunAt: null });
    await user.click(review.getByLabelText("Enable this routine"));
    await user.click(review.getByRole("button", { name: "Save routine" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Review saved routine" })).not.toBeInTheDocument());
  });

  it("refuses an incomplete host draft even if it claims to be ready for review", async () => {
    const { user, client } = await open();
    client.host.nextDraft = { ...client.host.makeDraft({ workspaceId: "finance", message: "Review invoices.", history: [] }),
      draft: { title: "Incomplete draft" } };
    await say(user, "Review supplier invoices.");
    await screen.findByRole("article", { name: "Task proposal" });
    expect(screen.queryByRole("button", { name: "Review details" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve & create task" })).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(client.workspace.tasks).toHaveLength(0);
  });
  it("exposes the full prefilled starter routine schedule and activation policy before workspace creation", async () => {
    const client = new FixtureClient(testHostState([]));
    const proposal = client.host.makeDraft({ workspaceId: null, message: "Create a finance workspace.", history: [] });
    const draft = workspaceInputSchema.parse(proposal.draft);
    draft.starterRoutines.push({ id: crypto.randomUUID(), name: "Friday finance review", taskTitle: "Review weekly exceptions",
      instructions: "Cite the source invoices and do not send payments.", agentId: draft.leadAgent.id,
      cadence: { kind: "weekly", weekday: 5, at: "09:00", timezone: "UTC" }, enabled: true });
    client.host.nextDraft = { ...proposal, draft };
    const { user } = await open(client);
    await say(user, "Create a finance workspace.");
    expect(await screen.findByText("1 routine requests activation")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Review details" }));
    const review = within(screen.getByRole("dialog"));
    await user.click(review.getByText("Prefilled team, policies & starter work"));
    expect(review.getByText("Friday at 09:00 · UTC")).toBeVisible();
    expect(review.getByText("Review weekly exceptions")).toBeVisible();
    expect(review.getByText(/Requests activation on creation/)).toBeVisible();
    expect(client.host.state.catalog.workspaces).toHaveLength(0);
  });

  it("isolates conversation, unsent composer, and review state when switching workspaces", async () => {
    const { client, user } = await open(new FixtureClient(testHostState(["Finance studio", "Retail studio"])));
    await say(user, "Private finance review.");
    await user.click(await screen.findByRole("button", { name: "Review details" }));
    await user.clear(screen.getByLabelText("Task title")); await user.type(screen.getByLabelText("Task title"), "Uncommitted finance edit");
    await user.click(screen.getByRole("button", { name: "Open workspace Retail studio" }));
    await screen.findByRole("heading", { name: "Retail studio Twin", level: 1 });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(composer()).toHaveValue("");
    expect(screen.getByRole("log")).not.toHaveTextContent("Private finance review.");
    await user.type(composer(), "Retail unsent request");
    await user.click(screen.getByRole("button", { name: "Open workspace Finance studio" }));
    await screen.findByRole("article", { name: "Task proposal" });
    expect(composer()).toHaveValue("");
    expect(screen.getByRole("log")).not.toHaveTextContent("Retail unsent request");
    await user.click(screen.getByRole("button", { name: "Review details" }));
    expect(screen.getByLabelText("Task title")).toHaveValue("Review supplier invoices");
    expect(client.host.state.conversations["business-2"]!.turns).toHaveLength(0);
    await waitFor(() => expect([...client.host.subscriptions.values()].every((id) => id === "finance")).toBe(true));
  });

  it("does not deliver late responses into a different workspace", async () => {
    const client = new FixtureClient(testHostState(["Finance studio", "Retail studio"]));
    let release!: () => void;
    client.messageGate = new Promise<void>((resolve) => { release = resolve; });
    const { user } = await open(client);
    await say(user, "Private finance request while waiting.");
    await screen.findByRole("button", { name: "Working…" });
    await user.click(screen.getByRole("button", { name: "Open workspace Retail studio" }));
    await screen.findByRole("heading", { name: "Retail studio Twin", level: 1 });
    await act(async () => { release(); });
    await waitFor(() => expect(client.host.state.conversations.finance!.turns).toHaveLength(2));
    expect(screen.getByRole("log")).not.toHaveTextContent("Private finance request");
    expect(screen.queryByRole("article", { name: "Task proposal" })).not.toBeInTheDocument();
    expect(composer()).toHaveValue("");
    client.messageGate = null;
    await user.click(screen.getByRole("button", { name: "Open workspace Finance studio" }));
    expect(await screen.findByRole("article", { name: "Task proposal" })).toBeVisible();
  });

  it("keeps approval recommendations separate from explicit human decisions", async () => {
    const { client, user } = await open(populatedClient());
    await say(user, "Review pending approval and recommend whether to approve or deny.");
    const card = await screen.findByRole("article", { name: "Approval recommendation proposal" });
    expect(within(card).queryByRole("button", { name: /Approve &/ })).not.toBeInTheDocument();
    expect(client.workspace.approvals[0]!.state).toBe("pending");
    await user.click(within(card).getByRole("button", { name: "Review decision" }));
    const dialog = within(screen.getByRole("dialog", { name: "Your approval decision" }));
    expect(dialog.getByLabelText("Decision reason")).toHaveValue("Confirm the reviewer and the financial data scope before sending.");
    expect(dialog.queryByLabelText("Decision")).not.toBeInTheDocument();
    fireEvent.submit(dialog.getByLabelText("Decision reason").closest("form")!);
    expect(client.calls.some((call) => call.method === "approvals.decide" || call.method === "twin.applyProposal")).toBe(false);
    await user.click(dialog.getByRole("button", { name: "Deny action" }));
    await waitFor(() => expect(client.workspace.approvals[0]!.state).toBe("denied"));
    expect(client.workspace.runs[0]!.state).toBe("awaiting_approval");
    expect(client.calls.find((call) => call.method === "approvals.decide")!.params).toMatchObject({ workspaceId: "finance", decision: "denied" });
  });

  it("keeps failed or unavailable Twin requests honest and retains the user's text", async () => {
    const { client, user } = await open();
    client.host.failure = "The model provider is unavailable. No proposal was generated.";
    await say(user, "Review supplier invoices.");
    expect(await screen.findByRole("alert")).toHaveTextContent("No proposal was generated");
    expect(composer()).toHaveValue("Review supplier invoices.");
    expect(screen.queryByRole("article", { name: "Task proposal" })).not.toBeInTheDocument();
    act(() => client.host.connection({ state: "offline", detail: "Host exited." }));
    expect(await screen.findByText(/last loaded records/)).toBeVisible();
    expect(screen.getByRole("button", { name: "New task" })).toBeDisabled();
    await waitFor(() => expect(client.host.subscriptions.size).toBe(0));
  });

  it("renders a disconnected production state without fabricated records or old navigation", async () => {
    render(<App client={new DisconnectedClient()} />);
    expect(await screen.findByRole("heading", { name: "Connect to your local host" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    expect(screen.queryByRole("navigation", { name: "Primary navigation" })).not.toBeInTheDocument();
    expect(screen.queryByText(/marketplace|compatibility|legacy UI/i)).not.toBeInTheDocument();
  });
});

describe("blank review sheets are structurally unreachable", () => {
  const props = { source: "twin" as const, onSave: async () => true, onClose: () => {}, busy: false, error: "" };
  it("requires a complete draft prop at both the type and runtime boundaries", () => {
    // @ts-expect-error A draft is deliberately missing to guard against optional creation props.
    const task = <TaskForm {...props} agents={[]} />;
    // @ts-expect-error A draft is deliberately missing to guard against optional creation props.
    const agent = <AgentForm {...props} providers={[]} />;
    // @ts-expect-error A draft is deliberately missing to guard against optional creation props.
    const automation = <AutomationForm {...props} agents={[]} />;
    // @ts-expect-error A draft is deliberately missing to guard against optional creation props.
    const settings = <SettingsForm {...props} />;
    // @ts-expect-error A draft is deliberately missing to guard against optional creation props.
    const workspace = <WorkspaceForm {...props} />;
    // @ts-expect-error Saved review must have an existing task, never a blank template.
    const savedTask = <SavedTaskForm {...props} agents={[]} assignable={false} onAssign={async () => true} />;
    for (const component of [task, agent, automation, settings, workspace, savedTask]) {
      const result = render(component);
      expect(result.container.querySelector("form")).toBeNull();
      expect(screen.getByRole("alert")).toHaveTextContent("no blank form");
      result.unmount();
    }
  });
});
