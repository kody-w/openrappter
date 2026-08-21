// rapp-qqdrill/1.0 — local instant transmission.
//
// The drill finds pairs. It never merges, never assimilates, and advances no
// lineage: its whole output is a key and the two addresses that key resolves.
// Everything after that is the fold's job, under the compatibility rule.
// See ../docs/QQDRILL-PROTOCOL.md.
//
// This module builds on the frozen RAPP/1 frame in rapp-protocol.mjs and
// changes nothing about it. The discriminator a join needs is already there:
//   payload_hash equal + frame_hash different  ==  same bytes, different ancestry
//
// What RAPP/1 does NOT offer is a second-parent field. `prev_wave` is reserved
// for swarm streams, where it must equal the swarm head — so a join records the
// frames it assimilated in its payload. The payload is hashed into frame_hash,
// so that ancestry claim is bound just as tightly, and the local chain stays a
// valid single-parent RAPP/1 chain.
//
// ARITHMETIC. Every comparison that decides a diagonal, a placement or a run is
// done in exact integer arithmetic over BigInt rationals. Nothing here rounds,
// and nothing buckets on a formatted float. Two machines that never communicate
// must reach the same verdict, and a verdict that depends on the last bit of a
// division is not a verdict.
//
// Mechanism lives here. Policy — which components to index, how to weight
// substance, what threshold calls a span determined — is injected, and the
// default below is a plain example rather than a ceiling.

import { H, buildFrame, verifyFrame, canonical } from "./qqdrill-deps.mjs";

export const PROTOCOL = "rapp-qqdrill/1.0";

/**
 * The coordinate components this protocol knows how to address. A dimension may
 * declare further ones in its manifest under `coordinates` — the specification
 * says "whatever else a dimension declares as a coordinate it shares", and this
 * list being closed made that sentence false.
 */
export const COMPONENTS = Object.freeze(["rappid", "clock", "tick", "digest"]);

/** Extra components a dimension declares, in canonical order. */
function declaredComponents(manifest) {
  const extra = manifest?.coordinates;
  if (!extra || typeof extra !== "object" || Array.isArray(extra)) return [];
  return Object.keys(extra).filter((name) => !COMPONENTS.includes(name)).sort();
}

/**
 * The lookups a drill probes, as component tuples. Position pairs frames of the
 * same capability at the same tick of the same cadence; content pairs frames
 * whose bytes are identical. Both are ordinary lookups; which ones exist and in
 * what order they are probed is policy.
 */
export const DEFAULT_LOOKUPS = Object.freeze([
  Object.freeze(["rappid", "clock", "tick"]),
  Object.freeze(["digest"]),
]);

/** How many candidates one coordinate may fan out to before the drill says so. */
const DEFAULT_FANOUT_CAP = 512;

// ── exact rationals ─────────────────────────────────────────────────────────

function gcd(a, b) {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y) { const t = x % y; x = y; y = t; }
  return x;
}

function reduce(n, d) {
  if (d === 0n) throw new Error("rational with zero denominator");
  if (d < 0n) { n = -n; d = -d; }
  const g = gcd(n, d);
  return g === 0n ? { n: 0n, d: 1n } : { n: n / g, d: d / g };
}

/**
 * A clock key parsed to an exact rational. Accepts an integer, a finite decimal,
 * or the decimal's string form — so `1` and `"1"` are the same cadence, which is
 * the only way the coordinate and the alignment can agree about it.
 * Anything else is refused rather than coerced.
 */
export function parseClock(value) {
  if (typeof value === "bigint") {
    return value > 0n ? { n: value, d: 1n } : null;
  }
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "number" && !Number.isFinite(value)) return null;

  let text = String(value).trim();

  // Expand exponent notation. JS renders 1e-9 and 1e21 that way, so a plain
  // decimal regex rejects perfectly ordinary clock keys — and every rejection
  // used to collapse to the same null, which made two dimensions with DIFFERENT
  // unusable cadences pair as though their cadences matched. A refusal must
  // never become an equality.
  const exponent = /^(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/.exec(text);
  if (exponent) {
    const [, whole, frac = "", rawExp] = exponent;
    const exp = Number(rawExp);
    const digits = whole + frac;
    const pointFrom = whole.length + exp;
    if (pointFrom <= 0) {
      text = `0.${"0".repeat(-pointFrom)}${digits}`;
    } else if (pointFrom >= digits.length) {
      text = digits + "0".repeat(pointFrom - digits.length);
    } else {
      text = `${digits.slice(0, pointFrom)}.${digits.slice(pointFrom)}`;
    }
  }

  if (!/^\d+(\.\d+)?$/.test(text)) return null;
  const [whole, frac = ""] = text.split(".");
  const n = BigInt(whole + frac);
  const d = 10n ** BigInt(frac.length);
  if (n <= 0n) return null;
  return reduce(n, d);
}

/** The canonical text of a clock key, so equal cadences render identically. */
function clockText(rational) {
  return rational ? `${rational.n}/${rational.d}` : null;
}

/**
 * The ratio between two cadences, exact. their-clock over our-clock, reduced,
 * so `n` is how far their tick advances while `d` is how far ours does.
 */
function ratioOf(here, there) {
  if (!here || !there) return null;
  return reduce(there.n * here.d, there.d * here.n);
}

// ── payload access, without touching prototypes ─────────────────────────────

function plainMap(value) {
  const out = Object.create(null);
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const key of Object.keys(value)) out[key] = value[key];
  }
  return out;
}

function assertsOf(frame) { return plainMap(frame?.payload?.asserts); }
function requiresOf(frame) { return plainMap(frame?.payload?.requires); }

/**
 * Compare two asserted values. A value that cannot be canonically encoded is
 * not a crash: it is a refusal with a reason, because a refusal is a result and
 * an exception is a lost frame.
 */
function equalValues(left, right) {
  try {
    return { ok: true, equal: canonical(left ?? null) === canonical(right ?? null) };
  } catch (error) {
    return { ok: false, reason: error.message };
  }
}

/**
 * A frame is substantive when it asserts something. A frame that asserts
 * nothing can contradict nothing, and a run of them is cheap agreement — it
 * must not read as strongly as a run of frames that each said something.
 */
export function isSubstantive(frame) {
  return Object.keys(assertsOf(frame)).length > 0;
}

// ── coordinates ─────────────────────────────────────────────────────────────

/** The composite coordinate of a frame. Computed about frames, never stored in them. */
export function quantumKey(frame, manifest = {}) {
  if (!frame || typeof frame !== "object") {
    throw new Error("quantumKey needs a RAPP/1 frame");
  }
  const declared = Object.create(null);
  for (const name of declaredComponents(manifest)) declared[name] = manifest.coordinates[name];
  return Object.freeze({
    ...declared,
    rappid: frame.stream_id ?? null,
    // The canonical rational text, so 1 and "1" are one cadence everywhere.
    // A declared-but-unreadable cadence renders as itself rather than as null,
    // so two dimensions whose clock keys are both unusable but DIFFERENT do not
    // pair as though they agreed. Absent stays null: declaring no cadence is a
    // different thing from declaring one nobody can parse.
    clock: manifest.clock_key === undefined || manifest.clock_key === null
      ? null
      : (clockText(parseClock(manifest.clock_key))
        ?? `unreadable:${canonical(String(manifest.clock_key))}`),
    tick: typeof frame.seq === "number" ? frame.seq : null,
    digest: frame.payload_hash ?? null,
  });
}

/**
 * Canonical, machine-independent rendering of a key over a chosen set of
 * components. Two machines that never communicate produce the same string.
 */
export function keyString(key, components = COMPONENTS) {
  const chosen = [...components].sort();
  const picked = {};
  for (const component of chosen) {
    if (typeof component !== "string" || !component) {
      throw new Error(`a key component must be a non-empty name, got ${String(component)}`);
    }
    // A component outside the built-in set is allowed: a dimension may declare
    // its own, and refusing them here contradicted the specification. An
    // undeclared component simply reads as null, which is what a coordinate
    // nobody stated should be.
    picked[component] = key?.[component] ?? null;
  }
  return `${PROTOCOL}\n${canonical({ components: chosen, at: picked })}`;
}

function addressOf(frame, source) {
  return Object.freeze({
    dimension: source.manifest?.dimension_id ?? null,
    stream_id: frame.stream_id ?? null,
    seq: frame.seq ?? null,
    payload_hash: frame.payload_hash ?? null,
    frame_hash: frame.frame_hash ?? null,
  });
}

function deepFreeze(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  Object.freeze(value);
  for (const item of Object.values(value)) deepFreeze(item, seen);
  return value;
}

/**
 * A frozen copy of a frame — never the caller's own object.
 *
 * Freezing in place looked like enforcing inertness and was itself a mutation:
 * it changed an object the caller owns, so their later writes began failing
 * silently, or throwing under strict mode, in code that never called this
 * module. A dimension owns its copy; the caller keeps theirs.
 *
 * RAPP/1 frames are I-JSON by construction — rapp-protocol validates exactly
 * that — so a JSON round trip is a faithful copy. Anything that will not round
 * trip is not a frame this module can work with, and is passed through
 * untouched rather than silently altered.
 */
function frozenCopy(frame) {
  if (!frame || typeof frame !== "object") return frame;
  try {
    return deepFreeze(JSON.parse(JSON.stringify(frame)));
  } catch {
    return frame;
  }
}

/**
 * A dimension is a manifest (which carries the clock key) plus its frames.
 * The frames are frozen through: a dimension that says it is inert must be.
 */
export function dimension(manifest, frames) {
  return Object.freeze({
    manifest: Object.freeze({ ...manifest }),
    frames: Object.freeze([...frames].map(frozenCopy)),
  });
}

/** Canonical enumeration order — derived from the frames, never the array order. */
function canonicalOrder(frames) {
  return [...frames].sort((a, b) => {
    const sa = a.stream_id ?? "";
    const sb = b.stream_id ?? "";
    if (sa !== sb) return sa < sb ? -1 : 1;
    if (a.seq !== b.seq) return (a.seq ?? 0) - (b.seq ?? 0);
    const ha = a.frame_hash ?? "";
    const hb = b.frame_hash ?? "";
    return ha < hb ? -1 : ha > hb ? 1 : 0;
  });
}

/**
 * Build the lookups for a dimension. An index is a convenience: it narrows the
 * candidates and never decides a merge.
 */
export function indexDimension(source, { lookups = DEFAULT_LOOKUPS } = {}) {
  const tables = new Map();
  for (const components of lookups) {
    const table = new Map();
    for (const frame of canonicalOrder(source.frames)) {
      const at = keyString(quantumKey(frame, source.manifest), components);
      const bucket = table.get(at);
      if (bucket) bucket.push(frame);
      else table.set(at, [frame]);
    }
    tables.set(keyString({}, components), { components, table });
  }
  return { source, tables };
}

// ── the drill ───────────────────────────────────────────────────────────────

/**
 * Search for pairs. Mutates nothing, merges nothing, advances no lineage —
 * a search that cannot change anything can run constantly and be wrong every
 * time without costing more than the search.
 *
 * How far it goes is how long the person is willing to wait. The enumeration
 * order is derived from the frames themselves, so a bigger budget returns a
 * superset of a smaller one on any machine, whatever order the caller's array
 * happened to be in.
 */
export function drill(local, remote, {
  lookups = DEFAULT_LOOKUPS,
  budget = null,
  fanoutCap = DEFAULT_FANOUT_CAP,
} = {}) {
  const limit = Number.isFinite(budget?.pairs) ? budget.pairs : Infinity;
  const deadline = Number.isFinite(budget?.deadlineMs) ? budget.deadlineMs : null;
  const startedAt = deadline === null ? 0 : Date.now();
  const skip = Number.isFinite(budget?.resumeAfter) ? budget.resumeAfter : 0;

  const remoteIndex = indexDimension(remote, { lookups });
  const localOrder = canonicalOrder(local.frames);
  const found = new Map();
  const seen = new Set();
  const capped = [];
  let searched = 0;
  let position = 0;
  let stoppedEarly = false;

  outer:
  for (const components of lookups) {
    const lane = remoteIndex.tables.get(keyString({}, components));
    for (const here of localOrder) {
      // The deadline governs the search, not only the hits — a long fruitless
      // sweep is exactly the case a person is waiting through.
      if (deadline !== null && Date.now() - startedAt > deadline) {
        stoppedEarly = true;
        break outer;
      }
      searched += 1;
      const at = keyString(quantumKey(here, local.manifest), components);
      const candidates = lane.table.get(at) || [];
      if (candidates.length > fanoutCap) {
        // A repeated payload matches every one of its twins. Say what was left
        // unexamined rather than silently sampling it. This is reported through
        // `capped` and does NOT mean the budgeted walk stopped early — those are
        // different facts and conflating them made `exhausted` meaningless.
        capped.push(Object.freeze({
          key: at, matched: candidates.length, examined: fanoutCap,
        }));
      }
      for (const there of candidates.slice(0, fanoutCap)) {
        const identity = `${here.frame_hash}|${there.frame_hash}`;
        if (seen.has(identity)) {
          // Already enumerated on an earlier lane. Record the extra lane if the
          // pair is in this call's result; if the cursor skipped it, it stays
          // skipped. Either way it is not a new position.
          const existing = found.get(identity);
          if (existing) {
            existing.via.push([...components]);
            existing.keys.push(at);
          }
          continue;
        }

        // The cursor is a position in this fixed enumeration, counting every
        // unique pair whether it was skipped or stored. A pair is only marked
        // seen once it has been ACCOUNTED for — if the budget stops us here we
        // leave the position untouched, so resuming from it yields exactly the
        // tail and never re-delivers what was already returned.
        if (position < skip) {
          seen.add(identity);
          position += 1;
          continue;
        }
        if (found.size >= limit
          || (deadline !== null && Date.now() - startedAt > deadline)) {
          stoppedEarly = true;
          break outer;
        }
        seen.add(identity);
        position += 1;
        found.set(identity, {
          key: at,
          keys: [at],
          via: [[...components]],
          here: addressOf(here, local),
          there: addressOf(there, remote),
        });
      }
    }
  }

  const pairs = [...found.values()]
    .map((pair) => Object.freeze({
      ...pair,
      keys: Object.freeze([...pair.keys].sort()),
      via: Object.freeze(pair.via.map((components) => Object.freeze(components))),
    }))
    .sort((a, b) => (a.here.seq - b.here.seq)
      || (a.here.frame_hash < b.here.frame_hash ? -1 : a.here.frame_hash > b.here.frame_hash ? 1 : 0)
      || (a.there.frame_hash < b.there.frame_hash ? -1 : 1));

  return Object.freeze({
    protocol: PROTOCOL,
    searched,
    hits: pairs.length,
    pairs: Object.freeze(pairs),
    // Whether the budgeted walk reached the end of the search space. A fan-out
    // cap does not make this false: the walk finished, and `capped` separately
    // names each coordinate whose candidates were too numerous to examine.
    exhausted: !stoppedEarly,
    // A position in the fixed enumeration. Passing it back as budget.resumeAfter
    // continues from exactly here.
    resumeAfter: position,
    capped: Object.freeze(capped),
  });
}

/** The hit pulls the entire frame — not a digest, not a description. */
export function pull(source, address) {
  const found = source.frames.find((frame) => frame.frame_hash === address.frame_hash);
  if (!found) throw new Error(`no frame at ${address.frame_hash} in this dimension`);
  return found;
}

/**
 * Identical bytes reached along different ancestries. Identical bytes with the
 * same ancestry is the same frame twice and pins nothing.
 */
export function fixedPoints(pairs) {
  return Object.freeze(pairs.filter((pair) => (
    pair.here.payload_hash === pair.there.payload_hash
    && pair.here.frame_hash !== pair.there.frame_hash
  )));
}

// ── diagonals ───────────────────────────────────────────────────────────────

/**
 * The exact lane a point sits on. Two points share a diagonal when
 * there.seq*d - n*here.seq is equal, in integers, with no division anywhere.
 */
/** The numeric diagonal inside a composite lane key. */
function laneValue(lane) {
  return BigInt(String(lane).split("\u0000").pop());
}

function placeable(point) {
  return Number.isSafeInteger(point?.here?.seq) && Number.isSafeInteger(point?.there?.seq);
}

/**
 * The exact lane a point sits on. Callers must filter with placeable() first —
 * a frame from another dimension can carry a fractional or absent seq, and
 * converting that to a BigInt throws. A foreign frame is refusable input, not a
 * crash: one bad frame used to kill the whole run computation.
 */
function laneOf(point, ratio) {
  return BigInt(point.there.seq) * ratio.d - ratio.n * BigInt(point.here.seq);
}

/**
 * Contiguous spans of fixed points along each diagonal.
 *
 * Adjacency is symmetric: on a reduced ratio n/d, the next point along a
 * diagonal is d local ticks and n of theirs away. That is why a five-frame
 * match reports length five from either side — the old form assumed the local
 * tick always advanced by one, which was true only for the coarser dimension.
 */
export function runsFrom(points, local, remote) {
  const ratio = ratioOf(parseClock(local.manifest?.clock_key), parseClock(remote.manifest?.clock_key));
  if (!ratio) return Object.freeze([]);

  const substantive = new Set(
    local.frames.filter((frame) => isSubstantive(frame)).map((frame) => frame.frame_hash),
  );
  const assertedBy = new Map(
    local.frames.map((frame) => [frame.frame_hash, assertsOf(frame)]),
  );

  const byLane = new Map();
  for (const point of points) {
    if (!placeable(point)) continue;
    // The lane is the diagonal AND the capability. Grouping on tick arithmetic
    // alone let two unrelated streams whose ticks happened to line up be
    // reported as one run — a fidelity claim about a coincidence.
    const lane = `${point.here.stream_id}\u0000${point.there.stream_id}\u0000${laneOf(point, ratio)}`;
    const bucket = byLane.get(lane);
    if (bucket) bucket.push(point);
    else byLane.set(lane, [point]);
  }

  const runs = [];
  for (const [lane, group] of byLane) {
    const ordered = [...group].sort((a, b) => (a.here.seq - b.here.seq)
      || (a.here.frame_hash < b.here.frame_hash ? -1 : 1));
    const stepHere = Number(ratio.d);
    const stepThere = Number(ratio.n);
    let current = null;

    const close = (boundary) => {
      if (!current) return;
      if (!boundary) throw new Error("a run must record why it ended");
      runs.push(Object.freeze({
        lane,
        offset: Number(laneValue(lane)) / Number(ratio.d),
        startHere: current.startHere,
        startThere: current.startThere,
        endHere: current.endHere,
        endThere: current.endThere,
        length: current.points.length,
        substance: current.substance,
        // What matched, not only how much — a stated proof obligation. Keys AND
        // values, because "three frames asserted something" is not a record of
        // what they asserted.
        asserted: Object.freeze({ ...current.asserted }),
        // And per tick, in order. The flat merge above is last-write-wins, so a
        // run of five frames each asserting the same key presented as one fact
        // and looked identical to a run of one.
        assertedByTick: Object.freeze([...current.assertedByTick]),
        points: Object.freeze(current.points),
        boundary: boundary ? Object.freeze(boundary) : null,
      }));
      current = null;
    };

    const take = (point) => {
      current.points.push(point);
      current.endHere = point.here.seq;
      current.endThere = point.there.seq;
      if (substantive.has(point.here.frame_hash)) current.substance += 1;
      const said = assertedBy.get(point.here.frame_hash) || {};
      Object.assign(current.asserted, said);
      current.assertedByTick.push(Object.freeze({
        here: point.here.seq, asserts: Object.freeze({ ...said }),
      }));
    };

    // A local tick can have more than one partner on the same lane — two remote
    // frames at the same tick with the same bytes. Both are real pairings, so
    // the extras become their own runs rather than being dropped for arriving
    // second. Every fixed point is a chance to merge.
    const primary = [];
    const alternates = [];
    let lastTick = null;
    for (const point of ordered) {
      if (point.here.seq === lastTick) alternates.push(point);
      else { primary.push(point); lastTick = point.here.seq; }
    }

    for (const point of primary) {
      if (current && point.here.seq !== current.endHere + stepHere) {
        // The boundary is the first tick at which the match stopped — the tick
        // after the run's last matching one, not the next tick that matched.
        close({
          at: current.endHere + stepHere,
          reason: "the frames stopped matching",
          resumedAt: point.here.seq,
        });
      }
      if (!current) {
        current = {
          startHere: point.here.seq,
          startThere: point.there.seq,
          endHere: point.here.seq,
          endThere: point.there.seq,
          points: [],
          substance: 0,
          asserted: Object.create(null),
          assertedByTick: [],
        };
        take(point);
        continue;
      }
      take(point);
    }
    // A run that simply reached the end of the frames still names where it
    // stopped; recording null there loses the length it earned.
    close(current
      ? { at: current.endHere + stepHere, reason: "no further matching frame", resumedAt: null }
      : null);

    for (const point of alternates) {
      runs.push(Object.freeze({
        lane,
        offset: Number(laneValue(lane)) / Number(ratio.d),
        startHere: point.here.seq,
        startThere: point.there.seq,
        endHere: point.here.seq,
        endThere: point.there.seq,
        length: 1,
        substance: substantive.has(point.here.frame_hash) ? 1 : 0,
        asserted: Object.freeze({ ...(assertedBy.get(point.here.frame_hash) || {}) }),
        // What each matching frame asserted, in order — a flat merge presented a
        // long meaningful run as a single fact, losing exactly the substance the
        // record exists to show.
        assertedByTick: Object.freeze([Object.freeze({
          here: point.here.seq,
          asserts: Object.freeze({ ...(assertedBy.get(point.here.frame_hash) || {}) }),
        })]),
        points: Object.freeze([point]),
        boundary: Object.freeze({
          at: point.here.seq,
          reason: "an alternative partner at a tick another run already used",
          resumedAt: null,
        }),
      }));
    }
    void stepThere;
  }

  return Object.freeze([...runs].sort((a, b) => {
    if (b.length !== a.length) return b.length - a.length;
    if (b.substance !== a.substance) return b.substance - a.substance;
    // Exact lane, not the float offset — see the note in alignment().
    const la = laneValue(a.lane);
    const lb = laneValue(b.lane);
    const absA = la < 0n ? -la : la;
    const absB = lb < 0n ? -lb : lb;
    if (absA !== absB) return absA < absB ? -1 : 1;
    if (la !== lb) return la < lb ? -1 : 1;
    return a.startHere - b.startHere;
  }));
}

/**
 * Register the two dimensions against each other. The clock keys relate by an
 * exact ratio and a fixed point pins the phase, so placement is arithmetic.
 * Without a pin there is nothing to place against, and this refuses rather
 * than guesses.
 */
export function alignment(points, local, remote) {
  const here = parseClock(local.manifest?.clock_key);
  const there = parseClock(remote.manifest?.clock_key);
  if (!here || !there) {
    return Object.freeze({
      ok: false,
      reason: "both dimensions must declare a clock key that is a positive number",
    });
  }
  if (!points.length) {
    return Object.freeze({ ok: false, reason: "no fixed point: nothing pins the phase" });
  }
  const ratio = ratioOf(here, there);

  const lanes = new Map();
  const unplaceable = points.filter((point) => !placeable(point));
  for (const point of points) {
    if (!placeable(point)) continue;
    const lane = `${point.here.stream_id}\u0000${point.there.stream_id}\u0000${laneOf(point, ratio)}`;
    const pin = Object.freeze({
      here: point.here.seq,
      there: point.there.seq,
      offset: Number(laneValue(lane)) / Number(ratio.d),
    });
    const bucket = lanes.get(lane);
    if (bucket) bucket.push(pin);
    else lanes.set(lane, [pin]);
  }

  // Every lane is a path the two dimensions genuinely line up along. The one
  // with the most pins leads; the rest are alternates and can be merged along
  // too. More paths is more to assimilate, not ambiguity to resolve.
  const ordered = [...lanes.entries()]
    .map(([lane, pins]) => Object.freeze({
      lane,
      offset: pins[0].offset,
      pins: Object.freeze([...pins].sort((a, b) => a.here - b.here)),
    }))
    // Ties break on the EXACT lane, never on the float offset. Number() maps
    // distinct BigInt lanes onto the same double past 2^53, so a float
    // comparator returns 0 for genuinely different diagonals and the winner
    // becomes whichever happened to be inserted first — array order deciding a
    // merge, which is the exact thing this module claims it never does.
    .sort((a, b) => {
      if (b.pins.length !== a.pins.length) return b.pins.length - a.pins.length;
      const la = laneValue(a.lane);
      const lb = laneValue(b.lane);
      const absA = la < 0n ? -la : la;
      const absB = lb < 0n ? -lb : lb;
      if (absA !== absB) return absA < absB ? -1 : 1;
      return la === lb ? 0 : (la < lb ? -1 : 1);
    });

  if (!ordered.length) {
    return Object.freeze({
      ok: false,
      reason: "every fixed point carries a tick that is not a whole number, so none can be placed",
      unplaceable: Object.freeze(unplaceable.map((point) => point.here.frame_hash)),
    });
  }

  const primary = ordered[0];
  return Object.freeze({
    ok: true,
    // Fixed points whose ticks are not whole numbers cannot sit on a diagonal.
    // Named rather than silently dropped.
    unplaceable: Object.freeze(unplaceable.map((point) => point.here.frame_hash)),
    ratio: Number(ratio.n) / Number(ratio.d),
    exactRatio: Object.freeze({ n: ratio.n, d: ratio.d }),
    lane: primary.lane,
    offset: primary.offset,
    pins: primary.pins,
    paths: Object.freeze(ordered),
    // Pins on a path other than the primary one. Named `alternatePins` because
    // that is what they are: two dimensions can genuinely line up more than one
    // way, and calling every such pin a disagreement reported divergence
    // between dimensions that never diverged. Kept under the old name too, so a
    // caller reading it does not silently get undefined.
    alternatePins: Object.freeze(ordered.slice(1).flatMap((path) => path.pins)),
    disagreeing: Object.freeze(ordered.slice(1).flatMap((path) => path.pins)),
  });
}

/**
 * Where a local tick lands in the other dimension, as an exact rational.
 * Every decision inside this module uses this form; the convenience wrapper
 * below returns a Number for display and must not be compared for equality.
 */
export function placeThereExact(align, hereSeq) {
  if (!align?.ok) throw new Error(`cannot place without an alignment: ${align?.reason}`);
  const { n, d } = align.exactRatio;
  const lane = laneValue(align.lane);
  return Object.freeze({ n: n * BigInt(hereSeq) + lane, d });
}

/**
 * The same placement as a Number, for printing. Named honestly: this divides in
 * binary64 and therefore rounds, so it is a rendering of the answer rather than
 * the answer. Use placeThereExact for anything that decides something.
 */
export function placeThere(align, hereSeq) {
  const { n, d } = placeThereExact(align, hereSeq);
  return Number(n) / Number(d);
}

// ── the line ────────────────────────────────────────────────────────────────

/** A line is an ordered chain of frames plus its HEAD. */
export function makeLine(frames) {
  const ordered = [...frames].map(frozenCopy);
  return Object.freeze({
    frames: Object.freeze(ordered),
    head: ordered.length ? ordered[ordered.length - 1].frame_hash : null,
  });
}

function descendantsOf(line, fromFrameHash) {
  if (!fromFrameHash) return line.frames;
  const index = line.frames.findIndex((frame) => frame.frame_hash === fromFrameHash);
  return index < 0 ? line.frames : line.frames.slice(index + 1);
}

/**
 * What the line has asserted, folded in chain order. Reporting only — nothing
 * refuses on the strength of it.
 *
 * An earlier attempt used these as sticky facts that a later frame could
 * contradict, and it was wrong in three directions at once: folding a
 * byte-identical twin permanently blocked every later update to that key,
 * a fact once settled could never be superseded, and the join grew by the whole
 * accumulated history until it hit RAPP/1's 1 MiB ceiling and the line could
 * never fold again. `phase: morning` followed by `phase: noon` is time passing.
 * Only a descendant's declared precondition refuses anything.
 */
export function established(line) {
  const facts = Object.create(null);
  for (const frame of line.frames) {
    for (const [key, value] of Object.entries(assertsOf(frame))) facts[key] = value;
  }
  return facts;
}

/**
 * Backward fidelity: a frame is assimilated only if it contradicts nothing
 * downstream. A descendant that requires a key the incoming frame asserts
 * differently would be silently invalidated by the merge, so the frame is
 * refused — whole. A frame with pieces removed existed in neither dimension,
 * and the fold is not entitled to invent one.
 */
export function compatibility(incoming, line, { from = null } = {}) {
  const asserts = assertsOf(incoming);
  const contradicts = [];

  for (const descendant of descendantsOf(line, from)) {
    const requires = requiresOf(descendant);
    for (const key of Object.keys(requires)) {
      if (!Object.hasOwn(asserts, key)) continue;
      const verdict = equalValues(asserts[key], requires[key]);
      if (!verdict.ok) {
        contradicts.push(Object.freeze({
          descendant: descendant.frame_hash, key, unencodable: true, reason: verdict.reason,
        }));
      } else if (!verdict.equal) {
        contradicts.push(Object.freeze({
          descendant: descendant.frame_hash,
          key,
          required: requires[key],
          asserted: asserts[key],
        }));
      }
    }
  }

  return contradicts.length
    ? Object.freeze({ ok: false, contradicts: Object.freeze(contradicts) })
    : Object.freeze({ ok: true, contradicts: Object.freeze([]) });
}

/** Dream Catcher ordering: (frame_tick, utc_timestamp), with the hash as the last tiebreak. */
function foldOrder(left, right) {
  if (left.seq !== right.seq) return left.seq - right.seq;
  if (left.utc !== right.utc) return left.utc < right.utc ? -1 : 1;
  return left.frame_hash < right.frame_hash ? -1 : left.frame_hash > right.frame_hash ? 1 : 0;
}

/**
 * Fold compatible incoming frames into the local line and continue from the
 * joined frame. Append-only: nothing is overwritten, the inputs are untouched,
 * and the local chain gains exactly one frame — the join, which names by hash
 * every frame it assimilated.
 *
 * The join is verified before it is returned. Minting a frame the frame spec
 * rejects would break the one claim this module makes about RAPP/1.
 */
export function assimilate(line, incoming, {
  from = null,
  streamId = null,
  utc = null,
  fidelity = null,
} = {}) {
  const candidates = [...incoming].sort(foldOrder);
  const merged = [];
  const refused = [];
  // Null prototype, deliberately: a key named __proto__ written through [[Set]]
  // on an ordinary object hits the prototype setter instead of becoming data.
  // An asserted key is data whatever it is called.
  const foldAsserts = Object.create(null);
  const foldRequires = Object.create(null);
  let working = line;

  for (const frame of candidates) {
    const verdict = compatibility(frame, working, { from });
    if (!verdict.ok) {
      refused.push(Object.freeze({ frame: frame.frame_hash, contradicts: verdict.contradicts }));
      continue;
    }
    merged.push(frame);
    for (const [key, value] of Object.entries(assertsOf(frame))) foldAsserts[key] = value;
    for (const [key, value] of Object.entries(requiresOf(frame))) foldRequires[key] = value;
    working = Object.freeze({ frames: Object.freeze([...working.frames, frame]), head: frame.frame_hash });
  }

  if (!merged.length) {
    return Object.freeze({
      joined: null, head: line.head, line, merged: Object.freeze([]),
      refused: Object.freeze(refused),
    });
  }

  const localHead = line.frames.length ? line.frames[line.frames.length - 1] : null;
  const last = merged[merged.length - 1];
  const streamOfRecord = streamId || localHead?.stream_id || last.stream_id;

  if (typeof streamOfRecord === "string" && streamOfRecord.startsWith("net:")) {
    // RAPP/1 requires prev_wave to equal the swarm head and requires a
    // signature on a swarm frame. Neither is this module's to mint, so it
    // refuses rather than producing a frame the spec rejects.
    return Object.freeze({
      joined: null,
      head: line.head,
      line,
      merged: Object.freeze([]),
      refused: Object.freeze([
        ...refused,
        ...merged.map((frame) => Object.freeze({
          frame: frame.frame_hash,
          contradicts: Object.freeze([Object.freeze({
            key: "stream_id",
            reason: "a swarm stream needs a signed join with prev_wave at the swarm head",
          })]),
        })),
      ]),
    });
  }

  const joinUtc = utc || (localHead && localHead.utc > last.utc ? localHead.utc : last.utc);

  let joined;
  try {
    joined = buildFrame({
      kind: "qqdrill.join",
      streamId: streamOfRecord,
      seq: (localHead?.seq ?? -1) + 1,
      utc: joinUtc,
      payload: {
        protocol: PROTOCOL,
        // What THIS fold assimilated — not the accumulated history. Inherited
        // facts are already on the line in the joins that recorded them, and
        // re-asserting them grew the payload until it hit RAPP/1's 1 MiB limit
        // and the line could never be folded again.
        //
        // Object.fromEntries defines own properties, so an asserted __proto__
        // travels as data rather than mutating the payload.
        asserts: Object.fromEntries(Object.entries(foldAsserts)),
        // The preconditions of the frames this fold absorbed. Carrying them
        // makes the join a descendant that declares what its contents needed,
        // so a candidate offered in a LATER call meets exactly the constraints
        // it would have met arriving in this one.
        requires: Object.fromEntries(Object.entries(foldRequires)),
        assimilated: merged.map((frame) => frame.frame_hash),
        refused: refused.map((entry) => entry.frame),
        // Fidelity travels with the join, so the lineage records which spans
        // were determined and which were not, rather than one flat number.
        fidelity: fidelity
          ? fidelity.map((run) => ({
            startHere: run.startHere, endHere: run.endHere,
            length: run.length, substance: run.substance,
          }))
          : [],
      },
      prev: localHead ? localHead.payload_hash : null,
      prevWave: null,
    });
  } catch (error) {
    // Every frame that was going to be merged is now refused, and each is named.
    // A frame that is neither merged nor refused has silently vanished.
    return Object.freeze({
      joined: null, head: line.head, line, merged: Object.freeze([]),
      refused: Object.freeze([...refused, ...merged.map((frame) => Object.freeze({
        frame: frame.frame_hash,
        contradicts: Object.freeze([Object.freeze({ key: "payload", reason: error.message })]),
      }))]),
    });
  }

  const [valid, , why] = verifyFrame(joined, { head: localHead, streamIdOfRecord: streamOfRecord });
  if (!valid) {
    return Object.freeze({
      joined: null, head: line.head, line, merged: Object.freeze([]),
      refused: Object.freeze([...refused, ...merged.map((frame) => Object.freeze({
        frame: frame.frame_hash,
        contradicts: Object.freeze([Object.freeze({ key: "join", reason: `RAPP/1 refused the join: ${why}` })]),
      }))]),
    });
  }

  const frames = Object.freeze([...line.frames, deepFreeze(joined)]);
  return Object.freeze({
    joined,
    head: joined.frame_hash,
    line: Object.freeze({ frames, head: joined.frame_hash }),
    merged: Object.freeze([...merged]),
    refused: Object.freeze(refused),
  });
}

/**
 * Retroactive zoom. A dimension at a finer clock holds more frames across the
 * same span of your time; assimilating them raises the resolution of a past you
 * have already lived through. Retroactive, not revisionist: the finer frames
 * refine an interval, may contradict neither the frame they refine nor anything
 * downstream of it, and a span with no fixed point in it is guesswork and is
 * refused as such.
 */
export function zoom(span, finer, align, line) {
  if (!align?.ok) {
    return Object.freeze({ ok: false, reason: align?.reason || "no alignment" });
  }
  const { n, d } = align.exactRatio;
  if (!(n > d)) {
    return Object.freeze({ ok: false, reason: "the other dimension is not running a finer clock" });
  }
  const pinned = align.pins.some((pin) => pin.here >= span.start && pin.here <= span.end);
  if (!pinned) {
    return Object.freeze({ ok: false, reason: "no fixed point inside the span: placement would be guesswork" });
  }

  const lane = laneValue(align.lane);
  const coarse = line.frames.filter((frame) => frame.seq >= span.start && frame.seq <= span.end);
  const refined = [];
  const refused = [];

  for (const frame of [...finer].sort(foldOrder)) {
    if (!Number.isSafeInteger(frame.seq)) {
      // A foreign frame with a fractional or absent tick cannot be placed. Say
      // so rather than throwing on the BigInt conversion or dropping it.
      refused.push(Object.freeze({
        frame: frame.frame_hash,
        contradicts: Object.freeze([Object.freeze({
          key: "seq", reason: "tick is not a whole number, so the frame cannot be placed",
        })]),
      }));
      continue;
    }
    // lane = there*d - n*here, so here = (there*d - lane) / n, exactly.
    // Floor by integer division so a placement never depends on a float's last bit.
    const num = BigInt(frame.seq) * d - lane;
    // A span of coarse ticks [start, end] covers the INTERVAL from start up to
    // just before end+1. Bounding at exactly end dropped every finer frame
    // sitting between two coarse ticks — silently, into neither refined nor
    // refused — which is the whole point of zooming.
    if (num < BigInt(span.start) * n || num >= BigInt(span.end + 1) * n) continue;
    let whole = num / n;
    if (num % n !== 0n && num < 0n) whole -= 1n;
    const at = Number(num) / Number(n);
    const covering = coarse.find((candidate) => BigInt(candidate.seq) === whole);
    if (!covering) {
      // Attributing a frame to an interval it does not sit in is how a real
      // contradiction slips through. Refuse instead.
      refused.push(Object.freeze({
        frame: frame.frame_hash, at,
        contradicts: Object.freeze([Object.freeze({
          key: "placement", reason: "lands outside every coarse frame in the span",
        })]),
      }));
      continue;
    }

    const asserts = assertsOf(frame);
    const contradicts = [];
    for (const [key, value] of Object.entries(assertsOf(covering))) {
      if (!Object.hasOwn(asserts, key)) continue;
      const verdict = equalValues(asserts[key], value);
      if (!verdict.ok) {
        contradicts.push(Object.freeze({ refines: covering.frame_hash, key, unencodable: true, reason: verdict.reason }));
      } else if (!verdict.equal) {
        contradicts.push(Object.freeze({ refines: covering.frame_hash, key, coarse: value, finer: asserts[key] }));
      }
    }
    // Backward fidelity is about the whole downstream line, not one frame.
    const downstream = compatibility(frame, line, { from: covering.frame_hash });
    if (!downstream.ok) contradicts.push(...downstream.contradicts);

    if (contradicts.length) {
      refused.push(Object.freeze({ frame: frame.frame_hash, at, contradicts: Object.freeze(contradicts) }));
    } else {
      refined.push(Object.freeze({
        frame,
        // The exact position, and a float rendering for display. The float can
        // read 192156999999.99997 where the exact value is 192157000000, so a
        // caller that compares `at` against the frame named in `refines` must
        // use atExact.
        atExact: Object.freeze({ n: num, d: n }),
        at,
        refines: covering.frame_hash,
      }));
    }
  }

  return Object.freeze({
    ok: true,
    span: Object.freeze({ ...span }),
    resolution: Object.freeze({ before: coarse.length, after: coarse.length + refined.length }),
    refined: Object.freeze(refined),
    refused: Object.freeze(refused),
  });
}

export const qqdrillInternals = Object.freeze({
  foldOrder, descendantsOf, addressOf, equalValues, parseClock, ratioOf, laneOf, canonicalOrder,
});
