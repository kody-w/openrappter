import assert from "node:assert/strict";
import test, { after } from "node:test";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { buildFrame, verifyFrame } from "../electron/rapp-protocol.mjs";
import {
  createStore,
  fold,
  journal,
  readLine,
  restore,
  scan,
  status,
} from "../electron/drill-app.mjs";

// drill-app — checkpoint-before-fold and restore.
//
// A fold is the one operation in this system that can put something on a line
// you would want back (QQDRILL-PROTOCOL.md, "There is no un-merge, and there is
// a fast way back"). Inside the protocol a join is permanent; outside it, the
// store checkpoints before every fold and can elect an earlier generation.
// These tests are that safety net, so they are written about what a person can
// see afterwards: which files exist, what is in them, what HEAD is, and what the
// journal says happened.

// ── fixture ─────────────────────────────────────────────────────────────────

const STREAM = `rappid:@rapp/tile-weather:${"a".repeat(64)}`;

function utcAt(second) {
  return `2026-08-21T12:00:${String(second).padStart(2, "0")}.000Z`;
}

/** A valid RAPP/1 chain from genesis. Each entry is {asserts, requires}. */
function chain(entries, { ran = 0 } = {}) {
  const frames = [];
  let prev = null;
  entries.forEach((entry, index) => {
    const frame = buildFrame({
      kind: "qqdrill.tick",
      streamId: STREAM,
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

// Two ticks the two lines share byte for byte — different ancestry, because the
// dimensions ran at different times — so the drill has fixed points to pin the
// clocks with, and a third tick that only the other dimension has.
const SHARED = [{ asserts: { sky: "clear" } }, { asserts: { wind: 5 } }];

function localFrames() {
  return chain([...SHARED, { asserts: { note: "local-only" } }]);
}

/** A dimension document of the shape raw.githubusercontent.com already serves. */
function sourceDocument(tag, ran) {
  return {
    manifest: { dimension_id: `remote-${tag}`, clock_key: 1 },
    frames: chain([...SHARED, { asserts: { gust: tag } }], { ran }),
  };
}

const workspaces = [];
const homeOf = new Map();

after(() => {
  for (const workspace of workspaces) fs.rmSync(workspace, { recursive: true, force: true });
});

/** A store on a fresh temp directory, holding a three-frame line. */
function freshStore() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "drill-app-"));
  workspaces.push(home);
  const root = path.join(home, "store");
  fs.mkdirSync(root, { recursive: true });

  const store = createStore(root);
  assert.ok(store?.linePath, "createStore must say where the line is kept");
  assert.ok(store?.checkpointDir, "and where checkpoints go");
  assert.ok(store?.journalPath, "and where the journal is");
  assert.equal(
    path.resolve(store.root),
    path.resolve(root),
    "the store lives at the root it was given",
  );
  homeOf.set(store, home);

  fs.mkdirSync(path.dirname(store.linePath), { recursive: true });
  const frames = localFrames();
  fs.writeFileSync(store.linePath, `${frames.map((frame) => JSON.stringify(frame)).join("\n")}\n`);
  return store;
}

/** Source documents live OUTSIDE the store, the way a fetched dimension does. */
function writeSource(store, name, document) {
  const dir = path.join(homeOf.get(store), "sources");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.json`);
  fs.writeFileSync(file, JSON.stringify(document, null, 2));
  return file;
}

function readFrames(file) {
  return fs.readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

function hashes(frames) {
  return frames.map((frame) => frame.frame_hash);
}

function assertValidLine(frames, label) {
  let head = null;
  for (const frame of frames) {
    const [ok, , why] = verifyFrame(frame, { head });
    assert.equal(ok, true, `${label} must remain a valid RAPP/1 line: ${why}`);
    head = frame;
  }
}

/** A count that may honestly be reported as a number or as the list itself. */
function howMany(value) {
  if (Array.isArray(value)) return value.length;
  if (typeof value === "number") return value;
  return assert.fail(`expected a count or a list, got ${JSON.stringify(value)}`);
}

/** The join a fold minted, however the fold chose to hand it back. */
function joinHash(joined) {
  return typeof joined === "string" ? joined : joined?.frame_hash;
}

/** The file a reported checkpoint names. A checkpoint nobody can open is not one. */
function checkpointFile(store, checkpoint) {
  assert.ok(checkpoint, "a fold must say where it put the checkpoint");
  const id = typeof checkpoint === "string"
    ? checkpoint
    : checkpoint.path || checkpoint.file || checkpoint.id || checkpoint.name || checkpoint.utc;
  assert.ok(
    typeof id === "string" && id.length,
    `the checkpoint must be identifiable, got ${JSON.stringify(checkpoint)}`,
  );
  for (const candidate of [
    id,
    path.join(store.checkpointDir, id),
    path.join(store.checkpointDir, `${id}.jsonl`),
  ]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return assert.fail(
    `the checkpoint a fold reported must exist on disk: ${JSON.stringify(checkpoint)}; `
    + `${store.checkpointDir} holds [${checkpointFiles(store).join(", ")}]`,
  );
}

function checkpointFiles(store) {
  if (!store.checkpointDir || !fs.existsSync(store.checkpointDir)) return [];
  return fs.readdirSync(store.checkpointDir).filter((name) => !name.startsWith(".")).sort();
}

/** Any file under the store that still contains this text, or null. */
function whereOnDisk(root, needle) {
  const stack = [root];
  while (stack.length) {
    const at = stack.pop();
    for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
      const full = path.join(at, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (fs.readFileSync(full, "utf8").includes(needle)) return full;
    }
  }
  return null;
}

function eventsMatching(entries, pattern) {
  return entries.filter((entry) => pattern.test(String(entry?.event ?? "")));
}

// ── the tests ───────────────────────────────────────────────────────────────

test("the fixture is a real RAPP/1 line and a real dimension document", () => {
  let head = null;
  for (const frame of localFrames()) {
    const [ok, , why] = verifyFrame(frame, { head, streamIdOfRecord: STREAM });
    assert.equal(ok, true, `fixture line frames must verify: ${why}`);
    head = frame;
  }
  head = null;
  for (const frame of sourceDocument("a", 20).frames) {
    const [ok, , why] = verifyFrame(frame, { head, streamIdOfRecord: STREAM });
    assert.equal(ok, true, `fixture source frames must verify: ${why}`);
    head = frame;
  }
});

// If the checkpoint were taken after the fold, it would be a copy of the state
// the person wants to escape. They would click restore, watch it "succeed", and
// still be looking at the merge they were trying to get out of — with no other
// copy of the line anywhere. The ordering IS the safety net.
test("a fold checkpoints the line before it changes it, and the checkpoint holds the PRE-fold state", async () => {
  const store = freshStore();
  const before = readLine(store);
  assert.equal(before.frames.length, 3);

  const folded = await fold(store, writeSource(store, "source-a", sourceDocument("a", 20)));
  assert.ok(
    howMany(folded.merged) > 0,
    "this fixture shares coordinates with the line, so the fold must merge something — "
    + "a fold that changed nothing proves nothing about ordering",
  );
  assert.ok(folded.joined, "a fold that merged frames mints a join");

  const file = checkpointFile(store, folded.checkpoint);
  assert.ok(
    path.resolve(file).startsWith(path.resolve(store.checkpointDir)),
    `the checkpoint belongs in ${store.checkpointDir}, found at ${file}`,
  );

  const checkpointed = readFrames(file);
  assert.deepEqual(
    hashes(checkpointed),
    hashes(before.frames),
    "the checkpoint is a copy of the line as it stood BEFORE the fold",
  );
  assert.equal(
    checkpointed[checkpointed.length - 1].frame_hash,
    before.head,
    "so its last frame is the pre-fold HEAD",
  );
  assert.equal(
    checkpointed.some((frame) => frame.frame_hash === folded.head),
    false,
    "and the frame the fold produced is NOT in it",
  );

  const after = readLine(store);
  assert.equal(after.head, folded.head, "the live line did move on");
  assert.equal(joinHash(folded.joined), folded.head, "and it continues from the joined frame");
  assert.equal(after.frames.length, before.frames.length + 1, "by exactly one frame: the join");
});

// Someone folds a dimension off the commons, sees it was a mistake, and hits
// restore. If HEAD does not actually go back, everything they do next descends
// from the merge they rejected.
test("restore puts HEAD back to the checkpointed state", async () => {
  const store = freshStore();
  const before = readLine(store);

  const folded = await fold(store, writeSource(store, "source-a", sourceDocument("a", 20)));
  assert.notEqual(readLine(store).head, before.head, "the fold moved HEAD");

  const back = await restore(store);
  assert.ok(back?.restoredTo, "a restore names the generation it elected");
  assert.equal(back.recorded, true, "and says it was recorded");
  assert.equal(back.head, before.head, "the restore reports the pre-fold HEAD");

  const now = readLine(store);
  assert.equal(now.head, before.head, "and the line reads back at the pre-fold HEAD");
  assert.deepEqual(hashes(now.frames), hashes(before.frames), "with exactly the pre-fold frames");
  assert.equal(
    now.frames.some((frame) => frame.frame_hash === folded.head),
    false,
    "the join is no longer the live generation",
  );

  const reported = status(store);
  assert.equal(reported.head, before.head, "status agrees about where the line is");
  assert.equal(howMany(reported.frames), before.frames.length);
});

// A rollback nobody can see is indistinguishable from a line that was quietly
// edited. A person reading this line later has to be able to tell that a fold
// happened, that it was rolled back, and when.
test("a restore is recorded — never a silent rollback", async () => {
  const store = freshStore();
  const before = readLine(store);
  const startedWith = journal(store).length;

  const folded = await fold(store, writeSource(store, "source-a", sourceDocument("a", 20)));
  const afterFold = journal(store);
  assert.ok(afterFold.length > startedWith, "the fold itself is on the record");

  const back = await restore(store);
  const afterRestore = journal(store);
  assert.ok(
    afterRestore.length > afterFold.length,
    "the restore added an entry rather than passing silently",
  );

  const restores = eventsMatching(afterRestore, /restore/i);
  assert.equal(restores.length, 1, "exactly one restore is recorded, and it is named as one");
  const entry = restores[0];
  assert.ok(
    typeof entry.utc === "string" && entry.utc.length > 0,
    "the record says WHEN the line was rolled back",
  );
  assert.ok(
    JSON.stringify(entry).includes(String(back.restoredTo))
    || JSON.stringify(entry).includes(before.head),
    `the record says WHAT was elected, so it can be traced: ${JSON.stringify(entry)}`,
  );

  const folds = eventsMatching(afterRestore, /fold|join|assimilat/i);
  assert.ok(folds.length >= 1, "the fold that was rolled back is still on the record");
  assert.ok(
    afterRestore.indexOf(entry) > afterRestore.indexOf(folds[folds.length - 1]),
    "and the restore is recorded after it, in the order a person would read",
  );

  assert.equal(howMany(status(store).restores), 1, "status shows the line has been rolled back once");
  assert.ok(howMany(status(store).folds) >= 1, "and that a fold happened at all");

  assert.ok(fs.existsSync(store.journalPath), "the journal is a plain file a person can read");
  const onDisk = fs.readFileSync(store.journalPath, "utf8");
  assert.match(onDisk, /restore/i, "and the restore is in it, not only in memory");
  assert.ok(
    onDisk.includes(folded.head) || /fold|join|assimilat/i.test(onDisk),
    "alongside the fold it superseded",
  );
});

test("a failed restore rolls back the line, checkpoint, journal, and snapshots", async () => {
  const store = freshStore();
  const folded = await fold(store, writeSource(store, "source-a", sourceDocument("a", 20)));
  const liveBefore = readLine(store);
  const checkpointBefore = checkpointFile(store, folded.checkpoint);
  const journalBefore = journal(store);

  const brokenStore = {
    ...store,
    journalPath: path.join(homeOf.get(store), "missing-parent", "journal.jsonl"),
  };
  assert.throws(
    () => restore(brokenStore),
    /ENOENT|no such file or directory/i,
    "an unwritable journal makes the restore fail rather than go unrecorded",
  );

  assert.deepEqual(hashes(readLine(store).frames), hashes(liveBefore.frames), "the live line rolled back");
  assert.ok(fs.existsSync(checkpointBefore), "the checkpoint is active for a retry");
  assert.deepEqual(journal(store), journalBefore, "the durable journal is unchanged");
  assert.deepEqual(fs.readdirSync(store.restoredCheckpointDir), [], "no checkpoint was archived");
  assert.deepEqual(fs.readdirSync(store.supersededDir), [], "no superseded snapshot was left behind");
});

test("a corrupt checkpoint is refused before restore changes anything", async () => {
  const store = freshStore();
  const folded = await fold(store, writeSource(store, "source-a", sourceDocument("a", 20)));
  const liveBefore = readLine(store);
  const checkpoint = checkpointFile(store, folded.checkpoint);
  const journalBefore = journal(store);

  const damaged = readFrames(checkpoint);
  damaged[damaged.length - 1].payload.asserts.tampered = true;
  fs.writeFileSync(
    checkpoint,
    damaged.map((frame) => JSON.stringify(frame)).join("\n") + "\n",
    "utf8",
  );

  assert.throws(
    () => restore(store),
    /checkpoint .* frame .* failed RAPP\/1 verification: payload_hash mismatch/i,
  );
  assert.deepEqual(hashes(readLine(store).frames), hashes(liveBefore.frames), "the live line is unchanged");
  assert.ok(fs.existsSync(checkpoint), "the corrupt checkpoint remains active for inspection or repair");
  assert.deepEqual(journal(store), journalBefore, "no restore was journaled");
  assert.deepEqual(fs.readdirSync(store.restoredCheckpointDir), [], "nothing was archived");
  assert.deepEqual(fs.readdirSync(store.supersededDir), [], "nothing was superseded");
});

test("empty stream ids are invalid and a checkpoint cannot switch valid streams", () => {
  const store = freshStore();
  fs.mkdirSync(store.checkpointDir, { recursive: true });
  const empty = buildFrame({
    kind: "qqdrill.tick",
    streamId: "",
    seq: 0,
    utc: utcAt(40),
    payload: { asserts: { stage: "first" }, requires: {} },
    prev: null,
    prevWave: null,
  });
  assert.equal(verifyFrame(empty, { head: null })[0], false);
  const first = buildFrame({
    kind: "qqdrill.tick",
    streamId: STREAM,
    seq: 0,
    utc: utcAt(40),
    payload: { asserts: { stage: "first" }, requires: {} },
    prev: null,
    prevWave: null,
  });
  const second = buildFrame({
    kind: "qqdrill.tick",
    streamId: `rappid:@rapp/other-weather:${"b".repeat(64)}`,
    seq: 1,
    utc: utcAt(41),
    payload: { asserts: { stage: "second" }, requires: {} },
    prev: first.payload_hash,
    prevWave: null,
  });
  assert.equal(verifyFrame(first, { head: null })[0], true);
  assert.equal(
    verifyFrame(second, { head: first })[0],
    true,
    "the fixture isolates the cross-frame stream check from per-frame verification",
  );
  const checkpoint = path.join(
    store.checkpointDir,
    "2026-08-21T12-00-00-000Z-000.jsonl",
  );
  fs.writeFileSync(
    checkpoint,
    `${JSON.stringify(first)}\n${JSON.stringify(second)}\n`,
  );
  const liveBefore = readLine(store);

  assert.throws(() => restore(store), /stream_id mismatch/i);
  assert.deepEqual(hashes(readLine(store).frames), hashes(liveBefore.frames));
  assert.ok(fs.existsSync(checkpoint), "the invalid checkpoint remains available for inspection");
  assert.equal(status(store).restores, 0);
});

test("an active writer lock refuses a concurrent restore without changing state", async () => {
  const store = freshStore();
  const folded = await fold(store, writeSource(store, "source-a", sourceDocument("a", 20)));
  const liveBefore = readLine(store);
  const checkpoint = checkpointFile(store, folded.checkpoint);
  fs.writeFileSync(
    path.join(store.root, ".write.lock"),
    `${JSON.stringify({ pid: process.pid, token: "other-writer" })}\n`,
    { mode: 0o600 },
  );

  assert.throws(() => restore(store), /busy|writer|lock/i);
  assert.deepEqual(hashes(readLine(store).frames), hashes(liveBefore.frames));
  assert.ok(fs.existsSync(checkpoint), "the concurrent writer still owns the checkpoint");
  assert.equal(status(store).restores, 0);
});

test("a dead writer lock refuses until an operator removes the exact stale file", async () => {
  const store = freshStore();
  const before = readLine(store);
  await fold(store, writeSource(store, "source-a", sourceDocument("a", 20)));
  fs.writeFileSync(
    path.join(store.root, ".write.lock"),
    `${JSON.stringify({ pid: 2_147_483_647, token: "dead-writer" })}\n`,
    { mode: 0o600 },
  );

  assert.throws(() => restore(store), /stale writer lock/i);
  assert.equal(status(store).restores, 0);
  fs.rmSync(path.join(store.root, ".write.lock"));
  const restored = restore(store);
  assert.equal(restored.ok, true);
  assert.equal(restored.head, before.head);
  assert.equal(fs.existsSync(path.join(store.root, ".write.lock")), false);
});

// Restoring is electing an earlier generation, not un-merging. If restore
// destroyed the folded frames, a person who rolled back one merge too many
// would have nothing left to go forward to — and the "no un-merge" guarantee
// would have been broken by the store instead of the protocol.
test("restoring archives the used checkpoint and keeps every generation recoverable", async () => {
  const store = freshStore();
  const before = readLine(store);

  const folded = await fold(store, writeSource(store, "source-a", sourceDocument("a", 20)));
  const checkpoint = checkpointFile(store, folded.checkpoint);
  const merged = Array.isArray(folded.merged) ? folded.merged : [];

  await restore(store);

  assert.ok(
    whereOnDisk(store.root, folded.head),
    "the frame the fold minted is still somewhere in the store — nothing was deleted",
  );
  for (const frame of merged) {
    const hash = typeof frame === "string" ? frame : frame.frame_hash;
    assert.ok(
      whereOnDisk(store.root, hash),
      `the assimilated frame ${hash} is still recoverable after the rollback`,
    );
  }

  assert.equal(fs.existsSync(checkpoint), false, "the used checkpoint left the active undo stack");
  const archived = path.join(store.restoredCheckpointDir, path.basename(checkpoint));
  assert.ok(fs.existsSync(archived), "the used checkpoint moved to the restored-checkpoint archive");
  assert.deepEqual(
    hashes(readFrames(archived)),
    hashes(before.frames),
    "and the archived checkpoint still reads back as the generation it captured",
  );
});

// The dangerous version of this is a restore that quietly does nothing on a
// store with no checkpoint: the person believes they rolled back, and carries on
// building on a line they thought they had abandoned. A crash is nearly as bad —
// it tells them the tool is broken rather than that there is nothing to go back to.
test("restore with no checkpoint refuses out loud, and changes nothing", async () => {
  const store = freshStore();
  const before = readLine(store);
  assert.deepEqual(checkpointFiles(store), [], "nothing has been folded, so there is nothing to restore");

  let refusal;
  try {
    refusal = await restore(store);
  } catch (error) {
    assert.fail(`restore must refuse with a stated reason, not throw: ${error?.message}`);
  }

  assert.ok(refusal && typeof refusal === "object", "a refusal is a result, so it comes back as one");
  assert.ok(!refusal.restoredTo, `nothing was elected, so nothing is named: ${JSON.stringify(refusal)}`);
  const reason = String(refusal.reason ?? refusal.detail ?? refusal.why ?? "");
  assert.ok(reason.trim().length > 0, `the refusal states a reason: ${JSON.stringify(refusal)}`);
  assert.match(reason, /checkpoint/i, "and the reason says what is missing");

  const now = readLine(store);
  assert.equal(now.head, before.head, "HEAD did not move");
  assert.deepEqual(hashes(now.frames), hashes(before.frames), "and neither did the line");
  if ("head" in refusal) {
    assert.equal(refusal.head, before.head, "a refusal must not report a HEAD the line is not at");
  }
});

// A person who rolls a fold back is not done with the app. If the store were
// wedged after a restore — the next fold failing, or overwriting the checkpoint
// that got them out last time — the rollback would cost them the safety net.
test("fold, restore, fold again: the second fold works and gets its own checkpoint", async () => {
  const store = freshStore();
  const before = readLine(store);

  const first = await fold(store, writeSource(store, "source-a", sourceDocument("a", 20)));
  const firstCheckpoint = checkpointFile(store, first.checkpoint);
  await restore(store);
  assert.equal(readLine(store).head, before.head);
  const archivedFirst = path.join(store.restoredCheckpointDir, path.basename(firstCheckpoint));

  const second = await fold(store, writeSource(store, "source-b", sourceDocument("b", 30)));
  assert.ok(howMany(second.merged) > 0, "the second fold merges normally");
  assert.ok(second.joined, "and mints its own join");
  assert.equal(joinHash(second.joined), second.head);
  assert.notEqual(second.head, before.head, "HEAD moved off the restored generation");
  assert.notEqual(second.head, first.head, "and this is a different join from the first");

  const secondCheckpoint = checkpointFile(store, second.checkpoint);
  assert.notEqual(
    path.resolve(secondCheckpoint),
    path.resolve(firstCheckpoint),
    "the second fold's checkpoint is its own file, not the first one written over",
  );
  assert.equal(fs.existsSync(firstCheckpoint), false, "the first checkpoint is no longer active");
  assert.ok(fs.existsSync(archivedFirst), "and the first checkpoint survived in the archive");
  assert.deepEqual(
    hashes(readFrames(secondCheckpoint)),
    hashes(before.frames),
    "the second checkpoint holds the restored line, which is what the second fold was applied to",
  );

  const line = readLine(store);
  assert.equal(line.head, second.head);
  assert.equal(line.frames.length, before.frames.length + 1);

  const back = await restore(store);
  assert.equal(back.head, before.head, "and the way back still works after the round trip");
  assert.equal(readLine(store).head, before.head);
});

// Checkpoint names come from a clock, and folds can happen back to back — a
// sentinel drilling on a schedule does exactly that. If two folds in the same
// second share a filename, the second silently destroys the only copy of the
// state the first one was protecting, and the person can only get back one step
// when they need two.
test("folds in quick succession leave one recoverable checkpoint each, never one", async () => {
  const store = freshStore();
  const documents = [sourceDocument("a", 20), sourceDocument("b", 30), sourceDocument("c", 40)];
  const files = documents.map((document, index) => writeSource(store, `source-${index}`, document));

  const headsBefore = [];
  const results = [];
  const startedAt = Date.now();
  for (const file of files) {
    headsBefore.push(readLine(store).head);
    // Deliberately no pause: three folds inside the same wall-clock second.
    results.push(await fold(store, file));
  }
  const elapsed = Date.now() - startedAt;

  for (const [index, result] of results.entries()) {
    assert.ok(howMany(result.merged) > 0, `fold ${index + 1} merged something`);
  }

  const checkpoints = results.map((result) => path.resolve(checkpointFile(store, result.checkpoint)));
  assert.equal(
    new Set(checkpoints).size,
    3,
    `three folds in ${elapsed}ms must leave three distinct checkpoints, got ${JSON.stringify(checkpoints)}`,
  );
  assert.ok(
    checkpointFiles(store).length >= 3,
    `the checkpoint directory holds all three: [${checkpointFiles(store).join(", ")}]`,
  );

  checkpoints.forEach((file, index) => {
    const frames = readFrames(file);
    assert.equal(
      frames.length,
      3 + index,
      `checkpoint ${index + 1} holds the line as it stood before fold ${index + 1}`,
    );
    assert.equal(
      frames[frames.length - 1].frame_hash,
      headsBefore[index],
      `checkpoint ${index + 1} ends at the HEAD that fold ${index + 1} was applied to — `
      + "a later fold must never write over it",
    );
    // A checkpoint nobody could replay is not a way back, it is a file.
    let head = null;
    for (const frame of frames) {
      const [ok, , why] = verifyFrame(frame, { head });
      assert.equal(ok, true, `checkpoint ${index + 1} must still be a valid RAPP/1 line: ${why}`);
      head = frame;
    }
  });
});

// restore is what a person reaches for right after one fold went wrong. If it
// elected the oldest checkpoint instead of the newest, undoing one bad fold
// would silently throw away every good fold before it.
test("restore elects the most recent checkpoint — it undoes the last fold, not all of them", async () => {
  const store = freshStore();
  const heads = [];
  for (const [index, tag] of ["a", "b", "c"].entries()) {
    heads.push(readLine(store).head);
    await fold(store, writeSource(store, `source-${tag}`, sourceDocument(tag, 20 + index * 10)));
  }
  const afterThree = readLine(store);
  assert.equal(afterThree.frames.length, 6, "three folds, three joins");

  const back = await restore(store);
  assert.equal(
    back.head,
    heads[2],
    "restoring returns to the line as it stood before the LAST fold",
  );

  const now = readLine(store);
  assert.equal(now.head, heads[2]);
  assert.equal(now.frames.length, 5, "the two earlier folds are still on the live line");
  assert.notEqual(now.head, heads[0], "restoring did not wind the whole line back to the start");
});

test("successive restores walk the checkpoint stack once, then refuse", async (t) => {
  const NativeDate = globalThis.Date;
  const frozen = "2026-08-21T12:34:56.789Z";
  globalThis.Date = class FrozenDate extends NativeDate {
    constructor(...args) {
      super(...(args.length ? args : [frozen]));
    }

    static now() {
      return NativeDate.parse(frozen);
    }
  };
  t.after(() => {
    globalThis.Date = NativeDate;
  });

  const store = freshStore();
  const original = readLine(store);

  const first = await fold(store, writeSource(store, "source-a", sourceDocument("a", 20)));
  const afterFirst = readLine(store);
  const firstCheckpoint = checkpointFile(store, first.checkpoint);
  const second = await fold(store, writeSource(store, "source-b", sourceDocument("b", 30)));
  const afterSecond = readLine(store);
  const secondCheckpoint = checkpointFile(store, second.checkpoint);
  assert.equal(checkpointFiles(store).length, 2, "both folds left an active way back");

  const backOne = restore(store);
  assert.equal(backOne.ok, true);
  assert.equal(backOne.head, afterFirst.head, "the first restore undoes only the second fold");
  assert.equal(checkpointFiles(store).length, 1, "the used checkpoint left the active stack");
  assert.ok(
    fs.existsSync(path.join(store.restoredCheckpointDir, path.basename(secondCheckpoint))),
    "the second checkpoint was archived rather than deleted",
  );
  const firstSuperseded = readFrames(path.join(store.supersededDir, backOne.superseded));
  assert.deepEqual(
    hashes(firstSuperseded),
    hashes(afterSecond.frames),
    "the first superseded file is the exact line the first restore stepped away from",
  );
  assertValidLine(firstSuperseded, "the first superseded file");

  const backTwo = restore(store);
  assert.equal(backTwo.ok, true);
  assert.equal(backTwo.head, original.head, "the second restore reaches the pre-first-fold line");
  assert.deepEqual(hashes(readLine(store).frames), hashes(original.frames));
  assert.equal(checkpointFiles(store).length, 0, "both recovery points were consumed exactly once");
  assert.ok(
    fs.existsSync(path.join(store.restoredCheckpointDir, path.basename(firstCheckpoint))),
    "the first checkpoint was archived too",
  );
  const secondSuperseded = readFrames(path.join(store.supersededDir, backTwo.superseded));
  assert.deepEqual(
    hashes(secondSuperseded),
    hashes(afterFirst.frames),
    "the second superseded file is the exact line the second restore stepped away from",
  );
  assertValidLine(secondSuperseded, "the second superseded file");
  assert.notEqual(
    backOne.superseded,
    backTwo.superseded,
    "two restores in the same millisecond receive distinct superseded paths",
  );

  const eventsBeforeRefusal = journal(store);
  const supersededBeforeRefusal = fs.readdirSync(store.supersededDir).sort();
  assert.equal(supersededBeforeRefusal.length, 2, "each real restore preserved one live generation");

  const refused = restore(store);
  assert.equal(refused.ok, false, "there is no third checkpoint to restore");
  assert.match(refused.reason, /checkpoint/i);
  assert.deepEqual(journal(store), eventsBeforeRefusal, "a refused no-op is not journaled as a restore");
  assert.deepEqual(
    fs.readdirSync(store.supersededDir).sort(),
    supersededBeforeRefusal,
    "a refused no-op writes no superseded copy",
  );
  assert.equal(status(store).restores, 2, "status counts only the two restores that moved the line");
});

// A search is meant to be free — the protocol's whole reason for keeping the
// drill and the fold apart. If scanning left checkpoints behind, the checkpoint
// directory a person digs through in a bad moment would be full of generations
// that were never at risk, and the one they need would be buried.
test("a scan costs nothing: no checkpoint, no journal rollback point, no moved HEAD", async () => {
  const store = freshStore();
  const before = readLine(store);
  const file = writeSource(store, "source-a", sourceDocument("a", 20));

  const found = await scan(store, file);
  assert.equal(found.changed, false, "a scan says plainly that it changed nothing");
  assert.deepEqual(checkpointFiles(store), [], "and left no checkpoint behind");
  assert.equal(readLine(store).head, before.head, "HEAD did not move");
  assert.deepEqual(hashes(readLine(store).frames), hashes(before.frames));
  assert.equal(howMany(status(store).folds), 0, "nothing was folded");

  // So there is still nothing to restore, and the app says so rather than
  // pretending the scan was something to go back from.
  const refusal = await restore(store);
  assert.ok(!refusal.restoredTo, "a scan is not a generation to return to");
  assert.match(String(refusal.reason ?? refusal.detail ?? refusal.why ?? ""), /checkpoint/i);
});

// The drill is a fast local lookup. Remote delivery is a separate summon/save
// step, so a URL must be refused before a checkpoint or mutation can happen.
test("a remote fold is refused before checkpointing; its saved bytes remain recoverable", async () => {
  const store = freshStore();
  const before = readLine(store);
  const document = sourceDocument("a", 20);
  await assert.rejects(
    () => fold(store, "https://raw.githubusercontent.com/owner/repo/main/dimension.json"),
    /local lookup|summon and save/i,
  );
  assert.deepEqual(checkpointFiles(store), []);
  assert.equal(readLine(store).head, before.head);

  const saved = writeSource(store, "saved-remote", document);
  const folded = await fold(store, saved);
  assert.ok(howMany(folded.merged) > 0, "the saved dimension merged");
  const checkpointed = readFrames(checkpointFile(store, folded.checkpoint));
  assert.deepEqual(hashes(checkpointed), hashes(before.frames));
  const back = await restore(store);
  assert.equal(back.head, before.head);
  assert.equal(back.recorded, true);
  assert.ok(whereOnDisk(store.root, folded.head));
});

// Found 2026-08-21 by driving the published beta page in a real browser: fold,
// then fold again against a commons with nothing new, then restore — and the
// line came back to the state AFTER the first fold rather than before it. The
// second fold had taken a checkpoint of the already-folded line and become the
// most recent one, so the no-op quietly consumed the recovery point the person
// was relying on. A fold that changes nothing must cost nothing.
test("a fold that merges nothing does not spend the way back", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "drill-noop-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = createStore(root);

  const local = chain([{ asserts: { sky: "clear" } }]);
  fs.mkdirSync(path.dirname(store.linePath), { recursive: true });
  fs.writeFileSync(store.linePath, local.map((f) => JSON.stringify(f)).join("\n") + "\n", "utf8");
  const beforeAnyFold = readLine(store).head;

  const doc = {
    manifest: { dimension_id: "commons", clock_key: 1 },
    frames: chain([{ asserts: { sky: "clear" } }, { asserts: { wind: 5 } }], { ran: 30 }),
  };
  const source = path.join(root, "commons.json");
  fs.writeFileSync(source, JSON.stringify(doc), "utf8");

  await fold(store, source);
  const afterRealFold = readLine(store).head;
  assert.notEqual(afterRealFold, beforeAnyFold, "the first fold changed the line");

  const second = await fold(store, source);
  assert.equal(second.merged.length, 0, "the second fold has nothing new to absorb");
  assert.equal(second.checkpoint, null, "and reports that it took no checkpoint");

  const back = restore(store);
  assert.equal(back.ok, true);
  assert.equal(
    back.head,
    beforeAnyFold,
    "restore must return to the state before the fold that actually changed something, "
      + "not to the state a no-op fold happened to photograph",
  );
});
