import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  OPENRAPPTER_CHAT_ENDPOINT_SCHEMA,
  startOpenRappterChatEndpoint,
} from "../electron/openrappter-chat-endpoint.mjs";

async function listen(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    server,
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test("OpenRappter exposes the exact Brainstem POST /chat wire", async (t) => {
  let observed = null;
  const upstream = await listen((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      observed = {
        method: request.method,
        path: request.url,
        body: Buffer.concat(chunks).toString("utf8"),
      };
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        response: "WIRE_OK",
        agent_logs: ["called:proof"],
        session_id: "session-proof",
      }));
    });
  });
  t.after(() => upstream.close());
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "openrappter-chat-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const endpoint = await startOpenRappterChatEndpoint({
    betaHome: home,
    resolveTarget: () => upstream.url,
  });
  t.after(() => endpoint.stop());

  const requestBody = {
    user_input: "prove the wire",
    session_id: "caller-session",
    conversation_history: [{ role: "user", content: "prior" }],
  };
  const response = await fetch(endpoint.url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(requestBody),
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(body, {
    response: "WIRE_OK",
    agent_logs: ["called:proof"],
    session_id: "session-proof",
  });
  assert.deepEqual(observed, {
    method: "POST",
    path: "/chat",
    body: JSON.stringify(requestBody),
  });

  const metadata = JSON.parse(fs.readFileSync(endpoint.metadataPath, "utf8"));
  assert.equal(metadata.schema, OPENRAPPTER_CHAT_ENDPOINT_SCHEMA);
  assert.equal(metadata.url, endpoint.url);
  assert.equal(metadata.neighborhood_id, "openrappter:alpha");
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(endpoint.metadataPath).mode & 0o777, 0o600);
  }
  const health = await fetch(`${new URL(endpoint.url).origin}/health`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).status, "ready");
});

test("OpenRappter preserves /chat refusals instead of success-shaping them", async (t) => {
  const upstream = await listen((_request, response) => {
    response.writeHead(422, { "content-type": "application/json" });
    response.end(JSON.stringify({
      error: { code: "unknown-session", step: null },
    }));
  });
  t.after(() => upstream.close());
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "openrappter-chat-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const endpoint = await startOpenRappterChatEndpoint({
    betaHome: home,
    resolveTarget: () => upstream.url,
  });
  t.after(() => endpoint.stop());

  const response = await fetch(endpoint.url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ user_input: "x", session_id: "missing" }),
  });
  assert.equal(response.status, 422);
  assert.deepEqual(await response.json(), {
    error: { code: "unknown-session", step: null },
  });
});

test("the endpoint is /chat only and unavailable routes fail closed", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "openrappter-chat-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const endpoint = await startOpenRappterChatEndpoint({
    betaHome: home,
    resolveTarget: () => null,
  });

  test("instance control requires the private launch capability", async (t) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "openrappter-control-"));
    t.after(() => fs.rmSync(home, { recursive: true, force: true }));
    let stopRequests = 0;
    const instanceToken = "test-instance-capability";
    const endpoint = await startOpenRappterChatEndpoint({
      betaHome: home,
      instanceToken,
      requestStop: () => {
        stopRequests += 1;
      },
      resolveTarget: () => null,
    });
    t.after(() => endpoint.stop());
    const controlUrl = `${new URL(endpoint.url).origin}/__openrappter/control`;

    assert.equal((await fetch(controlUrl)).status, 403);
    const probe = await fetch(controlUrl, {
      headers: { "x-openrappter-instance-token": instanceToken },
    });
    assert.equal(probe.status, 200);
    assert.deepEqual(await probe.json(), {
      schema: "openrappter-instance-control/1.0",
      pid: process.pid,
      instance_token: instanceToken,
      neighborhood_id: "openrappter:alpha",
      parent_neighborhood_id: null,
      generation: 0,
      app_name: "OpenRappter",
      app_user_model_id: null,
      dock_badge: "",
      dock_visible: false,
    });
    const stop = await fetch(controlUrl, {
      method: "POST",
      headers: { "x-openrappter-instance-token": instanceToken },
    });
    assert.equal(stop.status, 202);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(stopRequests, 1);
  });
  const metadataPath = endpoint.metadataPath;
  const get = await fetch(endpoint.url);
  assert.equal(get.status, 405);
  const health = await fetch(`${new URL(endpoint.url).origin}/health`);
  assert.equal(health.status, 503);
  const unavailable = await fetch(endpoint.url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ user_input: "x" }),
  });
  assert.equal(unavailable.status, 503);
  await endpoint.stop();
  assert.equal(fs.existsSync(metadataPath), false);
});

test("headless OpenRappter and Pack Node use /chat, never UI-driver chat", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const main = fs.readFileSync(path.join(root, "electron", "main.mjs"), "utf8");
  const packNode = fs.readFileSync(path.join(root, "scripts", "rappter-pack-node.mjs"), "utf8");
  const chatCli = fs.readFileSync(path.join(root, "scripts", "openrappter-chat.mjs"), "utf8");
  const driveCli = fs.readFileSync(path.join(root, "scripts", "brainstem-chat.mjs"), "utf8");
  assert.match(packNode, /chat-endpoint\.json/);
  assert.match(chatCli, /chat-endpoint\.json/);
  assert.match(packNode, /POST|method: "POST"/);
  assert.match(chatCli, /method: "POST"/);
  assert.doesNotMatch(packNode, /action: "chat"/);
  assert.doesNotMatch(chatCli, /action: "chat"/);
  assert.match(driveCli, /action: "chat"/);
  assert.match(driveCli, /visible Brainstem chat/);
  assert.match(main, /resolveTarget: \(\) => routeManager\.activeRoute\?\.url \|\| null/);
  assert.doesNotMatch(main, /resolveTarget: \(\) => state\.url/);
});

test("installers preserve both exact-wire chat and visible UI driving", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const unix = fs.readFileSync(path.join(root, "install.sh"), "utf8");
  const windows = fs.readFileSync(path.join(root, "install.cmd"), "utf8");
  for (const installer of [unix, windows]) {
    assert.match(installer, /openrappter-chat/);
    assert.match(installer, /openrappter-drive/);
    assert.match(installer, /brainstem-chat/);
  }
  assert.match(unix, /scripts\/openrappter-chat\.mjs/);
  assert.match(unix, /scripts\/brainstem-chat\.mjs/);
  assert.match(windows, /scripts\\openrappter-chat\.mjs/);
  assert.match(windows, /scripts\\brainstem-chat\.mjs/);
});
