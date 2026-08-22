import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import {
  buildFrame,
  verifyFrame,
} from "../electron/qqdrill-deps.mjs";
import {
  createStore,
  readLine,
  loadSource,
  localSavedSource,
  fold,
} from "../electron/drill-app.mjs";

// drill-app — the application that makes qqdrill.mjs reachable by a person.
//
// This file covers two things only: getting a commons INTO the app, and the
// property the whole method exists to provide — two machines that never speak
// to each other, given the same frames, end up at the same HEAD.
//
// Fixture style follows beta/tests/qqdrill.test.mjs: real RAPP/1 frames built
// with buildFrame, a commons whose payloads are byte-identical to the local
// line but whose ancestry differs (offset utc), so the twins are genuine fixed
// points and pass the compatibility rule by construction.

const STREAM = `rappid:@rapp/tile-weather:${"a".repeat(64)}`;

function utcAt(second) {
  return `2026-08-21T12:00:${String(second).padStart(2, "0")}.000Z`;
}

/** A contiguous RAPP/1 chain. Each entry is { asserts, requires }. */
function chain(entries, { streamId = STREAM, ran = 0 } = {}) {
  const frames = [];
  let prev = null;
  entries.forEach((entry, index) => {
    const frame = buildFrame({
      kind: "qqdrill.tick",
      streamId,
      seq: index,
      utc: utcAt(ran + index),
      payload: { asserts: entry.asserts || {}, requires: entry.requires || {} },
      prev,
      prevWave: null,
    });
    frames.push(frame);
    prev = frame.payload_hash;
  });
  return frames;
}

// What this device already lived through.
const LOCAL_ENTRIES = [
  { asserts: { sky: "clear" } },
  { asserts: { plan: "picnic" }, requires: { sky: "clear" } },
  { asserts: { temp: 20 } },
];

// What the commons published: the same three ticks, run somewhere else at a
// different moment, plus two deltas this device never had.
const COMMONS_ENTRIES = [
  ...LOCAL_ENTRIES,
  { asserts: { wind: 5 } },
  { asserts: { gust: 9 } },
];

function localFrames() {
  return chain(LOCAL_ENTRIES);
}

function commonsFrames() {
  return chain(COMMONS_ENTRIES, { ran: 30 });
}

function commonsDocument(frames = commonsFrames()) {
  return {
    manifest: { dimension_id: "commons-weather", clock_key: 1 },
    frames,
  };
}

/** A temp directory that this test owns and deletes. Never the real home. */
function tempDir(t, label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `drill-app-${label}-`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A store whose line.jsonl already holds `frames`, exactly as written. */
function storeWithLine(t, label, frames) {
  const store = createStore(tempDir(t, label));
  fs.mkdirSync(path.dirname(store.linePath), { recursive: true });
  fs.writeFileSync(
    store.linePath,
    `${frames.map((frame) => JSON.stringify(frame)).join("\n")}\n`,
    "utf8",
  );
  return store;
}

/** Write a JSON document to a file and return its path. */
function sourceFile(t, label, document) {
  const file = path.join(tempDir(t, label), "commons.json");
  fs.writeFileSync(file, JSON.stringify(document), "utf8");
  return file;
}

/** A local http server on an ephemeral port, closed when the test ends. */
async function serve(t, handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const close = async () => {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  };
  t.after(close);
  return { origin: `http://127.0.0.1:${port}`, port, close };
}

/** The failure a call produced, as an Error. Resolving is itself a failure. */
async function refusal(fn, what) {
  let value;
  try {
    value = await fn();
  } catch (error) {
    assert.ok(error instanceof Error, `${what} must fail with an Error`);
    assert.ok(
      typeof error.message === "string" && error.message.trim().length > 0,
      `${what} must fail with a reason, not an empty message`,
    );
    return error;
  }
  assert.fail(`${what} must be refused, but it returned ${JSON.stringify(value)}`);
}

/**
 * Wait until the wall clock has crossed into a new second.
 *
 * Two people fold the same commons days apart. Two folds a millisecond apart
 * inside one test would let a join stamped with the local clock agree by
 * coincidence, and the test would pass on a device that had already broken the
 * one property it is checking.
 */
async function andThenMuchLater() {
  const second = Math.floor(Date.now() / 1000);
  while (Math.floor(Date.now() / 1000) === second) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  await new Promise((resolve) => setTimeout(resolve, 25));
}

/** Frame hashes, however the app chose to shape its merged list. */
function hashesOf(merged) {
  return [...(merged || [])]
    .map((entry) => (typeof entry === "string" ? entry : entry.frame_hash ?? entry.frame))
    .sort();
}

// ── the fixtures themselves ─────────────────────────────────────────────────

// If this fails every other test in this file is measuring the wrong thing:
// the fixtures would not be RAPP/1 frames, so nothing below would be a
// statement about the real protocol.
test("the fixtures are real RAPP/1 frames and a real twin of the local line", () => {
  let head = null;
  for (const frame of localFrames()) {
    const [ok, , why] = verifyFrame(frame, { head, streamIdOfRecord: STREAM });
    assert.equal(ok, true, `local fixture must verify: ${why}`);
    head = frame;
  }
  const local = localFrames();
  const commons = commonsFrames();
  assert.equal(commons[0].payload_hash, local[0].payload_hash, "identical bytes");
  assert.notEqual(commons[0].frame_hash, local[0].frame_hash, "different ancestry");
});

// ── loading a source ────────────────────────────────────────────────────────

// A person who was handed an .egg, a USB stick or a checked-out repo has the
// commons as a file on disk. If a path is not a source, the offline half of
// this method — the half the protocol calls a real path rather than a degraded
// one — cannot be used at all.
test("loadSource reads a commons from a filesystem path", async (t) => {
  const frames = commonsFrames();
  const file = sourceFile(t, "path-src", commonsDocument(frames));

  const loaded = await loadSource(file);

  assert.equal(loaded.manifest.dimension_id, "commons-weather");
  assert.equal(loaded.manifest.clock_key, 1);
  assert.equal(loaded.frames.length, frames.length, "every published frame arrives");
  assert.deepEqual(
    loaded.frames.map((frame) => frame.frame_hash),
    frames.map((frame) => frame.frame_hash),
  );
  // The hit pulls the entire frame, not a digest and not a description.
  assert.deepEqual(loaded.frames[0].payload, frames[0].payload);
});

test("local Drill refuses SMB, UNC, device, and remote-authority file sources", () => {
  for (const source of [
    "file://attacker.example/share/commons.json",
    String.raw`\\attacker.example\share\commons.json`,
    String.raw`\\?\C:\remote\commons.json`,
    "//attacker.example/share/commons.json",
  ]) {
    assert.throws(
      () => localSavedSource(source, { platform: "win32" }),
      /refuses.*(?:remote|network|UNC|device)/i,
    );
  }
  assert.equal(
    localSavedSource("C:\\saved\\commons.json", { platform: "win32" }).protocol,
    "file:",
  );
});

// Publishing may populate a summon line, but delivery must finish before the
// quick local Drill is called. It never fetches its own source.
test("loadSource refuses an http URL and accepts its locally saved bytes", async (t) => {
  const frames = commonsFrames();
  const body = JSON.stringify(commonsDocument(frames));
  let requests = 0;
  const server = await serve(t, (request, response) => {
    requests += 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(body);
  });

  await assert.rejects(
    () => loadSource(`${server.origin}/commons.json`),
    /local lookup|summon and save/i,
  );
  assert.equal(requests, 0, "the Drill has no network fallback");
  const loaded = await loadSource(
    sourceFile(t, "saved-http", commonsDocument(frames)),
  );
  assert.equal(loaded.manifest.dimension_id, "commons-weather");
  assert.equal(loaded.frames.length, frames.length);
  assert.deepEqual(
    loaded.frames.map((frame) => frame.frame_hash),
    frames.map((frame) => frame.frame_hash),
  );
  // Saved bytes are data and remain subject to frame verification.
  for (const frame of loaded.frames) {
    const [ok, , why] = verifyFrame(frame, { streamIdOfRecord: STREAM });
    if (frame.seq === 0) assert.equal(ok, true, `fetched genesis must verify: ${why}`);
  }
});

test("remote availability is irrelevant to Drill; an empty saved summon is empty", async (t) => {
  const dead = await serve(t, (request, response) => response.end("{}"));
  const url = `${dead.origin}/commons.json`;
  await dead.close();

  const error = await refusal(() => loadSource(url), "an unreachable source");
  assert.match(error.message, /local lookup|summon and save/i);
  const loaded = await loadSource(sourceFile(t, "empty-saved", {
    manifest: { dimension_id: "quiet", clock_key: 1 },
    frames: [],
  }));
  assert.deepEqual(loaded.frames, [], "an empty commons is a load, not a failure");
});

test("HTTP statuses are never consulted by the local Drill", async (t) => {
  let requests = 0;
  const server = await serve(t, (request, response) => {
    requests += 1;
    const status = Number(request.url.replace("/", "")) || 500;
    response.writeHead(status, { "content-type": "text/plain" });
    response.end("no");
  });

  const missing = await refusal(
    () => loadSource(`${server.origin}/404`),
    "a source that answers 404",
  );
  assert.match(missing.message, /local lookup|summon and save/i);

  const broken = await refusal(
    () => loadSource(`${server.origin}/500`),
    "a source that answers 500",
  );
  assert.match(broken.message, /local lookup|summon and save/i);
  assert.equal(requests, 0);
});

// Fetched bytes are data, never instructions and never assumed well-formed. A
// document that is valid JSON but is not a commons must be refused with a
// reason a person can act on, rather than half-read into an app that then
// behaves as though the commons were empty.
test("valid JSON of the wrong shape is refused with a reason that names the source", async (t) => {
  const cases = [
    ["no manifest and no frames", { hello: "world" }],
    ["frames is not an array", { manifest: { dimension_id: "x", clock_key: 1 }, frames: "lots" }],
    ["a bare array instead of a document", [1, 2, 3]],
    ["no manifest at all", { frames: commonsFrames() }],
  ];

  for (const [label, document] of cases) {
    const file = sourceFile(t, "bad-shape", document);
    const error = await refusal(() => loadSource(file), `a source whose document has ${label}`);
    assert.ok(
      error.message.includes(file),
      `refusing ${label} must name which source was refused, got: ${error.message}`,
    );
  }

  const file = path.join(tempDir(t, "not-json"), "commons.json");
  fs.writeFileSync(file, "<html><body>not JSON</body></html>");
  const error = await refusal(() => loadSource(file), "a saved source that is not JSON");
  assert.ok(error.message.includes(file), `it must name the source, got: ${error.message}`);
});

// A damaged document invalidates the whole document, not just the damaged part
// of it. If the sound frames in a damaged document folded anyway, a person's
// line would permanently carry a half-version of something that existed in no
// dimension anywhere — and because there is no un-merge, they would be stuck
// with it without ever being told which half they got.
//
// Where the check happens is the builder's choice; that nothing partial lands
// is not.
// ADJUDICATED 2026-08-21. This test and fold-and-refuse.test.mjs disagreed about
// the same input: this one wanted a document containing ANY unverifiable frame
// to land nothing; that one wanted the bad frame refused by name while the rest
// still folded. Both were written independently, so the conflict had to be
// decided rather than settled by whichever assertion ran last.
//
// Per-frame refusal wins, for two reasons. Each frame carries its own hashes, so
// a tampered frame is caught on its own and the others remain provably intact —
// nothing is inferred about them from a neighbour. And refusing an entire
// commons over one bad frame hands any single publisher a denial of service
// against everyone drilling it, which is a poor property for a system whose
// premise is absorbing from a public commons. It also matches the rule already
// in qqdrill.mjs: an accurate refusal of one is worth more than a false
// accusation of five.
//
// Document SHAPE is still refused whole — an entry that is not even an object
// means the document is not a commons at all — and that case is the test above.
test("a damaged frame is refused by name while the intact frames still fold", async (t) => {
  const frames = commonsFrames();
  const damaged = JSON.parse(JSON.stringify(frames[frames.length - 1]));
  damaged.payload.asserts.tampered = true;
  const [stillValid] = verifyFrame(damaged, { head: frames[frames.length - 2] });
  assert.equal(stillValid, false, "the fixture really is damaged");

  const store = storeWithLine(t, "damaged", localFrames());
  const source = sourceFile(t, "damaged-src", commonsDocument([...frames.slice(0, -1), damaged]));

  const result = await fold(store, source);

  assert.ok(
    result.refused.some((entry) => entry.frame === damaged.frame_hash),
    "the damaged frame is named in the refusals, so a person can go look at it",
  );
  assert.ok(
    result.refused.some((entry) => entry.contradicts?.some((clash) => clash.key === "integrity")),
    "and the reason says integrity, not disagreement — those are different failures",
  );
  assert.ok(result.merged.length > 0, "the intact frames still land");
  assert.equal(
    hashesOf(result.merged).includes(damaged.frame_hash),
    false,
    "and the damaged one is not among them",
  );
});

test("two devices with identical lines that fold the same commons reach the same HEAD", async (t) => {
  const alice = storeWithLine(t, "alice", localFrames());
  const bob = storeWithLine(t, "bob", localFrames());
  const startingHead = readLine(alice).head;
  assert.equal(readLine(bob).head, startingHead, "the two devices start identical");
  assert.match(startingHead, /^[0-9a-f]{64}$/, "a line HEAD is a frame hash");

  const commons = sourceFile(t, "commons", commonsDocument());

  const first = await fold(alice, commons);
  // Bob folds it later — a different second, as two real people would.
  await andThenMuchLater();
  const second = await fold(bob, commons);

  // Non-vacuous: something actually merged and HEAD actually advanced.
  assert.ok(hashesOf(first.merged).length > 0, "the commons had frames worth folding");
  assert.match(first.head, /^[0-9a-f]{64}$/);
  assert.notEqual(first.head, startingHead, "the line continues from the joined frame");

  assert.equal(second.head, first.head, "two devices, no coordination, one HEAD");
  assert.deepEqual(hashesOf(second.merged), hashesOf(first.merged), "and the same frames merged");

  // The stored lines agree too, not only the values the calls returned.
  const alicesLine = readLine(alice);
  const bobsLine = readLine(bob);
  assert.equal(alicesLine.head, first.head, "what was returned is what was written");
  assert.deepEqual(
    bobsLine.frames.map((frame) => frame.frame_hash),
    alicesLine.frames.map((frame) => frame.frame_hash),
    "the two devices hold the same line, frame for frame",
  );
  assert.equal(
    alicesLine.frames.at(-1).frame_hash,
    first.head,
    "HEAD is the last frame of the line a person can read",
  );
});

// A commons is a static JSON file anyone may publish, and nothing obliges its
// author to list frames in any particular order. If array order reached the
// join, the same commons re-published with its frames rearranged would fork
// every device that folded the new copy away from every device that folded the
// old one — for a change that carried no new information at all.
test("the same commons offered in a shuffled order still reaches the same HEAD", async (t) => {
  const frames = commonsFrames();
  const shuffled = [frames[3], frames[0], frames[4], frames[2], frames[1]];
  assert.notDeepEqual(
    shuffled.map((frame) => frame.frame_hash),
    frames.map((frame) => frame.frame_hash),
    "the fixture really is a different array order",
  );

  const ordered = storeWithLine(t, "ordered", localFrames());
  const jumbled = storeWithLine(t, "jumbled", localFrames());

  const inOrder = await fold(ordered, sourceFile(t, "in-order", commonsDocument(frames)));
  const outOfOrder = await fold(jumbled, sourceFile(t, "shuffled", commonsDocument(shuffled)));

  assert.ok(hashesOf(inOrder.merged).length > 0, "something folded, so this compares real work");
  assert.equal(outOfOrder.head, inOrder.head, "array order must not reach the join");
  assert.deepEqual(hashesOf(outOfOrder.merged), hashesOf(inOrder.merged));
  assert.deepEqual(
    readLine(jumbled).frames.map((frame) => frame.frame_hash),
    readLine(ordered).frames.map((frame) => frame.frame_hash),
  );
});

// A remote address cannot influence a line. After save, two local copies of
// the same bytes still converge deterministically.
test("a remote commons is inert; two saved copies still converge", async (t) => {
  const document = commonsDocument();
  const body = JSON.stringify(document);
  const server = await serve(t, (request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(body);
  });

  const refused = storeWithLine(t, "remote-refused", localFrames());
  const firstSaved = storeWithLine(t, "first-saved", localFrames());
  const secondSaved = storeWithLine(t, "second-saved", localFrames());
  const before = readLine(refused).head;
  await assert.rejects(
    () => fold(refused, `${server.origin}/commons.json`),
    /local lookup|summon and save/i,
  );
  assert.equal(readLine(refused).head, before);
  const first = await fold(firstSaved, sourceFile(t, "same-doc-a", document));
  await andThenMuchLater();
  const second = await fold(secondSaved, sourceFile(t, "same-doc-b", document));

  assert.ok(hashesOf(first.merged).length > 0, "the saved commons folded something");
  assert.equal(second.head, first.head, "saved byte identity determines the join");
  assert.deepEqual(
    readLine(secondSaved).frames.map((frame) => frame.frame_hash),
    readLine(firstSaved).frames.map((frame) => frame.frame_hash),
  );
});
