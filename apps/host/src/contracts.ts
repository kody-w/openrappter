import { z } from "zod";

export const idSchema = z.string().min(1).max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/);
export const textSchema = z.string().trim().min(1).max(160);
export const MAX_INSTRUCTION_CHARS = 64_000;
export const MAX_RPC_BYTES = 512 * 1024;
export const instructionTextSchema = z.string().min(1).max(MAX_INSTRUCTION_CHARS)
  .refine((value) => value.trim().length > 0 && new TextEncoder().encode(value).byteLength <= 128 * 1024,
    "Instructions must contain text and fit within 128 KiB.");
export const dateSchema = z.iso.datetime();
export const areaSchema = z.enum(["work", "agents", "automations", "settings"]);
export const checkSchema = z.strictObject({
  state: z.enum(["ready", "degraded", "unavailable"]),
  detail: z.string().max(512),
});
export const settingsSchema = z.strictObject({
  workspaceName: textSchema,
  appearance: z.strictObject({
    theme: z.enum(["system", "light", "dark"]),
    density: z.enum(["comfortable", "compact"]),
  }),
  work: z.strictObject({
    defaultPriority: z.enum(["normal", "high"]),
    approvalPolicy: z.enum(["always", "on-risk"]),
  }),
  notifications: z.strictObject({ approvals: z.boolean(), completedRuns: z.boolean() }),
});
export const agentInputSchema = z.strictObject({
  id: idSchema,
  name: textSchema,
  role: z.string().trim().max(240),
  instructions: instructionTextSchema,
  providerId: idSchema.nullable(),
  model: z.string().max(160),
  computerPolicy: z.enum(["none", "read-only", "control"]),
  approvalPolicy: z.enum(["always", "on-risk"]),
  enabled: z.boolean(),
});
export const agentSchema = agentInputSchema.extend({ workspaceId: idSchema, updatedAt: dateSchema, retiredAt: dateSchema.nullable().optional() });
export const taskInputSchema = z.strictObject({
  requestId: z.uuid(),
  title: textSchema,
  instructions: z.string().trim().min(1).max(16000),
  agentId: idSchema.nullable(),
  priority: z.enum(["normal", "high"]),
});
export const taskSchema = taskInputSchema.omit({ requestId: true }).extend({
  id: idSchema,
  workspaceId: idSchema.nullable(),
  state: z.enum(["queued", "running", "awaiting_approval", "completed", "failed", "cancelled", "unresolved"]),
  createdAt: dateSchema,
  updatedAt: dateSchema,
}).refine((task) => (task.agentId === null) === (task.workspaceId === null), "Assigned tasks require an agent workspace.");
export const runSchema = z.strictObject({
  id: idSchema,
  taskId: idSchema,
  agentId: idSchema,
  workspaceId: idSchema,
  state: z.enum(["running", "awaiting_approval", "completed", "failed", "cancelled", "unresolved"]),
  startedAt: dateSchema,
  finishedAt: dateSchema.nullable(),
  summary: z.string().max(4000),
  verification: z.enum(["not_checked", "passed", "failed"]),
  evidenceIds: z.array(idSchema).max(200),
}).refine((run) => run.verification !== "passed" || run.evidenceIds.length > 0, {
  message: "Passed verification requires service-reported evidence.",
});
export const approvalSchema = z.strictObject({
  id: idSchema,
  runId: idSchema,
  taskId: idSchema,
  agentId: idSchema,
  workspaceId: idSchema,
  operationHash: z.string().regex(/^[a-f0-9]{64}$/),
  expiresAt: dateSchema,
  consumedBy: idSchema.nullable(),
  action: textSchema,
  reason: z.string().max(4000),
  risk: z.enum(["low", "medium", "high"]),
  state: z.enum(["pending", "approved", "denied"]),
  createdAt: dateSchema,
  decidedAt: dateSchema.nullable(),
  decisionReason: z.string().max(2000),
});
export const artifactSchema = z.strictObject({
  id: idSchema,
  taskId: idSchema,
  runId: idSchema,
  agentId: idSchema,
  workspaceId: idSchema,
  name: textSchema,
  mediaType: z.enum(["text/plain", "text/markdown", "application/json"]),
  bytes: z.number().int().nonnegative().max(1_000_000),
  createdAt: dateSchema,
  evidence: z.boolean(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
const timezoneSchema = z.string().min(1).max(100).refine((zone) => {
  try { new Intl.DateTimeFormat("en", { timeZone: zone }); return true; }
  catch { return false; }
}, "Use a valid IANA time zone.");
const timeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
export const cadenceSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("daily"), at: timeSchema, timezone: timezoneSchema }),
  z.strictObject({
    kind: z.literal("weekly"), at: timeSchema, timezone: timezoneSchema,
    weekday: z.number().int().min(0).max(6),
  }),
  z.strictObject({ kind: z.literal("interval"), minutes: z.number().int().min(15).max(10080) }),
]);
export const automationInputSchema = z.strictObject({
  id: idSchema,
  name: textSchema,
  taskTitle: textSchema,
  instructions: z.string().trim().min(1).max(16000),
  agentId: idSchema,
  cadence: cadenceSchema,
  enabled: z.boolean(),
});
export const automationSchema = automationInputSchema.extend({
  workspaceId: idSchema,
  originWorkspaceId: idSchema.optional(),
  updatedAt: dateSchema,
  nextRunAt: dateSchema.nullable(),
});
export const snapshotSchema = z.strictObject({
  ownerId: idSchema,
  workspaceId: idSchema,
  revision: z.number().int().nonnegative(),
  agents: z.array(agentSchema).max(1000),
  tasks: z.array(taskSchema).max(10000),
  runs: z.array(runSchema).max(20000),
  approvals: z.array(approvalSchema).max(10000),
  artifacts: z.array(artifactSchema).max(20000),
  automations: z.array(automationSchema).max(1000),
  settings: settingsSchema,
}).superRefine((snapshot, context) => {
  const agents = new Map(snapshot.agents.map((agent) => [agent.id, agent]));
  const tasks = new Map(snapshot.tasks.map((task) => [task.id, task]));
  const runs = new Map(snapshot.runs.map((run) => [run.id, run]));
  const reject = (path: (string | number)[]) => context.addIssue({ code: "custom", path, message: "Agent, task and workspace ownership must agree." });
  if (agents.size !== snapshot.agents.length || new Set(snapshot.agents.map((agent) => agent.workspaceId)).size !== agents.size) reject(["agents"]);
  for (const [index, task] of snapshot.tasks.entries()) {
    if (task.agentId !== null && agents.get(task.agentId)?.workspaceId !== task.workspaceId) reject(["tasks", index]);
  }
  for (const [index, run] of snapshot.runs.entries()) {
    const task = tasks.get(run.taskId);
    if (!task || task.agentId !== run.agentId || task.workspaceId !== run.workspaceId) reject(["runs", index]);
  }
  for (const key of ["approvals", "artifacts"] as const) for (const [index, item] of snapshot[key].entries()) {
    const run = runs.get(item.runId);
    if (!run || run.taskId !== item.taskId || run.agentId !== item.agentId || run.workspaceId !== item.workspaceId) reject([key, index]);
  }
  for (const [index, item] of snapshot.automations.entries()) {
    if (agents.get(item.agentId)?.workspaceId !== item.workspaceId) reject(["automations", index]);
  }
});
export const providerSchema = z.strictObject({
  id: idSchema,
  name: textSchema,
  configured: z.boolean(),
  availability: z.enum(["ready", "unavailable"]),
  authentication: z.enum(["authenticated", "required", "unverified"]),
  models: z.array(z.string().min(1).max(160)).max(500),
  detail: z.string().max(512),
  modelOptions: z.array(z.strictObject({
    model: z.string().min(1).max(160),
    reasoningEfforts: z.array(z.string().min(1).max(32)).max(16),
    maxContextWindowTokens: z.number().int().positive(),
  })).max(500).optional(),
});
export const computerSchema = z.strictObject({
  state: z.enum(["unavailable", "stopped", "starting", "running", "unresolved", "error"]),
  detail: z.string().max(2000),
  verified: z.boolean(),
  verifiedAt: dateSchema.nullable(),
  evidenceIds: z.array(idSchema).max(200),
  capabilities: z.strictObject({ view: z.boolean(), control: z.boolean() }),
  workspace: z.strictObject({
    id: idSchema, enabled: z.boolean(),
    computerPolicy: z.enum(["none", "read-only", "control"]),
    approvalPolicy: z.enum(["always", "on-risk"]),
  }).nullable().optional(),
  lease: z.strictObject({
    state: z.enum(["idle", "held", "other-workspace", "unresolved"]),
    id: z.uuid().nullable(), workspaceId: idSchema.nullable(), agentId: idSchema.nullable(),
    agentWorkspaceId: idSchema.nullable(),
    operation: z.enum(["starting", "stopping", "executing"]).nullable(),
  }).optional(),
  display: z.strictObject({
    state: z.enum(["available", "unavailable"]),
    detail: z.string().max(1000),
  }).optional(),
}).refine((computer) => !computer.verified ||
  (computer.state === "running" && computer.verifiedAt !== null && computer.evidenceIds.length > 0), {
  message: "Computer verification requires running service evidence.",
});
export const diagnosticsSchema = z.strictObject({
  capturedAt: dateSchema,
  entries: z.array(z.strictObject({
    id: idSchema,
    time: dateSchema,
    level: z.enum(["info", "warning", "error"]),
    area: areaSchema,
    message: z.string().max(1000),
  })).max(200),
});
export const serviceNames = ["storage", "security", "work", "runtime", "provider", "computer", "diagnostics"] as const;
export const statusSchema = z.strictObject({
  product: z.literal("RAPP Work"),
  protocolVersion: z.literal(1),
  ready: z.boolean(),
  checks: z.strictObject(Object.fromEntries(serviceNames.map((key) => [key, checkSchema])) as
    Record<(typeof serviceNames)[number], typeof checkSchema>),
});
export const scopeSchema = z.strictObject({ area: areaSchema, entityId: idSchema.optional() });
export const eventReadSchema = z.strictObject({
  scope: scopeSchema,
  cursor: z.string().min(1).max(2048).optional(),
  limit: z.number().int().min(1).max(200).default(100),
});
export const eventSchema = z.strictObject({
  id: idSchema,
  area: areaSchema,
  entityId: idSchema,
  kind: z.enum(["created", "updated"]),
  at: dateSchema,
});
export const eventPageSchema = z.strictObject({
  events: z.array(eventSchema).max(200),
  cursor: z.string().max(2048),
});
export const rpcEnvelopeSchema = z.strictObject({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string().min(1).max(128), z.number().int().safe()]),
  method: z.string().min(1).max(80),
  params: z.unknown().optional(),
});
export const emptySchema = z.strictObject({});
export const entityParamsSchema = z.strictObject({ id: idSchema });
export const approvalDecisionSchema = z.strictObject({
  id: idSchema,
  decision: z.enum(["approved", "denied"]),
  reason: z.string().trim().min(1).max(2000),
});
export const providerConfigSchema = z.strictObject({
  id: idSchema, connectionRef: z.string().min(1).max(160).regex(/^[a-zA-Z0-9_./:-]+$/),
});

export type Area = z.infer<typeof areaSchema>;
export type Check = z.infer<typeof checkSchema>;
export type Agent = z.infer<typeof agentSchema>;
export type AgentInput = z.infer<typeof agentInputSchema>;
export type Task = z.infer<typeof taskSchema>;
export type TaskInput = z.infer<typeof taskInputSchema>;
export type Run = z.infer<typeof runSchema>;
export type Approval = z.infer<typeof approvalSchema>;
export type Artifact = z.infer<typeof artifactSchema>;
export type Automation = z.infer<typeof automationSchema>;
export type AutomationInput = z.infer<typeof automationInputSchema>;
export type Settings = z.infer<typeof settingsSchema>;
export type Snapshot = z.infer<typeof snapshotSchema>;
export type Provider = z.infer<typeof providerSchema>;
export type Computer = z.infer<typeof computerSchema>;
export type Diagnostics = z.infer<typeof diagnosticsSchema>;
export type Status = z.infer<typeof statusSchema>;
export type EventScope = z.infer<typeof scopeSchema>;
export type WorkEvent = z.infer<typeof eventSchema>;
export type EventPage = z.infer<typeof eventPageSchema>;

export const workspaceScopeSchema = z.strictObject({ agentId: idSchema, workspaceId: idSchema });
export const MAX_WORKSPACE_DEPTH = 4;
export const MAX_WORKSPACE_AGENTS = 32;
export const MAX_WORKSPACES = 1000;
export const workspaceBindingSchema = z.strictObject({ workspaceId: idSchema });
export const conciergeBindingSchema = z.strictObject({ workspaceId: idSchema.nullable() });
export const twinIdentitySchema = z.strictObject({
  name: textSchema,
  instructions: z.string().trim().min(1).max(16000),
});
export const workspaceDetailsSchema = z.strictObject({
  name: textSchema,
  purpose: z.string().trim().min(1).max(4000),
  twin: twinIdentitySchema,
  approvalPolicy: z.enum(["always", "on-risk"]),
  computerPolicy: z.enum(["none", "read-only", "control"]),
  parentAccess: z.enum(["inspect", "none"]).optional(),
});
export const workspaceOrganizationSchema = z.strictObject({
  twinSummary: z.string().max(2000),
  sections: z.array(z.strictObject({
    id: idSchema, title: textSchema, description: z.string().max(1000),
    kind: z.enum(["tasks", "notes", "routines"]), taskIds: z.array(idSchema).max(100),
  })).max(8),
  suggestedRoutines: z.array(automationInputSchema.extend({ enabled: z.literal(false) })).max(8),
  defaultFocus: z.enum(["conversation", "work", "agents", "automations", "settings"]),
}).refine((organization) => new Set(organization.sections.map((section) => section.id)).size === organization.sections.length
  && new Set(organization.suggestedRoutines.map((routine) => routine.id)).size === organization.suggestedRoutines.length,
  "Internal organization identifiers must be unique.");
export const emptyOrganization = () => workspaceOrganizationSchema.parse({
  twinSummary: "", sections: [], suggestedRoutines: [], defaultFocus: "conversation",
});
const leadAgentSchema = agentInputSchema.extend({
  role: z.string().trim().min(1).max(240),
  instructions: instructionTextSchema,
});
export const workspaceInputSchema = workspaceDetailsSchema.extend({
  requestId: z.uuid(),
  leadAgent: leadAgentSchema,
  starterTask: taskInputSchema.nullable(),
  starterRoutines: z.array(automationInputSchema).max(8),
}).superRefine((input, context) => {
  if (input.starterTask && input.starterTask.agentId !== input.leadAgent.id) {
    context.addIssue({ code: "custom", path: ["starterTask", "agentId"], message: "Starter work belongs to the lead agent." });
  }
  if (new Set(input.starterRoutines.map((routine) => routine.id)).size !== input.starterRoutines.length) {
    context.addIssue({ code: "custom", path: ["starterRoutines"], message: "Routine identities must be unique." });
  }
  for (const [index, routine] of input.starterRoutines.entries()) {
    if (routine.agentId !== input.leadAgent.id || (routine.enabled && !input.leadAgent.enabled)) {
      context.addIssue({ code: "custom", path: ["starterRoutines", index], message: "Starter routines require their own available lead agent." });
    }
  }
  const rank = { none: 0, "read-only": 1, control: 2 };
  if (rank[input.leadAgent.computerPolicy] > rank[input.computerPolicy]) {
    context.addIssue({ code: "custom", path: ["leadAgent", "computerPolicy"], message: "An agent cannot exceed its business computer policy." });
  }
  if (input.approvalPolicy === "always" && input.leadAgent.approvalPolicy !== "always") {
    context.addIssue({ code: "custom", path: ["leadAgent", "approvalPolicy"], message: "The business approval policy is the minimum." });
  }
});
export const workspaceSummarySchema = workspaceDetailsSchema.extend({
  id: idSchema,
  ownerId: idSchema,
  parentWorkspaceId: idSchema.nullable(),
  ownerType: z.enum(["human", "agent"]),
  ownerAgentId: idSchema.nullable(),
  rootWorkspaceId: idSchema,
  lineage: z.array(idSchema).min(1).max(MAX_WORKSPACE_DEPTH + 1),
  depth: z.number().int().min(0).max(MAX_WORKSPACE_DEPTH),
  status: z.enum(["active", "paused", "archived"]),
  parentAccess: z.enum(["inspect", "none"]),
  organization: workspaceOrganizationSchema,
  catalogScope: workspaceScopeSchema,
  leadAgentId: idSchema,
  revision: z.number().int().nonnegative(),
  createdAt: dateSchema,
  updatedAt: dateSchema,
}).superRefine((workspace, context) => {
  if (workspace.id !== workspace.catalogScope.workspaceId || workspace.id === workspace.parentWorkspaceId
    || workspace.lineage.length !== workspace.depth + 1 || workspace.lineage.at(-1) !== workspace.id
    || workspace.lineage[0] !== workspace.rootWorkspaceId || new Set(workspace.lineage).size !== workspace.lineage.length
    || (workspace.depth === 0
      ? workspace.parentWorkspaceId !== null || workspace.rootWorkspaceId !== workspace.id || workspace.ownerType !== "human" || workspace.ownerAgentId !== null
      : workspace.parentWorkspaceId !== workspace.lineage.at(-2) || workspace.ownerType !== "agent"
        || workspace.ownerAgentId !== workspace.catalogScope.agentId)) {
    context.addIssue({ code: "custom", message: "Workspace ownership and immutable bounded lineage must agree." });
  }
});
export const workspaceListSchema = z.strictObject({
  ownerId: idSchema,
  conciergeWorkspaceId: idSchema,
  workspaces: z.array(workspaceSummarySchema).max(MAX_WORKSPACES),
});
export const workspaceChildrenSchema = z.strictObject({
  parent: workspaceSummarySchema,
  children: z.array(workspaceSummarySchema).max(MAX_WORKSPACE_AGENTS),
});
export const workspaceTreeSchema = z.strictObject({
  maxDepth: z.literal(MAX_WORKSPACE_DEPTH),
  roots: z.array(idSchema).max(MAX_WORKSPACES),
  nodes: z.array(z.strictObject({
    workspace: workspaceSummarySchema, children: z.array(idSchema).max(MAX_WORKSPACE_AGENTS),
  })).max(MAX_WORKSPACES),
});
export const workspaceBreadcrumbSchema = z.strictObject({
  workspaceId: idSchema,
  ancestors: z.array(z.strictObject({
    id: idSchema, name: textSchema, ownerType: z.enum(["human", "agent"]),
    ownerAgentId: idSchema.nullable(), depth: z.number().int().min(0).max(MAX_WORKSPACE_DEPTH),
  })).min(1).max(MAX_WORKSPACE_DEPTH + 1),
});
export const settingsPatchSchema = z.strictObject({
  workspaceName: textSchema.optional(),
  appearance: settingsSchema.shape.appearance.partial().optional(),
  work: settingsSchema.shape.work.partial().optional(),
  notifications: settingsSchema.shape.notifications.partial().optional(),
  computerPolicy: z.enum(["none", "read-only", "control"]).optional(),
  parentAccess: z.enum(["inspect", "none"]).optional(),
}).refine((patch) => Object.values(patch).some((value) =>
  typeof value === "string" || (value !== undefined && Object.keys(value).length > 0)), "Specify a meaningful settings change.");
export const approvalRecommendationSchema = z.strictObject({
  approvalId: idSchema,
  operationHash: z.string().regex(/^[a-f0-9]{64}$/),
  recommendation: z.enum(["approve", "deny"]),
  reason: z.string().trim().min(1).max(2000),
});
export const twinTargetSchema = z.enum(["auto", "workspace", "task", "agent", "automation", "settings", "approval"]);
export const twinMessageRequestSchema = conciergeBindingSchema.extend({
  message: instructionTextSchema,
  target: twinTargetSchema.optional(),
  history: z.array(z.strictObject({
    role: z.enum(["user", "assistant"]),
    content: z.string().trim().min(1).max(8000),
  })).max(24),
  contextRevision: z.number().int().nonnegative().optional(),
}).refine((input) => new TextEncoder().encode(JSON.stringify(input)).byteLength <= 256 * 1024
  && new TextEncoder().encode(JSON.stringify(input.history)).byteLength <= 48 * 1024,
  "The conversation request exceeds its byte bound.");
const proposalFields = {
  assistantMessage: z.string().trim().min(1).max(8000),
  summary: z.string().trim().min(1).max(2000),
  confidence: z.number().min(0).max(1),
  readyForReview: z.literal(true),
  missing: z.array(z.string()).length(0),
};
const completeAgentDraftSchema = leadAgentSchema.extend({
  providerId: idSchema,
  model: z.string().min(1).max(160),
});
export const agentDraftSchema = completeAgentDraftSchema.extend({
  suggestedRoutines: z.array(automationInputSchema).max(8).optional(),
}).superRefine((draft, context) => {
  const routines = draft.suggestedRoutines ?? [];
  if (new Set(routines.map((routine) => routine.id)).size !== routines.length
    || routines.some((routine) => routine.agentId !== draft.id || routine.enabled)) {
    context.addIssue({ code: "custom", path: ["suggestedRoutines"],
      message: "Suggested routines belong to this agent and remain disabled until separately reviewed." });
  }
});
export const twinProposalSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("workspace"), ...proposalFields, draft: workspaceInputSchema }),
  z.strictObject({ kind: z.literal("task"), ...proposalFields, draft: taskInputSchema }),
  z.strictObject({ kind: z.literal("agent"), ...proposalFields, draft: agentDraftSchema }),
  z.strictObject({ kind: z.literal("automation"), ...proposalFields, draft: automationInputSchema }),
  z.strictObject({ kind: z.literal("settings"), ...proposalFields, draft: settingsPatchSchema }),
  z.strictObject({ kind: z.literal("approval"), ...proposalFields, draft: approvalRecommendationSchema }),
  z.strictObject({
    kind: z.literal("clarification"),
    assistantMessage: proposalFields.assistantMessage,
    summary: proposalFields.summary,
    confidence: proposalFields.confidence,
    readyForReview: z.literal(false),
    missing: z.array(z.string().trim().min(1).max(240)).min(1).max(24),
    draft: z.null(),
  }),
]);
const evolutionField = { evolution: workspaceOrganizationSchema.optional() };
export const twinModelResponseSchema = z.discriminatedUnion("kind", [
  twinProposalSchema.options[0].extend(evolutionField),
  twinProposalSchema.options[1].extend(evolutionField),
  twinProposalSchema.options[2].extend(evolutionField),
  twinProposalSchema.options[3].extend(evolutionField),
  twinProposalSchema.options[4].extend(evolutionField),
  twinProposalSchema.options[5].extend(evolutionField),
  twinProposalSchema.options[6].extend(evolutionField),
]);
export const twinHeadsSchema = z.strictObject({
  body: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  memory: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  swarm: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
});
export const twinBasisSchema = z.strictObject({
  schema: z.literal("rapp-work/twin-basis/1"),
  ownerId: idSchema,
  workspaceId: idSchema.nullable(),
  revision: z.number().int().nonnegative(),
  heads: z.array(z.strictObject({ scope: workspaceScopeSchema, heads: twinHeadsSchema })).min(1).max(1002),
  optionsHash: z.string().regex(/^[a-f0-9]{64}$/),
  proposalHash: z.string().regex(/^[a-f0-9]{64}$/),
  instructionDocument: z.strictObject({
    turnId: z.uuid(), contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  }).optional(),
});
const twinEnvelopeFields = {
  id: z.uuid(), workspaceId: idSchema.nullable(), createdAt: dateSchema, basis: twinBasisSchema.nullable(),
};
export const twinDraftSchema = z.discriminatedUnion("kind", [
  twinProposalSchema.options[0].extend(twinEnvelopeFields),
  twinProposalSchema.options[1].extend(twinEnvelopeFields),
  twinProposalSchema.options[2].extend(twinEnvelopeFields),
  twinProposalSchema.options[3].extend(twinEnvelopeFields),
  twinProposalSchema.options[4].extend(twinEnvelopeFields),
  twinProposalSchema.options[5].extend(twinEnvelopeFields),
  twinProposalSchema.options[6].extend(twinEnvelopeFields),
]);
export const twinTurnSchema = z.strictObject({
  id: z.uuid(), workspaceId: idSchema.nullable(), role: z.enum(["user", "assistant"]),
  content: instructionTextSchema, proposalId: z.uuid().nullable(), createdAt: dateSchema,
});
export const twinEventSchema = z.strictObject({
  id: z.uuid(), workspaceId: idSchema.nullable(), proposalId: z.uuid().nullable(),
  kind: z.enum(["proposal", "accept", "dismiss", "error", "evolution"]), actorId: idSchema,
  detail: z.string().max(2000), createdAt: dateSchema,
});
export const twinConversationSchema = z.strictObject({
  workspaceId: idSchema.nullable(),
  revision: z.number().int().nonnegative(),
  turns: z.array(twinTurnSchema).max(500),
  proposals: z.array(twinDraftSchema).max(250),
  events: z.array(twinEventSchema).max(500),
});
export const twinApplyRequestSchema = conciergeBindingSchema.extend({
  id: z.uuid(),
  proposalHash: z.string().regex(/^[a-f0-9]{64}$/),
  editedDraft: z.record(z.string(), z.unknown()).optional(),
});
export const twinDismissRequestSchema = twinApplyRequestSchema.omit({ editedDraft: true }).extend({
  reason: z.string().trim().max(2000).default("Dismissed by the owner."),
});
export const twinApplyResultSchema = z.strictObject({
  id: z.uuid(), workspaceId: idSchema.nullable(),
  kind: z.enum(["workspace", "task", "agent", "automation", "settings"]),
  status: z.literal("applied"), result: z.record(z.string(), z.unknown()), createdAt: dateSchema,
});
export const workspaceOpenSchema = z.strictObject({
  workspace: workspaceSummarySchema,
  snapshot: snapshotSchema,
  twin: twinConversationSchema,
  routines: z.array(automationSchema).max(1000),
  computer: computerSchema,
  breadcrumb: workspaceBreadcrumbSchema,
});
export type WorkspaceInput = z.infer<typeof workspaceInputSchema>;
export type WorkspaceDetails = z.infer<typeof workspaceDetailsSchema>;
export type WorkspaceSummary = z.infer<typeof workspaceSummarySchema>;
export type WorkspaceList = z.infer<typeof workspaceListSchema>;
export type WorkspaceOpen = z.infer<typeof workspaceOpenSchema>;
export type WorkspaceOrganization = z.infer<typeof workspaceOrganizationSchema>;
export type WorkspaceChildren = z.infer<typeof workspaceChildrenSchema>;
export type WorkspaceTree = z.infer<typeof workspaceTreeSchema>;
export type WorkspaceBreadcrumb = z.infer<typeof workspaceBreadcrumbSchema>;
export type TwinMessageRequest = z.infer<typeof twinMessageRequestSchema>;
export type TwinProposal = z.infer<typeof twinProposalSchema>;
export type TwinDraft = z.infer<typeof twinDraftSchema>;
export type TwinBasis = z.infer<typeof twinBasisSchema>;
export type TwinTurn = z.infer<typeof twinTurnSchema>;
export type TwinEvent = z.infer<typeof twinEventSchema>;
export type TwinConversation = z.infer<typeof twinConversationSchema>;
export type TwinApplyRequest = z.infer<typeof twinApplyRequestSchema>;
export type TwinApplyResult = z.infer<typeof twinApplyResultSchema>;
export type TwinDismissRequest = z.infer<typeof twinDismissRequestSchema>;

const bound = <T extends z.ZodObject>(schema: T) => z.strictObject({
  ...schema.shape, ...workspaceBindingSchema.shape,
} as T["shape"] & typeof workspaceBindingSchema.shape);
export const rpcParameterSchemas = {
  "system.status": emptySchema,
  "workspaces.list": emptySchema,
  "workspaces.create": workspaceInputSchema,
  "workspaces.open": workspaceBindingSchema,
  "workspaces.update": bound(workspaceDetailsSchema),
  "workspaces.children": workspaceBindingSchema,
  "workspaces.tree": conciergeBindingSchema,
  "workspaces.breadcrumb": workspaceBindingSchema,
  "work.snapshot": workspaceBindingSchema,
  "work.createTask": bound(taskInputSchema),
  "work.assignTask": bound(z.strictObject({ id: idSchema, agentId: idSchema })),
  "agents.save": bound(agentInputSchema.extend({ parentRevision: z.number().int().nonnegative().optional() })),
  "agents.openWorkspace": bound(entityParamsSchema),
  "agents.retire": bound(entityParamsSchema.extend({ parentRevision: z.number().int().nonnegative().optional() })),
  "runs.start": bound(entityParamsSchema), "runs.cancel": bound(entityParamsSchema),
  "approvals.decide": bound(approvalDecisionSchema), "artifacts.read": bound(entityParamsSchema),
  "automations.save": bound(automationInputSchema), "settings.update": bound(settingsSchema),
  "providers.list": conciergeBindingSchema, "providers.configure": bound(providerConfigSchema),
  "computer.inspect": conciergeBindingSchema, "computer.start": workspaceBindingSchema, "computer.stop": workspaceBindingSchema,
  "diagnostics.get": conciergeBindingSchema,
  "events.read": bound(eventReadSchema), "events.subscribe": bound(eventReadSchema),
  "events.unsubscribe": bound(z.strictObject({ subscriptionId: z.uuid() })),
  "twin.message": twinMessageRequestSchema, "twin.conversation": conciergeBindingSchema,
  "twin.applyProposal": twinApplyRequestSchema, "twin.dismissProposal": twinDismissRequestSchema,
} as const;
