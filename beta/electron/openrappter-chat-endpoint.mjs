import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import path from "node:path";

import { exactRapp1Success } from "./rapp1-chat-envelope.mjs";

export const OPENRAPPTER_CHAT_ENDPOINT_SCHEMA = "openrappter-chat-endpoint/1.0";
export const OPENRAPPTER_CONTROL_PATH = "/__openrappter/control";
const MAX_CHAT_BYTES = 1024 * 1024;

function loopbackTarget(value) {
  if (!value) return null;
  const target = new URL(String(value));
  if (
    target.protocol !== "http:"
    || !["127.0.0.1", "localhost"].includes(target.hostname)
    || !target.port
  ) {
    throw new Error("OpenRappter active Brainstem must be an explicit loopback HTTP origin.");
  }
  return target.origin;
}

function writeMetadata(file, metadata) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(metadata, null, 2)}\n`, {
    mode: 0o600,
  });
  renameSync(temporary, file);
  try {
    chmodSync(file, 0o600);
  } catch {
    // Windows does not expose POSIX modes.
  }
}

function removeOwnedMetadata(file, token) {
  try {
    const current = JSON.parse(readFileSync(file, "utf8"));
    if (current.pid === process.pid && current.instance_token === token) {
      rmSync(file, { force: true });
    }
  } catch {
    // Missing or replaced metadata belongs to no cleanup action here.
  }
}

function jsonError(response, status, code) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify({ error: { code, step: null } }));
}

function exactChatRequest(bytes) {
  const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const value = JSON.parse(source);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid request");
  }
  if (typeof value.user_input !== "string" || !value.user_input.trim()) {
    throw new Error("invalid user_input");
  }
  const request = { user_input: value.user_input };
  for (const key of ["session_id", "idempotency_key"]) {
    if (value[key] !== undefined) {
      if (typeof value[key] !== "string" || !value[key]) {
        throw new Error(`invalid ${key}`);
      }
      request[key] = value[key];
    }
  }
  return Buffer.from(JSON.stringify(request));
}

function exactChatSuccess(bytes) {
  const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const value = JSON.parse(source);
  return Buffer.from(JSON.stringify(exactRapp1Success(value)));
}

export async function startOpenRappterChatEndpoint({
  appIdentity = null,
  betaHome,
  dockVisible = false,
  fetchImpl = fetch,
  instanceToken = randomUUID(),
  metadataPath = null,
  neighborhoodId = "openrappter:alpha",
  requestStop = null,
  resolveTarget,
} = {}) {
  if (!betaHome || typeof resolveTarget !== "function") {
    throw new Error("OpenRappter /chat endpoint requires betaHome and resolveTarget.");
  }
  const file = metadataPath || path.join(betaHome, "chat-endpoint.json");
  const server = http.createServer((request, response) => {
    if (request.url === OPENRAPPTER_CONTROL_PATH) {
      if (request.headers["x-openrappter-instance-token"] !== instanceToken) {
        jsonError(response, 403, "control-capability-required");
        return;
      }
      if (request.method === "GET") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          schema: "openrappter-instance-control/1.0",
          pid: process.pid,
          instance_token: instanceToken,
          neighborhood_id: neighborhoodId,
          parent_neighborhood_id:
            appIdentity?.parent_neighborhood_id || null,
          generation: appIdentity?.generation ?? 0,
          app_name: appIdentity?.app_name || "OpenRappter",
          app_user_model_id: appIdentity?.app_user_model_id || null,
          dock_badge: appIdentity?.dock_badge || "",
          dock_visible: dockVisible === true,
        }));
        return;
      }
      if (request.method === "POST" && typeof requestStop === "function") {
        response.writeHead(202, { "content-type": "application/json" });
        response.end(JSON.stringify({ stopping: true }));
        setImmediate(requestStop);
        return;
      }
      response.setHeader("allow", requestStop ? "GET, POST" : "GET");
      jsonError(response, 405, "method-not-allowed");
      return;
    }
    if (request.url === "/health") {
      if (request.method !== "GET") {
        response.setHeader("allow", "GET");
        jsonError(response, 405, "method-not-allowed");
        return;
      }
      void (async () => {
        let target;
        try {
          target = loopbackTarget(resolveTarget());
        } catch {
          target = null;
        }
        if (!target) {
          jsonError(response, 503, "active-route-unavailable");
          return;
        }
        try {
          const upstream = await fetchImpl(`${target}/health`, {
            signal: AbortSignal.timeout(2_000),
          });
          if (!upstream.ok) {
            jsonError(response, 503, "active-route-unavailable");
            return;
          }
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({
            schema: "openrappter-neighborhood-health/1.0",
            status: "ready",
            neighborhood_id: neighborhoodId,
            parent_neighborhood_id: appIdentity?.parent_neighborhood_id || null,
            generation: appIdentity?.generation ?? 0,
            app_name: appIdentity?.app_name || "OpenRappter",
            app_user_model_id: appIdentity?.app_user_model_id || null,
            dock_badge: appIdentity?.dock_badge || "",
            dock_visible: dockVisible === true,
          }));
        } catch {
          jsonError(response, 503, "active-route-unavailable");
        }
      })();
      return;
    }
    if (request.url !== "/chat") {
      jsonError(response, 404, "not-found");
      return;
    }
    if (request.method !== "POST") {
      response.setHeader("allow", "POST");
      jsonError(response, 405, "method-not-allowed");
      return;
    }
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_CHAT_BYTES) {
        jsonError(response, 413, "request-too-large");
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (size > MAX_CHAT_BYTES || response.writableEnded) return;
      void (async () => {
        let exactRequest;
        try {
          exactRequest = exactChatRequest(Buffer.concat(chunks));
        } catch {
          jsonError(response, 422, "invalid-request-envelope");
          return;
        }
        let target;
        try {
          target = loopbackTarget(resolveTarget());
        } catch {
          jsonError(response, 503, "active-route-unavailable");
          return;
        }
        if (!target) {
          jsonError(response, 503, "active-route-unavailable");
          return;
        }
        try {
          const upstream = await fetchImpl(`${target}/chat`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
            },
            body: exactRequest,
            signal: AbortSignal.timeout(5 * 60 * 1000),
          });
          const bytes = Buffer.from(await upstream.arrayBuffer());
          if (upstream.ok) {
            if (upstream.status !== 200) {
              jsonError(response, 502, "invalid-upstream-envelope");
              return;
            }
            let exactSuccess;
            try {
              exactSuccess = exactChatSuccess(bytes);
            } catch {
              jsonError(response, 502, "invalid-upstream-envelope");
              return;
            }
            response.writeHead(200, { "content-type": "application/json" });
            response.end(exactSuccess);
            return;
          }
          response.writeHead(upstream.status, {
            "content-type": upstream.headers.get("content-type")
              || "application/json",
          });
          response.end(bytes);
        } catch {
          jsonError(response, 503, "active-route-unavailable");
        }
      })();
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("OpenRappter /chat endpoint could not allocate loopback.");
  }
  const url = `http://127.0.0.1:${address.port}/chat`;
  writeMetadata(file, {
    schema: OPENRAPPTER_CHAT_ENDPOINT_SCHEMA,
    url,
    pid: process.pid,
    instance_token: instanceToken,
    neighborhood_id: neighborhoodId,
    parent_neighborhood_id: appIdentity?.parent_neighborhood_id || null,
    generation: appIdentity?.generation ?? 0,
    app_name: appIdentity?.app_name || "OpenRappter",
    app_user_model_id: appIdentity?.app_user_model_id || null,
    dock_badge: appIdentity?.dock_badge || "",
    dock_visible: dockVisible === true,
    started_at: new Date().toISOString(),
  });
  return {
    metadataPath: file,
    url,
    async stop() {
      await new Promise((resolve) => server.close(resolve));
      removeOwnedMetadata(file, instanceToken);
    },
  };
}
