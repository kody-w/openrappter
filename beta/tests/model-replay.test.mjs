import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  fingerprintRequest,
  normalizeRequest,
  startModelReplay,
} from "./e2e/harness/model-replay.mjs";

const fixturePath = path.join(
  import.meta.dirname,
  "e2e",
  "fixtures",
  "model-replay-cassette.json",
);

async function post(server, body) {
  return fetch(`${server.endpoint}/chat/completions`, {
    body: JSON.stringify(body),
    headers: {
      authorization: "Bearer fake-token",
      "content-type": "application/json",
    },
    method: "POST",
  });
}

test("model request fingerprints mask volatile timestamps, ids, guids, and paths", () => {
  const first = {
    messages: [{
      content: "2026-08-20T12:00:00.000Z /Users/alice/project "
        + "550e8400-e29b-41d4-a716-446655440000 req_abcdef123",
      role: "system",
    }],
    request_id: "one",
  };
  const second = {
    messages: [{
      content: "2027-09-21T13:01:02.000Z /Users/bob/other "
        + "123e4567-e89b-42d3-a456-426614174000 req_987654321",
      role: "system",
    }],
    request_id: "two",
  };
  assert.deepEqual(normalizeRequest(first), normalizeRequest(second));
  assert.equal(fingerprintRequest(first), fingerprintRequest(second));
});

test("replay mode serves fixture responses and reports the nearest unknown request", async (t) => {
  const server = await startModelReplay({
    cassettePath: fixturePath,
    mode: "replay",
  });
  t.after(() => server.stop());

  const modelsResponse = await fetch(`${server.endpoint}/models`);
  assert.equal(modelsResponse.status, 200);
  assert.equal((await modelsResponse.json()).data[0].id, "frontier-e2e-model");

  const response = await post(server, {
    messages: [{ content: "hello", role: "user" }],
    model: "frontier-e2e-model",
  });
  assert.equal(response.status, 200);
  assert.equal(
    (await response.json()).choices[0].message.content,
    "fixture reply",
  );

  const unknown = await post(server, {
    messages: [{ content: "goodbye", role: "user" }],
    model: "frontier-e2e-model",
  });
  assert.equal(unknown.status, 409);
  const failure = await unknown.json();
  assert.match(failure.error, /Unknown model request fingerprint/);
  assert.match(failure.nearestFingerprint, /^[0-9a-f]{64}$/);
  assert(failure.diff.some((item) => item.path.includes("content")));
});

test("script mode emits Copilot-compatible streaming tool calls", async (t) => {
  const server = await startModelReplay({
    mode: "script",
    script: {
      steps: [{
        when: {
          hasTool: "echo",
          lastUser: "use echo",
          stream: true,
        },
        response: {
          toolCalls: [{
            arguments: { value: "hello" },
            name: "echo",
          }],
        },
      }],
    },
  });
  t.after(() => server.stop());

  const response = await post(server, {
    messages: [{ content: "use echo", role: "user" }],
    model: "frontier-e2e-model",
    stream: true,
    tools: [{
      function: { name: "echo", parameters: { type: "object" } },
      type: "function",
    }],
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/event-stream/);
  const text = await response.text();
  assert.match(text, /"name":"echo"/);
  assert.match(text, /"finish_reason":"tool_calls"/);
  assert.match(text, /data: \[DONE\]/);
  assert.equal(server.requests.length, 1);
});

test("record mode proxies a local endpoint and writes a sanitized cassette", async (t) => {
  let upstreamAuthorization = null;
  const upstreamRequests = [];
  const upstream = createServer(async (req, res) => {
    upstreamAuthorization = req.headers.authorization;
    upstreamRequests.push(`${req.method} ${req.url}`);
    for await (const _chunk of req) {
      // Consume the request before replying.
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      choices: [{
        finish_reason: "stop",
        message: { content: "recorded reply", role: "assistant" },
      }],
    }));
  });
  await new Promise((resolve, reject) => {
    upstream.once("error", reject);
    upstream.listen(0, "127.0.0.1", resolve);
  });
  const address = upstream.address();
  assert(address && typeof address !== "string");
  const root = mkdtempSync(path.join(tmpdir(), "model-record-"));
  const cassettePath = path.join(root, "recorded.json");
  const server = await startModelReplay({
    allowRecord: true,
    cassettePath,
    mode: "record",
    realEndpoint: `http://127.0.0.1:${address.port}`,
    realToken: "developer-secret",
  });
  t.after(async () => {
    await server.stop();
    await new Promise((resolve) => upstream.close(resolve));
    rmSync(root, { recursive: true, force: true });
  });

  const modelsResponse = await fetch(`${server.endpoint}/models`);
  assert.equal(modelsResponse.status, 200);
  const response = await post(server, {
    messages: [{ content: "record me", role: "user" }],
    model: "frontier-e2e-model",
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).choices[0].message.content, "recorded reply");
  assert.equal(upstreamAuthorization, "Bearer developer-secret");
  assert.deepEqual(upstreamRequests, [
    "GET /models",
    "POST /chat/completions",
  ]);
  const cassetteText = readFileSync(cassettePath, "utf8");
  assert.doesNotMatch(cassetteText, /developer-secret/);
  const cassette = JSON.parse(cassetteText);
  assert.equal(Object.keys(cassette.entries).length, 1);
});
