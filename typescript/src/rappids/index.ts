/**
 * Quantum RAPPIDs — the operations a habitat, an agent or a gateway performs.
 *
 * One canonical RAPP/1 identity, many independently verifiable dimensions,
 * append-only growth, and nothing here that mints a second identity for an
 * organism that merely grew.
 *
 * Playback is a *data* handoff: `readAssetPayload` returns verified bytes and
 * their content address, and the caller plays them in process. Nothing in this
 * subsystem shells out to a player, so a habitat cannot be talked into
 * executing a path that arrived in a manifest.
 *
 * Mirrored by `python/openrappter/rappids/__init__.py`.
 */

import { readFileSync, lstatSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

import { sha256Hex } from './canonical.js';
import { proposeContinuation } from './autocomplete.js';
import { writeMidi } from './midi.js';
import {
  assetBytes,
  appendBodyFrame,
  buildDimensionFrame,
  formatFrameTime,
  loadOrganismByRappid,
  loadOrganisms,
  rappidsHome,
  mediaRef,
  writeDimensionAsset,
} from './store.js';
import { summarize } from './stats.js';
import {
  buildGrowthProposal,
  growOrganism,
  projectedStage,
  sonicContext,
} from './growth.js';
import { assertVerified, verifyOrganism } from './verify.js';
import { QuantumRappidError } from './types.js';
import type { GrowthResult } from './growth.js';
import type {
  AssetPayload,
  AssetRecord,
  ContinuationProposal,
  GrowthProposal,
  LoadedOrganism,
  PlaybackManifest,
  PlaybackTrack,
  QuantumRappidSummary,
  SonicProfile,
  VerificationReport,
} from './types.js';

export * from './types.js';
export {
  AUTOCOMPLETE_DOMAIN,
  PROPOSAL_DOMAIN,
  RAPP_EGG_DOMAIN,
  RAPP_MAX_CANONICAL_BYTES,
  RAPP_MAX_CANONICAL_DEPTH,
  RAPP_PARTICLE_DOMAIN,
  RAPP_WAVE_DOMAIN,
  DeterministicStream,
  assertRappCanonicalValue,
  canonicalDigest,
  canonicalJson,
  domainDigest,
  idiv,
  microToFloat,
  parseRappJson,
  roundHalfUp,
  rappCanonicalJson,
  rappH,
  rappHb,
  sha256Hex,
  traitMilli,
} from './canonical.js';
export {
  directoryHex,
  formatRappid,
  isRappid,
  loadOrCreateStableRappid,
  parseRappid,
  rappidHex,
  stableRappidTailPath,
} from './identity.js';
export type { StableRappidOptions } from './identity.js';
export {
  PPQ,
  STEP,
  buildDnaPrompt,
  midiDurationTicks,
  nearestScalePitch,
  noteFromJson,
  noteToJson,
  sonicParameters,
  ticksToMilliseconds,
  variableLength,
  writeMidi,
} from './midi.js';
export {
  DEFAULT_CANDIDATE_COUNT,
  DEFAULT_CONTINUATION_LENGTH,
  PROVIDER,
  contourIntervals,
  generateCandidate,
  generateCandidates,
  continuationSeed,
  presentScores,
  proposeContinuation,
  scoreCandidate,
} from './autocomplete.js';
export {
  BODY_FRAME_SCHEMA,
  FRAME_TIME_PATTERN,
  appendBodyFrame,
  buildDimensionFrame,
  bodyFrameDigest,
  bodyFrameToJson,
  formatFrameTime,
  listOrganismDirectories,
  loadOrganism,
  loadOrganismByRappid,
  loadOrganisms,
  mediaRef,
  rappidsHome,
  resolveWithin,
  storeRappObject,
} from './store.js';
export {
  CENSUS_DIMENSION,
  SPECIES_HEIGHT_CURVE,
  STAGE_LADDER,
  contiguousFrameHeight,
  deriveStage,
  deriveStageFromEvidence,
  deriveStats,
  dimensionStates,
  summarize,
} from './stats.js';
export {
  GROWABLE_DIMENSIONS,
  buildGrowthProposal,
  growOrganism,
  projectedStage,
  sonicContext,
} from './growth.js';
export type { GrowthOptions, GrowthResult, PendingGrowth } from './growth.js';
export { assertVerified, isVerified, verifyOrganism } from './verify.js';

export interface HabitatOptions {
  /** Habitat root. Defaults to `$RAPP_RAPPIDS_HOME`, else `~/.rapp/twins`. */
  root?: string;
}

/** Every organism in the habitat, summarised for the wire. */
export function listOrganismSummaries(options: HabitatOptions = {}): QuantumRappidSummary[] {
  return loadOrganisms(options.root ?? rappidsHome()).map((organism) =>
    summarize(organism, verifyOrganism(organism)),
  );
}

export interface OrganismInspection {
  summary: QuantumRappidSummary;
  verification: VerificationReport;
  directory: string;
  bornAt: string;
  kernelVersion: string | null;
  frames: LoadedOrganism['frames'];
  playback: PlaybackManifest;
}

function organismFor(rappid: string, options: HabitatOptions): LoadedOrganism {
  return loadOrganismByRappid(rappid, options.root ?? rappidsHome());
}

export function inspectOrganism(rappid: string, options: HabitatOptions = {}): OrganismInspection {
  const organism = organismFor(rappid, options);
  const verification = verifyOrganism(organism);
  return {
    summary: summarize(organism, verification),
    verification,
    directory: organism.directory,
    bornAt: organism.document.bornAt,
    kernelVersion: organism.document.kernelVersion,
    frames: organism.frames,
    playback: buildPlaybackManifest(organism, verification),
  };
}

export function verifyRappid(rappid: string, options: HabitatOptions = {}): VerificationReport {
  return verifyOrganism(organismFor(rappid, options));
}

export interface CompletionOptions extends HabitatOptions {
  candidateCount?: number;
  continuationLength?: number;
  /** Overrides the organism's own engram cursor when exploring alternatives. */
  engramCursor?: string | null;
}

export interface CompletionResult extends ContinuationProposal {
  /** The rendered `prompt + continuation` file, ready to hand to a player. */
  midiBase64: string;
}

/**
 * Propose a continuation of the organism's identity motif.
 *
 * Nothing is written. The result is explicitly non-authoritative until a
 * growth frame appends it.
 */
export function completeRappid(rappid: string, options: CompletionOptions = {}): CompletionResult {
  const organism = organismFor(rappid, options);
  const { params, prompt } = sonicContext(organism);
  const proposal = proposeContinuation({
    rappid: organism.document.rappid,
    traitsMilli: organism.traits.traitsMilli,
    params,
    prompt,
    engramCursor:
      options.engramCursor !== undefined
        ? options.engramCursor
        : organism.document.externalEpisode?.cursor ?? null,
    ...(options.candidateCount !== undefined ? { candidateCount: options.candidateCount } : {}),
    ...(options.continuationLength !== undefined
      ? { continuationLength: options.continuationLength }
      : {}),
  });
  const midi = writeMidi([...prompt, ...proposal.continuation], params);
  return { ...proposal, midiBase64: midi.toString('base64') };
}

export function proposeGrowth(
  rappid: string,
  dimension: string,
  options: HabitatOptions = {},
): GrowthProposal {
  const organism = organismFor(rappid, options);
  return buildGrowthProposal(organism, dimension).proposal;
}

export interface GrowOptions extends HabitatOptions {
  createdAt?: string;
}

export function growRappid(
  rappid: string,
  proposalId: string,
  options: GrowOptions = {},
): GrowthResult {
  const organism = organismFor(rappid, options);
  return growOrganism(
    organism,
    proposalId,
    options.createdAt !== undefined ? { createdAt: options.createdAt } : {},
  );
}

function trackFor(
  role: string,
  sonic: SonicProfile,
  verification: VerificationReport,
  path: string | null,
): PlaybackTrack | null {
  if (path === null) return null;
  const asset = sonic.assets.find((entry) => entry.path === path);
  if (asset === undefined) return null;
  const verified = verification.assets.some(
    (entry) => entry.dimension === sonic.dimension && entry.path === path && entry.status === 'verified',
  );
  return {
    role,
    path,
    mediaType: asset.mediaType,
    bytes: asset.bytes,
    sha256: asset.sha256,
    durationSeconds: asset.durationSeconds,
    verified,
  };
}

/**
 * What this organism can be played back as, and from which exact bytes.
 *
 * Device capability comes from the organism's own device dimension rather than
 * from what happens to be installed: a habitat that claims playback it cannot
 * do is the same class of error as a creature that claims weight it cannot
 * produce.
 */
export function buildPlaybackManifest(
  organism: LoadedOrganism,
  verification: VerificationReport = verifyOrganism(organism),
): PlaybackManifest {
  const device = organism.document.dimensions.find((dimension) => dimension.name === 'device');
  const sonic = organism.sonic;
  if (sonic === null) {
    return {
      rappid: organism.document.rappid,
      deviceMediaTypes: device?.mediaTypes ?? [],
      preferred: null,
      losslessFallback: null,
      tracks: [],
      requiresUserGesture: false,
      stopControlRequired: false,
      playbackMode: 'in-process-bytes',
    };
  }
  const roles: Array<[string, string | null]> = [
    ['preferred', sonic.devicePlayback.preferred],
    ['lossless-fallback', sonic.devicePlayback.losslessFallback],
    ['midi-dna', sonic.devicePlayback.midiPrompt],
    ['midi-autocomplete', sonic.devicePlayback.midiAutocomplete],
  ];
  const tracks = roles
    .map(([role, path]) => trackFor(role, sonic, verification, path))
    .filter((track): track is PlaybackTrack => track !== null);
  return {
    rappid: organism.document.rappid,
    deviceMediaTypes: device?.mediaTypes ?? [],
    preferred: tracks.find((track) => track.role === 'preferred') ?? null,
    losslessFallback: tracks.find((track) => track.role === 'lossless-fallback') ?? null,
    tracks,
    requiresUserGesture: sonic.devicePlayback.requiresUserGesture,
    stopControlRequired: sonic.devicePlayback.stopControlRequired,
    playbackMode: 'in-process-bytes',
  };
}

export function playbackManifest(rappid: string, options: HabitatOptions = {}): PlaybackManifest {
  const organism = organismFor(rappid, options);
  return buildPlaybackManifest(organism, verifyOrganism(organism));
}

/** Friendly names the habitat uses for the tracks it offers. */
const ASSET_ALIASES: Record<string, keyof Pick<
  SonicProfile['devicePlayback'],
  'preferred' | 'losslessFallback' | 'midiPrompt' | 'midiAutocomplete'
>> = {
  'wake-call': 'preferred',
  'wake-call-lossless': 'losslessFallback',
  'midi-dna': 'midiPrompt',
  'midi-autocomplete': 'midiAutocomplete',
};

function resolveAsset(sonic: SonicProfile, key: string): AssetRecord {
  const alias = ASSET_ALIASES[key];
  const path = alias === undefined ? key : sonic.devicePlayback[alias];
  if (path === null || path === undefined) {
    throw new QuantumRappidError('unknown-asset', `this organism offers no ${JSON.stringify(key)} track`);
  }
  const asset = sonic.assets.find((entry) => entry.path === path);
  if (asset === undefined) {
    throw new QuantumRappidError('unknown-asset', `${path} is not recorded in the sonic manifest`);
  }
  return asset;
}

/**
 * Verified bytes for one asset, base64 for the wire.
 *
 * The digest is re-checked at read time rather than trusted from the earlier
 * verification pass: a file can change between the two, and handing a player
 * bytes that no longer match their content address is exactly the failure the
 * manifest exists to prevent.
 */
export function readAssetPayload(
  rappid: string,
  key: string,
  options: HabitatOptions = {},
): AssetPayload {
  const organism = organismFor(rappid, options);
  if (organism.sonic === null) {
    throw new QuantumRappidError('no-sonic-dimension', `${rappid} carries no sonic dimension`);
  }
  const asset = resolveAsset(organism.sonic, key);
  const bytes = assetBytes(organism, organism.sonic.dimension, asset.path);
  const digest = sha256Hex(bytes);
  if (bytes.length !== asset.bytes || digest !== asset.sha256) {
    throw new QuantumRappidError(
      'asset-tampered',
      `${asset.path} does not match its content address: manifest says ${asset.bytes} bytes / ${asset.sha256}, `
        + `disk has ${bytes.length} bytes / ${digest}`,
    );
  }
  return {
    mediaType: asset.mediaType,
    base64: bytes.toString('base64'),
    sha256: digest,
    bytes: bytes.length,
    path: asset.path,
  };
}

export interface AttachSkillInput extends HabitatOptions {
  artifactPath: string;
  contentHash: string;
  artifactRoot: string;
  name: string;
  sessionId: string;
  createdAt?: string;
}

export function attachSkillDimension(
  rappid: string,
  input: AttachSkillInput,
): GrowthResult {
  const organism = organismFor(rappid, input);
  const report = assertVerified(organism);
  const artifactRoot = realpathSync(resolve(input.artifactRoot));
  const skillPath = realpathSync(resolve(input.artifactPath));
  const rel = relative(artifactRoot, skillPath);
  if (rel.startsWith('..') || rel === '' || isAbsolute(rel)) {
    throw new QuantumRappidError(
      'skill-path',
      'the recorded skill is outside the private OpenRappter skills directory',
    );
  }
  const skillStat = lstatSync(skillPath);
  if (!skillStat.isFile() || skillStat.isSymbolicLink()) {
    throw new QuantumRappidError('skill-path', 'the recorded skill is not a regular file');
  }
  const manifestPath = realpathSync(
    join(dirname(skillPath), 'manifest.json'),
  );
  const manifestRelative = relative(artifactRoot, manifestPath);
  if (
    manifestRelative.startsWith('..')
    || isAbsolute(manifestRelative)
  ) {
    throw new QuantumRappidError(
      'skill-manifest',
      'the recorded skill manifest escapes the private skills directory',
    );
  }
  const manifestStat = lstatSync(manifestPath);
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) {
    throw new QuantumRappidError('skill-manifest', 'the recorded skill manifest is missing');
  }
  const skillBytes = readFileSync(skillPath);
  const manifestBytes = readFileSync(manifestPath);
  const combinedHash = sha256Hex(Buffer.concat([
    skillBytes,
    Buffer.from([0]),
    manifestBytes,
  ]));
  if (combinedHash !== input.contentHash) {
    throw new QuantumRappidError(
      'skill-integrity',
      `recorded skill hash ${combinedHash} does not match ${input.contentHash}`,
    );
  }
  const skillAsset = writeDimensionAsset(
    organism,
    'skill',
    `assets/${input.contentHash.slice(0, 16)}.skill.md`,
    skillBytes,
  );
  const manifestAsset = writeDimensionAsset(
    organism,
    'skill',
    `assets/${input.contentHash.slice(0, 16)}.manifest.json`,
    manifestBytes,
  );
  const version =
    1
    + organism.frames.filter(
      (frame) => frame.payload.dimension === 'skill',
    ).length;
  const frame = buildDimensionFrame({
    rappid,
    seq: organism.frames.length,
    utc: input.createdAt ?? formatFrameTime(new Date()),
    prev: organism.frames.at(-1)?.payload_hash ?? null,
    dimension: 'skill',
    version,
    stage: projectedStage(organism, 'skill', report),
    traits: { ...organism.traits.traitsMilli },
    media: {
      skill: mediaRef(skillBytes, skillAsset.mediaType),
      manifest: mediaRef(manifestBytes, manifestAsset.mediaType),
    },
  });
  const framePath = appendBodyFrame(organism, frame);
  const after = verifyOrganism(organism);
  return {
    rappid,
    appended: frame,
    framePath,
    writtenAssets: [skillAsset, manifestAsset],
    summary: summarize(organism, after),
    verification: after,
  };
}
