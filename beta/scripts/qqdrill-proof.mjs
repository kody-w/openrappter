#!/usr/bin/env node
// rapp-qqdrill/1.0 — drive local instant transmission end to end and print what
// actually happened at each step. Nothing here is mocked: it builds two real
// dimensions of RAPP/1 frames, drills them, folds what may be folded, refuses
// what may not, and zooms a span using a finer clock.
//
//   node beta/scripts/qqdrill-proof.mjs
//
// See ../docs/QQDRILL-PROTOCOL.md.

import { buildFrame } from "../electron/qqdrill-deps.mjs";
import {
  alignment,
  assimilate,
  dimension,
  drill,
  fixedPoints,
  makeLine,
  placeThere,
  pull,
  runsFrom,
  zoom,
} from "../electron/qqdrill.mjs";

const STREAM = "rappid:@rapp/tile-forecast:" + "a".repeat(64);

const bold = (text) => `\x1b[1m${text}\x1b[0m`;
const dim = (text) => `\x1b[2m${text}\x1b[0m`;
const green = (text) => `\x1b[32m${text}\x1b[0m`;
const red = (text) => `\x1b[31m${text}\x1b[0m`;
const short = (hash) => (hash ? hash.slice(0, 8) : "—");

function step(number, title) {
  console.log(`\n${bold(`${number}. ${title}`)}`);
}

function utcAt(second) {
  const minute = String(Math.floor(second / 60)).padStart(2, "0");
  return `2026-08-21T12:${minute}:${String(second % 60).padStart(2, "0")}.000Z`;
}

function chain(entries, { ran = 0, streamId = STREAM } = {}) {
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

// ---------------------------------------------------------------------------

console.log(bold("\nrapp-qqdrill/1.0 — local instant transmission\n"));

// Here: what this machine lived through. There: the same situation as it ran in
// another dimension, at a different wall-clock time, carrying facts we never saw.
const hereEntries = [
  { asserts: { sky: "clear" } },
  { asserts: { wind: 5 } },
  { asserts: { temp: 20 } },
  { asserts: { plan: "picnic" }, requires: { sky: "clear" } },
];
const thereEntries = [
  { asserts: { sky: "clear" } },
  { asserts: { wind: 5 } },
  { asserts: { temp: 20 } },
  { asserts: { pressure: 1014 } },
  { asserts: { humidity: 60 } },
];

const here = dimension({ dimension_id: "this-device", clock_key: 1 }, chain(hereEntries));
const there = dimension({ dimension_id: "the-commons", clock_key: 1 }, chain(thereEntries, { ran: 600 }));

step(1, "Two dimensions");
console.log(`   here  ${here.manifest.dimension_id.padEnd(12)} ${here.frames.length} frames, clock ${here.manifest.clock_key}`);
console.log(`   there ${there.manifest.dimension_id.padEnd(12)} ${there.frames.length} frames, clock ${there.manifest.clock_key}`);

step(2, "Drill — finds pairs, changes nothing");
const found = drill(here, there);
console.log(`   searched ${found.searched} coordinates, ${found.hits} hit${found.hits === 1 ? "" : "s"}`);
for (const pair of found.pairs) {
  console.log(`   ${dim("pair")} tick ${pair.here.seq} ↔ ${pair.there.seq}  ${short(pair.here.frame_hash)} ↔ ${short(pair.there.frame_hash)}  ${dim(`via ${pair.via.map((v) => v.join("+")).join(", ")}`)}`);
}

step(3, "Fixed points — identical bytes, different ancestry");
const points = fixedPoints(found.pairs);
for (const point of points) {
  console.log(`   ${green("pinned")} tick ${point.here.seq}  payload ${short(point.here.payload_hash)}  ${dim(`frames differ: ${short(point.here.frame_hash)} vs ${short(point.there.frame_hash)}`)}`);
}
if (!points.length) console.log(`   ${red("none")} — nothing pins the two dimensions together`);

step(4, "Runs — fidelity accrues with length");
for (const run of runsFrom(points, here, there)) {
  console.log(`   ticks ${run.startHere}–${run.endHere}: length ${run.length}, substance ${run.substance}${run.boundary ? dim(`  (ended at tick ${run.boundary.at}: ${run.boundary.reason})`) : ""}`);
}

step(5, "Alignment — the clock offset comes from the pins");
const align = alignment(points, here, there);
if (!align.ok) {
  console.log(`   ${red("refused")} ${align.reason}`);
} else {
  console.log(`   ratio ${align.ratio}, offset ${align.offset}, ${align.pins.length} pins, ${align.disagreeing.length} disagreeing`);
  console.log(`   ${dim(`our tick 3 places at their tick ${placeThere(align, 3)} — by arithmetic, not judgement`)}`);
}

step(6, "Pull — the hit pulls the whole frame");
const pulled = points.length ? pull(there, points[0].there) : null;
if (pulled) {
  console.log(`   ${short(pulled.frame_hash)} kind=${pulled.kind} seq=${pulled.seq} utc=${pulled.utc}`);
  console.log(`   ${dim(`asserts ${JSON.stringify(pulled.payload.asserts)}`)}`);
}

step(7, "Assimilate — compatible frames only, refused whole");
const line = makeLine(here.frames);
// Everything the other dimension holds past our last pin is what we never saw.
const incoming = there.frames.filter((frame) => frame.seq >= 3);
// And one frame that contradicts a descendant of ours: our tick 3 requires
// sky=clear, so a frame asserting sky=storm cannot be folded in.
const hostile = chain([{ asserts: { sky: "storm", gust: 40 } }], { ran: 900 })[0];

const before = line.head;
const result = assimilate(line, [...incoming, hostile]);
for (const frame of result.merged) {
  console.log(`   ${green("merged  ")} ${short(frame.frame_hash)} ${JSON.stringify(frame.payload.asserts)}`);
}
for (const entry of result.refused) {
  const why = entry.contradicts[0];
  console.log(`   ${red("refused ")} ${short(entry.frame)} — ${why.key}: line ${why.withinFold ? "already established" : "requires"} ${JSON.stringify(why.required ?? why.established)}, frame asserts ${JSON.stringify(why.asserted)}`);
}
console.log(`   HEAD ${short(before)} → ${short(result.head)}  ${dim("the line continues from the joined frame")}`);
if (result.joined) {
  console.log(`   ${dim(`join asserts ${JSON.stringify(result.joined.payload.asserts)}`)}`);
  console.log(`   ${dim(`join names ${result.joined.payload.assimilated.length} assimilated frame(s); ancestry only grew (${line.frames.length} → ${result.line.frames.length})`)}`);
}

step(8, "Retroactive zoom — a finer clock is resolution on our own past");
const fine = dimension({ dimension_id: "fine-grained", clock_key: 4 }, chain([
  { asserts: { sky: "clear" } },
  { asserts: { gust: 1 } },
  { asserts: { gust: 2 } },
  { asserts: { gust: 3 } },
  { asserts: { wind: 5 } },
], { ran: 1200 }));

const finePoints = fixedPoints(drill(here, fine).pairs);
const fineAlign = alignment(finePoints, here, fine);
const zoomed = zoom({ start: 0, end: 1 }, fine.frames, fineAlign, line);
if (!zoomed.ok) {
  console.log(`   ${red("refused")} ${zoomed.reason}`);
} else {
  console.log(`   ratio ${fineAlign.ratio} — they hold ${fineAlign.ratio} frames per one of ours`);
  console.log(`   resolution over ticks 0–1: ${zoomed.resolution.before} → ${green(String(zoomed.resolution.after))} frames`);
  for (const item of zoomed.refined) {
    console.log(`   ${green("refines ")} our tick ${item.at} ${JSON.stringify(item.frame.payload.asserts)}`);
  }
  for (const item of zoomed.refused) {
    console.log(`   ${red("refused ")} ${short(item.frame)} — would contradict ${item.contradicts[0].key}`);
  }
}

const unpinned = zoom({ start: 40, end: 50 }, fine.frames, fineAlign, line);
console.log(`   ${red("refused")} a span with no pin in it: ${unpinned.reason}`);

console.log(`\n${dim("The drill found. The fold decided. Nothing the commons sent could invalidate anything this device already established.")}\n`);
