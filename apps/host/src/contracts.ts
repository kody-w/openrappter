import { z } from "zod";

export const idSchema = z.string().min(1).max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/);
export const textSchema = z.string().trim().min(1).max(160);
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
  instructions: z.string().trim().max(16000),
  providerId: idSchema.nullable(),
  model: z.string().max(160),
  computerPolicy: z.enum(["none", "read-only", "control"]),
  approvalPolicy: z.enum(["always", "on-risk"]),
  enabled: z.boolean(),
});
export const agentSchema = agentInputSchema.extend({ workspaceId: idSchema, updatedAt: dateSchema });
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
});
export const computerSchema = z.strictObject({
  state: z.enum(["unavailable", "stopped", "starting", "running", "error"]),
  detail: z.string().max(2000),
  verified: z.boolean(),
  verifiedAt: dateSchema.nullable(),
  evidenceIds: z.array(idSchema).max(200),
  capabilities: z.strictObject({ view: z.boolean(), control: z.boolean() }),
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
