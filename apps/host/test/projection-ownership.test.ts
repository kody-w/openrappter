import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { agentInput, productionFixture } from "./production-fixture.js";

type Fixture = Awaited<ReturnType<typeof productionFixture>>;
const fixtures: Fixture[] = [];
afterEach(async () => { for (const fixture of fixtures.splice(0)) await fixture.close(); });
async function setup() {
  const fixture = await productionFixture();
  fixtures.push(fixture);
  return fixture;
}
const taskInput = (requestId: string, agentId: string | null, title: string) => ({
  requestId, title, instructions: `${title} instructions.`, agentId, priority: "normal" as const,
});
const routineInput = (id: string, agentId: string, name: string) => ({
  id, name, taskTitle: `${name} task`, instructions: `${name} instructions.`, agentId,
  cadence: { kind: "interval" as const, minutes: 60 }, enabled: false,
});

describe("canonical workspace projection ownership", () => {
  it("ignores child-local unassigned tasks when reading and listing the parent", async () => {
    const f = await setup();
    const child = await f.services.work.saveAgent(f.context(), agentInput("projection-child"));
    const local = await f.services.work.createTask(
      f.context(child.workspaceId),
      taskInput(randomUUID(), null, "Child-only unassigned task"),
    );
    await f.services.persistence.rebuildFromFrames();

    expect((await f.services.work.snapshot(f.context(child.workspaceId))).tasks).toEqual([local]);
    expect((await f.services.work.snapshot(f.context())).tasks).toEqual([]);
    expect((await f.services.work.listWorkspaces(f.catalogContext())).workspaces.map((workspace) => workspace.id))
      .toEqual(expect.arrayContaining([f.workspace!.id, child.workspaceId]));
  });

  it("does not let a child-local task with a colliding ID replace its parent record", async () => {
    const f = await setup();
    const child = await f.services.work.saveAgent(f.context(), agentInput("task-collision-child"));
    const id = randomUUID();
    const parentTask = await f.services.work.createTask(f.context(), taskInput(id, child.id, "Parent task"));
    const childTask = await f.services.work.createTask(
      f.context(child.workspaceId),
      taskInput(id, child.id, "Child task"),
    );
    await f.services.persistence.rebuildFromFrames();

    expect((await f.services.work.snapshot(f.context())).tasks).toEqual([parentTask]);
    expect((await f.services.work.snapshot(f.context(child.workspaceId))).tasks).toEqual([childTask]);
  });

  it("does not let a child-local routine with a colliding ID replace its parent record", async () => {
    const f = await setup();
    const child = await f.services.work.saveAgent(f.context(), agentInput("routine-collision-child"));
    const id = "colliding-routine";
    const parentRoutine = await f.services.work.saveAutomation(
      f.context(),
      routineInput(id, child.id, "Parent routine"),
      f.services.runtime,
    );
    const childRoutine = await f.services.work.saveAutomation(
      f.context(child.workspaceId),
      routineInput(id, child.id, "Child routine"),
      f.services.runtime,
    );
    await f.services.persistence.rebuildFromFrames();

    expect((await f.services.work.snapshot(f.context())).automations).toEqual([parentRoutine]);
    expect((await f.services.work.snapshot(f.context(child.workspaceId))).automations).toEqual([childRoutine]);
  });

  it("keeps delegated records in their parent origin and rejects child-side task mutation", async () => {
    const f = await setup();
    const child = await f.services.work.saveAgent(f.context(), agentInput("delegated-record-child"));
    const task = await f.services.work.createTask(
      f.context(),
      taskInput(randomUUID(), null, "Parent-origin task"),
    );
    const assigned = await f.services.work.assignTask(f.context(), { id: task.id, agentId: child.id });
    const routine = await f.services.work.saveAutomation(
      f.context(),
      routineInput("parent-origin-routine", child.id, "Parent-origin routine"),
      f.services.runtime,
    );
    await f.services.persistence.rebuildFromFrames();

    expect((await f.services.work.snapshot(f.context())).tasks).toEqual([assigned]);
    expect((await f.services.work.snapshot(f.context())).automations).toEqual([routine]);
    expect(routine.originWorkspaceId).toBe(f.workspace!.id);
    await expect(f.services.work.assignTask(
      f.context(child.workspaceId),
      { id: task.id, agentId: child.id },
    )).rejects.toMatchObject({ code: -32004 });
    expect((await f.services.work.snapshot(f.context(child.workspaceId))).tasks).toEqual([]);
    expect((await f.services.work.snapshot(f.context(child.workspaceId))).automations).toEqual([]);
  });
});
