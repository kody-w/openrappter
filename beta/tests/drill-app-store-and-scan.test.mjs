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
  fold,
  journal,
  loadSource,
  readLine,
  restore,
  scan,
  status,
} from "../electron/drill-app.mjs";

// drill-app — the store, status, and scan: the read-only half.
//
// qqdrill.mjs promises that a search "mutates nothing, merges nothing, advances
// no lineage", and QQDRILL-PROTOCOL.md leans the whole safety argument on it:
// "a search that cannot mutate anything can run constantly and be wrong every
// time without costing more than the search." These tests hold the application
// to that promise from the outside — through the plain files a person can read.

const STREAM = `rappid:@rapp/tile-weather:${"a".repeat(64)}`;
const OTHER_STREAM = `rappid:@rapp/tile-tides:${"b".repeat(64)}`;

function utcAt(second) {
  return `2026-08-21T12:00:${String(second).padStart(2, "0")}.000Z`;
}

/**
 * Build a real RAPP/1 chain. Each entry is {asserts, requires}. `ran` shifts the
 * wall clock, which is what makes two lines that recorded the SAME bytes carry
 * different frame_hashes — identical payload, different ancestry, i.e. a fixed
 * point. Copied in spirit from beta/tests/qqdrill.test.mjs.
 */
function chain(entries, { streamId = STREAM, startSeq = 0, ran = 0 } = {}) {
  const frames = [];
  let prev = null;
  entries.forEach((entry, index) => {
    const frame = buildFrame({
      kind: "qqdrill.tick",
      streamId,
      seq: startSeq + index,
      utc: utcAt(ran + startSeq + index),
      payload: { asserts: entry.asserts || {}, requires: entry.requires || {} },
      prev,
      prevWave: null,
    });
    frames.push(frame);
    prev = frame.payload_hash;
  });
  return frames;
}

// Three ticks both lines recorded identically, then one tick each went its own way.
const SHARED = [
  { asserts: { sky: "clear" } },
  { asserts: { wind: 5 } },
  { asserts: { temp: 20 } },
];

function localFrames() {
  return chain([...SHARED, { asserts: { note: "local-only" } }]);
}

function commonsDocument() {
  return {
    manifest: { dimension_id: "commons", clock_key: 1 },
    frames: chain([...SHARED, { asserts: { note: "commons-only" } }], { ran: 30 }),
  };
}

/** A commons that ran a different capability entirely. No coordinate can match. */
function strangerDocument() {
  return {
    manifest: { dimension_id: "stranger", clock_key: 1 },
    frames: chain(
      [{ asserts: { moon: "full" } }, { asserts: { tide: "high" } }],
      { streamId: OTHER_STREAM, ran: 45 },
    ),
  };
}

function freshRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "drill-app-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

/** Put a line on disk the way the storage contract describes it: one frame per line. */
function seed(store, frames) {
  fs.mkdirSync(path.dirname(store.linePath), { recursive: true });
  fs.writeFileSync(store.linePath, frames.map((frame) => `${JSON.stringify(frame)}\n`).join(""));
}

function writeJson(dir, name, document) {
  const at = path.join(dir, name);
  fs.writeFileSync(at, JSON.stringify(document, null, 2));
  return at;
}

function checkpointFiles(store) {
  try {
    return fs.readdirSync(store.checkpointDir).sort();
  } catch {
    return [];
  }
}

function readJsonl(at) {
  if (!fs.existsSync(at)) return [];
  return fs.readFileSync(at, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

/** Serve one JSON document on a loopback port. Never the real network. */
async function serveJson(t, document) {
  const body = JSON.stringify(document);
  const server = http.createServer((request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(body);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}/commons.json`;
}

// If the fixtures were not real RAPP/1 frames, every failure below would be my
// typo rather than the application's defect, and a real person would be sent
// chasing a bug that is not there.
test("the frames these tests write are real RAPP/1 frames", () => {
  const frames = localFrames();
  frames.forEach((frame, index) => {
    const [ok, , why] = verifyFrame(frame, {
      head: index ? frames[index - 1] : null,
      streamIdOfRecord: STREAM,
    });
    assert.equal(ok, true, `fixture frame ${index} must verify: ${why}`);
  });
  const twin = commonsDocument().frames[0];
  assert.equal(twin.payload_hash, frames[0].payload_hash, "identical bytes");
  assert.notEqual(twin.frame_hash, frames[0].frame_hash, "different ancestry");
});

// The very first thing anyone does is open the app before there is anything in
// it. If status() throws on an empty directory, a person's first impression of
// the feature is a stack trace, and they never see the second screen.
test("a first run on an empty directory reports an empty line instead of crashing", (t) => {
  const root = freshRoot(t);
  const store = createStore(root);

  assert.equal(path.resolve(store.root), path.resolve(root), "the store keeps the root it was given");
  assert.equal(path.basename(store.linePath), "line.jsonl");
  assert.equal(path.basename(store.checkpointDir), "checkpoints");
  assert.equal(path.basename(store.journalPath), "journal.jsonl");
  for (const at of [store.linePath, store.checkpointDir, store.journalPath]) {
    assert.equal(
      path.resolve(at).startsWith(path.resolve(root)),
      true,
      `${at} must live inside the root a person pointed at, not somewhere else on their disk`,
    );
  }

  const first = status(store);
  assert.equal(first.frames, 0, "an empty store has no frames");
  assert.equal(first.head, null, "and therefore no HEAD");
  assert.equal(first.checkpoints, 0);
  assert.equal(first.folds, 0);
  assert.equal(first.restores, 0);

  assert.deepEqual(journal(store), [], "nothing has happened yet, and that is not an error");
});

// A person may point the app at ~/.rapp/drill before that directory exists.
// A crash here means the feature can only ever be used by someone who already
// knew to create the folder by hand.
test("a store root that does not exist yet is still readable, not a crash", (t) => {
  const root = freshRoot(t);
  const nested = path.join(root, "not", "created", "yet");
  const store = createStore(nested);

  const first = status(store);
  assert.equal(first.frames, 0);
  assert.equal(first.head, null);
  assert.deepEqual(readLine(store).frames, []);
  assert.equal(readLine(store).head, null);
});

// readLine is what every screen in the app is built on. If a fresh store hands
// back null or undefined instead of an empty line, the first render of an empty
// store fails on `.frames.map`, and nobody can get past a blank window.
test("readLine on a fresh store returns a usable empty line", (t) => {
  const store = createStore(freshRoot(t));
  const line = readLine(store);

  assert.equal(Array.isArray(line.frames), true, "frames must be an array a caller can map over");
  assert.deepEqual(line.frames, []);
  assert.equal(line.head, null, "an empty line has no HEAD — not undefined, not a string");
  assert.deepEqual(line.frames.map((frame) => frame.frame_hash), []);
});

// A person's own line has to come back exactly as they left it, in order, with
// HEAD naming the last frame. Get the order or the HEAD wrong and every later
// judgement — what is downstream, what a fold may contradict — is made against
// the wrong ancestry.
test("readLine returns the stored frames in order with HEAD at the last one", (t) => {
  const store = createStore(freshRoot(t));
  const frames = localFrames();
  seed(store, frames);

  const line = readLine(store);
  assert.deepEqual(
    line.frames.map((frame) => frame.frame_hash),
    frames.map((frame) => frame.frame_hash),
    "the line reads back in the order it was written",
  );
  assert.equal(line.head, frames[frames.length - 1].frame_hash, "HEAD is the last frame");
  assert.equal(status(store).frames, frames.length);
  assert.equal(status(store).head, line.head);
});

// This is what the whole application is for: showing a person that another
// machine already did this work, and how much of it lines up. A scan that finds
// nothing against a commons that plainly overlaps makes the feature look broken
// and hides every merge that was available.
test("scan finds the pairs, the fixed points, the run and the alignment", async (t) => {
  const root = freshRoot(t);
  const store = createStore(root);
  seed(store, localFrames());
  const source = writeJson(root, "commons.json", commonsDocument());

  const found = await scan(store, source);

  assert.ok(found.pairs.length >= 3, `a scan over an overlapping commons must find pairs, got ${found.pairs.length}`);
  for (const pair of found.pairs) {
    assert.equal(typeof pair.here.frame_hash, "string", "a pair names an address here");
    assert.equal(typeof pair.there.frame_hash, "string", "and an address there");
    assert.equal(pair.here.payload, undefined, "a pair carries addresses, not whole frames");
  }

  assert.equal(
    found.fixedPoints.length,
    3,
    "the three byte-identical ticks are fixed points; the fourth diverged and is not one",
  );
  for (const point of found.fixedPoints) {
    assert.equal(point.here.payload_hash, point.there.payload_hash, "same bytes");
    assert.notEqual(point.here.frame_hash, point.there.frame_hash, "different ancestry is the whole point");
  }

  assert.equal(
    found.runs.length,
    1,
    "the three fixed points are one contiguous run, not three unrelated coincidences — "
      + "if this reports three runs of one, the local cadence is not registering against an ordinary commons",
  );
  assert.equal(found.runs[0].length, 3, "the run reached three frames before the lines diverged");
  assert.equal(found.runs[0].startHere, 0);
  assert.equal(found.runs[0].endHere, 2);
  assert.ok(found.runs[0].boundary, "a run records why it ended");

  assert.equal(found.alignment.ok, true, `the fixed points must pin the phase: ${found.alignment.reason}`);
  assert.equal(found.alignment.ratio, 1, "both dimensions ran at the same cadence");
  assert.equal(found.alignment.offset, 0);
  assert.equal(found.alignment.pins.length, 3, "every fixed point is a pin");
});

// The loudest promise in the protocol: searching cannot change anything. If a
// scan quietly rewrites the line, then a person who scanned and did not like
// what they saw has already lost the state they had — and the thing that was
// supposed to be safe to run constantly is the most dangerous button in the app.
test("scan changes nothing: the line is byte-identical and no checkpoint is written", async (t) => {
  const root = freshRoot(t);
  const store = createStore(root);
  seed(store, localFrames());
  const source = writeJson(root, "commons.json", commonsDocument());

  const before = fs.readFileSync(store.linePath);
  const beforeStatus = status(store);
  assert.deepEqual(checkpointFiles(store), [], "nothing has been folded yet");

  const first = await scan(store, source);
  const second = await scan(store, source);

  const after = fs.readFileSync(store.linePath);
  assert.equal(
    after.equals(before),
    true,
    "line.jsonl must be byte-identical after a scan — a search mutates nothing",
  );
  assert.deepEqual(
    checkpointFiles(store),
    [],
    "a scan is not a fold, so it must not take a checkpoint",
  );

  assert.equal(first.changed, false, "scan reports, in the result itself, that it changed nothing");
  assert.equal(second.changed, false);
  assert.equal(second.pairs.length, first.pairs.length, "scanning twice is the same search twice");

  const afterStatus = status(store);
  assert.equal(afterStatus.frames, beforeStatus.frames, "no frame was appended");
  assert.equal(afterStatus.head, beforeStatus.head, "HEAD did not move");
  assert.equal(afterStatus.checkpoints, 0);
  assert.equal(afterStatus.folds, 0, "searching is not folding");
  assert.equal(afterStatus.restores, 0);
});

// Most drills find nothing — the protocol says so plainly, and that is the
// expected case. If "no overlap" surfaces as an exception rather than a result,
// a person doing the normal thing sees a failure every time and learns to
// distrust the tool that was working correctly.
test("a commons that shares nothing reports zero hits honestly rather than erroring", async (t) => {
  const root = freshRoot(t);
  const store = createStore(root);
  seed(store, localFrames());
  const source = writeJson(root, "stranger.json", strangerDocument());

  const before = fs.readFileSync(store.linePath);
  const found = await scan(store, source);

  assert.deepEqual(found.pairs, [], "nothing shared, nothing found");
  assert.deepEqual(found.fixedPoints, []);
  assert.deepEqual(found.runs, []);
  assert.equal(found.alignment.ok, false, "with no fixed point there is nothing to pin the phase");
  assert.equal(
    typeof found.alignment.reason === "string" && found.alignment.reason.length > 0,
    true,
    "a refusal must say why, or a person cannot tell 'no overlap' from 'broken'",
  );
  assert.equal(found.changed, false);
  assert.equal(fs.readFileSync(store.linePath).equals(before), true, "a miss still changes nothing");
  assert.equal(status(store).folds, 0);
});

// The summon line may deliver remote bytes, but Quantum Drill itself is only a
// local lookup. The URL is refused without a request; saved bytes remain useful.
test("a URL commons is refused until the same bytes are saved locally", async (t) => {
  const root = freshRoot(t);
  const store = createStore(root);
  seed(store, localFrames());
  const document = commonsDocument();
  const filePath = writeJson(root, "commons.json", document);
  const url = await serveJson(t, document);

  await assert.rejects(
    () => loadSource(url),
    /local lookup|summon and save/i,
  );
  const overDisk = await scan(store, filePath);
  assert.ok(overDisk.pairs.length > 0);
  assert.equal(overDisk.changed, false, "local lookup is still only a search");
  assert.equal(status(store).folds, 0);
});

// status is the one screen that tells a person what has happened to their line.
// If it miscounts, someone who folded something they regret cannot tell whether
// a checkpoint exists to go back to — and the rollback story is only as good as
// the count that says a checkpoint is there.
test("status counts checkpoints, folds and restores across a few operations", async (t) => {
  const root = freshRoot(t);
  const store = createStore(root);
  const frames = localFrames();
  seed(store, frames);
  const source = writeJson(root, "commons.json", commonsDocument());

  const before = status(store);
  assert.equal(before.frames, frames.length);
  assert.equal(before.checkpoints, 0);
  assert.equal(before.folds, 0);
  assert.equal(before.restores, 0);
  const lineBefore = readJsonl(store.linePath).map((frame) => frame.frame_hash);

  await scan(store, source);
  assert.equal(status(store).folds, 0, "a search never counts as a fold");
  assert.equal(status(store).checkpoints, 0);

  const folded = await fold(store, source);
  assert.ok(
    folded.merged.length > 0,
    "byte-identical frames from another ancestry contradict nothing and must merge",
  );

  const afterFold = status(store);
  assert.equal(afterFold.folds, 1, "one fold happened, so one fold is counted");
  assert.equal(afterFold.checkpoints, 1, "a checkpoint is taken before each fold");
  assert.equal(afterFold.restores, 0);
  assert.equal(
    afterFold.frames,
    before.frames + 1,
    "the local chain gains exactly one frame — the join that names what it assimilated",
  );
  assert.equal(afterFold.head, folded.head, "status agrees with the fold about where HEAD is");
  assert.notEqual(afterFold.head, before.head, "the line continues from the joined frame");

  const files = checkpointFiles(store);
  assert.equal(files.length, 1, "one fold leaves one checkpoint on disk a person can find");
  assert.deepEqual(
    readJsonl(path.join(store.checkpointDir, files[0])).map((frame) => frame.frame_hash),
    lineBefore,
    "the checkpoint holds the line exactly as it stood BEFORE the fold",
  );

  const back = restore(store);
  assert.equal(back.recorded, true, "an election is an event in the record, not a quiet rewind");
  assert.equal(typeof back.restoredTo === "string" && back.restoredTo.length > 0, true);
  assert.equal(back.head, before.head, "the elected generation is the pre-fold one");

  const afterRestore = status(store);
  assert.equal(afterRestore.restores, 1);
  assert.equal(afterRestore.folds, 1, "restoring does not un-count the fold — history is not rewritten");
  assert.equal(
    afterRestore.checkpoints,
    0,
    "the restored checkpoint leaves the active undo stack",
  );
  const archived = path.join(store.restoredCheckpointDir, files[0]);
  assert.ok(fs.existsSync(archived), "the used checkpoint survives in the restored-checkpoint archive");
  assert.deepEqual(
    readJsonl(archived).map((frame) => frame.frame_hash),
    lineBefore,
    "the archived checkpoint still holds the exact pre-fold line",
  );
  assert.equal(afterRestore.frames, before.frames, "the line is back to the generation before the fold");
  assert.equal(afterRestore.head, before.head);
});

// The journal is the only place a person can see what this application did to
// their line and in what order. Out-of-order entries make a fold look like it
// happened after the restore that rolled it back — which is exactly the
// question someone opens the journal to answer.
test("journal entries are readable, on disk, and in chronological order", async (t) => {
  const root = freshRoot(t);
  const store = createStore(root);
  seed(store, localFrames());
  const source = writeJson(root, "commons.json", commonsDocument());

  await scan(store, source);
  await fold(store, source);
  restore(store);

  const entries = journal(store);
  assert.ok(entries.length >= 2, `a fold and a restore are both events, got ${entries.length}`);

  for (const entry of entries) {
    assert.equal(typeof entry.utc, "string", "every entry is stamped");
    assert.equal(Number.isNaN(Date.parse(entry.utc)), false, `unreadable timestamp: ${entry.utc}`);
    assert.equal(typeof entry.event, "string", "every entry names what happened");
    assert.ok(entry.event.length > 0);
    assert.equal(Object.hasOwn(entry, "detail"), true, "every entry carries its detail");
  }

  const times = entries.map((entry) => Date.parse(entry.utc));
  for (let index = 1; index < times.length; index += 1) {
    assert.ok(
      times[index] >= times[index - 1],
      `entry ${index} (${entries[index].utc}) is stamped before entry ${index - 1} (${entries[index - 1].utc})`,
    );
  }

  const events = entries.map((entry) => entry.event.toLowerCase());
  const foldAt = events.findIndex((event) => event.includes("fold"));
  const restoreAt = events.findIndex((event) => event.includes("restore"));
  assert.ok(foldAt >= 0, `a fold must appear in the journal, saw: ${events.join(", ")}`);
  assert.ok(restoreAt >= 0, `a restore must appear in the journal, saw: ${events.join(", ")}`);
  assert.ok(restoreAt > foldAt, "the restore is recorded after the fold it rolled back");

  const onDisk = readJsonl(store.journalPath);
  assert.equal(
    onDisk.length,
    entries.length,
    "the journal a person can read with `cat` is the journal the app reports",
  );
  assert.deepEqual(onDisk.map((entry) => entry.event), entries.map((entry) => entry.event));
});
