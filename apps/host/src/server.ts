import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { WebSocket, WebSocketServer } from "ws";
import { eventReadSchema, idSchema, rpcEnvelopeSchema, serviceNames, type WorkEvent } from "./contracts.js";
import type { HostServices, Principal } from "./ports.js";
import { HostError } from "./errors.js";
import { EventJournal } from "./events.js";
import { createMethods, statusOf, type SubscriptionConnection } from "./methods.js";
import { z } from "zod";

const MAX_BODY = 64 * 1024;
const MAX_BUFFER = 34 * 1024 * 1024;
const principalSchema = z.strictObject({
  id: idSchema, workspaceId: idSchema,
  permissions: z.array(z.enum([
    "work:read", "work:write", "agents:read", "agents:write", "automations:read", "automations:write",
    "settings:read", "settings:write", "runtime:execute", "computer:read", "computer:control", "diagnostics:read", "events:read",
  ])).max(32),
});
const required: Record<keyof HostServices, readonly string[]> = {
  storage: ["initialize", "read"],
  security: ["authenticate", "authorize"],
  work: ["subscribe", "snapshot", "createTask", "assignTask", "saveAgent", "saveAutomation", "updateSettings", "startRun", "cancelRun", "decideApproval", "readArtifact"],
  runtime: ["start", "cancel", "decide", "schedule"],
  provider: ["list", "configure"], computer: ["inspect", "start", "stop"], diagnostics: ["snapshot", "record"],
};
export interface HostOptions { port?: number; allowedOrigins?: readonly string[]; eventCapacity?: number }
export interface RunningHost {
  port: number;
  instanceId: string;
  publish(workspaceId: string, event: WorkEvent): void;
  close(): Promise<void>;
}
export async function createHost(services: HostServices, options: HostOptions = {}): Promise<RunningHost> {
  for (const name of serviceNames) {
    for (const method of ["check", ...required[name]]) {
      if (typeof (services?.[name] as unknown as Record<string, unknown>)?.[method] !== "function") {
        throw new Error(`Required composition port is missing: ${name}.${method}`);
      }
    }
  }
  const origins = new Set(options.allowedOrigins ?? []);
  for (const origin of origins) {
    const parsed = new URL(origin);
    if (parsed.origin !== origin || !["http:", "https:"].includes(parsed.protocol)) {
      throw new Error("Origins must be explicit HTTP(S) origins, not wildcards or opaque origins.");
    }
  }
  const journal = new EventJournal(options.eventCapacity);
  const methods = createMethods(services, journal);
  const sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_BODY, perMessageDeflate: false });
  let port = 0;
  let closing = false;
  const validRequest = (request: IncomingMessage) =>
    (request.socket.remoteAddress === "127.0.0.1" || request.socket.remoteAddress === "::ffff:127.0.0.1") &&
    request.headers.host === `127.0.0.1:${port}` &&
    request.rawHeaders.filter((header, index) => index % 2 === 0 && header.toLowerCase() === "host").length === 1 &&
    (!request.headers.origin || origins.has(request.headers.origin));
  const authenticate = async (request: IncomingMessage) => {
    const authorization = request.headers.authorization;
    if (!authorization?.startsWith("Bearer ") || authorization.length > 263 ||
        request.rawHeaders.filter((header, index) => index % 2 === 0 && header.toLowerCase() === "authorization").length !== 1) return null;
    const parsed = principalSchema.safeParse(await services.security.authenticate(authorization.slice(7)));
    return parsed.success ? parsed.data : null;
  };
  const reply = (response: ServerResponse, code: number, body: unknown) => {
    if (!response.writableEnded && !response.destroyed) {
      response.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'" });
      response.end(JSON.stringify(body));
    }
  };
  async function dispatch(raw: unknown, principal: Principal, connection?: SubscriptionConnection) {
    const parsed = rpcEnvelopeSchema.safeParse(raw);
    if (!parsed.success) return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid JSON-RPC request." } };
    const request = parsed.data;
    const method = methods.get(request.method);
    try {
      if (closing) throw new HostError(-32011, "Host is shutting down.");
      if (!method) throw new HostError(-32601, "Method not found.");
      if (!await services.security.authorize(principal, method.permission)) throw new HostError(-32003, "Permission denied.");
      const result = await method.execute(request.params, { principal, requestId: String(request.id) }, connection);
      if (Buffer.byteLength(JSON.stringify(result)) > 32 * 1024 * 1024) {
        throw new HostError(-32013, "The service response exceeds the workspace transport limit.");
      }
      return { jsonrpc: "2.0", id: request.id, result };
    } catch (error) {
      const known = error instanceof HostError;
      const code = known ? error.code : -32603;
      try { services.diagnostics.record({ code: String(code), method: method ? request.method : "unknown" }); } catch { /* Diagnostics must not break the transport. */ }
      return { jsonrpc: "2.0", id: request.id, error: { code, message: known ? error.message : "The service could not complete this request." } };
    }
  }
  const server = createServer((request, response) => {
    void (async () => {
      if (!validRequest(request)) return reply(response, 403, { error: "Request origin is not permitted." });
      if (!["/rpc", "/healthz", "/readyz"].includes(request.url ?? "")) return reply(response, 404, { error: "Not found." });
      if (request.headers.origin) {
        response.setHeader("Access-Control-Allow-Origin", request.headers.origin);
        response.setHeader("Vary", "Origin");
      }
      if (request.method === "OPTIONS" && request.url === "/rpc" && request.headers.origin) {
        response.setHeader("Access-Control-Allow-Methods", "POST");
        response.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
        response.writeHead(204);
        response.end();
        return;
      }
      const principal = await authenticate(request);
      if (!principal) return reply(response, 401, { error: "Authentication required." });
      if (request.url === "/healthz" || request.url === "/readyz") {
        if (request.method !== "GET") return reply(response, 405, { error: "Method not allowed." });
        if (!await services.security.authorize(principal, "diagnostics:read")) return reply(response, 403, { error: "Permission denied." });
        if (request.url === "/healthz") return reply(response, closing ? 503 : 200, { product: "RAPP Work", protocolVersion: 1, alive: !closing });
        const status = await statusOf(services);
        return reply(response, !closing && status.ready ? 200 : 503, status);
      }
      if (request.method !== "POST") return reply(response, 405, { error: "Method not allowed." });
      if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers["content-type"] ?? "")) {
        return reply(response, 415, { error: "JSON content is required." });
      }
      if (Number(request.headers["content-length"] ?? 0) > MAX_BODY) return reply(response, 413, { error: "Request too large." });
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        const buffer = Buffer.from(chunk as Uint8Array);
        size += buffer.length;
        if (size > MAX_BODY) { reply(response, 413, { error: "Request too large." }); return; }
        chunks.push(buffer);
      }
      let raw: unknown;
      try { raw = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
      catch { return reply(response, 200, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Invalid JSON." } }); }
      return reply(response, 200, await dispatch(raw, principal));
    })().catch(() => reply(response, 500, { error: "Host request failed." }));
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 5000;
  server.on("upgrade", (request, socket, head) => {
    void (async () => {
      const reject = (code: number, reason: string) => { socket.end(`HTTP/1.1 ${code} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); };
      if (closing || !validRequest(request)) return reject(403, "Forbidden");
      if (request.url !== "/rpc") return reject(404, "Not Found");
      const principal = await authenticate(request);
      if (!principal) return reject(401, "Unauthorized");
      if (request.headers["sec-websocket-protocol"]) return reject(400, "Bad Request");
      sockets.handleUpgrade(request, socket as Socket, head, (client) => attach(client, request, principal));
    })().catch(() => socket.destroy());
  });
  function attach(client: WebSocket, request: IncomingMessage, original: Principal) {
    let chain = Promise.resolve();
    let pending = 0;
    let alive = true;
    const subscriptions = new Map<string, () => void>();
    const send = (data: unknown) => {
      if (client.readyState !== WebSocket.OPEN) return;
      const json = JSON.stringify(data);
      if (client.bufferedAmount + Buffer.byteLength(json) > MAX_BUFFER) { client.close(1013, "Consumer is too slow."); return; }
      client.send(json);
    };
    const currentIdentity = async () => {
      const identity = await authenticate(request);
      if (!identity || identity.id !== original.id || identity.workspaceId !== original.workspaceId) {
        client.close(1008, "Authentication expired.");
        return null;
      }
      return identity;
    };
    const connection: SubscriptionConnection = {
      async subscribe(input: z.infer<typeof eventReadSchema>, context) {
        if (subscriptions.size >= 16) throw new HostError(-32009, "Subscription limit reached.");
        const subscriptionId = randomUUID();
        const page = journal.read(context.principal, input.scope, input.cursor, input.limit);
        let cursor = page.cursor;
        let updating = false;
        let dirty = false;
        const pump = () => {
          dirty = true;
          if (updating) return;
          updating = true;
          void (async () => {
            do {
              dirty = false;
            if (!subscriptions.has(subscriptionId) || client.readyState !== WebSocket.OPEN) return;
            const identity = await currentIdentity();
            if (!identity) return;
            for (const permission of ["events:read", `${input.scope.area}:read`] as const) {
              if (!await services.security.authorize(identity, permission)) { client.close(1008, "Permission revoked."); return; }
            }
            if (!subscriptions.has(subscriptionId)) return;
            let next;
            do {
              next = journal.read(identity, input.scope, cursor, 200);
              cursor = next.cursor;
              if (next.events.length) send({ jsonrpc: "2.0", method: "events.changed", params: { subscriptionId, ...next } });
            } while (next.events.length === 200);
            } while (dirty);
          })().catch(() => { client.close(1011, "Refresh the workspace to resume events."); }).finally(() => {
            updating = false;
            if (dirty && subscriptions.has(subscriptionId) && client.readyState === WebSocket.OPEN) pump();
          });
        };
        const remove = journal.listen(original.workspaceId, pump);
        subscriptions.set(subscriptionId, remove);
        // Finish replay even when the initial page is truncated and no new event arrives.
        setImmediate(pump);
        return { subscriptionId, ...page };
      },
      unsubscribe(id) {
        const remove = subscriptions.get(id);
        remove?.();
        return { removed: subscriptions.delete(id) };
      },
    };
    client.on("message", (data, binary) => {
      if (binary) { client.close(1003, "JSON text is required."); return; }
      if (++pending > 32) { client.close(1013, "Too many pending requests."); return; }
      chain = chain.then(async () => {
        const identity = await currentIdentity();
        if (!identity) return;
        let raw: unknown;
        try { raw = JSON.parse(data.toString()); }
        catch { send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Invalid JSON." } }); return; }
        send(await dispatch(raw, identity, connection));
      }).catch(() => client.close(1011, "Host request failed.")).finally(() => { pending -= 1; });
    });
    client.on("pong", () => { alive = true; });
    const heartbeat = setInterval(() => {
      if (!alive) { client.terminate(); return; }
      alive = false;
      client.ping();
    }, 30000);
    heartbeat.unref();
    client.on("error", () => client.terminate());
    client.on("close", () => {
      clearInterval(heartbeat);
      for (const remove of subscriptions.values()) remove();
      subscriptions.clear();
    });
  }
  try { await services.storage.initialize(); }
  catch (error) {
    sockets.close();
    await services.runtime.close?.().catch(() => {});
    await services.provider.close?.().catch(() => {});
    await services.storage.close?.().catch(() => {});
    throw error;
  }
  const unsubscribe = services.work.subscribe((workspaceId, event) => journal.publish(workspaceId, event));
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.port ?? 0, "127.0.0.1", () => {
        server.off("error", reject);
        const address = server.address();
        if (!address || typeof address === "string") { reject(new Error("No loopback listener.")); return; }
        port = address.port;
        resolve();
      });
    });
  } catch (error) {
    unsubscribe();
    await services.storage.close?.();
    throw error;
  }
  let stopped: Promise<void> | undefined;
  return {
    port, instanceId: journal.instanceId,
    publish: (workspace, event) => { if (!closing) journal.publish(workspace, event); },
    close() {
      stopped ??= (async () => {
        closing = true;
        unsubscribe();
        for (const client of sockets.clients) client.terminate();
        sockets.close();
        await new Promise<void>((resolve, reject) => {
          const deadline = setTimeout(() => server.closeAllConnections(), 1500);
          deadline.unref();
          server.close((error) => { clearTimeout(deadline); error ? reject(error) : resolve(); });
          server.closeIdleConnections();
        });
        const closed = new Set<object>();
        for (const name of ["runtime", "computer", "provider", "work", "diagnostics", "security", "storage"] as const) {
          if (!closed.has(services[name])) { closed.add(services[name]); await services[name].close?.(); }
        }
      })();
      return stopped;
    },
  };
}
