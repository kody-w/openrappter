import assert from "node:assert/strict";
import test from "node:test";

import { buildFrame } from "../electron/rapp-protocol.mjs";
import {
  alignment,
  dimension,
  drill,
  fixedPoints,
  runsFrom,
} from "../electron/qqdrill.mjs";

// Regression tests for rapp-qqdrill/1.0 lane bucketing.
//
// runsFrom() and alignment() both compute `offset = there.seq - ratio * here.seq`
// in binary64 and then bucket the diagonal on `offset.toFixed(9)`. Every test
// below feeds those functions fixed points that lie on ONE exact diagonal —
// there.seq * hereClock === thereClock * here.seq for every pin, checked by hand
// in the fixture comment — and asserts they are reported as one diagonal.

const STREAM = "rappid:@rapp/tile-weather:" + "a".repeat(64);

function utcAt(second) {
  return `2026-08-21T12:00:${String(second).padStart(2, "0")}.000Z`;
}

/**
 * Build a chain of frames at explicit ticks. Each entry is {seq, asserts}.
 * Ancestry threads through prev, so two dimensions built from the same payloads
 * at different wall-clock times get identical payload_hash and different
 * frame_hash — which is what makes them fixed points.
 */
function chainAt(entries, { streamId = STREAM, ran = 0 } = {}) {
  let prev = null;
  return entries.map((entry, index) => {
    const frame = buildFrame({
      kind: "qqdrill.tick",
      streamId,
      seq: entry.seq,
      utc: utcAt(ran + index),
      payload: { asserts: entry.asserts, requires: {} },
      prev,
      prevWave: null,
    });
    prev = frame.payload_hash;
    return frame;
  });
}

function pinsOf(local, remote) {
  return fixedPoints(drill(local, remote).pairs);
}

function describeLanes(points, hereClock, thereClock) {
  const ratio = Number(thereClock) / Number(hereClock);
  const lanes = new Map();
  for (const point of points) {
    const lane = (point.there.seq - ratio * point.here.seq).toFixed(9);
    lanes.set(lane, [...(lanes.get(lane) || []), `${point.here.seq}->${point.there.seq}`]);
  }
  return [...lanes.entries()].map(([lane, pins]) => `${lane}: ${pins.join(",")}`).join("  |  ");
}

// ---------------------------------------------------------------------------
// Fixture A: a decimal cadence pair whose ratio is a whole number, 3, that
// binary64 cannot represent exactly (2.1 / 0.7 === 3.0000000000000004).
// The other dimension ran three ticks for each of ours, so the pins are
//   here 0,1,2,3,4  <->  there 0,3,6,9,12
// and every one satisfies there.seq * 0.7 === 3 * here.seq * 0.7 exactly:
// one diagonal, offset 0, no gaps in `here`.
// ---------------------------------------------------------------------------
function decimalCadence() {
  const shared = [
    { sky: "clear" },
    { wind: 5 },
    { temp: 20 },
    { pressure: 1014 },
    { rain: false },
  ];
  const local = dimension(
    { dimension_id: "local", clock_key: 0.7 },
    chainAt(shared.map((asserts, seq) => ({ seq, asserts }))),
  );
  // Thirteen ticks at the faster cadence: every third repeats one of ours.
  const remoteEntries = [];
  for (let seq = 0; seq <= 12; seq += 1) {
    remoteEntries.push(seq % 3 === 0
      ? { seq, asserts: shared[seq / 3] }
      : { seq, asserts: { between: seq } });
  }
  const remote = dimension(
    { dimension_id: "remote", clock_key: 2.1 },
    chainAt(remoteEntries, { ran: 30 }),
  );
  return { local, remote };
}

// DEFECT: runsFrom() buckets a diagonal on the binary64 string
// `offset.toFixed(9)`, so the rounding error in ratio 2.1/0.7 = 3.0000000000000004
// makes the pin at here=0 (offset +0) land in lane "0.000000000" while every
// later pin (offset -4.4e-16) lands in lane "-0.000000000". One diagonal is
// reported as two short runs.
// SPEC (QQDRILL-PROTOCOL.md): "A diagonal is a constant offset: the other
// dimension's tick advances by the clock ratio for each of yours. Grouping the
// fixed points by that offset separates the paths exactly."
test("a decimal clock ratio must not split one diagonal into two runs", () => {
  const { local, remote } = decimalCadence();
  const points = pinsOf(local, remote);
  assert.equal(points.length, 5, "the fixture pins all five ticks");

  const runs = runsFrom(points, local, remote);
  assert.equal(
    runs.length,
    1,
    `one diagonal, so one run — got ${runs.length} of lengths `
    + `[${runs.map((run) => run.length).join(", ")}]; lanes: `
    + describeLanes(points, 0.7, 2.1),
  );
  assert.equal(runs[0].length, 5, "the run reached all five matching ticks");
  assert.equal(runs[0].startHere, 0);
  assert.equal(runs[0].endHere, 4);
});

// DEFECT: alignment() buckets pins with the same `offset.toFixed(9)` string, so
// the same 2.1/0.7 rounding error reports two paths and a non-empty
// `disagreeing` for two dimensions that coincide at every single pin.
// SPEC (QQDRILL-PROTOCOL.md): "disagreeing fixed points are themselves a
// result: two dimensions that coincide at one tick and contradict at another
// have diverged in a way the trace should record."
test("a decimal clock ratio must not report agreeing pins as disagreeing", () => {
  const { local, remote } = decimalCadence();
  const points = pinsOf(local, remote);

  const align = alignment(points, local, remote);
  assert.equal(align.ok, true);
  assert.equal(
    align.disagreeing.length,
    0,
    `every pin sits on the same diagonal, so none disagree; lanes: `
    + describeLanes(points, 0.7, 2.1),
  );
  assert.equal(align.paths.length, 1, "one diagonal is one path");
  assert.equal(align.pins.length, 5, "all five pins belong to it");
});

// ---------------------------------------------------------------------------
// Fixture B: whole-number cadences 7 and 9, whose ratio 9/7 is not
// representable in binary64. Nine of their ticks per seven of ours, so the pins
//   here 0,7,14,21  <->  there 0,9,18,27
// all satisfy there.seq * 7 === 9 * here.seq exactly: one diagonal, offset 0.
// ---------------------------------------------------------------------------
function coprimeCadence() {
  const localEntries = [];
  for (let seq = 0; seq <= 21; seq += 1) {
    localEntries.push(seq % 7 === 0
      ? { seq, asserts: { mark: seq / 7 } }
      : { seq, asserts: { slow: seq } });
  }
  const remoteEntries = [];
  for (let seq = 0; seq <= 27; seq += 1) {
    remoteEntries.push(seq % 9 === 0
      ? { seq, asserts: { mark: seq / 9 } }
      : { seq, asserts: { fast: seq } });
  }
  return {
    local: dimension({ dimension_id: "seven", clock_key: 7 }, chainAt(localEntries)),
    remote: dimension({ dimension_id: "nine", clock_key: 9 }, chainAt(remoteEntries, { ran: 30 })),
  };
}

// DEFECT: signed zero decides the lane. With ratio 9/7 the pins at here=0,7,14
// compute an offset of exactly +0 and bucket as "0.000000000", while the pin at
// here=21 computes -3.55e-15 and buckets as "-0.000000000". Two strings, one
// number: the sign of a zero splits a diagonal that the arithmetic says is
// single.
// SPEC (QQDRILL-PROTOCOL.md): "the placement of the finer frames inside the
// coarse interval is arithmetic rather than a judgement" — and "Every further
// fixed point tightens the registration".
test("an offset that computes to negative zero must bucket with positive zero", () => {
  const { local, remote } = coprimeCadence();
  const points = pinsOf(local, remote);
  assert.equal(points.length, 4, "the fixture pins here 0,7,14,21");

  const align = alignment(points, local, remote);
  assert.equal(align.ok, true);
  assert.equal(
    align.paths.length,
    1,
    `+0 and -0 are the same offset, so this is one path; lanes: `
    + describeLanes(points, 7, 9),
  );
  assert.equal(align.pins.length, 4, "every pin tightens the one registration");
  assert.equal(align.disagreeing.length, 0, "nothing here disagrees");
});

// ---------------------------------------------------------------------------
// Fixture C: cadences 5 and 7, pins at
//   here 0                  <-> there 0
//   here 100000000000000    <-> there 140000000000000
// Both satisfy there.seq * 5 === 7 * here.seq exactly (1e14 * 7 === 1.4e14 * 5),
// and both seqs are safe integers, so RAPP/1 accepts them. One diagonal,
// offset 0.
// ---------------------------------------------------------------------------
function longRunningCadence() {
  const far = 100000000000000;
  const local = dimension(
    { dimension_id: "five", clock_key: 5 },
    chainAt([
      { seq: 0, asserts: { epoch: "start" } },
      { seq: far, asserts: { epoch: "much-later" } },
    ]),
  );
  const remote = dimension(
    { dimension_id: "seven", clock_key: 7 },
    chainAt([
      { seq: 0, asserts: { epoch: "start" } },
      { seq: (far / 5) * 7, asserts: { epoch: "much-later" } },
    ], { ran: 30 }),
  );
  return { local, remote, far };
}

// DEFECT: `ratio * here.seq` loses precision at large seq. 7/5 is not exact in
// binary64, so 1.4 * 1e14 comes back 0.015625 short of 140000000000000 and the
// far pin buckets as "0.015625000" while the pin at here=0 buckets as
// "0.000000000". The two dimensions coincide exactly at both ticks; the drill
// reports them as two paths that disagree.
// SPEC (QQDRILL-PROTOCOL.md): "Two frames with identical bytes and different
// ancestries are a fixed point — a place where the two lines are known to
// coincide exactly."
test("a large tick must not lose the diagonal to float precision", () => {
  const { local, remote, far } = longRunningCadence();
  const points = pinsOf(local, remote);
  assert.equal(points.length, 2, "both epochs pin");

  const align = alignment(points, local, remote);
  assert.equal(align.ok, true);
  assert.equal(align.ratio, 7 / 5);
  assert.equal(
    align.paths.length,
    1,
    `both pins lie on there.seq = 7/5 * here.seq, so this is one path; lanes: `
    + describeLanes(points, 5, 7),
  );
  assert.equal(align.disagreeing.length, 0, "an exact coincidence cannot disagree");
  assert.ok(
    Math.abs(align.offset) < 1e-9,
    `the diagonal through the origin has offset 0, got ${align.offset}`,
  );
  assert.equal(align.pins.length, 2, `both pins belong to it, at here 0 and ${far}`);
});

// ---------------------------------------------------------------------------
// Fixture D: the same cadence declared two ways — clock_key "1" and clock_key 1.
// ---------------------------------------------------------------------------

// DEFECT: clock_key is read two different ways. quantumKey() copies the raw
// manifest value into the coordinate, so the string "1" and the number 1 render
// as different coordinates and never pair on position; alignment() and
// runsFrom() coerce with Number(), so the same two manifests are treated as one
// cadence at ratio 1. One of the two must be wrong, and a clock key that cannot
// be used as a coordinate should be refused with a reason rather than silently
// coerced.
// SPEC (QQDRILL-PROTOCOL.md): "A quantum key is a composite coordinate, and
// matching is exact equality of its components", one of which is "the cadence
// the dimension ran at".
test("a clock key means the same thing to the coordinate and to the alignment", () => {
  const shared = [{ sky: "clear" }, { wind: 5 }, { temp: 20 }];
  const entries = shared.map((asserts, seq) => ({ seq, asserts }));

  let local;
  let remote;
  try {
    local = dimension({ dimension_id: "text-clock", clock_key: "1" }, chainAt(entries));
    remote = dimension({ dimension_id: "number-clock", clock_key: 1 }, chainAt(entries, { ran: 30 }));
  } catch (error) {
    // Refusing a string clock key outright is a correct answer, provided it says why.
    assert.ok(String(error.message).trim().length > 0, "a refused clock key must carry a reason");
    return;
  }

  // Half one: does the composite coordinate treat the two manifests as the same
  // cadence? Probe the position lookup only, so a digest match cannot mask it.
  let coordinateSaysSame;
  try {
    coordinateSaysSame = drill(local, remote, {
      lookups: [["rappid", "clock", "tick"]],
    }).hits > 0;
  } catch {
    coordinateSaysSame = false; // refused == not the same cadence
  }

  // Half two: does the alignment treat them as the same cadence?
  let alignmentSaysSame;
  try {
    const align = alignment(pinsOf(local, remote), local, remote);
    alignmentSaysSame = align.ok === true && align.ratio === 1;
  } catch {
    alignmentSaysSame = false;
  }

  assert.equal(
    coordinateSaysSame,
    alignmentSaysSame,
    `clock_key "1" and clock_key 1 must be one cadence everywhere or neither: `
    + `the coordinate pairs them = ${coordinateSaysSame}, `
    + `alignment calls them ratio 1 = ${alignmentSaysSame}`,
  );
});
