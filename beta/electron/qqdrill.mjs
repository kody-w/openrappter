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
export function drill(local, remote, { lookups = DEFAULT_LOOKUPS } = {}) {
  const remoteIndex = indexDimension(remote, { lookups });
  const found = new Map();
  let searched = 0;

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
  // A repeated payload matches on the content lookup against every one of its
  // twins, so one local tick can arrive with several candidate partners. A run
  // is a diagonal through that: at each tick, take the partner that continues
  // the run, and only start a new one when nothing does.
  const byTick = new Map();
  for (const point of points) {
    const bucket = byTick.get(point.here.seq);
    if (bucket) bucket.push(point);
    else byTick.set(point.here.seq, [point]);
  }
  for (const bucket of byTick.values()) bucket.sort((a, b) => a.there.seq - b.there.seq);
  const ticks = [...byTick.keys()].sort((a, b) => a - b);

  const substantive = new Set(
    local.frames.filter((frame) => isSubstantive(frame)).map((frame) => frame.frame_hash),
  );

  const runs = [];
  let current = null;

  const close = (boundary) => {
    if (!current) return;
    runs.push(Object.freeze({
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

  const open = (point) => {
    current = {
      startHere: point.here.seq,
      startThere: point.there.seq,
      endHere: point.here.seq,
      endThere: point.there.seq,
      points: [point],
      substance: substantive.has(point.here.frame_hash) ? 1 : 0,
    };
  };

  for (const tick of ticks) {
    const candidates = byTick.get(tick);
    if (current && tick !== current.endHere + 1) {
      close({ at: tick, reason: "the frames stopped matching" });
    }
    const continues = current
      ? candidates.find((point) => point.there.seq === current.endThere + 1)
      : null;
    if (current && !continues) {
      close({ at: tick, reason: "the other dimension skipped a tick" });
    }
    if (current) {
      current.points.push(continues);
      current.endHere = continues.here.seq;
      current.endThere = continues.there.seq;
      if (substantive.has(continues.here.frame_hash)) current.substance += 1;
    } else {
      open(candidates[0]);
    }
  }
  close(null);
  return Object.freeze(runs);
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
  const pins = [...points]
    .sort((a, b) => a.here.seq - b.here.seq)
    .map((point) => Object.freeze({
      here: point.here.seq,
      there: point.there.seq,
      offset: point.there.seq - ratio * point.here.seq,
    }));
  const offset = pins[0].offset;
  const disagreeing = pins.filter((pin) => Math.abs(pin.offset - offset) > 1e-9);
  return Object.freeze({
    ok: true,
    ratio,
    offset,
    pins: Object.freeze(pins),
    disagreeing: Object.freeze(disagreeing),
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
