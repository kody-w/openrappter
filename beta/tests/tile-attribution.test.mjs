import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

import { composeDimensionTilesFrameBridgeSource } from "../electron/dimension-tiles.mjs";
import {
  createFakeWindow,
  FakeCustomEvent,
  FakeDataTransfer,
  FakeDocument,
  FakeEvent,
} from "./helpers/fake-dom.mjs";

const source = readFileSync(
  new URL("../ui/dimension-tiles.js", import.meta.url),
  "utf8",
);
const css = readFileSync(
  new URL("../ui/dimension-tiles.css", import.meta.url),
  "utf8",
);

function baseTile(id = "tile-7", overrides = {}) {
  return {
    arena: { faceUp: true, seat: 1 },
    bunch: null,
    history: [],
    id,
    restorable: true,
    route: {
      compositionHash: "composition-test",
      model: "auto",
      rappid: "rapp:test",
      url: "http://127.0.0.1:7071/",
    },
    status: "parked",
    surface: "herd",
    title: `Tile ${id}`,
    turns: [{ role: "user", text: "Can you answer this?" }],
    ...overrides,
  };
}

async function waitFor(predicate, message, timeoutMs = 1500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(message);
}

async function makeTileHarness({ capture, tiles = [baseTile()] } = {}) {
  const document = new FakeDocument();
  const window = createFakeWindow(document);
  window.window = window;
  Object.assign(window, {
    AbortController,
    CSS: { escape: (value) => String(value) },
    CustomEvent: FakeCustomEvent,
    URL,
    console,
  });

  const main = document.createElement("main");
  const frame = document.createElement("iframe");
  frame.id = "brainstem";
  main.appendChild(frame);
  document.body.appendChild(main);

  const herd = document.createElement("aside");
  herd.id = "surgeon-herd";
  const grid = document.createElement("div");
  grid.className = "surgeon-grid";
  herd.appendChild(grid);
  document.body.appendChild(herd);

  const store = new Map(tiles.map((tile) => [tile.id, structuredClone(tile)]));
  const frameMessages = [];
  let captureValue = capture || {
    history: [],
    model: "auto",
    pendingRequestIds: [],
    restorable: true,
    route: baseTile().route,
    title: "Current chat",
    turns: [],
  };
  let parkedSequence = 0;
  const frameWindow = {
    postMessage(message) {
      frameMessages.push(message);
      if (message.type !== "rapp-beta:tile-capture") return;
      queueMicrotask(() => {
        window.receiveMessage({
          ok: true,
          requestId: message.requestId,
          tile: structuredClone(captureValue),
          type: "rapp-beta:tile-capture-result",
        }, frameWindow);
      });
    },
  };
  frame.contentWindow = frameWindow;

  const context = {
    api: {
      async setViewMode(next) {
        Object.assign(context.viewMode, next);
      },
      async tilesBunch(sourceId, targetId) {
        const sourceTile = store.get(sourceId);
        const targetTile = store.get(targetId);
        const bunch = targetTile.bunch || "bunch-test";
        sourceTile.bunch = bunch;
        targetTile.bunch = bunch;
        return {
          bunch,
          source: structuredClone(sourceTile),
          target: structuredClone(targetTile),
        };
      },
      async tilesComplete() {},
      async tilesDeactivate() {},
      async tilesFold(id) {
        const tile = store.get(id);
        tile.status = "folded";
        return { tile: structuredClone(tile) };
      },
      async tilesList() {
        return [...store.values()].map((tile) => structuredClone(tile));
      },
      async tilesLoadCustomLayout() {
        return { canceled: true };
      },
      async tilesMove(id, surface) {
        const tile = store.get(id);
        tile.surface = surface;
        tile.bunch = null;
        return structuredClone(tile);
      },
      async tilesPark(value) {
        const id = value.id || `tile-parked-${++parkedSequence}`;
        const tile = baseTile(id, {
          ...value,
          id,
          status: "parked",
        });
        store.set(id, tile);
        return structuredClone(tile);
      },
      async tilesParkExisting() {},
      async tilesRace(id) {
        const sourceTile = store.get(id);
        const contender = baseTile(`${id}-race`, {
          status: "racing",
          title: `${sourceTile.title} contender`,
        });
        store.set(contender.id, contender);
        return {
          contender: structuredClone(contender),
          question: sourceTile.turns.at(-1).text,
          source: structuredClone(sourceTile),
        };
      },
      async tilesUndo(id) {
        const tile = store.get(id);
        tile.status = "parked";
        return structuredClone(tile);
      },
      async tilesWake(id) {
        const tile = store.get(id);
        tile.status = "primary";
        return structuredClone(tile);
      },
      async twinChat() {
        return { response: "Twin answer" };
      },
      async twinList() {
        return [];
      },
    },
    destroyHerd() {},
    enterHerd() {},
    exitHerd() {},
    frame,
    frameGeneration: 1,
    hadHerdDom: true,
    ensureHerd: () => ({ grid, herd }),
    state: {
      arenaLayout: null,
      brainstem: {
        callerRappid: "rapp:test",
        compositionHash: "composition-test",
      },
      url: "http://127.0.0.1:7071/",
    },
    viewMode: { layout: "ring", mode: "arena", surface: "herd" },
  };

  const vmContext = vm.createContext(window);
  vm.runInContext(source, vmContext);
  await window.RappDimensionTiles.sync(context);

  return {
    context,
    document,
    frameMessages,
    frameWindow,
    handle(value) {
      return document.querySelector(`[data-drive="${value}"]`);
    },
    setCapture(value) {
      captureValue = value;
    },
    store,
    window,
  };
}

test("a driver's fold exposes Undo on the folded tile and the same verb restores it", async () => {
  const harness = await makeTileHarness();
  harness.handle("herd.tile[tile-7].fold").click();
  const undo = await waitFor(
    () => harness.handle("tiles.undo"),
    "the folded object must carry its own Undo control",
  );
  assert.equal(harness.store.get("tile-7").status, "folded");
  assert.equal(
    harness.document.querySelector(".dimension-tile-toast"),
    null,
    "a driver's fold must not toast",
  );
  const folded = harness.handle("herd.tile[tile-7]");
  assert.equal(folded.contains(undo), true);

  undo.click();
  const restored = await waitFor(
    () => {
      const tile = harness.handle("herd.tile[tile-7]");
      return tile?.dataset.status === "parked" ? tile : null;
    },
    "the folded tile Undo control did not restore the tile",
  );
  assert.equal(restored.dataset.actor, "driver");
});

test("frame-originated mutations prefer the message actor over a stale shell actor", async () => {
  const harness = await makeTileHarness({
    capture: {
      history: [{ role: "user", content: "person" }],
      model: "auto",
      pendingRequestIds: [],
      restorable: true,
      title: "Person chat",
      turns: [{ role: "user", text: "person" }],
    },
  });
  harness.document.body.dispatchEvent(new FakeEvent("click"));
  harness.window.receiveMessage({
    actor: "user",
    surface: "herd",
    type: "rapp-beta:tile-keyboard-park",
  }, harness.frameWindow);
  const personTile = await waitFor(
    () => {
      const tile = [...harness.store.values()].find(
        (candidate) => candidate.title === "Person chat",
      );
      return tile && harness.handle(`herd.tile[${tile.id}]`) ? tile : null;
    },
    "the keyboard park message did not park the chat",
  );
  const toast = await waitFor(
    () => harness.document.querySelector(".dimension-tile-toast"),
    "the person's frame-originated park should receive feedback",
  );
  assert.match(toast.textContent, /Parked "Person chat"/);
  assert.equal(
    harness.handle(`herd.tile[${personTile.id}]`).classList.contains("actor-marked"),
    false,
  );

  harness.document.body.dispatchEvent(new FakeEvent("click", { isTrusted: true }));
  harness.window.receiveMessage({
    actor: "ai",
    id: "tile-7",
    type: "rapp-beta:tile-drop-primary",
  }, harness.frameWindow);
  const primaryMark = await waitFor(
    () => harness.document.querySelector(".dimension-tile-primary-actor-mark"),
    "the primary-drop message did not wake the tile",
  );
  assert.equal(harness.store.get("tile-7").status, "primary");
  assert.equal(harness.handle("herd.tile[tile-7]"), null);
  assert.equal(primaryMark?.dataset.actor, "driver");
});

test("move attribution survives the source rerender and marks the destination", async () => {
  const harness = await makeTileHarness();
  const binder = harness.document.querySelector(
    '[data-tile-surface-target="binder"]',
  );
  const dataTransfer = new FakeDataTransfer();
  dataTransfer.setData("application/x-rapp-dimension-tile", "tile-7");
  binder.dispatchEvent(new FakeEvent("drop", {
    actor: "ai",
    dataTransfer,
  }));
  await waitFor(
    () => binder.dataset.actor === "driver",
    "the real surface drop handler did not move the tile",
  );
  assert.equal(harness.store.get("tile-7").surface, "binder");
  assert.equal(harness.handle("herd.tile[tile-7]"), null);
  assert.equal(binder.dataset.actor, "driver");
  assert.equal(binder.classList.contains("actor-marked"), true);

  harness.context.viewMode.surface = "binder";
  await harness.window.RappDimensionTiles.sync(harness.context);
  const moved = harness.handle("herd.tile[tile-7]");
  assert.equal(moved.dataset.actor, "driver");
  assert.equal(moved.classList.contains("actor-marked"), true);
});

test("race and keyboard pickup obey person-versus-driver feedback", async () => {
  const raceHarness = await makeTileHarness();
  raceHarness.handle("herd.tile[tile-7].race").click();
  const contender = await waitFor(
    () => {
      const tile = raceHarness.store.get("tile-7-race");
      return tile && raceHarness.handle(`herd.tile[${tile.id}]`)?.dataset.actor === "driver"
        ? tile
        : null;
    },
    "the race handler did not create its contender",
  );
  assert.equal(
    raceHarness.document.querySelector(".dimension-tile-toast"),
    null,
    "a driver's race must not toast",
  );
  assert.equal(
    raceHarness.handle(`herd.tile[${contender.id}]`).dataset.actor,
    "driver",
  );

  const pickupHarness = await makeTileHarness();
  pickupHarness.handle("herd.tile[tile-7]").dispatchEvent(
    new FakeEvent("keydown", { key: " " }),
  );
  assert.equal(
    pickupHarness.handle("herd.tile[tile-7]").getAttribute("aria-grabbed"),
    "false",
    "a driver must not leave the person's two-step pickup half complete",
  );
  assert.equal(pickupHarness.document.querySelector(".dimension-tile-toast"), null);

  pickupHarness.handle("herd.tile[tile-7]").dispatchEvent(
    new FakeEvent("keydown", { isTrusted: true, key: " " }),
  );
  await waitFor(
    () => pickupHarness.document.querySelector(".dimension-tile-toast"),
    "a person's keyboard pickup should receive feedback",
  );
  assert.equal(
    pickupHarness.handle("herd.tile[tile-7]").getAttribute("aria-grabbed"),
    "true",
  );
});

test("a trusted wheel fold does not inherit the driver's stale actor", async () => {
  const harness = await makeTileHarness();
  harness.document.body.dispatchEvent(new FakeEvent("click"));
  harness.handle("herd.tile[tile-7]").dispatchEvent(new FakeEvent("wheel", {
    deltaX: -100,
    deltaY: 0,
    isTrusted: true,
  }));
  const toast = await waitFor(
    () => harness.document.querySelector(".dimension-tile-toast"),
    "the wheel handler did not fold the tile",
  );
  assert.equal(harness.store.get("tile-7").status, "folded");
  assert.match(toast?.textContent || "", /Folded "Tile tile-7"/);
  assert.equal(
    harness.handle("herd.tile[tile-7]").classList.contains("actor-marked"),
    false,
  );
});

test("Open one keeps the actor captured before its animation delay", async () => {
  const harness = await makeTileHarness();
  const arrange = harness.handle("arena.arrange");
  arrange.value = "open-one";
  arrange.dispatchEvent(new FakeEvent("change", { isTrusted: true }));
  harness.document.body.dispatchEvent(new FakeEvent("click"));
  await waitFor(
    () => harness.store.get("tile-7").status === "primary",
    "Open one did not wake its selected tile",
  );
  assert.match(
    harness.document.querySelector(".dimension-tile-toast")?.textContent || "",
    /Made "Tile tile-7" primary/,
  );
  assert.equal(
    harness.document.querySelector(".dimension-tile-primary-actor-mark"),
    null,
  );
});

test("the shipped frame keyboard bridge posts its own actor", () => {
  const document = new FakeDocument();
  const header = document.createElement("header");
  document.body.appendChild(header);
  const messages = [];
  const parent = { postMessage: (message) => messages.push(message) };
  const window = createFakeWindow(document);
  window.window = window;
  window.parent = parent;
  Object.assign(window, {
    AbortController,
    Node: { TEXT_NODE: 3 },
    console,
  });
  const composed = composeDimensionTilesFrameBridgeSource("", {
    customLayoutPath: null,
    layout: "ring",
    mode: "arena",
    surface: "herd",
  });
  const dragBridge = composed.slice(composed.lastIndexOf("\n;(") + 1);
  vm.runInContext(dragBridge, vm.createContext(window));

  header.dispatchEvent(new FakeEvent("keydown", {
    actor: "ai",
    key: "h",
  }));
  assert.equal(
    messages.find((message) => message.type === "rapp-beta:tile-keyboard-park")
      ?.actor,
    "ai",
  );
});

test("the on-object markers cannot swallow a person's click", () => {
  assert.match(
    css,
    /\.dimension-tile\.actor-marked::after,[\s\S]*?pointer-events: none/,
  );
  assert.match(
    css,
    /\.dimension-tile-primary-actor-mark \{[\s\S]*?pointer-events: none/,
  );
});
