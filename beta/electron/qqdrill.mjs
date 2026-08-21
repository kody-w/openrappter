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
// frames it assimilated in its payload instead. The payload is hashed into
// frame_hash, so that ancestry claim is bound just as tightly, and the local
// chain stays a valid single-parent RAPP/1 chain.
//
// Mechanism lives here. Policy — which components to index, how to weight
// substance, what threshold calls a span determined — is injected, and the
// default below is a plain example rather than a ceiling.

import { H, buildFrame, canonical } from "./rapp-protocol.mjs";

export const PROTOCOL = "rapp-qqdrill/1.0";

/** The coordinate components this protocol knows how to address. */
export const COMPONENTS = Object.freeze(["rappid", "clock", "tick", "digest"]);

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

function equalValues(left, right) {
  return canonical(left ?? null) === canonical(right ?? null);
}

function assertsOf(frame) {
  const asserts = frame?.payload?.asserts;
  return asserts && typeof asserts === "object" && !Array.isArray(asserts)
    ? asserts
    : {};
}

function requiresOf(frame) {
  const requires = frame?.payload?.requires;
  return requires && typeof requires === "object" && !Array.isArray(requires)
    ? requires
    : {};
}

/**
 * A frame is substantive when it asserts something. A frame that asserts
 * nothing can contradict nothing, and a run of them is cheap agreement — it
 * must not read as strongly as a run of frames that each said something.
 */
export function isSubstantive(frame) {
  return Object.keys(assertsOf(frame)).length > 0;
}

/** The composite coordinate of a frame. Computed about frames, never stored in them. */
export function quantumKey(frame, manifest = {}) {
  if (!frame || typeof frame !== "object") {
    throw new Error("quantumKey needs a RAPP/1 frame");
  }
  return Object.freeze({
    rappid: frame.stream_id ?? null,
    clock: manifest.clock_key ?? null,
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
    if (!COMPONENTS.includes(component)) {
      throw new Error(`unknown key component: ${component}`);
    }
    picked[component] = key?.[component] ?? null;
  }
  return `${PROTOCOL}\n${canonical({ components: chosen, at: picked })}`;
}

/** The address a pair reports. Addresses, not frames — pulling is a separate step. */
function addressOf(frame, dimension) {
  return Object.freeze({
    dimension: dimension.manifest?.dimension_id ?? null,
    stream_id: frame.stream_id ?? null,
    seq: frame.seq ?? null,
    payload_hash: frame.payload_hash ?? null,
    frame_hash: frame.frame_hash ?? null,
  });
}

/** A dimension is a manifest (which carries the clock key) plus its frames. */
export function dimension(manifest, frames) {
  return Object.freeze({
    manifest: Object.freeze({ ...manifest }),
    frames: Object.freeze([...frames]),
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
    for (const frame of source.frames) {
      const at = keyString(quantumKey(frame, source.manifest), components);
      const bucket = table.get(at);
      if (bucket) bucket.push(frame);
      else table.set(at, [frame]);
    }
    tables.set(keyString({}, components), { components, table });
  }
  return { source, tables };
}

/**
 * Search for pairs. Mutates nothing, merges nothing, advances no lineage —
 * a search that cannot change anything can run constantly and be wrong every
 * time without costing more than the search.
 */
export function drill(local, remote, {
  lookups = DEFAULT_LOOKUPS,
  budget = null,
} = {}) {
  // How far a drill goes is how long the person is willing to wait. The search
  // is enumerated in a fixed order, so a bigger budget returns a superset of a
  // smaller one: waiting longer only ever adds paths, and never invalidates a
  // pair already found. Whatever came back is usable immediately.
  const limit = Number.isFinite(budget?.pairs) ? budget.pairs : Infinity;
  const deadline = Number.isFinite(budget?.deadlineMs) ? budget.deadlineMs : null;
  const startedAt = deadline === null ? 0 : Date.now();
  const skip = Number.isFinite(budget?.resumeAfter) ? budget.resumeAfter : 0;

  const remoteIndex = indexDimension(remote, { lookups });
  const found = new Map();
  let searched = 0;
  let enumerated = 0;
  let exhausted = true;

  outer:
  for (const components of lookups) {
    const lane = remoteIndex.tables.get(keyString({}, components));
    for (const here of local.frames) {
      searched += 1;
      const at = keyString(quantumKey(here, local.manifest), components);
      for (const there of lane.table.get(at) || []) {
        // The same two frames reached by two lookups is one pair found two
        // ways, not two pairs. An index is a convenience; the key is the key.
        const identity = `${here.frame_hash}|${there.frame_hash}`;
        const existing = found.get(identity);
        if (existing) {
          existing.via.push([...components]);
          existing.keys.push(at);
          continue;
        }
        enumerated += 1;
        if (enumerated <= skip) continue;
        if (found.size >= limit
          || (deadline !== null && Date.now() - startedAt > deadline)) {
          exhausted = false;
          break outer;
        }
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
    // Whether the search ran out of space to look, or out of the patience it
    // was given. `resumeAfter` continues exactly where this one stopped.
    exhausted,
    resumeAfter: skip + found.size,
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

/**
 * Contiguous spans of fixed points. A run starts where frames begin matching
 * and ends at the first contradiction; the length it reached is what it earned,
 * and the boundary is kept rather than discarded.
 */
export function runsFrom(points, local, remote) {
  // A local tick can arrive with several candidate partners — a repeated
  // payload matches every one of its twins, and two dimensions can line up
  // along more than one path at once. Every one of those paths is a real
  // diagonal and a real chance to merge, so all of them are returned rather
  // than one being chosen and the rest discarded. A frame joined three ways is
  // one frame with three ancestries.
  const hereClock = Number(local.manifest?.clock_key) || 1;
  const thereClock = Number(remote.manifest?.clock_key) || 1;
  const ratio = thereClock / hereClock;

  const substantive = new Set(
    local.frames.filter((frame) => isSubstantive(frame)).map((frame) => frame.frame_hash),
  );

  // A diagonal is a constant offset: their tick advances by the clock ratio for
  // each of ours. Grouping by that offset separates the paths exactly.
  const byOffset = new Map();
  for (const point of points) {
    const offset = point.there.seq - ratio * point.here.seq;
    const lane = offset.toFixed(9);
    const bucket = byOffset.get(lane);
    if (bucket) bucket.points.push(point);
    else byOffset.set(lane, { offset, points: [point] });
  }

  const runs = [];
  for (const { offset, points: lane } of byOffset.values()) {
    const ordered = [...lane].sort((a, b) => (a.here.seq - b.here.seq)
      || (a.here.frame_hash < b.here.frame_hash ? -1 : 1));
    let current = null;

    const close = (boundary) => {
      if (!current) return;
      runs.push(Object.freeze({
        offset,
        startHere: current.startHere,
        startThere: current.startThere,
        endHere: current.endHere,
        endThere: current.endThere,
        length: current.points.length,
        substance: current.substance,
        points: Object.freeze(current.points),
        boundary: boundary ? Object.freeze(boundary) : null,
      }));
      current = null;
    };

    for (const point of ordered) {
      if (current && point.here.seq === current.endHere) continue;
      if (current && point.here.seq !== current.endHere + 1) {
        close({ at: point.here.seq, reason: "the frames stopped matching" });
      }
      if (!current) {
        current = {
          startHere: point.here.seq,
          startThere: point.there.seq,
          endHere: point.here.seq,
          endThere: point.there.seq,
          points: [point],
          substance: substantive.has(point.here.frame_hash) ? 1 : 0,
        };
        continue;
      }
      current.points.push(point);
      current.endHere = point.here.seq;
      current.endThere = point.there.seq;
      if (substantive.has(point.here.frame_hash)) current.substance += 1;
    }
    close(null);
  }

  // Longest first — a long run is the strongest evidence — then nearest
  // alignment, then position, so the order is the same on every machine.
  return Object.freeze([...runs].sort((a, b) => (b.length - a.length)
    || (b.substance - a.substance)
    || (Math.abs(a.offset) - Math.abs(b.offset))
    || (a.offset - b.offset)
    || (a.startHere - b.startHere)));
}

/**
 * Register the two dimensions against each other. The clock keys relate by
 * ratio and a fixed point pins the phase, so placement is arithmetic. Without a
 * pin there is nothing to place against, and this refuses rather than guesses.
 */
export function alignment(points, local, remote) {
  const here = Number(local.manifest?.clock_key);
  const there = Number(remote.manifest?.clock_key);
  if (!Number.isFinite(here) || here <= 0 || !Number.isFinite(there) || there <= 0) {
    return Object.freeze({ ok: false, reason: "both dimensions must declare a positive clock key" });
  }
  if (!points.length) {
    return Object.freeze({ ok: false, reason: "no fixed point: nothing pins the phase" });
  }
  const ratio = there / here;

  const lanes = new Map();
  for (const point of points) {
    const offset = point.there.seq - ratio * point.here.seq;
    const lane = offset.toFixed(9);
    const pin = Object.freeze({ here: point.here.seq, there: point.there.seq, offset });
    const bucket = lanes.get(lane);
    if (bucket) bucket.push(pin);
    else lanes.set(lane, [pin]);
  }

  // Every lane is a path the two dimensions genuinely line up along. The one
  // with the most pins leads; the rest are alternates and can be merged along
  // too. More paths is more to assimilate, not ambiguity to resolve.
  const ordered = [...lanes.values()]
    .map((pins) => Object.freeze({
      offset: pins[0].offset,
      pins: Object.freeze([...pins].sort((a, b) => a.here - b.here)),
    }))
    .sort((a, b) => (b.pins.length - a.pins.length)
      || (Math.abs(a.offset) - Math.abs(b.offset))
      || (a.offset - b.offset));

  const primary = ordered[0];
  return Object.freeze({
    ok: true,
    ratio,
    offset: primary.offset,
    pins: primary.pins,
    paths: Object.freeze(ordered),
    // Pins that sit on another path. Kept under the old name because a caller
    // that wanted one alignment still wants to know these exist.
    disagreeing: Object.freeze(ordered.slice(1).flatMap((path) => path.pins)),
  });
}

/** Where a local tick lands in the other dimension, by arithmetic. */
export function placeThere(align, hereSeq) {
  if (!align?.ok) throw new Error(`cannot place without an alignment: ${align?.reason}`);
  return align.ratio * hereSeq + align.offset;
}

/** A line is an ordered chain of frames plus its HEAD. */
export function makeLine(frames) {
  const ordered = [...frames];
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
    for (const [key, needed] of Object.entries(requires)) {
      if (key in asserts && !equalValues(asserts[key], needed)) {
        contradicts.push(Object.freeze({
          descendant: descendant.frame_hash,
          key,
          required: needed,
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
 * and the join records both parents — `prev` the local HEAD, `prev_wave` the
 * frame it joined with.
 */
export function assimilate(line, incoming, {
  from = null,
  streamId = null,
  utc = null,
} = {}) {
  const candidates = [...incoming].sort(foldOrder);
  const merged = [];
  const refused = [];
  const established = new Map();

  for (const frame of candidates) {
    const verdict = compatibility(frame, line, { from });
    if (!verdict.ok) {
      refused.push(Object.freeze({ frame: frame.frame_hash, contradicts: verdict.contradicts }));
      continue;
    }
    // Backward fidelity applies inside the fold too: a later candidate that
    // contradicts what an earlier one already established is refused, so the
    // outcome never depends on which frame happened to be folded last.
    const asserts = assertsOf(frame);
    const clashes = Object.entries(asserts)
      .filter(([key, value]) => established.has(key) && !equalValues(established.get(key), value))
      .map(([key, value]) => Object.freeze({
        withinFold: true,
        key,
        established: established.get(key),
        asserted: value,
      }));
    if (clashes.length) {
      refused.push(Object.freeze({ frame: frame.frame_hash, contradicts: Object.freeze(clashes) }));
      continue;
    }
    for (const [key, value] of Object.entries(asserts)) established.set(key, value);
    merged.push(frame);
  }

  if (!merged.length) {
    return Object.freeze({
      joined: null,
      head: line.head,
      line,
      merged: Object.freeze([]),
      refused: Object.freeze(refused),
    });
  }

  const localHead = line.frames.length ? line.frames[line.frames.length - 1] : null;
  const last = merged[merged.length - 1];
  const joinUtc = utc || (localHead && localHead.utc > last.utc ? localHead.utc : last.utc);
  const joined = buildFrame({
    kind: "qqdrill.join",
    streamId: streamId || localHead?.stream_id || last.stream_id,
    seq: (localHead?.seq ?? -1) + 1,
    utc: joinUtc,
    // The join carries forward what it assimilated, so everything downstream of
    // it sees those facts. prev_wave stays null: RAPP/1 reserves it for swarms.
    payload: {
      protocol: PROTOCOL,
      asserts: Object.fromEntries(established),
      assimilated: merged.map((frame) => frame.frame_hash),
      refused: refused.map((entry) => entry.frame),
    },
    prev: localHead ? localHead.payload_hash : null,
    prevWave: null,
  });

  // The local chain gains exactly one frame. The assimilated frames belong to
  // the dimension that produced them and are named by hash in the join, not
  // spliced into a chain they were never part of.
  const frames = Object.freeze([...line.frames, joined]);
  return Object.freeze({
    joined,
    head: joined.frame_hash,
    line: Object.freeze({ frames, head: joined.frame_hash }),
    merged: Object.freeze(merged),
    refused: Object.freeze(refused),
  });
}

/**
 * Retroactive zoom. A dimension at a finer clock holds more frames across the
 * same span of your time; assimilating them raises the resolution of a past you
 * have already lived through. Retroactive, not revisionist: the finer frames
 * refine an interval and may not contradict it, and a span with no fixed point
 * in it is guesswork and is refused as such.
 */
export function zoom(span, finer, align, line) {
  if (!align?.ok) {
    return Object.freeze({ ok: false, reason: align?.reason || "no alignment" });
  }
  if (!(align.ratio > 1)) {
    return Object.freeze({ ok: false, reason: "the other dimension is not running a finer clock" });
  }
  const pinned = align.pins.some((pin) => pin.here >= span.start && pin.here <= span.end);
  if (!pinned) {
    return Object.freeze({ ok: false, reason: "no fixed point inside the span: placement would be guesswork" });
  }

  const coarse = line.frames.filter((frame) => frame.seq >= span.start && frame.seq <= span.end);
  const refined = [];
  const refused = [];

  for (const frame of [...finer].sort(foldOrder)) {
    const here = (frame.seq - align.offset) / align.ratio;
    if (here < span.start || here > span.end) continue;
    const covering = coarse.find((candidate) => Math.floor(here) === candidate.seq)
      || coarse[coarse.length - 1];
    const contradicts = [];
    const asserts = assertsOf(frame);
    for (const [key, value] of Object.entries(assertsOf(covering))) {
      if (key in asserts && !equalValues(asserts[key], value)) {
        contradicts.push(Object.freeze({ refines: covering.frame_hash, key, coarse: value, finer: asserts[key] }));
      }
    }
    if (contradicts.length) {
      refused.push(Object.freeze({ frame: frame.frame_hash, contradicts: Object.freeze(contradicts) }));
    } else {
      refined.push(Object.freeze({ frame, at: here, refines: covering ? covering.frame_hash : null }));
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

export const qqdrillInternals = Object.freeze({ foldOrder, descendantsOf, addressOf, equalValues });
