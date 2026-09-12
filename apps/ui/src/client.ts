import { z } from "zod";
import { eventSchema, rpcContracts, type EventScope, type RpcInput, type RpcMethod, type RpcResult } from "./model";

export const hostStateSchema = z.strictObject({
  state: z.enum(["starting", "online", "offline"]), detail: z.string().max(512),
});
const bridgeEventSchema = z.discriminatedUnion("type", [
  hostStateSchema.extend({ type: z.literal("host") }),
  z.strictObject({
    type: z.literal("events"), subscriptionId: z.uuid(),
    events: z.array(eventSchema).max(200), cursor: z.string().max(2048),
  }),
]);
export type HostState = z.infer<typeof hostStateSchema>;
export interface DesktopBridge {
  request(input: { method: string; params: unknown }): Promise<unknown>;
  onEvent(callback: (event: unknown) => void): () => void;
  hostState(): Promise<unknown>;
}
export interface WorkClient {
  call<M extends RpcMethod>(method: M, params: RpcInput<M>): Promise<RpcResult<M>>;
  subscribe(scope: EventScope, changed: () => void): Promise<() => void>;
  onConnection(changed: (state: HostState) => void): () => void;
}
export class BridgeClient implements WorkClient {
  constructor(private readonly bridge: DesktopBridge) {}
  async call<M extends RpcMethod>(method: M, params: RpcInput<M>): Promise<RpcResult<M>> {
    const contract = rpcContracts[method];
    const input = contract.input.safeParse(params);
    if (!input.success) throw new Error("Please check the form fields and try again.");
    const raw = await this.bridge.request({ method, params: input.data });
    const output = contract.output.safeParse(raw);
    if (!output.success) throw new Error("The host returned an invalid response. Refresh diagnostics before continuing.");
    return output.data as RpcResult<M>;
  }
  async subscribe(scope: EventScope, changed: () => void): Promise<() => void> {
    let subscriptionId: string | undefined;
    const queued = new Set<string>();
    const remove = this.bridge.onEvent((raw) => {
      const parsed = bridgeEventSchema.safeParse(raw);
      if (!parsed.success || parsed.data.type !== "events") return;
      if (!subscriptionId) queued.add(parsed.data.subscriptionId);
      else if (parsed.data.subscriptionId === subscriptionId) changed();
    });
    try {
      const subscription = await this.call("events.subscribe", { scope, limit: 200 });
      subscriptionId = subscription.subscriptionId;
      if (subscription.events.length || queued.has(subscriptionId)) changed();
      return () => {
        remove();
        void this.call("events.unsubscribe", { subscriptionId: subscription.subscriptionId }).catch(() => {});
      };
    } catch (error) { remove(); throw error; }
  }
  onConnection(changed: (state: HostState) => void): () => void {
    let active = true;
    const remove = this.bridge.onEvent((raw) => {
      const event = bridgeEventSchema.safeParse(raw);
      if (event.success && event.data.type === "host") changed({ state: event.data.state, detail: event.data.detail });
    });
    void this.bridge.hostState().then((raw) => {
      if (active) changed(hostStateSchema.parse(raw));
    }).catch(() => { if (active) changed({ state: "offline", detail: "The desktop host is unavailable." }); });
    return () => { active = false; remove(); };
  }
}
export class DisconnectedClient implements WorkClient {
  async call<M extends RpcMethod>(_method: M, _params: RpcInput<M>): Promise<RpcResult<M>> {
    throw new Error("Open this workspace in RAPP Work desktop to connect to its local host.");
  }
  async subscribe(): Promise<() => void> { return () => {}; }
  onConnection(changed: (state: HostState) => void) {
    changed({ state: "offline", detail: "Desktop host not connected." });
    return () => {};
  }
}
declare global { interface Window { rappWork?: DesktopBridge } }
