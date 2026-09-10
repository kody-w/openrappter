import assert from "node:assert/strict";
import { test } from "node:test";
import { TeamsConversation } from "../electron/teams-conversation.mjs";

function fakeRuntime(reply = "A useful meeting reply.") {
  const calls = { configurations: [], messages: [], disconnected: [], deleted: [], aborted: [] };
  const runtime = {
    start: async () => ({ authenticated: true }),
    client: { deleteSession: async (id) => calls.deleted.push(id) },
    createSession: async (config) => {
      calls.configurations.push(config);
      const id = `owned-${calls.configurations.length}`;
      return {
        sessionId: id,
        sendAndWait: async (message) => {
          calls.messages.push(message);
          return { data: { content: reply } };
        },
        disconnect: async () => calls.disconnected.push(id),
        abort: async () => calls.aborted.push(id),
      };
    },
  };
  return { runtime, calls };
}

test("meeting turns reuse Frontier but cannot discover or invoke local capabilities", async () => {
  const { runtime, calls } = fakeRuntime();
  const conversation = new TeamsConversation({ runtime, identity: "r1" });
  await conversation.prepare();
  const response = await conversation.respond({ text: "Help with this idea." });
  assert.equal(response.text, "A useful meeting reply.");
  const config = calls.configurations[0];
  assert.equal(config.systemMessage.mode, "append");
  assert.equal(config.enableConfigDiscovery, false);
  assert.deepEqual(config.availableTools, []);
  assert.deepEqual(config.excludedTools, ["builtin:*", "mcp:*", "custom:*"]);
  assert.equal(config.manageScheduleEnabled, false);
  assert.equal(config.onPermissionRequest({ kind: "shell" }).kind, "reject");
  assert.deepEqual(calls.disconnected, ["owned-1"]);
  assert.deepEqual(calls.deleted, ["owned-1"]);
  assert.equal(conversation.history.length, 0);
  conversation.commit(response.input, response.text);
  assert.equal(conversation.history.length, 2);
  await conversation.close();
  assert.equal(conversation.history.length, 0);
});

test("a private fresh session is cleaned up after a size error before a smaller retry", async () => {
  const { runtime, calls } = fakeRuntime();
  const create = runtime.createSession;
  let attempts = 0;
  runtime.createSession = async (config) => {
    const session = await create(config);
    const send = session.sendAndWait;
    session.sendAndWait = async (message) => {
      attempts += 1;
      if (attempts === 1) {
        calls.messages.push(message);
        throw Object.assign(new Error("Payload too large"), { status: 413 });
      }
      return send(message);
    };
    return session;
  };
  const conversation = new TeamsConversation({ runtime, identity: "r1" });
  const response = await conversation.respond({ text: "context ".repeat(800000) });
  assert.equal(response.text, "A useful meeting reply.");
  assert.ok(Buffer.byteLength(calls.messages[1].prompt) < Buffer.byteLength(calls.messages[0].prompt));
  assert.deepEqual(calls.deleted, ["owned-1", "owned-2"]);
});

test("closed conversations, missing sign-in, and invalid frames fail explicitly", async () => {
  const { runtime } = fakeRuntime();
  runtime.start = async () => ({ authenticated: false });
  const conversation = new TeamsConversation({ runtime, identity: "r1" });
  await assert.rejects(conversation.prepare(), /Sign in/);
  await assert.rejects(conversation.respond({
    text: "Look at this.",
    frame: { jpegBase64: Buffer.from("not JPEG").toString("base64") },
  }), /not JPEG/);
  await conversation.close();
  await assert.rejects(conversation.respond({ text: "late request" }), /closed/);
});

test("a cancelled question cannot publish a late model reply", async () => {
  const { runtime, calls } = fakeRuntime();
  const controller = new AbortController();
  const create = runtime.createSession;
  runtime.createSession = async (config) => {
    const session = await create(config);
    session.sendAndWait = async () => {
      controller.abort(new Error("Meeting stopped"));
      return { data: { content: "This must not be published." } };
    };
    return session;
  };
  const conversation = new TeamsConversation({ runtime, identity: "r1" });
  await assert.rejects(conversation.respond({ text: "question", signal: controller.signal }), /Meeting stopped/);
  assert.deepEqual(calls.aborted, ["owned-1"]);
  assert.deepEqual(calls.deleted, ["owned-1"]);
});

test("the assistant can stay quiet without posting a placeholder or retaining oversized history", async () => {
  const { runtime } = fakeRuntime("[NO_REPLY]");
  const conversation = new TeamsConversation({ runtime, identity: "r1" });
  const result = await conversation.respond({ text: "Acknowledged, r1." });
  assert.equal(result.text, null);
  conversation.commit("START" + "x".repeat(6_000_000) + "END", "A short answer.");
  assert.ok(Buffer.byteLength(JSON.stringify(conversation.history)) < 32 * 1024);
  assert.ok(conversation.history[0].content.startsWith("START"));
  assert.ok(conversation.history[0].content.endsWith("END"));
});
