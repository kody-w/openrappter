import { describe, expect, it, vi } from "vitest";
import { BridgeClient, type DesktopBridge } from "../src/client";
import { testWorkspace } from "./fixture";

describe("typed desktop client boundary", () => {
  function setup(result: unknown) {
    const listeners = new Set<(event: unknown) => void>();
    const bridge: DesktopBridge = {
      request: vi.fn(async () => result),
      async hostState() { return { state: "online", detail: "Injected host." }; },
      onEvent(callback) { listeners.add(callback); return () => { listeners.delete(callback); }; },
    };
    return { bridge, listeners, client: new BridgeClient(bridge) };
  }
  it("validates responses before rendering and rejects unsupported verification claims", async () => {
    const { client } = setup({ state: "running", verified: true, evidenceIds: [] });
    await expect(client.call("computer.inspect", {})).rejects.toThrow("invalid response");
  });
  it("rejects extra settings and request fields before IPC", async () => {
    const { client, bridge } = setup({});
    await expect(client.call("settings.update", {
      ...testWorkspace().settings, appearance: { theme: "dark", density: "comfortable", secret: "not allowed" },
    } as never)).rejects.toThrow("form fields");
    expect(bridge.request).not.toHaveBeenCalled();
  });
  it("unsubscribes listeners and ignores malformed desktop events", async () => {
    const subscriptionId = crypto.randomUUID();
    const { client, listeners, bridge } = setup({ events: [], cursor: "opaque", subscriptionId });
    const changed = vi.fn();
    const remove = await client.subscribe({ area: "work" }, changed);
    listeners.forEach((listener) => listener({ type: "events", subscriptionId, arbitrary: true }));
    expect(changed).not.toHaveBeenCalled();
    listeners.forEach((listener) => listener({ type: "events", subscriptionId, events: [], cursor: "opaque" }));
    expect(changed).toHaveBeenCalledTimes(1);
    remove(); expect(listeners.size).toBe(0);
    expect(bridge.request).toHaveBeenLastCalledWith({ method: "events.unsubscribe", params: { subscriptionId } });
  });
  it("cleans listeners when subscription setup fails", async () => {
    const { client, listeners } = setup({});
    await expect(client.subscribe({ area: "work" }, () => {})).rejects.toThrow();
    expect(listeners.size).toBe(0);
  });
});
