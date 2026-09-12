import { afterEach, expect, it } from "vitest";
import { EVIDENCE_SCHEMA, isVerifiedChain } from "@rapp-work/rapp1";
import { LIFECYCLE_SCHEMA, validateLifecyclePayload } from "@rapp-work/domain";
import { agentInput, productionFixture, workspaceInput } from "../../../host/test/production-fixture.js";
import { BridgeClient } from "../../src/client";
import { agentWorkspaceResultSchema, workspaceSummarySchema, type TwinDraft } from "../../src/model";
import { prepareProposal } from "../../src/proposals";

type Fixture = Awaited<ReturnType<typeof productionFixture>>;
const fixtures: Fixture[] = [];
afterEach(async () => { for (const fixture of fixtures.splice(0)) await fixture.close(); });
function bridge(fixture: Fixture) {
  return new BridgeClient({
    async request({ method, params }) {
      const reply = await fixture.rawRpc(method, params);
      if (reply.error) throw new Error(reply.error.message);
      return reply.result;
    },
    async hostState() { return { state: "online", detail: "Real canonical local host with injected model and guest transports." }; },
    onEvent() { return () => {}; },
  });
}

it("rebuilds the UI tree, conversations, verified proposals, agents, routines and evolution from nonzero canonical frames", async () => {
  const fixture = await productionFixture({ bootstrap: false, computer: true });
  fixtures.push(fixture);
  const client = bridge(fixture);
  const ready = (kind: string, draft: unknown, evolution?: unknown) => ({
    kind, draft, assistantMessage: "Prepared complete work with canonical source and evidence references.",
    summary: "A complete proposal for explicit review.", confidence: 0.9, readyForReview: true, missing: [],
    ...(evolution ? { evolution } : {}),
  });
  fixture.copilot.complete.mockImplementation(async (request) => {
    const message = request.messages[1];
    if (!message || !("content" in message)) throw new Error("Missing bounded model context.");
    const prompt = JSON.parse(message.content);
    const ids = prompt.allocatedIdentifiers;
    if (prompt.requestedTarget === "workspace") return ready("workspace", {
      ...workspaceInput("Canonical UI business", ids.agentId), requestId: ids.workspaceRequestId,
      computerPolicy: "none",
      leadAgent: { ...agentInput(ids.agentId), model: "gpt-6-astra", enabled: true },
    });
    if (prompt.requestedTarget === "agent") return ready("agent", {
      ...agentInput(ids.agentId), name: prompt.message.includes("Second") ? "Second evidence agent" : "Evidence agent",
      model: "gpt-6-astra", enabled: true,
    });
    const owner = prompt.verifiedContext.agents.find((agent: { enabled: boolean }) => agent.enabled);
    if (!owner) throw new Error("No verified agent option.");
    if (prompt.requestedTarget === "automation") return ready("automation", {
      id: ids.routineIds[0], name: "Canonical disabled routine", taskTitle: "Review evidence",
      instructions: "Only review approved evidence; do not execute external changes.", agentId: owner.id,
      cadence: { kind: "daily", at: "09:00", timezone: "UTC" }, enabled: false,
    });
    const workspace = await fixture.services.work.workspace(fixture.context(prompt.verifiedContext.workspace.id));
    const scan = await (await fixture.services.persistence.workspace(workspace.catalogScope)).scan();
    expect(scan.streams.memory.frames.some((frame) => frame.kind === "memory.chat-turn"
      && JSON.stringify(frame.payload).includes(prompt.message))).toBe(true);
    return ready("task", {
      requestId: ids.taskRequestId, title: "Canonical UI evidence review", instructions: "Preserve every source reference.",
      agentId: owner.id, priority: "normal",
    }, {
      twinSummary: "A frame-derived evidence workspace.", sections: [{ id: "evidence-view", title: "Evidence view",
        description: "Only this workspace's evidence.", kind: "tasks", taskIds: [] }],
      suggestedRoutines: [], defaultFocus: "work",
    });
  });
  const propose = (workspaceId: string | null, target: "workspace" | "agent" | "task" | "automation", message: string) =>
    client.call("twin.message", { workspaceId, target, message, history: [] });
  const apply = (proposal: TwinDraft, editedDraft?: Record<string, unknown>) =>
    client.call("twin.applyProposal", { workspaceId: proposal.workspaceId, id: proposal.id,
      proposalHash: proposal.basis!.proposalHash, ...(editedDraft ? { editedDraft } : {}) });

  const workspaceProposal = await propose(null, "workspace", "Create a business for local evidence reviews.");
  expect(prepareProposal(workspaceProposal, null, null)?.kind).toBe("workspace");
  const root = workspaceSummarySchema.parse((await apply(workspaceProposal)).result);
  const firstProposal = await propose(root.id, "agent", "Create an evidence review agent.");
  const first = agentWorkspaceResultSchema.parse((await apply(firstProposal)).result);
  const secondProposal = await propose(root.id, "agent", "Create a Second evidence review agent.");
  const second = agentWorkspaceResultSchema.parse((await apply(secondProposal)).result);
  expect(first.workspace.parentWorkspaceId).toBe(root.id);
  expect(second.workspace.parentWorkspaceId).toBe(root.id);
  expect(first.workspace.id).not.toBe(second.workspace.id);
  const nested = agentWorkspaceResultSchema.parse((await apply(await propose(first.workspace.id, "agent", "Create a scoped sub-agent."))).result);
  expect(nested.workspace.depth).toBe(2);
  expect(nested.workspace.lineage).toEqual([root.id, first.workspace.id, nested.workspace.id]);
  expect((await client.call("agents.openWorkspace", { workspaceId: root.id, id: first.agent.id })).id).toBe(first.workspace.id);

  const taskProposal = await propose(first.workspace.id, "task", "Voice transcript: organize evidence and draft a reviewed task.");
  const open = await client.call("workspaces.open", { workspaceId: first.workspace.id });
  expect(prepareProposal(taskProposal, first.workspace.id, open.snapshot)?.kind).toBe("task");
  expect(taskProposal.basis?.verification).toMatchObject({
    state: "verified", trust: { classification: "integrity-only", factualTruth: false, authorship: false, promotionGrade: false },
  });
  expect(prepareProposal({ ...taskProposal, basis: { ...taskProposal.basis, verification: { state: "unverified", detail: "No scan." } } },
    first.workspace.id, open.snapshot)).toBeNull();
  await apply(taskProposal, { ...taskProposal.draft, title: "Reviewed canonical UI task" });
  const discarded = await propose(first.workspace.id, "task", "Draft an optional follow-up.");
  await client.call("twin.dismissProposal", { workspaceId: first.workspace.id, id: discarded.id, proposalHash: discarded.basis!.proposalHash });
  await apply(await propose(first.workspace.id, "automation", "Draft a disabled daily evidence review."));
  const enabled = await client.call("computer.start", { workspaceId: first.workspace.id });
  expect(enabled.workspace).toMatchObject({ id: first.workspace.id, enabled: true });
  expect((await client.call("computer.inspect", { workspaceId: second.workspace.id })).workspace?.enabled).toBe(false);
  await client.call("computer.stop", { workspaceId: first.workspace.id });
  expect((await client.call("twin.conversation", { workspaceId: second.workspace.id })).turns).toHaveLength(0);

  const tree = await client.call("workspaces.tree", { workspaceId: null });
  const projections = await Promise.all(tree.nodes.map(async ({ workspace }) => {
    const { computer: _liveComputer, ...projection } = await client.call("workspaces.open", { workspaceId: workspace.id });
    return projection;
  }));
  let scannedFrames = 0;
  const sourceKinds = new Set<string>(), lifecycleTypes = new Set<string>();
  for (const scope of [fixture.services.persistence.owner.catalog, fixture.services.persistence.owner.computer, ...tree.nodes.map(({ workspace }) => workspace.catalogScope)]) {
    const scan = await (await fixture.services.persistence.workspace(scope)).scan();
    expect(isVerifiedChain(scan.streams.body)).toBe(true);
    expect(isVerifiedChain(scan.streams.memory)).toBe(true);
    scannedFrames += scan.streams.body.frames.length + scan.streams.memory.frames.length;
    for (const frame of [...scan.streams.body.frames, ...scan.streams.memory.frames]) {
      expect(Object.keys(frame).sort()).toEqual(["spec", "kind", "stream_id", "seq", "utc", "payload", "payload_hash", "frame_hash", "prev", "prev_wave", "sig"].sort());
      if (frame.kind.startsWith("memory.")) sourceKinds.add(frame.kind);
      if ((frame.payload.data as { schema?: string } | undefined)?.schema === LIFECYCLE_SCHEMA)
        lifecycleTypes.add(validateLifecyclePayload(frame.payload).data.type);
    }
    expect(scan.streams.body.frames.some((frame) => frame.payload.schema === EVIDENCE_SCHEMA)).toBe(true);
  }
  expect(scannedFrames).toBeGreaterThan(0);
  expect([...sourceKinds]).toEqual(expect.arrayContaining(["memory.chat-turn", "memory.save", "memory.tool-call"]));
  expect([...lifecycleTypes]).toEqual(expect.arrayContaining(["workspace.created", "workspace.linked", "agent.created",
    "message.recorded", "twin.proposed", "workspace.evolved", "routine.drafted", "operation.intent", "operation.outcome"]));
  await fixture.services.runtime.close();
  await fixture.services.persistence.rebuildFromFrames();
  expect(await client.call("workspaces.tree", { workspaceId: null })).toEqual(tree);
  expect(await Promise.all(tree.nodes.map(async ({ workspace }) => {
    const { computer: _liveComputer, ...projection } = await client.call("workspaces.open", { workspaceId: workspace.id });
    return projection;
  }))).toEqual(projections);
  await fixture.close(false); fixtures.splice(fixtures.indexOf(fixture), 1);
  const restarted = await productionFixture({ directory: fixture.directory }); fixtures.push(restarted);
  expect(await bridge(restarted).call("workspaces.tree", { workspaceId: null })).toEqual(tree);
  expect(restarted.copilot.complete).not.toHaveBeenCalled();
  console.info(JSON.stringify({ rapp1: "COMPLIANT", scannedFrames, sourceKinds: [...sourceKinds],
    rebuiltFromFrames: true, trust: "local-integrity-only", liveInference: false, realGuestExecution: false }));
}, 240_000);
