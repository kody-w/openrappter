import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { App } from "../src/App";
import { DisconnectedClient } from "../src/client";
import { FixtureClient, populatedClient, testAgent, testStatus } from "./fixture";

async function open(client = new FixtureClient()) {
  render(<App client={client} />);
  await screen.findByRole("heading", { name: "Work", level: 1 });
  await waitFor(() => expect(screen.queryByRole("status", { name: "Loading workspace" })).not.toBeInTheDocument());
  return { client, user: userEvent.setup() };
}
const primary = () => within(screen.getByRole("navigation", { name: "Primary navigation" }));
describe("RAPP Work business workspace", () => {
  it("exposes exactly four primary areas and no fabricated production records", async () => {
    await open();
    expect(primary().getAllByRole("link").map((link) => link.textContent)).toEqual(["Work", "Agents", "Automations", "Settings"]);
    expect(screen.getByText("Make room for meaningful work")).toBeVisible();
    expect(screen.queryByText(/Compatibility|Show-and-Tell|RAPPIDs|OpenRappter|Surgeon|Skills marketplace|Zen/)).not.toBeInTheDocument();
  });
  it("creates a persisted roster entry, edits it, and keeps the roster between areas", async () => {
    const { user, client } = await open();
    await user.click(primary().getByRole("link", { name: "Agents" }));
    await user.click(screen.getByRole("button", { name: "New agent" }));
    let dialog = screen.getByRole("dialog", { name: "Create an agent" });
    await user.type(within(dialog).getByLabelText("Agent name"), "Procurement analyst");
    await user.type(within(dialog).getByLabelText("Agent instructions"), "Review supplier requests and retain evidence.");
    await user.click(within(dialog).getByRole("button", { name: "Create agent" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(client.workspace.agents[0]?.name).toBe("Procurement analyst");
    await user.click(primary().getByRole("link", { name: "Automations" }));
    const sidebar = within(screen.getByRole("complementary", { name: "Workspace sidebar" }));
    await user.click(sidebar.getByRole("button", { name: /Procurement analyst/ }));
    dialog = screen.getByRole("dialog", { name: "Configure agent" });
    await user.clear(within(dialog).getByLabelText("Role"));
    await user.type(within(dialog).getByLabelText("Role"), "Procurement");
    await user.click(within(dialog).getByRole("button", { name: "Save agent" }));
    await waitFor(() => expect(client.workspace.agents[0]?.role).toBe("Procurement"));
  });
  it("creates, starts, and cancels a task through the injected service without inventing verification", async () => {
    const client = new FixtureClient();
    client.workspace.agents.push(testAgent); client.status = testStatus(true);
    const { user } = await open(client);
    await user.click(screen.getByRole("button", { name: "New task" }));
    const dialog = screen.getByRole("dialog");
    await user.type(within(dialog).getByLabelText("Task title"), "Review a contract");
    await user.type(within(dialog).getByLabelText("Instructions and expected outcome"), "List material risks with supporting clauses.");
    await user.selectOptions(within(dialog).getByLabelText("Assign to"), testAgent.id);
    await user.click(within(dialog).getByRole("button", { name: "Create task" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "Start task" }));
    await screen.findByText("Run accepted by the connected runtime.");
    expect(client.workspace.runs).toHaveLength(1);
    expect(screen.getByText("Not verified")).toBeVisible();
    await user.click(screen.getByRole("tab", { name: "Runs" }));
    await user.click(screen.getByRole("button", { name: "Cancel run" }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel run" }));
    await waitFor(() => expect(client.workspace.runs[0]?.state).toBe("cancelled"));
  });
  it("records scoped approval decisions and displays artifact content as text", async () => {
    const { user, client } = await open(populatedClient());
    await user.click(screen.getByRole("tab", { name: "Approvals 1" }));
    await user.click(screen.getByRole("button", { name: "Review action" }));
    const dialog = screen.getByRole("dialog");
    await user.selectOptions(within(dialog).getByLabelText("Decision"), "denied");
    await user.type(within(dialog).getByLabelText("Decision reason"), "Confirm the reviewer first.");
    await user.click(within(dialog).getByRole("button", { name: "Deny action" }));
    await waitFor(() => expect(client.workspace.approvals[0]?.state).toBe("denied"));
    expect(client.workspace.runs[0]?.state).toBe("awaiting_approval");
    await user.click(screen.getByRole("tab", { name: "Artifacts & evidence" }));
    client.content = '<script>alert("untrusted")</script>';
    await user.click(screen.getByRole("button", { name: "View artifact" }));
    const content = await screen.findByLabelText("Artifact content");
    expect(content).toHaveTextContent('<script>alert("untrusted")</script>');
    expect(content.querySelector("script")).toBeNull();
  });
  it("saves disabled schedules and reports activation failure inside the form", async () => {
    const client = new FixtureClient(); client.workspace.agents.push(testAgent);
    const { user } = await open(client);
    await user.click(primary().getByRole("link", { name: "Automations" }));
    await user.click(screen.getByRole("button", { name: "New schedule" }));
    const dialog = within(screen.getByRole("dialog"));
    await user.type(dialog.getByLabelText("Schedule name"), "Morning review");
    await user.type(dialog.getByLabelText("Task title"), "Review pending invoices");
    await user.type(dialog.getByLabelText("Task instructions"), "Report exceptions only.");
    await user.selectOptions(dialog.getByLabelText("Assigned agent"), testAgent.id);
    await user.click(dialog.getByLabelText("Enable this schedule"));
    await user.click(dialog.getByRole("button", { name: "Save schedule" }));
    expect(await dialog.findByRole("alert")).toHaveTextContent("Scheduling runtime is not configured.");
    await user.click(dialog.getByLabelText("Enable this schedule"));
    await user.click(dialog.getByRole("button", { name: "Save schedule" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(client.workspace.automations[0]).toMatchObject({ enabled: false, nextRunAt: null });
    expect(screen.getByText("Not scheduled")).toBeVisible();
  });
  it("saves typed appearance, notification, and safety settings", async () => {
    const { client, user } = await open();
    await user.click(primary().getByRole("link", { name: "Settings" }));
    await user.clear(screen.getByLabelText("Workspace name"));
    await user.type(screen.getByLabelText("Workspace name"), "Finance workspace");
    await user.selectOptions(screen.getByLabelText("Theme"), "dark");
    await user.selectOptions(screen.getByLabelText("Density"), "compact");
    await user.click(screen.getByLabelText("Completed runs"));
    await user.click(screen.getByRole("button", { name: "Save preferences" }));
    await waitFor(() => expect(client.workspace.settings.workspaceName).toBe("Finance workspace"));
    expect(client.workspace.settings.appearance).toEqual({ theme: "dark", density: "compact" });
    expect(client.workspace.settings.notifications.completedRuns).toBe(false);
    await user.click(screen.getByRole("tab", { name: "Safety & access" }));
    await user.selectOptions(screen.getByLabelText("Require approval"), "on-risk");
    await user.click(screen.getByRole("button", { name: "Save approval policy" }));
    await waitFor(() => expect(client.workspace.settings.work.approvalPolicy).toBe("on-risk"));
  });
  it("does not imply a working or verified computer and disables unavailable control", async () => {
    const { user } = await open();
    await user.click(screen.getByRole("tab", { name: "Local computer" }));
    expect(screen.getByText("Not verified")).toBeVisible();
    expect(screen.getByRole("button", { name: "Start computer" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Stop computer" })).toBeDisabled();
  });
  it("keeps stale work visible but disables actions after a disconnect", async () => {
    const { client } = await open(populatedClient());
    act(() => client.connection?.({ state: "offline", detail: "Host exited." }));
    expect(await screen.findByText("Showing the last loaded workspace. Actions are disabled until the host reconnects.")).toBeVisible();
    expect(screen.getByRole("button", { name: "New task" })).toBeDisabled();
    expect(screen.getByRole("heading", { name: "Review supplier invoices" })).toBeVisible();
    await waitFor(() => expect(client.listeners.size).toBe(0));
  });
  it("supports keyboard tab selection and named navigation", async () => {
    const { user } = await open();
    const tasks = screen.getByRole("tab", { name: "Tasks 0" });
    tasks.focus(); await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "Runs" })).toHaveFocus();
    expect(screen.getByRole("tab", { name: "Runs" })).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{End}");
    expect(screen.getByRole("tab", { name: "Local computer" })).toHaveFocus();
  });
  it("renders an honest disconnected production state", async () => {
    render(<App client={new DisconnectedClient()} />);
    expect(await screen.findByRole("heading", { name: "Connect your local workspace" })).toBeVisible();
    expect(screen.getByRole("button", { name: "New task" })).toBeDisabled();
    expect(primary().getAllByRole("link")).toHaveLength(4);
  });
});
