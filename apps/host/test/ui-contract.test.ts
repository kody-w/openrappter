import { expect, it } from "vitest";
import {
  agentWorkspaceResultSchema, computerDisplaySchema, computerLeaseSchema, computerSchema, computerWorkspaceSchema,
  frameVerificationSchema, twinAgentApplyResultSchema, twinEvolutionEventSchema, twinEvolutionReferencesSchema,
  workspaceSummarySchema,
  type Agent, type Computer, type ComputerDisplayStatus, type ComputerLeaseStatus, type ComputerWorkspaceStatus,
  type FrameVerification, type TwinAgentApplyResult, type TwinEvolutionEvent, type WorkspaceLineage, type WorkspaceSummary,
} from "../src/contracts.js";

const createdAt = "2026-09-12T12:00:00.000Z";
const hash = "a".repeat(64);
const id = "00000000-0000-4000-8000-000000000001";
const agent: Agent = {
  id: "child-agent", name: "Child agent", role: "Review evidence", instructions: "Retain exact source references.",
  providerId: null, model: "", enabled: false, computerPolicy: "none", approvalPolicy: "always",
  workspaceId: "child-workspace", updatedAt: createdAt,
};
const workspace: WorkspaceSummary = {
  id: agent.workspaceId, ownerId: "human-owner", ownerType: "agent", ownerAgentId: agent.id,
  parentWorkspaceId: "parent-workspace", rootWorkspaceId: "parent-workspace",
  lineage: ["parent-workspace", agent.workspaceId], depth: 1, status: "active", parentAccess: "inspect",
  catalogScope: { agentId: agent.id, workspaceId: agent.workspaceId }, leadAgentId: agent.id,
  name: "Child workspace", purpose: "Review supplied evidence.", twin: { name: "Child Twin", instructions: "Draft for review." },
  computerPolicy: "none", approvalPolicy: "always",
  organization: { twinSummary: "", sections: [], suggestedRoutines: [], defaultFocus: "conversation" },
  revision: 1, createdAt, updatedAt: createdAt,
};

it("exports an exact parent-bound agent result with immutable child-lineage validation", () => {
  const lineage: WorkspaceLineage = workspace;
  const applied: TwinAgentApplyResult = {
    id, workspaceId: lineage.parentWorkspaceId!, kind: "agent", status: "applied",
    result: { agent, workspace }, createdAt,
  };
  expect(workspaceSummarySchema.parse(workspace)).toEqual(workspace);
  expect(agentWorkspaceResultSchema.parse(applied.result)).toEqual(applied.result);
  expect(twinAgentApplyResultSchema.parse(applied)).toEqual(applied);
  expect(twinAgentApplyResultSchema.safeParse({ ...applied, workspaceId: workspace.id }).success).toBe(false);
  expect(twinAgentApplyResultSchema.safeParse({ ...applied, workspaceId: null }).success).toBe(false);
  expect(agentWorkspaceResultSchema.safeParse({
    ...applied.result, agent: { ...agent, workspaceId: "sibling-workspace" },
  }).success).toBe(false);
  expect(agentWorkspaceResultSchema.safeParse({
    ...applied.result, agent: { ...agent, id: "sibling-agent" },
  }).success).toBe(false);
  expect(workspaceSummarySchema.safeParse({ ...workspace, lineage: [workspace.id, workspace.id] }).success).toBe(false);
});

it("exports the unchanged optional computer projection and each exact scoped status DTO", () => {
  const scope: ComputerWorkspaceStatus = {
    id: workspace.id, enabled: false, computerPolicy: "none", approvalPolicy: "always",
  };
  const lease: ComputerLeaseStatus = {
    state: "other-workspace", id: null, workspaceId: null, agentId: null, agentWorkspaceId: null, operation: "starting",
  };
  const display: ComputerDisplayStatus = { state: "unavailable", detail: "No verified screen stream." };
  const unavailable: Computer = {
    state: "unavailable", detail: "Computer is unavailable.", verified: false, verifiedAt: null,
    evidenceIds: [], capabilities: { view: false, control: false },
  };
  expect(computerSchema.parse(unavailable)).toEqual(unavailable);
  expect(computerWorkspaceSchema.parse(scope)).toEqual(scope);
  expect(computerLeaseSchema.parse(lease)).toEqual(lease);
  expect(computerDisplaySchema.parse(display)).toEqual(display);
  const scoped = { ...unavailable, workspace: scope, lease, display };
  expect(computerSchema.parse(scoped)).toEqual(scoped);
  expect(computerSchema.safeParse({ ...scoped, verified: true }).success).toBe(false);
  expect(computerLeaseSchema.safeParse({ ...lease, transferable: true }).success).toBe(false);
  expect(computerDisplaySchema.safeParse({ ...display, state: "simulated" }).success).toBe(false);
});

it("exports integrity-only proof projections and requires every exact evolution reference", () => {
  const verification: FrameVerification = {
    state: "verified", sourceFrameHash: hash, evidenceFrameHash: hash, publicationFrameHash: hash,
    workspaceId: workspace.id, sourceWorkspaceId: workspace.id, heads: { body: hash, memory: hash, swarm: null },
    trust: { classification: "integrity-only", factualTruth: false, authorship: false, promotionGrade: false },
  };
  expect(frameVerificationSchema.parse(verification)).toEqual(verification);
  expect(frameVerificationSchema.safeParse({ ...verification, trust: { ...verification.trust, factualTruth: true } }).success).toBe(false);
  expect(frameVerificationSchema.parse({ state: "unverified", detail: "No scanned source." }).state).toBe("unverified");
  expect(frameVerificationSchema.parse({ state: "unavailable", detail: "Host disconnected." }).state).toBe("unavailable");
  const event: TwinEvolutionEvent = {
    id, workspaceId: workspace.id, proposalId: id, kind: "evolution", actorId: "human-owner",
    detail: "Workspace evolved from this conversation", createdAt,
    references: { conversationFrameHash: hash, proposalFrameHash: hash, proposalHash: hash, evolutionFrameHash: hash },
  };
  expect(twinEvolutionEventSchema.parse(event)).toEqual(event);
  expect(twinEvolutionReferencesSchema.parse(event.references)).toEqual(event.references);
  expect(twinEvolutionEventSchema.safeParse({ ...event, references: undefined }).success).toBe(false);
  for (const key of Object.keys(event.references)) {
    expect(twinEvolutionReferencesSchema.safeParse({ ...event.references, [key]: undefined }).success).toBe(false);
  }
});
