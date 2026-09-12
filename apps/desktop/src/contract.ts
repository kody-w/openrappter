import { z } from "zod";

export const APP_URL = "rapp-work://app/index.html";
export const IPC = { request: "work:request", state: "work:state", event: "work:event" } as const;
const id = z.string().min(1).max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/);
const title = z.string().trim().min(1).max(160);
const empty = z.strictObject({});
const binding = z.strictObject({ workspaceId: id });
const concierge = z.strictObject({ workspaceId: id.nullable() });
const entity = binding.extend({ id });
const area = z.enum(["work", "agents", "automations", "settings"]);
const scope = z.strictObject({ area, entityId: id.optional() });
const eventRead = binding.extend({
  scope, cursor: z.string().min(1).max(2048).optional(), limit: z.number().int().min(1).max(200).default(100),
});
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const timezone = z.string().min(1).max(100).refine((value) => {
  try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; } catch { return false; }
});
const task = z.strictObject({
  requestId: z.uuid(), title, instructions: z.string().trim().min(1).max(16000),
  agentId: id.nullable(), priority: z.enum(["normal", "high"]),
});
const agent = z.strictObject({
  id, name: title, role: z.string().trim().max(240), instructions: z.string().trim().max(16000),
  providerId: id.nullable(), model: z.string().max(160), computerPolicy: z.enum(["none", "read-only", "control"]),
  approvalPolicy: z.enum(["always", "on-risk"]), enabled: z.boolean(),
});
const automation = z.strictObject({
  id, name: title, taskTitle: title, instructions: z.string().trim().min(1).max(16000), agentId: id,
  cadence: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("daily"), at: time, timezone }),
    z.strictObject({ kind: z.literal("weekly"), at: time, timezone, weekday: z.number().int().min(0).max(6) }),
    z.strictObject({ kind: z.literal("interval"), minutes: z.number().int().min(15).max(10080) }),
  ]), enabled: z.boolean(),
});
const settings = z.strictObject({
  workspaceName: title,
  appearance: z.strictObject({ theme: z.enum(["system", "light", "dark"]), density: z.enum(["comfortable", "compact"]) }),
  work: z.strictObject({ defaultPriority: z.enum(["normal", "high"]), approvalPolicy: z.enum(["always", "on-risk"]) }),
  notifications: z.strictObject({ approvals: z.boolean(), completedRuns: z.boolean() }),
});
const workspaceDetails = z.strictObject({
  name: title, purpose: z.string().trim().min(1).max(4000),
  twin: z.strictObject({ name: title, instructions: z.string().trim().min(1).max(16000) }),
  approvalPolicy: z.enum(["always", "on-risk"]), computerPolicy: z.enum(["none", "read-only", "control"]),
});
const workspace = workspaceDetails.extend({
  requestId: z.uuid(), leadAgent: agent.extend({
    role: z.string().trim().min(1).max(240), instructions: z.string().trim().min(1).max(16000),
  }),
  starterTask: task.nullable(), starterRoutines: z.array(automation).max(8),
}).superRefine((input, context) => {
  if (input.starterTask && input.starterTask.agentId !== input.leadAgent.id)
    context.addIssue({ code: "custom", path: ["starterTask"], message: "Starter work belongs to the lead agent." });
  if (new Set(input.starterRoutines.map((item) => item.id)).size !== input.starterRoutines.length)
    context.addIssue({ code: "custom", path: ["starterRoutines"], message: "Routine identities must be unique." });
  for (const routine of input.starterRoutines) if (routine.agentId !== input.leadAgent.id || routine.enabled && !input.leadAgent.enabled)
    context.addIssue({ code: "custom", path: ["starterRoutines"], message: "Routines must belong to the available lead agent." });
  const rank = { none: 0, "read-only": 1, control: 2 };
  if (rank[input.leadAgent.computerPolicy] > rank[input.computerPolicy]
    || input.approvalPolicy === "always" && input.leadAgent.approvalPolicy !== "always")
    context.addIssue({ code: "custom", path: ["leadAgent"], message: "Agent permissions cannot exceed the workspace policy." });
});
const twinMessage = concierge.extend({
  message: z.string().trim().min(1).max(8000),
  target: z.enum(["auto", "workspace", "task", "agent", "automation", "settings", "approval"]).optional(),
  history: z.array(z.strictObject({
    role: z.enum(["user", "assistant"]), content: z.string().trim().min(1).max(8000),
  })).max(24),
  contextRevision: z.number().int().nonnegative().optional(),
}).refine((input) => new TextEncoder().encode(JSON.stringify(input)).byteLength <= 48 * 1024,
  "The conversation request exceeds its byte bound.");
const proposal = concierge.extend({ id: z.uuid(), proposalHash: z.string().regex(/^[a-f0-9]{64}$/) });
export const parameterSchemas = {
  "system.status": empty,
  "workspaces.list": empty,
  "workspaces.open": binding,
  "workspaces.create": workspace,
  "workspaces.update": workspaceDetails.extend({ workspaceId: id }),
  "twin.message": twinMessage,
  "twin.conversation": concierge,
  "twin.applyProposal": proposal.extend({ editedDraft: z.record(z.string(), z.unknown()).optional() }),
  "twin.dismissProposal": proposal.extend({ reason: z.string().trim().max(2000).default("Dismissed by the owner.") }),
  "work.snapshot": binding,
  "work.createTask": task.extend({ workspaceId: id }),
  "work.assignTask": entity.extend({ agentId: id }),
  "agents.save": agent.extend({ workspaceId: id }),
  "runs.start": entity,
  "runs.cancel": entity,
  "approvals.decide": entity.extend({
    decision: z.enum(["approved", "denied"]), reason: z.string().trim().min(1).max(2000),
  }),
  "artifacts.read": entity,
  "automations.save": automation.extend({ workspaceId: id }),
  "settings.update": settings.extend({ workspaceId: id }),
  "providers.list": concierge,
  "providers.configure": binding.extend({
    id, connectionRef: z.string().min(1).max(160).regex(/^[a-zA-Z0-9_./:-]+$/),
  }),
  "computer.inspect": concierge,
  "computer.start": binding,
  "computer.stop": binding,
  "diagnostics.get": concierge,
  "events.read": eventRead,
  "events.subscribe": eventRead,
  "events.unsubscribe": binding.extend({ subscriptionId: z.uuid() }),
} as const;
export type Method = keyof typeof parameterSchemas;
const requestEnvelope = z.strictObject({
  method: z.string().refine((method) => Object.hasOwn(parameterSchemas, method)),
  params: z.unknown(),
});
export function parseRequest(raw: unknown): { method: Method; params: unknown } {
  const request = requestEnvelope.parse(raw);
  const method = request.method as Method;
  const params = parameterSchemas[method].parse(request.params);
  if (new TextEncoder().encode(JSON.stringify(params)).byteLength > 64000) throw new Error("Request is too large.");
  return { method, params };
}
export const hostStateSchema = z.strictObject({
  state: z.enum(["starting", "online", "offline"]), detail: z.string().max(512),
});
export type HostState = z.infer<typeof hostStateSchema>;
export const eventParamsSchema = z.strictObject({
  subscriptionId: z.uuid(),
  events: z.array(z.strictObject({
    id, area, entityId: id, kind: z.enum(["created", "updated"]), at: z.iso.datetime(),
  })).max(200),
  cursor: z.string().max(2048),
});
export const bridgeEventSchema = z.discriminatedUnion("type", [
  hostStateSchema.extend({ type: z.literal("host") }),
  eventParamsSchema.extend({ type: z.literal("events") }),
]);
export type BridgeEvent = z.infer<typeof bridgeEventSchema>;
export function isAppDocument(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "rapp-work:" && parsed.hostname === "app" && parsed.port === "" &&
      !parsed.username && !parsed.password && parsed.pathname === "/index.html";
  } catch { return false; }
}
export function trustedSender(
  event: { sender: unknown; senderFrame: unknown },
  contents: { mainFrame: { url: string } },
): boolean {
  return event.sender === contents && event.senderFrame === contents.mainFrame && isAppDocument(contents.mainFrame.url);
}
export function supportedPlatform(platform: string, architecture: string) {
  if (platform !== "darwin" || architecture !== "arm64") throw new Error("RAPP Work desktop requires macOS on Apple silicon.");
}
export function windowOptions(preload: string) {
  return {
    width: 1440, height: 920, minWidth: 840, minHeight: 640, show: false,
    title: "RAPP Work", titleBarStyle: "default" as const,
    webPreferences: {
      preload, nodeIntegration: false, contextIsolation: true, sandbox: true,
      webSecurity: true, allowRunningInsecureContent: false, webviewTag: false, devTools: false,
    },
  };
}
