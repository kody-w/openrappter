import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveChatStreamMode,
} from "../electron/chat-stream-mode.mjs";

await import("../ui/stream-pacing.js");

const {
  createStreamPacer,
  createTextSplitter,
  splitTextPieces,
} = globalThis.RappStreamPacing;

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

  function runNext() {
    const next = [...tasks.values()].sort(
      (left, right) => left.at - right.at || left.id - right.id,
    )[0];
    if (!next) return false;
    tasks.delete(next.id);
    currentTime = next.at;
    next.callback();
    return true;
  }

  function runAll(limit = 10000) {
    let count = 0;
    while (runNext()) {
      count += 1;
      if (count > limit) throw new Error("Fake timer runaway.");
    }
  }

  return {
    clearTimer,
    now: () => currentTime,
    runAll,
    runNext,
    setTimer,
  };
}

function textOfLength(length) {
  const phrase = "Smooth streaming keeps every word, emoji 🙂, and pause. ";
  return phrase.repeat(Math.ceil(length / phrase.length)).slice(0, length);
}

test("stream mode defaults smooth and keeps the typing flag as a hold alias", () => {
  assert.equal(resolveChatStreamMode({}), "smooth");
  assert.equal(resolveChatStreamMode({ RAPP_CHAT_STREAM: "raw" }), "raw");
  assert.equal(resolveChatStreamMode({ RAPP_CHAT_STREAM: "hold" }), "hold");
  assert.equal(resolveChatStreamMode({ RAPP_CHAT_STREAM: "unknown" }), "smooth");
  assert.equal(
    resolveChatStreamMode({
      RAPP_CHAT_STREAM: "raw",
      RAPP_CHAT_TYPING: "1",
    }),
    "hold",
  );
  assert.equal(
    resolveChatStreamMode({ RAPP_CHAT_TYPING: "0" }),
    "smooth",
  );
});

test("splitter preserves text byte-for-byte with punctuation attached", () => {
  const text = "Hello, world!  This is smooth.\nNext line.";
  const pieces = splitTextPieces(text);

  assert.equal(pieces.join(""), text);
  assert.deepEqual(pieces, [
    "Hello, ",
    "world!  ",
    "This ",
    "is ",
    "smooth.\n",
    "Next ",
    "line.",
  ]);
});

test("stateful splitter does not divide a markdown fence across deltas", () => {
  const splitter = createTextSplitter();
  const pieces = [
    ...splitter.push("Before\n``"),
    ...splitter.push("`js\nconst value = '🙂';\n``"),
    ...splitter.push("`\nAfter"),
    ...splitter.finish(),
  ];
  const text = "Before\n```js\nconst value = '🙂';\n```\nAfter";

  assert.equal(pieces.join(""), text);
  assert.ok(pieces.some((piece) => piece.includes("```js")));
  assert.ok(pieces.some((piece) => piece.includes("```\n")));
  assert.ok(!pieces.includes("`"));
  assert.ok(!pieces.includes("``"));
});

test("splitter keeps multibyte text intact", () => {
  const text = "🙂 café 漢字 🚀\nnaïve résumé";
  const pieces = splitTextPieces(text);

  assert.equal(pieces.join(""), text);
  assert.doesNotMatch(pieces.join(""), /\uFFFD/u);
});

test("scheduler emits its first piece immediately and preserves event order", () => {
  const clock = fakeClock();
  const output = [];
  const pacer = createStreamPacer({
    cadenceMs: 32,
    maxLagMs: 1000,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    onText: (text) => output.push(["text", text, clock.now()]),
    onEvent: (event) => output.push(["event", event, clock.now()]),
  });

  pacer.push("one two three");
  assert.deepEqual(output, [["text", "one ", 0]]);
  pacer.event("agent");
  pacer.push(" four");
  clock.runAll();

  assert.deepEqual(
    output.map(([kind, value]) => [kind, value]),
    [
      ["text", "one "],
      ["text", "two "],
      ["text", "three"],
      ["event", "agent"],
      ["text", " four"],
    ],
  );
});

test("terminal events flush queued text immediately", () => {
  const clock = fakeClock();
  const output = [];
  const pacer = createStreamPacer({
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    onText: (text) => output.push(["text", text, clock.now()]),
    onEvent: (event) => output.push(["event", event, clock.now()]),
  });

  pacer.push("one two three four");
  pacer.event("done", { terminal: true });

  assert.equal(
    output.filter(([kind]) => kind === "text").map(([, value]) => value).join(""),
    "one two three four",
  );
  assert.deepEqual(output.at(-1), ["event", "done", 0]);
});

test("1600-character backlog stays within one second at a steady cadence", () => {
  const clock = fakeClock();
  const emitted = [];
  const text = textOfLength(1600);
  const pacer = createStreamPacer({
    cadenceMs: 32,
    maxLagMs: 1000,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    onText: (piece) => emitted.push(piece),
  });

  pacer.push(text);
  clock.runAll();
  const metrics = pacer.metrics();

  assert.equal(emitted.join(""), text);
  assert.ok(emitted.length >= 24, `expected at least 24 paced chunks, got ${emitted.length}`);
  assert.ok(metrics.maxLagMs <= 1000, `max lag was ${metrics.maxLagMs}ms`);
  assert.ok(metrics.piecesPerSecond >= 24);
  assert.ok(metrics.piecesPerSecond <= 40);
  console.log(
    `cadence 1600 chars: ${metrics.piecesPerSecond.toFixed(1)} pieces/s, `
      + `max lag ${metrics.maxLagMs}ms, ${emitted.length} emitted pieces`,
  );
});
