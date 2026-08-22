#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const MAX_PACK_NODE_RESPONSE_BYTES = 4 * 1024 * 1024;

async function boundedText(response) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_PACK_NODE_RESPONSE_BYTES) {
    throw new Error("Pack node response exceeds 4 MiB.");
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_PACK_NODE_RESPONSE_BYTES) {
      await reader.cancel("Pack node response overflow");
      throw new Error("Pack node response exceeds 4 MiB.");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

export async function packNodeResponse(response, action) {
  const raw = await boundedText(response);
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Preserve non-JSON refusals as bounded text evidence.
  }
  const envelope = parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed
    : null;
  return {
    ok: true,
    response: action === "health"
      ? (envelope ? JSON.stringify(envelope) : raw)
      : String(envelope?.response ?? raw),
    envelope,
    http_status: response.status,
    refused: !response.ok,
  };
}

function requestDocument() {
  const source = readFileSync(0, "utf8");
  if (Buffer.byteLength(source) > 1024 * 1024) {
    throw new Error("Pack node request exceeds 1 MiB.");
  }
  const value = JSON.parse(source);
  if (!["brainstem", "openrappter"].includes(value.node_kind)) {
    throw new Error("Pack node request has invalid node_kind.");
  }
  if (!["chat", "health"].includes(value.action)) {
    throw new Error("Pack node request has invalid action.");
  }
  const prompt = String(value.prompt || "");
  if (value.action === "chat" && (!prompt.trim() || prompt.length > 100_000)) {
    throw new Error("Pack node chat requires a bounded prompt.");
  }
  return { ...value, prompt };
}

async function brainstem(request) {
  const origin = process.env.RAPPTER_PACK_BRAINSTEM_URL || "http://127.0.0.1:7071";
  const endpoint = request.action === "health" ? "/health" : "/chat";
  const response = await fetch(`${origin}${endpoint}`, {
    method: request.action === "health" ? "GET" : "POST",
    headers: { "Content-Type": "application/json" },
    ...(request.action === "health" ? {} : {
      body: JSON.stringify({
        user_input: request.prompt,
        conversation_history: [],
      }),
    }),
    signal: AbortSignal.timeout(5 * 60 * 1000),
  });
  return {
    ...(await packNodeResponse(response, request.action)),
    evidence: [`${origin}${endpoint}`],
  };
}

async function openRappter(request) {
  const home = process.env.OPENRAPPTER_HOME || path.join(homedir(), ".openrappter");
  const betaHome = process.env.BRAINSTEM_BETA_HOME || path.join(home, "desktop");
  const metadataPath = process.env.OPENRAPPTER_CHAT_ENDPOINT_FILE
    || path.join(betaHome, "chat-endpoint.json");
  if (!existsSync(metadataPath)) {
    throw new Error(`OpenRappter /chat endpoint is not running at ${metadataPath}.`);
  }
  const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
  if (
    metadata.schema !== "openrappter-chat-endpoint/1.0"
    || !/^http:\/\/127\.0\.0\.1:\d+\/chat$/.test(metadata.url)
  ) {
    throw new Error("OpenRappter /chat endpoint metadata is invalid.");
  }
  if (request.action === "health") {
    const origin = new URL(metadata.url).origin;
    const probe = await fetch(`${origin}/health`, {
      signal: AbortSignal.timeout(2_000),
    });
    const result = await packNodeResponse(probe, "health");
    if (
      result.refused
      || result.envelope?.status !== "ready"
      || result.envelope?.schema !== "openrappter-neighborhood-health/1.0"
    ) {
      throw new Error(`OpenRappter /chat probe HTTP ${probe.status}.`);
    }
    return {
      ...result,
      evidence: [metadataPath, `${origin}/health`],
    };
  }
  const response = await fetch(metadata.url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      user_input: request.prompt,
      conversation_history: [],
    }),
    signal: AbortSignal.timeout(5 * 60 * 1000),
  });
  return {
    ...(await packNodeResponse(response, "chat")),
    evidence: [metadataPath, metadata.url],
  };
}

async function main() {
  const request = requestDocument();
  const started = Date.now();
  const result = request.node_kind === "brainstem"
    ? await brainstem(request)
    : await openRappter(request);
  process.stdout.write(`${JSON.stringify({
    ok: result.ok,
    response: result.response,
    envelope: result.envelope,
    http_status: result.http_status,
    refused: result.refused,
    evidence: result.evidence,
    duration_ms: Date.now() - started,
  })}\n`);
}

if (
  process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  main().catch((error) => {
    process.stderr.write(`rappter-pack-node failed — ${error.message}\n`);
    process.exit(1);
  });
}
