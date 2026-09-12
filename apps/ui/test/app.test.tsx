import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { DisconnectedClient } from "../src/client";
import { ProposalReview } from "../src/forms";
import { twinDraftSchema } from "../src/model";
import { draftFor, FixtureClient, populatedClient, summaryFor, testAgent, testStatus } from "./fixture";
import { inventoryVisibilityInstructions } from "../../../tests/fixtures/instruction-documents";

async function open(client = new FixtureClient()) {
  render(<App client={client} />);
  await screen.findByRole("heading", { name: "Work", level: 1 });
  await waitFor(() => expect(screen.queryByRole("status", { name: "Loading workspace" })).not.toBeInTheDocument());
  return { client, user: userEvent.setup() };
}
const primary = () => within(screen.getByRole("navigation", { name: "Primary navigation" }));
const panel = () => within(screen.getByRole("complementary", { name: "Agent computer panel" }));
const composer = () => screen.getByRole("textbox", { name: "Your intent or full instruction document" });
function agentInput(name = "Procurement analyst") {
  const { workspaceId: _workspaceId, updatedAt: _updatedAt, ...input } = testAgent;
  return { ...input, id: crypto.randomUUID(), name, role: "Procurement", instructions: "Review supplier evidence and flag exceptions.", suggestedRoutines: [] };
}
async function send(user: ReturnType<typeof userEvent.setup>, message: string) {
  await user.type(composer(), message);
  await user.click(screen.getByRole("button", { name: "Send intent" }));
  await screen.findByRole("button", { name: "Review complete draft" });
}

describe("conversation-first three-column workspace", () => {
  it("keeps a right-side agent-computer panel present in every primary area without fabricated state", async () => {
    const { user } = await open();
    expect(document.querySelector('[data-layout="three-column-twin"]')).not.toBeNull();
    expect(primary().getAllByRole("link").map((link) => link.textContent)).toEqual(["Work", "Agents", "Automations", "Settings"]);
    for (const name of ["Work", "Agents", "Automations", "Settings"]) {
      await user.click(primary().getByRole("link", { name }));
      expect(panel().getByRole("button", { name: "Start agent computer" })).toBeVisible();
      expect(panel().getByRole("button", { name: "Start agent computer" })).toBeDisabled();
      expect(panel().getByText("Unavailable", { exact: true })).toBeVisible();
      expect(panel().getByText("Screen unavailable")).toBeVisible();
      expect(panel().getByText("Always require approval")).toBeVisible();
    }
  });

  it.each(["Work", "Agents", "Automations", "Settings", "Workspace"])(
    "%s starts with intent, never an empty creation form", async (area) => {
      const { user, client } = await open();
      if (area === "Workspace") await user.click(screen.getByRole("button", { name: "New workspace" }));
      else {
        await user.click(primary().getByRole("link", { name: area }));
        const button = area === "Work" ? "New task" : area === "Agents" ? "New agent" : area === "Automations" ? "New routine" : "Discuss settings";
        await user.click(screen.getByRole("button", { name: button }));
      }
      await waitFor(() => expect(composer()).toHaveFocus());
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(screen.queryByRole("form", { name: /^Review / })).not.toBeInTheDocument();
      expect(screen.queryByLabelText("Agent name")).not.toBeInTheDocument();
      expect(screen.queryByLabelText("Task title")).not.toBeInTheDocument();
      expect(client.calls.some((call) => ["agents.save", "work.createTask", "workspaces.create", "automations.save", "settings.update"].includes(call.method))).toBe(false);
    },
  );

  it.each([undefined, { kind: "agent", draft: {} }, { kind: "task", readyForReview: true }])(
    "cannot render a creation review without a complete proposal", (proposal) => {
      const client = new FixtureClient();
      render(<ProposalReview proposal={proposal as never} workspace={summaryFor(client.workspace)} snapshot={client.workspace}
        busy={false} error="" onClose={() => {}} apply={vi.fn()} />);
      expect(screen.getByRole("alert")).toHaveTextContent("complete");
      expect(screen.queryByRole("form")).not.toBeInTheDocument();
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    },
  );

  it("opens only prefilled agent drafts, applies reviewed edits, and reviews existing records without a new intake", async () => {
    const client = new FixtureClient(); client.status = testStatus(true);
    client.propose = () => draftFor("agent", agentInput());
    const { user } = await open(client);
    await user.click(primary().getByRole("link", { name: "Agents" }));
    await user.click(screen.getByRole("button", { name: "New agent" }));
    await send(user, "Create a procurement analyst to review supplier evidence.");
    expect(client.workspace.agents).toEqual([]);
    await user.click(screen.getByRole("button", { name: "Review complete draft" }));
    let dialog = within(screen.getByRole("dialog", { name: "Review agent draft" }));
    expect(dialog.getByLabelText("Agent name")).toHaveValue("Procurement analyst");
    expect(dialog.getByLabelText("Agent instructions")).toHaveValue("Review supplier evidence and flag exceptions.");
    await user.clear(dialog.getByLabelText("Role")); await user.type(dialog.getByLabelText("Role"), "Procurement coordination");
    await user.click(dialog.getByRole("button", { name: "Approve draft" }));
    await waitFor(() => expect(client.workspace.agents[0]?.role).toBe("Procurement coordination"));
    expect(client.calls.some((call) => call.method === "agents.save")).toBe(false);
    await user.click(primary().getByRole("link", { name: "Automations" }));
    await user.click(screen.getByRole("button", { name: "Review Procurement analyst" }));
    dialog = within(screen.getByRole("dialog", { name: "Review existing agent" }));
    expect(dialog.getByLabelText("Role")).toHaveValue("Procurement coordination");
    await user.click(dialog.getByRole("button", { name: "Save reviewed changes" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(client.calls.find((call) => call.method === "agents.save")?.params).toMatchObject({ workspaceId: client.workspace.workspaceId });
  });

  it("creates a workspace only from a complete reviewed proposal and opens its own computer context", async () => {
    const client = new FixtureClient(); client.status = testStatus(true);
    const { suggestedRoutines: _suggestions, ...leadAgent } = agentInput("Orion lead");
    client.propose = () => draftFor("workspace", {
      requestId: crypto.randomUUID(), name: "Orion", purpose: "Evidence-backed inventory work.",
      twin: { name: "Orion Twin", instructions: "Prepare complete work for human review." },
      leadAgent, starterTask: null, starterRoutines: [], approvalPolicy: "always", computerPolicy: "none",
    }, null);
    const { user } = await open(client);
    await user.click(screen.getByRole("button", { name: "New workspace" }));
    await waitFor(() => expect(composer()).toHaveFocus());
    await send(user, "Create Orion for inventory work.");
    expect(client.workspaces.size).toBe(1);
    await user.click(screen.getByRole("button", { name: "Review complete draft" }));
    expect(screen.getByLabelText("Workspace name")).toHaveValue("Orion");
    expect(screen.getByLabelText("Lead agent name")).toHaveValue("Orion lead");
    await user.click(screen.getByRole("button", { name: "Approve draft" }));
    await waitFor(() => expect(panel().getByText("Scoped to Orion")).toBeVisible());
    expect(client.workspaces.size).toBe(2);
    expect(client.calls.some((call) => call.method === "workspaces.create")).toBe(false);
  });

  it("retains a concierge instruction document when the only necessary follow-up is workspace selection", async () => {
    const client = new FixtureClient(); client.status = testStatus(true);
    const document = "# Inventory Visibility Agent — Manual Global Instructions\nRetain the exact evidence wording.\n";
    client.propose = () => twinDraftSchema.parse({
      ...draftFor("agent", agentInput(), null), kind: "clarification", readyForReview: false,
      missing: ["workspaceId"], draft: null, assistantMessage: "Which business workspace should own this agent?",
    });
    const { user } = await open(client);
    await user.click(screen.getByRole("button", { name: "Owner concierge" }));
    await waitFor(() => expect(composer()).toBeEnabled());
    fireEvent.paste(composer(), { clipboardData: { getData: () => document } });
    await user.click(screen.getByRole("button", { name: "Send intent" }));
    await screen.findByText("Which business workspace should own this agent?");
    await user.click(screen.getByRole("button", { name: "Open Operations" }));
    await waitFor(() => expect(composer()).toHaveValue(document));
    expect(client.calls.filter((call) => call.method === "twin.message")).toHaveLength(1);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("passes a long pasted instruction document unchanged and shows it verbatim in a populated review", async () => {
    const client = new FixtureClient(); client.status = testStatus(true);
    client.propose = (request) => {
      const proposal = draftFor("agent", { ...agentInput("Inventory Visibility Agent"), instructions: request.message, enabled: false });
      proposal.basis!.instructionDocument = { turnId: crypto.randomUUID(), contentHash: "c".repeat(64) };
      return proposal;
    };
    const { user } = await open(client);
    fireEvent.paste(composer(), { clipboardData: { getData: () => inventoryVisibilityInstructions } });
    await user.click(screen.getByRole("button", { name: "Send intent" }));
    await user.click(await screen.findByRole("button", { name: "Review complete draft" }));
    expect(screen.getByLabelText("Preserved instruction document").textContent).toBe(inventoryVisibilityInstructions);
    expect(within(screen.getByRole("dialog")).getByLabelText("Agent name")).toHaveValue("Inventory Visibility Agent");
    expect(client.calls.find((call) => call.method === "twin.message")?.params).toMatchObject({ message: inventoryVisibilityInstructions, workspaceId: "test-workspace" });
    await user.click(screen.getByRole("button", { name: "Approve draft" }));
    await waitFor(() => expect(client.workspace.agents[0]?.instructions).toBe(inventoryVisibilityInstructions));
  });

  it("does not truncate or submit an oversized paste", async () => {
    const { client } = await open();
    const document = "# Agent instructions\n" + "x".repeat(64_001);
    fireEvent.paste(composer(), { clipboardData: { getData: () => document } });
    expect(composer()).toHaveValue(document);
    expect(screen.getByRole("alert")).toHaveTextContent("Nothing was truncated or submitted");
    expect(screen.getByRole("button", { name: "Send intent" })).toBeDisabled();
    expect(client.calls.some((call) => call.method === "twin.message")).toBe(false);
  });

  it("creates work through a task proposal, then starts and cancels only scoped runtime work", async () => {
    const client = new FixtureClient(); client.status = testStatus(true); client.workspace.agents.push(testAgent);
    client.propose = () => draftFor("task", { requestId: crypto.randomUUID(), title: "Review a contract",
      instructions: "Cite material risks.", agentId: testAgent.id, priority: "normal" });
    const { user } = await open(client);
    await send(user, "Review the contract and cite material risks.");
    await user.click(screen.getByRole("button", { name: "Review complete draft" }));
    expect(screen.getByLabelText("Task title")).toHaveValue("Review a contract");
    await user.click(screen.getByRole("button", { name: "Approve draft" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "Start task" }));
    await waitFor(() => expect(client.workspace.runs).toHaveLength(1));
    expect(client.workspace.runs[0]?.verification).toBe("not_checked");
    await user.click(screen.getByRole("tab", { name: "Runs" }));
    await user.click(screen.getByRole("button", { name: "Cancel run" }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel run" }));
    await waitFor(() => expect(client.workspace.runs[0]?.state).toBe("cancelled"));
    expect(client.calls.find((call) => call.method === "runs.start")?.params).toMatchObject({ workspaceId: "test-workspace" });
  });

  it("keeps approval recommendations non-executing until a separate explicit human decision", async () => {
    const client = populatedClient();
    client.propose = () => draftFor("approval", { approvalId: "test-approval", operationHash: "a".repeat(64), recommendation: "approve", reason: "Check the recipient first." });
    const { user } = await open(client);
    await user.type(composer(), "Recommend whether to approve this action.");
    await user.click(screen.getByRole("button", { name: "Send intent" }));
    await user.click(await screen.findByRole("button", { name: "Review approval decision" }));
    expect(client.workspace.approvals[0]!.state).toBe("pending");
    expect(client.calls.some((call) => call.method === "approvals.decide" || call.method === "twin.applyProposal")).toBe(false);
    await user.click(screen.getByRole("button", { name: "Deny action" }));
    await waitFor(() => expect(client.workspace.approvals[0]!.state).toBe("denied"));
    expect(client.workspace.runs[0]!.state).toBe("awaiting_approval");
    await user.click(screen.getByRole("tab", { name: "Artifacts & evidence" }));
    client.content = '<script>alert("untrusted")</script>';
    await user.click(screen.getByRole("button", { name: "View artifact" }));
    const content = await screen.findByLabelText("Artifact content");
    expect(content.textContent).toBe(client.content); expect(content.querySelector("script")).toBeNull();
  });

  it("reviews complete routine and settings drafts instead of initial forms", async () => {
    const client = new FixtureClient(); client.status = testStatus(true); client.workspace.agents.push(testAgent);
    client.propose = (request) => request.target === "settings" ? draftFor("settings", { appearance: { theme: "dark", density: "compact" } })
      : draftFor("automation", { id: crypto.randomUUID(), name: "Morning review", taskTitle: "Review pending work",
        instructions: "Report exceptions only.", agentId: testAgent.id, cadence: { kind: "interval", minutes: 60 }, enabled: false });
    const { user } = await open(client);
    await user.click(primary().getByRole("link", { name: "Automations" }));
    await user.click(screen.getByRole("button", { name: "New routine" }));
    await send(user, "Review work every hour, but leave the routine disabled.");
    await user.click(screen.getByRole("button", { name: "Review complete draft" }));
    expect(screen.getByLabelText("Routine name")).toHaveValue("Morning review");
    expect(screen.getByLabelText("Drafted cadence")).toHaveTextContent('"minutes": 60');
    await user.click(screen.getByRole("button", { name: "Approve draft" }));
    await waitFor(() => expect(client.workspace.automations[0]).toMatchObject({ enabled: false, nextRunAt: null }));
    await user.click(primary().getByRole("link", { name: "Settings" }));
    expect(screen.queryByLabelText("Theme")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Discuss settings" }));
    await send(user, "Use a dark compact workspace.");
    await user.click(screen.getByRole("button", { name: "Review complete draft" }));
    expect(screen.getByLabelText("Theme")).toHaveValue("dark");
    expect(screen.getByLabelText("Workspace name")).toHaveValue("Operations");
    await user.click(screen.getByRole("button", { name: "Approve draft" }));
    await waitFor(() => expect(client.workspace.settings.appearance).toEqual({ theme: "dark", density: "compact" }));
  });

  it("clears computer state on switching and never applies a late start response or lease to another workspace", async () => {
    const client = new FixtureClient(); client.machineState = "stopped"; client.status = testStatus(true);
    client.addWorkspace("second-workspace", "Borealis");
    let release!: () => void; client.startGate = new Promise<void>((resolve) => { release = resolve; });
    const { user } = await open(client);
    await user.click(panel().getByRole("button", { name: "Start agent computer" }));
    expect(panel().getByRole("button", { name: "Starting agent computer…" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Open Borealis" }));
    await waitFor(() => expect(panel().getByText("Scoped to Borealis")).toBeVisible());
    expect(panel().getByText("Busy in another workspace")).toBeVisible();
    await act(async () => { release(); });
    await waitFor(() => expect(panel().getByText("Running", { exact: true })).toBeVisible());
    expect(panel().getByText("Not enabled")).toBeVisible();
    expect(panel().queryByText("Enabled for fresh scoped tool leases")).not.toBeInTheDocument();
    await user.click(panel().getByRole("button", { name: "Start agent computer" }));
    await waitFor(() => expect(panel().getByText("Enabled for fresh scoped tool leases")).toBeVisible());
    expect(client.calls.filter((call) => call.method === "computer.start").map((call) => call.params))
      .toEqual([{ workspaceId: "test-workspace" }, { workspaceId: "second-workspace" }]);
  });

  it("shows unresolved computer status and refuses a start without a recovery result", async () => {
    const client = new FixtureClient(); client.machineState = "unresolved";
    await open(client);
    expect(panel().getByText("Unresolved", { exact: true })).toBeVisible();
    expect(panel().getByText("Unresolved — recovery required")).toBeVisible();
    expect(panel().getByRole("button", { name: "Start agent computer" })).toBeDisabled();
  });
  it("retains intent on model failure rather than opening a fallback create form", async () => {
    const { user, client } = await open();
    await user.type(composer(), "Make an inventory agent.");
    await user.click(screen.getByRole("button", { name: "Send intent" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("No injected model response");
    expect(composer()).toHaveValue("Make an inventory agent.");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(); expect(client.workspace.agents).toEqual([]);
  });
  it("retains same-workspace stale data but disables actions after disconnect", async () => {
    const { client } = await open(populatedClient());
    act(() => client.connection?.({ state: "offline", detail: "Host exited." }));
    expect(screen.getByRole("button", { name: "New task" })).toBeDisabled();
    expect(panel().getByRole("button", { name: "Start agent computer" })).toBeDisabled();
    expect(screen.getByRole("heading", { name: "Review supplier invoices" })).toBeVisible();
    await waitFor(() => expect(client.listeners.size).toBe(0));
  });
  it("renders an honest disconnected production state with no AI or computer fallback", async () => {
    render(<App client={new DisconnectedClient()} />);
    expect(await screen.findByRole("heading", { name: "Connect your local workspace" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Send intent" })).toBeDisabled();
    expect(panel().getByRole("button", { name: "Start agent computer" })).toBeDisabled();
  });
});
