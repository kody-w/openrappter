import { bridgeEventSchema, hostStateSchema, IPC, parseRequest, type BridgeEvent } from "./contract.js";

export interface RendererIpcPort {
  invoke(channel: string, argument?: unknown): Promise<unknown>;
  on(channel: string, listener: (event: unknown, value: unknown) => void): unknown;
  removeListener(channel: string, listener: (event: unknown, value: unknown) => void): unknown;
}
export function createBridge(ipc: RendererIpcPort) {
  return Object.freeze({
    request: (raw: unknown) => ipc.invoke(IPC.request, parseRequest(raw)),
    hostState: async () => hostStateSchema.parse(await ipc.invoke(IPC.state)),
    onEvent(callback: (event: BridgeEvent) => void) {
      if (typeof callback !== "function") throw new Error("An event listener is required.");
      const listener = (_event: unknown, raw: unknown) => {
        const result = bridgeEventSchema.safeParse(raw);
        if (result.success) callback(result.data);
      };
      ipc.on(IPC.event, listener);
      return () => { ipc.removeListener(IPC.event, listener); };
    },
  });
}
