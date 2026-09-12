import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import { HostRpc } from "../src/rpc.js";
import type { BridgeEvent, HostState } from "../src/contract.js";

let server: WebSocketServer;
let port: number;
let client: HostRpc;
let events: BridgeEvent[];
let states: HostState[];
let socket: WebSocket | undefined;
beforeEach(async () => {
  server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected loopback port.");
  port = address.port;
  events = []; states = [];
  client = new HostRpc((event) => events.push(event), (state) => states.push(state), 100);
  server.on("connection", (connected) => { socket = connected; });
});
afterEach(async () => {
  client.close();
  for (const socket of server.clients) socket.terminate();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
describe("main-process JSON-RPC transport", () => {
  it("keeps the token in upgrade headers and correlates responses", async () => {
    let authorization: string | undefined;
    let url: string | undefined;
    server.on("connection", (socket, request) => {
      authorization = request.headers.authorization; url = request.url;
      socket.on("message", (raw) => {
        const request = JSON.parse(raw.toString());
        socket.send(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { accepted: request.method } }));
      });
    });
    await client.connect({ port, instanceId: randomUUID(), token: "test-token" });
    expect(await client.request({ method: "system.status", params: {} })).toEqual({ accepted: "system.status" });
    expect(authorization).toBe("Bearer test-token"); expect(url).toBe("/rpc");
    expect(JSON.stringify(states)).not.toContain("test-token");
  });
  it("forwards only validated scoped event notifications", async () => {
    await client.connect({ port, instanceId: randomUUID(), token: "test-token" });
    socket!.send(JSON.stringify({ jsonrpc: "2.0", method: "events.changed", params: { subscriptionId: randomUUID(), events: [], cursor: "opaque" } }));
    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(events[0]?.type).toBe("events");
  });
  it("rejects forbidden renderer requests before transport and bounds unanswered calls", async () => {
    await client.connect({ port, instanceId: randomUUID(), token: "test-token" });
    expect(() => client.request({ method: "shell.execute", params: {} })).toThrow();
    await expect(client.request({ method: "work.snapshot", params: {} })).rejects.toThrow("did not respond in time");
  });
  it("fails pending requests on disconnect rather than leaving them unresolved", async () => {
    await client.connect({ port, instanceId: randomUUID(), token: "test-token" });
    const request = client.request({ method: "work.snapshot", params: {} });
    const rejected = expect(request).rejects.toThrow("disconnected");
    socket!.terminate();
    await rejected;
    expect(states.at(-1)?.state).toBe("offline");
  });
});
