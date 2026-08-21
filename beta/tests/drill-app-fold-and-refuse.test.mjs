import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  buildFrame,
  verifyFrame,
} from "../electron/rapp-protocol.mjs";
import {
  createStore,
  fold,
  loadSource,
  readLine,
  status,
} from "../electron/drill-app.mjs";

// drill-app — the folding and refusing half.
//
// A person points this at a commons document — a file on a stick, a raw URL —
// and it absorbs what is safe to absorb into their own line. These tests are
// about the two halves of that sentence: what lands, and what is turned away
// with a reason. Fetched bytes are data; a document that cannot be trusted must
// leave the line exactly as it found it.

const STREAM_HISTORY = `rappid:@rapp/tile-drill-history:${"a".repeat(64)}`;
const STREAM_LATER = `rappid:@rapp/tile-drill-later:${"b".repeat(64)}`;
const STREAM_STORM = `rappid:@rapp/tile-drill-storm:${"c".repeat(64)}`;
const STREAM_BATCH = `rappid:@rapp/tile-drill-batch:${"d".repeat(64)}`;

// ── fixtures ────────────────────────────────────────────────────────────────

function utcAt(second) {
  const minutes = String(Math.floor(second / 60)).padStart(2, "0");
  const seconds = String(second % 60).padStart(2, "0");
  return `2026-08-21T12:${minutes}:${seconds}.000Z`;
}

/** A real RAPP/1 chain. Each entry is { asserts, requires }. */
function chain(entries, { streamId = STREAM_HISTORY, ran = 0 } = {}) {
  const frames = [];
  let prev = null;
  entries.forEach((entry, index) => {
    const frame = buildFrame({
      kind: "qqdrill.tick",
      streamId,
      seq: index,
      utc: utcAt(ran + index),
      payload: {
        asserts: entry.asserts || {},
        requires: entry.requires || {},
      },
      prev,
      prevWave: null,
    });
    frames.push(frame);
    prev = frame.payload_hash;
  });
  return frames;
}

function commonsDoc(dimensionId, frames) {
  return { manifest: { dimension_id: dimensionId, clock_key: 1 }, frames };
}

/** A fresh store and a fresh place to keep commons documents. Never shared. */
function bench() {
  const store = createStore(mkdtempSync(path.join(tmpdir(), "drill-app-store-")));
  const commons = mkdtempSync(path.join(tmpdir(), "drill-app-commons-"));
  const publish = (name, doc) => {
    const at = path.join(commons, name);
    writeFileSync(at, typeof doc === "string" ? doc : JSON.stringify(doc, null, 2));
    return at;
  };
  return { store, commons, publish };
}

/**
 * The local line already established sky=clear, and something on it declares
 * sky=clear as a precondition. This is the history every refusal test needs.
 */
function historyDoc() {
  return commonsDoc(
    "history",
    chain([
      { asserts: { phase: "morning", sky: "clear" } },
      { asserts: { plan: "picnic" }, requires: { sky: "clear" } },
    ], { streamId: STREAM_HISTORY }),
  );
}

// ── reading the line the way a person would ─────────────────────────────────

/** What the line says now, folded in the order it was written. */
function factsOn(line) {
  const facts = {};
  for (const frame of line.frames) {
    const asserts = frame?.payload?.asserts;
    if (!asserts || typeof asserts !== "object") continue;
    for (const [key, value] of Object.entries(asserts)) facts[key] = value;
  }
  return facts;
}

/** A frame hash is on the line if it is a frame there or a join names it. */
function lineMentions(line, frameHash) {
  return line.frames.some((frame) => (
    frame.frame_hash === frameHash
    || (Array.isArray(frame?.payload?.assimilated)
      && frame.payload.assimilated.includes(frameHash))
  ));
}

/**
 * The frames a result names, whatever shape the entries take — a hash, a frame,
 * or a record wrapping one. Deliberately not a deep sweep: a frame carries a
 * payload_hash and a prev as well, and those are not names of frames.
 */
function frameNames(entries) {
  const names = new Set();
  for (const entry of entries ?? []) {
    if (typeof entry === "string") {
      if (/^[0-9a-f]{64}$/.test(entry)) names.add(entry);
      continue;
    }
    if (!entry || typeof entry !== "object") continue;
    for (const candidate of [entry.frame_hash, entry.frame, entry.hash]) {
      if (typeof candidate === "string" && /^[0-9a-f]{64}$/.test(candidate)) names.add(candidate);
    }
  }
  return names;
}

/** Every frame hash mentioned anywhere inside a value — for "does it say so". */
function hashesIn(value, found = new Set()) {
  if (typeof value === "string") {
    if (/^[0-9a-f]{64}$/.test(value)) found.add(value);
    return found;
  }
  if (Array.isArray(value)) {
    for (const item of value) hashesIn(item, found);
    return found;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) hashesIn(item, found);
  }
  return found;
}

/** Does this refusal actually say which key it was about? */
function namesKey(entry, key) {
  const word = new RegExp(`(^|[^A-Za-z0-9_])${key}([^A-Za-z0-9_]|$)`);
  let found = false;
  const walk = (node) => {
    if (found) return;
    if (typeof node === "string") {
      if (node === key || word.test(node)) found = true;
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (node && typeof node === "object") {
      if (typeof node.key === "string" && node.key === key) {
        found = true;
        return;
      }
      for (const item of Object.values(node)) walk(item);
    }
  };
  walk(entry);
  return found;
}

async function attempt(run) {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    return { ok: false, error };
  }
}

function readBytes(filePath) {
  try {
    return readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

async function serveJson(body, t) {
  const server = http.createServer((request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(body);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}/commons.json`;
}

// ── tests ───────────────────────────────────────────────────────────────────

// If the fixtures below were not real RAPP/1 frames, every other test in this
// file would be measuring the app against nonsense, and a person could ship a
// fold that only ever works on frames no real commons serves.
test("the frames these tests fold are real RAPP/1 frames, and loadSource reads them", async () => {
  const { publish } = bench();
  const doc = historyDoc();
  const [first, second] = doc.frames;

  const [genesisOk, , genesisWhy] = verifyFrame(first, { streamIdOfRecord: STREAM_HISTORY });
  assert.equal(genesisOk, true, `fixture genesis must verify: ${genesisWhy}`);
  const [nextOk, , nextWhy] = verifyFrame(second, {
    head: first,
    streamIdOfRecord: STREAM_HISTORY,
  });
  assert.equal(nextOk, true, `fixture chain must verify: ${nextWhy}`);

  const loaded = await loadSource(publish("history.json", doc));
  assert.equal(loaded.manifest.dimension_id, "history", "the manifest comes back");
  assert.equal(loaded.manifest.clock_key, 1, "including the cadence the fold needs");
  assert.equal(loaded.frames.length, 2, "and every frame the document carried");
  assert.equal(loaded.frames[0].frame_hash, first.frame_hash, "unaltered");
});

// If a fold did not move the head, the person's line would never absorb
// anything: they would point the app at a commons that solved their problem,
// watch it report success, and still be exactly where they started.
test("a fold merges the source's frames, names them, and moves the line's head", async () => {
  const { store, publish } = bench();

  const before = readLine(store);
  assert.deepEqual(before.frames, [], "a new store starts with an empty line");
  assert.equal(before.head, null, "and no head");

  const doc = commonsDoc("weather", chain([
    { asserts: { sky: "clear" } },
    { asserts: { wind: 5 } },
  ], { streamId: STREAM_HISTORY }));

  const result = await fold(store, publish("weather.json", doc));

  const named = frameNames(result.merged);
  for (const frame of doc.frames) {
    assert.ok(
      named.has(frame.frame_hash),
      "a fold must name every frame it merged, or the person cannot tell what arrived",
    );
  }
  assert.equal(result.merged.length, 2, "both compatible frames folded in");
  assert.equal(result.refused.length, 0, "and nothing was turned away");

  const after = readLine(store);
  assert.match(String(result.head), /^[0-9a-f]{64}$/, "the fold reports the new head");
  assert.notEqual(after.head, before.head, "the line continues from the fold");
  assert.equal(after.head, result.head, "and the stored line agrees with the result");
  assert.ok(after.frames.length > 0, "the fold left something on the line");

  const state = status(store);
  assert.equal(state.head, after.head, "status shows the same head the file does");
  assert.equal(state.frames, after.frames.length, "and the same number of frames");
  assert.ok(state.folds >= 1, "the fold is counted");

  assert.equal(factsOn(after).sky, "clear", "what the source said is now what the line says");
  assert.equal(factsOn(after).wind, 5);
});

// This is the whole safety story. If a frame that contradicts a declared
// precondition folded in anyway, the person's own downstream work would be
// silently invalidated — a plan that required clear skies still sitting there
// under a line that now says storm.
test("a fold refuses a frame contradicting a declared precondition, and names the key", async () => {
  const { store, publish } = bench();
  await fold(store, publish("history.json", historyDoc()));

  const settled = readLine(store);
  assert.equal(factsOn(settled).sky, "clear", "the precondition's subject is established");

  const storm = commonsDoc("storm", chain([
    { asserts: { sky: "storm", siren: true } },
  ], { streamId: STREAM_STORM, ran: 600 }));

  const result = await fold(store, publish("storm.json", storm));

  assert.equal(result.merged.length, 0, "the contradicting frame did not fold in");
  assert.equal(result.refused.length, 1, "it was refused, and the refusal is a result");
  const refusal = result.refused[0];
  assert.ok(
    hashesIn(refusal).has(storm.frames[0].frame_hash),
    "the refusal names the frame it turned away",
  );
  assert.ok(
    namesKey(refusal, "sky"),
    "the refusal must name the key that clashed, or the person cannot act on it",
  );

  const after = readLine(store);
  assert.equal(after.head, settled.head, "a fold that merged nothing does not move the head");
  assert.equal(
    after.frames.length,
    settled.frames.length,
    "and adds no frame to the line",
  );
  assert.equal(factsOn(after).sky, "clear", "what was established is still what the line says");
  assert.equal(
    factsOn(after).siren,
    undefined,
    "refused whole: the innocent half of a refused frame must not sneak in",
  );
});

// A commons that reports a later state of the same thing is time passing, not a
// contradiction. If this were refused, the app would be useless for the case it
// exists for: absorbing what another machine learned after you last looked.
test("a new value for a key nothing requires is time passing, and folds in", async () => {
  const { store, publish } = bench();
  await fold(store, publish("history.json", historyDoc()));

  const settled = readLine(store);
  assert.equal(factsOn(settled).phase, "morning", "the line asserted phase=morning");

  const later = commonsDoc("later", chain([
    { asserts: { phase: "noon" } },
  ], { streamId: STREAM_LATER, ran: 600 }));

  const result = await fold(store, publish("later.json", later));

  assert.equal(result.refused.length, 0, "nothing declared phase as a precondition");
  assert.ok(
    frameNames(result.merged).has(later.frames[0].frame_hash),
    "an assertion that merely supersedes an earlier one must merge",
  );

  const after = readLine(store);
  assert.notEqual(after.head, settled.head, "and the line moves on");
  assert.equal(factsOn(after).phase, "noon", "the line now says the later thing");
  assert.equal(factsOn(after).sky, "clear", "without disturbing anything else");
});

// Folding is something people re-run — a scheduled sweep, a second click, a
// retry after a dropped connection. If each run re-merged the same frames, the
// line would fill with meaningless joins and every later reader would have to
// wade through a history that recorded nothing.
test("folding the same source twice changes nothing the second time", async () => {
  const { store, publish } = bench();
  const at = publish("weather.json", commonsDoc("weather", chain([
    { asserts: { sky: "clear" } },
    { asserts: { wind: 5 } },
  ], { streamId: STREAM_HISTORY })));

  const first = await fold(store, at);
  const afterFirst = readLine(store);
  assert.equal(first.merged.length, 2);

  const second = await fold(store, at);

  assert.equal(second.merged.length, 0, "there was nothing new to absorb");
  assert.ok(!second.joined, "so no join was minted for an empty fold");
  assert.equal(second.head, first.head, "and the head did not advance");

  const afterSecond = readLine(store);
  assert.equal(
    afterSecond.frames.length,
    afterFirst.frames.length,
    "the line gained no duplicate frame",
  );
  assert.deepEqual(
    afterSecond.frames.map((frame) => frame.frame_hash),
    afterFirst.frames.map((frame) => frame.frame_hash),
    "in fact the line is byte-for-byte the line it already was",
  );
  assert.equal(status(store).frames, afterFirst.frames.length);
});

// A commons is bytes someone else wrote. If one tampered frame could take the
// whole batch down, a single bad actor could deny everyone else's good frames;
// if it merged anyway, unverified content would land on the person's line.
test("one unverifiable frame is refused by name and the rest of the batch still folds", async () => {
  const { store, publish } = bench();

  const good = chain([
    { asserts: { sky: "clear" } },
    { asserts: { wind: 5 } },
    { asserts: { temp: 20 } },
  ], { streamId: STREAM_BATCH });

  // The last frame is edited in place after it was hashed — its payload no
  // longer matches its own payload_hash, so verifyFrame refuses it.
  const tampered = JSON.parse(JSON.stringify(good[2]));
  tampered.payload.asserts.contraband = "tampered";
  const claimedName = tampered.frame_hash;
  const [stillValid] = verifyFrame(tampered, { head: good[1], streamIdOfRecord: STREAM_BATCH });
  assert.equal(stillValid, false, "the fixture really is unverifiable");
  const recomputedName = buildFrame({
    kind: tampered.kind,
    streamId: tampered.stream_id,
    seq: tampered.seq,
    utc: tampered.utc,
    payload: tampered.payload,
    prev: tampered.prev,
    prevWave: tampered.prev_wave,
    sig: tampered.sig,
  }).frame_hash;

  const doc = commonsDoc("batch", [good[0], good[1], tampered]);
  const result = await fold(store, publish("batch.json", doc));

  const merged = frameNames(result.merged);
  assert.ok(merged.has(good[0].frame_hash), "the good frames still fold");
  assert.ok(merged.has(good[1].frame_hash), "all of them — one bad frame is not a batch failure");
  assert.equal(merged.has(claimedName), false, "the tampered frame did not merge");
  assert.equal(merged.has(recomputedName), false, "under either name");

  // Not silently dropped: somewhere in what the fold hands back, the frame it
  // would not touch is named.
  const anywhere = hashesIn(result);
  assert.ok(
    anywhere.has(claimedName) || anywhere.has(recomputedName),
    "a frame the fold would not touch must be named, never silently dropped",
  );

  // And named where the contract says refusals live. fold() returns `refused`;
  // a caller that renders it sees "nothing was turned away" if an unverifiable
  // frame is filed anywhere else, while `merged` is short by one.
  const refusedNames = hashesIn(result.refused);
  assert.ok(
    refusedNames.has(claimedName) || refusedNames.has(recomputedName),
    "a frame that fails verifyFrame belongs in the fold's refused list, by name",
  );
  assert.equal(
    refusedNames.has(good[0].frame_hash) || refusedNames.has(good[1].frame_hash),
    false,
    "and no frame that actually folded may be reported as refused",
  );

  const after = readLine(store);
  assert.equal(factsOn(after).sky, "clear", "the batch's good half landed");
  assert.equal(factsOn(after).wind, 5);
  assert.equal(
    factsOn(after).contraband,
    undefined,
    "and nothing the tampered frame claimed reached the line",
  );
});

// A truncated download, a 404 page served as JSON, a half-written file: if any
// of these were applied partially, the person's line would end up holding a
// state that existed nowhere, with no way to tell which half is real.
test("a malformed commons document is refused whole and the line is left untouched", async (t) => {
  const { store, publish } = bench();
  await fold(store, publish("history.json", historyDoc()));

  const settled = readLine(store);
  const bytesBefore = readBytes(store.linePath);
  assert.ok(bytesBefore, "the line is a plain file on disk");

  const broken = {
    "not JSON at all": "<!doctype html><title>404</title> not found",
    "no frames": JSON.stringify({ manifest: { dimension_id: "x", clock_key: 1 } }),
    "no manifest": JSON.stringify({ frames: historyDoc().frames }),
  };

  for (const [why, body] of Object.entries(broken)) {
    const at = publish(`broken-${why.replace(/\W+/g, "-")}.json`, body);

    const loaded = await attempt(() => loadSource(at));
    assert.equal(loaded.ok, false, `loadSource must refuse a document with ${why}`);
    assert.ok(
      typeof loaded.error?.message === "string" && loaded.error.message.trim().length > 0,
      `the refusal of "${why}" must carry a reason`,
    );
    assert.doesNotMatch(
      loaded.error.message,
      /cannot read propert|is not a function|undefined is not|of undefined/i,
      `"${why}" must be refused with a reason, not surfaced as a crash`,
    );

    // Whether the app refuses by throwing or by returning a refusal, what the
    // person must never see is a half-applied document.
    const folded = await attempt(() => fold(store, at));
    if (folded.ok) {
      assert.equal(
        folded.value.merged.length,
        0,
        `nothing from a document with ${why} may merge`,
      );
      assert.equal(folded.value.head, settled.head, "and the head stays put");
    }

    const after = readLine(store);
    assert.equal(after.head, settled.head, `the head is untouched by ${why}`);
    assert.deepEqual(
      after.frames.map((frame) => frame.frame_hash),
      settled.frames.map((frame) => frame.frame_hash),
      `the line is untouched by ${why}`,
    );
    assert.equal(readBytes(store.linePath), bytesBefore, `not one byte changed for ${why}`);
    assert.equal(factsOn(after).sky, "clear", `and it still says what it said, after ${why}`);
  }
  t.diagnostic(`checked ${Object.keys(broken).length} malformed documents`);
});

// The point of folding is that the capability arrives and stays. If what merged
// were not readable back off the line afterwards, the person would have
// absorbed something they cannot inspect, cite, or hand to anyone else.
test("what folded is readable from the line afterwards, as plain files", async () => {
  const { store, publish } = bench();
  const doc = commonsDoc("weather", chain([
    { asserts: { sky: "clear" } },
    { asserts: { wind: 5 } },
  ], { streamId: STREAM_HISTORY }));

  const result = await fold(store, publish("weather.json", doc));
  const line = readLine(store);

  for (const frameHash of frameNames(result.merged)) {
    assert.ok(
      lineMentions(line, frameHash),
      "every merged frame must be findable on the line, itself or named by the join that took it",
    );
  }
  assert.equal(factsOn(line).sky, "clear", "and what it asserted is readable there");
  assert.equal(factsOn(line).wind, 5);
  assert.equal(
    line.head,
    line.frames[line.frames.length - 1].frame_hash,
    "the head is the last frame on the line",
  );

  // A person can open the file. One frame per line, and each frame's hashes
  // still bind its own content, so nobody can edit the file without it showing.
  const text = readBytes(store.linePath);
  const rows = text.split("\n").filter((row) => row.trim().length > 0);
  assert.equal(rows.length, line.frames.length, "one frame per line of line.jsonl");
  for (const row of rows) {
    const frame = JSON.parse(row);
    assert.equal(frame.spec, "rapp/1", "every stored row is a RAPP/1 frame");
    const rebuilt = buildFrame({
      kind: frame.kind,
      streamId: frame.stream_id,
      seq: frame.seq,
      utc: frame.utc,
      payload: frame.payload,
      prev: frame.prev,
      prevWave: frame.prev_wave,
      sig: frame.sig,
    });
    assert.equal(
      rebuilt.payload_hash,
      frame.payload_hash,
      "a stored frame's payload_hash must still bind its payload",
    );
    assert.equal(
      rebuilt.frame_hash,
      frame.frame_hash,
      "and its frame_hash must still bind the whole frame",
    );
  }
});

// The commons this exists for lives at a URL. If folding over the network gave
// a different answer from folding the same bytes off a stick, nobody could tell
// whether what they absorbed depended on how it arrived.
test("a commons served over http folds to the same result as the same document on disk", async (t) => {
  const doc = historyDoc();
  const body = JSON.stringify(doc);

  const fromDisk = bench();
  const diskResult = await fold(fromDisk.store, fromDisk.publish("history.json", doc));

  const overHttp = bench();
  const url = await serveJson(body, t);
  const httpResult = await fold(overHttp.store, url);

  assert.deepEqual(
    [...frameNames(httpResult.merged)].sort(),
    [...frameNames(diskResult.merged)].sort(),
    "the same document merges the same frames however it arrived",
  );
  assert.equal(httpResult.refused.length, diskResult.refused.length);

  const diskLine = readLine(fromDisk.store);
  const httpLine = readLine(overHttp.store);
  assert.deepEqual(
    factsOn(httpLine),
    factsOn(diskLine),
    "and the two lines say exactly the same thing",
  );
  assert.match(String(httpResult.head), /^[0-9a-f]{64}$/, "the networked fold moved a head too");
  for (const frameHash of frameNames(httpResult.merged)) {
    assert.ok(lineMentions(httpLine, frameHash), "and what it absorbed is on its line");
  }
});
