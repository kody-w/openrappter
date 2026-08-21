import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";

import { composeDimensionTilesFrameBridgeSource } from "../electron/dimension-tiles.mjs";

await import("../ui/stream-follow.js");
await import("../ui/stream-pacing.js");
await import("../ui/stream-render-pacing.js");
await import("../ui/chat-look.js");

const mainSource = readFileSync(
  new URL("../electron/main.mjs", import.meta.url),
  "utf8",
).replaceAll("\r\n", "\n");
const { createTailFollower } = globalThis.RappStreamFollow;
const {
  createStreamPacer,
  createTextSplitter,
  splitTextPieces,
} = globalThis.RappStreamPacing;
const {
  createAdaptiveRenderPacer,
  splitRenderPieces,
} = globalThis.RappStreamRenderPacing;
const {
  applyLookStyles,
  grailFrameCss,
  inferMessageSide,
  markArrived,
  markGroupLast,
  normalizeChatLook,
} = globalThis.RappChatLook;

function extractExpression(startMarker, endMarker, source = mainSource) {
  const normalizedSource = source.replaceAll("\r\n", "\n");
  const declarationStart = normalizedSource.indexOf(startMarker);
  const expressionStart = normalizedSource.indexOf("=", declarationStart) + 1;
  const expressionEnd = normalizedSource.indexOf(endMarker, expressionStart);
  assert.ok(
    declarationStart >= 0 && expressionStart > 0 && expressionEnd > expressionStart,
  );
  return normalizedSource.slice(expressionStart, expressionEnd);
}

const smoothStreamCss = vm.runInNewContext(
  extractExpression("const smoothStreamCss =", ";\nconst betaHome ="),
);
const bridgeExpression = extractExpression(
  "const BETA_FRAME_BRIDGE_SOURCE =",
  ";\n\nfunction frameBridgeInstallationSource",
);

function materializeBridgeSource(
  chatStreamMode,
  expression = bridgeExpression,
  streamCss = smoothStreamCss,
) {
  return vm.runInNewContext(expression, {
    applyLookStyles,
    chatStreamMode,
    createStreamPacer,
    createAdaptiveRenderPacer,
    createTailFollower,
    createTextSplitter,
    exportRedactionSource: "",
    grailFrameCss,
    humanizeAgentName: (value) => String(value),
    inferMessageSide,
    markArrived,
    markGroupLast,
    normalizeChatLook,
    smoothStreamCss: streamCss,
    splitRenderPieces,
    splitTextPieces,
  });
}

test("herd-mode bridge source is byte-identical to the bridge without Agent Arena", (t) => {
  // Herd-mode identity is a property of the composition, not of one recorded hash:
  // the bridge legitimately changes for unrelated reasons (streaming fixes,
  // look tweaks), and every such change must keep this test green. With the
  // herd mode active the composed source must be the input source, byte for byte.
  const checkpointSource = `window.__rappBetaChatLookConfig = ${JSON.stringify({
    chatLook: "messages",
    chatTypingEnabled: false,
  })};\n${materializeBridgeSource("smooth")}`;
  const hash = createHash("sha256").update(checkpointSource).digest("hex");
  t.diagnostic(`herd-mode bridge source sha256: ${hash}`);
  assert.doesNotMatch(checkpointSource, /installArenaFrameBridge|rappDimensionTiles|agent.arena/i,
    "the bridge without the feature carries no tile code");
  const herd = composeDimensionTilesFrameBridgeSource(checkpointSource, {
    mode: "herd",
    layout: "ring",
    customLayoutPath: null,
  });
  assert.equal(herd, checkpointSource);
  assert.equal(createHash("sha256").update(herd).digest("hex"), hash);
  t.diagnostic(`herd-mode bridge source sha256: ${hash}`);
});

test("CRLF main.mjs extracts and materializes the frame bridge", () => {
  const crlfSource = mainSource.replaceAll("\n", "\r\n");
  const crlfCssExpression = extractExpression(
    "const smoothStreamCss =",
    ";\nconst betaHome =",
    crlfSource,
  );
  const crlfBridgeExpression = extractExpression(
    "const BETA_FRAME_BRIDGE_SOURCE =",
    ";\n\nfunction frameBridgeInstallationSource",
    crlfSource,
  );
  const crlfCss = vm.runInNewContext(crlfCssExpression);

  assert.equal(crlfBridgeExpression, bridgeExpression);
  assert.equal(
    materializeBridgeSource("smooth", crlfBridgeExpression, crlfCss),
    materializeBridgeSource("smooth"),
  );
  console.log("CRLF main.mjs: bridge extraction and materialization succeeded");
});

function fakeClock() {
  let currentTime = 0;
  let sequence = 0;
  const tasks = new Map();

  function setTimer(callback, delay) {
    const id = ++sequence;
    tasks.set(id, {
      at: currentTime + delay,
      callback,
      id,
    });
    return id;
  }

  function clearTimer(id) {
    tasks.delete(id);
  }

  function runAll(limit = 10000) {
    let count = 0;
    while (tasks.size) {
      const next = [...tasks.values()].sort(
        (left, right) => left.at - right.at || left.id - right.id,
      )[0];
      tasks.delete(next.id);
      currentTime = next.at;
      next.callback();
      count += 1;
      if (count > limit) throw new Error("Fake timer runaway.");
    }
  }

  function requestFrame(callback) {
    return setTimer(callback, 24);
  }

  class ClockDate extends Date {
    static now() {
      return currentTime;
    }
  }

  return {
    ClockDate,
    clearTimer,
    now: () => currentTime,
    pending: () => tasks.size,
    requestFrame,
    runAll,
    setTimer,
  };
}

function createDom() {
  const byId = new Map();
  const mutationObservations = [];
  const resizeObservations = [];

  function dataName(name) {
    return name
      .slice(5)
      .replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
  }

  function matches(element, selector) {
    if (!element?.classList) return false;
    if (selector === ".avatar") return element.classList.contains("avatar");
    if (selector === ".bubble") return element.classList.contains("bubble");
    if (selector === ".typing-indicator") {
      return element.classList.contains("typing-indicator");
    }
    if (selector === ".msg.assistant.stream-arriving") {
      return element.classList.contains("msg")
        && element.classList.contains("assistant")
        && element.classList.contains("stream-arriving");
    }
    if (selector.startsWith(".msg.assistant:not(")) {
      return element.classList.contains("msg")
        && element.classList.contains("assistant")
        && element.dataset.rappProvisional !== "1"
        && !element.classList.contains("typing-indicator")
        && !element.classList.contains("stream-arriving");
    }
    return false;
  }

  function createElement(tagName = "div") {
    const attributes = new Map();
    const listeners = new Map();
    const classes = new Set();
    const children = [];
    const styleValues = new Map();
    const element = {
      append: () => {},
      appendChild(child) {
        if (!child) return child;
        child.parentNode?.removeChild?.(child);
        children.push(child);
        child.parentNode = element;
        if (child.id) byId.set(child.id, child);
        return child;
      },
      addEventListener(type, listener) {
        listeners.set(type, listener);
      },
      classList: {
        add: (...values) => values.forEach((value) => classes.add(value)),
        contains: (value) => classes.has(value),
        remove: (...values) => values.forEach((value) => classes.delete(value)),
        toggle(value, enabled) {
          if (enabled) classes.add(value);
          else classes.delete(value);
        },
      },
      children,
      childNodes: children,
      cloneNode(deep = false) {
        const clone = createElement(element.tagName);
        clone.className = element.className;
        clone.textContent = element.textContent;
        if (deep) {
          for (const child of children) clone.appendChild(child.cloneNode(true));
        }
        return clone;
      },
      closest(selector) {
        let current = element;
        while (current) {
          if (
            selector === ".response-slot"
            && current.classList?.contains("response-slot")
          ) return current;
          current = current.parentNode;
        }
        return null;
      },
      dataset: {},
      getAttribute: (name) => attributes.get(name) ?? null,
      getBoundingClientRect: () => ({ height: 0 }),
      id: "",
      isContentEditable: false,
      listeners,
      get nextSibling() {
        if (!element.parentNode) return null;
        const siblings = element.parentNode.children || [];
        return siblings[siblings.indexOf(element) + 1] || null;
      },
      nodeType: 1,
      get parentElement() {
        return element.parentNode;
      },
      parentNode: null,
      querySelector(selector) {
        return element.querySelectorAll(selector)[0] || null;
      },
      querySelectorAll(selector) {
        const found = [];
        function walk(node) {
          for (const child of node.children || []) {
            if (matches(child, selector)) found.push(child);
            walk(child);
          }
        }
        walk(element);
        return found;
      },
      insertBefore(child, reference) {
        child.parentNode?.removeChild?.(child);
        const index = reference ? children.indexOf(reference) : -1;
        if (index < 0) children.push(child);
        else children.splice(index, 0, child);
        child.parentNode = element;
        return child;
      },
      remove() {
        element.parentNode?.removeChild?.(element);
        if (element.id) byId.delete(element.id);
      },
      removeAttribute(name) {
        attributes.delete(name);
        if (name.startsWith("data-")) delete element.dataset[dataName(name)];
      },
      removeChild(child) {
        const index = children.indexOf(child);
        if (index >= 0) children.splice(index, 1);
        child.parentNode = null;
        return child;
      },
      replaceChildren(...nextChildren) {
        children.splice(0);
        element.renderedValue = nextChildren[0]?.renderedValue || "";
        element.renderedHistory.push(element.renderedValue);
        for (const child of nextChildren) {
          if (child?.nodeType) element.appendChild(child);
        }
      },
      setAttribute(name, value) {
        attributes.set(name, String(value));
        if (name.startsWith("data-")) element.dataset[dataName(name)] = String(value);
      },
      style: {
        getPropertyValue: (name) => styleValues.get(name) || "",
        setProperty: (name, value) => styleValues.set(name, String(value)),
      },
      tagName: String(tagName).toUpperCase(),
      textContent: "",
      renderedHistory: [],
    };
    Object.defineProperty(element, "className", {
      get: () => [...classes].join(" "),
      set(value) {
        classes.clear();
        for (const name of String(value || "").split(/\s+/).filter(Boolean)) {
          classes.add(name);
        }
      },
    });
    return element;
  }

  const documentElement = createElement("html");
  const head = createElement("head");
  const body = createElement("body");
  const chat = createElement("div");
  chat.id = "chat";
  chat.clientHeight = 400;
  chat.scrollHeight = 1000;
  chat.scrollTop = 600;
  const responseSlot = createElement("div");
  responseSlot.className = "response-slot";
  const typingIndicator = createElement("div");
  typingIndicator.className = "msg assistant typing-indicator";
  const avatar = createElement("div");
  avatar.className = "avatar";
  typingIndicator.appendChild(avatar);
  responseSlot.appendChild(typingIndicator);
  chat.appendChild(responseSlot);
  const footer = createElement("footer");
  footer.getBoundingClientRect = () => ({ height: 112.5 });
  byId.set("chat", chat);

  const document = {
    addEventListener: () => {},
    body,
    createElement,
    createDocumentFragment() {
      const fragment = createElement("fragment");
      fragment.nodeType = 11;
      return fragment;
    },
    createTextNode(value) {
      return {
        cloneNode: () => document.createTextNode(value),
        nodeType: 3,
        nodeValue: String(value),
        parentNode: null,
        textContent: String(value),
      };
    },
    documentElement,
    getElementById: (id) => byId.get(id) || null,
    head,
    querySelector(selector) {
      if (selector === "footer") return footer;
      return null;
    },
    querySelectorAll(selector) {
      if (selector === "#chat .typing-indicator") {
        return chat.querySelectorAll(".typing-indicator");
      }
      return [];
    },
  };

  class FakeMutationObserver {
    constructor(callback) {
      this.callback = callback;
    }

    disconnect() {}

    observe(target, options) {
      mutationObservations.push({ observer: this, options, target });
    }
  }

  class FakeResizeObserver {
    constructor(callback) {
      this.callback = callback;
    }

    disconnect() {}

    observe(target) {
      resizeObservations.push({ observer: this, target });
    }
  }

  return {
    FakeMutationObserver,
    FakeResizeObserver,
    chat,
    document,
    footer,
    mutationObservations,
    responseSlot,
    resizeObservations,
    typingIndicator,
  };
}

function installBridge({
  chatLook = "messages",
  chatStreamMode = "smooth",
  chatTypingEnabled = chatStreamMode === "hold",
  clock = fakeClock(),
  lineageResult = { intercepted: false },
  nativeFetch,
} = {}) {
  const messageListeners = new Set();
  const postedMessages = [];
  const dom = createDom();
  const parent = {
    postMessage(message) {
      postedMessages.push(message);
      if (message.type === "rapp-beta:refresh-ambient") {
        queueMicrotask(() => {
          const event = {
            source: parent,
            data: {
              type: "rapp-beta:refresh-ambient-result",
              requestId: message.requestId,
              ok: true,
              result: { device: "fresh" },
            },
          };
          for (const listener of messageListeners) listener(event);
        });
        return;
      }
      if (message.type !== "rapp-beta:lineage-chat") return;
      queueMicrotask(() => {
        const event = {
          source: parent,
          data: {
            type: "rapp-beta:lineage-chat-result",
            requestId: message.requestId,
            ok: true,
            result: lineageResult,
          },
        };
        for (const listener of messageListeners) listener(event);
      });
    },
  };
  const window = {
    __rappBetaChatLookConfig: {
      chatLook,
      chatTypingEnabled,
    },
    addEventListener: () => {},
    alert: () => {},
    clearTimeout: clock.clearTimer,
    confirm: () => true,
    crypto: { randomUUID: () => "request-id" },
    document: dom.document,
    fetch: nativeFetch,
    location: { href: "http://127.0.0.1:7071/" },
    parent,
    removeEventListener(type, listener) {
      if (type === "message") messageListeners.delete(listener);
    },
    setTimeout: clock.setTimer,
  };
  window.addEventListener = (type, listener) => {
    if (type === "message") messageListeners.add(listener);
  };
  const context = vm.createContext({
    console,
    Date: clock.ClockDate,
    document: dom.document,
    Error,
    Headers,
    MutationObserver: dom.FakeMutationObserver,
    DOMParser: class {
      parseFromString() {
        return { body: { childNodes: [] } };
      }
    },
    performance: { now: clock.now },
    requestAnimationFrame: clock.requestFrame,
    cancelAnimationFrame: clock.clearTimer,
    ReadableStream,
    Request,
    ResizeObserver: dom.FakeResizeObserver,
    Response,
    setTimeout: clock.setTimer,
    clearTimeout: clock.clearTimer,
    TextDecoder,
    TextEncoder,
    URL,
    window,
  });
  window.marked = {
    parse: (text) => `rendered:${text}`,
  };
  window.sanitizeMarkdownFragment = (html) => ({
    nodeType: 11,
    renderedValue: html,
  });
  vm.runInContext(materializeBridgeSource(chatStreamMode), context);
  return { clock, dom, postedMessages, window };
}

function controlledResponse({
  headers = {
    "Cache-Control": "no-cache, no-transform",
    "Content-Type": "text/event-stream; charset=utf-8",
    "X-Frontier-Test": "preserved",
  },
} = {}) {
  let controller;
  let canceled = false;
  let cancelReason;
  const stream = new ReadableStream({
    start(nextController) {
      controller = nextController;
    },
    cancel(reason) {
      canceled = true;
      cancelReason = reason;
    },
  });
  return {
    response: new Response(stream, {
      status: 202,
      statusText: "Accepted",
      headers,
    }),
    enqueue(text) {
      controller.enqueue(new TextEncoder().encode(text));
    },
    close() {
      controller.close();
    },
    error(cause) {
      controller.error(cause);
    },
    get canceled() {
      return canceled;
    },
    get cancelReason() {
      return cancelReason;
    },
  };
}

function sse(event) {
  return `data: ${JSON.stringify(event)}\n\n`;
}

async function nextTask() {
  await new Promise((resolve) => setImmediate(resolve));
}

async function readChunks(reader) {
  const decoder = new TextDecoder();
  const chunks = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(decoder.decode(value, { stream: true }));
  }
  const tail = decoder.decode();
  if (tail) chunks.push(tail);
  return chunks;
}

function parseEvents(text) {
  return text
    .split(/\r?\n\r?\n/)
    .map((frame) => frame.split(/\r?\n/).find((line) => line.startsWith("data:")))
    .filter(Boolean)
    .map((line) => JSON.parse(line.slice(5).trim()));
}

function largeReply(length = 1600) {
  const phrase = "Smooth streams every word, emoji 🙂, and punctuation cleanly. ";
  return phrase.repeat(Math.ceil(length / phrase.length)).slice(0, length);
}

test("smooth bridge renders provisionally while holding the kernel wire", async () => {
  const upstream = controlledResponse();
  const installed = installBridge({
    chatStreamMode: "smooth",
    nativeFetch: async () => upstream.response,
  });
  const wrapped = await installed.window.fetch(
    "http://127.0.0.1:7071/chat/stream",
    {
      method: "POST",
      body: JSON.stringify({ user_input: "hello" }),
    },
  );
  const text = largeReply();
  const frames = [
    sse({ type: "delta", text }),
    sse({ type: "agent", logs: "tool complete" }),
    sse({ type: "done", response: text }),
  ];
  const reader = wrapped.body.getReader();
  const firstRead = reader.read();
  let kernelReadSettled = false;
  void firstRead.then(
    () => { kernelReadSettled = true; },
    () => { kernelReadSettled = true; },
  );

  upstream.enqueue(frames[0]);
  await nextTask();
  installed.clock.runAll();
  await nextTask();

  const streamingStats = installed.window.__rappSmoothScreenStats;
  const provisional = installed.dom.responseSlot.children.find(
    (child) => child.dataset.rappProvisional === "1",
  );
  const bubble = provisional?.querySelector(".bubble");
  assert.equal(kernelReadSettled, false);
  assert.ok(
    streamingStats.renderCount >= 40,
    `expected >=40 renders, got ${streamingStats.renderCount}`,
  );
  assert.equal(streamingStats.shownText, text);
  assert.equal(
    installed.window.__rappSmoothMarkdownCapabilities.marked,
    true,
  );
  assert.equal(
    installed.window.__rappSmoothMarkdownCapabilities.sanitizer,
    true,
  );
  assert.equal(
    installed.window.__rappSmoothMarkdownCapabilities.normalizeMd,
    false,
  );
  assert.ok(bubble);
  assert.equal(bubble.renderedHistory.length, streamingStats.renderCount);
  for (let index = 1; index < bubble.renderedHistory.length; index += 1) {
    assert.ok(
      bubble.renderedHistory[index].length
        >= bubble.renderedHistory[index - 1].length,
      `render ${index} regressed`,
    );
  }

  upstream.enqueue(frames[1]);
  upstream.enqueue(frames[2]);
  upstream.close();
  await nextTask();
  installed.clock.runAll();
  await nextTask();

  const first = await firstRead;
  const replay = new TextDecoder().decode(first.value) + (
    await readChunks(reader)
  ).join("");
  assert.equal(replay, frames.join(""));

  assert.ok(provisional);
  provisional.getBoundingClientRect = () => ({ height: 180 });
  const finalBubble = installed.dom.document.createElement("div");
  finalBubble.className = "msg assistant";
  finalBubble.getBoundingClientRect = () => ({ height: 172 });
  installed.dom.responseSlot.appendChild(finalBubble);
  const handoffObservation = installed.dom.mutationObservations.find(
    ({ target }) => target === installed.dom.responseSlot,
  );
  assert.ok(handoffObservation);
  handoffObservation.observer.callback();
  handoffObservation.observer.callback();

  const finalStats = installed.window.__rappSmoothScreenStats;
  assert.equal(finalStats.handoffCount, 1);
  assert.equal(finalStats.removeCount, 1);
  assert.equal(finalStats.heightDelta, -8);
  assert.equal(
    installed.dom.responseSlot.children.includes(provisional),
    false,
  );
  console.log(
    `smooth v2: 0 kernel bytes before terminal; `
      + `${streamingStats.renderCount} monotonic provisional renders; `
      + "byte-equality yes; handoff 1; removal 1; |height delta| 8px",
  );
});

test("smooth terminal event drains the screen and releases wire before EOF", async () => {
  const upstream = controlledResponse();
  const installed = installBridge({
    chatStreamMode: "smooth",
    nativeFetch: async () => upstream.response,
  });
  const wrapped = await installed.window.fetch(
    "http://127.0.0.1:7071/chat/stream",
    {
      method: "POST",
      body: JSON.stringify({ user_input: "hello" }),
    },
  );
  const text = "terminal done flushes every queued word immediately";
  const reader = wrapped.body.getReader();
  const firstRead = reader.read();
  let settled = false;
  void firstRead.then(() => { settled = true; });

  const deltaFrame = sse({ type: "delta", text });
  const doneFrame = sse({ type: "done", response: text });
  upstream.enqueue(deltaFrame);
  await nextTask();
  assert.ok(installed.clock.pending() > 0);
  assert.equal(settled, false);
  upstream.enqueue(doneFrame);
  await nextTask();
  installed.clock.runAll();
  await nextTask();

  const first = await firstRead;
  const second = await reader.read();
  const replay = new TextDecoder().decode(first.value)
    + new TextDecoder().decode(second.value);
  assert.equal(replay, deltaFrame + doneFrame);
  assert.equal(
    installed.window.__rappSmoothScreenStats.shownText,
    text,
  );
  assert.equal(installed.clock.pending(), 0);
  upstream.close();
  assert.equal((await reader.read()).done, true);
  console.log("smooth terminal drain: final screen and held wire released before EOF");
});

test("smooth style and follow observers exist only in smooth mode", () => {
  const smooth = installBridge({
    chatStreamMode: "smooth",
    nativeFetch: async () => new Response("ok"),
  });
  const style = smooth.dom.document.getElementById("__rappStreamStyle");
  assert.ok(style);
  assert.match(style.textContent, /-webkit-mask-image:\s*none !important/);
  assert.match(style.textContent, /mask-image:\s*none !important/);
  assert.match(style.textContent, /stream-arriving \.bubble::after/);
  assert.match(style.textContent, /padding-bottom:\s*var\(--rapp-stream-footer-clearance/);
  assert.doesNotMatch(style.textContent, /translateY/);
  assert.equal(
    smooth.dom.document.documentElement.dataset.rappStream,
    "smooth",
  );
  assert.equal(
    smooth.dom.document.documentElement.style.getPropertyValue(
      "--rapp-stream-footer-clearance",
    ),
    "112.5px",
  );
  assert.ok(smooth.window.__rappSmoothTailFollow);
  assert.ok(
    smooth.dom.mutationObservations.some(({ target }) => target === smooth.dom.chat),
  );
  assert.ok(
    smooth.dom.resizeObservations.some(({ target }) => target === smooth.dom.footer),
  );

  for (const mode of ["raw", "hold"]) {
    const installed = installBridge({
      chatStreamMode: mode,
      nativeFetch: async () => new Response("ok"),
    });
    assert.equal(
      installed.dom.document.getElementById("__rappStreamStyle"),
      null,
    );
    assert.equal(installed.window.__rappSmoothTailFollow, undefined);
    assert.equal(
      installed.dom.document.documentElement.style.getPropertyValue(
        "--rapp-stream-footer-clearance",
      ),
      "",
    );
  }
  console.log("smooth-only style, exact 112.5px clearance, and observers present");
});

test("raw bridge passes the native stream response through unchanged", async () => {
  const upstream = controlledResponse();
  const installed = installBridge({
    chatStreamMode: "raw",
    nativeFetch: async () => upstream.response,
  });
  const response = await installed.window.fetch(
    "http://127.0.0.1:7071/chat/stream",
    {
      method: "POST",
      body: JSON.stringify({ user_input: "hello" }),
    },
  );

  assert.strictEqual(response, upstream.response);
  console.log("raw: native response pass-through");
});

test("hold emits zero bytes before completion and replays ordered SSE", async () => {
  const upstream = controlledResponse();
  const installed = installBridge({
    chatStreamMode: "hold",
    nativeFetch: async () => upstream.response,
  });
  const wrapped = await installed.window.fetch(
    "http://127.0.0.1:7071/chat/stream",
    {
      method: "POST",
      body: JSON.stringify({ user_input: "hello" }),
    },
  );
  const frames = [
    sse({ type: "delta", text: "one" }),
    sse({ type: "delta", text: " two" }),
    sse({ type: "delta", text: " three" }),
    sse({ type: "done", response: "one two three" }),
  ];
  const reader = wrapped.body.getReader();
  const firstRead = reader.read();
  let settled = false;
  void firstRead.then(
    () => { settled = true; },
    () => { settled = true; },
  );
  for (const frame of frames) upstream.enqueue(frame);
  await nextTask();
  assert.equal(settled, false);

  upstream.close();
  const first = await firstRead;
  const remaining = await readChunks(reader);
  const decoder = new TextDecoder();
  const replay = decoder.decode(first.value) + remaining.join("");
  assert.equal(replay, frames.join(""));
  console.log("hold: 0 bytes before completion; ordered replay yes");
});

test("raw, smooth, and hold record only terminal Brainstem turns", async () => {
  for (const chatStreamMode of ["raw", "smooth", "hold"]) {
    const upstream = controlledResponse();
    const installed = installBridge({
      chatStreamMode,
      nativeFetch: async () => upstream.response,
    });
    const response = await installed.window.fetch(
      "http://127.0.0.1:7071/chat/stream",
      {
        method: "POST",
        body: JSON.stringify({
          user_input: "what's the weather here",
          session_id: "session-weather",
        }),
      },
    );
    const reading = readChunks(response.body.getReader());
    upstream.enqueue(sse({ type: "delta", text: "sun" }));
    await nextTask();
    assert.equal(
      installed.postedMessages.filter(
        ({ type }) => type === "rapp-beta:ledger-turn",
      ).length,
      0,
      `${chatStreamMode} persisted partial text`,
    );
    upstream.enqueue(sse({
      type: "done",
      response: "sunny",
      session_id: "session-weather",
      agent_logs: "[WeatherAgent] deterministic forecast",
      model: "scripted",
    }));
    await nextTask();
    assert.equal(
      installed.postedMessages.filter(
        ({ type }) => type === "rapp-beta:ledger-turn",
      ).length,
      0,
      `${chatStreamMode} persisted before clean completion`,
    );
    upstream.close();
    await nextTask();
    if (chatStreamMode === "smooth") installed.clock.runAll();
    await reading;
    await nextTask();

    const captured = installed.postedMessages.filter(
      ({ type }) => type === "rapp-beta:ledger-turn",
    );
    assert.equal(captured.length, 1, `${chatStreamMode} terminal capture`);
    assert.deepEqual(
      JSON.parse(JSON.stringify(captured[0].turn)),
      {
        agentLogs: "[WeatherAgent] deterministic forecast",
        model: "scripted",
        requestId: "request-id",
        response: "sunny",
        sessionId: "session-weather",
        userInput: "what's the weather here",
      },
    );
  }
});

test("non-stream chat records after JSON completion without replacing the response", async () => {
  const nativeResponse = new Response(JSON.stringify({
    response: "complete",
    session_id: "session-json",
    agent_logs: "",
    model: "scripted",
  }), {
    headers: { "Content-Type": "application/json" },
  });
  const installed = installBridge({
    chatStreamMode: "raw",
    nativeFetch: async () => nativeResponse,
  });
  const response = await installed.window.fetch(
    "http://127.0.0.1:7071/chat",
    {
      method: "POST",
      body: JSON.stringify({
        user_input: "hello",
        session_id: "session-json",
      }),
    },
  );
  assert.strictEqual(response, nativeResponse);
  assert.equal(
    installed.postedMessages.filter(
      ({ type }) => type === "rapp-beta:ledger-turn",
    ).length,
    0,
  );
  assert.equal((await response.json()).response, "complete");
  assert.equal(
    installed.postedMessages.filter(
      ({ type }) => type === "rapp-beta:ledger-turn",
    ).length,
    1,
  );
});

test("lineage synthetic replies record only when consumed to completion", async () => {
  const installed = installBridge({
    chatStreamMode: "raw",
    lineageResult: {
      intercepted: true,
      reply: "Restored the verified lineage.",
      url: "http://127.0.0.1:7071",
    },
    nativeFetch: async () => {
      throw new Error("An intercepted command must not reach native fetch.");
    },
  });
  const response = await installed.window.fetch(
    "http://127.0.0.1:7071/chat/stream",
    {
      method: "POST",
      body: JSON.stringify({ user_input: "restore" }),
    },
  );
  const reader = response.body.getReader();
  const first = await reader.read();
  assert.equal(first.done, false);
  assert.equal(
    installed.postedMessages.filter(
      ({ type }) => type === "rapp-beta:ledger-turn",
    ).length,
    0,
  );
  assert.equal((await reader.read()).done, true);
  const turns = installed.postedMessages.filter(
    ({ type }) => type === "rapp-beta:ledger-turn",
  );
  assert.equal(turns.length, 1);
  assert.equal(turns[0].turn.userInput, "restore");
  assert.equal(turns[0].turn.response, "Restored the verified lineage.");

  const canceled = installBridge({
    chatStreamMode: "raw",
    lineageResult: {
      intercepted: true,
      reply: "Not delivered.",
    },
    nativeFetch: async () => {
      throw new Error("An intercepted command must not reach native fetch.");
    },
  });
  const canceledResponse = await canceled.window.fetch(
    "http://127.0.0.1:7071/chat/stream",
    {
      method: "POST",
      body: JSON.stringify({ user_input: "baseline" }),
    },
  );
  await canceledResponse.body.getReader().cancel();
  assert.equal(
    canceled.postedMessages.filter(
      ({ type }) => type === "rapp-beta:ledger-turn",
    ).length,
    0,
  );
});

test("frame bridge injects and removes Messages look without a reload", () => {
  const installed = installBridge({
    chatLook: "messages",
    nativeFetch: async () => new Response("ok"),
  });
  const { window } = installed;
  const marker = window.__rappBetaFrameBridge;

  assert.ok(window.document.getElementById("__rappChatLook"));
  assert.equal(
    window.document.documentElement.getAttribute("data-rapp-look"),
    "messages",
  );
  console.log("inject: Messages style and html[data-rapp-look] present");

  const applied = window.__rappBetaApplyChatLook("business", false);
  assert.equal(applied.chatLook, "business");
  assert.equal(applied.chatTypingEnabled, false);
  assert.equal(window.__rappBetaFrameBridge, marker);
  assert.equal(window.document.getElementById("__rappChatLook"), null);
  assert.equal(
    window.document.documentElement.getAttribute("data-rapp-look"),
    null,
  );
  console.log("remove: Messages style and root attribute removed without reload");

  const business = installBridge({
    chatLook: "business",
    chatTypingEnabled: false,
    nativeFetch: async () => new Response("ok"),
  });
  assert.equal(
    business.window.document.getElementById("__rappChatLook"),
    null,
  );
  assert.equal(
    business.window.document.documentElement.getAttribute("data-rapp-look"),
    null,
  );
  console.log("business injects nothing");
});

test("smooth upstream error flushes queued text followed by error", async () => {
  const upstream = controlledResponse();
  const installed = installBridge({
    chatStreamMode: "smooth",
    nativeFetch: async () => upstream.response,
  });
  const wrapped = await installed.window.fetch(
    "http://127.0.0.1:7071/chat/stream",
    {
      method: "POST",
      body: JSON.stringify({ user_input: "hello" }),
    },
  );
  const text = "partial words remain byte equal";
  upstream.enqueue(sse({ type: "delta", text }));
  await nextTask();
  const provisional = installed.dom.responseSlot.children.find(
    (child) => child.dataset.rappProvisional === "1",
  );
  assert.ok(provisional);
  upstream.error(new Error("upstream exploded"));

  const events = parseEvents((await readChunks(wrapped.body.getReader())).join(""));
  assert.equal(
    events.filter((event) => event.type === "delta")
      .map((event) => event.text)
      .join(""),
    text,
  );
  assert.equal(events.at(-1).type, "error");
  assert.equal(events.at(-1).error, "upstream exploded");
  assert.equal(
    installed.dom.responseSlot.children.includes(provisional),
    false,
  );
  assert.equal(
    installed.window.__rappSmoothScreenStats.removeCount,
    1,
  );
  assert.equal(
    installed.dom.typingIndicator.classList.contains("rapp-provisional-hidden"),
    false,
  );
});

test("aborting a smooth response cancels upstream", async () => {
  const upstream = controlledResponse();
  const installed = installBridge({
    chatStreamMode: "smooth",
    nativeFetch: async () => upstream.response,
  });
  const controller = new AbortController();
  const wrapped = await installed.window.fetch(
    "http://127.0.0.1:7071/chat/stream",
    {
      method: "POST",
      body: JSON.stringify({ user_input: "hello" }),
      signal: controller.signal,
    },
  );
  const read = wrapped.body.getReader().read();
  upstream.enqueue(sse({ type: "delta", text: "visible before abort" }));
  await nextTask();
  const provisional = installed.dom.responseSlot.children.find(
    (child) => child.dataset.rappProvisional === "1",
  );
  assert.ok(provisional);

  controller.abort();

  await assert.rejects(read, (cause) => cause?.name === "AbortError");
  assert.equal(upstream.canceled, true);
  assert.equal(upstream.cancelReason?.name, "AbortError");
  assert.equal(installed.clock.pending(), 0);
  assert.equal(
    installed.dom.responseSlot.children.includes(provisional),
    false,
  );
  assert.equal(
    installed.window.__rappSmoothScreenStats.removeCount,
    1,
  );
});

test("smooth mode keeps two in-flight requests in their own response slots", async () => {
  // The kernel creates a response slot + typing indicator per send and never
  // gates on in-flight requests. A is sent, then B; A's first delta arrives
  // first. The provisional bubble for A must land under A, not under the
  // newest (B's) indicator.
  const upstreamA = controlledResponse();
  const upstreamB = controlledResponse();
  let calls = 0;
  const installed = installBridge({
    chatStreamMode: "smooth",
    nativeFetch: async () => (++calls === 1 ? upstreamA.response : upstreamB.response),
  });
  const { document } = installed.dom;
  const slotA = installed.dom.responseSlot;
  const chat = installed.dom.chat
    || slotA.parentElement
    || slotA.parentNode;
  assert.ok(chat, "the fake DOM exposes the chat container");

  const pendingA = installed.window.fetch("http://127.0.0.1:7071/chat/stream", {
    method: "POST",
    body: JSON.stringify({ user_input: "A" }),
  });
  // A's fetch pauses for ambient/lineage IPC before native fetch. The indicator
  // must already be claimed when the kernel synchronously creates B's slot.
  const slotB = document.createElement("div");
  slotB.className = "response-slot";
  const indicatorB = document.createElement("div");
  indicatorB.className = "msg assistant typing-indicator";
  slotB.appendChild(indicatorB);
  chat.appendChild(slotB);
  const pendingB = installed.window.fetch("http://127.0.0.1:7071/chat/stream", {
    method: "POST",
    body: JSON.stringify({ user_input: "B" }),
  });
  const [wrappedA, wrappedB] = await Promise.all([pendingA, pendingB]);
  const readerA = wrappedA.body.getReader();
  const readerB = wrappedB.body.getReader();
  void readerA.read().catch(() => {});
  void readerB.read().catch(() => {});

  upstreamA.enqueue(sse({ type: "delta", text: "reply for A" }));
  await nextTask();
  installed.clock.runAll();
  await nextTask();

  const provisionalIn = (slot) => slot.children.find((child) => child.dataset?.rappProvisional === "1") || null;
  assert.ok(provisionalIn(slotA), "A's provisional bubble renders under A's own indicator");
  assert.equal(provisionalIn(slotB), null, "B's slot is untouched by A's stream");

  upstreamB.enqueue(sse({ type: "delta", text: "reply for B" }));
  await nextTask();
  installed.clock.runAll();
  await nextTask();
  assert.ok(provisionalIn(slotB), "B's provisional bubble renders under B's own indicator");
  assert.ok(provisionalIn(slotA), "A's bubble is still in A's slot");

  upstreamA.enqueue(sse({ type: "done", response: "reply for A" }));
  upstreamB.enqueue(sse({ type: "done", response: "reply for B" }));
  upstreamA.close();
  upstreamB.close();
  await nextTask();
  installed.clock.runAll();
  await nextTask();
});
