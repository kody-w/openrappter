import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { launch } from "./harness/launch.mjs";
import { frontierTest } from "./harness/test-support.mjs";

const QUESTION = "Which path wins?";
const FIRST_REPLY = "FIRST_TILE_REPLY: preserve the delayed dimension.";
const SECOND_REPLY = "SECOND_TILE_REPLY: compare a fresh dimension.";
const FOLLOW_UP = "What did the first dimension answer?";
const FOLLOW_UP_REPLY = "FOLLOW_UP_REPLY: the first history was restored.";
const TILE_TOOL_SOURCE = `from agents.basic_agent import BasicAgent

class TileProofAgent(BasicAgent):
    def __init__(self):
        self.name = "TileProof"
        self.metadata = {
            "name": self.name,
            "description": "Use this tool when asked for the tile proof.",
            "parameters": {"type": "object", "properties": {}},
        }
        super().__init__()

    def perform(self, **kwargs):
        return "TILE_TOOL_CALLED"
`;
const CHECKPOINT_OUTLINE = JSON.parse(readFileSync(
  new URL("./fixtures/frontier-checkpoint-herd-outline.json", import.meta.url),
  "utf8",
));

async function waitFor(predicate, {
  intervalMs = 100,
  label = "condition",
  timeoutMs = 20_000,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(
    `Timed out waiting for ${label}: ${String(lastError?.message || lastError || "")}`,
  );
}

function readTiles(tilesDirectory) {
  if (!existsSync(tilesDirectory)) return [];
  return readdirSync(tilesDirectory)
    .filter((name) => /^tile-.*\.json$/.test(name))
    .map((name) => JSON.parse(readFileSync(path.join(tilesDirectory, name), "utf8")));
}

async function activeHealth(app) {
  const telemetry = await app.driver.routeTelemetry({ trace: false });
  const response = await fetch(`${telemetry.active_route.url}/health`, {
    signal: AbortSignal.timeout(5_000),
  });
  assert.equal(response.ok, true);
  return {
    health: await response.json(),
    route: telemetry.active_route,
  };
}

function stableOutline(outline) {
  return (outline.rows || []).map((row) => ({
    h: row.h,
    name: row.name,
    role: row.role,
    state: row.state,
  }));
}

async function sendBrainstem(app, text, {
  settleMs = 60,
} = {}) {
  await app.driver.run([
    {
      action: "type",
      selector: "#input",
      typingDelayMs: 0,
      value: text,
    },
    {
      action: "click",
      selector: "#send",
      settleMs,
    },
  ]);
}

frontierTest("dimension tiles preserve delayed races, wake history, folds, and herd identity", async () => {
  const app = await launch({
    modelScript: {
      steps: [
        {
          when: { index: 1, lastUser: QUESTION },
          response: { delayMs: 1600, text: FIRST_REPLY },
        },
        {
          when: { index: 2, lastUser: QUESTION },
          response: { delayMs: 120, text: SECOND_REPLY },
        },
        {
          when: { index: 3, lastUser: FOLLOW_UP },
          response: { delayMs: 80, text: FOLLOW_UP_REPLY },
        },
      ],
    },
    scenario: "dimension-tiles",
  });
  try {
    await app.driver.run([{
      action: "click",
      optional: true,
      selector: "#enter",
      settleMs: 100,
    }], { target: "shell" });
    const initialOutline = stableOutline(
      await app.driver.inspect({ target: "shell" }),
    );
    assert.deepEqual(initialOutline, CHECKPOINT_OUTLINE);

    await sendBrainstem(app, "agent arena");
    await app.driver.expect({
      selector: "header[data-drive=\"brainstem.primary\"]",
      timeoutMs: 10_000,
    });
    await app.driver.run([{
      action: "click",
      targetText: "Clear",
      settleMs: 100,
    }]);

    await sendBrainstem(app, QUESTION, { settleMs: 40 });
    await waitFor(() => app.model.requests.length >= 1, {
      label: "first delayed model request to be accepted",
    });
    await app.driver.run([{
      action: "press",
      handle: "@brainstem.primary",
      key: "h",
      settleMs: 80,
    }]);
    await app.driver.expect({
      selector: ".dimension-tile",
      target: "shell",
      text: QUESTION,
      timeoutMs: 10_000,
    });
    const tilesDirectory = path.join(app.paths.betaHome, "tiles");
    await waitFor(() => readTiles(tilesDirectory).length === 1, {
      label: "first parked tile file",
    });
    await app.driver.run([{
      action: "expect",
      selector: "#input",
      state: "empty",
    }]);

    await sendBrainstem(app, QUESTION);
    await app.driver.expect({
      selector: "#chat",
      text: SECOND_REPLY,
      timeoutMs: 10_000,
    });
    await app.driver.run([{
      action: "press",
      handle: "@brainstem.primary",
      key: "h",
      settleMs: 80,
    }]);

    const twoTiles = await waitFor(() => {
      const tiles = readTiles(tilesDirectory);
      return tiles.length === 2
        && tiles.some((tile) => tile.history.at(-1)?.content === FIRST_REPLY)
        && tiles.some((tile) => tile.history.at(-1)?.content === SECOND_REPLY)
        ? tiles
        : null;
    }, {
      label: "both complete tile files",
      timeoutMs: 15_000,
    });
    const first = twoTiles.find((tile) => (
      tile.history.at(-1)?.content === FIRST_REPLY
    ));
    const second = twoTiles.find((tile) => (
      tile.history.at(-1)?.content === SECOND_REPLY
    ));
    assert(first);
    assert(second);
    assert.equal(first.turns.at(-1).pending, undefined);

    await app.driver.run([{
      action: "swipe",
      direction: "right",
      distance: 110,
      handle: `@herd.tile[${first.id}]`,
      settleMs: 150,
    }], { target: "shell" });
    await app.driver.expect({
      selector: "#chat",
      text: FIRST_REPLY,
      timeoutMs: 10_000,
    });

    await sendBrainstem(app, FOLLOW_UP);
    await app.driver.expect({
      selector: "#chat",
      text: FOLLOW_UP_REPLY,
      timeoutMs: 10_000,
    });
    const followRequest = app.model.requests.find((request) => (
      request.request.messages.some((message) => (
        message.role === "user" && message.content === FOLLOW_UP
      ))
    ));
    assert(followRequest, "the follow-up model request must be captured");
    const conversationPrefix = followRequest.request.messages
      .filter((message) => ["user", "assistant"].includes(message.role))
      .slice(0, 3)
      .map((message) => [message.role, message.content]);
    assert.deepEqual(conversationPrefix, [
      ["user", QUESTION],
      ["assistant", FIRST_REPLY],
      ["user", FOLLOW_UP],
    ]);
    await waitFor(() => {
      const saved = readTiles(tilesDirectory).find((tile) => tile.id === first.id);
      return saved?.history.at(-1)?.content === FOLLOW_UP_REPLY ? saved : null;
    }, { label: "active tile continuation to persist" });

    await app.driver.run([{
      action: "click",
      handle: `@herd.tile[${second.id}].fold`,
      settleMs: 120,
    }], { target: "shell" });
    await waitFor(
      () => readTiles(tilesDirectory).find((tile) => (
        tile.id === second.id && tile.status === "folded"
      )),
      { label: "folded tile file" },
    );

    await sendBrainstem(app, "herd");
    await waitFor(async () => {
      const outline = await app.driver.inspect({ target: "shell" });
      return outline.rows.some((row) => String(row.h).startsWith("@herd.tile["))
        ? null
        : outline;
    }, { label: "tile handles to disappear" });
    const offOutline = stableOutline(
      await app.driver.inspect({ target: "shell" }),
    );
    assert.deepEqual(offOutline, CHECKPOINT_OUTLINE);
    await assert.rejects(
      app.driver.command({
        action: "read",
        selector: "#surgeon-herd",
        target: "shell",
      }),
      /not found/,
    );
    assert.equal(readTiles(tilesDirectory).length, 2);

    await sendBrainstem(app, "agent arena");
    await app.driver.expect({
      selector: `[data-dimension-tile="${first.id}"]`,
      target: "shell",
      text: first.title,
      timeoutMs: 10_000,
    });
    assert.equal(readTiles(tilesDirectory).length, 2);
  } finally {
    await app.stop();
  }
});

frontierTest("tile drag semantics hot-load agents, swap safely, and preserve binder bunches", async () => {
  const outgoingQuestion = "Park this primary conversation.";
  const outgoingReply = "OUTGOING_PRIMARY_REPLY";
  const tileQuestion = "What capability does this tile carry?";
  const tileReply = "TILE_CONVERSATION_REPLY";
  const toolQuestion = "Use the tile proof now.";
  const toolReply = "TILE_TOOL_REPLY";
  const swapQuestion = "Keep this conversation during the swap.";
  const swapReply = "SWAP_OUTGOING_REPLY";
  const fixtureId = "tile-hotload-fixture";
  const app = await launch({
    modelScript: {
      steps: [
        {
          when: { index: 1, lastUser: outgoingQuestion },
          response: { text: outgoingReply },
        },
        {
          when: {
            index: 2,
            lastUser: toolQuestion,
            hasTool: "TileProof",
          },
          response: {
            toolCalls: [{ name: "TileProof", arguments: {} }],
          },
        },
        {
          when: { index: 3, hasToolResult: "TileProof" },
          response: { text: toolReply },
        },
        {
          when: { index: 4, lastUser: swapQuestion },
          response: { text: swapReply },
        },
      ],
    },
    scenario: "dimension-tile-drag-semantics",
  });
  try {
    await app.driver.run([{
      action: "click",
      optional: true,
      selector: "#enter",
      settleMs: 100,
    }], { target: "shell" });
    const tilesDirectory = path.join(app.paths.betaHome, "tiles");
    mkdirSync(tilesDirectory, { recursive: true });
    const at = "2026-08-21T13:00:00.000Z";
    const route = app.route.telemetry.active_route;
    const identity = JSON.parse(readFileSync(
      path.join(app.paths.betaHome, "routing", "identity.json"),
      "utf8",
    ));
    writeFileSync(
      path.join(tilesDirectory, `${fixtureId}.json`),
      `${JSON.stringify({
        schema: "rapp-dimension-tile/1.0",
        id: fixtureId,
        title: "Tile proof companion",
        createdAt: at,
        parkedAt: at,
        route: {
          url: route.url,
          rappid: identity.caller_rappid,
          compositionHash: route.composition_hash,
          model: "auto",
        },
        turns: [
          { role: "user", text: tileQuestion, html: "", at },
          { role: "assistant", text: tileReply, html: "", at },
        ],
        history: [
          { role: "user", content: tileQuestion },
          { role: "assistant", content: tileReply },
        ],
        status: "parked",
        surface: "herd",
        bunch: null,
        agents: [{
          filename: "tile_proof_agent.py",
          scope: "tile",
          source: TILE_TOOL_SOURCE,
        }],
        arena: { seat: 1, faceUp: true },
        restorable: true,
        restoreError: null,
        raceId: null,
        completedRequestIds: [],
      }, null, 2)}\n`,
      { mode: 0o600 },
    );

    await sendBrainstem(app, "agent arena");
    await app.driver.expect({
      selector: `[data-dimension-tile="${fixtureId}"]`,
      target: "shell",
      text: "Tile proof companion",
      timeoutMs: 10_000,
    });
    await app.driver.run([{
      action: "click",
      targetText: "Clear",
      settleMs: 100,
    }]);

    await sendBrainstem(app, outgoingQuestion);
    await app.driver.expect({
      selector: "#chat",
      text: outgoingReply,
      timeoutMs: 10_000,
    });
    await app.driver.run([{
      action: "press",
      handle: "@brainstem.primary",
      key: "h",
      settleMs: 150,
    }]);
    await app.driver.run([{
      action: "expect",
      selector: "#input",
      state: "empty",
    }]);
    const afterChatPark = await waitFor(() => {
      const tiles = readTiles(tilesDirectory);
      return tiles.length === 2
        && tiles.some((tile) => tile.history.at(-1)?.content === outgoingReply)
        ? tiles
        : null;
    }, { label: "chat parked with a fresh primary left behind" });

    await app.driver.run([{
      action: "press",
      handle: `@herd.tile[${fixtureId}]`,
      key: "Enter",
      settleMs: 150,
    }], { target: "shell" });
    await app.driver.expect({
      selector: "#chat",
      text: tileReply,
      timeoutMs: 15_000,
    });
    assert.equal(readTiles(tilesDirectory).length, afterChatPark.length);
    await waitFor(async () => {
      const { health } = await activeHealth(app);
      return health.agents.includes("TileProof") ? health : null;
    }, { label: "tile tool in active worker health" });

    await sendBrainstem(app, toolQuestion);
    await app.driver.expect({
      selector: "#chat",
      text: toolReply,
      timeoutMs: 15_000,
    });
    assert(
      app.model.requests.some((request) => (
        request.request.messages.some((message) => (
          message.role === "tool"
          && message.name === "TileProof"
          && message.content.includes("TILE_TOOL_CALLED")
        ))
      )),
      "the next visible turn must call the tile tool",
    );

    await app.driver.run([{
      action: "press",
      handle: "@brainstem.primary",
      key: "b",
      settleMs: 150,
    }]);
    await waitFor(async () => {
      const saved = readTiles(tilesDirectory).find((tile) => tile.id === fixtureId);
      const { health } = await activeHealth(app);
      return saved?.surface === "binder" && !health.agents.includes("TileProof")
        ? saved
        : null;
    }, { label: "parked tile tool to leave the active worker" });

    await app.driver.run([{
      action: "click",
      handle: "@tiles.surface.binder",
      settleMs: 100,
    }], { target: "shell" });
    await app.driver.expect({
      selector: `[data-dimension-tile="${fixtureId}"]`,
      target: "shell",
      text: toolReply,
      timeoutMs: 10_000,
    });
    await app.driver.run([{
      action: "press",
      handle: `@herd.tile[${fixtureId}]`,
      key: "h",
      settleMs: 100,
    }], { target: "shell" });
    await waitFor(() => (
      readTiles(tilesDirectory).find((tile) => (
        tile.id === fixtureId && tile.surface === "herd"
      ))
    ), { label: "tile moved back from binder to herd" });
    await app.driver.run([{
      action: "click",
      handle: "@tiles.surface.herd",
      settleMs: 100,
    }], { target: "shell" });

    const outgoingTile = readTiles(tilesDirectory).find((tile) => (
      tile.history.at(-1)?.content === outgoingReply
    ));
    assert(outgoingTile);
    const routeBeforeBunch = (await activeHealth(app)).route.composition_hash;
    const bunchResult = await app.driver.command({
      action: "autopilot",
      script: `tile.bunch ${fixtureId} ${outgoingTile.id} --speed instant`,
      target: "shell",
    });
    assert.equal(bunchResult.ok, true);
    const bunched = await waitFor(() => {
      const tiles = readTiles(tilesDirectory);
      const first = tiles.find((tile) => tile.id === fixtureId);
      const second = tiles.find((tile) => tile.id === outgoingTile.id);
      return first?.bunch && first.bunch === second?.bunch ? first.bunch : null;
    }, { label: "two dormant tiles to persist one bunch" });
    assert.match(bunched, /^bunch-/);
    assert.equal((await activeHealth(app)).route.composition_hash, routeBeforeBunch);

    await sendBrainstem(app, swapQuestion);
    await app.driver.expect({
      selector: "#chat",
      text: swapReply,
      timeoutMs: 10_000,
    });
    await app.driver.run([{
      action: "press",
      handle: `@herd.tile[${fixtureId}]`,
      key: "Enter",
      settleMs: 150,
    }], { target: "shell" });
    await app.driver.expect({
      selector: "#chat",
      text: toolReply,
      timeoutMs: 15_000,
    });
    const afterSwap = await waitFor(() => {
      const tiles = readTiles(tilesDirectory);
      const incoming = tiles.find((tile) => tile.id === fixtureId);
      const outgoing = tiles.find((tile) => (
        tile.history.at(-1)?.content === swapReply
      ));
      return incoming?.status === "primary"
        && incoming.bunch === null
        && outgoing?.surface === "herd"
        && tiles.find((tile) => tile.id === outgoingTile.id)?.bunch === null
        ? tiles
        : null;
    }, { label: "conversation swap with no lost tile or orphaned bunch" });
    assert.equal(afterSwap.length, 3);
  } finally {
    await app.stop();
  }
});

frontierTest("Race stages one contender, renders one reply, and folds only its rival", async () => {
  const raceQuestion = "Can these models race?";
  const originalReply = "RACE_ORIGINAL_REPLY";
  const contenderReply = "RACE_CONTENDER_REPLY";
  const afterClearQuestion = "Does Clear detach the winner?";
  const afterClearReply = "AFTER_CLEAR_REPLY";
  const app = await launch({
    modelScript: {
      steps: [
        {
          when: { index: 1, lastUser: raceQuestion },
          response: { text: originalReply },
        },
        {
          when: { index: 2, lastUser: raceQuestion },
          response: { text: contenderReply },
        },
        {
          when: { index: 3, lastUser: afterClearQuestion },
          response: { text: afterClearReply },
        },
      ],
    },
    scenario: "dimension-tiles-race",
  });
  try {
    await app.driver.run([{
      action: "click",
      optional: true,
      selector: "#enter",
      settleMs: 100,
    }], { target: "shell" });
    await sendBrainstem(app, "agent arena");
    await app.driver.expect({
      selector: "header[data-drive=\"brainstem.primary\"]",
      timeoutMs: 10_000,
    });
    await app.driver.run([{
      action: "click",
      targetText: "Clear",
      settleMs: 100,
    }]);

    await sendBrainstem(app, raceQuestion);
    await app.driver.expect({
      selector: "#chat",
      text: originalReply,
      timeoutMs: 10_000,
    });
    await app.driver.run([{
      action: "press",
      handle: "@brainstem.primary",
      key: "h",
      settleMs: 100,
    }]);
    const tilesDirectory = path.join(app.paths.betaHome, "tiles");
    const [source] = await waitFor(() => {
      const tiles = readTiles(tilesDirectory);
      return tiles.length === 1 ? tiles : null;
    }, { label: "race source tile" });
    await app.driver.expect({
      selector: `[data-dimension-tile="${source.id}"]`,
      target: "shell",
      text: source.title,
      timeoutMs: 10_000,
    });

    await app.driver.run([{
      action: "click",
      handle: `@herd.tile[${source.id}].race`,
      settleMs: 100,
    }], { target: "shell" });
    await app.driver.run([{
      action: "expect",
      selector: "#input",
      state: "filled",
    }]);
    const staged = await waitFor(() => {
      const tiles = readTiles(tilesDirectory);
      return tiles.length === 2
        && tiles.every((tile) => tile.status === "racing")
        ? tiles
        : null;
    }, { label: "paired racing tiles" });
    const contender = staged.find((tile) => tile.id !== source.id);
    assert.equal(contender.raceId, staged.find((tile) => tile.id === source.id).raceId);

    await app.driver.run([{
      action: "click",
      selector: "#send",
      settleMs: 60,
    }]);
    await app.driver.expect({
      selector: "#chat",
      text: contenderReply,
      timeoutMs: 10_000,
    });
    await waitFor(() => {
      const saved = readTiles(tilesDirectory).find((tile) => (
        tile.id === contender.id
      ));
      return saved?.history.at(-1)?.content === contenderReply ? saved : null;
    }, { label: "race contender completion" });
    const transcript = await app.driver.command({
      action: "read",
      selector: "#chat",
    });
    assert.equal(transcript.text.split(contenderReply).length - 1, 1);
    assert.equal(readTiles(tilesDirectory).length, 2);

    await app.driver.run([{
      action: "swipe",
      direction: "right",
      distance: 110,
      handle: `@herd.tile[${contender.id}]`,
      settleMs: 150,
    }], { target: "shell" });
    await waitFor(() => {
      const tiles = readTiles(tilesDirectory);
      const winner = tiles.find((tile) => tile.id === contender.id);
      const rival = tiles.find((tile) => tile.id === source.id);
      return winner?.status === "primary" && rival?.status === "folded"
        ? tiles
        : null;
    }, { label: "race winner and folded rival" });
    assert.equal(readTiles(tilesDirectory).length, 2);

    await app.driver.run([{
      action: "click",
      targetText: "Clear",
      settleMs: 100,
    }]);
    await waitFor(() => {
      const saved = readTiles(tilesDirectory).find((tile) => (
        tile.id === contender.id
      ));
      return saved?.status === "parked" ? saved : null;
    }, { label: "cleared winner to detach" });
    await sendBrainstem(app, afterClearQuestion);
    await app.driver.expect({
      selector: "#chat",
      text: afterClearReply,
      timeoutMs: 10_000,
    });
    await app.driver.run([{
      action: "press",
      handle: "@brainstem.primary",
      key: "h",
      settleMs: 100,
    }]);
    const afterClearTiles = await waitFor(() => {
      const tiles = readTiles(tilesDirectory);
      return tiles.length === 3 ? tiles : null;
    }, { label: "new tile after manual Clear" });
    assert.equal(
      afterClearTiles.find((tile) => tile.id === contender.id)
        .history.at(-1).content,
      contenderReply,
    );
  } finally {
    await app.stop();
  }
});
