import assert from "node:assert/strict";
import test from "node:test";

const ROOT = new URL("../electron", import.meta.url).pathname;

const { buildFrame, verifyFrame } = await import(`${ROOT}/qqdrill-deps.mjs`);
const { assimilate, compatibility, makeLine } = await import(`${ROOT}/qqdrill.mjs`);

// rapp-qqdrill/1.0 regression suite — the fold's honesty.
//
// Two defects are under test:
//   B. assimilate() rebuilds `established` on every call, so the facts a fold
//      established are forgotten the moment the call returns. How the caller
//      chunked its candidates then decides what may be merged.
//   E. compatibility() probes the incoming payload with `key in asserts` and
//      reads it with `asserts[key]`, so a descendant whose `requires` names an
//      Object.prototype member is answered from the prototype rather than from
//      the frame.

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

/** A local line that has said nothing about the sky, so nothing is prejudged. */
function baseLine() {
  return makeLine(chain([{ asserts: { started: true } }]));
}

/**
 * Two incoming frames from one other dimension. B contradicts what A asserts,
 * so exactly one of them may ever join this line.
 */
function contradictingPair() {
  return chain(
    [{ asserts: { sky: "clear" } }, { asserts: { sky: "storm" } }],
    { streamId: OTHER_STREAM, saltAncestry: "1".repeat(64), startSeq: 5, ran: 40 },
  );
}

const hashes = (entries) => entries
  .map((entry) => entry.frame_hash || entry.frame)
  .sort();

// ---------------------------------------------------------------------------
// ROOT CAUSE B — the fold's memory is per-call.
// ---------------------------------------------------------------------------

// DEFECT B: `assimilate()` builds `established` fresh on every call, so a fact
// established by an earlier fold is invisible to the next one. Folding {A, B}
// in one call refuses B; folding [A] then [B] admits it. How long the caller
// waited before folding the rest of the drill's pairs decides what is true.
//
// QQDRILL-PROTOCOL.md: "a later candidate that contradicts what an earlier one
// already established is refused, so the outcome never depends on which frame
// happened to be folded last" is the module's own statement of the rule the
// protocol writes as: "the merge may only add ancestry, never invalidate a
// descendant. Everything that held before the join still holds after it."
test("B1. a second fold must refuse what the first fold's facts already contradict", () => {
  const [first, second] = contradictingPair();
  const line = baseLine();

  const oneCall = assimilate(line, [first, second]);
  assert.deepEqual(hashes(oneCall.merged), [first.frame_hash].sort(), "one call joins only the first");
  assert.deepEqual(hashes(oneCall.refused), [second.frame_hash].sort(), "one call refuses the contradiction");

  // The same two candidates, folded as the drill handed them back: one, then
  // the other, against the line the first fold produced.
  const step1 = assimilate(line, [first]);
  assert.equal(step1.merged.length, 1, "the first candidate joins either way");
  const step2 = assimilate(step1.line, [second]);

  assert.deepEqual(
    hashes(step2.merged),
    [],
    "sky=clear is established on this line; a frame asserting sky=storm must be refused however late it arrives",
  );
  assert.deepEqual(
    hashes(step2.refused),
    [second.frame_hash],
    "the refusal is a result and must be recorded, not skipped by a forgetful fold",
  );
  assert.equal(step2.joined, null, "nothing joined, so no join frame may be minted");
  assert.equal(step2.head, step1.head, "a refused fold does not move HEAD");
});

// DEFECT B: because `established` is per-call, a frame refused by a fold can be
// re-offered against the line that same fold produced and will be accepted the
// second time. Patience alone flips the verdict.
//
// QQDRILL-PROTOCOL.md: "the merge may only add ancestry, never invalidate a
// descendant. Everything that held before the join still holds after it."
test("B2. re-offering a refused frame against the resulting line is a no-op", () => {
  const [first, second] = contradictingPair();
  const line = baseLine();

  const folded = assimilate(line, [first, second]);
  assert.equal(folded.refused.length, 1, "the batch fold refused the contradiction");

  // Wait, then offer the refused frame again. Nothing about the line has
  // changed in its favour, so nothing about the verdict may change either.
  const again = assimilate(folded.line, [second]);

  assert.equal(again.merged.length, 0, "a refused frame is still refused when it is offered again");
  assert.equal(again.joined, null, "no join frame may be minted for a frame that cannot join");
  assert.equal(
    again.head,
    folded.head,
    "HEAD after the retry must equal HEAD after the fold — waiting longer cannot advance the lineage",
  );
  assert.deepEqual(
    again.line.frames.map((frame) => frame.frame_hash),
    folded.line.frames.map((frame) => frame.frame_hash),
    "the line gains nothing from a fold that merged nothing",
  );
  assert.equal(
    again.line.frames.some((frame) => frame.payload?.asserts?.sky === "storm"),
    false,
    "the contradicted fact must never reach the line",
  );
});

// DEFECT B: the outcome of folding a candidate set is currently a function of
// (line, candidate set, call boundaries). It must be a function of (line,
// candidate set) alone.
//
// QQDRILL-PROTOCOL.md: "Whatever a drill chooses to probe, and however it ranks
// what it finds, an assimilation must still refuse anything contradicting
// downstream ... Policy decides *what you look at*. It never decides *what is
// true*." And: "A drill stopped after two pairs is a smaller drill, not a
// broken one, and resuming continues from exactly where it stopped."
test("B3. the merged/refused partition does not depend on where the calls were cut", () => {
  const [first, second] = contradictingPair();
  const line = baseLine();

  const oneCall = assimilate(line, [first, second]);

  const step1 = assimilate(line, [first]);
  const step2 = assimilate(step1.line, [second]);
  const splitMerged = hashes([...step1.merged, ...step2.merged]);
  const splitRefused = hashes([...step1.refused, ...step2.refused]);

  assert.deepEqual(
    splitMerged,
    hashes(oneCall.merged),
    "the same candidates over the same line must merge the same set, folded in one call or two",
  );
  assert.deepEqual(
    splitRefused,
    hashes(oneCall.refused),
    "and must refuse the same set",
  );

  // The facts the line ends up carrying are the same fact either way.
  const assertedSky = (result) => result.line.frames
    .map((frame) => frame.payload?.asserts?.sky)
    .filter((value) => value !== undefined);
  assert.deepEqual(
    assertedSky(step2),
    assertedSky(oneCall),
    "the line must end up asserting the same thing about the sky in both paths",
  );
});

// ---------------------------------------------------------------------------
// ROOT CAUSE E — prototype-chain lookups in compatibility().
// ---------------------------------------------------------------------------

// DEFECT E: `key in asserts` walks the prototype chain, so a descendant whose
// `requires` names an Object.prototype member takes the prototype branch. The
// incoming frame asserts nothing about that key, but `asserts[key]` yields a
// built-in function, which canonical() then rejects — compatibility() throws
// instead of returning a verdict, and the fold cannot proceed at all.
//
// QQDRILL-PROTOCOL.md: "The rule: a frame is assimilated only if it contradicts
// nothing downstream of the current frame." A frame that says nothing about a
// key contradicts nothing about it.
test("E1. a descendant requiring toString/constructor/valueOf is not answered from the prototype", () => {
  for (const key of ["toString", "constructor", "valueOf"]) {
    const line = makeLine(chain([
      { asserts: { sky: "clear" } },
      { asserts: { plan: "picnic" }, requires: { [key]: "whatever this descendant needs" } },
    ]));
    const [incoming] = chain([{ asserts: { wind: 5 } }], {
      streamId: OTHER_STREAM,
      saltAncestry: "2".repeat(64),
      startSeq: 5,
      ran: 40,
    });

    let verdict;
    try {
      verdict = compatibility(incoming, line);
    } catch (error) {
      assert.fail(
        `compatibility() crashed on requires:{${key}} because \`${key} in asserts\` `
        + `took the Object.prototype branch and handed a built-in to canonical(): ${error.message}`,
      );
    }
    assert.equal(
      verdict.ok,
      true,
      `the incoming frame asserts nothing about ${key}, so it contradicts nothing — `
      + `verdict must be ok, got ${JSON.stringify(verdict.contradicts)}`,
    );
    assert.deepEqual(verdict.contradicts, [], `no contradiction may be invented for ${key}`);

    // And the fold must reach the same conclusion, whole.
    const folded = assimilate(line, [incoming]);
    assert.equal(folded.merged.length, 1, `a frame silent about ${key} still joins`);
  }
});

// DEFECT E: "__proto__" is the one Object.prototype member whose value is not a
// function, so this case does not crash — it silently returns the WRONG
// verdict. `asserts["__proto__"]` yields Object.prototype, canonical()
// renders it as "{}", and the frame is refused for contradicting a key it never
// mentioned, with a live prototype object reported as the asserted value.
//
// QQDRILL-PROTOCOL.md: "A pair is a candidate, not an assimilation ... a frame
// is assimilated only if it contradicts nothing downstream of the current
// frame." And: "A refusal is a result, not a failure" — which requires the
// refusal to be about something the frame actually said.
test("E2. a descendant requiring __proto__ is not answered from Object.prototype", () => {
  const line = makeLine(chain([
    { asserts: { sky: "clear" } },
    { asserts: { plan: "picnic" }, requires: { ["__proto__"]: "safe" } },
  ]));
  const [incoming] = chain([{ asserts: { wind: 5 } }], {
    streamId: OTHER_STREAM,
    saltAncestry: "3".repeat(64),
    startSeq: 5,
    ran: 40,
  });

  const verdict = compatibility(incoming, line);
  for (const entry of verdict.contradicts) {
    assert.notEqual(
      entry.asserted,
      Object.prototype,
      "Object.prototype reached the verdict as an asserted value — nothing may be read off a prototype",
    );
  }
  assert.equal(
    verdict.ok,
    true,
    "the incoming frame asserts nothing named __proto__, so it contradicts nothing downstream",
  );
  assert.deepEqual(verdict.contradicts, [], "no contradiction may be invented for __proto__");

  const folded = assimilate(line, [incoming]);
  assert.equal(folded.merged.length, 1, "and the frame joins, whole");
  assert.equal(folded.refused.length, 0, "a frame is not refused for a key it never mentioned");
});

// DEFECTS E and B together: a key literally named "__proto__" is ordinary
// payload data. It must be compared as data (E), and once a fold has
// established it, it must still be established at the next fold (B).
//
// QQDRILL-PROTOCOL.md: "the incoming frame's deltas are checked against the
// downstream line ... the merge may only add ancestry, never invalidate a
// descendant."
test("E3. asserts named __proto__ are ordinary data through the verdict, the join and the next fold", () => {
  const [safe, danger] = chain(
    [{ asserts: { ["__proto__"]: "safe" } }, { asserts: { ["__proto__"]: "danger" } }],
    { streamId: OTHER_STREAM, saltAncestry: "4".repeat(64), startSeq: 5, ran: 40 },
  );
  const line = baseLine();

  const first = assimilate(line, [safe]);
  assert.equal(first.merged.length, 1, "a frame asserting __proto__ is data and joins normally");

  const joinedAsserts = first.joined.payload.asserts;
  assert.equal(
    Object.prototype.hasOwnProperty.call(joinedAsserts, "__proto__"),
    true,
    "the join must carry __proto__ as its own data property",
  );
  assert.equal(joinedAsserts["__proto__"], "safe", "with the value the frame actually asserted");
  assert.equal(
    Object.getPrototypeOf(joinedAsserts),
    Object.prototype,
    "and must not have had its prototype replaced by the fold",
  );
  assert.equal(Object.prototype.safe, undefined, "nothing may be written onto Object.prototype");

  const [ok, , why] = verifyFrame(first.joined, {
    head: line.frames[line.frames.length - 1],
    streamIdOfRecord: STREAM,
  });
  assert.equal(ok, true, `the join must still be a valid RAPP/1 frame: ${why}`);

  // The fact is established on the line. A later fold must see it.
  const second = assimilate(first.line, [danger]);
  assert.equal(
    second.merged.length,
    0,
    "__proto__=safe is established on this line; a later fold asserting __proto__=danger must be refused",
  );
  assert.equal(second.head, first.head, "and HEAD must not move");
});
