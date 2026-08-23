import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

const MAX_REQUEST_BYTES = 4 * 1024 * 1024;
const VOLATILE_FIELD = /^(?:created|updated)?_?(?:at|utc)$|^(?:ts|timestamp|request_?id|session_?id|memory_?guid|guid|uuid|nonce)$/i;
const UUID_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;
const ISO_TIMESTAMP_PATTERN = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/g;
const REQUEST_ID_PATTERN = /\b(?:call|req|request)[_-][A-Za-z0-9_-]{6,}\b/g;
const UNIX_PATH_PATTERN = /(?:\/Users\/|\/home\/|\/private\/tmp\/|\/tmp\/|\/var\/folders\/)[^\s"'`<>]+/g;
const WINDOWS_PATH_PATTERN = /\b[A-Za-z]:\\(?:Users|Temp|Windows\\Temp)\\[^\s"'`<>]+/g;

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stableValue(value[key])]),
  );
}

export function stableStringify(value) {
  return JSON.stringify(stableValue(value));
}

function maskString(value, roots) {
  let masked = value
    .replace(ISO_TIMESTAMP_PATTERN, "<TIMESTAMP>")
    .replace(UUID_PATTERN, "<UUID>")
    .replace(REQUEST_ID_PATTERN, "<REQUEST_ID>");
  for (const root of roots) {
    if (!root) continue;
    masked = masked.replace(
      new RegExp(escapeRegExp(path.resolve(root)), "g"),
      "<ABSOLUTE_PATH>",
    );
  }
  return masked
    .replace(WINDOWS_PATH_PATTERN, "<ABSOLUTE_PATH>")
    .replace(UNIX_PATH_PATTERN, "<ABSOLUTE_PATH>");
}

export function normalizeVolatile(
  value,
  {
    roots = [process.cwd(), homedir(), tmpdir()],
  } = {},
) {
  function visit(current, key = "") {
    if (
      VOLATILE_FIELD.test(key)
      && (typeof current === "string" || typeof current === "number")
    ) {
      return `<${key.toUpperCase()}>`;
    }
    if (typeof current === "string") return maskString(current, roots);
    if (Array.isArray(current)) return current.map((item) => visit(item));
    if (!current || typeof current !== "object") return current;
    return Object.fromEntries(
      Object.keys(current)
        .sort()
        .map((childKey) => [childKey, visit(current[childKey], childKey)]),
    );
  }
  return visit(structuredClone(value));
}

export function normalizeRequest(request, options = {}) {
  return normalizeVolatile(request, options);
}

export function fingerprintRequest(request, options = {}) {
  return createHash("sha256")
    .update(stableStringify(normalizeRequest(request, options)))
    .digest("hex");
}

function readJson(filePath, label) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(
      `Could not read ${label} at ${filePath}: ${String(error.message || error)}`,
    );
  }
}

function cassetteEntries(cassette) {
  if (!cassette || typeof cassette !== "object") {
    throw new Error("A model replay cassette must be a JSON object.");
  }
  if (
    !cassette.entries
    || typeof cassette.entries !== "object"
    || Array.isArray(cassette.entries)
  ) {
    throw new Error("A model replay cassette must contain keyed entries.");
  }
  return cassette.entries;
}

function valueDiff(actual, expected, pointer = "$", output = []) {
  if (output.length >= 40) return output;
  if (Object.is(actual, expected)) return output;
  if (
    actual === null
    || expected === null
    || typeof actual !== "object"
    || typeof expected !== "object"
  ) {
    output.push({ actual, expected, path: pointer });
    return output;
  }
  if (Array.isArray(actual) !== Array.isArray(expected)) {
    output.push({ actual, expected, path: pointer });
    return output;
  }
  const keys = Array.isArray(actual)
    ? Array.from(
        { length: Math.max(actual.length, expected.length) },
        (_unused, index) => index,
      )
    : [...new Set([...Object.keys(actual), ...Object.keys(expected)])].sort();
  for (const key of keys) {
    const child = Array.isArray(actual) ? `[${key}]` : `.${key}`;
    if (!Object.hasOwn(actual, key)) {
      output.push({
        actual: "<missing>",
        expected: expected[key],
        path: `${pointer}${child}`,
      });
    } else if (!Object.hasOwn(expected, key)) {
      output.push({
        actual: actual[key],
        expected: "<missing>",
        path: `${pointer}${child}`,
      });
    } else {
      valueDiff(actual[key], expected[key], `${pointer}${child}`, output);
    }
    if (output.length >= 40) break;
  }
  return output;
}

function nearestCassetteEntry(entries, normalized) {
  return Object.entries(entries)
    .map(([fingerprint, entry]) => {
      const diff = valueDiff(normalized, entry.request);
      return { diff, entry, fingerprint };
    })
    .sort((left, right) => (
      left.diff.length - right.diff.length
      || left.fingerprint.localeCompare(right.fingerprint)
    ))[0] || null;
}

function requestMessages(body) {
  return Array.isArray(body.messages) ? body.messages : [];
}

function lastMessage(body, role) {
  return [...requestMessages(body)]
    .reverse()
    .find((message) => !role || message.role === role);
}

function scriptMatches(when = {}, body, sequence) {
  if (when.index !== undefined && Number(when.index) !== sequence) return false;
  if (when.stream !== undefined && Boolean(when.stream) !== Boolean(body.stream)) {
    return false;
  }
  const messagesText = stableStringify(requestMessages(body));
  if (
    when.messageIncludes !== undefined
    && !messagesText.includes(String(when.messageIncludes))
  ) {
    return false;
  }
  if (
    when.lastUser !== undefined
    && String(lastMessage(body, "user")?.content || "") !== String(when.lastUser)
  ) {
    return false;
  }
  if (
    when.hasTool !== undefined
    && !body.tools?.some((tool) => (
      tool?.function?.name === when.hasTool || tool?.name === when.hasTool
    ))
  ) {
    return false;
  }
  if (
    when.hasToolResult !== undefined
    && !requestMessages(body).some((message) => (
      message.role === "tool" && message.name === when.hasToolResult
    ))
  ) {
    return false;
  }
  return true;
}

function openAiToolCalls(toolCalls = [], responseIndex = 0) {
  return toolCalls.map((toolCall, index) => ({
    function: {
      arguments: typeof toolCall.arguments === "string"
        ? toolCall.arguments
        : JSON.stringify(toolCall.arguments || {}),
      name: toolCall.name,
    },
    id: toolCall.id || `script-call-${responseIndex + 1}-${index + 1}`,
    type: "function",
  }));
}

function scriptedJson(response, responseIndex) {
  if (response.body) return response.body;
  const toolCalls = openAiToolCalls(response.toolCalls, responseIndex);
  return {
    choices: [{
      finish_reason: toolCalls.length ? "tool_calls" : "stop",
      index: 0,
      message: {
        content: response.text ?? response.content ?? "",
        role: "assistant",
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      },
    }],
  };
}

function scriptedSse(response, responseIndex) {
  if (typeof response.body === "string") return response.body;
  const toolCalls = openAiToolCalls(response.toolCalls, responseIndex);
  const frames = [];
  const text = String(response.text ?? response.content ?? "");
  if (text) {
    frames.push({
      choices: [{ delta: { content: text, role: "assistant" }, index: 0 }],
    });
  }
  if (toolCalls.length) {
    frames.push({
      choices: [{
        delta: {
          tool_calls: toolCalls.map((toolCall, index) => ({
            ...toolCall,
            index,
          })),
        },
        index: 0,
      }],
    });
  }
  frames.push({
    choices: [{
      delta: {},
      finish_reason: toolCalls.length ? "tool_calls" : "stop",
      index: 0,
    }],
  });
  return [
    ...frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`),
    "data: [DONE]\n\n",
  ].join("");
}

function responseDescriptor(body, response, responseIndex) {
  const stream = Boolean(body.stream);
  return {
    body: stream
      ? scriptedSse(response, responseIndex)
      : scriptedJson(response, responseIndex),
    headers: {
      "content-type": stream
        ? "text/event-stream; charset=utf-8"
        : "application/json; charset=utf-8",
      ...(response.headers || {}),
    },
    status: response.status || 200,
  };
}

function sendResponse(res, descriptor) {
  const body = typeof descriptor.body === "string"
    ? descriptor.body
    : JSON.stringify(descriptor.body);
  res.writeHead(descriptor.status || 200, {
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
    ...(descriptor.headers || {}),
  });
  res.end(body);
}

async function readRequestBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES) {
      const error = new Error("Model request exceeds the 4 MiB harness limit.");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("Model request body must be valid JSON.");
    error.statusCode = 400;
    throw error;
  }
}

function resolveRecordCredentials(options) {
  if (options.realEndpoint && options.realToken) {
    return {
      endpoint: options.realEndpoint,
      token: options.realToken,
    };
  }
  const env = options.env || process.env;
  const cachePath = options.realCachePath
    || env.RAPP_MODEL_REAL_CACHE
    || (env.BRAINSTEM_BETA_SOURCE_DIR
      ? path.join(env.BRAINSTEM_BETA_SOURCE_DIR, ".copilot_session")
      : path.join(
          env.BRAINSTEM_HOME || path.join(homedir(), ".brainstem"),
          "src",
          "rapp_brainstem",
          ".copilot_session",
        ));
  const cache = readJson(cachePath, "developer Copilot cache");
  if (!cache.token || !cache.endpoint) {
    throw new Error(
      `Developer Copilot cache at ${cachePath} lacks token or endpoint.`,
    );
  }
  return { endpoint: cache.endpoint, token: cache.token };
}

function writeCassette(filePath, cassette) {
  mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(cassette, null, 2)}\n`, {
    mode: 0o600,
  });
  chmodSync(temporary, 0o600);
  renameSync(temporary, filePath);
}

export class ModelReplayServer {
  constructor({
    allowRecord = false,
    cassettePath = null,
    env = process.env,
    host = "127.0.0.1",
    mode = "replay",
    normalizeOptions = {},
    port = 0,
    script = null,
    ...recordOptions
  } = {}) {
    if (!["record", "replay", "script"].includes(mode)) {
      throw new Error(`Unknown model replay mode: ${mode}`);
    }
    if (mode !== "script" && !cassettePath) {
      throw new Error(`${mode} mode requires a cassettePath.`);
    }
    if (
      mode === "record"
      && !allowRecord
      && env.RAPP_MODEL_ALLOW_RECORD !== "1"
    ) {
      throw new Error(
        "Record mode is human-run only; set RAPP_MODEL_ALLOW_RECORD=1.",
      );
    }
    this.allowRecord = allowRecord;
    this.cassettePath = cassettePath;
    this.env = env;
    this.host = host;
    this.mode = mode;
    this.normalizeOptions = normalizeOptions;
    this.port = port;
    this.recordOptions = recordOptions;
    this.requests = [];
    this.script = Array.isArray(script)
      ? { steps: script }
      : script || { steps: [] };
    this.usedScriptSteps = new Set();
    this.cassette = mode === "replay"
      ? readJson(cassettePath, "model replay cassette")
      : {
          entries: cassettePath && existsSync(cassettePath)
            ? cassetteEntries(readJson(cassettePath, "model replay cassette"))
            : {},
          version: 1,
        };
    if (mode === "replay") cassetteEntries(this.cassette);
    this.server = null;
    this.endpoint = null;
  }

  models() {
    return this.script.models || [{
      capabilities: { type: "chat" },
      id: "frontier-e2e-model",
      model_picker_enabled: true,
      name: "Frontier E2E Model",
      supported_endpoints: ["/chat/completions"],
    }];
  }

  async start() {
    if (this.server) return this;
    this.server = createServer((req, res) => {
      void this.handle(req, res).catch((error) => {
        if (res.headersSent) {
          res.destroy(error);
          return;
        }
        sendResponse(res, {
          body: { error: String(error.message || error) },
          headers: { "content-type": "application/json; charset=utf-8" },
          status: error.statusCode || 500,
        });
      });
    });
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.port, this.host, resolve);
    });
    const address = this.server.address();
    if (!address || typeof address === "string") {
      await this.stop();
      throw new Error("Model replay server did not bind a TCP port.");
    }
    this.port = address.port;
    this.endpoint = `http://${this.host}:${this.port}`;
    return this;
  }

  async handle(req, res) {
    const url = new URL(req.url || "/", `http://${this.host}`);
    if (req.method === "GET" && url.pathname === "/models") {
      if (this.mode === "record") {
        await this.proxyModels(req, res);
        return;
      }
      sendResponse(res, {
        body: { data: this.models() },
        headers: { "content-type": "application/json; charset=utf-8" },
        status: 200,
      });
      return;
    }
    if (req.method !== "POST" || url.pathname !== "/chat/completions") {
      sendResponse(res, {
        body: { error: "Not found." },
        headers: { "content-type": "application/json; charset=utf-8" },
        status: 404,
      });
      return;
    }

    const body = await readRequestBody(req);
    const normalized = normalizeRequest(body, this.normalizeOptions);
    const fingerprint = fingerprintRequest(body, this.normalizeOptions);
    const captured = {
      fingerprint,
      normalized,
      request: body,
      sequence: this.requests.length + 1,
    };
    this.requests.push(captured);

    if (this.mode === "record") {
      await this.record(req, res, captured);
    } else if (this.mode === "script") {
      await this.respondFromScript(res, captured);
    } else {
      this.respondFromCassette(res, captured);
    }
  }

  respondFromCassette(res, captured) {
    const entries = cassetteEntries(this.cassette);
    const entry = entries[captured.fingerprint];
    if (entry) {
      sendResponse(res, entry.response);
      return;
    }
    const nearest = nearestCassetteEntry(entries, captured.normalized);
    sendResponse(res, {
      body: {
        diff: nearest?.diff || [],
        error: `Unknown model request fingerprint: ${captured.fingerprint}`,
        nearestFingerprint: nearest?.fingerprint || null,
      },
      headers: { "content-type": "application/json; charset=utf-8" },
      status: 409,
    });
  }

  async respondFromScript(res, captured) {
    const steps = Array.isArray(this.script.steps) ? this.script.steps : [];
    const index = steps.findIndex((step, stepIndex) => (
      !this.usedScriptSteps.has(stepIndex)
      && scriptMatches(
        step.when || step.match || {},
        captured.request,
        captured.sequence,
      )
    ));
    if (index < 0) {
      sendResponse(res, {
        body: {
          error: `No scripted model turn matched request ${captured.sequence}.`,
          fingerprint: captured.fingerprint,
        },
        headers: { "content-type": "application/json; charset=utf-8" },
        status: 409,
      });
      return;
    }
    const step = steps[index];
    if (step.repeat !== true) this.usedScriptSteps.add(index);
    const response = step.response || step;
    if (Number(response.delayMs) > 0) {
      await new Promise((resolve) => setTimeout(
        resolve,
        Math.min(30_000, Number(response.delayMs)),
      ));
    }
    sendResponse(
      res,
      responseDescriptor(captured.request, response, index),
    );
  }

  async record(req, res, captured) {
    const credentials = resolveRecordCredentials({
      allowRecord: this.allowRecord,
      env: this.env,
      ...this.recordOptions,
    });
    const upstream = new URL("/chat/completions", credentials.endpoint);
    const response = await fetch(upstream, {
      body: JSON.stringify(captured.request),
      headers: {
        accept: req.headers.accept || "application/json",
        authorization: `Bearer ${credentials.token}`,
        "content-type": "application/json",
        "copilot-integration-id": req.headers["copilot-integration-id"] || "vscode-chat",
        "editor-version": req.headers["editor-version"] || "vscode/1.95.0",
      },
      method: "POST",
    });
    const responseBody = Buffer.from(await response.arrayBuffer()).toString("utf8");
    const descriptor = {
      body: responseBody,
      headers: {
        "content-type": response.headers.get("content-type")
          || "application/json; charset=utf-8",
      },
      status: response.status,
    };
    this.cassette.entries[captured.fingerprint] = {
      request: captured.normalized,
      response: descriptor,
    };
    writeCassette(this.cassettePath, this.cassette);
    sendResponse(res, descriptor);
  }

  async proxyModels(req, res) {
    const credentials = resolveRecordCredentials({
      allowRecord: this.allowRecord,
      env: this.env,
      ...this.recordOptions,
    });
    const response = await fetch(new URL("/models", credentials.endpoint), {
      headers: {
        accept: req.headers.accept || "application/json",
        authorization: `Bearer ${credentials.token}`,
        "content-type": "application/json",
        "copilot-integration-id": req.headers["copilot-integration-id"] || "vscode-chat",
        "editor-version": req.headers["editor-version"] || "vscode/1.95.0",
      },
    });
    const responseBody = Buffer.from(await response.arrayBuffer()).toString("utf8");
    sendResponse(res, {
      body: responseBody,
      headers: {
        "content-type": response.headers.get("content-type")
          || "application/json; charset=utf-8",
      },
      status: response.status,
    });
  }

  async stop() {
    const server = this.server;
    this.server = null;
    this.endpoint = null;
    if (!server) return;
    await new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
      server.closeAllConnections?.();
    });
  }
}

export async function startModelReplay(options = {}) {
  return new ModelReplayServer(options).start();
}
