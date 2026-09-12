import { z } from "zod";

const id = z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/);
const title = z.string().trim().min(1).max(160);
const date = z.iso.datetime();
export const areaSchema = z.enum(["work", "agents", "automations", "settings"]);
export const settingsSchema = z.strictObject({
  workspaceName: title,
  appearance: z.strictObject({ theme: z.enum(["system", "light", "dark"]), density: z.enum(["comfortable", "compact"]) }),
  work: z.strictObject({ defaultPriority: z.enum(["normal", "high"]), approvalPolicy: z.enum(["always", "on-risk"]) }),
  notifications: z.strictObject({ approvals: z.boolean(), completedRuns: z.boolean() }),
});
export const agentInputSchema = z.strictObject({
  id, name: title, role: z.string().trim().max(240), instructions: z.string().trim().max(16000),
  providerId: id.nullable(), model: z.string().max(160),
  computerPolicy: z.enum(["none", "read-only", "control"]),
  approvalPolicy: z.enum(["always", "on-risk"]), enabled: z.boolean(),
});
export const agentSchema = agentInputSchema.extend({ updatedAt: date });
export const taskInputSchema = z.strictObject({
  requestId: z.uuid(), title, instructions: z.string().trim().min(1).max(16000),
  agentId: id.nullable(), priority: z.enum(["normal", "high"]),
});
export const taskSchema = taskInputSchema.omit({ requestId: true }).extend({
  id, state: z.enum(["queued", "running", "awaiting_approval", "completed", "failed", "cancelled"]),
  createdAt: date, updatedAt: date,
});
export const runSchema = z.strictObject({
  id, taskId: id, agentId: id,
  state: z.enum(["running", "awaiting_approval", "completed", "failed", "cancelled"]),
  startedAt: date, finishedAt: date.nullable(), summary: z.string().max(4000),
  verification: z.enum(["not_checked", "passed", "failed"]), evidenceIds: z.array(id).max(200),
}).refine((run) => run.verification !== "passed" || run.evidenceIds.length > 0);
export const approvalSchema = z.strictObject({
  id, runId: id, taskId: id, action: title, reason: z.string().max(4000),
  risk: z.enum(["low", "medium", "high"]), state: z.enum(["pending", "approved", "denied"]),
  createdAt: date, decidedAt: date.nullable(), decisionReason: z.string().max(2000),
});
export const artifactSchema = z.strictObject({
  id, taskId: id, runId: id, name: title,
  mediaType: z.enum(["text/plain", "text/markdown", "application/json"]),
  bytes: z.number().int().nonnegative().max(1_000_000), createdAt: date,
  evidence: z.boolean(), sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const timezone = z.string().min(1).max(100).refine((value) => {
  try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; } catch { return false; }
});
export const cadenceSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("daily"), at: time, timezone }),
  z.strictObject({ kind: z.literal("weekly"), at: time, timezone, weekday: z.number().int().min(0).max(6) }),
  z.strictObject({ kind: z.literal("interval"), minutes: z.number().int().min(15).max(10080) }),
]);
export const automationInputSchema = z.strictObject({
  id, name: title, taskTitle: title, instructions: z.string().trim().min(1).max(16000),
  agentId: id, cadence: cadenceSchema, enabled: z.boolean(),
});
export const automationSchema = automationInputSchema.extend({ updatedAt: date, nextRunAt: date.nullable() });
export const snapshotSchema = z.strictObject({
  workspaceId: id, revision: z.number().int().nonnegative(),
  agents: z.array(agentSchema).max(1000), tasks: z.array(taskSchema).max(10000),
  runs: z.array(runSchema).max(20000), approvals: z.array(approvalSchema).max(10000),
  artifacts: z.array(artifactSchema).max(20000), automations: z.array(automationSchema).max(1000),
  settings: settingsSchema,
});
export const providerSchema = z.strictObject({
  id, name: title, configured: z.boolean(),
  models: z.array(z.string().min(1).max(160)).max(500), detail: z.string().max(512),
});
export const computerSchema = z.strictObject({
  state: z.enum(["unavailable", "stopped", "starting", "running", "error"]), detail: z.string().max(2000),
  verified: z.boolean(), verifiedAt: date.nullable(), evidenceIds: z.array(id).max(200),
  capabilities: z.strictObject({ view: z.boolean(), control: z.boolean() }),
}).refine((computer) => !computer.verified ||
  (computer.state === "running" && computer.verifiedAt !== null && computer.evidenceIds.length > 0));
export const checkSchema = z.strictObject({
  state: z.enum(["ready", "degraded", "unavailable"]), detail: z.string().max(512),
});
export const serviceNames = ["storage", "security", "work", "runtime", "provider", "computer", "diagnostics"] as const;
export const statusSchema = z.strictObject({
  product: z.literal("RAPP Work"), protocolVersion: z.literal(1), ready: z.boolean(),
  checks: z.strictObject(Object.fromEntries(serviceNames.map((key) => [key, checkSchema])) as
    Record<(typeof serviceNames)[number], typeof checkSchema>),
});
export const diagnosticsSchema = z.strictObject({
  capturedAt: date,
  entries: z.array(z.strictObject({
    id, time: date, level: z.enum(["info", "warning", "error"]), area: areaSchema, message: z.string().max(1000),
  })).max(200),
});
export const scopeSchema = z.strictObject({ area: areaSchema, entityId: id.optional() });
export const eventSchema = z.strictObject({
  id, area: areaSchema, entityId: id, kind: z.enum(["created", "updated"]), at: date,
});
const pageSchema = z.strictObject({ events: z.array(eventSchema).max(200), cursor: z.string().max(2048) });
const eventReadSchema = z.strictObject({
  scope: scopeSchema, cursor: z.string().min(1).max(2048).optional(),
  limit: z.number().int().min(1).max(200).optional(),
});
const empty = z.strictObject({});
const entity = z.strictObject({ id });
export const rpcContracts = {
  "system.status": { input: empty, output: statusSchema },
  "work.snapshot": { input: empty, output: snapshotSchema },
  "work.createTask": { input: taskInputSchema, output: taskSchema },
  "work.assignTask": { input: z.strictObject({ id, agentId: id }), output: taskSchema },
  "agents.save": { input: agentInputSchema, output: agentSchema },
  "runs.start": { input: entity, output: runSchema },
  "runs.cancel": { input: entity, output: runSchema },
  "approvals.decide": {
    input: z.strictObject({ id, decision: z.enum(["approved", "denied"]), reason: z.string().trim().min(1).max(2000) }),
    output: approvalSchema,
  },
  "artifacts.read": { input: entity, output: z.strictObject({ artifact: artifactSchema, content: z.string().max(1_000_000) }) },
  "automations.save": { input: automationInputSchema, output: automationSchema },
  "settings.update": { input: settingsSchema, output: settingsSchema },
  "providers.list": { input: empty, output: z.array(providerSchema).max(100) },
  "providers.configure": {
    input: z.strictObject({ id, connectionRef: z.string().min(1).max(160).regex(/^[a-zA-Z0-9_./:-]+$/) }),
    output: providerSchema,
  },
  "computer.inspect": { input: empty, output: computerSchema },
  "computer.start": { input: empty, output: computerSchema },
  "computer.stop": { input: empty, output: computerSchema },
  "diagnostics.get": { input: empty, output: diagnosticsSchema },
  "events.read": { input: eventReadSchema, output: pageSchema },
  "events.subscribe": { input: eventReadSchema, output: pageSchema.extend({ subscriptionId: z.uuid() }) },
  "events.unsubscribe": { input: z.strictObject({ subscriptionId: z.uuid() }), output: z.strictObject({ removed: z.boolean() }) },
} as const;
export type RpcMethod = keyof typeof rpcContracts;
export type RpcInput<M extends RpcMethod> = z.input<(typeof rpcContracts)[M]["input"]>;
export type RpcResult<M extends RpcMethod> = z.output<(typeof rpcContracts)[M]["output"]>;
export type Area = z.infer<typeof areaSchema>;
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
export type Status = z.infer<typeof statusSchema>;
export type Provider = z.infer<typeof providerSchema>;
export type Computer = z.infer<typeof computerSchema>;
export type Diagnostics = z.infer<typeof diagnosticsSchema>;
export type EventScope = z.infer<typeof scopeSchema>;
