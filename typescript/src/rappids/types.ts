/**
 * The shapes a Quantum RAPPID is made of.
 *
 * One canonical RAPP/1 identity, many independently verifiable dimensions.
 * Nothing in this file derives identity from a trait, a media hash, a weight,
 * a height or a lifecycle stage — those are all *projections* of an organism
 * whose RAPPID was minted once and never re-minted.
 *
 * The document shapes mirror what is already on disk at
 * `~/.rapp/twins/<hex>/` (`rappid.json`, `traits.json`,
 * `sonic/sonic-profile.json`). Python mirrors this file in
 * `python/openrappter/rappids/types.py`.
 */

export type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;
export interface JsonObject {
  [key: string]: JsonValue;
}

/** Every failure this subsystem raises. Never swallowed, never defaulted away. */
export class QuantumRappidError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'QuantumRappidError';
    this.code = code;
  }
}

/** `rappid:@owner/name:<64 hex>` split into its parts. */
export interface RappidParts {
  owner: string;
  name: string;
  hex: string;
}

/** Where an organism's memory lives when it is not in this habitat. */
export interface ExternalEpisodeRef {
  source: string;
  sessionGuid: string;
  memoryKey: string;
  /** Latest cursor the memory dimension has accepted, when one is recorded. */
  cursor: string | null;
}

/** One dimension family as the identity document declares it. */
export interface DimensionRecord {
  name: string;
  status: string;
  /** Content refs this dimension points at, relative to the organism directory. */
  refs: Record<string, string>;
  /** Media types this dimension can be played back as, when it declares any. */
  mediaTypes: string[];
}

export interface RappidDocument {
  schema: string;
  rappid: string;
  kind: string;
  name: string;
  displayName: string;
  url: string | null;
  parentRappid: string | null;
  bornAt: string;
  kernelVersion: string | null;
  externalEpisode: ExternalEpisodeRef | null;
  quantumSchema: string;
  dimensions: DimensionRecord[];
  localOnly: boolean;
}

export interface TraitsDocument {
  schema: string;
  rappid: string;
  /** Immutable identity-conditioning snapshot recorded at birth. */
  birthTraits: Record<string, number>;
  birthTraitsMilli: Record<string, number>;
  /** Trait name -> 0.0..1.0. Presentation value; scoring uses `traitsMilli`. */
  traits: Record<string, number>;
  /** Trait name -> 0..1000 integers. The only form the providers score with. */
  traitsMilli: Record<string, number>;
}

/** `NOTE(pitch, delta_onset, duration, velocity)` — the whole note event. */
export interface Note {
  pitch: number;
  deltaOnset: number;
  duration: number;
  velocity: number;
}

export interface MusicalParameters {
  rootPitch: number;
  rootPitchClass: number;
  mode: string;
  scale: number[];
  bpm: number;
  program: number;
}

/** One content-addressed file carried by a dimension. */
export interface AssetRecord {
  /** Relative to the dimension directory, exactly as the manifest records it. */
  path: string;
  bytes: number;
  sha256: string;
  mediaType: string;
  durationSeconds: number | null;
}

/**
 * How a habitat is allowed to play this organism.
 *
 * The roles are normalised because manifests nest them differently as the
 * sonic dimension evolves (`midi_prompt` at the top level in one revision, a
 * `midi_data` group in the next). The two policy flags are the organism's own
 * statement about playback and are honoured rather than second-guessed: a
 * creature that says it must not sound without a user gesture must not be
 * autoplayed by anything reading this.
 */
export interface DevicePlayback {
  preferred: string | null;
  losslessFallback: string | null;
  midiPrompt: string | null;
  midiAutocomplete: string | null;
  requiresUserGesture: boolean;
  stopControlRequired: boolean;
}

export interface SonicProfile {
  schema: string;
  rappid: string;
  dimension: string;
  /** Recorded inside the profile, when that revision embeds it. */
  manifestSha256: string | null;
  /** Recorded beside it as `sonic-profile.sha256`, sha256sum style. */
  sidecarSha256: string | null;
  /** sha256 of the profile file exactly as it was read. */
  fileSha256: string;
  identitySeedSha256: string | null;
  evolutionSeedSha256: string | null;
  traits: Record<string, number>;
  musical: MusicalParameters;
  prompt: Note[];
  assets: AssetRecord[];
  devicePlayback: DevicePlayback;
  recordedStage: string | null;
  /** The raw document, kept for manifest re-hashing. Never mutated. */
  raw: JsonObject;
}

export interface RappMediaRef {
  space: 'rapp/1:egg';
  hash: string;
  media_type: string;
  bytes: number;
}

export interface RappDimensionPayload extends JsonObject {
  rappid: string;
  dimension: string;
  version: number;
  stage: JsonObject;
  traits: JsonObject;
  traits_hash: string;
  media: JsonObject;
  sources: JsonValue[];
}

/** The exact eleven-key RAPP/1 frame. No private OpenRappter envelope. */
export interface BodyFrame {
  spec: 'rapp/1';
  kind: 'body.dimension';
  stream_id: string;
  seq: number;
  utc: string;
  payload: RappDimensionPayload;
  payload_hash: string;
  frame_hash: string;
  prev: string | null;
  prev_wave: null;
  sig: null;
}

export interface LoadedOrganism {
  directory: string;
  document: RappidDocument;
  traits: TraitsDocument;
  sonic: SonicProfile | null;
  frames: BodyFrame[];
}

export type CheckStatus = 'pass' | 'fail';

export interface VerificationCheck {
  name: string;
  status: CheckStatus;
  detail: string;
}

export type AssetStatus = 'verified' | 'missing' | 'byte-mismatch' | 'hash-mismatch';

export interface AssetVerification {
  dimension: string;
  path: string;
  status: AssetStatus;
  addressSpace: string;
  addressHash: string;
  expectedBytes: number;
  actualBytes: number | null;
  expectedSha256: string;
  actualSha256: string | null;
  mediaType: string;
}

export interface VerificationReport {
  rappid: string;
  ok: boolean;
  checks: VerificationCheck[];
  assets: AssetVerification[];
  /** `(dimension, sha256)` pairs that verified, each counted exactly once. */
  verifiedAddresses: string[];
}

export type LifecycleStage = 'baby' | 'hatchling' | 'raptor';

export interface CreatureStats {
  frameHeight: number;
  displayHeightMm: number;
  /** Null when any carried dimension has an unknown size. Never estimated. */
  totalWeightBytes: number | null;
  /** Verified bytes even when total weight is incomplete. */
  verifiedWeightBytes: number;
  residentWeightBytes: number;
  linkedWeightBytes: number | null;
  weightComplete: boolean;
  uniqueFrames: number;
  uniqueAssets: number;
}

export interface DimensionSummary {
  name: string;
  status: 'active' | 'linked' | 'missing';
  mediaTypes?: string[];
}

/** The gateway wire shape. Identical in both runtimes, hence camelCase here. */
export interface QuantumRappidSummary {
  rappid: string;
  name: string;
  displayName: string;
  species: string;
  lifecycleStage: LifecycleStage;
  localOnly: boolean;
  parentRappid: string | null;
  stats: CreatureStats;
  traits: Record<string, number>;
  dimensions: DimensionSummary[];
  sonic?: {
    wakeCall: boolean;
    midiDna: boolean;
    autocomplete: boolean;
  };
  externalEpisode: ExternalEpisodeRef | null;
  verified: boolean;
  unmeasuredDimensions: string[];
}

/** Scores kept as exact integers in millionths; floats are presentation only. */
export interface CandidateScoresMicro {
  continuation: number;
  soundsGood: number;
  traitFit: number;
  pitchRange: number;
  repeatedNoteRatio: number;
  pitchClassDiversity: number;
}

export interface CandidateScores {
  continuation: number;
  soundsGood: number;
  traitFit: number;
  pitchRange: number;
  repeatedNoteRatio: number;
  pitchClassDiversity: number;
}

export interface ContinuationCandidate {
  index: number;
  notes: Note[];
  scoresMicro: CandidateScoresMicro;
  scores: CandidateScores;
}

export interface ProviderClaim {
  name: string;
  kind: 'deterministic-rules-and-scoring';
  learnedTransformer: false;
  claim: string;
  contextPolicy: {
    trainingOrRuntimeCeilingNotes: number;
    retainedRecentNotes: number;
  };
  source: string;
}

export interface ContinuationProposal {
  rappid: string;
  provider: ProviderClaim;
  musical: MusicalParameters;
  prompt: Note[];
  selectedCandidate: number;
  candidateCount: number;
  continuation: Note[];
  scoresMicro: CandidateScoresMicro;
  scores: CandidateScores;
  /** sha256 of the rendered `prompt + continuation` MIDI file. */
  midiSha256: string;
  midiBytes: number;
  authoritative: false;
}

export interface GrowthProposal {
  id: string;
  rappid: string;
  dimension: string;
  title: string;
  summary: string;
  predictedStats: CreatureStats;
  predictedStage: LifecycleStage;
  evidence: string[];
  assets: AssetRecord[];
  authoritative: false;
  appendable: boolean;
}

export interface AssetPayload {
  mediaType: string;
  base64: string;
  sha256: string;
  bytes: number;
  path: string;
}

export interface PlaybackTrack {
  role: string;
  path: string;
  mediaType: string;
  bytes: number;
  sha256: string;
  durationSeconds: number | null;
  verified: boolean;
}

export interface PlaybackManifest {
  rappid: string;
  /** What the device says it can play, from the organism's device dimension. */
  deviceMediaTypes: string[];
  preferred: PlaybackTrack | null;
  losslessFallback: PlaybackTrack | null;
  tracks: PlaybackTrack[];
  /** The organism's own playback policy, carried rather than interpreted. */
  requiresUserGesture: boolean;
  stopControlRequired: boolean;
  /** Playback is a data handoff. Nothing here shells out to a player. */
  playbackMode: 'in-process-bytes';
}
