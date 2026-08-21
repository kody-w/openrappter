// rapp-drill — the application that uses the method.
//
// qqdrill.mjs implements finding work another machine already did and absorbing
// what is safe to absorb. Until now nothing called it: a reviewed, tested
// library shipped as dead code. This is what makes it usable.
//
// Everything is plain files a person can read with `cat`:
//
//   <root>/line.jsonl              the local line, one RAPP/1 frame per line
//   <root>/checkpoints/<utc>.jsonl a copy of the line taken BEFORE each fold
//   <root>/journal.jsonl           what happened, one event per line
//
// No database, nothing that needs a daemon, nothing that has to be running for
// the files to mean something. If this application disappears, the record it
// leaves is still readable.
//
// The two rules it exists to keep:
//   scan changes nothing — it is safe to run constantly
//   fold checkpoints first — there is no un-merge, so there must be a way back

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, readdirSync, copyFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { H, verifyFrame } from "./qqdrill-deps.mjs";
import {
  alignment,
  assimilate,
  dimension,
  drill,
  fixedPoints,
  makeLine,
  runsFrom,
} from "./qqdrill.mjs";

/** The default cadence a local line runs at when it has not said otherwise. */
const DEFAULT_CLOCK = 1;

export function createStore(root) {
  const resolved = path.resolve(root);
  return Object.freeze({
    root: resolved,
    linePath: path.join(resolved, "line.jsonl"),
    checkpointDir: path.join(resolved, "checkpoints"),
    journalPath: path.join(resolved, "journal.jsonl"),
    manifestPath: path.join(resolved, "manifest.json"),
    // Superseded state lives apart from checkpoints. Both are kept, but they
    // answer different questions — "what could I go back to" versus "what did I
    // step away from" — and mixing them made a restore look like a fold.
    supersededDir: path.join(resolved, "superseded"),
  });
}

function ensure(store) {
  mkdirSync(store.root, { recursive: true });
  mkdirSync(store.checkpointDir, { recursive: true });
  mkdirSync(store.supersededDir, { recursive: true });
}

function readJsonl(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`${path.basename(file)} line ${index + 1} is not readable JSON: ${error.message}`);
      }
    });
}

function writeJsonl(file, rows) {
  writeFileSync(file, rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : ""), "utf8");
}

/** A store that has never been used is empty, not broken. */
export function readLine(store) {
  return makeLine(readJsonl(store.linePath));
}

export function localManifest(store) {
  if (existsSync(store.manifestPath)) {
    try {
      const declared = JSON.parse(readFileSync(store.manifestPath, "utf8"));
      return { dimension_id: "local", clock_key: DEFAULT_CLOCK, ...declared };
    } catch {
      // A manifest we cannot read is not a reason to refuse to run; the default
      // cadence is stated rather than guessed.
    }
  }
  return { dimension_id: "local", clock_key: DEFAULT_CLOCK };
}

function localDimension(store) {
  return dimension(localManifest(store), readLine(store).frames);
}

function record(store, event, detail) {
  ensure(store);
  appendFileSync(store.journalPath, JSON.stringify({
    utc: new Date().toISOString(), event, detail,
  }) + "\n", "utf8");
}

export function journal(store) {
  return readJsonl(store.journalPath);
}

export function status(store) {
  const line = readLine(store);
  const events = journal(store);
  return Object.freeze({
    root: store.root,
    frames: line.frames.length,
    head: line.head,
    checkpoints: checkpoints(store).length,
    folds: events.filter((entry) => entry.event === "fold").length,
    restores: events.filter((entry) => entry.event === "restore").length,
  });
}

export function checkpoints(store) {
  if (!existsSync(store.checkpointDir)) return [];
  return readdirSync(store.checkpointDir)
    .filter((name) => name.endsWith(".jsonl"))
    .sort();
}

// ── the commons ─────────────────────────────────────────────────────────────

/**
 * Load a commons document from a path or a URL.
 *
 * An unreachable source is an ERROR and never reads as "nothing found". A person
 * must be able to tell a network failure from an empty commons, or they will act
 * on a silence that means the opposite of what they think.
 *
 * The bytes are DATA. Every frame is verified before anything looks at it, and a
 * malformed document is refused whole rather than partially applied.
 */
export async function loadSource(source) {
  if (typeof source !== "string" || !source.trim()) {
    throw new Error("a source must be a path or a URL");
  }
  let text;
  if (/^https?:\/\//i.test(source)) {
    let response;
    try {
      response = await fetch(source);
    } catch (error) {
      throw new Error(`could not reach ${source}: ${error.message}`);
    }
    if (!response.ok) {
      throw new Error(`${source} answered ${response.status} ${response.statusText || ""}`.trim());
    }
    text = await response.text();
  } else {
    const file = source.startsWith("file://") ? new URL(source) : pathToFileURL(path.resolve(source));
    try {
      text = readFileSync(file, "utf8");
    } catch (error) {
      throw new Error(`could not read ${source}: ${error.message}`);
    }
  }

  let document;
  try {
    document = JSON.parse(text);
  } catch (error) {
    throw new Error(`${source} is not readable JSON: ${error.message}`);
  }
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    throw new Error(`${source} is not a commons document`);
  }
  if (!Array.isArray(document.frames)) {
    throw new Error(`${source} has no frames array`);
  }
  // The document's SHAPE is refused whole — an entry that is not even an object
  // means the document is not a commons and nothing in it can be trusted to
  // mean what it appears to. That is a different failure from a frame that IS
  // well formed and fails its own hash check: each frame carries its own
  // hashes, so a tampered frame is caught on its own while the rest remain
  // provably good. Refusing a whole commons over one bad frame would let any
  // single publisher deny the commons to everyone.
  for (const [index, frame] of document.frames.entries()) {
    if (!frame || typeof frame !== "object" || Array.isArray(frame)) {
      throw new Error(`${source} has a frames entry at index ${index} that is not a frame`);
    }
  }
  const manifest = document.manifest;
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error(`${source} has no manifest`);
  }
  return Object.freeze({
    source,
    manifest: Object.freeze({ dimension_id: "commons", clock_key: DEFAULT_CLOCK, ...manifest }),
    frames: Object.freeze([...document.frames]),
  });
}

/**
 * Split a commons into the frames that are genuinely RAPP/1 and the ones that
 * are not, each rejection naming the frame and the reason. One bad frame must
 * not take the batch down.
 */
export function verifyFrames(frames) {
  const good = [];
  const rejected = [];
  for (const [index, frame] of frames.entries()) {
    const verdict = selfConsistent(frame);
    if (verdict.ok) good.push(frame);
    else rejected.push({ frame: frame?.frame_hash ?? `index ${index}`, reason: verdict.reason });
  }
  return { good, rejected };
}

/**
 * Is this frame intact — do its own hashes still describe its own bytes?
 *
 * Deliberately NOT verifyFrame against the previous entry in the array. A
 * commons document is a bag of frames, not a chain, and checking each frame
 * against its neighbour made the verdict depend on the ORDER the publisher
 * happened to serialise them in: the same frames shuffled produced a different
 * set of accepted frames, and therefore a different join. Array order must
 * never reach a merge.
 *
 * Chain position is the receiving line's business. What a commons must prove
 * about a frame is that nobody edited it after it was hashed.
 */
function selfConsistent(frame) {
  if (!frame || typeof frame !== "object" || Array.isArray(frame)) {
    return { ok: false, reason: "not a frame" };
  }
  // Cheap structural gate first, so a nonsense object fails with a useful word
  // rather than a hashing error.
  const [, , why] = verifyFrame(frame, { head: null });
  const structural = /spec|kind|invalid|not |must |mismatch/i.test(String(why || ""));
  try {
    if (frame.payload_hash !== H("rapp/1:particle", frame.payload)) {
      return { ok: false, reason: "payload_hash does not describe this payload — the frame was edited after it was hashed" };
    }
    const preimage = Object.fromEntries(
      Object.entries(frame).filter(([key]) => !["frame_hash", "sig"].includes(key)),
    );
    if (frame.frame_hash !== H("rapp/1:wave", preimage)) {
      return { ok: false, reason: "frame_hash does not describe this frame — the frame was edited after it was hashed" };
    }
  } catch (error) {
    return { ok: false, reason: error.message };
  }
  if (structural && !/genesis|contiguous|prev does not match|utc moved/i.test(String(why || ""))) {
    return { ok: false, reason: why };
  }
  return { ok: true };
}

// ── the commands ────────────────────────────────────────────────────────────

/**
 * Find what a commons shares with this line. Changes nothing — no file is
 * written, no checkpoint taken, no lineage advanced. It is safe to run
 * constantly, which is the whole reason searching is separated from folding.
 */
export async function scan(store, source) {
  const loaded = await loadSource(source);
  const { good, rejected } = verifyFrames(loaded.frames);
  const here = localDimension(store);
  const there = dimension(loaded.manifest, good);

  const found = drill(here, there);
  const points = fixedPoints(found.pairs);

  return Object.freeze({
    source: loaded.source,
    changed: false,
    searched: found.searched,
    pairs: found.pairs,
    fixedPoints: points,
    runs: runsFrom(points, here, there),
    alignment: alignment(points, here, there),
    rejected: Object.freeze(rejected),
    exhausted: found.exhausted,
  });
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

/**
 * Take a copy of the line before touching it. A name collision cannot silently
 * lose a checkpoint: two folds in the same millisecond produce two files.
 */
export function checkpoint(store) {
  ensure(store);
  // Always suffixed and zero-padded, so the filenames sort chronologically as
  // plain strings. Suffixing only on collision produced "…000Z-1.jsonl" beside
  // "…000Z.jsonl", and "-" sorts before "." — so the NEWER checkpoint sorted
  // first and "restore the most recent" quietly returned the wrong generation.
  const base = stamp();
  let n = 0;
  let name = `${base}-${String(n).padStart(3, "0")}.jsonl`;
  while (existsSync(path.join(store.checkpointDir, name))) {
    n += 1;
    name = `${base}-${String(n).padStart(3, "0")}.jsonl`;
  }
  const target = path.join(store.checkpointDir, name);
  if (existsSync(store.linePath)) copyFileSync(store.linePath, target);
  else writeFileSync(target, "", "utf8");
  return name;
}

/**
 * Drill a commons and assimilate what may be assimilated.
 *
 * The checkpoint is taken FIRST, before anything is written, because the
 * protocol has no un-merge: a fold is the one operation that can put something
 * on a line you would want back. Append-only is the right guarantee and it is
 * not a recovery story on its own.
 */
export async function fold(store, source) {
  ensure(store);
  const loaded = await loadSource(source);
  const { good, rejected } = verifyFrames(loaded.frames);
  const before = readLine(store);

  // Before the line is touched. The ordering is the point.
  const taken = checkpoint(store);

  // What this line has already absorbed. The assimilated frames are NOT spliced
  // into the chain — the join names them by hash — so asking only which frames
  // are on the line would offer every previously folded frame again, and folding
  // the same commons twice would keep minting joins that absorb nothing new.
  const held = new Set();
  for (const frame of before.frames) {
    held.add(frame.frame_hash);
    for (const absorbed of frame?.payload?.assimilated || []) held.add(absorbed);
  }
  const incoming = good.filter((frame) => !held.has(frame.frame_hash));
  const result = assimilate(before, incoming);

  if (result.joined) {
    writeJsonl(store.linePath, result.line.frames);
  }

  record(store, "fold", {
    source: loaded.source,
    checkpoint: taken,
    offered: good.length,
    merged: result.merged.map((frame) => frame.frame_hash),
    refused: result.refused.map((entry) => ({
      frame: entry.frame,
      why: entry.contradicts?.[0]?.key ?? "refused",
      detail: entry.contradicts?.[0] ?? null,
    })),
    rejected,
    head: result.head,
  });

  const refused = Object.freeze([
    ...result.refused,
    // A frame that never reached the fold because it was not intact is still a
    // frame that did not merge. A caller should not have to know which of two
    // lists to look in to find out what happened to it.
    ...rejected.map((entry) => Object.freeze({
      frame: entry.frame,
      contradicts: Object.freeze([Object.freeze({ key: "integrity", reason: entry.reason })]),
    })),
  ]);

  return Object.freeze({
    source: loaded.source,
    checkpoint: taken,
    merged: result.merged,
    refused,
    rejected: Object.freeze(rejected),
    joined: result.joined,
    head: result.head,
  });
}

/**
 * Return to the last checkpoint.
 *
 * This is not an un-merge. The folded frames still exist — in the checkpoint
 * directory and in the journal — and the restore is itself recorded. An earlier
 * generation is elected as live; nothing is unwritten.
 */
export function restore(store) {
  const taken = checkpoints(store);
  if (!taken.length) {
    return Object.freeze({
      ok: false,
      reason: "there is no checkpoint to return to — nothing has been folded on this line",
    });
  }
  const latest = taken[taken.length - 1];
  const source = path.join(store.checkpointDir, latest);
  // Keep what is being rolled back, so restoring loses nothing.
  ensure(store);
  const supersededName = `${stamp()}.jsonl`;
  if (existsSync(store.linePath)) {
    copyFileSync(store.linePath, path.join(store.supersededDir, supersededName));
  }
  copyFileSync(source, store.linePath);
  const line = readLine(store);
  record(store, "restore", { restoredTo: latest, superseded: supersededName, head: line.head });
  return Object.freeze({
    ok: true,
    recorded: true,
    restoredTo: latest,
    superseded: supersededName,
    head: line.head,
  });
}

/** Write frames onto a line. Used to seed a store; append-only. */
export function seedLine(store, frames) {
  ensure(store);
  writeJsonl(store.linePath, frames);
  return readLine(store);
}
