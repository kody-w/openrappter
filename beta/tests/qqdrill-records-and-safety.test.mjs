import assert from "node:assert/strict";
import test from "node:test";

import {
  buildFrame,
  canonical,
  verifyFrame,
} from "../electron/qqdrill-deps.mjs";
import {
  alignment,
  assimilate,
  dimension,
  drill,
  fixedPoints,
  makeLine,
  pull,
  runsFrom,
  zoom,
} from "../electron/qqdrill.mjs";

// Regression tests for rapp-qqdrill/1.0 root causes F, G, H, I:
// what gets minted, what gets dropped, what gets recorded, what crashes.
// Every test asserts the behaviour the protocol requires, so each one fails
// against the module as it stands and passes once the defect is fixed.

const STREAM = `rappid:@rapp/tile-weather:${"a".repeat(64)}`;
const OTHER_STREAM = `rappid:@rapp/tile-weather:${"b".repeat(64)}`;
const SWARM_STREAM = "net:swarm-alpha";

function utcAt(second) {
  return `2026-08-21T12:00:${String(second).padStart(2, "0")}.000Z`;
}

/** Build a chain of frames. Each entry is {asserts, requires}. */
function chain(entries, {
  streamId = STREAM,
  saltAncestry = null,
  startSeq = 0,
  ran = 0,
  sig = null,
  swarm = false,
} = {}) {
  const frames = [];
  let prev = saltAncestry;
  let prevWave = null;
  entries.forEach((entry, index) => {
    const frame = buildFrame({
      kind: "qqdrill.tick",
      streamId,
      seq: startSeq + index,
      utc: utcAt(ran + startSeq + index),
      payload: { asserts: entry.asserts || {}, requires: entry.requires || {} },
      prev,
      prevWave,
      sig,
    });
    frames.push(frame);
    prev = frame.payload_hash;
    prevWave = swarm ? frame.frame_hash : null;
  });
  return frames;
}

/** Two dimensions that ran the same situation: ticks 0-2 match, tick 3 diverges. */
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
    chain([...shared, { asserts: { note: "remote-only" } }], { ran: 30 }),
  );
  return { local, remote };
}

/** A frame handed in from an unvalidated source — a foreign dimension, a cache, a fetch. */
function foreignFrame(asserts) {
  return {
    spec: "rapp/1",
    kind: "qqdrill.tick",
    stream_id: OTHER_STREAM,
    seq: 7,
    utc: utcAt(9),
    payload: { asserts, requires: {} },
    payload_hash: "0".repeat(64),
    prev: null,
    prev_wave: null,
    sig: null,
    frame_hash: "c".repeat(64),
  };
}

function label(point) {
  return `here#${point.here.seq}/${point.here.frame_hash.slice(0, 8)}`
    + ` -> there#${point.there.seq}/${point.there.frame_hash.slice(0, 8)}`;
}

// ---------------------------------------------------------------------------
// F — what gets minted
// ---------------------------------------------------------------------------

// DEFECT F: assimilate() hard-codes `prevWave: null` and never signs, so on a
// stream_id beginning "net:" the join it mints is rejected by RAPP/1 rule 5
// ("prev_wave does not match swarm head"). It mints an invalid frame instead of
// refusing. qqdrill.mjs header: "the local chain stays a valid single-parent
// RAPP/1 chain". QQDRILL-PROTOCOL.md: "A refusal is a result, not a failure."
test("F. a join minted onto a swarm stream verifies, or assimilate refuses and says why", () => {
  const line = makeLine(chain(
    [{ asserts: { sky: "clear" } }, { asserts: { plan: "picnic" } }],
    { streamId: SWARM_STREAM, sig: "swarm-signature", swarm: true },
  ));
  const head = line.frames[line.frames.length - 1];
  // The fixture itself is a valid RAPP/1 swarm chain, so any failure below is
  // about the frame assimilate minted and nothing else.
  assert.equal(verifyFrame(line.frames[0], { streamIdOfRecord: SWARM_STREAM })[0], true);
  assert.equal(verifyFrame(head, { head: line.frames[0], streamIdOfRecord: SWARM_STREAM })[0], true);

  const [incoming] = chain([{ asserts: { wind: 5 } }], {
    streamId: OTHER_STREAM,
    saltAncestry: "1".repeat(64),
    startSeq: 5,
    ran: 30,
  });
  const result = assimilate(line, [incoming]);

  if (result.joined === null) {
    const stated = result.reason ?? result.refusal
      ?? (result.refused.length ? "recorded in refused[]" : null);
    assert.ok(stated, "refusing to mint is fine, but the refusal must state a reason");
    assert.equal(result.head, line.head, "a refusal leaves HEAD where it was");
    return;
  }

  const [ok, rule, why] = verifyFrame(result.joined, {
    head,
    streamIdOfRecord: SWARM_STREAM,
  });
  assert.equal(
    ok,
    true,
    `assimilate minted a frame RAPP/1 rejects (rule ${rule}: ${why})`
    + " — it must mint a valid frame or refuse with a stated reason",
  );
});

// DEFECT F: the same minted-invalid-frame defect, stated as the header's own
// claim: "the local chain stays a valid single-parent RAPP/1 chain". Walk the
// line assimilate() handed back and verify every frame against the head it
// descends from.
test("F. every frame in the line assimilate() returns verifies against the head it descends from", () => {
  const line = makeLine(chain(
    [{ asserts: { sky: "clear" } }, { asserts: { plan: "picnic" } }],
    { streamId: SWARM_STREAM, sig: "swarm-signature", swarm: true },
  ));
  const [incoming] = chain([{ asserts: { wind: 5 } }], {
    streamId: OTHER_STREAM,
    saltAncestry: "2".repeat(64),
    startSeq: 5,
    ran: 30,
  });

  const result = assimilate(line, [incoming]);
  const broken = [];
  let head = null;
  for (const frame of result.line.frames) {
    const [ok, rule, why] = verifyFrame(frame, { head, streamIdOfRecord: SWARM_STREAM });
    if (!ok) broken.push(`seq ${frame.seq} (${frame.kind}): rule ${rule} — ${why}`);
    head = frame;
  }
  assert.deepEqual(broken, [], "the chain assimilate returns must be a valid RAPP/1 chain");
});

// ---------------------------------------------------------------------------
// G — what gets dropped
// ---------------------------------------------------------------------------

// DEFECT G: runsFrom() skips any fixed point that shares a local tick with an
// already-open run ("if (current && point.here.seq === current.endHere)
// continue"), so a second genuine partner for that tick is silently discarded —
// it appears in no run at all. QQDRILL-PROTOCOL.md: "A local tick can arrive
// with several partners ... Each path is a real diagonal and a real chance to
// merge, so all of them are returned."
test("G. a local tick with two partners keeps both — no fixed point is silently discarded", () => {
  // A binder that holds two independently-run lines of the same two ticks: the
  // very case the protocol calls "a repeated payload matches every one of its
  // twins". Each local tick therefore has two real partners.
  const local = dimension(
    { dimension_id: "local", clock_key: 1 },
    chain([{ asserts: { sky: "clear" } }, { asserts: { wind: 5 } }]),
  );
  const binder = dimension({ dimension_id: "binder", clock_key: 1 }, [
    ...chain([{ asserts: { sky: "clear" } }, { asserts: { wind: 5 } }], { ran: 30 }),
    ...chain([{ asserts: { sky: "clear" } }, { asserts: { wind: 5 } }], { ran: 45 }),
  ]);

  const points = fixedPoints(drill(local, binder).pairs);
  assert.equal(points.length, 4, "each of the two local ticks pins against both twins");

  const runs = runsFrom(points, local, binder);
  const kept = new Set(
    runs.flatMap((run) => run.points.map((point) => label(point))),
  );
  const dropped = points.map(label).filter((id) => !kept.has(id));
  assert.deepEqual(
    dropped,
    [],
    "every fixed point is a chance to merge and must be returned in some run,"
    + " not dropped for sharing a tick with a run already open",
  );
});

// ---------------------------------------------------------------------------
// H — what gets recorded
// ---------------------------------------------------------------------------

// DEFECT H: a run that ends because the two dimensions diverged is closed by
// the final `close(null)`, so it records boundary: null — the divergence is
// discarded. QQDRILL-PROTOCOL.md: "A run starts where the frames begin matching
// and ends at the first contradiction ... the contradiction is recorded as the
// boundary rather than discarded, because where two dimensions stopped agreeing
// is the most informative thing about them."
test("H. a run that ends because the dimensions diverged records the boundary, not null", () => {
  const { local, remote } = twoDimensions();
  const runs = runsFrom(fixedPoints(drill(local, remote).pairs), local, remote);
  assert.equal(runs.length, 1);
  const [run] = runs;
  assert.equal(run.endHere, 2, "the run reached tick 2; both lines then said something different");

  assert.notEqual(
    run.boundary,
    null,
    "the run ended at a real contradiction (local tick 3 asserts note=local-only,"
    + " remote tick 3 asserts note=remote-only) and that must be recorded",
  );
  assert.equal(run.boundary.at, 3, "the boundary names the tick where they stopped agreeing");
  assert.equal(typeof run.boundary.reason, "string", "and says why it stopped");
});

// DEFECT H: boundary.at is filled from the next MATCHING point's tick
// ("close({ at: point.here.seq ... })"), so it names a tick where the two
// dimensions agree again instead of the first tick where they contradicted.
// QQDRILL-PROTOCOL.md: "A run ... ends at the first contradiction."
test("H. boundary.at names the first contradiction, not the next matching tick", () => {
  // Ticks 0 and 2 match; tick 1 is where they stopped agreeing.
  const local = dimension({ dimension_id: "local", clock_key: 1 }, chain([
    { asserts: { sky: "clear" } },
    { asserts: { wind: 5 } },
    { asserts: { temp: 20 } },
  ]));
  const remote = dimension({ dimension_id: "remote", clock_key: 1 }, chain([
    { asserts: { sky: "clear" } },
    { asserts: { wind: 999 } },
    { asserts: { temp: 20 } },
  ], { ran: 30 }));

  const runs = runsFrom(fixedPoints(drill(local, remote).pairs), local, remote);
  const first = runs.find((run) => run.startHere === 0);
  assert.ok(first?.boundary, "the run that stops at tick 1 records a boundary");
  assert.equal(
    first.boundary.at,
    1,
    "tick 1 is the contradiction (wind=5 here, wind=999 there); tick 2 matches again"
    + " and is not where the run ended",
  );
});

// DEFECT H: a run records `substance` — a bare count of substantive frames —
// and nothing about what those frames actually said, so a caller cannot tell a
// long trivial run from a long meaningful one by reading the run.
// QQDRILL-PROTOCOL.md proof obligation: "a run of matching frames ends at the
// first contradiction and is recorded with the length it reached and what those
// frames asserted." And: "The record keeps what the matching frames actually
// contained, so a long trivial run cannot present as a long meaningful one."
test("H. a run records what the matching frames asserted, not only how many did", () => {
  const { local, remote } = twoDimensions();
  const [run] = runsFrom(fixedPoints(drill(local, remote).pairs), local, remote);
  assert.equal(run.length, 3);
  assert.equal(run.substance, 3, "all three matching frames asserted something");

  const recorded = JSON.stringify(run);
  const missing = [
    ["sky", "clear"],
    ["wind", 5],
    ["temp", 20],
  ].filter(([key, value]) => !(
    recorded.includes(JSON.stringify(key)) && recorded.includes(JSON.stringify(value))
  ));
  assert.deepEqual(
    missing.map(([key]) => key),
    [],
    `the run records substance=${run.substance} but nothing about what the frames asserted`
    + " — the record must keep what the matching frames actually contained",
  );
});

// ---------------------------------------------------------------------------
// I — what crashes
// ---------------------------------------------------------------------------

// DEFECT I: assimilate() carries every merged frame's asserts into the join
// payload and calls buildFrame() on it unguarded. Two individually-legal frames
// can push the join's canonical form past canonical()'s 1 MiB ceiling, and the
// exception escapes assimilate instead of becoming a refusal.
// QQDRILL-PROTOCOL.md: "A refusal is a result, not a failure."
test("I. a join too large to canonicalise is refused, not thrown", () => {
  const line = makeLine(chain([{ asserts: { sky: "clear" } }]));
  // Each frame is a legal RAPP/1 frame on its own — ~600 KiB, well under the
  // 1 MiB ceiling. Together they do not fit in one join payload.
  const half = "x".repeat(600 * 1024);
  const incoming = [
    ...chain([{ asserts: { blob_a: half } }], {
      streamId: OTHER_STREAM, saltAncestry: "3".repeat(64), startSeq: 5, ran: 30,
    }),
    ...chain([{ asserts: { blob_b: half } }], {
      streamId: OTHER_STREAM, saltAncestry: "4".repeat(64), startSeq: 6, ran: 30,
    }),
  ];
  for (const frame of incoming) {
    assert.ok(
      Buffer.byteLength(canonical(frame.payload), "utf8") < 1024 * 1024,
      "each frame is individually inside the 1 MiB canonical ceiling",
    );
  }

  let result = null;
  let thrown = null;
  try {
    result = assimilate(line, incoming);
  } catch (error) {
    thrown = error;
  }
  assert.equal(
    thrown === null ? null : thrown.message,
    null,
    "assimilate must refuse what it cannot mint, not throw at the caller",
  );

  const accounted = new Set([
    ...result.merged.map((frame) => frame.frame_hash),
    ...result.refused.map((entry) => entry.frame),
  ]);
  assert.equal(accounted.size, 2, "each incoming frame is either merged or recorded as refused");
  if (result.joined) {
    const [ok, rule, why] = verifyFrame(result.joined, {
      head: line.frames[line.frames.length - 1],
      streamIdOfRecord: STREAM,
    });
    assert.equal(ok, true, `a minted join must be a valid frame (rule ${rule}: ${why})`);
  }
});

// DEFECT I: a frame pulled from an unvalidated source can carry a value RAPP/1
// canonicalisation rejects (a non-finite number, an unpaired surrogate — the
// latter survives JSON.parse intact). assimilate() folds the value into the
// join payload and lets canonical()'s exception escape.
// QQDRILL-PROTOCOL.md: "A refusal is a result, not a failure."
test("I. a frame that cannot be canonicalised is refused, not thrown", () => {
  const cases = [
    ["a non-finite number", { score: NaN }],
    ["an unpaired surrogate", { label: "\ud800" }],
  ];
  for (const [what, asserts] of cases) {
    const line = makeLine(chain([{ asserts: { sky: "clear" } }]));
    const incoming = foreignFrame(asserts);

    let result = null;
    let thrown = null;
    try {
      result = assimilate(line, [incoming]);
    } catch (error) {
      thrown = error;
    }
    assert.equal(
      thrown === null ? null : thrown.message,
      null,
      `a frame carrying ${what} must be refused as a result, not crash the fold`,
    );
    assert.equal(result.joined, null, `nothing may be minted from ${what}`);
    assert.equal(result.merged.length, 0, `${what} cannot be folded in`);
    assert.deepEqual(
      result.refused.map((entry) => entry.frame),
      [incoming.frame_hash],
      `the refusal of ${what} is recorded`,
    );
    assert.equal(result.head, line.head, "HEAD does not move on a refusal");
  }
});

// DEFECT I: dimension() freezes the wrapper and the frames array but not the
// frames themselves, so pull() hands back a live handle into the caller's
// dimension. QQDRILL-PROTOCOL.md: "A drill's output is a pair ... It does not
// fold, does not assimilate, and does not advance any lineage" — a search that
// hands out mutable state cannot be "safe to run constantly".
test("I. pull() does not hand back a live handle into the dimension", () => {
  const { local, remote } = twoDimensions();
  const point = fixedPoints(drill(local, remote).pairs)[0];
  const pulled = pull(remote, point.there);
  assert.equal(pulled.payload.asserts.sky, "clear");

  try {
    pulled.payload.asserts.sky = "storm";
  } catch {
    // Frozen — refusing the write is a correct outcome.
  }
  assert.equal(
    remote.frames[0].payload.asserts.sky,
    "clear",
    "a caller mutating a pulled frame must not rewrite the dimension it came from",
  );
});

// DEFECT I: assimilate() puts the caller's own frame objects into `merged`, so
// a merged frame is a live handle into the dimension it came from — and its
// payload can be rewritten after the join committed to its frame_hash.
// QQDRILL-PROTOCOL.md: "the merge may only add ancestry, never invalidate a
// descendant. Everything that held before the join still holds after it."
test("I. assimilate().merged does not hand back live frames from the source dimension", () => {
  const source = dimension(
    { dimension_id: "source", clock_key: 1 },
    chain([{ asserts: { wind: 5 } }], {
      streamId: OTHER_STREAM, saltAncestry: "5".repeat(64), startSeq: 5, ran: 30,
    }),
  );
  const line = makeLine(chain([{ asserts: { sky: "clear" } }]));

  const result = assimilate(line, source.frames);
  assert.equal(result.merged.length, 1);

  try {
    result.merged[0].payload.asserts.wind = 999;
  } catch {
    // Frozen — refusing the write is a correct outcome.
  }
  assert.equal(
    source.frames[0].payload.asserts.wind,
    5,
    "mutating a merged frame must not rewrite the dimension, whose frame the join"
    + " already bound by hash",
  );
});

// DEFECT I: zoom() freezes each {frame, at, refines} wrapper but not the frame
// inside it, so refined[] hands back live frames from the finer dimension.
// QQDRILL-PROTOCOL.md: "It is retroactive but not revisionist ... Your past
// gains detail it never had, and loses nothing it did."
test("I. zoom().refined does not hand back live frames from the finer dimension", () => {
  const coarse = dimension({ dimension_id: "coarse", clock_key: 1 }, chain([
    { asserts: { sky: "clear" } },
    { asserts: { sky: "clear" } },
  ]));
  const fine = dimension({ dimension_id: "fine", clock_key: 4 }, chain([
    { asserts: { sky: "clear" } },
    { asserts: { gust: 1 } },
    { asserts: { gust: 2 } },
    { asserts: { gust: 3 } },
    { asserts: { sky: "clear" } },
  ], { ran: 30 }));

  const align = alignment(fixedPoints(drill(coarse, fine).pairs), coarse, fine);
  const zoomed = zoom({ start: 0, end: 1 }, fine.frames, align, makeLine(coarse.frames));
  assert.equal(zoomed.ok, true);

  const gusty = zoomed.refined.find((entry) => entry.frame.payload.asserts.gust === 1);
  assert.ok(gusty, "the finer frames refined the interval");
  try {
    gusty.frame.payload.asserts.gust = 999;
  } catch {
    // Frozen — refusing the write is a correct outcome.
  }
  assert.equal(
    fine.frames[1].payload.asserts.gust,
    1,
    "a caller mutating a refined frame must not rewrite the finer dimension",
  );
});
