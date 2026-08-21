import assert from "node:assert/strict";
import test from "node:test";

import { buildFrame, verifyFrame } from "../electron/qqdrill-deps.mjs";
import {
  COMPONENTS,
  PROTOCOL,
  alignment,
  assimilate,
  compatibility,
  dimension,
  drill,
  fixedPoints,
  isSubstantive,
  keyString,
  makeLine,
  placeThere,
  pull,
  quantumKey,
  runsFrom,
  zoom,
} from "../electron/qqdrill.mjs";

// rapp-qqdrill/1.0 — one test per proof obligation in docs/QQDRILL-PROTOCOL.md.
// The drill finds pairs and changes nothing; the fold decides what may join.

const STREAM = "rappid:@rapp/tile-weather:" + "a".repeat(64);
const OTHER_STREAM = "rappid:@rapp/tile-weather:" + "b".repeat(64);

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

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}

// Two dimensions that ran the same situation. Ticks 0-2 are byte-identical
// (different ancestry, because the lines started differently); tick 3 diverges.
function twoDimensions() {
  const shared = [
    { asserts: { sky: "clear" } },
    { asserts: { wind: 5 } },
    { asserts: { temp: 20 } },
  ];
  const local = dimension(
    { dimension_id: "local", clock_key: 1 },
    chain([...shared, { asserts: { note: "local-only" } }]),
  );
  const remote = dimension(
    { dimension_id: "remote", clock_key: 1 },
    // Same payloads, ancestry salted so every frame_hash differs.
    chain([...shared, { asserts: { note: "remote-only" } }], { ran: 30 }),
  );
  return { local, remote };
}

test("the frames these tests build are real RAPP/1 frames", () => {
  const [first] = chain([{ asserts: { sky: "clear" } }]);
  const [ok, , why] = verifyFrame(first, { streamIdOfRecord: STREAM });
  assert.equal(ok, true, `fixture frames must verify: ${why}`);
});

test("1. a drill returns pairs and changes nothing", () => {
  const { local, remote } = twoDimensions();
  deepFreeze(local);
  deepFreeze(remote);
  const before = JSON.stringify({ local, remote });
  const found = drill(local, remote);
  assert.ok(found.hits > 0, "the fixture dimensions do share coordinates");
  assert.equal(JSON.stringify({ local, remote }), before, "drill must not touch its inputs");
  assert.equal(found.protocol, PROTOCOL);
  for (const pair of found.pairs) {
    assert.ok(pair.here.frame_hash && pair.there.frame_hash, "a pair reports addresses");
    assert.equal(pair.here.payload ?? undefined, undefined, "a pair carries addresses, not frames");
  }
});

test("2. the same key computed on two machines resolves the same frames", () => {
  const { local, remote } = twoDimensions();
  // Two independent computations of the same coordinate, components in
  // different orders, no communication between them.
  const machineA = keyString(quantumKey(local.frames[1], local.manifest), ["rappid", "clock", "tick"]);
  const machineB = keyString(quantumKey(local.frames[1], local.manifest), ["tick", "clock", "rappid"]);
  assert.equal(machineA, machineB, "component order must not change the key");

  const viaKey = drill(local, remote).pairs.filter((pair) => pair.keys.includes(machineA));
  assert.equal(viaKey.length, 1, "that coordinate resolves exactly one pair");
  assert.equal(viaKey[0].there.seq, 1);
});

test("3. identical bytes with different ancestry is a fixed point; same ancestry is not", () => {
  const { local, remote } = twoDimensions();
  const points = fixedPoints(drill(local, remote).pairs);
  assert.equal(points.length, 3, "ticks 0-2 are byte-identical across the two lines");
  for (const point of points) {
    assert.equal(point.here.payload_hash, point.there.payload_hash);
    assert.notEqual(point.here.frame_hash, point.there.frame_hash, "different ancestry is the point");
  }

  // A dimension paired against itself: identical bytes AND identical ancestry.
  const selfPoints = fixedPoints(drill(local, local).pairs);
  assert.equal(selfPoints.length, 0, "the same frame twice pins nothing");
});

test("4. a run ends at the first contradiction and records the length it reached", () => {
  const { local, remote } = twoDimensions();
  const runs = runsFrom(fixedPoints(drill(local, remote).pairs), local, remote);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].length, 3, "the run reached three frames before the lines diverged");
  assert.equal(runs[0].startHere, 0);
  assert.equal(runs[0].endHere, 2);

  // A gap in the middle closes one run and opens another, with the boundary kept.
  const gappy = dimension(
    { dimension_id: "gappy", clock_key: 1 },
    chain(
      [
        { asserts: { sky: "clear" } },
        { asserts: { wind: 999 } },
        { asserts: { temp: 20 } },
      ],
      { ran: 30 },
    ),
  );
  const split = runsFrom(fixedPoints(drill(local, gappy).pairs), local, gappy);
  assert.equal(split.length, 2, "the mismatch at tick 1 splits the run");
  assert.equal(split[0].length, 1);
  assert.ok(split[0].boundary, "the boundary is recorded rather than discarded");
  assert.match(split[0].boundary.reason, /stopped matching|skipped a tick/);
});

test("5. a long trivial run scores lower substance than a short substantive one", () => {
  const quiet = [{ asserts: {} }, { asserts: {} }, { asserts: {} }, { asserts: {} }];
  const loud = [{ asserts: { fact: 1 } }, { asserts: { fact: 2 } }];

  const quietLocal = dimension({ dimension_id: "ql", clock_key: 1 }, chain(quiet));
  const quietRemote = dimension({ dimension_id: "qr", clock_key: 1 }, chain(quiet, { ran: 30 }));
  const loudLocal = dimension({ dimension_id: "ll", clock_key: 1 }, chain(loud));
  const loudRemote = dimension({ dimension_id: "lr", clock_key: 1 }, chain(loud, { ran: 30 }));

  const quietRun = runsFrom(fixedPoints(drill(quietLocal, quietRemote).pairs), quietLocal, quietRemote)[0];
  const loudRun = runsFrom(fixedPoints(drill(loudLocal, loudRemote).pairs), loudLocal, loudRemote)[0];

  assert.ok(quietRun.length > loudRun.length, "the trivial run is longer");
  assert.ok(quietRun.substance < loudRun.substance, "and still counts for less");
  assert.equal(quietRun.substance, 0);
  assert.equal(isSubstantive(quietLocal.frames[0]), false);
  assert.equal(isSubstantive(loudLocal.frames[0]), true);
});

test("6. the clock offset comes from a fixed point and neighbours place by arithmetic", () => {
  const { local, remote } = twoDimensions();
  const align = alignment(fixedPoints(drill(local, remote).pairs), local, remote);
  assert.equal(align.ok, true);
  assert.equal(align.ratio, 1);
  assert.equal(align.offset, 0);
  assert.equal(align.disagreeing.length, 0, "the pins agree");
  assert.equal(placeThere(align, 3), 3, "the non-identical neighbour places by arithmetic");

  // No pin at all: refuse rather than guess.
  const blind = alignment([], local, remote);
  assert.equal(blind.ok, false);
  assert.match(blind.reason, /nothing pins the phase/);
});

test("7. a frame contradicting a descendant is refused whole", () => {
  // The local line established sky=clear, and a descendant requires it.
  const line = makeLine(chain([
    { asserts: { sky: "clear" } },
    { asserts: { plan: "picnic" }, requires: { sky: "clear" } },
  ]));
  const [incoming] = chain([{ asserts: { sky: "storm", wind: 40 } }], {
    streamId: OTHER_STREAM,
    saltAncestry: "1".repeat(64),
    startSeq: 5,
  });

  const verdict = compatibility(incoming, line);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.contradicts[0].key, "sky");
  assert.equal(verdict.contradicts[0].required, "clear");
  assert.equal(verdict.contradicts[0].asserted, "storm");

  const result = assimilate(line, [incoming]);
  assert.equal(result.merged.length, 0, "refused whole — not partially applied");
  assert.equal(result.joined, null, "nothing joined, so no join frame was minted");
  assert.equal(result.head, line.head, "HEAD did not move");
  assert.equal(result.refused[0].frame, incoming.frame_hash);
  // The useful half: the fold cannot drop the offending delta and keep the rest.
  assert.equal(
    result.line.frames.some((frame) => frame.payload?.asserts?.wind === 40),
    false,
    "the non-contradicting part of a refused frame must not sneak in",
  );
});

test("8. a compatible frame assimilates, HEAD becomes the join, and both ancestries are bound", () => {
  const line = makeLine(chain([
    { asserts: { sky: "clear" } },
    { asserts: { plan: "picnic" }, requires: { sky: "clear" } },
  ]));
  const [incoming] = chain([{ asserts: { wind: 5 } }], {
    streamId: OTHER_STREAM,
    saltAncestry: "2".repeat(64),
    startSeq: 5,
  });

  const before = line.head;
  const result = assimilate(line, [incoming]);
  assert.equal(result.merged.length, 1);
  assert.equal(result.refused.length, 0);
  assert.notEqual(result.head, before, "the line continues from the joined frame");
  assert.equal(result.head, result.joined.frame_hash);
  const localHead = line.frames[line.frames.length - 1];
  assert.equal(result.joined.prev, localHead.payload_hash, "the local HEAD is the chain parent");
  assert.equal(result.joined.prev_wave, null, "RAPP/1 reserves prev_wave for swarm streams");
  assert.equal(
    result.joined.payload.assimilated.includes(incoming.frame_hash),
    true,
    "the frame it joined with is named in the join, and so is bound into frame_hash",
  );
  assert.deepEqual(result.joined.payload.assimilated, [incoming.frame_hash]);

  const [ok, , why] = verifyFrame(result.joined, {
    head: line.frames[line.frames.length - 1],
    streamIdOfRecord: STREAM,
  });
  assert.equal(ok, true, `the join must be a valid RAPP/1 frame: ${why}`);
});

test("9. a byte-identical frame from another ancestry always passes compatibility", () => {
  const entries = [
    { asserts: { sky: "clear" } },
    { asserts: { plan: "picnic" }, requires: { sky: "clear" } },
  ];
  const line = makeLine(chain(entries));
  // Same bytes, different ancestry — asserts exactly what is already asserted.
  const twin = chain(entries, { ran: 30 })[0];
  assert.equal(twin.payload_hash, line.frames[0].payload_hash, "identical bytes");
  assert.notEqual(twin.frame_hash, line.frames[0].frame_hash, "different ancestry");
  assert.equal(compatibility(twin, line).ok, true, "it cannot contradict what it repeats");
});

test("10. same frames and fixed points, shuffled order, identical joined result", () => {
  const line = makeLine(chain([{ asserts: { sky: "clear" } }]));
  const incoming = chain(
    [{ asserts: { a: 1 } }, { asserts: { b: 2 } }, { asserts: { c: 3 } }],
    { streamId: OTHER_STREAM, saltAncestry: "4".repeat(64), startSeq: 10 },
  );

  const machineA = assimilate(line, incoming);
  const machineB = assimilate(line, [incoming[2], incoming[0], incoming[1]]);
  assert.equal(machineA.joined.frame_hash, machineB.joined.frame_hash, "no coordination needed");
  assert.deepEqual(
    machineA.line.frames.map((frame) => frame.frame_hash),
    machineB.line.frames.map((frame) => frame.frame_hash),
  );
});

test("11. after a join, nothing returns HEAD to the pre-join frame", async () => {
  const line = makeLine(chain([{ asserts: { sky: "clear" } }]));
  const [incoming] = chain([{ asserts: { wind: 5 } }], {
    streamId: OTHER_STREAM,
    saltAncestry: "5".repeat(64),
    startSeq: 9,
  });
  const before = line.head;
  const after = assimilate(line, [incoming]);

  // Append-only: the pre-join frames are all still there, and HEAD moved past them.
  for (const frame of line.frames) {
    assert.ok(
      after.line.frames.some((kept) => kept.frame_hash === frame.frame_hash),
      "ancestry only grows",
    );
  }
  assert.notEqual(after.head, before);

  const module = await import("../electron/qqdrill.mjs");
  const undoish = Object.keys(module).filter((name) => /unmerge|unjoin|rollback|revert|reset/i.test(name));
  assert.deepEqual(undoish, [], "an append-only lineage has no un-merge operation");
});

test("12. zoom refines an interval; zoom without a fixed point in the span is refused", () => {
  const coarse = dimension({ dimension_id: "coarse", clock_key: 1 }, chain([
    { asserts: { sky: "clear" } },
    { asserts: { sky: "clear" } },
  ]));
  // Four frames per one of ours, so ratio 4. Ticks 0 and 4 repeat our bytes.
  const fine = dimension({ dimension_id: "fine", clock_key: 4 }, chain(
    [
      { asserts: { sky: "clear" } },
      { asserts: { gust: 1 } },
      { asserts: { gust: 2 } },
      { asserts: { gust: 3 } },
      { asserts: { sky: "clear" } },
    ],
    { ran: 30 },
  ));

  const points = fixedPoints(drill(coarse, fine).pairs);
  assert.ok(points.length > 0, "the identical frames pin the two clocks");
  const align = alignment(points, coarse, fine);
  assert.equal(align.ok, true);
  assert.equal(align.ratio, 4);

  const line = makeLine(coarse.frames);
  const zoomed = zoom({ start: 0, end: 1 }, fine.frames, align, line);
  assert.equal(zoomed.ok, true);
  assert.ok(
    zoomed.resolution.after > zoomed.resolution.before,
    "the past gained detail it never had",
  );

  const unpinned = zoom({ start: 40, end: 50 }, fine.frames, align, line);
  assert.equal(unpinned.ok, false);
  assert.match(unpinned.reason, /no fixed point inside the span/);
});

test("13. zoom is retroactive but not revisionist", () => {
  const coarse = dimension({ dimension_id: "coarse", clock_key: 1 }, chain([
    { asserts: { sky: "clear" } },
    { asserts: { sky: "clear" } },
  ]));
  const fine = dimension({ dimension_id: "fine", clock_key: 2 }, chain(
    [
      { asserts: { sky: "clear" } },
      { asserts: { sky: "storm" } },
    ],
    { ran: 30 },
  ));

  const align = alignment(fixedPoints(drill(coarse, fine).pairs), coarse, fine);
  const line = makeLine(coarse.frames);
  const zoomed = zoom({ start: 0, end: 1 }, fine.frames, align, line);

  assert.equal(zoomed.ok, true);
  assert.equal(zoomed.refused.length, 1, "the finer frame contradicting the interval is refused");
  assert.equal(zoomed.refused[0].contradicts[0].key, "sky");
  assert.equal(zoomed.refused[0].contradicts[0].coarse, "clear");
  assert.equal(zoomed.refused[0].contradicts[0].finer, "storm");
  // What was already there is untouched.
  assert.deepEqual(
    line.frames.map((frame) => frame.frame_hash),
    coarse.frames.map((frame) => frame.frame_hash),
  );
});

test("14. the same drill runs against global tiles, because a tile is a frame", () => {
  const tilePayload = (agents, transcript) => ({
    asserts: { agents, transcript },
    requires: {},
  });
  const mine = dimension({ dimension_id: "my-binder", clock_key: 1 }, [
    buildFrame({
      kind: "rapp.tile",
      streamId: STREAM,
      seq: 0,
      utc: utcAt(0),
      payload: tilePayload(["weather_agent"], "what is the forecast"),
      prev: null,
    }),
  ]);
  const commons = dimension({ dimension_id: "commons", clock_key: 1 }, [
    buildFrame({
      kind: "rapp.tile",
      streamId: STREAM,
      seq: 0,
      utc: utcAt(0),
      payload: tilePayload(["weather_agent"], "what is the forecast"),
      prev: "8".repeat(64),
    }),
  ]);

  const found = drill(mine, commons);
  assert.ok(found.hits > 0, "a published tile is a drillable coordinate");
  const points = fixedPoints(found.pairs);
  assert.equal(points.length, 1, "same tile, different ancestry — a fixed point");
  const pulled = pull(commons, points[0].there);
  assert.equal(pulled.kind, "rapp.tile", "the hit pulls the whole tile, not a digest");
  assert.deepEqual(pulled.payload.asserts.agents, ["weather_agent"]);
});

test("15. disjoint dimensions report no hits honestly", () => {
  const left = dimension({ dimension_id: "left", clock_key: 1 }, chain([{ asserts: { a: 1 } }]));
  const right = dimension(
    { dimension_id: "right", clock_key: 1 },
    chain([{ asserts: { z: 26 } }], { streamId: OTHER_STREAM, saltAncestry: "9".repeat(64) }),
  );
  const found = drill(left, right);
  assert.equal(found.hits, 0, "most drills find nothing, and say so");
  assert.ok(found.searched > 0, "and report what they searched");
  assert.equal(fixedPoints(found.pairs).length, 0);
});

test("the coordinate is computed about frames, never stored in them", () => {
  const [frame] = chain([{ asserts: { sky: "clear" } }]);
  for (const component of COMPONENTS) {
    assert.equal(component in frame, false, `RAPP/1 frames gain no ${component} field`);
  }
  const key = quantumKey(frame, { clock_key: 7 });
  // The coordinate carries the clock as a canonical exact rational, not the raw
  // manifest value. That is what makes clock_key 7 and clock_key "7" one cadence
  // rather than two disjoint coordinates that alignment() would still call ratio 1.
  assert.equal(key.clock, "7/1", "the clock key comes from the dimension manifest, normalised");
  assert.equal(
    quantumKey(frame, { clock_key: "7" }).clock,
    key.clock,
    "a clock key written as a string is the same cadence",
  );
  assert.equal(key.tick, frame.seq);
  assert.equal(key.digest, frame.payload_hash);
});

test("16. two dimensions can line up along several paths, and every one is returned", () => {
  // The same three payloads run twice in the other dimension: once at its ticks
  // 0-2 and again at 4-6. Both are real alignments, and picking one and
  // discarding the other would throw away a merge.
  const shared = [
    { asserts: { sky: "clear" } },
    { asserts: { wind: 5 } },
    { asserts: { temp: 20 } },
  ];
  const local = dimension({ dimension_id: "local", clock_key: 1 }, chain(shared));
  const remote = dimension(
    { dimension_id: "remote", clock_key: 1 },
    chain([...shared, { asserts: { gap: true } }, ...shared], { ran: 30 }),
  );

  const points = fixedPoints(drill(local, remote).pairs);
  const runs = runsFrom(points, local, remote);
  const offsets = [...new Set(runs.map((run) => run.offset))].sort((a, b) => a - b);
  assert.deepEqual(offsets, [0, 4], "both diagonals are found");
  assert.equal(runs[0].length, 3, "longest first");
  assert.equal(runs.filter((run) => run.length === 3).length, 2, "both paths are full length");

  const align = alignment(points, local, remote);
  assert.equal(align.ok, true);
  assert.equal(align.paths.length, 2, "both paths are reported, not one chosen");
  assert.equal(align.paths[0].pins.length, 3);
  assert.equal(align.paths[1].pins.length, 3);
});

test("17. how far a drill goes is how long the person waits, and more is always a superset", () => {
  const shared = [
    { asserts: { sky: "clear" } },
    { asserts: { wind: 5 } },
    { asserts: { temp: 20 } },
    { asserts: { pressure: 1014 } },
  ];
  const local = dimension({ dimension_id: "local", clock_key: 1 }, chain(shared));
  const remote = dimension({ dimension_id: "remote", clock_key: 1 }, chain(shared, { ran: 30 }));

  const impatient = drill(local, remote, { budget: { pairs: 2 } });
  const patient = drill(local, remote);

  assert.equal(impatient.hits, 2, "it stopped where it was told to");
  assert.equal(impatient.exhausted, false, "and says it stopped early rather than finished");
  assert.equal(patient.exhausted, true, "the unbudgeted search ran out of places to look");
  assert.ok(patient.hits > impatient.hits, "waiting longer found more");

  const seen = new Set(patient.pairs.map((pair) => `${pair.here.frame_hash}|${pair.there.frame_hash}`));
  for (const pair of impatient.pairs) {
    assert.ok(
      seen.has(`${pair.here.frame_hash}|${pair.there.frame_hash}`),
      "waiting longer never invalidates a pair already found",
    );
  }

  // And the short search is usable on its own: it merges what it found.
  const line = makeLine(local.frames);
  const result = assimilate(line, impatient.pairs.map((pair) => pull(remote, pair.there)));
  assert.ok(result.merged.length > 0, "a partial drill is still a usable drill");
});
