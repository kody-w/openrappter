import { afterEach, expect, it } from "vitest";
import { EVIDENCE_SCHEMA, isVerifiedChain } from "@rapp-work/rapp1";
import { LIFECYCLE_SCHEMA, RESULT_REFERENCE_SCHEMA, validateLifecyclePayload } from "@rapp-work/domain";
import { agentInput, productionFixture } from "../../apps/host/test/production-fixture.js";
import { twinDraftSchema } from "../../apps/host/src/contracts.js";

type Fixture = Awaited<ReturnType<typeof productionFixture>>;
const fixtures: Fixture[] = [];
afterEach(async () => { for (const fixture of fixtures.splice(0)) await fixture.close(); });

it("rebuilds the full recursive workspace tree and Twin organization from canonical source/evidence frames alone", async () => {
  const f = await productionFixture(); fixtures.push(f);
  const agent = await f.services.work.saveAgent(f.context(), { ...agentInput("frame-owned-agent"), model: "gpt-6-astra" });
  const sibling = await f.services.work.saveAgent(f.context(), { ...agentInput("frame-sibling"), model: "gpt-6-astra" });
  const child = await f.services.work.agentWorkspace(f.context(), agent.id);
  const task = await f.services.work.createTask(f.context(child.id), {
    requestId: crypto.randomUUID(), title: "Canonical evidence review", instructions: "Review supplied evidence only.",
    agentId: agent.id, priority: "normal",
  });
  await f.services.work.saveAutomation(f.context(child.id), {
    id: "canonical-routine", name: "Draft review routine", taskTitle: "Review evidence",
    instructions: "Review evidence under the owning agent's restrictions.", agentId: agent.id,
    cadence: { kind: "interval", minutes: 60 }, enabled: false,
  }, f.services.runtime);
  f.copilot.complete.mockImplementation(async (request) => {
    const context = request.messages[1];
    if (!context || !("content" in context)) throw new Error("No context.");
    const prompt = JSON.parse(context.content);
    const history = await f.services.persistence.read(child.catalogScope);
    const user = history.commands.find((command) => command.state === "committed" && command.command.operation === "twin.user");
    expect(user?.state).toBe("committed");
    const scan = await (await f.services.persistence.workspace(child.catalogScope)).scan();
    expect(scan.streams.memory.frames.some((frame) => frame.kind === "memory.chat-turn"
      && (frame.payload.data as any).event?.turn?.role === "user")).toBe(true);
    return {
      kind: "task", assistantMessage: "I prepared a complete task and organized the workspace for review.",
      summary: "Review the supplied canonical evidence.", confidence: 0.95, readyForReview: true, missing: [],
      draft: { requestId: prompt.allocatedIdentifiers.taskRequestId, title: "Follow-up evidence review",
        instructions: "Retain source references.", agentId: agent.id, priority: "normal" },
      evolution: { twinSummary: "Canonical evidence workspace", sections: [{ id: "evidence", title: "Evidence view",
        kind: "tasks", description: "Only this workspace's evidence.", taskIds: [task.id] }],
        suggestedRoutines: [], defaultFocus: "work" },
    };
  });
  const reply = await f.rpc("twin.message", { workspaceId: child.id, message: "Voice transcript: organize this evidence and draft a follow-up task.", history: [] });
  expect(reply.error).toBeUndefined();
  const draft = twinDraftSchema.parse(reply.result);
  expect(draft.basis?.verification).toMatchObject({
    state: "verified", trust: { classification: "integrity-only", factualTruth: false, authorship: false, promotionGrade: false },
  });
  expect((await f.rpc("twin.applyProposal", { workspaceId: child.id, id: draft.id, proposalHash: draft.basis!.proposalHash })).error).toBeUndefined();
  const conversation = await f.services.twin.conversation(f.context(child.id));
  expect(conversation.events.find((event) => event.kind === "evolution")?.references).toMatchObject({
    proposalHash: draft.basis!.proposalHash, proposalFrameHash: draft.basis!.verification!.state === "verified" ? draft.basis!.verification!.sourceFrameHash : "",
  });
  expect((await f.services.twin.conversation(f.context(sibling.workspaceId))).turns).toEqual([]);
  const tree = await f.services.work.listWorkspaces(f.catalogContext());
  const snapshots = await Promise.all(tree.workspaces.map((workspace) => f.services.work.snapshot(f.context(workspace.id))));
  const conversations = await Promise.all(tree.workspaces.map((workspace) => f.services.twin.conversation(f.context(workspace.id))));
  let frameCount = 0;
  const kinds = new Set<string>(), types = new Set<string>();
  for (const workspace of tree.workspaces) {
    const scan = await (await f.services.persistence.workspace(workspace.catalogScope)).scan();
    expect(isVerifiedChain(scan.streams.body)).toBe(true);
    expect(isVerifiedChain(scan.streams.memory)).toBe(true);
    frameCount += scan.streams.body.frames.length + scan.streams.memory.frames.length;
    for (const frame of scan.streams.memory.frames) {
      kinds.add(frame.kind);
      if ((frame.payload.data as any)?.schema === LIFECYCLE_SCHEMA) types.add(validateLifecyclePayload(frame.payload).data.type);
    }
    expect(scan.streams.body.frames.some((frame) => frame.payload.schema === EVIDENCE_SCHEMA)).toBe(true);
    for (const frame of scan.streams.body.frames.filter((frame) => frame.payload.type === "work.outcome")) {
      expect((frame.payload.value as any).schema).toBe(RESULT_REFERENCE_SCHEMA);
      expect((frame.payload.events as any[]).every((event) => event.schema === "rapp-work/event-ref/1")).toBe(true);
    }
  }
  expect(frameCount).toBeGreaterThan(0);
  expect([...kinds]).toEqual(expect.arrayContaining(["memory.chat-turn", "memory.save", "memory.tool-call"]));
  expect([...types]).toEqual(expect.arrayContaining(["workspace.created", "workspace.linked", "agent.created",
    "message.recorded", "twin.proposed", "workspace.evolved", "routine.drafted", "operation.intent", "operation.outcome"]));
  await f.services.runtime.close();
  await f.services.persistence.rebuildFromFrames();
  expect(await f.services.work.listWorkspaces(f.catalogContext())).toEqual(tree);
  expect(await Promise.all(tree.workspaces.map((workspace) => f.services.work.snapshot(f.context(workspace.id))))).toEqual(snapshots);
  expect(await Promise.all(tree.workspaces.map((workspace) => f.services.twin.conversation(f.context(workspace.id))))).toEqual(conversations);
  await f.close(false); fixtures.splice(fixtures.indexOf(f), 1);
  const restarted = await productionFixture({ directory: f.directory }); fixtures.push(restarted);
  expect(await restarted.services.work.listWorkspaces(restarted.catalogContext())).toEqual(tree);
  expect(await restarted.services.twin.conversation(restarted.context(child.id))).toEqual(conversation);
  expect(restarted.copilot.complete).not.toHaveBeenCalled();
}, 240_000);
