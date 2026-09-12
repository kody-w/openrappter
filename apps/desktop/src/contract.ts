import { z } from "zod";
import { MAX_RPC_BYTES, rpcParameterSchemas } from "../../host/src/contracts.js";

export const APP_URL = "rapp-work://app/index.html";
export const IPC = { request: "work:request", state: "work:state", event: "work:event" } as const;
const id = z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/);
const area = z.enum(["work", "agents", "automations", "settings"]);
export const parameterSchemas = rpcParameterSchemas;
export type Method = keyof typeof parameterSchemas;
const requestEnvelope = z.strictObject({
  method: z.string().refine((method) => Object.hasOwn(parameterSchemas, method)),
  params: z.unknown(),
});
export function parseRequest(raw: unknown): { method: Method; params: unknown } {
  const request = requestEnvelope.parse(raw);
  const method = request.method as Method;
  const params = parameterSchemas[method].parse(request.params);
  if (new TextEncoder().encode(JSON.stringify(params)).byteLength > MAX_RPC_BYTES) throw new Error("Request is too large.");
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
