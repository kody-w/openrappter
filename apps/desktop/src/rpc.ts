import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { z } from "zod";
import { eventParamsSchema, parseRequest, type BridgeEvent, type HostState } from "./contract.js";
import type { HostLease } from "./host-process.js";

const responseSchema = z.union([
  z.strictObject({ jsonrpc: z.literal("2.0"), id: z.string(), result: z.unknown() }),
  z.strictObject({ jsonrpc: z.literal("2.0"), id: z.string().nullable(), error: z.strictObject({ code: z.number().int(), message: z.string().max(2000) }) }),
]);
const notificationSchema = z.strictObject({
  jsonrpc: z.literal("2.0"), method: z.literal("events.changed"), params: eventParamsSchema,
});
export class HostRpc {
  private socket?: WebSocket;
  private connecting?: Promise<void>;
  private leaseId?: string;
  private pending = new Map<string, { resolve: (result: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  constructor(
    private readonly event: (event: BridgeEvent) => void,
    private readonly connectionChanged: (state: HostState) => void,
    private readonly requestTimeout = 30000,
  ) {}
  connect(lease: HostLease): Promise<void> {
    if (this.socket?.readyState === WebSocket.OPEN && this.leaseId === lease.instanceId) return Promise.resolve();
    if (this.connecting && this.leaseId === lease.instanceId) return this.connecting;
    this.close();
    this.leaseId = lease.instanceId;
    const socket = new WebSocket(`ws://127.0.0.1:${lease.port}/rpc`, {
      headers: { Authorization: `Bearer ${lease.token}` }, perMessageDeflate: false,
      maxPayload: 34 * 1024 * 1024, handshakeTimeout: 10000,
    });
    this.socket = socket;
    const operation = new Promise<void>((resolve, reject) => {
      socket.on("open", () => {
        this.connectionChanged({ state: "online", detail: "Authenticated connection to the owned local host." });
        resolve();
      });
      socket.on("error", () => reject(new Error("The local host connection failed.")));
      socket.on("close", () => {
        if (this.socket !== socket) return;
        this.socket = undefined;
        this.rejectPending();
        this.connectionChanged({ state: "offline", detail: "The local host connection closed. Refresh to reconnect." });
        reject(new Error("The local host connection closed."));
      });
      socket.on("message", (data, binary) => {
        if (binary) { socket.close(1003); return; }
        let raw: unknown;
        try { raw = JSON.parse(data.toString()); } catch { socket.close(1002); return; }
        const notification = notificationSchema.safeParse(raw);
        if (notification.success) { this.event({ type: "events", ...notification.data.params }); return; }
        const response = responseSchema.safeParse(raw);
        if (!response.success) { socket.close(1002); return; }
        if (response.data.id === null) { socket.close(1002); return; }
        const pending = this.pending.get(response.data.id);
        if (!pending) return;
        clearTimeout(pending.timer); this.pending.delete(response.data.id);
        if ("error" in response.data) pending.reject(new Error(response.data.error.message));
        else pending.resolve(response.data.result);
      });
    });
    this.connecting = operation;
    void operation.finally(() => { if (this.connecting === operation) this.connecting = undefined; }).catch(() => {});
    return operation;
  }
  request(raw: unknown): Promise<unknown> {
    const request = parseRequest(raw);
    if (this.socket?.readyState !== WebSocket.OPEN) return Promise.reject(new Error("The owned local host is not connected."));
    if (this.pending.size >= 32) return Promise.reject(new Error("Too many pending workspace requests."));
    const socket = this.socket;
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("The host did not respond in time. Refresh before retrying a state-changing action."));
      }, this.requestTimeout);
      this.pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ jsonrpc: "2.0", id, ...request }), (error) => {
        if (!error) return;
        clearTimeout(timer); this.pending.delete(id); reject(new Error("The request could not be delivered."));
      });
    });
  }
  private rejectPending() {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error("The local host disconnected.")); }
    this.pending.clear();
  }
  close() {
    const socket = this.socket;
    this.socket = undefined;
    this.connecting = undefined;
    this.rejectPending();
    socket?.terminate();
  }
}
