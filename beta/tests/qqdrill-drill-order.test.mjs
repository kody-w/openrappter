import assert from "node:assert/strict";
import test from "node:test";

import { buildFrame } from "../electron/rapp-protocol.mjs";
import {
  dimension,
  drill,
} from "../electron/qqdrill.mjs";

/** A dimension of six frames, distinguished from its twin only by when it ran. */
function dimensionOf(id, ran) {
  const stream = "rappid:@rapp/walk:" + "a".repeat(64);
  const frames = [];
  let prev = null;
  for (let index = 0; index < 6; index += 1) {
    const frame = buildFrame({
      kind: "qqdrill.tick",
      streamId: stream,
      seq: index,
      utc: `2026-08-21T12:00:${String(ran + index).padStart(2, "0")}.000Z`,
      payload: { asserts: { step: index }, requires: {} },
      prev,
      prevWave: null,
    });
    frames.push(frame);
    prev = frame.payload_hash;
  }
  return dimension({ dimension_id: id, clock_key: 1 }, frames);
}

// ROOT CAUSE D — enumeration order and resume.
// Regression tests for docs/QQDRILL-PROTOCOL.md, section
// "How far a drill goes is how long the person waits".

const STREAM = `rappid:@rapp/tile-weather:${"a".repeat(64)}`;
const OTHER_STREAM = `rappid:@rapp/tile-other:${"b".repeat(64)}`;

function utcAt(second) {
  return new Date(Date.UTC(2026, 7, 21, 12, 0, 0) + second * 1000).toISOString();
}

/** Build a chain of frames. Each entry is {asserts}. Same style as beta/tests/qqdrill.test.mjs. */
function chain(entries, { streamId = STREAM, saltAncestry = null, startSeq = 0, ran = 0 } = {}) {
  const frames = [];
  let prev = saltAncestry;
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

/** A pair's identity, sorted, so two results compare as sets of the same pairs. */
function pairIds(found) {
  return found.pairs
    .map((pair) => `${pair.here.seq}->${pair.there.seq}`
      + `#${pair.here.frame_hash.slice(0, 8)}|${pair.there.frame_hash.slice(0, 8)}`)
    .sort();
}

const SIX = [
  { asserts: { sky: "clear" } },
  { asserts: { wind: 5 } },
  { asserts: { temp: 20 } },
  { asserts: { pressure: 1014 } },
  { asserts: { humidity: 61 } },
  { asserts: { visibility: 10 } },
];

/**
 * The same six frames, and a remote dimension that ran the same six payloads at
 * a different time (so every frame_hash differs and every payload_hash matches).
 * `held` chooses the array order the caller happens to store its own frames in.
 */
function fixture(held = (frames) => frames) {
  const frames = chain(SIX);
  return {
    local: dimension({ dimension_id: "local", clock_key: 1 }, held([...frames])),
    remote: dimension({ dimension_id: "remote", clock_key: 1 }, chain(SIX, { ran: 30 })),
  };
}

const oldestFirst = (frames) => frames;
const newestFirst = (frames) => [...frames].reverse();
// A fixed, arbitrary permutation — a caller that merged two logs, say.
const interleaved = (frames) => [frames[3], frames[0], frames[5], frames[1], frames[4], frames[2]];

// ---------------------------------------------------------------------------
// DEFECT D1 — drill() enumerates `local.frames` in the caller's array order
// (`for (const here of local.frames)`), so a budget truncates a prefix that is
// a property of how this machine happened to store its log rather than of the
// frames themselves. Two machines holding the identical SET of frames return
// different pairs for the same budget.
//
// Spec, "How far a drill goes is how long the person waits":
//   "The search is enumerated in a fixed order, so a bigger budget returns a
//    superset of a smaller one."
// Spec, "An identical frame is a fixed point, and it calibrates the rest":
//   "Given the same frames and the same fixed points, two machines that never
//    speak to each other compute the same joined frame".
// ---------------------------------------------------------------------------
test("D1: a budgeted drill enumerates the frame set, not the caller's array order", () => {
  const ascending = fixture(oldestFirst);
  const descending = fixture(newestFirst);
  const mixed = fixture(interleaved);

  const budget = { pairs: 2 };
  const a = drill(ascending.local, ascending.remote, { budget });
  const b = drill(descending.local, descending.remote, { budget });
  const c = drill(mixed.local, mixed.remote, { budget });

  assert.equal(a.hits, 2, "the fixture has more pairs than the budget allows");

  assert.deepEqual(
    pairIds(b),
    pairIds(a),
    `budget ${budget.pairs} returned ${JSON.stringify(pairIds(a))} for a caller holding its`
    + ` frames oldest-first and ${JSON.stringify(pairIds(b))} for a caller holding the very same`
    + " frames newest-first: the enumeration order is the caller's array, not a fixed one",
  );
  assert.deepEqual(
    pairIds(c),
    pairIds(a),
    `budget ${budget.pairs} returned ${JSON.stringify(pairIds(c))} for a caller holding the same`
    + ` frames in a different order, instead of ${JSON.stringify(pairIds(a))}`,
  );

  // The unbudgeted drill already agrees across orders; the budget is what breaks it.
  assert.deepEqual(
    pairIds(drill(descending.local, descending.remote)),
    pairIds(drill(ascending.local, ascending.remote)),
    "an unbudgeted drill must also be order-independent",
  );

  // A fix that canonicalises the order must copy, not sort the caller's array.
  assert.deepEqual(
    descending.local.frames.map((frame) => frame.seq),
    [5, 4, 3, 2, 1, 0],
    "drill must not reorder the caller's own frames",
  );
});

// ---------------------------------------------------------------------------
// DEFECT D2 — `resumeAfter` re-delivers pairs already returned. `skip` is
// compared against `enumerated`, which is only incremented for identities not
// already present in THIS call's `found` map. Pairs skipped by the resume are
// never recorded, so the second lookup lane re-enumerates them from zero and
// hands them back a second time. Walking a drill incrementally therefore does
// not reconstruct the one-shot result.
//
// Spec, "How far a drill goes is how long the person waits":
//   "A drill stopped after two pairs is a smaller drill, not a broken one, and
//    resuming continues from exactly where it stopped rather than starting
//    again."
// ---------------------------------------------------------------------------
test("D2: resumeAfter continues where the drill stopped instead of starting again", () => {
  const { local, remote } = fixture(oldestFirst);
  const oneShot = drill(local, remote);
  assert.ok(oneShot.hits >= 4, "the fixture needs several pairs to walk through");
  assert.equal(oneShot.exhausted, true, "the unbudgeted drill finished");

  const MAX_STEPS = 20;
  const walked = [];
  const trace = [];
  let cursor = 0;
  let steps = 0;
  let finished = false;

  while (steps < MAX_STEPS) {
    steps += 1;
    const step = drill(local, remote, { budget: { pairs: 2, resumeAfter: cursor } });
    trace.push(`step ${steps} (resumeAfter ${cursor}) -> ${JSON.stringify(pairIds(step))}`);
    walked.push(...pairIds(step));
    if (step.exhausted) {
      finished = true;
      break;
    }
    assert.notEqual(
      step.resumeAfter,
      cursor,
      `the resume cursor did not advance past ${cursor}, so the walk can never terminate`,
    );
    cursor = step.resumeAfter;
  }

  assert.equal(
    finished,
    true,
    `the incremental walk did not terminate within ${MAX_STEPS} steps:\n${trace.join("\n")}`,
  );

  const duplicates = [...new Set(walked.filter((id, index) => walked.indexOf(id) !== index))];
  assert.deepEqual(
    duplicates,
    [],
    `resuming re-delivered ${duplicates.length} pair(s) already returned`
    + ` (${JSON.stringify(duplicates)}):\n${trace.join("\n")}`,
  );

  assert.deepEqual(
    [...walked].sort(),
    pairIds(oneShot),
    "walking the drill two pairs at a time must reconstruct the one-shot result exactly",
  );
});

// ---------------------------------------------------------------------------
// DEFECT D3 — `budget.deadlineMs` is only consulted inside the innermost loop
// body, which runs once per candidate partner. On a miss that loop body never
// executes, so the deadline is never read and the drill walks the whole space
// and reports `exhausted: true`. A miss is the expected case, which makes this
// the case where the deadline matters most.
//
// Spec, "How far a drill goes is how long the person waits":
//   "A drill takes a budget — a number of pairs, a deadline — and returns what
//    it had when the budget ran out, saying plainly whether it finished or
//    stopped."
// Spec, "The contract", rule 4: "a run stops at its declared budget rather than
// exceeding it."
// ---------------------------------------------------------------------------
test("D3: a deadline is honoured on a miss, not only on a hit", () => {
  const N = 4000;
  const big = dimension(
    { dimension_id: "big-local", clock_key: 1 },
    chain(Array.from({ length: N }, (_, i) => ({ asserts: { mine: i } }))),
  );
  // Nothing in common: different stream, different clock key, different bytes.
  const stranger = dimension(
    { dimension_id: "big-remote", clock_key: 9 },
    chain(Array.from({ length: N }, (_, i) => ({ asserts: { theirs: i } })), {
      streamId: OTHER_STREAM,
      saltAncestry: "9".repeat(64),
      ran: 5,
    }),
  );

  const startedAt = Date.now();
  const unbudgeted = drill(big, stranger);
  const fullMs = Date.now() - startedAt;
  assert.equal(unbudgeted.hits, 0, "the fixture is a big miss");
  assert.ok(
    fullMs > 5,
    `fixture too small to exercise a deadline: the full miss took only ${fullMs}ms`,
  );

  const stopped = drill(big, stranger, { budget: { deadlineMs: 1 } });

  assert.equal(
    stopped.exhausted,
    false,
    `a 1ms deadline over a ${fullMs}ms miss must stop the search, but the drill searched`
    + ` ${stopped.searched} frames and reported exhausted=true — the deadline was never checked`,
  );
  assert.ok(
    stopped.searched < unbudgeted.searched,
    `the deadlined drill searched ${stopped.searched} frames, the same as the unbudgeted`
    + ` ${unbudgeted.searched}: it blew straight past its deadline`,
  );
});

// ---------------------------------------------------------------------------
// DEFECT D4 — monotonicity under budget. The ladder only holds relative to the
// caller's own array order (defect D1), so the property the spec actually
// claims — that a bigger budget returns a superset, of a search enumerated in a
// FIXED order — does not hold for the frame set. Every rung k must be a subset
// of rung k+1 and of the unbudgeted result, and every rung must name the same
// pairs on any machine holding the same frames.
//
// Spec, "How far a drill goes is how long the person waits":
//   "Monotone. The search is enumerated in a fixed order, so a bigger budget
//    returns a superset of a smaller one. Waiting longer only ever adds paths.
//    It never invalidates a pair already found and never reorders one out of
//    the result."
// ---------------------------------------------------------------------------
test("D4: every budget rung is a subset of the next and of the unbudgeted result", () => {
  const held = fixture(oldestFirst);
  const mirror = fixture(newestFirst);

  const everything = new Set(pairIds(drill(held.local, held.remote)));
  const total = everything.size;
  assert.ok(total >= 4, "the fixture needs several rungs to climb");

  let previous = new Set();
  for (let k = 0; k <= total + 1; k += 1) {
    const budget = { pairs: k };
    const rung = new Set(pairIds(drill(held.local, held.remote, { budget })));

    for (const id of previous) {
      assert.ok(
        rung.has(id),
        `budget ${k} dropped pair ${id} that budget ${k - 1} had already returned`,
      );
    }
    for (const id of rung) {
      assert.ok(
        everything.has(id),
        `budget ${k} returned pair ${id}, which the unbudgeted drill never returns`,
      );
    }

    // Same rung, same frames, a caller that stores them the other way round.
    const other = new Set(pairIds(drill(mirror.local, mirror.remote, { budget })));
    assert.deepEqual(
      [...other].sort(),
      [...rung].sort(),
      `rung ${k} is ${JSON.stringify([...rung].sort())} for one caller and`
      + ` ${JSON.stringify([...other].sort())} for another holding the identical frame set:`
      + " the monotone ladder is built on the caller's array order, not a fixed enumeration",
    );

    previous = rung;
  }
});

// D5 — added 2026-08-21 after a second review found the cursor could move
// BACKWARD under a deadline and that a fired fan-out cap pinned exhausted:false
// forever, freezing the walk. The cursor is now a position in a fixed
// enumeration, counting every unique pair whether skipped or stored, and a pair
// is marked seen only once it has been ACCOUNTED for — so a budget stop leaves
// the position untouched rather than half-consuming it.
//
// The property worth locking in is the one a caller relies on: walking a drill
// in small steps must reconstruct the one-shot result exactly. Not a superset,
// not a prefix repeated — the same set, each pair once.
test("D5. an incremental walk reconstructs the one-shot result exactly", () => {
  const local = dimensionOf("walk-local", 0);
  const remote = dimensionOf("walk-remote", 30);

  const oneShot = drill(local, remote);
  assert.ok(oneShot.hits >= 4, "the fixture must produce enough pairs to walk");
  assert.equal(oneShot.exhausted, true, "an unbudgeted drill finishes");

  const identify = (pair) => `${pair.here.frame_hash}|${pair.there.frame_hash}`;
  const walked = [];
  let cursor = 0;
  let steps = 0;

  while (steps < 50) {
    steps += 1;
    const page = drill(local, remote, { budget: { pairs: 2, resumeAfter: cursor } });
    walked.push(...page.pairs.map(identify));
    if (page.exhausted) break;
    assert.ok(page.resumeAfter > cursor, "the cursor must advance, never stall or move back");
    cursor = page.resumeAfter;
  }

  assert.ok(steps < 50, "the walk must terminate rather than cycle");
  assert.equal(
    walked.length,
    new Set(walked).size,
    "no pair may be delivered twice across the walk",
  );
  assert.deepEqual(
    [...new Set(walked)].sort(),
    oneShot.pairs.map(identify).sort(),
    "the walk must find exactly what a single unbudgeted drill finds",
  );
});

// A fan-out cap elides candidates at one coordinate. That is a cap doing its
// job, not the budgeted walk stopping early, and reporting it as exhausted:false
// made that flag mean nothing — a caller could never tell "I ran out of
// patience" from "one coordinate had a lot of twins".
test("D6. a fan-out cap is reported separately from stopping early", () => {
  const local = dimensionOf("cap-local", 0);
  const remote = dimensionOf("cap-remote", 30);

  const capped = drill(local, remote, { fanoutCap: 1 });
  assert.equal(capped.exhausted, true, "the walk reached the end of the search space");
  const wide = drill(local, remote);
  assert.ok(
    capped.hits <= wide.hits,
    "a cap can only reduce what was examined, never increase it",
  );
  for (const entry of capped.capped) {
    assert.ok(entry.matched > entry.examined, "a capped entry names what it left unexamined");
  }
});
