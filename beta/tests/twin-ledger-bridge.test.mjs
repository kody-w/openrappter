import assert from "node:assert/strict";
import vm from "node:vm";
import test from "node:test";

import {
  createTwinLedgerBridgeSource,
} from "../electron/twin-ledger-bridge.mjs";


function installBridge(nativeFetch, { sink = "preload" } = {}) {
  const turns = [];
  const parentMessages = [];
  let refreshCount = 0;
  const window = {
    crypto: { randomUUID: () => "twin-request" },
    fetch: nativeFetch,
    location: { href: "http://127.0.0.1:7080/" },
    rappTwinLedger: {
      recordCompletedTurn: async (turn) => {
        turns.push(turn);
      },
      refreshAmbient: async () => {
        refreshCount += 1;
      },
    },
    top: {
      postMessage: (message) => parentMessages.push(message),
    },
  };
  vm.runInNewContext(
    createTwinLedgerBridgeSource({
      sink,
      twinId: "weather-1",
    }),
    {
      JSON,
      Request,
      TextDecoder,
      URL,
      window,
    },
  );
  return {
    get refreshCount() {
      return refreshCount;
    },
    parentMessages,
    turns,
    window,
  };
}

function controlledResponse() {
  let controller;
  let canceled = false;
  const body = new ReadableStream({
    start(value) {
      controller = value;
    },
    cancel() {
      canceled = true;
    },
  });
  return {
    close: () => controller.close(),
    enqueue: (text) => controller.enqueue(new TextEncoder().encode(text)),
    get canceled() {
      return canceled;
    },
    response: new Response(body, {
      headers: { "Content-Type": "text/event-stream" },
    }),
  };
}

function sse(event) {
  return `data: ${JSON.stringify(event)}\n\n`;
}

test("twin non-stream responses record only after the UI consumes completion", async () => {
  const nativeResponse = new Response(JSON.stringify({
    response: "sunny",
    session_id: "twin-session",
    agent_logs: "[WeatherAgent] forecast",
    model: "scripted",
  }), {
    headers: { "Content-Type": "application/json" },
  });
  const installed = installBridge(async () => nativeResponse);
  const response = await installed.window.fetch(
    "http://127.0.0.1:7080/chat",
    {
      method: "POST",
      body: JSON.stringify({ user_input: "weather here" }),
    },
  );
  assert.strictEqual(response, nativeResponse);
  assert.equal(installed.refreshCount, 1);
  assert.equal(installed.turns.length, 0);
  assert.equal((await response.json()).response, "sunny");
  assert.equal(installed.turns.length, 1);
  assert.equal(installed.turns[0].requestId, "twin-request");
  assert.equal(installed.turns[0].userInput, "weather here");
});

test("twin stream responses require clean EOF after the terminal event", async () => {
  const upstream = controlledResponse();
  const installed = installBridge(async () => upstream.response);
  const response = await installed.window.fetch(
    "http://127.0.0.1:7080/chat/stream",
    {
      method: "POST",
      body: JSON.stringify({ user_input: "weather here" }),
    },
  );
  assert.strictEqual(response, upstream.response);
  const reader = response.body.getReader();
  upstream.enqueue(sse({ type: "delta", text: "sun" }));
  upstream.enqueue(sse({
    type: "done",
    response: "sunny",
    session_id: "twin-session",
    agent_logs: "[WeatherAgent] forecast",
    model: "scripted",
  }));
  await reader.read();
  await reader.read();
  assert.equal(installed.turns.length, 0);
  upstream.close();
  assert.equal((await reader.read()).done, true);
  assert.equal(installed.turns.length, 1);
  assert.equal(installed.turns[0].response, "sunny");
});

test("cancelled twin streams do not record and parent sinks retain twin identity", async () => {
  const upstream = controlledResponse();
  const installed = installBridge(
    async () => upstream.response,
    { sink: "parent" },
  );
  const response = await installed.window.fetch(
    "http://127.0.0.1:7080/chat/stream",
    {
      method: "POST",
      body: JSON.stringify({ user_input: "cancel me" }),
    },
  );
  const reader = response.body.getReader();
  upstream.enqueue(sse({
    type: "done",
    response: "not delivered",
  }));
  await reader.read();
  await reader.cancel();
  assert.equal(upstream.canceled, true);
  assert.equal(installed.parentMessages.length, 1);
  assert.equal(installed.parentMessages[0].turn.settledOnly, true);

  const complete = controlledResponse();
  const parent = installBridge(
    async () => complete.response,
    { sink: "parent" },
  );
  const completedResponse = await parent.window.fetch(
    "http://127.0.0.1:7080/chat/stream",
    {
      method: "POST",
      body: JSON.stringify({ user_input: "complete me" }),
    },
  );
  const completeReader = completedResponse.body.getReader();
  complete.enqueue(sse({ type: "done", response: "delivered" }));
  await completeReader.read();
  complete.close();
  await completeReader.read();
  assert.equal(parent.parentMessages.length, 1);
  assert.equal(parent.parentMessages[0].twinId, "weather-1");
  assert.equal(parent.parentMessages[0].type, "rapp-beta:twin-ledger-turn");
});
