import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { isVerifiedChain } from "@rapp-work/rapp1";
import { inventoryVisibilityInstructions, lockedEvidencePhrases } from "../../../tests/fixtures/instruction-documents.js";
import { instructionDocument, INSTRUCTION_DOCUMENT_REF } from "../src/instruction-document.js";
import { twinDraftSchema, type TwinDraft } from "../src/contracts.js";
import { agentScope } from "../src/local-work.js";
import { productionFixture } from "./production-fixture.js";

type Fixture = Awaited<ReturnType<typeof productionFixture>>;
const fixtures: Fixture[] = [];
afterEach(async () => { for (const fixture of fixtures.splice(0)) await fixture.close(); });
async function setup(directory?: string) {
  const f = await productionFixture(directory ? { directory } : {});
  fixtures.push(f); return f;
}
function response(request: Parameters<Fixture["copilot"]["complete"]>[0], changes: Record<string, unknown> = {}) {
  const context = request.messages[1];
  if (!context || !("content" in context)) throw new Error("No supplied context.");
  const prompt = JSON.parse(context.content);
  return {
    kind: "agent", assistantMessage: "I prepared Inventory Visibility Agent from your complete instructions, with conservative restrictions.",
    summary: "Inventory visibility agent; exact instructions preserved, no computer tools, disabled, always require approval.",
    confidence: 0.96, readyForReview: true, missing: [],
    draft: {
      id: prompt.allocatedIdentifiers.agentId, name: prompt.verifiedInstructionDocument.name,
      role: "Inventory visibility and evidence reporting", instructions: INSTRUCTION_DOCUMENT_REF,
      providerId: prompt.verifiedContext.allowed.providerModels[0].providerId,
      model: prompt.verifiedContext.allowed.providerModels[0].model,
      computerPolicy: "none", approvalPolicy: "always", enabled: false, suggestedRoutines: [], ...changes,
    },
  };
}
const applyInput = (draft: TwinDraft) => ({ workspaceId: draft.workspaceId, id: draft.id, proposalHash: draft.basis!.proposalHash });

describe("primary verbatim instruction-document intake", () => {
  it("infers the supplied identity and retains a long Markdown document byte-for-byte in draft, agent definition and restart history", async () => {
    const f = await setup();
    expect(inventoryVisibilityInstructions.length).toBeGreaterThan(32_768);
    f.copilot.complete.mockImplementation(async (request) => response(request));
    const reply = await f.rpc("twin.message", { workspaceId: f.workspace!.id, history: [], target: "auto", message: inventoryVisibilityInstructions });
    expect(reply.error).toBeUndefined();
    const draft = twinDraftSchema.parse(reply.result);
    expect(draft).toMatchObject({
      kind: "agent", readyForReview: true, missing: [],
      draft: { name: "Inventory Visibility Agent", instructions: inventoryVisibilityInstructions,
        providerId: "github-copilot", model: "gpt-6-astra", computerPolicy: "none", approvalPolicy: "always", enabled: false, suggestedRoutines: [] },
    });
    if (draft.kind !== "agent") throw new Error("No agent draft.");
    for (const phrase of lockedEvidencePhrases) expect(draft.draft.instructions).toContain(phrase);
    expect(draft.basis!.instructionDocument).toBeDefined();
    const prompt = f.copilot.complete.mock.calls[0]![0].messages[1]!;
    expect("content" in prompt && JSON.parse(prompt.content).message).toBe(inventoryVisibilityInstructions);
    expect((await f.rpc("twin.applyProposal", {
      ...applyInput(draft), editedDraft: { ...draft.draft, instructions: draft.draft.instructions.trim() },
    })).error?.code).toBe(-32602);
    expect((await f.rpc("twin.applyProposal", applyInput(draft))).error).toBeUndefined();
    const agent = (await f.services.work.snapshot(f.context())).agents.find((item) => item.id === draft.draft.id)!;
    expect(agent.instructions).toBe(inventoryVisibilityInstructions);
    const history = await f.services.persistence.read(agentScope(agent));
    const definition = history.commands.find((command) => command.command.operation === "agent.define");
    expect(JSON.stringify(definition)).toContain(lockedEvidencePhrases[0]);
    const scanned = await (await f.services.persistence.workspace(agentScope(agent))).scan();
    expect(isVerifiedChain(scanned.streams.body)).toBe(true);
    expect(scanned.streams.body.frames.length).toBeGreaterThan(0);
    await f.close(false); fixtures.splice(fixtures.indexOf(f), 1);
    const reopened = await setup(f.directory);
    expect((await reopened.services.work.snapshot(reopened.context())).agents.find((item) => item.id === agent.id)!.instructions).toBe(inventoryVisibilityInstructions);
    expect(reopened.copilot.complete).not.toHaveBeenCalled();
  }, 180_000);

  it("rejects rewritten evidence, a different name, relaxed policy and requests to re-enter present fields", async () => {
    const f = await setup();
    const document = "# Inventory Visibility Agent — Manual Global Instructions\nNo computer access. Remain disabled until reviewed. No schedules.\nLOCKED EVIDENCE: Do not infer availability.\n";
    const changes = [
      { instructions: document.replace("Do not infer", "Infer") }, { name: "Guessed inventory agent" },
      { enabled: true }, { approvalPolicy: "on-risk" }, { computerPolicy: "read-only" },
    ];
    for (const change of changes) {
      f.copilot.complete.mockImplementation(async (request) => response(request, change));
      expect((await f.rpc("twin.message", { workspaceId: f.workspace!.id, message: document, history: [], target: "agent" })).error?.code).toBe(-32014);
    }
    f.copilot.complete.mockResolvedValue({
      kind: "clarification", assistantMessage: "Enter the agent name and instructions.", summary: "Missing form fields.",
      confidence: 0.5, readyForReview: false, missing: ["name", "instructions"], draft: null,
    });
    expect((await f.rpc("twin.message", { workspaceId: f.workspace!.id, message: document, history: [], target: "agent" })).error?.code).toBe(-32014);
    expect((await f.services.twin.conversation(f.context())).proposals).toEqual([]);
  }, 65_000);

  it("retains the document through a necessary follow-up rather than asking for the same fields again", async () => {
    const f = await setup();
    const document = "# Inventory Visibility Agent — Manual Global Instructions\nNo computer access. Always require approval.\nReport only supplied inventory evidence.\n";
    f.copilot.complete.mockResolvedValueOnce({
      kind: "clarification", assistantMessage: "Should this agent start disabled?", summary: "Confirm initial activation.",
      confidence: 0.8, readyForReview: false, missing: ["enabled"], draft: null,
    });
    expect((await f.rpc("twin.message", { workspaceId: f.workspace!.id, message: document, history: [], target: "agent" })).error).toBeUndefined();
    f.copilot.complete.mockImplementation(async (request) => response(request));
    const reply = await f.rpc("twin.message", { workspaceId: f.workspace!.id, message: "Yes, keep it disabled.", history: [], target: "agent" });
    const draft = twinDraftSchema.parse(reply.result);
    expect(draft.kind === "agent" && draft.draft.instructions).toBe(document);
  }, 45_000);

  it("includes complete suggested routines, keeps them disabled, and requires automation permission to save them", async () => {
    const f = await setup();
    const document = "# Inventory Visibility Agent — Manual Global Instructions\nNo computer access. Always require approval.\nSuggest a daily 09:00 UTC inventory evidence review, but do not enable it automatically.\n";
    f.copilot.complete.mockImplementation(async (request) => {
      const context = request.messages[1]!;
      if (!("content" in context)) throw new Error("No context.");
      const prompt = JSON.parse(context.content);
      return response(request, { suggestedRoutines: [{
        id: prompt.allocatedIdentifiers.routineIds[0], agentId: prompt.allocatedIdentifiers.agentId,
        name: "Daily inventory evidence review", taskTitle: "Review inventory evidence",
        instructions: "Apply the complete agent instructions to the supplied evidence.",
        cadence: { kind: "daily", at: "09:00", timezone: "UTC" }, enabled: false,
      }] });
    });
    const draft = twinDraftSchema.parse((await f.rpc("twin.message", { workspaceId: f.workspace!.id, message: document, history: [], target: "agent" })).result);
    const authorize = f.services.security.authorize;
    f.services.security.authorize = async (principal, permission) => permission !== "automations:write" && authorize(principal, permission);
    expect((await f.rpc("twin.applyProposal", applyInput(draft))).error?.code).toBe(-32003);
    expect((await f.services.work.snapshot(f.context())).agents).toHaveLength(1);
    f.services.security.authorize = authorize;
    expect((await f.rpc("twin.applyProposal", applyInput(draft))).error).toBeUndefined();
    const snapshot = await f.services.work.snapshot(f.context());
    expect(snapshot.automations).toHaveLength(1);
    expect(snapshot.automations[0]).toMatchObject({ enabled: false, nextRunAt: null });
    expect(snapshot.runs).toEqual([]);
  }, 60_000);

  it("does not confuse document structure with a tool grant", () => {
    const source = instructionDocument(inventoryVisibilityInstructions, randomUUID())!;
    expect(source).toMatchObject({ name: "Inventory Visibility Agent", maximumComputerPolicy: "none", requireDisabled: true, forbidRoutines: true });
    expect(source.text).toBe(inventoryVisibilityInstructions);
  });
});
