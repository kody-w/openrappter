import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { uiDriverInternals } from "../electron/ui-driver-server.mjs";
import {
  createAutopilotInstallationSource,
  instrumentRappUi,
} from "../electron/injection-sources.mjs";
import { createAutopilot } from "../ui/autopilot.js";

class FakeEvent {
  constructor(type, options = {}) {
    this.type = type;
    this.bubbles = options.bubbles !== false;
    this.cancelable = options.cancelable !== false;
    this.defaultPrevented = false;
    this.detail = options.detail;
    this.key = options.key || "";
    this.code = options.code || "";
    this.pointerId = options.pointerId || 1;
    this.clientX = options.clientX || 0;
    this.clientY = options.clientY || 0;
    this.dataTransfer = options.dataTransfer || null;
    this.target = null;
    this.currentTarget = null;
    this.propagationStopped = false;
    this.immediateStopped = false;
  }

  preventDefault() {
    if (this.cancelable) this.defaultPrevented = true;
  }

  stopPropagation() {
    this.propagationStopped = true;
  }

  stopImmediatePropagation() {
    this.immediateStopped = true;
    this.propagationStopped = true;
  }
}

class FakeCustomEvent extends FakeEvent {}
class FakeDragEvent extends FakeEvent {}
class FakeKeyboardEvent extends FakeEvent {}
class FakePointerEvent extends FakeEvent {}

class FakeDataTransfer {
  constructor() {
    this.data = new Map();
    this.dropEffect = "none";
    this.effectAllowed = "all";
    this.files = [];
    this.items = [];
  }

  get types() {
    return [...this.data.keys()];
  }

  clearData(type) {
    if (type) this.data.delete(type);
    else this.data.clear();
  }

  getData(type) {
    return this.data.get(type) || "";
  }

  setData(type, value) {
    this.data.set(String(type), String(value));
  }
}

class FakeClassList {
  constructor(names = []) {
    this.names = new Set(names);
  }

  add(...names) {
    names.forEach((name) => this.names.add(name));
  }

  contains(name) {
    return this.names.has(name);
  }

  remove(...names) {
    names.forEach((name) => this.names.delete(name));
  }

  toggle(name, force) {
    const next = force === undefined ? !this.names.has(name) : Boolean(force);
    if (next) this.names.add(name);
    else this.names.delete(name);
    return next;
  }

  toString() {
    return [...this.names].join(" ");
  }
}

function selectorMatches(element, selector) {
  const value = selector.trim();
  if (!value) return false;
  if (value === "[data-drive]") return Boolean(element.dataset.drive);
  if (value === "[data-dimension-tile]") {
    return Boolean(element.dataset.dimensionTile);
  }
  if (value === "[tabindex]") return element.tabIndex !== undefined;
  if (value === "a[href]") {
    return element.localName === "a" && Boolean(element.getAttribute("href"));
  }
  if (value.startsWith("#")) return element.id === value.slice(1);
  if (value.startsWith(".")) {
    return value.slice(1).split(".").every((name) => element.classList.contains(name));
  }
  return element.localName === value.toLowerCase();
}

class FakeElement {
  constructor(ownerDocument, tagName = "div") {
    this.ownerDocument = ownerDocument;
    this.localName = tagName.toLowerCase();
    this.tagName = tagName.toUpperCase();
    this.id = "";
    this.dataset = {};
    this.attributes = new Map();
    this.children = [];
    this.parentElement = null;
    this.listeners = new Map();
    this.classList = new FakeClassList();
    this.style = {};
    this.textContent = "";
    this.value = "";
    this.disabled = false;
    this.tabIndex = undefined;
    this.rect = { left: 20, top: 20, width: 120, height: 48 };
  }

  get isConnected() {
    let node = this;
    while (node) {
      if (node === this.ownerDocument.body) return true;
      node = node.parentElement;
    }
    return false;
  }

  addEventListener(type, listener, options = {}) {
    const entries = this.listeners.get(type) || [];
    entries.push({
      capture: options === true || options?.capture === true,
      listener,
      once: options?.once === true,
    });
    this.listeners.set(type, entries);
  }

  append(...children) {
    children.forEach((child) => this.appendChild(child));
  }

  appendChild(child) {
    child.parentElement?.removeChild(child);
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  click() {
    if (this.disabled) return;
    this.dispatchEvent(new FakeEvent("click", { bubbles: true, cancelable: true }));
  }

  closest(selector) {
    const selectors = selector.split(",");
    let node = this;
    while (node) {
      if (selectors.some((candidate) => selectorMatches(node, candidate))) return node;
      node = node.parentElement;
    }
    return null;
  }

  contains(element) {
    if (element === this) return true;
    return this.children.some((child) => child.contains(element));
  }

  focus() {
    this.ownerDocument.activeElement = this;
  }

  dispatchEvent(event) {
    if (!event.target) event.target = this;
    const path = [];
    let node = this;
    while (node) {
      path.push(node);
      node = node.parentElement;
    }
    path.push(this.ownerDocument);
    const capturePath = [...path].reverse();
    for (const target of capturePath) {
      target.invokeListeners?.(event, true);
      if (event.propagationStopped) return !event.defaultPrevented;
    }
    for (const target of path) {
      target.invokeListeners?.(event, false);
      if (event.propagationStopped) break;
    }
    return !event.defaultPrevented;
  }

  getAttribute(name) {
    if (name === "class") return this.classList.toString();
    if (name === "data-drive") return this.dataset.drive || null;
    if (name === "data-dimension-tile") return this.dataset.dimensionTile || null;
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  getBoundingClientRect() {
    return {
      ...this.rect,
      right: this.rect.left + this.rect.width,
      bottom: this.rect.top + this.rect.height,
    };
  }

  hasAttribute(name) {
    return this.getAttribute(name) !== null;
  }

  invokeListeners(event, capture) {
    const entries = [...(this.listeners.get(event.type) || [])];
    for (const entry of entries) {
      if (entry.capture !== capture) continue;
      event.currentTarget = this;
      entry.listener.call(this, event);
      if (entry.once) {
        const current = this.listeners.get(event.type) || [];
        this.listeners.set(event.type, current.filter((candidate) => candidate !== entry));
      }
      if (event.immediateStopped) break;
    }
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  querySelectorAll(selector) {
    const selectors = selector.split(",");
    const matches = [];
    const visit = (element) => {
      if (selectors.some((candidate) => selectorMatches(element, candidate))) {
        matches.push(element);
      }
      element.children.forEach(visit);
    };
    this.children.forEach(visit);
    return matches;
  }

  remove() {
    this.parentElement?.removeChild(this);
  }

  removeAttribute(name) {
    if (name === "data-drive") delete this.dataset.drive;
    else this.attributes.delete(name);
  }

  removeChild(child) {
    const index = this.children.indexOf(child);
    if (index >= 0) this.children.splice(index, 1);
    child.parentElement = null;
    return child;
  }

  replaceChildren(...children) {
    this.children.forEach((child) => {
      child.parentElement = null;
    });
    this.children = [];
    this.append(...children);
  }

  setAttribute(name, value) {
    if (name === "class") {
      this.classList = new FakeClassList(String(value).split(/\s+/).filter(Boolean));
    } else if (name === "data-drive") {
      this.dataset.drive = String(value);
    } else if (name === "data-dimension-tile") {
      this.dataset.dimensionTile = String(value);
    } else {
      this.attributes.set(name, String(value));
    }
  }
}

class FakeDocument {
  constructor() {
    this.listeners = new Map();
    this.body = new FakeElement(this, "body");
    this.head = new FakeElement(this, "head");
    this.documentElement = new FakeElement(this, "html");
    this.documentElement.append(this.head, this.body);
    this.activeElement = this.body;
  }

  addEventListener(type, listener, options = {}) {
    const entries = this.listeners.get(type) || [];
    entries.push({
      capture: options === true || options?.capture === true,
      listener,
      once: options?.once === true,
    });
    this.listeners.set(type, entries);
  }

  createElement(tagName) {
    return new FakeElement(this, tagName);
  }

  createEvent() {
    const event = new FakeEvent("");
    event.initEvent = (type, bubbles, cancelable) => {
      event.type = type;
      event.bubbles = bubbles;
      event.cancelable = cancelable;
    };
    return event;
  }

  dispatchEvent(event) {
    if (!event.target) event.target = this;
    this.invokeListeners(event, true);
    if (!event.propagationStopped) this.invokeListeners(event, false);
    return !event.defaultPrevented;
  }

  getElementById(id) {
    return this.querySelectorAll(`#${id}`)[0] || null;
  }

  invokeListeners(event, capture) {
    const entries = [...(this.listeners.get(event.type) || [])];
    for (const entry of entries) {
      if (entry.capture !== capture) continue;
      event.currentTarget = this;
      entry.listener.call(this, event);
      if (entry.once) {
        const current = this.listeners.get(event.type) || [];
        this.listeners.set(event.type, current.filter((candidate) => candidate !== entry));
      }
      if (event.immediateStopped) break;
    }
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  querySelectorAll(selector) {
    const selectors = selector.split(",");
    const matches = [];
    const visit = (element) => {
      if (selectors.some((candidate) => selectorMatches(element, candidate))) {
        matches.push(element);
      }
      element.children.forEach(visit);
    };
    visit(this.body);
    return matches;
  }
}

function fakeWindow(document) {
  const listeners = new Map();
  const window = {
    CustomEvent: FakeCustomEvent,
    DataTransfer: FakeDataTransfer,
    DragEvent: FakeDragEvent,
    Event: FakeEvent,
    KeyboardEvent: FakeKeyboardEvent,
    PointerEvent: FakePointerEvent,
    clearTimeout,
    document,
    innerHeight: 900,
    innerWidth: 1400,
    performance,
    setTimeout,
    addEventListener(type, listener) {
      const entries = listeners.get(type) || [];
      entries.push(listener);
      listeners.set(type, entries);
    },
    removeEventListener(type, listener) {
      const entries = listeners.get(type) || [];
      listeners.set(type, entries.filter((candidate) => candidate !== listener));
    },
    dispatchEvent(event) {
      for (const listener of listeners.get(event.type) || []) listener(event);
    },
    receiveMessage(data, source) {
      const event = { data, source, type: "message" };
      for (const listener of listeners.get("message") || []) listener(event);
    },
  };
  window.parent = window;
  return window;
}

function monitor(element, name, events, sequence) {
  for (const type of events) {
    element.addEventListener(type, (event) => {
      sequence.push({
        mime: [...(event.dataTransfer?.types || [])],
        name,
        type,
      });
    });
  }
}

function makeFixture({
  bunched = false,
  capability = "",
  folded = false,
  handleDrops = true,
  largeTranscript = false,
  remotePrimary = false,
  sourceSetsMime = true,
  supplyTileAdapter = true,
  transcriptTurns = null,
} = {}) {
  const document = new FakeDocument();
  const window = fakeWindow(document);
  const logs = [];
  const sequence = [];
  const state = new Map([
    ["tile-7", {
      bunch: bunched ? "bunch-seven-eight" : "",
      id: "tile-7",
      status: folded ? "folded" : "parked",
      surface: "herd",
      title: "Tile Seven",
    }],
    ["tile-8", {
      bunch: bunched ? "bunch-seven-eight" : "",
      id: "tile-8",
      status: "parked",
      surface: "herd",
      title: "Tile Eight",
    }],
    ["tile-9", {
      bunch: "",
      id: "tile-9",
      status: "parked",
      surface: "arena",
      title: "Tile Nine",
    }],
  ]);
  let currentSurface = "herd";
  let modelCalls = 0;
  let otherClicks = 0;
  let parkedSequence = 0;
  const sentTexts = [];
  const typedTexts = [];
  const tileElements = new Map();

  const controls = new Map();
  for (const [index, surface] of ["herd", "arena", "binder"].entries()) {
    const control = document.createElement("button");
    control.dataset.drive = `tiles.surface.${surface}`;
    control.textContent = surface;
    control.rect = {
      left: 30 + (index * 150),
      top: 30,
      width: 120,
      height: 42,
    };
    control.addEventListener("click", () => {
      currentSurface = surface;
      render();
    });
    control.addEventListener("dragover", (event) => {
      event.preventDefault();
    });
    if (handleDrops) {
      control.addEventListener("drop", (event) => {
        const id = event.dataTransfer.getData("application/x-rapp-dimension-tile");
        if (!id || !state.has(id)) return;
        event.preventDefault();
        state.get(id).surface = surface;
        state.get(id).bunch = "";
        render();
        window.dispatchEvent(new FakeCustomEvent(
          "rapp-beta:tile-move-complete",
          { detail: { actor: "ai", id, surface } },
        ));
      });
    }
    monitor(control, `surface-control:${surface}`, [
      "dragenter",
      "dragover",
      "drop",
    ], sequence);
    controls.set(surface, control);
    document.body.appendChild(control);
  }

  const surfaceElement = document.createElement("section");
  surfaceElement.classList.add("dimension-tile-surface");
  surfaceElement.rect = { left: 80, top: 180, width: 900, height: 500 };
  surfaceElement.addEventListener("dragover", (event) => {
    const tileId = event.dataTransfer.getData("application/x-rapp-dimension-tile");
    const chat = event.dataTransfer.getData("application/x-rapp-brainstem-chat");
    if (tileId || chat) event.preventDefault();
  });
  if (handleDrops) {
    surfaceElement.addEventListener("drop", (event) => {
      const tileId = event.dataTransfer.getData("application/x-rapp-dimension-tile");
      const chat = event.dataTransfer.getData("application/x-rapp-brainstem-chat");
      if (tileId && state.has(tileId)) {
        event.preventDefault();
        state.get(tileId).surface = currentSurface;
        state.get(tileId).bunch = "";
        render();
        window.dispatchEvent(new FakeCustomEvent(
          "rapp-beta:tile-move-complete",
          { detail: { actor: "ai", id: tileId, surface: currentSurface } },
        ));
      } else if (chat) {
        event.preventDefault();
        parkedSequence += 1;
        const id = `tile-parked-${parkedSequence}`;
        state.set(id, {
          bunch: "",
          id,
          status: "parked",
          surface: currentSurface,
          title: "Parked chat",
        });
        render();
        window.dispatchEvent(new FakeCustomEvent(
          "rapp-beta:tile-park-complete",
          { detail: { actor: "ai", id, surface: currentSurface } },
        ));
      }
    });
  }
  monitor(surfaceElement, "surface", ["dragenter", "dragover", "drop"], sequence);
  document.body.appendChild(surfaceElement);

  const primary = document.createElement("header");
  primary.dataset.drive = "brainstem.primary";
  primary.rect = { left: 1080, top: 180, width: 260, height: 70 };
  primary.addEventListener("dragover", (event) => {
    if (event.dataTransfer.getData("application/x-rapp-dimension-tile")) {
      event.preventDefault();
    }
  });
  if (handleDrops) {
    primary.addEventListener("drop", (event) => {
      const id = event.dataTransfer.getData("application/x-rapp-dimension-tile");
      if (!id || !state.has(id)) return;
      event.preventDefault();
      state.get(id).status = "primary";
      render();
      window.dispatchEvent(new FakeCustomEvent(
        "rapp-beta:tile-primary-complete",
        { detail: { actor: "ai", id } },
      ));
    });
  }
  monitor(primary, "primary", ["dragenter", "dragover", "drop"], sequence);
  document.body.appendChild(primary);

  const chatSource = document.createElement("header");
  chatSource.dataset.drive = "brainstem.primary-source";
  chatSource.rect = { left: 1080, top: 300, width: 260, height: 70 };
  chatSource.addEventListener("dragstart", (event) => {
    event.dataTransfer.effectAllowed = "move";
    if (sourceSetsMime) {
      event.dataTransfer.setData("application/x-rapp-brainstem-chat", "primary");
    }
  });
  monitor(chatSource, "chat-source", [
    "pointerdown",
    "dragstart",
    "dragend",
  ], sequence);
  document.body.appendChild(chatSource);

  const other = document.createElement("button");
  other.dataset.drive = "other.button";
  other.textContent = "Other";
  other.addEventListener("click", () => {
    otherClicks += 1;
  });
  document.body.appendChild(other);

  const dash = document.createElement("button");
  dash.dataset.drive = "dash.button";
  dash.textContent = "--foo";
  document.body.appendChild(dash);

  const chatElement = document.createElement("div");
  chatElement.id = "chat";
  chatElement.dataset.drive = "brainstem.chat";
  document.body.appendChild(chatElement);
  let requestSequence = 0;
  const recordModelCall = () => {
    modelCalls += 1;
    requestSequence += 1;
    const slot = document.createElement("section");
    slot.classList.add("response-slot");
    slot.dataset.requestId = String(requestSequence);
    chatElement.appendChild(slot);
  };
  const composer = document.createElement("textarea");
  composer.id = "input";
  composer.dataset.drive = "brainstem.composer";
  composer.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    recordModelCall();
  });
  document.body.appendChild(composer);
  const send = document.createElement("button");
  send.id = "send";
  send.dataset.drive = "brainstem.send";
  send.addEventListener("click", recordModelCall);
  document.body.appendChild(send);
  const modelProxy = document.createElement("button");
  modelProxy.dataset.drive = "other.modelProxy";
  modelProxy.addEventListener("click", recordModelCall);
  document.body.appendChild(modelProxy);

  function createTile(record, index) {
    const tile = document.createElement("article");
    tile.classList.add("dimension-tile");
    tile.dataset.dimensionTile = record.id;
    tile.dataset.drive = `herd.tile[${record.id}]`;
    tile.dataset.status = record.status;
    tile.dataset.surface = record.surface;
    tile.dataset.bunch = record.bunch;
    tile.textContent = record.title;
    tile.rect = {
      left: 100 + (index * 220),
      top: 250,
      width: 190,
      height: 150,
    };
    tile.addEventListener("dragstart", (event) => {
      event.dataTransfer.effectAllowed = "move";
      if (sourceSetsMime) {
        event.dataTransfer.setData("application/x-rapp-dimension-tile", record.id);
      }
    });
    monitor(tile, record.id, ["pointerdown", "dragstart", "dragend"], sequence);
    tile.addEventListener("dragover", (event) => {
      const sourceId = event.dataTransfer.getData(
        "application/x-rapp-dimension-tile",
      );
      if (sourceId && sourceId !== record.id) {
        event.preventDefault();
        event.stopPropagation();
      }
    });
    if (handleDrops) {
      tile.addEventListener("drop", (event) => {
        const sourceId = event.dataTransfer.getData(
          "application/x-rapp-dimension-tile",
        );
        if (!sourceId || sourceId === record.id || !state.has(sourceId)) return;
        event.preventDefault();
        event.stopPropagation();
        const bunchId = record.bunch || "bunch-seven-eight";
        state.get(sourceId).bunch = bunchId;
        state.get(record.id).bunch = bunchId;
        render();
        window.dispatchEvent(new FakeCustomEvent(
          "rapp-beta:tile-bunch-complete",
          {
            detail: {
              bunch: bunchId,
              actor: "ai",
              sourceId,
              targetId: record.id,
            },
          },
        ));
      });
    }
    monitor(tile, record.id, ["dragenter", "dragover", "drop"], sequence);
    if (record.status !== "folded") {
      const fold = document.createElement("button");
      fold.dataset.drive = `herd.tile[${record.id}].fold`;
      fold.textContent = "Fold";
      fold.addEventListener("click", () => {
        state.get(record.id).status = "folded";
        render();
      });
      tile.appendChild(fold);
    } else {
      const undo = document.createElement("button");
      undo.dataset.drive = "tiles.undo";
      undo.textContent = "Undo";
      undo.addEventListener("click", () => {
        state.get(record.id).status = "parked";
        render();
      });
      tile.appendChild(undo);
    }
    return tile;
  }

  function render() {
    surfaceElement.dataset.surface = currentSurface;
    surfaceElement.dataset.drive = `tiles.surface[${currentSurface}]`;
    surfaceElement.replaceChildren();
    tileElements.clear();
    const records = [...state.values()].filter((record) => (
      record.surface === currentSurface && record.status !== "primary"
    ));
    records.forEach((record, index) => {
      const tile = createTile(record, index);
      tileElements.set(record.id, tile);
      surfaceElement.appendChild(tile);
    });
  }
  render();

  const chat = {
    async read({ last } = {}) {
      const turns = transcriptTurns || (largeTranscript
        ? [{ role: "assistant", text: "x".repeat(100_000) }]
        : [
            { role: "user", text: "hello" },
            { role: "assistant", text: "hi" },
          ]);
      return last === undefined ? turns : turns.slice(-last);
    },
    async send(text) {
      modelCalls += 1;
      sentTexts.push(String(text));
      return { accepted: true, text };
    },
    async type(text) {
      typedTexts.push(String(text));
    },
  };

  const tiles = {
    chatSource: () => remotePrimary ? null : chatSource,
    currentSurface: () => currentSurface,
    find: (id) => tileElements.get(id) || null,
    list: (surface) => (
      surface === currentSurface
        ? [...state.values()].filter((record) => (
            record.surface === surface && record.status !== "primary"
          )).map((record) => ({ ...record }))
        : []
    ),
    primaryTarget: () => remotePrimary ? null : primary,
    surface: (surface) => surface === currentSurface ? surfaceElement : null,
    surfaceControl: (surface) => controls.get(surface) || null,
  };
  const rapp = createAutopilot({
    capability,
    chat,
    console: { log: (line) => logs.push(line) },
    document,
    composer,
    tiles: supplyTileAdapter ? tiles : undefined,
    window,
  });

  return {
    composer,
    document,
    get currentSurface() {
      return currentSurface;
    },
    get modelCalls() {
      return modelCalls;
    },
    get otherClicks() {
      return otherClicks;
    },
    logs,
    other,
    modelProxy,
    primary,
    rapp,
    render,
    sequence,
    send,
    sentTexts,
    snapshot() {
      return [...state.values()]
        .map((record) => ({ ...record }))
        .sort((left, right) => left.id.localeCompare(right.id));
    },
    state,
    tile: (id) => tileElements.get(id) || null,
    typedTexts,
    window,
  };
}

function makeCrossFrameFixture() {
  const capability = "cross-frame-capability";
  const shell = makeFixture({ capability, remotePrimary: true });
  shell.primary.remove();
  const childDocument = new FakeDocument();
  const childWindow = fakeWindow(childDocument);
  const frame = shell.document.createElement("iframe");
  frame.dataset.drive = "shell.brainstem";
  frame.rect = { left: 980, top: 120, width: 380, height: 620 };
  const childProxy = {
    postMessage(data) {
      queueMicrotask(() => childWindow.receiveMessage(data, parentProxy));
    },
  };
  const parentProxy = {
    postMessage(data) {
      queueMicrotask(() => shell.window.receiveMessage(data, childProxy));
    },
  };
  frame.contentWindow = childProxy;
  childWindow.parent = parentProxy;
  shell.document.body.appendChild(frame);

  const header = childDocument.createElement("header");
  header.dataset.drive = "brainstem.primary";
  header.rect = { left: 20, top: 20, width: 320, height: 64 };
  header.addEventListener("dragstart", (event) => {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("application/x-rapp-brainstem-chat", "primary");
  });
  header.addEventListener("dragover", (event) => {
    if (event.dataTransfer.getData("application/x-rapp-dimension-tile")) {
      event.preventDefault();
    }
  });
  header.addEventListener("drop", (event) => {
    const id = event.dataTransfer.getData("application/x-rapp-dimension-tile");
    if (!id || !shell.state.has(id)) return;
    event.preventDefault();
    shell.state.get(id).status = "primary";
    shell.render();
    shell.window.dispatchEvent(new FakeCustomEvent(
      "rapp-beta:tile-primary-complete",
      { detail: { actor: "ai", id } },
    ));
  });
  childDocument.body.appendChild(header);
  createAutopilot({
    capability,
    chat: {
      async read() {
        return [];
      },
      async send() {
        return { accepted: true };
      },
      async type() {},
    },
    console: { log() {} },
    document: childDocument,
    window: childWindow,
  });
  return { childDocument, childWindow, shell };
}

test("string and object shapes return identical envelopes", async () => {
  const cli = makeFixture();
  const api = makeFixture();
  assert.deepEqual(
    await cli.rapp("tile.primary tile-7"),
    await api.rapp({ cmd: "tile.primary", args: { id: "tile-7" } }),
  );
});

test("multi-line scripts stop at the first failure", async () => {
  const fixture = makeFixture();
  const result = await fixture.rapp(`
    herd.open
    tile.prmary tile-7
    binder.open
  `);
  assert.equal(result.ok, false);
  assert.equal(result.ran, 2);
  assert.deepEqual(result.results.map((entry) => entry.cmd), [
    "herd.open",
    "tile.prmary",
  ]);
  assert.equal(fixture.currentSurface, "herd");
  assert.equal(fixture.logs.length, 2);
});

test("help is complete and only chat.send costs the model", async () => {
  const fixture = makeFixture();
  const result = await fixture.rapp("help");
  const commands = result.results[0].commands;
  assert.deepEqual(
    commands.map((entry) => entry.cmd),
    fixture.rapp.registry.map((entry) => entry.cmd),
  );
  assert.equal(commands.filter((entry) => entry.costs_model).length, 1);
  assert.equal(
    commands.find((entry) => entry.costs_model).cmd,
    "chat.send",
  );
  assert.ok(commands.every((entry) => (
    Array.isArray(entry.args)
    && Array.isArray(entry.flags)
    && typeof entry.example === "string"
    && typeof entry.does === "string"
  )));
});

test("unknown commands teach the nearest valid verb without throwing", async () => {
  const fixture = makeFixture();
  const result = await fixture.rapp("tile.prmary tile-7");
  assert.equal(result.ok, false);
  assert.equal(result.results[0].reason, "unknown_command");
  assert.equal(result.results[0].suggestion, "tile.primary");
  assert.equal(result.results[0].help.cmd, "tile.primary");
  assert.match(result.results[0].error, /did you mean "tile\.primary"/);
});

test("every verb except chat.send leaves the model-call counter at zero", async (t) => {
  const invocations = new Map([
    ["help", {}],
    ["ui.inspect", {}],
    ["ui.click", { handle: "other.button" }],
    ["ui.press", { key: "Enter" }],
    ["ui.wait", { handle: "other.button", text: "Other" }],
    ["chat.read", { last: 1 }],
    ["chat.type", { text: "draft" }],
    ["chat.send", { text: "ask" }],
    ["herd.open", {}],
    ["arena.switch", {}],
    ["binder.open", {}],
    ["herd.list", {}],
    ["arena.list", {}],
    ["binder.list", {}],
    ["tile.primary", { id: "tile-7", speed: "instant" }],
    ["tile.park", { speed: "instant", to: "herd" }],
    ["tile.move", { id: "tile-7", speed: "instant", to: "binder" }],
    ["tile.bunch", {
      source_id: "tile-7",
      speed: "instant",
      target_id: "tile-8",
    }],
    ["tile.unbunch", { id: "tile-7" }],
    ["tile.fold", { id: "tile-7" }],
    ["tile.undo", {}],
  ]);
  const fixtureRegistry = makeFixture();
  assert.deepEqual(
    [...invocations.keys()].sort(),
    fixtureRegistry.rapp.registry.map((entry) => entry.cmd).sort(),
    "every registry verb must be invoked here, and no phantom verbs",
  );
  for (const [cmd, args] of invocations) {
    const fixture = makeFixture({
      bunched: cmd === "tile.unbunch",
      folded: cmd === "tile.undo",
    });
    const result = await fixture.rapp({ cmd, args });
    assert.equal(result.ok, true, `${cmd}: ${JSON.stringify(result)}`);
    assert.equal(
      fixture.modelCalls,
      cmd === "chat.send" ? 1 : 0,
      cmd,
    );
  }
  t.diagnostic(`proved ${invocations.size} verbs independently`);
});

test("raw UI verbs refuse known chat-send paths without spending a model call", async () => {
  const clickFixture = makeFixture();
  const clicked = await clickFixture.rapp({
    cmd: "ui.click",
    args: { handle: "brainstem.send" },
  });
  assert.equal(clicked.ok, false);
  assert.equal(clicked.results[0].reason, "bad_argument");
  assert.match(clicked.results[0].error, /use chat\.send, which costs a model call/);
  assert.equal(clicked.results[0].costs_model, false);
  assert.equal(clickFixture.modelCalls, 0);

  const pressFixture = makeFixture();
  pressFixture.composer.focus();
  const pressed = await pressFixture.rapp({
    cmd: "ui.press",
    args: { key: "Enter" },
  });
  assert.equal(pressed.ok, false);
  assert.equal(pressed.results[0].reason, "bad_argument");
  assert.match(pressed.results[0].error, /use chat\.send, which costs a model call/);
  assert.equal(pressed.results[0].costs_model, false);
  assert.equal(pressFixture.modelCalls, 0);
});

test("a generic UI action reports when its target starts a model call", async () => {
  const fixture = makeFixture();
  const result = await fixture.rapp({
    cmd: "ui.click",
    args: { handle: "other.modelProxy" },
  });
  assert.equal(result.ok, true);
  assert.equal(result.results[0].costs_model, true);
  assert.equal(fixture.modelCalls, 1);
  assert.match(fixture.logs[0], /\[model call\]$/);
});

test("quoted dash-leading values and the end-of-flags separator stay literal", async () => {
  const fixture = makeFixture();
  const quotedSend = await fixture.rapp('chat.send "-- what does this do?"');
  assert.equal(quotedSend.ok, true);
  assert.equal(fixture.sentTexts.at(-1), "-- what does this do?");

  const quotedType = await fixture.rapp('chat.type "--- section"');
  assert.equal(quotedType.ok, true);
  assert.equal(fixture.typedTexts.at(-1), "--- section");

  const equalsValue = await fixture.rapp("ui.wait dash.button --text=--foo");
  assert.equal(equalsValue.ok, true);
  const quotedFlagValue = await fixture.rapp('ui.wait dash.button --text="--foo"');
  assert.equal(quotedFlagValue.ok, true);
  const separateQuotedValue = await fixture.rapp('ui.wait dash.button --text "--foo"');
  assert.equal(separateQuotedValue.ok, true);

  const separated = await fixture.rapp("chat.send -- --foo");
  assert.equal(separated.ok, true);
  assert.equal(fixture.sentTexts.at(-1), "--foo");

  const unknownFlag = await fixture.rapp("chat.send --nope");
  assert.equal(unknownFlag.ok, false);
  assert.equal(unknownFlag.results[0].reason, "bad_argument");
});

test("tile.fold followed by tile.undo uses the folded tile control", async () => {
  const fixture = makeFixture();
  const folded = await fixture.rapp("tile.fold tile-7");
  assert.equal(folded.ok, true);
  assert.equal(fixture.state.get("tile-7").status, "folded");
  assert.equal(
    fixture.tile("tile-7").children.find(
      (child) => child.dataset.drive === "tiles.undo",
    )?.textContent,
    "Undo",
  );

  const undone = await fixture.rapp("tile.undo");
  assert.equal(undone.ok, true);
  assert.equal(fixture.state.get("tile-7").status, "parked");
});

test("scripts over the 64-command cap are refused before running", async () => {
  const fixture = makeFixture();
  const result = await fixture.rapp(
    Array.from({ length: 65 }, () => "help").join("\n"),
  );
  assert.equal(result.ok, false);
  assert.equal(result.ran, 0);
  assert.equal(result.results[0].reason, "command_limit");
  assert.equal(fixture.modelCalls, 0);
});

test("tile.move fails when the renderer drop handler is absent", async () => {
  const fixture = makeFixture({ handleDrops: false });
  const before = fixture.snapshot();
  const result = await fixture.rapp(
    "tile.move tile-7 --to binder --speed instant",
  );
  assert.equal(result.ok, false);
  assert.equal(result.results[0].reason, "drop_not_handled");
  assert.deepEqual(fixture.snapshot(), before);
});

test("a source must populate the renderer MIME during dragstart", async () => {
  const fixture = makeFixture({ sourceSetsMime: false });
  const before = fixture.snapshot();
  const result = await fixture.rapp(
    "tile.move tile-7 --to binder --speed instant",
  );
  assert.equal(result.ok, false);
  assert.equal(result.results[0].reason, "drag_payload_missing");
  assert.deepEqual(fixture.snapshot(), before);
});

test("tile.move dispatches the real drag sequence with the renderer MIME", async () => {
  const fixture = makeFixture();
  const result = await fixture.rapp(
    "tile.move tile-7 --to binder --speed instant",
  );
  assert.equal(result.ok, true);
  const relevant = fixture.sequence.filter((entry) => (
    (entry.name === "tile-7" && ["dragstart", "dragend"].includes(entry.type))
    || (
      entry.name === "surface-control:binder"
      && ["dragenter", "dragover", "drop"].includes(entry.type)
    )
  ));
  assert.deepEqual(relevant.map((entry) => entry.type), [
    "dragstart",
    "dragenter",
    "dragover",
    "drop",
    "dragend",
  ]);
  assert.ok(relevant.every((entry) => (
    entry.mime.includes("application/x-rapp-dimension-tile")
  )));
  assert.equal(fixture.state.get("tile-7").surface, "binder");
});

test("AI gestures leave other controls live and yield a contested tile", async () => {
  const concurrent = makeFixture();
  const moving = concurrent.rapp(
    "tile.move tile-7 --to binder --speed natural",
  );
  await new Promise((resolve) => setTimeout(resolve, 30));
  concurrent.other.click();
  const moved = await moving;
  assert.equal(moved.ok, true);
  assert.equal(concurrent.otherClicks, 1);

  const contested = makeFixture();
  const source = contested.tile("tile-7");
  source.dispatchEvent(new FakePointerEvent("pointerdown", {
    bubbles: true,
    pointerId: 77,
  }));
  const before = contested.snapshot();
  const yielded = await contested.rapp(
    "tile.move tile-7 --to binder --speed instant",
  );
  assert.equal(yielded.ok, false);
  assert.equal(yielded.results[0].reason, "yielded_to_user");
  assert.deepEqual(contested.snapshot(), before);
  source.dispatchEvent(new FakePointerEvent("pointerup", {
    bubbles: true,
    pointerId: 77,
  }));

  const interrupted = makeFixture();
  const inFlight = interrupted.rapp(
    "tile.move tile-7 --to binder --speed natural",
  );
  await new Promise((resolve) => setTimeout(resolve, 30));
  interrupted.document.body.dispatchEvent(new FakeKeyboardEvent("keydown", {
    bubbles: true,
    key: "Escape",
  }));
  const stopped = await inFlight;
  assert.equal(stopped.ok, false);
  assert.equal(stopped.results[0].reason, "interrupted");
  assert.equal(interrupted.state.get("tile-7").surface, "herd");
});

test("native drag pointer-cancel stays held until dragend", async () => {
  const fixture = makeFixture();
  const source = fixture.tile("tile-7");
  const transfer = new FakeDataTransfer();
  source.dispatchEvent(new FakePointerEvent("pointerdown", {
    bubbles: true,
    pointerId: 81,
  }));
  source.dispatchEvent(new FakeDragEvent("dragstart", {
    bubbles: true,
    dataTransfer: transfer,
  }));
  source.dispatchEvent(new FakePointerEvent("pointercancel", {
    bubbles: true,
    pointerId: 81,
  }));
  const held = await fixture.rapp(
    "tile.move tile-7 --to binder --speed instant",
  );
  assert.equal(held.ok, false);
  assert.equal(held.results[0].reason, "yielded_to_user");
  source.dispatchEvent(new FakeDragEvent("dragend", {
    bubbles: true,
    dataTransfer: transfer,
  }));

  const released = await fixture.rapp(
    "tile.move tile-7 --to binder --speed instant",
  );
  assert.equal(released.ok, true);
});

test("pointerup releases the grabbed tile even over another control", async () => {
  const fixture = makeFixture();
  fixture.tile("tile-7").dispatchEvent(new FakePointerEvent("pointerdown", {
    bubbles: true,
    pointerId: 82,
  }));
  fixture.other.dispatchEvent(new FakePointerEvent("pointerup", {
    bubbles: true,
    pointerId: 82,
  }));
  const result = await fixture.rapp(
    "tile.move tile-7 --to binder --speed instant",
  );
  assert.equal(result.ok, true);
});

test("tile.bunch yields when the person holds its target tile", async () => {
  const fixture = makeFixture();
  const target = fixture.tile("tile-8");
  target.dispatchEvent(new FakePointerEvent("pointerdown", {
    bubbles: true,
    pointerId: 83,
  }));
  const before = fixture.snapshot();
  const result = await fixture.rapp(
    "tile.bunch tile-7 tile-8 --speed instant",
  );
  assert.equal(result.ok, false);
  assert.equal(result.results[0].reason, "yielded_to_user");
  assert.deepEqual(fixture.snapshot(), before);
  target.dispatchEvent(new FakePointerEvent("pointerup", {
    bubbles: true,
    pointerId: 83,
  }));
});

test("instant and natural speeds change tempo, not handlers or outcome", async () => {
  const instant = makeFixture();
  const natural = makeFixture();
  const instantResult = await instant.rapp(
    "tile.move tile-7 --to binder --speed instant",
  );
  const naturalResult = await natural.rapp(
    "tile.move tile-7 --to binder --speed natural",
  );
  assert.equal(instantResult.ok, true);
  assert.equal(naturalResult.ok, true);
  const handlerTypes = (fixture) => fixture.sequence
    .filter((entry) => [
      "dragstart",
      "dragenter",
      "dragover",
      "drop",
      "dragend",
    ].includes(entry.type))
    .map((entry) => `${entry.name}:${entry.type}`);
  assert.deepEqual(handlerTypes(instant), handlerTypes(natural));
  assert.deepEqual(instant.snapshot(), natural.snapshot());
});

test("result envelopes stay within 64 KB", async () => {
  const fixture = makeFixture({ largeTranscript: true });
  const result = await fixture.rapp("chat.read");
  assert.ok(new TextEncoder().encode(JSON.stringify(result)).byteLength <= 64 * 1024);
  assert.equal(result.result_truncated, true);
  assert.equal(result.results[0].reason, "result_too_large");
});

test("many-turn chat reads retain recent turns and report all omissions", async () => {
  const transcriptTurns = Array.from({ length: 80 }, (_, index) => ({
    role: index % 2 ? "assistant" : "user",
    text: `${index}:`.padEnd(4000, "x"),
  }));
  const fixture = makeFixture({ transcriptTurns });
  const result = await fixture.rapp("chat.read");
  const read = result.results[0];
  assert.equal(result.ok, true);
  assert.equal(result.result_truncated, true);
  assert.ok(read.turns.length > 0);
  assert.ok(read.turns.length < 50);
  assert.equal(read.turns.at(-1).text, transcriptTurns.at(-1).text);
  assert.equal(read.turns_omitted, 80 - read.turns.length);
});

test("chat.read defaults to the latest 50 turns before envelope truncation", async () => {
  const transcriptTurns = Array.from({ length: 60 }, (_, index) => ({
    role: index % 2 ? "assistant" : "user",
    text: `turn ${index}`,
  }));
  const fixture = makeFixture({ transcriptTurns });
  const result = await fixture.rapp("chat.read");
  const read = result.results[0];
  assert.equal(result.result_truncated, undefined);
  assert.equal(read.turns.length, 50);
  assert.equal(read.turns[0].text, "turn 10");
  assert.equal(read.turns_omitted, 10);
});

test("production DOM fallbacks perform the drag without test adapters", async () => {
  const fixture = makeFixture({ supplyTileAdapter: false });
  const result = await fixture.rapp(
    "tile.move tile-7 --to binder --speed instant",
  );
  assert.equal(result.ok, true);
  assert.equal(fixture.state.get("tile-7").surface, "binder");
});

test("cross-frame drags use the real Brainstem source and target handlers", async () => {
  const { shell } = makeCrossFrameFixture();
  const parked = await shell.rapp(
    "tile.park --to herd --speed instant",
  );
  assert.equal(parked.ok, true);
  assert.ok([...shell.state.keys()].some((id) => id.startsWith("tile-parked-")));

  const primary = await shell.rapp(
    "tile.primary tile-7 --speed instant",
  );
  assert.equal(primary.ok, true);
  assert.equal(shell.state.get("tile-7").status, "primary");
});

test("Escape in the Brainstem frame interrupts a shell-local drag", async () => {
  const { childDocument, shell } = makeCrossFrameFixture();
  const moving = shell.rapp(
    "tile.primary tile-7 --speed natural",
  );
  await new Promise((resolve) => setTimeout(resolve, 30));
  childDocument.body.dispatchEvent(new FakeKeyboardEvent("keydown", {
    bubbles: true,
    key: "Escape",
  }));
  const result = await moving;
  assert.equal(result.ok, false);
  assert.equal(result.results[0].reason, "interrupted");
  assert.equal(shell.state.get("tile-7").status, "parked");
});

test("the driver validates, budgets, and executes Autopilot in the shell frame", () => {
  const command = uiDriverInternals.validateCommand({
    action: "autopilot",
    script: "help",
  });
  assert.equal(command.action, "autopilot");
  assert.ok(command.frameTimeoutMs >= 13_000);
  assert.equal(uiDriverInternals.frameKeyForCommand(command), "shell");
  assert.match(
    uiDriverInternals.browserDriverCommand.toString(),
    /typeof window\.rapp !== "function"/,
  );
  assert.throws(
    () => uiDriverInternals.validateCommand({
      action: "autopilot",
      script: 42,
    }),
    /script must be a string/,
  );
  const documentedBootstrap = uiDriverInternals.validateCommand({
    action: "run",
    steps: [{ action: "autopilot", script: "help" }],
  });
  assert.equal(documentedBootstrap.steps[0].action, "autopilot");
  assert.equal(
    uiDriverInternals.frameKeyForCommand(documentedBootstrap),
    "shell",
  );
});

test("the shell and injected rapplication frames install the same Autopilot module", () => {
  const shell = readFileSync(new URL("../ui/index.html", import.meta.url), "utf8");
  const main = readFileSync(new URL("../electron/main.mjs", import.meta.url), "utf8");
  const classicSource = readFileSync(
    new URL("../ui/autopilot.js", import.meta.url),
    "utf8",
  ).replace("export function createAutopilot", "function createAutopilot");
  const driver = readFileSync(
    new URL("../electron/ui-driver-server.mjs", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(shell, /type="module" src="autopilot\.js"/);
  assert.match(main, /autopilotClassicSource/);
  assert.match(main, /createInstrumentedRappUi/);
  assert.match(main, /did-finish-load/);
  assert.match(main, /autopilotInstallationSource\(\)/);
  const installation = createAutopilotInstallationSource({
    capability: "test-capability",
    classicSource,
  });
  assert.match(installation, /function createAutopilot/);
  assert.match(
    instrumentRappUi("<html><head></head></html>", {
      autopilotSource: installation,
    }),
    /<script>[\s\S]*function createAutopilot[\s\S]*<\/script>/,
  );
  assert.match(driver, /commandHasAutopilot\(command\)/);
});
