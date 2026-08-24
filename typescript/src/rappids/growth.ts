/**
 * Growth: append a verified body frame, never mint a second identity.
 *
 * A proposal is not organism state. It is a preview with a content-addressed
 * id, and the id is what makes approval mean something: `grow` re-derives the
 * proposal from the organism itself and refuses anything whose id does not
 * match, so an approved preview cannot be swapped for a different payload
 * between the preview and the append.
 *
 * Appending never touches the RAPPID. A creature that grows from baby to
 * Raptor is the same creature the whole way — only a true child gets a new
 * identity, and it gets an explicit parent pointer with it.
 *
 * Mirrored by `python/openrappter/rappids/growth.py`.
 */

import {
  RAPP_EGG_DOMAIN,
  canonicalJson,
  rappHb,
  sha256Hex,
} from './canonical.js';
import { proposeContinuation } from './autocomplete.js';
import { buildDnaPrompt, sonicParameters, writeMidi } from './midi.js';
import {
  appendBodyFrame,
  buildDimensionFrame,
  FRAME_TIME_PATTERN,
  formatFrameTime,
  mediaRef,
  writeDimensionAsset,
} from './store.js';
import {
  contiguousFrameHeight,
  deriveStage,
  deriveStageFromEvidence,
  deriveStats,
  dimensionStates,
  summarize,
} from './stats.js';
import { assertVerified, verifyOrganism } from './verify.js';
import { QuantumRappidError } from './types.js';
import type {
  AssetRecord,
  AssetVerification,
  BodyFrame,
  ContinuationProposal,
  GrowthProposal,
  JsonObject,
  LoadedOrganism,
  MusicalParameters,
  Note,
  QuantumRappidSummary,
  VerificationReport,
} from './types.js';

/** Growth requests this runtime knows how to answer. Anything else is refused. */
export const GROWABLE_DIMENSIONS = ['sonic', 'stats'] as const;
export type GrowableDimension = (typeof GROWABLE_DIMENSIONS)[number];

/**
 * The instant a prediction is drafted against.
 *
 * Frame timestamps are fixed-width, so any value of the right shape produces a
 * frame of the same canonical length — which is what lets a preview quote
 * exact bytes for a frame that has not been written yet.
 */
const PREDICTION_INSTANT = '1970-01-01T00:00:00.000Z';
const STAGE_ORDINAL = { baby: 0, hatchling: 1, raptor: 2 } as const;

export interface PendingGrowth {
  proposal: GrowthProposal;
  frameKind: 'body.dimension';
  /** Bytes that would be written, keyed by the asset path they land on. */
  payloads: Array<{ dimension: string; path: string; bytes: Buffer }>;
  continuation: ContinuationProposal | null;
}

function isGrowable(dimension: string): dimension is GrowableDimension {
  return (GROWABLE_DIMENSIONS as readonly string[]).includes(dimension);
}

/** The prompt and key an organism sings in, recorded if it has a profile. */
export function sonicContext(organism: LoadedOrganism): { params: MusicalParameters; prompt: Note[] } {
  const params = organism.sonic?.musical
    ?? sonicParameters(
      organism.document.rappid,
      organism.traits.birthTraitsMilli,
    );
  const prompt = organism.sonic?.prompt
    ?? buildDnaPrompt(
      organism.document.rappid,
      organism.traits.birthTraitsMilli,
      params,
    );
  return { params, prompt: [...prompt] };
}

function proposalId(body: JsonObject): string {
  return sha256Hex(`quantum-rappid/1:proposal\n${canonicalJson(body)}`);
}

/** A verified asset record for bytes that are in hand but not yet on disk. */
function pendingVerification(
  dimension: string,
  asset: AssetRecord,
  bytes: Buffer,
): AssetVerification {
  const addressHash = rappHb(RAPP_EGG_DOMAIN, bytes);
  return {
    dimension,
    path: asset.path,
    status: 'verified',
    addressSpace: RAPP_EGG_DOMAIN,
    addressHash,
    expectedBytes: asset.bytes,
    actualBytes: asset.bytes,
    expectedSha256: asset.sha256,
    actualSha256: asset.sha256,
    mediaType: asset.mediaType,
  };
}

/**
 * What the organism would look like after this frame, without writing it.
 *
 * The prediction runs the real derivation over a copy rather than a parallel
 * "estimate" path: a preview that is computed differently from the thing it
 * previews is how a habitat starts lying to its operator.
 */
function predict(
  organism: LoadedOrganism,
  report: VerificationReport,
  frame: BodyFrame,
  payloads: ReadonlyArray<{ asset: AssetRecord; bytes: Buffer }>,
): { stats: GrowthProposal['predictedStats']; stage: GrowthProposal['predictedStage'] } {
  const projected: LoadedOrganism = { ...organism, frames: [...organism.frames, frame] };
  const projectedReport: VerificationReport = {
    ...report,
    assets: [
      ...report.assets,
      ...payloads.map(({ asset, bytes }) =>
        pendingVerification(frame.payload.dimension, asset, bytes),
      ),
    ],
    verifiedAddresses: [
      ...new Set([
        ...report.verifiedAddresses,
        ...payloads.map(({ bytes }) =>
          `${RAPP_EGG_DOMAIN}:${rappHb(RAPP_EGG_DOMAIN, bytes)}`,
        ),
      ]),
    ].sort(),
  };
  const dimensions = dimensionStates(projected, projectedReport);
  const stats = deriveStats(projected, projectedReport, dimensions);
  return { stats, stage: deriveStage(stats, dimensions) };
}

/**
 * Build the frame a proposal would append.
 *
 * `createdAt` is an input rather than a clock read, because the frame hash
 * covers it: a proposal id that changed every second could never be approved.
 */
export function projectedStage(
  organism: LoadedOrganism,
  dimension: string,
  report: VerificationReport = verifyOrganism(organism),
): { name: 'baby' | 'hatchling' | 'raptor'; ordinal: number } {
  const dimensions = dimensionStates(organism, report);
  const existing = dimensions.find((entry) => entry.name === dimension);
  if (existing) existing.status = 'active';
  else dimensions.push({ name: dimension, status: 'active', unmeasured: false });
  const name = deriveStageFromEvidence(
    contiguousFrameHeight(organism.frames) + 1,
    dimensions,
  );
  return { name, ordinal: STAGE_ORDINAL[name] };
}

function draftFrame(
  organism: LoadedOrganism,
  dimension: string,
  version: number,
  media: JsonObject,
  createdAt: string,
  report: VerificationReport,
): BodyFrame {
  const seq = organism.frames.length;
  return buildDimensionFrame({
    rappid: organism.document.rappid,
    seq,
    utc: createdAt,
    prev: seq === 0 ? null : organism.frames[seq - 1].payload_hash,
    dimension,
    version,
    stage: projectedStage(organism, dimension, report),
    traits: { ...organism.traits.traitsMilli },
    media,
  });
}

/**
 * One growth proposal for a dimension.
 *
 * The proposal id covers everything that would be written — dimension, kind,
 * evidence and the exact content addresses of every byte — so approving an id
 * approves a specific append and nothing else.
 */
export function buildGrowthProposal(
  organism: LoadedOrganism,
  dimension: string,
  report: VerificationReport = verifyOrganism(organism),
): PendingGrowth {
  if (!isGrowable(dimension)) {
    throw new QuantumRappidError(
      'ungrowable-dimension',
      `no growth path for dimension ${JSON.stringify(dimension)}; known: ${GROWABLE_DIMENSIONS.join(', ')}`,
    );
  }

  const rappid = organism.document.rappid;
  const payloads: Array<{ dimension: string; path: string; bytes: Buffer }> = [];
  let continuation: ContinuationProposal | null = null;
  let assets: AssetRecord[] = [];
  let title: string;
  let summary: string;
  let evidence: string[];
  let frameDimension: string;
  const appendable = dimension === 'sonic';

  if (dimension === 'sonic') {
    const { params, prompt } = sonicContext(organism);
    continuation = proposeContinuation({
      rappid,
      traitsMilli: organism.traits.traitsMilli,
      params,
      prompt,
      engramCursor: organism.document.externalEpisode?.cursor ?? null,
    });
    const bytes = writeMidi([...prompt, ...continuation.continuation], params);
    const path = `assets/autocomplete-${continuation.midiSha256.slice(0, 12)}.mid`;
    assets = [
      {
        path,
        bytes: bytes.length,
        sha256: continuation.midiSha256,
        mediaType: 'application/x-midi',
        durationSeconds: null,
      },
    ];
    payloads.push({ dimension: 'sonic', path, bytes });
    frameDimension = 'sonic';
    title = 'A trait-conditioned continuation of the identity motif';
    summary =
      `${continuation.continuation.length} notes continuing the ${prompt.length}-note MIDI DNA, `
      + `selected from ${continuation.candidateCount} deterministic candidates.`;
    evidence = [
      `provider: ${continuation.provider.name} (${continuation.provider.kind}, not a trained transformer)`,
      `selected candidate ${continuation.selectedCandidate} of ${continuation.candidateCount}`,
      `continuation score ${continuation.scoresMicro.continuation} / 1000000`,
      `standalone score ${continuation.scoresMicro.soundsGood} / 1000000`,
      `rendered midi sha256 ${continuation.midiSha256}`,
    ];
  } else {
    const carried = new Set([
      ...organism.document.dimensions.map((entry) => entry.name),
      ...organism.frames.map((entry) => entry.payload.dimension),
    ]);
    frameDimension =
      ['memory', 'skill', 'sonic', 'device', 'visual', 'capability']
        .find((name) => !carried.has(name))
      ?? 'capability';
    title = `A proposed ${frameDimension} dimension`;
    summary =
      'A lineage- and trait-conditioned preview. It carries no data yet and cannot be appended.';
    evidence = [
      ...report.verifiedAddresses.map((address) => `verified ${address}`),
      `checks passed: ${report.checks.filter((check) => check.status === 'pass').length}`,
    ];
  }

  const version =
    1
    + organism.frames.filter(
      (candidate) => candidate.payload.dimension === frameDimension,
    ).length;
  const media: JsonObject = {};
  const pendingAssets = payloads.map((payload, index) => {
    const asset = assets[index];
    media[
      frameDimension === 'sonic'
        ? 'midi-autocomplete'
        : `asset-${index + 1}`
    ] = mediaRef(payload.bytes, asset.mediaType);
    return { asset, bytes: payload.bytes };
  });
  // Fixed, not a clock read: a preview must predict the same organism twice.
  const frame = draftFrame(
    organism,
    frameDimension,
    version,
    media,
    PREDICTION_INSTANT,
    report,
  );
  const prediction = predict(organism, report, frame, pendingAssets);

  const id = proposalId({
    rappid,
    dimension: frameDimension,
    kind: 'body.dimension',
    version,
    title,
    summary,
    evidence: [...evidence],
    media,
    seq: frame.seq,
    prev: frame.prev,
  });

  return {
    proposal: {
      id,
      rappid,
      dimension: frameDimension,
      title,
      summary,
      predictedStats: prediction.stats,
      predictedStage: prediction.stage,
      evidence,
      assets,
      authoritative: false,
      appendable,
    },
    frameKind: 'body.dimension',
    payloads,
    continuation,
  };
}

export interface GrowthResult {
  rappid: string;
  appended: BodyFrame;
  framePath: string;
  writtenAssets: AssetRecord[];
  summary: QuantumRappidSummary;
  verification: VerificationReport;
}

export interface GrowthOptions {
  /** The frame's recorded time. Defaults to now, in UTC, to the second. */
  createdAt?: string;
}

/**
 * Append an approved proposal.
 *
 * Order matters: verify first, write the bytes, then append the frame that
 * points at them. A frame that names an asset which is not on disk would be a
 * lie the next verification catches — but it is better not to write it at all.
 */
export function growOrganism(
  organism: LoadedOrganism,
  proposalIdentifier: string,
  options: GrowthOptions = {},
): GrowthResult {
  const report = assertVerified(organism);
  const matches = GROWABLE_DIMENSIONS.map((dimension) =>
    buildGrowthProposal(organism, dimension, report),
  ).filter((pending) => pending.proposal.id === proposalIdentifier);

  if (matches.length === 0) {
    throw new QuantumRappidError(
      'unknown-proposal',
      `proposal ${proposalIdentifier} does not match any growth this organism can currently produce; `
        + 'preview it again and approve the new id',
    );
  }
  const pending = matches[0];
  if (!pending.proposal.appendable) {
    throw new QuantumRappidError(
      'proposal-not-appendable',
      'this autocomplete result is a preview only; attach real verified dimension data first',
    );
  }
  const createdAt = options.createdAt ?? formatFrameTime(new Date());
  if (!FRAME_TIME_PATTERN.test(createdAt)) {
    throw new QuantumRappidError(
      'frame-time',
      `createdAt ${createdAt} is not YYYY-MM-DDTHH:MM:SS.mmmZ`,
    );
  }

  const written: AssetRecord[] = pending.payloads.map((payload) =>
    writeDimensionAsset(organism, payload.dimension, payload.path, payload.bytes),
  );
  const version =
    1
    + organism.frames.filter(
      (candidate) =>
        candidate.payload.dimension === pending.proposal.dimension,
    ).length;
  const media: JsonObject = {};
  pending.payloads.forEach((payload, index) => {
    media[
      pending.proposal.dimension === 'sonic'
        ? 'midi-autocomplete'
        : `asset-${index + 1}`
    ] = mediaRef(payload.bytes, written[index].mediaType);
  });
  const frame = draftFrame(
    organism,
    pending.proposal.dimension,
    version,
    media,
    createdAt,
    report,
  );
  const framePath = appendBodyFrame(organism, frame);
  const verification = verifyOrganism(organism);

  return {
    rappid: organism.document.rappid,
    appended: frame,
    framePath,
    writtenAssets: written,
    summary: summarize(organism, verification),
    verification,
  };
}
