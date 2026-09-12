import { createHash, randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { createHost, type RunningHost } from "../src/server.js";
import type { HostServices } from "../src/ports.js";
import { agent, fixture, owner, token } from "./fixture.js";

let services: HostServices;
let host: RunningHost;
let clients: WebSocket[];
const auth = { Authorization: `Bearer ${token}` };
beforeEach(async () => {
  clients = [];
  services = fixture();
  host = await createHost(services, { allowedOrigins: ["http://127.0.0.1:5173"] });
});
afterEach(async () => {
  for (const client of clients) client.terminate();
  await host.close();
});
async function http(path = "/rpc", options: RequestInit = {}) {
  return fetch(`http://127.0.0.1:${host.port}${path}`, options);
}
async function rpc(method: string, params: unknown = {}, extra: Record<string, unknown> = {}) {
  const response = await http("/rpc", {
    method: "POST", headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "request", method, params, ...extra }),
  });
  return response.json();
}
async function connect(headers: Record<string, string> = auth) {
  const client = new WebSocket(`ws://127.0.0.1:${host.port}/rpc`, { headers });
  clients.push(client);
  await new Promise<void>((resolve, reject) => { client.once("open", resolve); client.once("error", reject); });
  return client;
}
function nextMessage(client: WebSocket) {
  return new Promise<Record<string, any>>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("No WebSocket response.")), 2000);
    client.once("message", (raw) => { clearTimeout(timer); resolve(JSON.parse(raw.toString())); });
  });
}
async function wsRpc(client: WebSocket, method: string, params: unknown = {}) {
  const next = nextMessage(client);
  client.send(JSON.stringify({ jsonrpc: "2.0", id: randomUUID(), method, params }));
  return next;
}
describe("authenticated loopback HTTP transport", () => {
  it("requires every structural composition port at runtime", async () => {
    await expect(createHost({ ...services, computer: undefined } as unknown as HostServices))
      .rejects.toThrow("Required composition port");
  });
  it("binds an ephemeral IPv4 loopback port and requires authentication for health", async () => {
    expect((await http("/healthz")).status).toBe(401);
    const health = await http("/healthz", { headers: auth });
    expect(await health.json()).toEqual({ product: "RAPP Work", protocolVersion: 1, alive: true });
  });
  it("only reports readiness supplied by all injected services", async () => {
    expect((await http("/readyz", { headers: auth })).status).toBe(200);
    services.computer.check = async () => ({ state: "unavailable", detail: "No computer connected." });
    const response = await http("/readyz", { headers: auth });
    expect(response.status).toBe(503);
    expect((await response.json()).checks.computer.state).toBe("unavailable");
  });
  it("fails closed and sanitizes throwing service checks", async () => {
    services.provider.check = async () => { throw new Error("SECRET credential"); };
    const response = await rpc("system.status");
    expect(response.result.ready).toBe(false);
    expect(JSON.stringify(response)).not.toContain("SECRET");
  });
  it("rejects remote origins, opaque origins, and DNS rebinding host headers", async () => {
    for (const Origin of ["https://attacker.invalid", "null"]) {
      expect((await http("/rpc", { headers: { ...auth, Origin } })).status).toBe(403);
    }
    const status = await new Promise<number>((resolve, reject) => {
      const request = httpRequest({
        host: "127.0.0.1", port: host.port, path: "/healthz",
        headers: { ...auth, Host: "attacker.invalid" },
      }, (response) => { response.resume(); resolve(response.statusCode!); });
      request.on("error", reject); request.end();
    });
    expect(status).toBe(403);
  });
  it("supports only explicit origin preflight and never wildcard CORS", async () => {
    const response = await http("/rpc", { method: "OPTIONS", headers: { Origin: "http://127.0.0.1:5173" } });
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("http://127.0.0.1:5173");
    expect((await http("/rpc", { method: "OPTIONS" })).status).toBe(401);
  });
  it("does not accept credentials in paths, cookies, or old routes", async () => {
    for (const path of ["/rpc?token=secret", "/api/status", "/ws", "/health", "/api/agents"]) {
      expect((await http(path, { headers: auth })).status).toBe(404);
    }
    expect((await http("/healthz", { headers: { Cookie: `token=${token}` } })).status).toBe(401);
  });
  it("requires JSON and bounded request bodies", async () => {
    expect((await http("/rpc", { method: "POST", headers: auth, body: "{}" })).status).toBe(415);
    expect((await http("/rpc", {
      method: "POST", headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ value: "x".repeat(65536) }),
    })).status).toBe(413);
  });
  it("bounds chunked bodies without invoking a service", async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const request = httpRequest({
        host: "127.0.0.1", port: host.port, path: "/rpc", method: "POST",
        headers: { ...auth, "Content-Type": "application/json", "Transfer-Encoding": "chunked" },
      }, (response) => { response.resume(); resolve(response.statusCode!); });
      request.on("error", reject);
      request.write("x".repeat(40000));
      request.end("x".repeat(40000));
    });
    expect(status).toBe(413);
  });
  it("returns standard parse errors and rejects batches and notifications", async () => {
    for (const [body, code] of [["{", -32700], ["[]", -32600], ['{"jsonrpc":"2.0","method":"work.snapshot"}', -32600]] as const) {
      const response = await http("/rpc", { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body });
      expect((await response.json()).error.code).toBe(code);
    }
  });
  it("rejects unknown fields at the envelope and nested parameter boundaries", async () => {
    expect((await rpc("work.snapshot", {}, { extra: true })).error.code).toBe(-32600);
    expect((await rpc("work.snapshot", { workspaceId: "other" })).error.code).toBe(-32602);
    expect((await rpc("agents.save", { ...agent, unexpected: true })).error.code).toBe(-32602);
    const snapshot = (await rpc("work.snapshot")).result;
    expect((await rpc("settings.update", {
      ...snapshot.settings, appearance: { theme: "dark", density: "compact", injected: true },
    })).error.code).toBe(-32602);
  });
  it("has an explicit method allowlist", async () => {
    for (const name of ["chat.send", "sessions.list", "shell.execute", "constructor", "toString"]) {
      expect((await rpc(name)).error.code).toBe(-32601);
    }
  });
  it("checks permissions before service calls and never accepts a client workspace override", async () => {
    services.security.authorize = vi.fn(async (_, permission) => permission !== "agents:write");
    expect((await rpc("agents.save", agent)).error.code).toBe(-32003);
    expect((await services.work.snapshot({ principal: owner, requestId: "test" })).agents).toHaveLength(0);
    expect((await rpc("events.read", { scope: { area: "work", workspaceId: "other" } })).error.code).toBe(-32602);
  });
  it("rejects aggregate reads missing another area's read grant", async () => {
    services.security.authorize = async (_, permission) => permission !== "settings:read";
    expect((await rpc("work.snapshot")).error.code).toBe(-32003);
  });
  it("sanitizes internal failures and invalid adapter output", async () => {
    services.provider.list = async () => { throw new Error("SECRET path and credential"); };
    expect((await rpc("providers.list")).error).toEqual({
      code: -32603, message: "The service could not complete this request.",
    });
    services.computer.inspect = async () => ({
      state: "running", detail: "Unsupported verification claim.", verified: true, verifiedAt: null,
      evidenceIds: [], capabilities: { view: true, control: true },
    });
    expect((await rpc("computer.inspect")).error.code).toBe(-32603);
    expect(JSON.stringify(vi.mocked(services.diagnostics.record).mock.calls)).not.toContain("SECRET");
  });
  it("persists agent configuration and idempotent task creation and delegates actual execution", async () => {
    await rpc("agents.save", agent);
    const input = { requestId: randomUUID(), title: "Review purchase orders", instructions: "Produce an evidence-backed review.", agentId: agent.id, priority: "normal" };
    const task = (await rpc("work.createTask", input)).result;
    expect((await rpc("work.createTask", input)).result.id).toBe(task.id);
    expect((await rpc("work.createTask", { ...input, title: "Changed" })).error.code).toBe(-32009);
    const run = (await rpc("runs.start", { id: task.id })).result;
    expect(run.verification).toBe("not_checked");
    expect(services.runtime.start).toHaveBeenCalledTimes(1);
    expect((await rpc("runs.start", { id: task.id })).error.code).toBe(-32009);
    const cancelled = (await rpc("runs.cancel", { id: run.id })).result;
    expect(cancelled.state).toBe("cancelled");
  });
});
describe("authenticated WebSocket JSON-RPC and events", () => {
  it("rejects unauthenticated upgrades", async () => {
    await expect(connect({})).rejects.toThrow("401");
  });
  it("supports the same strict method schemas as HTTP", async () => {
    const client = await connect();
    expect((await wsRpc(client, "work.snapshot")).result.workspaceId).toBe(owner.workspaceId);
    expect((await wsRpc(client, "work.snapshot", { extra: 1 })).error.code).toBe(-32602);
  });
  it("validates artifact integrity and accommodates bounded escaped content", async () => {
    const content = "\n".repeat(600000);
    const artifact = {
      id: "artifact", taskId: "task", runId: "run", name: "Report.txt", mediaType: "text/plain" as const,
      bytes: Buffer.byteLength(content), createdAt: new Date().toISOString(), evidence: true,
      sha256: createHash("sha256").update(content).digest("hex"),
    };
    services.work.readArtifact = async () => ({ artifact, content });
    const client = await connect();
    expect((await wsRpc(client, "artifacts.read", { id: artifact.id })).result.content).toHaveLength(600000);
    artifact.sha256 = "0".repeat(64);
    expect((await wsRpc(client, "artifacts.read", { id: artifact.id })).error.code).toBe(-32603);
  });
  it("revokes existing connections when authentication expires", async () => {
    const client = await connect();
    services.security.authenticate = async () => null;
    const closed = new Promise<number>((resolve) => client.once("close", resolve));
    client.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "work.snapshot" }));
    expect(await closed).toBe(1008);
  });
  it("replays scoped events, streams only the workspace scope, and unsubscribes", async () => {
    const client = await connect();
    const subscribed = await wsRpc(client, "events.subscribe", { scope: { area: "agents" } });
    expect(subscribed.result.events).toEqual([]);
    const notification = nextMessage(client);
    await rpc("agents.save", agent);
    const changed = await notification;
    expect(changed.method).toBe("events.changed");
    expect(changed.params.events[0]).toMatchObject({ area: "agents", entityId: agent.id });
    expect((await rpc("events.read", {
      scope: { area: "agents" }, cursor: subscribed.result.cursor,
    })).result.events).toHaveLength(1);
    const unsubscribed = await wsRpc(client, "events.unsubscribe", { subscriptionId: subscribed.result.subscriptionId });
    expect(unsubscribed.result.removed).toBe(true);
    expect((await wsRpc(client, "events.unsubscribe", { subscriptionId: subscribed.result.subscriptionId })).result.removed).toBe(false);
  });
  it("requires scope-specific permission for subscriptions", async () => {
    const client = await connect();
    services.security.authorize = async (_, permission) => permission !== "agents:read";
    expect((await wsRpc(client, "events.subscribe", { scope: { area: "agents" } })).error.code).toBe(-32003);
  });
  it("drains truncated replay without requiring another live event", async () => {
    for (let index = 0; index < 5; index++) host.publish(owner.workspaceId, {
      id: `event-${index}`, area: "work", entityId: "task", kind: "updated", at: new Date().toISOString(),
    });
    const client = await connect();
    const messages: Record<string, any>[] = [];
    client.on("message", (raw) => messages.push(JSON.parse(raw.toString())));
    client.send(JSON.stringify({ jsonrpc: "2.0", id: "subscribe", method: "events.subscribe", params: { scope: { area: "work" }, limit: 1 } }));
    await vi.waitFor(() => expect(messages).toHaveLength(2));
    expect(messages[0]?.result.events).toHaveLength(1);
    expect(messages[1]?.params.events).toHaveLength(4);
  });
  it("checks revoked authorization again before delivering events", async () => {
    const client = await connect();
    await wsRpc(client, "events.subscribe", { scope: { area: "agents" } });
    const closed = new Promise<number>((resolve) => client.once("close", resolve));
    services.security.authorize = async (_, permission) => permission !== "agents:read";
    host.publish(owner.workspaceId, { id: "event", area: "agents", entityId: "agent", kind: "updated", at: new Date().toISOString() });
    expect(await closed).toBe(1008);
  });
  it("bounds subscriptions per connection", async () => {
    const client = await connect();
    for (let index = 0; index < 16; index++) {
      expect((await wsRpc(client, "events.subscribe", { scope: { area: "work" } })).result.subscriptionId).toBeDefined();
    }
    expect((await wsRpc(client, "events.subscribe", { scope: { area: "work" } })).error.code).toBe(-32009);
  });
  it("rejects binary frames and HTTP subscriptions", async () => {
    expect((await rpc("events.subscribe", { scope: { area: "work" } })).error.code).toBe(-32600);
    const client = await connect();
    const closed = new Promise<number>((resolve) => client.once("close", resolve));
    client.send(Buffer.from("{}"));
    expect(await closed).toBe(1003);
  });
});
