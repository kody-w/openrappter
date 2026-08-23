import assert from "node:assert/strict";
import test from "node:test";

import { buildFrame } from "../electron/qqdrill-deps.mjs";
import {
  alignment,
  compatibility,
  dimension,
  drill,
  fixedPoints,
  makeLine,
  zoom,
} from "../electron/qqdrill.mjs";

// ROOT CAUSE C — zoom() applies no backward-fidelity check, and picks the coarse
// frame a finer frame "refines" with Math.floor(here) plus a silent fallback to
// the last frame in the span. Three ways that goes wrong, one test each.

const STREAM = "rappid:@rapp/tile-weather:" + "a".repeat(64);

function utcAt(second) {
  return `2026-08-21T12:00:${String(second).padStart(2, "0")}.000Z`;
}

/** Build a chain of frames. Each entry is {asserts, requires}. */
function chain(entries, { streamId = STREAM, saltAncestry = null, startSeq = 0, ran = 0 } = {}) {
  const frames = [];
  let prev = saltAncestry;
  entries.forEach((entry, index) => {
    const frame = buildFrame({
      kind: "qqdrill.tick",
      streamId,
      seq: startSeq + index,
      utc: utcAt(ran + startSeq + index),
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

const seqOf = (line, frameHash) =>
  line.frames.find((frame) => frame.frame_hash === frameHash)?.seq;

const accepted = (zoomed) => (zoomed.ok ? zoomed.refined : []);

const wasRefused = (zoomed, frame) =>
  zoomed.ok && zoomed.refused.some((entry) => entry.frame === frame.frame_hash);

const wasRefined = (zoomed, frame) =>
  accepted(zoomed).some((entry) => entry.frame.frame_hash === frame.frame_hash);

// DEFECT C-1: zoom() checks a finer frame only against the coarse frame it
// covers, never against the line's descendants, so a frame the fold itself would
// refuse is accepted as a refinement.
//
// QQDRILL-PROTOCOL.md: "The finer frames refine an interval; they may not
// contradict the coarse frame they refine, or backward fidelity refuses them."
// And backward fidelity is defined over the whole downstream line: "a frame is
// assimilated only if it contradicts nothing downstream of the current frame."
/** A chain whose only distinguishing feature from its twin is when it ran. */
function chainAt(entries, ran) {
  const stream = "rappid:@rapp/zoom:" + "a".repeat(64);
  const frames = [];
  let prev = null;
  entries.forEach((entry, index) => {
    const frame = buildFrame({
      kind: "qqdrill.tick",
      streamId: stream,
      seq: index,
      utc: `2026-08-21T12:00:${String(ran + index).padStart(2, "0")}.000Z`,
      payload: { asserts: entry.asserts || {}, requires: entry.requires || {} },
      prev,
      prevWave: null,
    });
    frames.push(frame);
    prev = frame.payload_hash;
  });
  return frames;
}

test("C-1: a finer frame that contradicts a descendant of the span is refused", () => {
  // The local line: two quiet coarse ticks, then a descendant built on sky=clear.
  const line = makeLine(chain([
    { asserts: { phase: "morning" } },
    { asserts: { phase: "noon" } },
    { asserts: { plan: "picnic" }, requires: { sky: "clear" } },
  ]));
  const coarse = dimension({ dimension_id: "coarse", clock_key: 1 }, line.frames);

  // Twice the clock. Ticks 0 and 2 repeat our bytes, so the clocks are pinned.
  // Tick 1 sits at here=0.5, inside a coarse frame that says nothing about the
  // sky — but the picnic downstream of the span requires sky=clear.
  const fine = dimension({ dimension_id: "fine", clock_key: 2 }, chain(
    [
      { asserts: { phase: "morning" } },
      { asserts: { sky: "storm" } },
      { asserts: { phase: "noon" } },
    ],
    { ran: 30 },
  ));
  const poison = fine.frames[1];

  const align = alignment(fixedPoints(drill(coarse, fine).pairs), coarse, fine);
  assert.equal(align.ok, true, "the identical frames pin the two clocks");
  assert.equal(align.ratio, 2);

  // The fold's own verdict on this frame, for the record: refused.
  const verdict = compatibility(poison, line);
  assert.equal(verdict.ok, false, "the picnic downstream requires sky=clear");
  assert.equal(verdict.contradicts[0].key, "sky");

  const zoomed = zoom({ start: 0, end: 1 }, fine.frames, align, line);
  assert.equal(zoomed.ok, true);
  assert.equal(
    wasRefined(zoomed, poison),
    false,
    "zoom must not accept a frame the line's descendants refuse",
  );
  assert.equal(wasRefused(zoomed, poison), true, "and must record the refusal");
  assert.ok(
    zoomed.refused
      .find((entry) => entry.frame === poison.frame_hash)
      .contradicts.some((clash) => clash.key === "sky"),
    "with what it contradicted recorded",
  );
  // The frames that contradict nothing still refine, so this is a refusal and
  // not zoom giving up on the span.
  assert.equal(wasRefined(zoomed, fine.frames[0]), true);
  assert.equal(wasRefined(zoomed, fine.frames[2]), true);
});

// DEFECT C-2: the covering frame is chosen by `coarse.find(c => Math.floor(here)
// === c.seq) || coarse[coarse.length - 1]`. When the line has no frame at that
// tick the fallback silently blames the LAST frame of the span — a frame that
// begins after the finer frame it is said to refine — and that frame's asserts
// decide the verdict.
//
// QQDRILL-PROTOCOL.md: "they may not contradict the coarse frame they refine, or
// backward fidelity refuses them" — the coarse frame they refine, not whichever
// frame happens to be last.
test("C-2: a finer frame is never attributed to a coarse frame that begins after it", () => {
  // A local line that recorded no frame at tick 2: seq 0, 1, then 3.
  const head = chain([
    { asserts: { phase: "start" } },
    { asserts: { sky: "clear" } },
  ]);
  const tail = chain([{ asserts: { phase: "tail" } }], {
    startSeq: 3,
    saltAncestry: head[1].payload_hash,
  });
  const line = makeLine([...head, ...tail]);
  const coarse = dimension({ dimension_id: "coarse", clock_key: 1 }, line.frames);

  const fine = dimension({ dimension_id: "fine", clock_key: 2 }, chain(
    [
      { asserts: { phase: "start" } }, // pins the clocks at here=0
      { asserts: { gust: 1 } },
      { asserts: { gust: 2 } },
      { asserts: { gust: 3 } },
      { asserts: { gust: 4 } },
      { asserts: { sky: "storm" } }, // here = 2.5
    ],
    { ran: 30 },
  ));
  const poison = fine.frames[5];

  const align = alignment(fixedPoints(drill(coarse, fine).pairs), coarse, fine);
  assert.equal(align.ok, true);
  assert.equal(align.ratio, 2);
  assert.equal(align.offset, 0);

  // The flip, stated before the call: here=2.5 falls inside the interval the
  // seq-1 frame opened (nothing was recorded at tick 2), and that frame says
  // sky=clear. The seq-3 frame the fallback reaches for says nothing about sky,
  // so attributing the finer frame to it turns a refusal into an acceptance.
  assert.equal(line.frames[1].payload.asserts.sky, "clear");
  assert.equal("sky" in line.frames[2].payload.asserts, false);

  const zoomed = zoom({ start: 0, end: 3 }, fine.frames, align, line);
  assert.equal(zoomed.ok, true);

  assert.equal(
    wasRefined(zoomed, poison),
    false,
    "sky=storm contradicts the coarse frame that actually covers here=2.5",
  );
  for (const entry of accepted(zoomed)) {
    const covering = seqOf(line, entry.refines);
    assert.notEqual(covering, undefined, "a refinement names a frame of this line");
    assert.ok(
      covering <= entry.at,
      `a finer frame at ${entry.at} cannot refine the coarse frame at seq ${covering}`,
    );
  }
});

// DEFECT C-3: `here = (frame.seq - align.offset) / align.ratio` is binary
// floating point. With a clock ratio and phase offset that are not representable
// the placement lands a hair below the tick it belongs to, Math.floor drops it
// into the previous coarse interval, and it is judged against the wrong frame.
//
// QQDRILL-PROTOCOL.md: "The clock keys relate by ratio and a fixed point pins
// the phase, so the placement of the finer frames inside the coarse interval is
// arithmetic rather than a judgement."
test("C-3: a non-representable clock ratio still places a finer frame in its own interval", () => {
  // Coarse clock 3, finer clock 4: ratio 4/3, and the pin puts the phase at
  // 8/3 — neither is representable in binary64.
  const line = makeLine(chain([
    { asserts: { sky: "storm" } },
    { asserts: { sky: "clear" } },
    { asserts: { phase: "late" } },
  ]));
  const coarse = dimension({ dimension_id: "coarse", clock_key: 3 }, line.frames);

  const fine = dimension({ dimension_id: "fine", clock_key: 4 }, chain(
    [
      { asserts: { gust: 0 } },
      { asserts: { gust: 1 } },
      { asserts: { gust: 2 } },
      { asserts: { gust: 3 } },
      { asserts: { sky: "clear" } }, // byte-identical to our tick 1: the pin
      { asserts: { gust: 5 } },
    ],
    { ran: 30 },
  ));
  const twin = fine.frames[4];

  const points = fixedPoints(drill(coarse, fine).pairs);
  assert.equal(points.length, 1, "one fixed point: our tick 1 and their tick 4");
  const align = alignment(points, coarse, fine);
  assert.equal(align.ok, true);
  assert.deepEqual(
    align.pins.map((pin) => [pin.here, pin.there]),
    [[1, 4]],
    "the phase is pinned at our tick 1",
  );

  const zoomed = zoom({ start: 0, end: 2 }, fine.frames, align, line);
  assert.equal(zoomed.ok, true);

  // The pinned frame is the one frame whose placement is known exactly: it IS
  // our tick 1, byte for byte. It must refine that frame and nothing else.
  const placed = accepted(zoomed).find((entry) => entry.frame.frame_hash === twin.frame_hash);
  assert.ok(placed, `the frame that pins the phase was refused: ${JSON.stringify(zoomed.refused)}`);
  assert.ok(
    Math.abs(placed.at - 1) < 1e-9,
    `their tick 4 is our tick 1, but it placed at ${placed.at}`,
  );
  assert.equal(
    seqOf(line, placed.refines),
    1,
    "it refines the coarse frame it is identical to, not the one before it",
  );
  assert.equal(
    wasRefused(zoomed, twin),
    false,
    "a frame asserting exactly what the frame it refines asserts cannot contradict it",
  );
});

// C-4 — added 2026-08-21 after a second review found finer frames vanishing.
// A span of coarse ticks [start, end] covers the INTERVAL from start up to just
// before end+1. Bounding the placement at exactly `end` dropped every finer
// frame sitting BETWEEN two coarse ticks — into neither refined nor refused,
// which is the one outcome a fold may never produce. Zooming exists precisely
// to bring in the frames between your own ticks.
test("C-4: every finer frame inside the span is accounted for, none silently dropped", () => {
  const coarse = dimension({ dimension_id: "coarse", clock_key: 1 }, chainAt([
    { asserts: { sky: "clear" } },
    { asserts: { sky: "clear" } },
  ], 0));
  // Ten times the cadence: their ticks 0..10 land on our 0.0 .. 1.0, so nine of
  // them sit strictly between our tick 0 and our tick 1.
  const fine = dimension({ dimension_id: "fine", clock_key: 10 }, chainAt(
    Array.from({ length: 11 }, (unused, index) => (
      index % 10 === 0 ? { asserts: { sky: "clear" } } : { asserts: { gust: index } }
    )),
    30,
  ));

  const points = fixedPoints(drill(coarse, fine).pairs);
  const align = alignment(points, coarse, fine);
  assert.equal(align.ok, true, "the identical frames pin the two clocks");

  const line = makeLine(coarse.frames);
  const zoomed = zoom({ start: 0, end: 0 }, fine.frames, align, line);
  assert.equal(zoomed.ok, true);

  const inSpan = fine.frames.filter((frame) => frame.seq >= 0 && frame.seq < 10);
  assert.equal(
    zoomed.refined.length + zoomed.refused.length,
    inSpan.length,
    "every finer frame in the interval must be either refined or refused — a frame "
      + "that is neither has vanished, and the fold cannot account for it",
  );
  assert.ok(zoomed.refined.length > 1, "the frames between our ticks are the point of zooming");
});
