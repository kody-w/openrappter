import { z } from "zod";
import {
  agentInputSchema, agentSchema, automationInputSchema, computerSchema, dateSchema, idSchema,
  settingsSchema, snapshotSchema, taskInputSchema, taskSchema, textSchema, automationSchema,
} from "../../host/src/contracts.js";

export const workspaceBindingSchema = z.strictObject({ workspaceId: idSchema });
export const conciergeBindingSchema = z.strictObject({ workspaceId: idSchema.nullable() });
const workspaceScopeSchema = z.strictObject({ agentId: idSchema, workspaceId: idSchema });
export const workspaceDetailsSchema = z.strictObject({
  name: textSchema,
  purpose: z.string().trim().min(1).max(4000),
  twin: z.strictObject({ name: textSchema, instructions: z.string().trim().min(1).max(16000) }),
  approvalPolicy: z.enum(["always", "on-risk"]),
  computerPolicy: z.enum(["none", "read-only", "control"]),
});
export const completeAgentDraftSchema = agentInputSchema.extend({
  role: z.string().trim().min(1).max(240), instructions: z.string().trim().min(1).max(16000),
});
export const workspaceInputSchema = workspaceDetailsSchema.extend({
  requestId: z.uuid(), leadAgent: completeAgentDraftSchema,
  starterTask: taskInputSchema.nullable(), starterRoutines: z.array(automationInputSchema).max(8),
}).superRefine((input, context) => {
  if (input.starterTask && input.starterTask.agentId !== input.leadAgent.id)
    context.addIssue({ code: "custom", path: ["starterTask"], message: "Starter work must belong to the lead agent." });
  if (new Set(input.starterRoutines.map((item) => item.id)).size !== input.starterRoutines.length)
    context.addIssue({ code: "custom", path: ["starterRoutines"], message: "Routine identities must be unique." });
  for (const item of input.starterRoutines) if (item.agentId !== input.leadAgent.id || item.enabled && !input.leadAgent.enabled)
    context.addIssue({ code: "custom", path: ["starterRoutines"], message: "Starter routines must belong to the available lead agent." });
  const rank = { none: 0, "read-only": 1, control: 2 };
  if (rank[input.leadAgent.computerPolicy] > rank[input.computerPolicy] ||
      input.approvalPolicy === "always" && input.leadAgent.approvalPolicy !== "always")
    context.addIssue({ code: "custom", path: ["leadAgent"], message: "The lead agent cannot exceed workspace access policies." });
});
export const workspaceSummarySchema = workspaceDetailsSchema.extend({
  id: idSchema, ownerId: idSchema, parentWorkspaceId: idSchema, catalogScope: workspaceScopeSchema,
  leadAgentId: idSchema, revision: z.number().int().nonnegative(), createdAt: dateSchema, updatedAt: dateSchema,
}).refine((workspace) => workspace.id === workspace.catalogScope.workspaceId && workspace.id !== workspace.parentWorkspaceId,
  "A business workspace must have an independent catalog.");
export const workspaceListSchema = z.strictObject({
  ownerId: idSchema, conciergeWorkspaceId: idSchema, workspaces: z.array(workspaceSummarySchema).max(1000),
});
export const settingsPatchSchema = z.strictObject({
  workspaceName: textSchema.optional(),
  appearance: settingsSchema.shape.appearance.partial().optional(),
  work: settingsSchema.shape.work.partial().optional(),
  notifications: settingsSchema.shape.notifications.partial().optional(),
}).refine((patch) => Object.values(patch).some((value) =>
  typeof value === "string" || value !== undefined && Object.keys(value).length > 0), "Settings changes cannot be empty.");
export const approvalRecommendationSchema = z.strictObject({
  approvalId: idSchema, operationHash: z.string().regex(/^[a-f0-9]{64}$/),
  recommendation: z.enum(["approve", "deny"]), reason: z.string().trim().min(1).max(2000),
});
export const twinTargetSchema = z.enum(["auto", "workspace", "task", "agent", "automation", "settings", "approval"]);
export const twinMessageRequestSchema = conciergeBindingSchema.extend({
  message: z.string().trim().min(1).max(8000), target: twinTargetSchema.optional(),
  history: z.array(z.strictObject({ role: z.enum(["user", "assistant"]), content: z.string().trim().min(1).max(8000) })).max(24),
  contextRevision: z.number().int().nonnegative().optional(),
}).refine((input) => new TextEncoder().encode(JSON.stringify(input)).byteLength <= 48 * 1024,
  "The conversation request exceeds its byte bound.");
export const twinBasisSchema = z.strictObject({
  schema: z.literal("rapp-work/twin-basis/1"), ownerId: idSchema, workspaceId: idSchema.nullable(),
  revision: z.number().int().nonnegative(),
  heads: z.array(z.strictObject({
    scope: workspaceScopeSchema,
    heads: z.strictObject({
      body: z.string().regex(/^[a-f0-9]{64}$/).nullable(), memory: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
      swarm: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
    }),
  })).min(1).max(1002),
  optionsHash: z.string().regex(/^[a-f0-9]{64}$/), proposalHash: z.string().regex(/^[a-f0-9]{64}$/),
});
export const twinDraftSchema = z.strictObject({
  id: z.uuid(), workspaceId: idSchema.nullable(),
  kind: z.enum(["workspace", "task", "agent", "automation", "settings", "approval", "clarification"]),
  assistantMessage: z.string().trim().min(1).max(8000), summary: z.string().trim().min(1).max(2000),
  confidence: z.number().min(0).max(1), readyForReview: z.boolean(),
  missing: z.array(z.string().trim().min(1).max(240)).max(24),
  draft: z.record(z.string(), z.unknown()).nullable(), basis: z.record(z.string(), z.unknown()).nullable(),
  createdAt: dateSchema,
});
export const twinTurnSchema = z.strictObject({
  id: z.uuid(), workspaceId: idSchema.nullable(), role: z.enum(["user", "assistant"]),
  content: z.string().min(1).max(8000), proposalId: z.uuid().nullable(), createdAt: dateSchema,
});
export const twinEventSchema = z.strictObject({
  id: z.uuid(), workspaceId: idSchema.nullable(), proposalId: z.uuid().nullable(),
  kind: z.enum(["proposal", "accept", "dismiss", "error"]), actorId: idSchema,
  detail: z.string().max(2000), createdAt: dateSchema,
});
export const twinConversationSchema = z.strictObject({
  workspaceId: idSchema.nullable(), revision: z.number().int().nonnegative(),
  turns: z.array(twinTurnSchema).max(500), proposals: z.array(twinDraftSchema).max(250), events: z.array(twinEventSchema).max(500),
}).superRefine((conversation, context) => {
  for (const key of ["turns", "proposals", "events"] as const) {
    if (conversation[key].some((item) => item.workspaceId !== conversation.workspaceId))
      context.addIssue({ code: "custom", path: [key], message: "Conversation records must belong to this workspace." });
  }
});
export const twinApplyRequestSchema = conciergeBindingSchema.extend({
  id: z.uuid(), proposalHash: z.string().regex(/^[a-f0-9]{64}$/),
  editedDraft: z.record(z.string(), z.unknown()).optional(),
});
export const twinDismissRequestSchema = twinApplyRequestSchema.omit({ editedDraft: true }).extend({
  reason: z.string().trim().max(2000).default("Dismissed by the owner."),
});
export const twinApplyResultSchema = z.strictObject({
  id: z.uuid(), workspaceId: idSchema.nullable(), kind: z.enum(["workspace", "task", "agent", "automation", "settings"]),
  status: z.literal("applied"), result: z.record(z.string(), z.unknown()), createdAt: dateSchema,
}).superRefine((receipt, context) => {
  const schemas = { workspace: workspaceSummarySchema, task: taskSchema, agent: agentSchema, automation: automationSchema, settings: settingsSchema };
  if (!schemas[receipt.kind].safeParse(receipt.result).success)
    context.addIssue({ code: "custom", path: ["result"], message: "The applied result must be a complete host record." });
});
export const workspaceOpenSchema = z.strictObject({
  workspace: workspaceSummarySchema, snapshot: snapshotSchema, twin: twinConversationSchema,
  routines: z.array(automationSchema).max(1000), computer: computerSchema,
}).refine((result) => result.workspace.id === result.snapshot.workspaceId && result.workspace.id === result.twin.workspaceId,
  "The open workspace and its records must agree.");

export type WorkspaceInput = z.infer<typeof workspaceInputSchema>;
export type WorkspaceSummary = z.infer<typeof workspaceSummarySchema>;
export type WorkspaceList = z.infer<typeof workspaceListSchema>;
export type WorkspaceOpen = z.infer<typeof workspaceOpenSchema>;
export type TwinDraft = z.infer<typeof twinDraftSchema>;
export type TwinMessageRequest = z.infer<typeof twinMessageRequestSchema>;
export type TwinTarget = z.infer<typeof twinTargetSchema>;
export type TwinConversation = z.infer<typeof twinConversationSchema>;
export type TwinApplyResult = z.infer<typeof twinApplyResultSchema>;
