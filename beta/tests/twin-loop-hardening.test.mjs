import assert from "node:assert/strict";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { TwinManager } from "../electron/twin-manager.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (r) => readFileSync(path.join(root, r), "utf8");

// A TwinManager wired to a stubbed Brainstem + twin so we can drive loop()/chat()
// deterministically and inspect the exact /chat request bodies.
function harness({ brainstemReplies }) {
  const calls = [];
  let bsIdx = 0;
  const events = [];
  const betaHome = mkdtempSync(path.join(tmpdir(), "twinmgr-"));
  const manager = new TwinManager({
    brainstemConfig: { url: "http://bs.local" },
    betaHome,
    storeClient: {},
    brainstemUrl: () => "http://bs.local",
    onEvent: (e) => events.push(e),
  });
  manager.twins.set("t1", {
    id: "t1", name: "Twin", url: "http://twin.local", status: "ready",
    loopLog: [], running: false, license: "MIT", port: 5, rappid: "r", createdUtc: "u",
  });
  const originalFetch = global.fetch;
  global.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    calls.push({ url: String(url), body });
    const isBrainstem = String(url).startsWith("http://bs.local");
    const response = isBrainstem
      ? (brainstemReplies[bsIdx++] ?? "DONE — finished")
      : "Twin did the step.";
    return { ok: true, json: async () => ({ response }) };
  };
  return { manager, calls, events, restore: () => { global.fetch = originalFetch; } };
}

test("loop(): the Brainstem keeps the goal + prior turns after round 1 (memory via conversation_history)", async () => {
  // Opening plan → "step one"; after twin reply → "step two"; then "DONE".
  const h = harness({ brainstemReplies: ["step one", "step two", "DONE — met"] });
  try {
    await h.manager.loop("t1", "GOAL-XYZ-UNIQUE", { maxRounds: 4 });
  } finally {
    h.restore();
  }
  const bsCalls = h.calls.filter((c) => c.url.startsWith("http://bs.local"));
  const twinCalls = h.calls.filter((c) => c.url.startsWith("http://twin.local"));
  assert.ok(bsCalls.length >= 2, "the Brainstem should be consulted every round");

  // A non-opening planner turn must still carry the goal — via history or a restated prompt.
  const laterPlan = bsCalls[1];
  const planBlob = JSON.stringify(laterPlan.body);
  assert.ok(planBlob.includes("GOAL-XYZ-UNIQUE"),
    "after round 1 the planner must still see the goal (history or restated prompt)");
  assert.ok(Array.isArray(laterPlan.body.conversation_history) && laterPlan.body.conversation_history.length >= 2,
    "the planner call must forward prior turns as conversation_history");

  // The twin must build on prior room turns too (not be memoryless).
  assert.ok(twinCalls.length >= 2, "the twin should be driven each round");
  assert.ok(Array.isArray(twinCalls[1].body.conversation_history) && twinCalls[1].body.conversation_history.length >= 1,
    "the twin's later turns must forward the room's conversation_history");
});

test("loop(): an empty goal surfaces a visible error instead of a silent no-op", async () => {
  const h = harness({ brainstemReplies: [] });
  try {
    await h.manager.loop("t1", "   ", { maxRounds: 2 });
  } finally {
    h.restore();
  }
  const errored = h.events.some((e) => e.type === "twin-message" && e.role === "error");
  assert.ok(errored, "an empty goal must emit a visible twin-message error, not vanish");
  assert.equal(h.calls.length, 0, "no /chat calls should happen for an empty goal");
});

// ── Structural guards for the remaining consensus fixes ──

test("chat() forwards per-room conversation memory to the twin", () => {
  const tm = read("electron/twin-manager.mjs");
  assert.match(tm, /roomHistory/);
  assert.match(tm, /conversation_history/);
});

test("the needs-auth gate matches an auth REQUEST, not incidental auth vocabulary", () => {
  const tm = read("electron/twin-manager.mjs");
  // tightened phrasing — a request, not a bare mention of 'authentication'
  assert.match(tm, /authentication required|please sign in|device login|not authenticated/i);
  // the loose bare-substring 'authenticat' alternative should be gone
  assert.doesNotMatch(tm, /\|authenticat\|/);
});

test("run(): an empty twin reply is treated as an error, not success", () => {
  const tm = read("electron/twin-manager.mjs");
  // no longer `|| !text` short-circuiting to done
  assert.doesNotMatch(tm, /\|\|\s*!text\s*\)\s*\{[^}]*done/);
});

test("close() signals an in-flight loop so no ghost tile is resurrected", () => {
  const tm = read("electron/twin-manager.mjs");
  assert.match(tm, /twin\.closed = true/);
  assert.match(tm, /twin\.closed/);   // guarded in the loop/emit path
});

test("the renderer distinguishes the human (self) from driver turns by author, not wire role", () => {
  const renderer = read("ui/renderer.js");
  assert.match(renderer, /author[\s\S]{0,40}(toLowerCase\(\)\s*===\s*"you"|===\s*"You")/);
  assert.match(renderer, /driver/);            // Brainstem/Surgeon driver styling
  const ui = read("ui/index.html");
  assert.match(ui, /\.tw-msg\.driver/);
});

test("the twin transcript array is bounded (no unbounded memory growth)", () => {
  const renderer = read("ui/renderer.js");
  assert.match(renderer, /entry\.chat\.splice\(0/);
});

test("store-picker hatch failures are surfaced to the user, not swallowed", () => {
  const renderer = read("ui/renderer.js");
  assert.doesNotMatch(renderer, /catch \(cause\) \{ \/\* surfaced via twin events \*\/ void cause; \}/);
});

test("the RAPP Store fails CLOSED when a singleton has no sha256 pin", () => {
  const store = read("electron/rapp-store.mjs");
  assert.match(store, /singleton_sha256|singletonSha256/);
  assert.match(store, /throw|reject/i);
});

test("twin workers are pinned to loopback regardless of ambient LAN mode (canon)", () => {
  const tm = read("electron/twin-manager.mjs");
  // a twin runs sha-pinned-but-third-party store code; it must never inherit the
  // main brainstem's LAN mode and bind 0.0.0.0 (rapp-kernel-boundary/1.0).
  assert.match(tm, /BRAINSTEM_LAN_MODE:\s*"0"/);
});
