import assert from "node:assert/strict";
import test from "node:test";

const ROOT = new URL("../electron", import.meta.url).pathname;

const { buildFrame, verifyFrame } = await import(`${ROOT}/qqdrill-deps.mjs`);
const { assimilate, compatibility, makeLine, established } = await import(`${ROOT}/qqdrill.mjs`);

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
/**
 * A pair whose FIRST candidate declares a precondition the second one breaks.
 * This is the case backward fidelity is actually about: the fold refuses a frame
 * that would invalidate something already assimilated, because that something
 * said in writing what it depended on.
 */
function preconditionPair() {
  return chain(
    [
      { asserts: { wind: 5 }, requires: { sky: "clear" } },
      { asserts: { sky: "overcast" } },
    ],
    { streamId: OTHER_STREAM, saltAncestry: "2".repeat(64), startSeq: 5, ran: 40 },
  );
}

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
// CORRECTED 2026-08-21 after an independent review. B1 and B2 were written
// against a rule the module used to enforce and no longer does: that a fact
// settled by a fold became sticky, so any later frame asserting a different
// value for that key was refused. That rule was wrong three ways at once —
// folding a byte-identical twin permanently blocked every later update to its
// key, a settled fact could never be superseded, and each join re-asserted the
// whole accumulated history until the payload crossed RAPP/1's 1 MiB ceiling
// and the line could never be folded again.
//
// The rule that replaces it is the one the protocol states: a frame is refused
// only when it contradicts a DECLARED PRECONDITION of something already on the
// line. `phase: morning` followed by `phase: noon` is time passing.
//
// The invariant these tests exist to protect is unchanged, and is what they now
// assert: how the caller chunked its candidates must never change the outcome.
test("B1. a declared precondition refuses, in one call or two alike", () => {
  const [needsClearSky, breaksIt] = preconditionPair();
  const line = baseLine();

  const oneCall = assimilate(line, [needsClearSky, breaksIt]);
  assert.deepEqual(hashes(oneCall.merged), [needsClearSky.frame_hash], "the precondition-holder joins");
  assert.deepEqual(hashes(oneCall.refused), [breaksIt.frame_hash], "the frame that breaks it does not");

  // Split across two calls. The join minted by the first carries forward the
  // preconditions of what it absorbed, so the second call meets exactly the
  // constraint the second candidate would have met inside the first call.
  const step1 = assimilate(line, [needsClearSky]);
  const step2 = assimilate(step1.line, [breaksIt]);
  assert.equal(step1.merged.length, 1, "the first candidate joins either way");
  assert.deepEqual(hashes(step2.merged), [], "and the second is still refused a call later");
  assert.equal(step2.refused[0].contradicts[0].key, "sky", "for the same recorded reason");
});

test("B2. a bare disagreement is time passing, not a contradiction", () => {
  const [earlier, later] = contradictingPair();
  const line = baseLine();

  // Neither frame declares a precondition and nothing on the line requires the
  // sky to be anything, so a later frame saying the sky changed is exactly what
  // an append-only history of a changing world looks like.
  const oneCall = assimilate(line, [earlier, later]);
  assert.equal(oneCall.refused.length, 0, "nothing declared a dependency, so nothing is invalidated");
  assert.equal(oneCall.merged.length, 2);

  const step1 = assimilate(line, [earlier]);
  const step2 = assimilate(step1.line, [later]);
  assert.equal(step2.merged.length, 1, "and the same holds a call later");
  assert.equal(
    established(step2.line).sky,
    established(oneCall.line).sky,
    "both paths leave the line believing the same thing about the sky",
  );
});

test("B3. the merged/refused partition does not depend on where the calls were cut", () => {
  const [first, second] = preconditionPair();
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

  // What must agree is the FACT the line ends up carrying, not the frame-by-frame
  // history. Two calls mint two joins where one call mints one; that difference
  // is append-only history working, not a disagreement.
  assert.deepEqual(
    established(step2.line).wind,
    established(oneCall.line).wind,
    "the line must end up carrying the same fact either way",
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

  // A later fold updating the same key. Nothing on the line declared a
  // dependency on it, so this is an ordinary update and joins — the point of
  // the test is that a key named __proto__ is treated as data at every step,
  // not that it is treated as special.
  const second = assimilate(first.line, [danger]);
  assert.equal(
    second.merged.length,
    1,
    "__proto__ is ordinary data: nothing declared a dependency on it, so a later "
      + "fold updating it joins like any other key",
  );
  assert.notEqual(second.head, first.head, "and the line continues from the new join");
  const secondAsserts = second.joined.payload.asserts;
  assert.equal(
    Object.hasOwn(secondAsserts, "__proto__"),
    true,
    "carried in the second join as its own data property too",
  );
  assert.equal(Object.prototype.danger, undefined, "and still nothing on Object.prototype");
});
