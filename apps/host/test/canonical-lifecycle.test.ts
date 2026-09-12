import { randomUUID } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { isVerifiedChain } from "@rapp-work/rapp1";
import { LIFECYCLE_SCHEMA, validateLifecyclePayload } from "@rapp-work/domain";
import { agentInput, productionFixture } from "./production-fixture.js";
import { agentScope } from "../src/local-work.js";
import { twinDraftSchema } from "../src/contracts.js";

type Fixture = Awaited<ReturnType<typeof productionFixture>>;
const fixtures: Fixture[] = [];
afterEach(async () => { for (const fixture of fixtures.splice(0)) await fixture.close(); });
async function setup(computer = false) { const f = await productionFixture({ computer }); fixtures.push(f); return f; }
async function sourceTypes(f: Fixture) {
  const result = new Set<string>();
  const scopes = [f.services.persistence.owner.catalog, f.services.persistence.owner.computer,
    ...f.services.persistence.businessIds().map((id) => f.services.persistence.businessScope(id))];
  for (const scope of scopes) {
    const scan = await (await f.services.persistence.workspace(scope)).scan();
    if (!scan.streams.memory.frames.length) continue;
    expect(isVerifiedChain(scan.streams.body)).toBe(true);
    expect(isVerifiedChain(scan.streams.memory)).toBe(true);
    for (const frame of scan.streams.memory.frames) if ((frame.payload.data as any)?.schema === LIFECYCLE_SCHEMA) {
      result.add(validateLifecyclePayload(frame.payload).data.type);
    }
  }
  return [...result];
}

it("scans nonzero canonical workspace/agent/routine/computer lifecycles, including pause and fire", async () => {
  const f = await setup(true);
  const agent = await f.services.work.saveAgent(f.context(), agentInput("lifecycle-agent"));
  const before = await f.services.work.workspace(f.context());
  await f.services.work.updateWorkspace(f.context(), { name: "Renamed lifecycle workspace", purpose: before.purpose,
    twin: before.twin, approvalPolicy: before.approvalPolicy, computerPolicy: before.computerPolicy });
  await f.services.work.saveAgent(f.context(), { ...agentInput(agent.id), enabled: false });
  await f.services.work.saveAgent(f.context(), agentInput(agent.id));
  const input = { id: "lifecycle-routine", name: "Review", taskTitle: "Review sources", instructions: "Review supplied sources.",
    agentId: agent.id, cadence: { kind: "interval" as const, minutes: 15 }, enabled: false };
  await f.services.work.saveAutomation(f.context(), input, f.services.runtime);
  await f.services.work.saveAutomation(f.context(), { ...input, enabled: true }, f.services.runtime);
  await f.services.work.saveAutomation(f.context(), input, f.services.runtime);
  const enabled = await f.services.work.saveAutomation(f.context(), { ...input, enabled: true }, f.services.runtime);
  await f.services.runtime.tickSchedules(Date.parse(enabled.nextRunAt!) + 1);
  await f.services.runtime.drain();
  await f.services.computer.start(f.context());
  await f.services.computer.stop(f.context());
  await f.services.work.retireAgent(f.context(), agent.id);
  expect(await sourceTypes(f)).toEqual(expect.arrayContaining([
    "workspace.created", "workspace.renamed", "workspace.paused", "workspace.archived",
    "agent.created", "agent.configured", "agent.retired", "routine.drafted", "routine.enabled", "routine.paused", "routine.fired",
    "operation.intent", "operation.outcome", "computer.updated",
  ]));
  const history = await f.services.persistence.read(f.services.persistence.owner.computer);
  expect(history.commands.some((command) => command.command.operation === "computer.lease.acquire" && command.state === "committed")).toBe(true);
  expect(history.commands.every((command) => command.state === "committed")).toBe(true);
}, 240_000);

it("uses chat-turn/save/tool-call sources for clarification, proposal, edit/apply and dismissal", async () => {
  const f = await setup();
  let count = 0;
  f.copilot.complete.mockImplementation(async (request) => {
    if (++count === 1) return { kind: "clarification", assistantMessage: "Which period?", summary: "Period needed.",
      confidence: 0.8, readyForReview: false, missing: ["period"], draft: null };
    const message = request.messages[1]!;
    if (!("content" in message)) throw new Error("No context.");
    const prompt = JSON.parse(message.content);
    return { kind: "task", assistantMessage: "The draft is complete.", summary: "A complete review task.", confidence: 0.9,
      readyForReview: true, missing: [], draft: { requestId: prompt.allocatedIdentifiers.taskRequestId, title: "Review",
        instructions: "Review August evidence.", agentId: null, priority: "normal" } };
  });
  const send = async (message: string) => {
    const response = await f.rpc("twin.message", { workspaceId: f.workspace!.id, message, history: [] });
    expect(response.error).toBeUndefined();
    return twinDraftSchema.parse(response.result);
  };
  await send("Prepare a review.");
  const draft = await send("August.");
  const applied = await f.rpc("twin.applyProposal", { workspaceId: draft.workspaceId, id: draft.id,
    proposalHash: draft.basis!.proposalHash, editedDraft: { ...draft.draft, title: "August review" } });
  expect(applied.error).toBeUndefined();
  const dismissed = await send("Draft another review.");
  expect((await f.rpc("twin.dismissProposal", { workspaceId: dismissed.workspaceId, id: dismissed.id,
    proposalHash: dismissed.basis!.proposalHash })).error).toBeUndefined();
  expect(await sourceTypes(f)).toEqual(expect.arrayContaining(["message.recorded", "twin.clarified", "twin.proposed", "proposal.edited", "proposal.dismissed"]));
  const conversation = await f.services.twin.conversation(f.context());
  expect(conversation.turns.every((turn) => turn.verification?.state === "verified")).toBe(true);
  expect(conversation.proposals.every((proposal) => proposal.basis?.verification?.state === "verified")).toBe(true);
}, 180_000);

it("rejects stale heads and tampered source frames even after projection caches were populated", async () => {
  const f = await setup();
  f.copilot.complete.mockImplementation(async (request) => {
    const message = request.messages[1]!;
    if (!("content" in message)) throw new Error("No context.");
    const prompt = JSON.parse(message.content);
    return { kind: "task", assistantMessage: "Review this draft.", summary: "Complete task.", confidence: 0.9,
      readyForReview: true, missing: [], draft: { requestId: prompt.allocatedIdentifiers.taskRequestId, title: "Review",
        instructions: "Keep evidence.", agentId: null, priority: "normal" } };
  });
  const draft = twinDraftSchema.parse((await f.rpc("twin.message", { workspaceId: f.workspace!.id, message: "Draft a task.", history: [] })).result);
  await f.services.persistence.commit(f.workspace!.catalogScope, randomUUID(), "host.noop", {}, async () => ({
    status: "succeeded", value: {}, events: [], receipts: [{ kind: "no-effect" }],
  }));
  expect((await f.rpc("twin.applyProposal", { workspaceId: draft.workspaceId, id: draft.id, proposalHash: draft.basis!.proposalHash })).error?.code).toBe(-32015);
  const projection = await f.services.persistence.read(f.workspace!.catalogScope);
  (projection.commands as unknown as unknown[]).splice(0, 1);
  expect((await f.services.persistence.read(f.workspace!.catalogScope)).commands.length).toBeGreaterThan(projection.commands.length);
  const verification = draft.basis!.verification!;
  if (verification.state !== "verified") throw new Error("No verified proposal.");
  const directory = join(f.directory, "workspaces", verification.sourceWorkspaceId, "frames", "memory");
  const filename = (await readdir(directory)).find((name) => name.includes(verification.sourceFrameHash))!;
  const path = join(directory, filename), original = await readFile(path, "utf8");
  try {
    await writeFile(path, ` ${original}`, { mode: 0o600 });
    await expect(f.services.work.snapshot(f.context())).rejects.toThrow();
    expect((await f.rpc("twin.applyProposal", { workspaceId: draft.workspaceId, id: draft.id, proposalHash: draft.basis!.proposalHash })).error).toBeDefined();
  } finally { await writeFile(path, original, { mode: 0o600 }); }
  const lead = (await f.services.work.snapshot(f.context())).agents[0]!;
  const foreign = await f.services.persistence.capability(agentScope(lead));
  await expect(f.services.persistence.work.read(foreign, f.workspace!.catalogScope)).rejects.toThrow();
}, 120_000);
