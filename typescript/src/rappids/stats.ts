/**
 * Creature stats, derived — never asserted, never estimated.
 *
 * Weight is exact integer bytes over unique verified content addresses. A
 * `(dimension, sha256)` pair counts once, so carrying the same asset twice
 * cannot make an organism heavier, and an unknown size makes the total
 * *incomplete* rather than approximate: `null` is the honest answer and a
 * guess is not.
 *
 * Lifecycle stage is derived state. It is a reading of how much verified body
 * an organism has accumulated, and it never touches the RAPPID — a Raptor and
 * the baby it grew from are the same creature with the same identity. Nothing
 * here infers maturity from file size.
 *
 * Mirrored by `python/openrappter/rappids/stats.py`.
 */

import { rappCanonicalJson } from './canonical.js';
import { bodyFrameToJson } from './store.js';
import type {
  BodyFrame,
  CreatureStats,
  DimensionSummary,
  LifecycleStage,
  LoadedOrganism,
  QuantumRappidSummary,
  VerificationReport,
} from './types.js';

/**
 * A versioned presentation curve over frame height.
 *
 * Height is how the habitat draws the creature. It is not identity and not a
 * physical fact, so it is versioned and kept away from every integrity path.
 */
export const SPECIES_HEIGHT_CURVE = {
  id: 'quantum-continuity/1',
  baseMm: 420,
  perFrameMm: 90,
  maxMm: 2400,
} as const;

/**
 * Frames that record evidence about the organism rather than a new sense.
 *
 * A census frame proves what verified today; it is not a dimension the
 * creature carries, and counting it as one would inflate the only stat that is
 * supposed to mean "this organism gained a way of being in the world".
 */
export const CENSUS_DIMENSION = 'census';

/**
 * What each stage requires, in the order they are tested.
 *
 * The thresholds are about *verified body*, which is why a compact organism
 * with one rich dimension stays a baby: the point of the ladder is that a
 * Raptor has proven durable memory and recorded skills, not that it has a
 * large file somewhere.
 */
export const STAGE_LADDER: ReadonlyArray<{
  stage: LifecycleStage;
  minFrameHeight: number;
  minActiveDimensions: number;
  requiredActive: readonly string[];
}> = [
  { stage: 'raptor', minFrameHeight: 8, minActiveDimensions: 4, requiredActive: ['memory', 'skill'] },
  { stage: 'hatchling', minFrameHeight: 2, minActiveDimensions: 2, requiredActive: [] },
  { stage: 'baby', minFrameHeight: 0, minActiveDimensions: 0, requiredActive: [] },
];

/**
 * How deep the accepted, unbroken history goes.
 *
 * Contiguous: the first frame that does not continue the chain ends the count,
 * because everything after it rests on a link that did not hold.
 */
export function contiguousFrameHeight(frames: readonly BodyFrame[]): number {
  let height = 0;
  let parent: string | null = null;
  for (const frame of frames) {
    if (frame.seq !== height) break;
    if (frame.prev !== parent) break;
    height += 1;
    parent = frame.payload_hash;
  }
  return height;
}

/** Bytes an accepted frame contributes: its own canonical body, counted once. */
function frameWeightBytes(frames: readonly BodyFrame[], height: number): number {
  const counted = new Set<string>();
  let total = 0;
  for (const frame of frames.slice(0, height)) {
    if (counted.has(frame.frame_hash)) continue;
    counted.add(frame.frame_hash);
    total += Buffer.byteLength(
      rappCanonicalJson(bodyFrameToJson(frame)),
      'utf8',
    );
  }
  return total;
}

export interface DimensionState extends DimensionSummary {
  /** True when this dimension points at content whose size is not known here. */
  unmeasured: boolean;
}

/**
 * Every dimension family the organism carries, declared or witnessed.
 *
 * Declared dimensions come from `rappid.json`; frames can witness families
 * that were not declared when the organism was minted, which is exactly what
 * growth is. Both are the same organism, so both are listed.
 */
export function dimensionStates(
  organism: LoadedOrganism,
  report: VerificationReport,
): DimensionState[] {
  const states = new Map<string, DimensionState>();
  const verified = new Set(
    report.assets
      .filter((asset) => asset.status === 'verified')
      .map((asset) => asset.dimension),
  );
  const brokenDimensions = new Set(
    report.assets.filter((asset) => asset.status !== 'verified').map((asset) => asset.dimension),
  );
  const failedChecks = new Set(
    report.checks.filter((check) => check.status === 'fail').map((check) => check.name.split('.')[0]),
  );

  for (const dimension of organism.document.dimensions) {
    const pathRefs = Object.values(dimension.refs).filter((ref) => ref.includes('/'));
    const externalRefs = Object.values(dimension.refs).filter((ref) => !ref.includes('/'));
    const hasLocalContent = verified.has(dimension.name) || pathRefs.length > 0;
    let status: DimensionSummary['status'];
    if (brokenDimensions.has(dimension.name) || failedChecks.has(dimension.name)) status = 'missing';
    else if (hasLocalContent) status = 'active';
    else status = 'linked';
    states.set(dimension.name, {
      name: dimension.name,
      status,
      ...(dimension.mediaTypes.length > 0 ? { mediaTypes: [...dimension.mediaTypes] } : {}),
      unmeasured: externalRefs.length > 0,
    });
  }

  for (const frame of organism.frames) {
    const dimension = frame.payload.dimension;
    if (states.has(dimension)) continue;
    states.set(dimension, {
      name: dimension,
      status: brokenDimensions.has(dimension) ? 'missing' : 'active',
      unmeasured: false,
    });
  }

  return [...states.values()].sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  );
}

export function deriveStats(
  organism: LoadedOrganism,
  report: VerificationReport,
  dimensions: readonly DimensionState[],
): CreatureStats {
  const frameHeight = contiguousFrameHeight(organism.frames);
  const uniqueVerified = new Map<string, number>();
  for (const asset of report.assets) {
    if (asset.status !== 'verified') continue;
    uniqueVerified.set(
      `${asset.addressSpace}:${asset.addressHash}`,
      asset.expectedBytes,
    );
  }
  let assetWeight = 0;
  for (const bytes of uniqueVerified.values()) assetWeight += bytes;
  const residentWeightBytes = assetWeight + frameWeightBytes(organism.frames, frameHeight);

  // Known-but-absent bytes are only *known* if the manifest that recorded them
  // verified. Otherwise there is no attestation behind the number at all.
  const manifestTrusted = !report.checks.some(
    (check) => check.status === 'fail' && check.name === 'sonic.manifest',
  );
  const linkedUnique = new Map<string, number>();
  if (manifestTrusted) {
    for (const asset of report.assets) {
      if (asset.status !== 'missing') continue;
      const contentKey = asset.addressHash
        ? `${asset.addressSpace}:${asset.addressHash}`
        : `sha256:${asset.expectedSha256}`;
      linkedUnique.set(
        contentKey,
        asset.expectedBytes,
      );
    }
  }
  let linkedKnown = 0;
  for (const bytes of linkedUnique.values()) linkedKnown += bytes;

  const unmeasured = dimensions.some((dimension) => dimension.unmeasured);
  const linkedWeightBytes = unmeasured ? null : linkedKnown;
  const weightComplete = !unmeasured;

  return {
    frameHeight,
    displayHeightMm: Math.min(
      SPECIES_HEIGHT_CURVE.maxMm,
      SPECIES_HEIGHT_CURVE.baseMm + SPECIES_HEIGHT_CURVE.perFrameMm * frameHeight,
    ),
    totalWeightBytes: linkedWeightBytes === null ? null : residentWeightBytes + linkedWeightBytes,
    verifiedWeightBytes: residentWeightBytes,
    residentWeightBytes,
    linkedWeightBytes,
    weightComplete,
    uniqueFrames: new Set(
      organism.frames.slice(0, frameHeight).map((frame) => frame.frame_hash),
    ).size,
    uniqueAssets: uniqueVerified.size,
  };
}

/** Stage is read off verified body. It never re-mints or renames anything. */
export function deriveStageFromEvidence(
  frameHeight: number,
  dimensions: readonly DimensionState[],
): LifecycleStage {
  const active = dimensions.filter((dimension) => dimension.status === 'active');
  const activeNames = new Set(active.map((dimension) => dimension.name));
  for (const rung of STAGE_LADDER) {
    if (frameHeight < rung.minFrameHeight) continue;
    if (active.length < rung.minActiveDimensions) continue;
    if (!rung.requiredActive.every((name) => activeNames.has(name))) continue;
    return rung.stage;
  }
  return 'baby';
}

/** Stage from a complete derived stat block. */
export function deriveStage(
  stats: CreatureStats,
  dimensions: readonly DimensionState[],
): LifecycleStage {
  return deriveStageFromEvidence(stats.frameHeight, dimensions);
}

/** The gateway wire shape for one organism. Identical in both runtimes. */
export function summarize(
  organism: LoadedOrganism,
  report: VerificationReport,
): QuantumRappidSummary {
  const dimensions = dimensionStates(organism, report);
  const stats = deriveStats(organism, report, dimensions);
  const sonic = organism.sonic;
  const verifiedPaths = new Set(
    report.assets.filter((asset) => asset.status === 'verified').map((asset) => asset.path),
  );

  const summary: QuantumRappidSummary = {
    rappid: organism.document.rappid,
    name: organism.document.name,
    displayName: organism.document.displayName,
    species: organism.document.name,
    lifecycleStage: deriveStage(stats, dimensions),
    localOnly: organism.document.localOnly,
    parentRappid: organism.document.parentRappid,
    stats,
    traits: { ...organism.traits.traits },
    dimensions: dimensions.map((dimension) => {
      const entry: DimensionSummary = { name: dimension.name, status: dimension.status };
      if (dimension.mediaTypes !== undefined) entry.mediaTypes = [...dimension.mediaTypes];
      return entry;
    }),
    externalEpisode: organism.document.externalEpisode,
    verified: report.ok,
    unmeasuredDimensions: dimensions
      .filter((dimension) => dimension.unmeasured)
      .map((dimension) => dimension.name),
  };

  if (sonic !== null) {
    const playback = sonic.devicePlayback;
    const verifiedTrack = (path: string | null): boolean =>
      path !== null && verifiedPaths.has(path);
    summary.sonic = {
      wakeCall: verifiedTrack(playback.preferred) || verifiedTrack(playback.losslessFallback),
      midiDna: verifiedTrack(playback.midiPrompt),
      autocomplete: verifiedTrack(playback.midiAutocomplete),
    };
  }
  return summary;
}
