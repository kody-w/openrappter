import { z } from "zod";
import {
  approvalRecommendationSchema, automationInputSchema, completeAgentDraftSchema, settingsPatchSchema,
  idSchema, settingsSchema, taskInputSchema, twinBasisSchema, workspaceInputSchema,
  type AgentInput, type AutomationInput, type Settings, type Snapshot, type TaskInput,
  type TwinConversation, type TwinDraft, type WorkspaceInput,
} from "./model";

export type ReviewDraft =
  | { kind: "workspace"; input: WorkspaceInput }
  | { kind: "task"; input: TaskInput }
  | { kind: "agent"; input: AgentInput }
  | { kind: "automation"; input: AutomationInput }
  | { kind: "settings"; input: Settings }
  | { kind: "approval"; input: z.infer<typeof approvalRecommendationSchema> };

export function prepareProposal(proposal: TwinDraft, workspaceId: string | null, snapshot: Snapshot | null): ReviewDraft | null {
  if (proposal.workspaceId !== workspaceId || !proposal.readyForReview || proposal.missing.length || proposal.draft === null) return null;
  const basis = twinBasisSchema.safeParse(proposal.basis);
  if (!basis.success || basis.data.workspaceId !== workspaceId || snapshot && basis.data.ownerId !== snapshot.ownerId) return null;
  if (proposal.kind === "workspace") {
    const value = workspaceInputSchema.safeParse(proposal.draft);
    return value.success && workspaceId === null ? { kind: "workspace", input: value.data } : null;
  }
  if (!snapshot || snapshot.workspaceId !== workspaceId) return null;
  if (proposal.kind === "task") {
    const value = taskInputSchema.safeParse(proposal.draft);
    return value.success && (value.data.agentId === null || snapshot.agents.some((item) => item.id === value.data.agentId))
      ? { kind: "task", input: value.data } : null;
  }
  if (proposal.kind === "agent") {
    const value = completeAgentDraftSchema.extend({
      providerId: idSchema, model: z.string().trim().min(1).max(160),
    }).safeParse(proposal.draft);
    return value.success ? { kind: "agent", input: value.data } : null;
  }
  if (proposal.kind === "automation") {
    const value = automationInputSchema.safeParse(proposal.draft);
    return value.success && snapshot.agents.some((item) => item.id === value.data.agentId)
      ? { kind: "automation", input: value.data } : null;
  }
  if (proposal.kind === "settings") {
    const value = settingsPatchSchema.safeParse(proposal.draft);
    if (!value.success) return null;
    const input = settingsSchema.safeParse({
      ...snapshot.settings, ...value.data,
      appearance: { ...snapshot.settings.appearance, ...value.data.appearance },
      work: { ...snapshot.settings.work, ...value.data.work },
      notifications: { ...snapshot.settings.notifications, ...value.data.notifications },
    });
    return input.success ? { kind: "settings", input: input.data } : null;
  }
  if (proposal.kind === "approval") {
    const value = approvalRecommendationSchema.safeParse(proposal.draft);
    if (!value.success) return null;
    const approval = snapshot.approvals.find((item) => item.id === value.data.approvalId);
    if (!approval || approval.operationHash !== value.data.operationHash || approval.state !== "pending"
      || approval.consumedBy || new Date(approval.expiresAt).getTime() <= Date.now()
      || !snapshot.runs.some((run) => run.id === approval.runId && run.state === "awaiting_approval")) return null;
    return { kind: "approval", input: value.data };
  }
  return null;
}
export function proposalDisposition(conversation: TwinConversation | null, id: string) {
  const event = conversation?.events.filter((item) => item.proposalId === id && ["accept", "dismiss"].includes(item.kind)).at(-1);
  return event?.kind === "accept" ? "Applied" : event?.kind === "dismiss" ? "Dismissed" : null;
}
export function conversationPhase(conversation: TwinConversation): string {
  const last = conversation.turns.at(-1);
  if (!last) return "Saved workspace";
  if (last.role === "user") {
    const failure = conversation.events.at(-1);
    return failure?.kind === "error" && Date.parse(failure.createdAt) >= Date.parse(last.createdAt) ? "Needs attention" : "Reply pending";
  }
  const proposal = conversation.proposals.find((item) => item.id === last.proposalId);
  return proposal ? proposalDisposition(conversation, proposal.id)
    ?? (proposal.kind === "clarification" ? "Needs your reply" : "Proposal received") : "Conversation saved";
}
export function proposalHash(proposal: TwinDraft): string | null {
  const basis = twinBasisSchema.safeParse(proposal.basis);
  return basis.success ? basis.data.proposalHash : null;
}
export function historyFor(conversation: TwinConversation | null, message = "") {
  const history = (conversation?.turns ?? []).slice(-24).map(({ role, content }) => ({ role, content }));
  const encoder = new TextEncoder();
  const budget = Math.min(32 * 1024, 48 * 1024 - encoder.encode(JSON.stringify(message)).byteLength - 512);
  while (history.length && encoder.encode(JSON.stringify(history)).byteLength > budget) history.shift();
  return history;
}
