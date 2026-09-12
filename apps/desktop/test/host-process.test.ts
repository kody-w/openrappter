import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HostProcess, type HostLease, type OwnedChild } from "../src/host-process.js";

class Child extends EventEmitter implements OwnedChild {
  pid = 321;
  messages: unknown[] = [];
  killed = false;
  postMessage(message: unknown) { this.messages.push(message); }
  kill() { this.killed = true; this.emit("exit", 0); }
}
function setup(probe = async (_lease: HostLease) => true, timeout = 1000) {
  const child = new Child();
  const ports = {
    spawn: vi.fn(() => child), probe: vi.fn(probe),
    forceKill: vi.fn((target: OwnedChild) => { target.kill(); }), stateChanged: vi.fn(),
  };
  const host = new HostProcess(ports, "apps/desktop/.test-scratch/workspaces", timeout);
  return { child, ports, host };
}
const ready = () => ({ type: "ready", protocolVersion: 1, port: 43210, instanceId: randomUUID() });
afterEach(() => vi.useRealTimers());
describe("owned host lifecycle", () => {
  it("coalesces starts and passes a fresh secret only through the private bootstrap message", async () => {
    const { host, child, ports } = setup();
    const first = host.start(), second = host.start();
    expect(first).toBe(second);
    expect(ports.spawn).toHaveBeenCalledTimes(1);
    const bootstrap = child.messages[0] as Record<string, unknown>;
    expect(bootstrap).toMatchObject({ type: "bootstrap", protocolVersion: 1 });
    expect(String(bootstrap.token)).toMatch(/^[a-zA-Z0-9_-]{64}$/);
    child.emit("message", ready());
    const lease = await first;
    expect(ports.probe).toHaveBeenCalledWith(lease);
    expect(JSON.stringify(host.state)).not.toContain(lease.token);
    const stop = host.stop(); child.emit("exit", 0); await stop;
  });
  it("rejects unverified hosts and terminates the exact owned process", async () => {
    const { host, child, ports } = setup(async () => false);
    const start = host.start();
    const rejected = expect(start).rejects.toThrow("could not be authenticated");
    child.emit("message", ready());
    await rejected;
    expect(ports.forceKill).toHaveBeenCalledWith(child);
    expect(host.state.state).toBe("offline");
  });
  it("rejects mismatched protocols and never adopts an arbitrary server endpoint", async () => {
    const { host, child, ports } = setup();
    const start = host.start();
    const rejected = expect(start).rejects.toThrow();
    child.emit("message", { ...ready(), protocolVersion: 2 });
    await rejected;
    expect(ports.probe).not.toHaveBeenCalled();
    expect(child.killed).toBe(true);
  });
  it("bounds startup and forcibly cleans up a child that does not become ready", async () => {
    vi.useFakeTimers();
    const { host, child } = setup(async () => true, 50);
    const start = host.start();
    const rejected = expect(start).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(60);
    await rejected; expect(child.killed).toBe(true);
  });
  it("shuts down once, waits for the owned child, and refuses restart during quit", async () => {
    const { host, child } = setup();
    const start = host.start(); child.emit("message", ready()); await start;
    const stop = host.stop();
    expect(host.stop()).toBe(stop);
    expect(child.messages.at(-1)).toEqual({ type: "shutdown" });
    child.emit("exit", 0); await stop;
    await expect(host.start()).rejects.toThrow("shutting down");
  });
  it("forces termination if graceful shutdown stalls", async () => {
    vi.useFakeTimers();
    const { host, child, ports } = setup();
    const start = host.start(); child.emit("message", ready()); await start;
    const stop = host.stop();
    await vi.advanceTimersByTimeAsync(3001); await stop;
    expect(ports.forceKill).toHaveBeenCalledWith(child);
  });
  it("kills a booting child when the application quits", async () => {
    const { host, child } = setup();
    const start = host.start();
    const rejected = expect(start).rejects.toThrow();
    await host.stop(); await rejected;
    expect(child.killed).toBe(true);
  });
  it("invalidates the lease after unexpected child exit", async () => {
    const { host, child } = setup();
    const start = host.start(); child.emit("message", ready()); await start;
    child.emit("exit", 1);
    expect(host.state.state).toBe("offline");
    expect(host.state.detail).toContain("Refresh to restart");
  });
});
