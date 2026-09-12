import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { agent, fixture, owner } from "./fixture.js";
import { automationInputSchema, computerSchema, runSchema } from "../src/contracts.js";
const context = { principal: owner, requestId: "test" };
describe("work adapter business boundaries", () => {
  it("can assign queued tasks but cannot reassign an active run", async () => {
    const services = fixture();
    await services.work.saveAgent(context, agent);
    const task = await services.work.createTask(context, {
      requestId: randomUUID(), title: "Review", instructions: "Review actual inputs", agentId: null, priority: "normal",
    });
    expect((await services.work.assignTask(context, { id: task.id, agentId: agent.id })).agentId).toBe(agent.id);
    await services.work.startRun(context, task.id, services.runtime, services.provider);
    await expect(services.work.assignTask(context, { id: task.id, agentId: agent.id })).rejects.toThrow("inactive");
  });
  it("applies the stricter workspace approval policy to the injected runtime", async () => {
    const services = fixture();
    await services.work.saveAgent(context, { ...agent, approvalPolicy: "on-risk" });
    const task = await services.work.createTask(context, {
      requestId: randomUUID(), title: "Review", instructions: "Review", agentId: agent.id, priority: "normal",
    });
    await services.work.startRun(context, task.id, services.runtime, services.provider);
    expect(services.runtime.start).toHaveBeenCalledWith(context, expect.objectContaining({
      agent: expect.objectContaining({ approvalPolicy: "always" }),
    }));
  });
  it("prevents concurrent double-starts and changes to an active agent", async () => {
    const services = fixture();
    await services.work.saveAgent(context, agent);
    const task = await services.work.createTask(context, {
      requestId: randomUUID(), title: "Review", instructions: "Review", agentId: agent.id, priority: "normal",
    });
    const results = await Promise.allSettled([
      services.work.startRun(context, task.id, services.runtime, services.provider),
      services.work.startRun(context, task.id, services.runtime, services.provider),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(services.runtime.start).toHaveBeenCalledTimes(1);
    await expect(services.work.saveAgent(context, { ...agent, computerPolicy: "control" })).rejects.toThrow("active run");
  });
  it("rejects an unrelated runtime result without recording fabricated progress", async () => {
    const services = fixture();
    await services.work.saveAgent(context, agent);
    const task = await services.work.createTask(context, {
      requestId: randomUUID(), title: "Review", instructions: "Review", agentId: agent.id, priority: "normal",
    });
    services.runtime.start = async () => ({
      id: randomUUID(), taskId: "other-task", agentId: agent.id, state: "completed",
      startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), summary: "Wrong run",
      verification: "not_checked", evidenceIds: [],
    });
    await expect(services.work.startRun(context, task.id, services.runtime, services.provider)).rejects.toThrow("unrelated");
    expect((await services.work.snapshot(context)).runs).toEqual([]);
    expect((await services.work.snapshot(context)).tasks[0]?.state).toBe("queued");
  });
  it("does not record an approval if the runtime rejects it, and rejects repeat decisions", async () => {
    const services = fixture();
    await services.storage.transact(owner.workspaceId, (draft) => {
      draft.runs.push({
        id: "run", taskId: "task", agentId: agent.id, state: "awaiting_approval",
        startedAt: new Date().toISOString(), finishedAt: null, summary: "", verification: "not_checked", evidenceIds: [],
      });
      draft.approvals.push({
        id: "approval", runId: "run", taskId: "task", action: "Send report", reason: "External action", risk: "high",
        state: "pending", createdAt: new Date().toISOString(), decidedAt: null, decisionReason: "",
      });
    });
    services.runtime.decide = async () => { throw new Error("runtime unavailable"); };
    const input = { id: "approval", decision: "approved" as const, reason: "Recipient checked" };
    await expect(services.work.decideApproval(context, input, services.runtime)).rejects.toThrow();
    expect((await services.work.snapshot(context)).approvals[0]?.state).toBe("pending");
    services.runtime.decide = async () => {};
    await services.work.decideApproval(context, input, services.runtime);
    await expect(services.work.decideApproval(context, input, services.runtime)).rejects.toThrow("already been decided");
    expect((await services.work.snapshot(context)).runs[0]?.state).toBe("awaiting_approval");
  });
  it("requires real confirmation before enabling schedules and rejects invalid calendar inputs", async () => {
    const services = fixture();
    await services.work.saveAgent(context, agent);
    const input = {
      id: "schedule", name: "Review", taskTitle: "Review", instructions: "Review real inputs",
      agentId: agent.id, enabled: true, cadence: { kind: "daily" as const, at: "09:00", timezone: "UTC" },
    };
    services.runtime.schedule = async () => ({ nextRunAt: null });
    await expect(services.work.saveAutomation(context, input, services.runtime)).rejects.toThrow("did not confirm");
    expect((await services.work.snapshot(context)).automations).toEqual([]);
    expect(automationInputSchema.safeParse({ ...input, cadence: { ...input.cadence, timezone: "Not/AZone" } }).success).toBe(false);
    expect(automationInputSchema.safeParse({ ...input, cadence: { ...input.cadence, at: "25:30" } }).success).toBe(false);
  });
  it("never treats an unsupported verification claim as evidence", () => {
    expect(computerSchema.safeParse({
      state: "running", verified: true, verifiedAt: null, detail: "", evidenceIds: [],
      capabilities: { view: true, control: true },
    }).success).toBe(false);
    expect(runSchema.safeParse({
      id: "run", taskId: "task", agentId: agent.id, state: "completed",
      startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
      summary: "", verification: "passed", evidenceIds: [],
    }).success).toBe(false);
  });
});
