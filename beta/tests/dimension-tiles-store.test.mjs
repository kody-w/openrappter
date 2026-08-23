import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DIMENSION_TILE_SCHEMA,
  DimensionTileStore,
  MAX_DIMENSION_TILE_BYTES,
  MAX_DIMENSION_TILE_TURNS,
  registerDimensionTileIpc,
} from "../electron/dimension-tiles.mjs";

function fixtureStore(t, options = {}) {
  const betaHome = mkdtempSync(path.join(tmpdir(), "rapp-tile-store-"));
  t.after(() => rmSync(betaHome, { recursive: true, force: true }));
  let sequence = 0;
  const store = new DimensionTileStore({
    betaHome,
    idFactory: () => `tile-fixture-${String(++sequence).padStart(3, "0")}`,
    ...options,
  });
  return { betaHome, store };
}

function tileFixture(question = "What should we build?") {
  const at = "2026-08-20T20:00:00.000Z";
  return {
    title: question,
    route: {
      url: "http://127.0.0.1:7071",
      rappid: "rappid:@frontier/default:abc",
      compositionHash: "abc",
      model: "auto",
    },
    turns: [
      { role: "user", text: question, html: question, at },
      {
        role: "assistant",
        text: "A useful answer.",
        html: "<p>A useful answer.</p>",
        at,
      },
    ],
    history: [
      { role: "user", content: question },
      { role: "assistant", content: "A useful answer." },
    ],
  };
}

test("tile store parks atomic 0600 schema files and lists them by seat", (t) => {
  const { betaHome, store } = fixtureStore(t);
  const first = store.park(tileFixture());
  const second = store.park(tileFixture("Which model should race?"));

  assert.equal(first.schema, DIMENSION_TILE_SCHEMA);
  assert.equal(first.status, "parked");
  assert.equal(first.arena.seat, 1);
  assert.equal(second.arena.seat, 2);
  assert.equal(first.title, "What should we build?");
  assert.deepEqual(store.list().map((tile) => tile.id).sort(), [
    first.id,
    second.id,
  ].sort());

  const directory = path.join(betaHome, "tiles");
  const file = path.join(directory, `${first.id}.json`);
  assert.equal(existsSync(file), true);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).schema, DIMENSION_TILE_SCHEMA);
  assert.equal(
    readdirSync(directory).some((name) => name.endsWith(".tmp")),
    false,
  );
  if (process.platform !== "win32") {
    assert.equal(statSync(directory).mode & 0o777, 0o700);
    assert.equal(statSync(file).mode & 0o777, 0o600);
  }
});

test("fold keeps the tile, undo lasts ten seconds, and wake picks a primary", (t) => {
  let now = new Date("2026-08-20T20:00:00.000Z");
  const { betaHome, store } = fixtureStore(t, { now: () => now });
  const first = store.park(tileFixture());
  const second = store.park(tileFixture("Can a second tile win?"));

  const folded = store.fold(first.id);
  assert.equal(folded.tile.status, "folded");
  assert.equal(folded.tile.arena.faceUp, false);
  assert.equal(existsSync(path.join(betaHome, "tiles", `${first.id}.json`)), true);
  assert.equal(store.undo(first.id).status, "parked");

  store.fold(first.id);
  now = new Date(now.getTime() + 10_001);
  assert.throws(() => store.undo(first.id), /undo window has expired/);

  assert.equal(store.wake(second.id).status, "primary");
  assert.equal(store.read(first.id).status, "folded");
});

test("surfaces, agent payloads, and bunch membership persist in one tile document", (t) => {
  const { store } = fixtureStore(t, {
    bunchIdFactory: () => "bunch-fixture-001",
  });
  const first = store.park({
    ...tileFixture(),
    agents: [{
      filename: "proof_agent.py",
      scope: "stack:proof",
      source: "class ProofAgent:\n    pass\n",
    }],
    surface: "binder",
  });
  const second = store.park({
    ...tileFixture("Keep these together?"),
    surface: "binder",
  });

  assert.equal(first.surface, "binder");
  assert.equal(first.agents[0].filename, "proof_agent.py");
  const grouped = store.bunch(first.id, second.id);
  assert.equal(grouped.bunch, "bunch-fixture-001");
  assert.equal(store.read(first.id).bunch, grouped.bunch);
  assert.equal(store.read(second.id).bunch, grouped.bunch);

  const moved = store.move(first.id, "herd");
  assert.equal(moved.surface, "herd");
  assert.equal(moved.bunch, null);
  assert.equal(store.read(second.id).bunch, null);
  assert.equal(moved.agents[0].source, "class ProofAgent:\n    pass\n");
  assert.throws(() => store.move(first.id, "shelf"), /herd, arena, or binder/);
});

test("race creates a pending contender and waking a winner folds its rival", (t) => {
  const { store } = fixtureStore(t);
  const original = store.park(tileFixture("Which answer wins?"));
  const race = store.race(original.id);

  assert.equal(race.question, "Which answer wins?");
  assert.equal(race.source.status, "racing");
  assert.equal(race.contender.status, "racing");
  assert.equal(race.source.raceId, race.contender.raceId);
  assert.throws(
    () => store.race(race.source.id),
    /already in an unresolved race/,
  );
  assert.equal(race.contender.turns.at(-1).pending, true);
  const completed = store.complete(race.contender.id, {
    reply: "The contender replied.",
    html: "<p>The contender replied.</p>",
    requestId: "request-fixture-1",
  });

  assert.equal(completed.turns.at(-1).pending, undefined);
  assert.equal(completed.history.at(-1).content, "The contender replied.");
  const duplicate = store.complete(race.contender.id, {
    reply: "The contender replied.",
    html: "<p>The contender replied.</p>",
    requestId: "request-fixture-1",
  });
  assert.equal(duplicate.history.length, completed.history.length);

  store.wake(original.id);
  assert.equal(store.read(original.id).status, "primary");
  assert.equal(store.read(race.contender.id).status, "folded");
});

// These two were nested inside the race test above; Node cancels nested
// subtests when the parent finishes first ("cancelledByParent" on Windows).
test("a race winner folds only its paired rival", (t) => {
  let raceSequence = 0;
  const { store } = fixtureStore(t, {
    raceIdFactory: () => `race-fixture-${++raceSequence}`,
  });
  const first = store.race(store.park(tileFixture("First race?")).id);
  const second = store.race(store.park(tileFixture("Second race?")).id);

  store.wake(first.source.id);
  assert.equal(store.read(first.contender.id).status, "folded");
  assert.equal(store.read(second.source.id).status, "racing");
  assert.equal(store.read(second.contender.id).status, "racing");
});

test("a non-restorable transcript reports the reason instead of waking", (t) => {
  const { store } = fixtureStore(t);
  const tile = store.park({
    ...tileFixture(),
    restorable: false,
    restoreError: "Exact wire history was not observed.",
  });
  assert.equal(tile.restorable, false);
  assert.throws(() => store.wake(tile.id), /wire history was not observed/);
});

test("race refuses a tile whose last user turn is not a question", (t) => {
  const { store } = fixtureStore(t);
  const tile = store.park(tileFixture("Build the answer."));
  assert.throws(() => store.race(tile.id), /last user turn is a question/);
});

test("concurrent pending replies reconcile by request id", (t) => {
  const { store } = fixtureStore(t);
  const at = "2026-08-20T20:00:00.000Z";
  const tile = store.park({
    title: "Concurrent tile",
    route: tileFixture().route,
    turns: [
      { role: "user", text: "First?", html: "", at, requestId: "request-1" },
      {
        role: "assistant",
        text: "Waiting for reply...",
        html: "",
        at,
        pending: true,
        requestId: "request-1",
      },
      { role: "user", text: "Second?", html: "", at, requestId: "request-2" },
      {
        role: "assistant",
        text: "Waiting for reply...",
        html: "",
        at,
        pending: true,
        requestId: "request-2",
      },
    ],
    history: [
      { role: "user", content: "First?", requestId: "request-1" },
      { role: "user", content: "Second?", requestId: "request-2" },
    ],
  });

  store.complete(tile.id, {
    reply: "Second answer.",
    requestId: "request-2",
  });
  const completed = store.complete(tile.id, {
    reply: "First answer.",
    requestId: "request-1",
  });
  assert.deepEqual(
    completed.turns.map((turn) => [turn.text, turn.pending]),
    [
      ["First?", undefined],
      ["First answer.", undefined],
      ["Second?", undefined],
      ["Second answer.", undefined],
    ],
  );
  assert.deepEqual(
    completed.history.map((message) => [message.role, message.content]),
    [
      ["user", "First?"],
      ["assistant", "First answer."],
      ["user", "Second?"],
      ["assistant", "Second answer."],
    ],
  );
  assert(completed.history.every((message) => !("requestId" in message)));
});

test("reparking a woken pending tile preserves its placeholder and user turn", (t) => {
  const { store } = fixtureStore(t);
  const at = "2026-08-20T20:00:00.000Z";
  const question = "Will the delayed answer survive?";
  const requestId = "request-delayed-1";
  const parked = store.park({
    title: question,
    route: tileFixture().route,
    turns: [
      { role: "user", text: question, html: "", at },
      {
        role: "assistant",
        text: "Waiting for reply...",
        html: "",
        at,
        pending: true,
        requestId,
      },
    ],
    history: [{ role: "user", content: question, requestId }],
  });
  const woken = store.wake(parked.id);

  const reparked = store.park({
    ...woken,
    turns: [woken.turns[0]],
  });
  assert.deepEqual(
    reparked.turns.map((turn) => [turn.role, turn.text, turn.pending]),
    [
      ["user", question, undefined],
      ["assistant", "Waiting for reply...", true],
    ],
  );

  const completed = store.complete(reparked.id, {
    reply: "The delayed answer survived.",
    requestId,
    userInput: question,
  });
  assert.deepEqual(
    completed.turns.map((turn) => [turn.role, turn.text]),
    [
      ["user", question],
      ["assistant", "The delayed answer survived."],
    ],
  );
  assert.deepEqual(
    completed.history.map((message) => [message.role, message.content]),
    [
      ["user", question],
      ["assistant", "The delayed answer survived."],
    ],
  );
});

test("tile store enforces turn and 256 KiB caps before writing", (t) => {
  const { betaHome, store } = fixtureStore(t);
  const oversizedTurns = Array.from(
    { length: MAX_DIMENSION_TILE_TURNS + 1 },
    (_, index) => ({
      role: index % 2 ? "assistant" : "user",
      text: `turn ${index}`,
      html: "",
      at: "2026-08-20T20:00:00.000Z",
    }),
  );
  assert.throws(
    () => store.park({ ...tileFixture(), turns: oversizedTurns }),
    new RegExp(`${MAX_DIMENSION_TILE_TURNS} transcript turns`),
  );
  assert.throws(
    () => store.park({
      ...tileFixture(),
      turns: [{
        role: "user",
        text: "x".repeat(MAX_DIMENSION_TILE_BYTES),
        html: "",
        at: "2026-08-20T20:00:00.000Z",
      }],
    }),
    new RegExp(`${MAX_DIMENSION_TILE_BYTES} bytes`),
  );
  assert.equal(
    existsSync(path.join(betaHome, "tiles", "tile-fixture-001.json")),
    false,
  );
});

test("oversized or invalid on-disk tiles are reported without hiding valid tiles", (t) => {
  const { betaHome, store } = fixtureStore(t);
  const valid = store.park(tileFixture());
  const invalidId = "tile-invalid-oversized";
  const directory = path.join(betaHome, "tiles");
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    path.join(directory, `${invalidId}.json`),
    " ".repeat(MAX_DIMENSION_TILE_BYTES + 1),
  );

  assert.throws(() => store.read(invalidId), /exceeds the 262144 byte limit/);
  const tiles = store.list();
  assert(tiles.some((tile) => tile.id === valid.id && tile.restorable));
  const unavailable = tiles.find((tile) => tile.id === invalidId);
  assert.equal(unavailable.restorable, false);
  assert.match(unavailable.restoreError, /exceeds the 262144 byte limit/);
});

test("tile IPC is inert off except identified durable completions", async (t) => {
  const { store } = fixtureStore(t);
  const handlers = new Map();
  let trusted = 0;
  let enabled = false;
  registerDimensionTileIpc({
    assertTrustedIpc: () => { trusted += 1; },
    ipcMain: {
      handle(name, handler) {
        handlers.set(name, handler);
      },
    },
    isEnabled: () => enabled,
    store,
  });

  assert.deepEqual([...handlers.keys()].sort(), [
    "beta:tiles-bunch",
    "beta:tiles-complete",
    "beta:tiles-deactivate",
    "beta:tiles-fold",
    "beta:tiles-list",
    "beta:tiles-move",
    "beta:tiles-park",
    "beta:tiles-park-existing",
    "beta:tiles-race",
    "beta:tiles-undo",
    "beta:tiles-wake",
  ]);
  assert.throws(() => handlers.get("beta:tiles-list")({}), /Agent Arena is not active/);
  const pending = store.park({
    ...tileFixture(),
    turns: [
      ...tileFixture().turns.slice(0, 1),
      {
        role: "assistant",
        text: "Waiting for reply...",
        html: "",
        at: "2026-08-20T20:00:00.000Z",
        pending: true,
        requestId: "request-off-1",
      },
    ],
    history: [{
      role: "user",
      content: "What should we build?",
      requestId: "request-off-1",
    }],
  });
  const completedOff = handlers.get("beta:tiles-complete")(
    {},
    pending.id,
    {
      reply: "Durable while off.",
      requestId: "request-off-1",
    },
  );
  assert.equal(completedOff.history.at(-1).content, "Durable while off.");
  assert.throws(
    () => handlers.get("beta:tiles-complete")(
      {},
      pending.id,
      { reply: "Unexpected.", requestId: "request-off-2" },
    ),
    /existing pending tile/,
  );
  enabled = true;
  assert.equal(
    handlers.get("beta:tiles-park-existing")({}, pending.id).status,
    "parked",
  );
  assert.equal(handlers.get("beta:tiles-list")({})[0].id, pending.id);
  assert.equal(trusted, 5);
});

test("tile IPC captures, activates, and deactivates agent payloads around durable state", async (t) => {
  const { store } = fixtureStore(t);
  const handlers = new Map();
  const events = [];
  registerDimensionTileIpc({
    activateTile: async (tile) => {
      events.push(`activate:${tile.agents[0].filename}`);
    },
    assertTrustedIpc: () => {},
    captureActivePayload: async () => ({
      agents: [{
        filename: "tile_proof_agent.py",
        scope: "stack:fixture",
        source: "class TileProofAgent:\n    pass\n",
      }],
      route: {
        compositionHash: "tile-composition",
        rappid: tileFixture().route.rappid,
      },
    }),
    deactivatePrimary: async () => {
      events.push("deactivate");
    },
    ipcMain: {
      handle(name, handler) {
        handlers.set(name, handler);
      },
    },
    isEnabled: () => true,
    store,
  });

  const parked = await handlers.get("beta:tiles-park")({}, tileFixture());
  assert.equal(parked.agents[0].filename, "tile_proof_agent.py");
  assert.equal(parked.route.compositionHash, "tile-composition");
  const primary = await handlers.get("beta:tiles-wake")({}, parked.id);
  assert.equal(primary.status, "primary");
  await handlers.get("beta:tiles-deactivate")({});
  assert.deepEqual(events, ["activate:tile_proof_agent.py", "deactivate"]);
});
