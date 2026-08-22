import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createStore, readLine, seedLine } from "../electron/drill-app.mjs";
import { buildFrame } from "../electron/rapp-protocol.mjs";

const CLI = fileURLToPath(new URL("../scripts/rapp-drill.mjs", import.meta.url));
const STREAM = `rappid:@rapp/tile-weather:${"a".repeat(64)}`;
const ANSI = /\x1b\[[0-9;]*m/g;

function chain(entries, ran = 0) {
  const frames = [];
  let prev = null;
  for (const [index, entry] of entries.entries()) {
    const frame = buildFrame({
      kind: "qqdrill.tick",
      streamId: STREAM,
      seq: index,
      utc: `2026-08-21T12:${String(ran).padStart(2, "0")}:${String(index).padStart(2, "0")}.000Z`,
      payload: { asserts: entry.asserts || {}, requires: entry.requires || {} },
      prev,
      prevWave: null,
    });
    frames.push(frame);
    prev = frame.payload_hash;
  }
  return frames;
}

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "rapp-drill-cli-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const store = createStore(path.join(home, "store"));
  seedLine(store, chain([
    { asserts: { sky: "clear" } },
    { asserts: { wind: 5 } },
    { asserts: { note: "local-only" } },
  ]));
  const original = readLine(store);

  const source = (name, tag, ran) => {
    const file = path.join(home, `${name}.json`);
    fs.writeFileSync(file, JSON.stringify({
      manifest: { dimension_id: name, clock_key: 1 },
      frames: chain([
        { asserts: { sky: "clear" } },
        { asserts: { wind: 5 } },
        { asserts: { gust: tag } },
      ], ran),
    }));
    return file;
  };

  return {
    store,
    original,
    sourceA: source("source-a", "a", 20),
    sourceB: source("source-b", "b", 30),
  };
}

function run(store, ...args) {
  const result = spawnSync(process.execPath, [CLI, "--root", store.root, ...args], {
    encoding: "utf8",
  });
  return {
    ...result,
    stdout: result.stdout.replace(ANSI, ""),
    stderr: result.stderr.replace(ANSI, ""),
  };
}

test("the CLI walks back two folds once each and refuses a third restore", (t) => {
  const { store, original, sourceA, sourceB } = fixture(t);
  assert.equal(run(store, "fold", sourceA).status, 0);
  assert.equal(run(store, "fold", sourceB).status, 0);

  const first = run(store, "restore");
  const second = run(store, "restore");
  const third = run(store, "restore");
  assert.equal(first.status, 0);
  assert.equal(second.status, 0);
  assert.equal(third.status, 1);
  assert.match(third.stderr, /cannot restore.*no checkpoint/s);
  assert.deepEqual(
    readLine(store).frames.map((frame) => frame.frame_hash),
    original.frames.map((frame) => frame.frame_hash),
    "two restores returned to the original line",
  );

  const status = run(store, "status");
  assert.match(status.stdout, /checkpoints 0/);
  assert.match(status.stdout, /restores    2/);
});

test("a no-op fold says no checkpoint was needed, never checkpoint null", (t) => {
  const { store, sourceA } = fixture(t);
  assert.equal(run(store, "fold", sourceA).status, 0);
  const second = run(store, "fold", sourceA);
  assert.equal(second.status, 0);
  assert.match(second.stdout, /no checkpoint needed.*nothing was written/);
  assert.doesNotMatch(second.stdout, /checkpoint null/i);
});

test("the durable log counts integrity rejections separately from refusals", (t) => {
  const { store } = fixture(t);
  const tampered = chain([{ asserts: { signal: "original" } }], 40)[0];
  tampered.payload.asserts.signal = "edited after hashing";
  const source = path.join(path.dirname(store.root), "tampered.json");
  fs.writeFileSync(source, JSON.stringify({
    manifest: { dimension_id: "tampered", clock_key: 1 },
    frames: [tampered],
  }));

  const folded = run(store, "fold", source);
  assert.equal(folded.status, 0);
  assert.match(folded.stdout, /refused .*payload_hash does not describe this payload/);

  const log = run(store, "log");
  assert.equal(log.status, 0);
  assert.match(log.stdout, /0 merged, 0 refused, 1 rejected/);
});

test("an unknown command is diagnosed before source validation", (t) => {
  const { store } = fixture(t);
  const result = run(store, "frobnicate");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unknown command frobnicate/);
  assert.doesNotMatch(result.stderr, /no source/);
  assert.match(result.stdout, /rapp-drill.*find work another machine already did/s);
});
