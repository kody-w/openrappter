import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

await import("../ui/stream-render-pacing.js");

const {
  createAdaptiveRenderPacer,
  splitRenderPieces,
} = globalThis.RappStreamRenderPacing;

function fakeFrames(intervalMs = 24) {
  let currentTime = 0;
  let sequence = 0;
  const tasks = new Map();

  function requestFrame(callback) {
    const id = ++sequence;
    tasks.set(id, {
      at: currentTime + intervalMs,
      callback,
      id,
    });
    return id;
  }

  function cancelFrame(id) {
    tasks.delete(id);
  }

  function runNext() {
    const next = [...tasks.values()].sort(
      (left, right) => left.at - right.at || left.id - right.id,
    )[0];
    if (!next) return false;
    tasks.delete(next.id);
    currentTime = next.at;
    next.callback(currentTime);
    return true;
  }

  function runAll(limit = 10000) {
    let count = 0;
    while (runNext()) {
      count += 1;
      if (count > limit) throw new Error("Fake frame runaway.");
    }
  }

  function advance(ms) {
    const goal = currentTime + ms;
    while (true) {
      const next = [...tasks.values()].sort(
        (left, right) => left.at - right.at || left.id - right.id,
      )[0];
      if (!next || next.at > goal) break;
      runNext();
    }
    currentTime = goal;
  }

  return {
    advance,
    cancelFrame,
    now: () => currentTime,
    pending: () => tasks.size,
    requestFrame,
    runAll,
  };
}

function replyOfLength(length) {
  const phrase = "Smooth v2 renders every word, emoji 🙂, and Markdown token. ";
  return phrase.repeat(Math.ceil(length / phrase.length)).slice(0, length);
}

test("render splitter preserves word-granular multibyte text", () => {
  const text = "Hello, smooth world 🙂\n```js\nconst café = true;\n```";
  const pieces = splitRenderPieces(text);

  assert.equal(pieces.join(""), text);
  assert.ok(pieces.length > 4);
  assert.doesNotMatch(pieces.join(""), /\uFFFD/u);
});

test("1600-character burst renders monotonically at least forty times", () => {
  const frames = fakeFrames();
  const renders = [];
  const text = replyOfLength(1600);
  const pacer = createAdaptiveRenderPacer({
    now: frames.now,
    requestFrame: frames.requestFrame,
    cancelFrame: frames.cancelFrame,
    onRender: (value) => renders.push(value),
  });

  pacer.push(text);
  assert.equal(renders.length, 1);
  assert.ok(renders[0].length > 0);
  frames.runAll();

  assert.ok(renders.length >= 40, `expected >=40 renders, got ${renders.length}`);
  assert.equal(renders.at(-1), text);
  for (let index = 1; index < renders.length; index += 1) {
    assert.ok(renders[index].startsWith(renders[index - 1]));
    assert.ok(renders[index].length > renders[index - 1].length);
  }
  assert.ok(pacer.metrics().maxLagMs <= 1000);
});

test("arrival EMA adapts to inter-chunk timing", () => {
  const frames = fakeFrames();
  const pacer = createAdaptiveRenderPacer({
    now: frames.now,
    requestFrame: frames.requestFrame,
    cancelFrame: frames.cancelFrame,
  });

  pacer.push("first words ");
  frames.advance(120);
  pacer.push("second words ");
  const afterSlow = pacer.metrics().emaArrivalMs;
  frames.advance(32);
  pacer.push("third words ");
  const afterFast = pacer.metrics().emaArrivalMs;

  assert.ok(afterSlow < 1000);
  assert.ok(afterFast < afterSlow);
});

test("terminal drain completes within three hundred milliseconds", async () => {
  const frames = fakeFrames();
  const renders = [];
  const text = replyOfLength(800);
  const pacer = createAdaptiveRenderPacer({
    now: frames.now,
    requestFrame: frames.requestFrame,
    cancelFrame: frames.cancelFrame,
    onRender: (value) => renders.push([frames.now(), value]),
  });

  pacer.push(text);
  const startedAt = frames.now();
  const drained = pacer.finish();
  frames.runAll();
  await drained;

  assert.equal(renders.at(-1)[1], text);
  assert.ok(frames.now() - startedAt <= 300);
  assert.equal(pacer.metrics().pendingPieces, 0);
});

test("terminal drain falls back when animation frames pause", async () => {
  const renders = [];
  let fallback = null;
  let cancelledFrame = null;
  const text = replyOfLength(800);
  const pacer = createAdaptiveRenderPacer({
    cancelFrame: (frame) => {
      cancelledFrame = frame;
    },
    clearTimer() {},
    now: () => 0,
    onRender: (value) => renders.push(value),
    requestFrame: () => 17,
    setTimer: (callback, delay) => {
      fallback = { callback, delay };
      return 23;
    },
  });

  pacer.push(text);
  const drained = pacer.finish();
  assert.equal(fallback?.delay, 300);
  fallback.callback();
  await drained;

  assert.equal(renders.at(-1), text);
  assert.equal(cancelledFrame, 17);
  assert.equal(pacer.metrics().pendingPieces, 0);
  const mainSource = readFileSync(
    new URL("../electron/main.mjs", import.meta.url),
    "utf8",
  );
  assert.match(mainSource, /backgroundThrottling:\s*false/);
});

test("abort cancels pending frames and keeps the shown prefix", async () => {
  const frames = fakeFrames();
  const pacer = createAdaptiveRenderPacer({
    now: frames.now,
    requestFrame: frames.requestFrame,
    cancelFrame: frames.cancelFrame,
  });

  pacer.push("one two three four five");
  const shown = pacer.text();
  assert.equal(pacer.abort(), true);
  frames.runAll();

  assert.equal(pacer.text(), shown);
  assert.equal(frames.pending(), 0);
  assert.equal(await pacer.finish(), shown);
});
