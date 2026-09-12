import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { isVerifiedChain } from "@rapp-work/rapp1";
import { approvalFromFrames } from "@rapp-work/security";
import { rpcContracts } from "../../ui/src/model.js";
import { agentScope } from "../src/local-work.js";
import { agentInput, FakeCommands, productionFixture, until } from "./production-fixture.js";

const fixtures: Awaited<ReturnType<typeof productionFixture>>[] = [];
afterEach(async () => { for (const fixture of fixtures.splice(0)) await fixture.close(); });
async function setup(options: Parameters<typeof productionFixture>[0] = {}) {
  const fixture = await productionFixture(options); fixtures.push(fixture); return fixture;
}
const taskInput = (agentId: string | null, title = "Do accountable work") => ({
  requestId: randomUUID(), title, instructions: `Produce evidence for ${title}.`, agentId, priority: "normal" as const,
});

describe("filesystem-backed production composition", () => {
  it("mints isolated agent workspaces and runs two agents without shared model context", async () => {
    const f = await setup();
    const a = await f.services.work.saveAgent(f.context(), agentInput("agent-alpha"));
    const b = await f.services.work.saveAgent(f.context(), agentInput("agent-beta"));
    expect(a.workspaceId).not.toBe(a.id); expect(b.workspaceId).not.toBe(b.id);
    expect(a.workspaceId).not.toBe(b.workspaceId);
    const capA = await f.services.persistence.capability(agentScope(a));
    await expect(f.services.persistence.work.read(capA, agentScope(b))).rejects.toThrow();
    const tasks = await Promise.all([a, b].map((agent) => f.services.work.createTask(f.context(), taskInput(agent.id, agent.id))));
    await Promise.all(tasks.map((task) => f.services.work.startRun(f.context(), task.id, f.services.runtime, f.services.provider)));
    await f.services.runtime.drain();
    const snapshot = await f.services.work.snapshot(f.context());
    expect(snapshot.runs.map((run) => run.state)).toEqual(["completed", "completed"]);
    expect(snapshot.tasks.every((task) => snapshot.agents.find((agent) => agent.id === task.agentId)?.workspaceId === task.workspaceId)).toBe(true);
    const scans = await Promise.all([a, b].map(async (agent) => (await f.services.persistence.workspace(agentScope(agent))).scan()));
    expect(scans[0]!.identity.body_stream).not.toBe(scans[1]!.identity.body_stream);
    expect(JSON.stringify(scans[0]!.streams)).not.toContain("agent-beta");
    expect(JSON.stringify(scans[1]!.streams)).not.toContain("agent-alpha");
    expect(f.copilot.complete).toHaveBeenCalledTimes(2);
    expect(f.commands.calls).toEqual([]);
    expect(await readdir(f.directory)).toEqual(expect.arrayContaining(["owner.json", "workspaces"]));
    rpcContracts["work.snapshot"].output.parse(snapshot);
    const mismatched = structuredClone(snapshot);
    mismatched.tasks[0]!.workspaceId = mismatched.tasks[0]!.agentId;
    expect(rpcContracts["work.snapshot"].output.safeParse(mismatched).success).toBe(false);
  }, 25_000);

  it("creates, assigns and starts through RPC; consumes approval and scans linked tool/computer evidence", async () => {
    const f = await setup({ computer: true });
    const computer = rpcContracts["computer.start"].output.parse((await f.rpc("computer.start")).result);
    expect(computer).toMatchObject({ state: "running", verified: true });
    const agent = rpcContracts["agents.save"].output.parse((await f.rpc("agents.save", agentInput("agent-worker", "control"))).result);
    const task = rpcContracts["work.createTask"].output.parse((await f.rpc("work.createTask", taskInput(null))).result);
    const assigned = rpcContracts["work.assignTask"].output.parse((await f.rpc("work.assignTask", { id: task.id, agentId: agent.id })).result);
    expect(assigned.workspaceId).toBe(agent.workspaceId);
    const run = rpcContracts["runs.start"].output.parse((await f.rpc("runs.start", { id: task.id })).result);
    expect(run).toMatchObject({ agentId: agent.id, workspaceId: agent.workspaceId, state: "running" });
    const waiting = await until(() => f.services.work.snapshot(f.context()), (snapshot) => snapshot.approvals.length > 0);
    expect(waiting.runs[0]!.state).toBe("awaiting_approval");
    expect(f.commands.guestExecutions).toBe(0);
    const approval = waiting.approvals[0]!;
    rpcContracts["approvals.decide"].output.parse((await f.rpc("approvals.decide", {
      id: approval.id, decision: "approved", reason: "Exact guest operation reviewed.",
    })).result);
    await f.services.runtime.drain();
    const finished = rpcContracts["work.snapshot"].output.parse((await f.rpc("work.snapshot")).result);
    expect(finished.runs[0]!).toMatchObject({ state: "completed", verification: "passed" });
    expect(f.commands.guestExecutions).toBe(1);
    expect(f.commands.executionScopes).toEqual([agent.workspaceId]);
    const scan = await (await f.services.persistence.workspace(agentScope(agent))).scan();
    expect(isVerifiedChain(scan.streams.body)).toBe(true);
    expect(isVerifiedChain(scan.streams.memory)).toBe(true);
    if (!isVerifiedChain(scan.streams.body) || !isVerifiedChain(scan.streams.memory)) throw new Error("No canonical scans.");
    expect(scan.streams.body.frames.length).toBeGreaterThan(30);
    const grant = approvalFromFrames(scan.streams.memory, scan.streams.body, approval.id);
    expect(grant.consumedBy).toBeTruthy();
    expect(finished.approvals[0]!.consumedBy).toBe(grant.consumedBy);
    const commands = (await f.services.persistence.read(agentScope(agent))).commands;
    const tool = commands.find((item) => item.command.operation === "tool.execute");
    expect(tool?.state).toBe("committed");
    if (tool?.state !== "committed") throw new Error("Tool has no canonical proof.");
    const linked = tool.receipts.find((receipt) => receipt.kind === "computer-receipt")!;
    const computerHistory = await f.services.persistence.read(f.services.persistence.owner.computer);
    expect(computerHistory.commands.some((item) => item.state === "committed" && item.proof.evidenceRef === linked.evidenceRef)).toBe(true);
    for (const artifact of finished.artifacts) {
      rpcContracts["artifacts.read"].output.parse((await f.rpc("artifacts.read", { id: artifact.id })).result);
      expect(artifact.workspaceId).toBe(agent.workspaceId);
    }
    const ssh = f.commands.calls.find((call) => call.file === "/usr/bin/ssh")!;
    expect(ssh.args).toContain("StrictHostKeyChecking=yes");
    expect(ssh.args.at(-1)).toBe("/usr/bin/node /usr/local/lib/rapp-work/guest-helper.js");
    expect(ssh.args).not.toContain("owned work");
    expect(f.commands.calls.every((call) => ["/opt/homebrew/bin/tart", "/usr/bin/ssh"].includes(call.file))).toBe(true);
  }, 35_000);

  it.each(["configuration", "template", "tart"] as const)("missing %s produces zero model or guest execution", async (missing) => {
    const commands = new FakeCommands();
    if (missing === "template") commands.sourceExists = false;
    if (missing === "tart") commands.installed = false;
    const f = await setup({ computer: missing !== "configuration", commands });
    const agent = await f.services.work.saveAgent(f.context(), agentInput("agent-blocked", "control"));
    const task = await f.services.work.createTask(f.context(), taskInput(agent.id));
    await expect(f.services.work.startRun(f.context(), task.id, f.services.runtime, f.services.provider)).rejects.toThrow();
    expect(f.copilot.complete).not.toHaveBeenCalled();
    expect(f.commands.guestExecutions).toBe(0);
    expect((await f.services.work.snapshot(f.context())).runs).toEqual([]);
    expect((await f.services.computer.inspect(f.context())).state).toBe("unavailable");
  }, 20_000);

  it("requires durable intent before invoking even the model transport", async () => {
    const f = await setup();
    const agent = await f.services.work.saveAgent(f.context(), agentInput("agent-persistence"));
    const task = await f.services.work.createTask(f.context(), taskInput(agent.id));
    f.failPersistence();
    await expect(f.services.work.startRun(f.context(), task.id, f.services.runtime, f.services.provider)).rejects.toThrow("unresolved");
    expect(f.copilot.complete).not.toHaveBeenCalled();
    expect(f.commands.guestExecutions).toBe(0);
    f.failPersistence(false);
  }, 20_000);

  it("restores the same owner, workspace and results after restart without replaying a run", async () => {
    const f = await setup();
    const owner = f.services.persistence.owner;
    const agent = await f.services.work.saveAgent(f.context(), agentInput("agent-durable"));
    const input = taskInput(agent.id);
    const task = await f.services.work.createTask(f.context(), input);
    const runContext = f.context();
    const run = await f.services.work.startRun(runContext, task.id, f.services.runtime, f.services.provider);
    await f.services.runtime.drain();
    await f.close(false);
    fixtures.splice(fixtures.indexOf(f), 1);
    const reopened = await setup({ directory: f.directory });
    expect(reopened.services.persistence.owner).toEqual(owner);
    const snapshot = await reopened.services.work.snapshot(reopened.context());
    expect(snapshot.agents[0]!.workspaceId).toBe(agent.workspaceId);
    expect(snapshot.runs[0]!).toMatchObject({ id: run.id, state: "completed" });
    await reopened.services.work.createTask(reopened.context(), input);
    await reopened.services.work.startRun({ ...reopened.context(), requestId: runContext.requestId }, task.id, reopened.services.runtime, reopened.services.provider);
    expect(reopened.copilot.complete).not.toHaveBeenCalled();
    expect((await reopened.services.work.snapshot(reopened.context())).tasks).toHaveLength(1);
    const result = snapshot.artifacts.find((item) => !item.evidence)!;
    expect((await reopened.services.work.readArtifact(reopened.context(), result.id)).content).toContain("agent-durable");
  }, 25_000);

  it.each(["denied", "cancelled"] as const)("an approval can be %s without any guest execution", async (decision) => {
    const f = await setup({ computer: true });
    await f.services.computer.start(f.context());
    const agent = await f.services.work.saveAgent(f.context(), agentInput("agent-review", "control"));
    const task = await f.services.work.createTask(f.context(), taskInput(agent.id));
    const run = await f.services.work.startRun(f.context(), task.id, f.services.runtime, f.services.provider);
    const waiting = await until(() => f.services.work.snapshot(f.context()), (snapshot) => snapshot.approvals.length > 0);
    if (decision === "denied") {
      await f.services.work.decideApproval(f.context(), { id: waiting.approvals[0]!.id, decision, reason: "Do not execute." }, f.services.runtime);
    } else {
      await f.services.work.cancelRun(f.context(), run.id, f.services.runtime);
    }
    await f.services.runtime.drain();
    const snapshot = await f.services.work.snapshot(f.context());
    expect(snapshot.runs[0]!.state).toBe(decision === "denied" ? "failed" : "cancelled");
    expect(f.commands.guestExecutions).toBe(0);
    expect(snapshot.approvals[0]!.consumedBy).toBeNull();
    const history = await f.services.persistence.read(agentScope(agent));
    expect(history.commands.find((item) => item.command.operation === "tool.execute")).toMatchObject({ state: "committed", status: decision });
  }, 35_000);

  it("enforces a read-only guest mount under an explicitly reviewed on-risk policy", async () => {
    const f = await setup({ computer: true });
    await f.services.computer.start(f.context());
    const initial = await f.services.work.snapshot(f.context());
    await f.services.work.updateSettings(f.context(), { ...initial.settings, work: { ...initial.settings.work, approvalPolicy: "on-risk" } });
    const agent = await f.services.work.saveAgent(f.context(), { ...agentInput("agent-reader", "read-only"), approvalPolicy: "on-risk" });
    const task = await f.services.work.createTask(f.context(), taskInput(agent.id));
    await f.services.work.startRun(f.context(), task.id, f.services.runtime, f.services.provider);
    await f.services.runtime.drain();
    const snapshot = await f.services.work.snapshot(f.context());
    expect(snapshot.approvals).toEqual([]);
    expect(snapshot.runs[0]!.state).toBe("completed");
    const ssh = f.commands.calls.find((call) => call.file === "/usr/bin/ssh")!;
    expect(JSON.parse(ssh.options.stdin!).request).toMatchObject({ readOnly: true, argv: ["/usr/bin/head", "-c", "65536", "--", "/workspace/report.txt"] });
  }, 35_000);

  it("executes persisted schedules once and advances the same agent's canonical schedule", async () => {
    const f = await setup();
    const agent = await f.services.work.saveAgent(f.context(), agentInput("agent-scheduled"));
    const automation = await f.services.work.saveAutomation(f.context(), {
      id: "schedule-one", name: "Scheduled work", taskTitle: "Scheduled report", instructions: "Prepare the scheduled report.",
      agentId: agent.id, cadence: { kind: "interval", minutes: 15 }, enabled: true,
    }, f.services.runtime);
    const due = Date.parse(automation.nextRunAt!) + 1;
    await f.services.runtime.tickSchedules(due);
    await f.services.runtime.drain();
    await f.services.runtime.tickSchedules(due);
    const snapshot = await f.services.work.snapshot(f.context());
    expect(snapshot.tasks).toHaveLength(1);
    expect(snapshot.runs[0]!).toMatchObject({ state: "completed", workspaceId: agent.workspaceId });
    expect(Date.parse(snapshot.automations[0]!.nextRunAt!)).toBeGreaterThan(due);
    expect(f.copilot.complete).toHaveBeenCalledOnce();
  }, 25_000);

  it("retains an uncertain model intent across restart and never automatically replays it", async () => {
    const f = await setup();
    const agent = await f.services.work.saveAgent(f.context(), agentInput("agent-uncertain"));
    const task = await f.services.work.createTask(f.context(), taskInput(agent.id));
    f.copilot.complete.mockRejectedValueOnce(new Error("Transport acknowledgement lost."));
    await f.services.work.startRun(f.context(), task.id, f.services.runtime, f.services.provider);
    await f.services.runtime.drain();
    expect((await f.services.work.snapshot(f.context())).runs[0]!.state).toBe("unresolved");
    await f.close(false);
    fixtures.splice(fixtures.indexOf(f), 1);
    const recovered = await setup({ directory: f.directory });
    await expect(recovered.services.work.startRun(recovered.context(), task.id, recovered.services.runtime, recovered.services.provider)).rejects.toThrow("unresolved");
    expect(recovered.copilot.complete).not.toHaveBeenCalled();
    const commands = (await recovered.services.persistence.read(agentScope(agent))).commands;
    expect(commands.filter((item) => item.command.operation === "model.complete")).toHaveLength(1);
    expect(commands.find((item) => item.command.operation === "model.complete")!.state).toBe("unresolved");
  }, 25_000);

  it("serializes two agents' approved guest operations on the one shared computer", async () => {
    const f = await setup({ computer: true });
    await f.services.computer.start(f.context());
    const agents = await Promise.all(["agent-first", "agent-second"].map((id) =>
      f.services.work.saveAgent(f.context(), agentInput(id, "control"))));
    const tasks = await Promise.all(agents.map((agent) => f.services.work.createTask(f.context(), taskInput(agent.id))));
    await Promise.all(tasks.map((task) => f.services.work.startRun(f.context(), task.id, f.services.runtime, f.services.provider)));
    const waiting = await until(() => f.services.work.snapshot(f.context()), (snapshot) => snapshot.approvals.length === 2);
    await Promise.all(waiting.approvals.map((approval) => f.services.work.decideApproval(f.context(), {
      id: approval.id, decision: "approved", reason: "Review this agent's exact guest action.",
    }, f.services.runtime)));
    await f.services.runtime.drain();
    const snapshot = await f.services.work.snapshot(f.context());
    expect(snapshot.runs.map((run) => run.state)).toEqual(["completed", "completed"]);
    expect([...f.commands.executionScopes].sort()).toEqual(agents.map((agent) => agent.workspaceId).sort());
    expect(snapshot.approvals.every((approval) => approval.consumedBy !== null)).toBe(true);
    expect((await f.services.persistence.read(f.services.persistence.owner.computer)).commands.every((command) => command.state === "committed")).toBe(true);
  }, 60_000);
});
