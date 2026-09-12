import { z } from "zod";

export const APP_URL = "rapp-work://app/index.html";
export const IPC = { request: "work:request", state: "work:state", event: "work:event" } as const;
const id = z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/);
const title = z.string().trim().min(1).max(160);
const empty = z.strictObject({});
const entity = z.strictObject({ id });
const area = z.enum(["work", "agents", "automations", "settings"]);
const scope = z.strictObject({ area, entityId: id.optional() });
const eventRead = z.strictObject({
  scope, cursor: z.string().min(1).max(2048).optional(), limit: z.number().int().min(1).max(200).optional(),
});
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const timezone = z.string().min(1).max(100).refine((value) => {
  try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; } catch { return false; }
});
export const parameterSchemas = {
  "system.status": empty,
  "work.snapshot": empty,
  "work.createTask": z.strictObject({
    requestId: z.uuid(), title, instructions: z.string().trim().min(1).max(16000),
    agentId: id.nullable(), priority: z.enum(["normal", "high"]),
  }),
  "work.assignTask": z.strictObject({ id, agentId: id }),
  "agents.save": z.strictObject({
    id, name: title, role: z.string().trim().max(240), instructions: z.string().trim().max(16000),
    providerId: id.nullable(), model: z.string().max(160), computerPolicy: z.enum(["none", "read-only", "control"]),
    approvalPolicy: z.enum(["always", "on-risk"]), enabled: z.boolean(),
  }),
  "runs.start": entity,
  "runs.cancel": entity,
  "approvals.decide": z.strictObject({
    id, decision: z.enum(["approved", "denied"]), reason: z.string().trim().min(1).max(2000),
  }),
  "artifacts.read": entity,
  "automations.save": z.strictObject({
    id, name: title, taskTitle: title, instructions: z.string().trim().min(1).max(16000), agentId: id,
    cadence: z.discriminatedUnion("kind", [
      z.strictObject({ kind: z.literal("daily"), at: time, timezone }),
      z.strictObject({ kind: z.literal("weekly"), at: time, timezone, weekday: z.number().int().min(0).max(6) }),
      z.strictObject({ kind: z.literal("interval"), minutes: z.number().int().min(15).max(10080) }),
    ]), enabled: z.boolean(),
  }),
  "settings.update": z.strictObject({
    workspaceName: title,
    appearance: z.strictObject({ theme: z.enum(["system", "light", "dark"]), density: z.enum(["comfortable", "compact"]) }),
    work: z.strictObject({ defaultPriority: z.enum(["normal", "high"]), approvalPolicy: z.enum(["always", "on-risk"]) }),
    notifications: z.strictObject({ approvals: z.boolean(), completedRuns: z.boolean() }),
  }),
  "providers.list": empty,
  "providers.configure": z.strictObject({
    id, connectionRef: z.string().min(1).max(160).regex(/^[a-zA-Z0-9_./:-]+$/),
  }),
  "computer.inspect": empty,
  "computer.start": empty,
  "computer.stop": empty,
  "diagnostics.get": empty,
  "events.read": eventRead,
  "events.subscribe": eventRead,
  "events.unsubscribe": z.strictObject({ subscriptionId: z.uuid() }),
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
  if (JSON.stringify(params).length > 64000) throw new Error("Request is too large.");
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
    width: 1360, height: 900, minWidth: 840, minHeight: 640, show: false,
    title: "RAPP Work", titleBarStyle: "default" as const,
    webPreferences: {
      preload, nodeIntegration: false, contextIsolation: true, sandbox: true,
      webSecurity: true, allowRunningInsecureContent: false, webviewTag: false, devTools: false,
    },
  };
}
