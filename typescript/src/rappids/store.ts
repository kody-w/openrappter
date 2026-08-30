/**
 * Where organisms live, and the only code that reads or writes them.
 *
 * The habitat is `~/.rapp/twins/<hex>/`, beside the twin vault and outside any
 * repository, for the reason `src/twin/vault.ts` spells out: a creature that
 * lands inside a working tree is one `git add -A` away from being published.
 * `$RAPP_RAPPIDS_HOME` relocates it, read at call time so tests and `reset`
 * cannot be left pointing at a directory that was current at import.
 *
 * Two rules are enforced here rather than documented:
 *
 *   1. **Append-only.** A body frame is written to a new numbered file with
 *      `wx`; a frame that already exists is never reopened, so history cannot
 *      be rewritten by this module even by mistake.
 *   2. **Inside the organism.** Every asset path from a manifest is resolved
 *      and then checked to still be under the organism directory. A manifest
 *      is data, and data that names `../../.ssh/id_rsa` must not be followed.
 *
 * Mirrored by `python/openrappter/rappids/store.py`.
 */

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';

import {
  RAPP_EGG_DOMAIN,
  RAPP_PARTICLE_DOMAIN,
  rappH,
  rappHb,
  sha256Hex,
} from './canonical.js';
import {
  RAPP_FRAME_KEYS,
  RAPP_FRAME_SPEC,
  RAPP_FRAME_TIME_PATTERN,
  hashRappBodyFrame,
  isRappFrameUtc,
  rappFrameDigest,
  rappFrameToJson,
  verifyRappFrame,
  type RappBodyFrameProfile,
} from '../rapp/frame.js';
import { isRappid, parseRappid, validateParentPointer } from './identity.js';
import { noteFromJson } from './midi.js';
import { QuantumRappidError } from './types.js';
import type {
  AssetRecord,
  BodyFrame,
  DevicePlayback,
  DimensionRecord,
  ExternalEpisodeRef,
  JsonObject,
  JsonValue,
  LoadedOrganism,
  MusicalParameters,
  RappDimensionPayload,
  RappidDocument,
  SonicProfile,
  TraitsDocument,
} from './types.js';
import { traitMilli } from './canonical.js';

export const RAPPID_DOCUMENT = 'rappid.json';
export const TRAITS_DOCUMENT = 'traits.json';
export const SONIC_PROFILE = 'sonic/sonic-profile.json';
export const SONIC_PROFILE_SIDECAR = 'sonic/sonic-profile.sha256';
export const FRAMES_DIRECTORY = 'frames';
export const OBJECTS_DIRECTORY = 'objects/rapp-1-egg';
export const BODY_FRAME_SCHEMA = RAPP_FRAME_SPEC;

/**
 * Frame timestamps are RFC 3339 UTC to the second, and only that.
 *
 * One fixed-width format keeps a frame's canonical bytes — and therefore the
 * weight it contributes — the same length whenever it was written, so a growth
 * preview can state exact bytes instead of an estimate that drifts by the
 * length of a timestamp.
 */
export const FRAME_TIME_PATTERN = RAPP_FRAME_TIME_PATTERN;
const LABEL = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function formatFrameTime(instant: Date): string {
  return instant.toISOString();
}

const MEDIA_TYPES: Record<string, string> = {
  '.mid': 'application/x-midi',
  '.midi': 'application/x-midi',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.json': 'application/json',
  '.md': 'text/markdown',
};

/** The habitat directory: `$RAPP_RAPPIDS_HOME`, else `~/.rapp/twins`. */
export function rappidsHome(): string {
  const override = process.env.RAPP_RAPPIDS_HOME;
  if (override !== undefined && override.trim() !== '') return override;
  return join(homedir(), '.rapp', 'twins');
}

export function mediaTypeForPath(path: string): string {
  const dot = path.lastIndexOf('.');
  const extension = dot < 0 ? '' : path.slice(dot).toLowerCase();
  const mediaType = MEDIA_TYPES[extension];
  if (mediaType === undefined) {
    throw new QuantumRappidError('unknown-media-type', `no media type is registered for ${path}`);
  }
  return mediaType;
}

/** Resolve `relative` under `base`, refusing anything that escapes it. */
export function resolveWithin(base: string, relative: string): string {
  const root = resolve(base);
  const target = resolve(root, relative);
  if (target !== root && !target.startsWith(root + sep)) {
    throw new QuantumRappidError(
      'path-escape',
      `${JSON.stringify(relative)} resolves outside the organism directory`,
    );
  }
  return target;
}

function readJson(path: string): JsonObject {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    throw new QuantumRappidError('unreadable', `cannot read ${path}: ${(error as Error).message}`);
  }
  let value: JsonValue;
  try {
    value = JSON.parse(text) as JsonValue;
  } catch (error) {
    throw new QuantumRappidError('invalid-json', `${path} is not JSON: ${(error as Error).message}`);
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new QuantumRappidError('invalid-json', `${path} must contain a JSON object`);
  }
  return value;
}

function requireString(value: JsonValue | undefined, where: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new QuantumRappidError('invalid-field', `${where} must be a non-empty string`);
  }
  return value;
}

function optionalString(value: JsonValue | undefined, where: string): string | null {
  if (value === undefined || value === null) return null;
  return requireString(value, where);
}

function requireObject(value: JsonValue | undefined, where: string): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new QuantumRappidError('invalid-field', `${where} must be an object`);
  }
  return value;
}

function requireArray(value: JsonValue | undefined, where: string): JsonValue[] {
  if (!Array.isArray(value)) {
    throw new QuantumRappidError('invalid-field', `${where} must be an array`);
  }
  return value;
}

function requireInteger(value: JsonValue | undefined, where: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new QuantumRappidError('invalid-field', `${where} must be an integer`);
  }
  return value;
}

function parseExternalEpisode(raw: JsonValue | undefined, cursor: string | null): ExternalEpisodeRef | null {
  if (raw === undefined || raw === null) return null;
  const value = requireObject(raw, 'external_episode');
  return {
    source: requireString(value.source, 'external_episode.source'),
    sessionGuid: requireString(value.session_guid, 'external_episode.session_guid'),
    memoryKey: requireString(value.memory_key, 'external_episode.memory_key'),
    cursor,
  };
}

/**
 * A dimension record, with its refs and playback types pulled out.
 *
 * Dimension bodies are open by design — the whole premise is that new
 * dimensions arrive later — so every string value is treated as a content ref
 * and every string in `playback` as a media type, rather than hard-coding the
 * three families that happen to exist today.
 */
function parseDimension(name: string, raw: JsonValue): DimensionRecord {
  if (!LABEL.test(name)) {
    throw new QuantumRappidError(
      'invalid-dimension',
      `quantum dimension name is not an lclabel: ${JSON.stringify(name)}`,
    );
  }
  const value = requireObject(raw, `quantum.dimensions.${name}`);
  const refs: Record<string, string> = {};
  const mediaTypes: string[] = [];
  for (const key of Object.keys(value).sort()) {
    const entry = value[key];
    if (key === 'status') continue;
    if (typeof entry === 'string') refs[key] = entry;
    else if (Array.isArray(entry) && key === 'playback') {
      for (const item of entry) {
        if (typeof item === 'string') mediaTypes.push(item);
      }
    }
  }
  return {
    name,
    status: requireString(value.status, `quantum.dimensions.${name}.status`),
    refs,
    mediaTypes,
  };
}

export function parseRappidDocument(raw: JsonObject, source: string): RappidDocument {
  const rappid = requireString(raw.rappid, `${source}.rappid`);
  if (!isRappid(rappid)) {
    throw new QuantumRappidError('invalid-rappid', `${source}.rappid is not a RAPPID: ${rappid}`);
  }
  const parent = raw.parent_rappid === undefined ? null : optionalString(raw.parent_rappid, `${source}.parent_rappid`);
  validateParentPointer(rappid, parent);

  const quantum = requireObject(raw.quantum, `${source}.quantum`);
  const dimensionsRaw = requireObject(quantum.dimensions, `${source}.quantum.dimensions`);
  const dimensions = Object.keys(dimensionsRaw)
    .sort()
    .map((name) => parseDimension(name, dimensionsRaw[name]));
  const memory = dimensions.find((dimension) => dimension.name === 'memory');
  const cursor = memory?.refs.latest_cursor ?? null;

  const name = requireString(raw.name, `${source}.name`);
  return {
    schema: requireString(raw.schema, `${source}.schema`),
    rappid,
    kind: requireString(raw.kind, `${source}.kind`),
    name,
    displayName: optionalString(raw.display_name, `${source}.display_name`) ?? name,
    url: optionalString(raw.url, `${source}.url`),
    parentRappid: parent,
    bornAt: requireString(raw.born_at, `${source}.born_at`),
    kernelVersion: optionalString(raw.kernel_version, `${source}.kernel_version`),
    externalEpisode: parseExternalEpisode(raw.external_episode, cursor),
    quantumSchema: requireString(quantum.schema, `${source}.quantum.schema`),
    dimensions,
    localOnly: raw._local_only === true,
  };
}

export function parseTraitsDocument(raw: JsonObject, source: string): TraitsDocument {
  const traitsRaw = requireObject(raw.traits, `${source}.traits`);
  const birthRaw = raw.birth_traits === undefined
    ? traitsRaw
    : requireObject(raw.birth_traits, `${source}.birth_traits`);
  const traits: Record<string, number> = {};
  const traitsMilli: Record<string, number> = {};
  for (const key of Object.keys(traitsRaw).sort()) {
    const value = traitsRaw[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
      throw new QuantumRappidError(
        'invalid-trait',
        `${source}.traits.${key} must be a number between 0 and 1, got ${JSON.stringify(value)}`,
      );
    }
    traits[key] = value;
    traitsMilli[key] = traitMilli(value);
  }
  if (Object.keys(traits).length === 0) {
    throw new QuantumRappidError('invalid-trait', `${source}.traits is empty`);
  }
  const birthTraits: Record<string, number> = {};
  const birthTraitsMilli: Record<string, number> = {};
  for (const key of Object.keys(birthRaw).sort()) {
    const value = birthRaw[key];
    if (
      typeof value !== 'number'
      || !Number.isFinite(value)
      || value < 0
      || value > 1
    ) {
      throw new QuantumRappidError(
        'invalid-trait',
        `${source}.birth_traits.${key} must be a number between 0 and 1`,
      );
    }
    birthTraits[key] = value;
    birthTraitsMilli[key] = traitMilli(value);
  }
  return {
    schema: requireString(raw.schema, `${source}.schema`),
    rappid: requireString(raw.rappid, `${source}.rappid`),
    birthTraits,
    birthTraitsMilli,
    traits,
    traitsMilli,
  };
}

function parseAsset(raw: JsonValue, where: string): AssetRecord {
  const value = requireObject(raw, where);
  const duration = value.duration_seconds;
  if (duration !== undefined && duration !== null && typeof duration !== 'number') {
    throw new QuantumRappidError('invalid-field', `${where}.duration_seconds must be a number or null`);
  }
  const sha256 = requireString(value.sha256, `${where}.sha256`);
  if (!/^[0-9a-f]{64}$/.test(sha256)) {
    throw new QuantumRappidError('invalid-field', `${where}.sha256 is not a sha-256 digest`);
  }
  return {
    path: requireString(value.path, `${where}.path`),
    bytes: requireInteger(value.bytes, `${where}.bytes`),
    sha256,
    mediaType: requireString(value.media_type, `${where}.media_type`),
    durationSeconds: typeof duration === 'number' ? duration : null,
  };
}

function parseMusicalParameters(raw: JsonValue, where: string): MusicalParameters {
  const value = requireObject(raw, where);
  const scale = requireArray(value.scale, `${where}.scale`).map((entry, index) =>
    requireInteger(entry, `${where}.scale[${index}]`),
  );
  const rootPitch = requireInteger(value.root_pitch, `${where}.root_pitch`);
  return {
    rootPitch,
    rootPitchClass:
      value.root_pitch_class === undefined
        ? ((rootPitch % 12) + 12) % 12
        : requireInteger(value.root_pitch_class, `${where}.root_pitch_class`),
    mode: requireString(value.mode, `${where}.mode`),
    scale,
    bpm: requireInteger(value.bpm, `${where}.bpm`),
    program: parseProgram(value, where),
  };
}

/**
 * The General MIDI program, whichever way this manifest spells it.
 *
 * A profile written today records `program_zero_based` alongside the
 * one-based GM number a musician would quote; an earlier one recorded a bare
 * `program`. Reading all three keeps a rendered voice stable across a
 * dimension that renamed its own field, and the zero-based value is the one
 * that goes on the wire because that is what a MIDI program-change byte is.
 */
function parseProgram(value: JsonObject, where: string): number {
  if (value.program !== undefined) return requireInteger(value.program, `${where}.program`);
  if (value.program_zero_based !== undefined) {
    return requireInteger(value.program_zero_based, `${where}.program_zero_based`);
  }
  if (value.program_gm_one_based !== undefined) {
    return requireInteger(value.program_gm_one_based, `${where}.program_gm_one_based`) - 1;
  }
  throw new QuantumRappidError(
    'invalid-field',
    `${where} records no MIDI program (program, program_zero_based or program_gm_one_based)`,
  );
}

/**
 * Playback roles, normalised across manifest revisions.
 *
 * The sonic dimension has already moved its MIDI refs from two top-level keys
 * into a `midi_data` group. Both spellings are read here so a manifest written
 * by an older organism keeps playing, and unknown keys are ignored rather than
 * rejected — a dimension is allowed to grow new fields.
 */
function parseDevicePlayback(raw: JsonValue | undefined, source: string): DevicePlayback {
  if (raw === undefined || raw === null) {
    return {
      preferred: null,
      losslessFallback: null,
      midiPrompt: null,
      midiAutocomplete: null,
      requiresUserGesture: false,
      stopControlRequired: false,
    };
  }
  const value = requireObject(raw, source);
  const midiGroup =
    value.midi_data === undefined || value.midi_data === null
      ? {}
      : requireObject(value.midi_data, `${source}.midi_data`);
  const ref = (entry: JsonValue | undefined, where: string): string | null =>
    entry === undefined || entry === null ? null : requireString(entry, where);
  return {
    preferred: ref(value.preferred, `${source}.preferred`),
    losslessFallback: ref(value.lossless_fallback, `${source}.lossless_fallback`),
    midiPrompt:
      ref(value.midi_prompt, `${source}.midi_prompt`)
      ?? ref(midiGroup.prompt, `${source}.midi_data.prompt`),
    midiAutocomplete:
      ref(value.midi_autocomplete, `${source}.midi_autocomplete`)
      ?? ref(midiGroup.autocomplete, `${source}.midi_data.autocomplete`),
    requiresUserGesture: value.requires_user_gesture === true,
    stopControlRequired: value.stop_control_required === true,
  };
}

export interface SonicProfileEvidence {
  /** sha256 of the profile file exactly as it was read. */
  fileSha256: string;
  /** The `sonic-profile.sha256` sidecar digest, when one is present. */
  sidecarSha256: string | null;
}

export function parseSonicProfile(
  raw: JsonObject,
  source: string,
  evidence: SonicProfileEvidence,
): SonicProfile {
  const identity = requireObject(raw.identity, `${source}.identity`);
  const traitsRaw = requireObject(raw.traits, `${source}.traits`);
  const traits: Record<string, number> = {};
  for (const key of Object.keys(traitsRaw).sort()) {
    const value = traitsRaw[key];
    if (typeof value !== 'number') {
      throw new QuantumRappidError('invalid-trait', `${source}.traits.${key} must be a number`);
    }
    traits[key] = value;
  }
  const stats = raw.creature_stats === undefined ? null : requireObject(raw.creature_stats, `${source}.creature_stats`);
  const devicePlayback = parseDevicePlayback(raw.device_playback, `${source}.device_playback`);

  return {
    schema: requireString(raw.schema, `${source}.schema`),
    rappid: requireString(raw.rappid, `${source}.rappid`),
    dimension: requireString(raw.dimension, `${source}.dimension`),
    manifestSha256: optionalString(raw.manifest_sha256, `${source}.manifest_sha256`),
    sidecarSha256: evidence.sidecarSha256,
    fileSha256: evidence.fileSha256,
    identitySeedSha256: optionalString(
      identity.identity_seed_sha256,
      `${source}.identity.identity_seed_sha256`,
    ),
    evolutionSeedSha256: optionalString(
      identity.evolution_seed_sha256,
      `${source}.identity.evolution_seed_sha256`,
    ),
    traits,
    musical: parseMusicalParameters(raw.musical_parameters, `${source}.musical_parameters`),
    prompt: requireArray(raw.prompt, `${source}.prompt`).map((entry, index) =>
      noteFromJson(requireObject(entry, `${source}.prompt[${index}]`), `${source}.prompt[${index}]`),
    ),
    assets: requireArray(raw.assets, `${source}.assets`).map((entry, index) =>
      parseAsset(entry, `${source}.assets[${index}]`),
    ),
    devicePlayback,
    recordedStage: stats === null ? null : optionalString(stats.lifecycle_stage, `${source}.creature_stats.lifecycle_stage`),
    raw,
  };
}

export function assetToJson(asset: AssetRecord): JsonObject {
  const value: JsonObject = {
    path: asset.path,
    bytes: asset.bytes,
    sha256: asset.sha256,
    media_type: asset.mediaType,
  };
  if (asset.durationSeconds !== null) value.duration_seconds = asset.durationSeconds;
  return value;
}

export function mediaRef(bytes: Uint8Array, mediaType: string): JsonObject {
  if (!/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(mediaType)) {
    throw new QuantumRappidError('media-type', `invalid RAPP/1 media type: ${mediaType}`);
  }
  return {
    space: RAPP_EGG_DOMAIN,
    hash: rappHb(RAPP_EGG_DOMAIN, bytes),
    media_type: mediaType,
    bytes: bytes.length,
  };
}

const DIMENSION_PAYLOAD_KEYS = [
  'rappid',
  'dimension',
  'version',
  'stage',
  'traits',
  'traits_hash',
  'media',
  'sources',
] as const;
const HEX64 = /^[0-9a-f]{64}$/;
const MEDIA_TYPE =
  /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;
const MEMORY_STREAM =
  /^rappid:@[a-z0-9]+(?:-[a-z0-9]+)*\/[a-z0-9]+(?:-[a-z0-9]+)*:[0-9a-f]{64}:[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SWARM_STREAM = /^net:[a-z0-9]+(?:-[a-z0-9]+)*$/;
const BODY_DIMENSION_FRAME_PROFILE: Readonly<
  RappBodyFrameProfile<RappDimensionPayload, 'body.dimension'>
> = Object.freeze({
  name: 'openrappter-body-dimension',
  kinds: Object.freeze(['body.dimension'] as const),
  signature: 'unsigned-local',
});

export function bodyFrameToJson(frame: BodyFrame): JsonObject {
  return rappFrameToJson(frame);
}

/** The nine-key RAPP/1 wave preimage (frame_hash and sig removed). */
export function bodyFrameBody(frame: BodyFrame): JsonObject {
  const value = rappFrameToJson(frame);
  delete value.frame_hash;
  delete value.sig;
  return value;
}

export function bodyFrameDigest(frame: BodyFrame): string {
  return rappFrameDigest(frame);
}

export function buildDimensionFrame(input: {
  rappid: string;
  seq: number;
  utc: string;
  prev: string | null;
  dimension: string;
  version: number;
  stage: { name: string; ordinal: number };
  traits: JsonObject;
  media: JsonObject;
  sources?: JsonValue[];
}): BodyFrame {
  const payload = {
    rappid: input.rappid,
    dimension: input.dimension,
    version: input.version,
    stage: { name: input.stage.name, ordinal: input.stage.ordinal },
    traits: input.traits,
    traits_hash: rappH(RAPP_PARTICLE_DOMAIN, input.traits),
    media: input.media,
    sources: input.sources ?? [],
  };
  return hashRappBodyFrame({
    kind: 'body.dimension',
    streamId: input.rappid,
    seq: input.seq,
    utc: input.utc,
    payload,
    prev: input.prev,
  }) as BodyFrame;
}

export function parseBodyFrame(raw: JsonObject, source: string): BodyFrame {
  if (
    Object.keys(raw).sort().join('\0')
    !== [...RAPP_FRAME_KEYS].sort().join('\0')
  ) {
    throw new QuantumRappidError(
      'frame-shape',
      `${source} is not the exact eleven-key RAPP/1 envelope`,
    );
  }
  const utc = requireString(raw.utc, `${source}.utc`);
  if (!FRAME_TIME_PATTERN.test(utc)) {
    throw new QuantumRappidError(
      'invalid-field',
      `${source}.utc must be YYYY-MM-DDTHH:MM:SS.mmmZ`,
    );
  }
  const payload = requireObject(raw.payload, `${source}.payload`);
  const kind = requireString(raw.kind, `${source}.kind`);
  if (kind !== 'body.dimension') {
    throw new QuantumRappidError('frame-kind', `${source}.kind is not body.dimension`);
  }
  return {
    spec: requireString(raw.spec, `${source}.spec`) as 'rapp/1',
    kind: 'body.dimension',
    stream_id: requireString(raw.stream_id, `${source}.stream_id`),
    seq: requireInteger(raw.seq, `${source}.seq`),
    utc,
    payload: payload as BodyFrame['payload'],
    payload_hash: requireString(raw.payload_hash, `${source}.payload_hash`),
    frame_hash: requireString(raw.frame_hash, `${source}.frame_hash`),
    prev: optionalString(raw.prev, `${source}.prev`),
    prev_wave: raw.prev_wave === null ? null : (() => {
      throw new QuantumRappidError('frame-wire', `${source}.prev_wave must be null on a body stream`);
    })(),
    sig: raw.sig === null ? null : (() => {
      throw new QuantumRappidError('frame-signature', `${source}.sig must be null for this local body profile`);
    })(),
  };
}

export function bodyFrameProblems(
  frame: BodyFrame,
  head: BodyFrame | null,
  streamId: string,
): string[] {
  const problems: string[] = [];
  const common = verifyRappFrame(frame, BODY_DIMENSION_FRAME_PROFILE, {
    head,
    streamIdOfRecord: streamId,
  });
  if (!common.ok && ['key-set', 'canonical'].includes(common.error.code)) {
    return [common.error.message];
  }
  if (
    !common.ok
    && [
      'stream-id',
      'signature-format',
      'signature-profile',
    ].includes(common.error.code)
  ) {
    problems.push(common.error.message);
  }
  if (frame.spec !== 'rapp/1') problems.push('spec is not rapp/1');
  if (frame.kind !== 'body.dimension') problems.push('kind is not body.dimension');
  if (frame.stream_id !== streamId) problems.push('stream_id does not match the organism');
  if (frame.payload.rappid !== streamId) problems.push('payload.rappid does not match stream_id');
  if (!Number.isSafeInteger(frame.seq) || frame.seq < 0) {
    problems.push('seq is not a uint53');
  }
  if (!isRappFrameUtc(frame.utc)) {
    problems.push('utc is not a valid fixed-width RFC 3339 timestamp');
  }
  if (!HEX64.test(frame.payload_hash)) problems.push('payload_hash is not 64hex');
  if (!HEX64.test(frame.frame_hash)) problems.push('frame_hash is not 64hex');
  if (frame.prev !== null && !HEX64.test(frame.prev)) problems.push('prev is not null or 64hex');
  if (
    Object.keys(frame.payload).sort().join('\0')
    !== [...DIMENSION_PAYLOAD_KEYS].sort().join('\0')
  ) {
    problems.push('body.dimension payload does not have its exact key set');
  }
  if (!LABEL.test(frame.payload.dimension)) problems.push('dimension is not an lclabel');
  if (
    !Number.isSafeInteger(frame.payload.version)
    || frame.payload.version < 1
  ) {
    problems.push('dimension version is not a uint53 >= 1');
  }
  const stage = frame.payload.stage;
  if (
    stage === null
    || Array.isArray(stage)
    || Object.keys(stage).sort().join('\0') !== 'name\0ordinal'
    || typeof stage.name !== 'string'
    || !LABEL.test(stage.name)
    || typeof stage.ordinal !== 'number'
    || !Number.isSafeInteger(stage.ordinal)
    || stage.ordinal < 0
  ) {
    problems.push('stage is not exactly {name:lclabel, ordinal:uint53}');
  }
  if (
    frame.payload.traits === null
    || Array.isArray(frame.payload.traits)
  ) {
    problems.push('traits is not an object');
  }
  const media = frame.payload.media;
  if (media === null || Array.isArray(media)) {
    problems.push('media is not an object');
  } else {
    for (const [role, value] of Object.entries(media)) {
      if (!LABEL.test(role)) {
        problems.push(`media role ${role} is not an lclabel`);
        continue;
      }
      if (
        value === null
        || Array.isArray(value)
        || typeof value !== 'object'
      ) {
        problems.push(`media.${role} is not an object`);
        continue;
      }
      const ref = value as Record<string, JsonValue>;
      if (
        Object.keys(ref).sort().join('\0')
        !== 'bytes\0hash\0media_type\0space'
      ) {
        problems.push(`media.${role} does not have its exact key set`);
      }
      if (ref.space !== RAPP_EGG_DOMAIN) {
        problems.push(`media.${role}.space is not ${RAPP_EGG_DOMAIN}`);
      }
      if (typeof ref.hash !== 'string' || !HEX64.test(ref.hash)) {
        problems.push(`media.${role}.hash is not 64hex`);
      }
      if (
        typeof ref.media_type !== 'string'
        || !MEDIA_TYPE.test(ref.media_type)
      ) {
        problems.push(`media.${role}.media_type is invalid`);
      }
      if (
        typeof ref.bytes !== 'number'
        || !Number.isSafeInteger(ref.bytes)
        || ref.bytes < 0
      ) {
        problems.push(`media.${role}.bytes is not a uint53`);
      }
    }
  }
  if (!Array.isArray(frame.payload.sources)) {
    problems.push('sources is not an array');
  } else {
    const sourceOrder: string[] = [];
    for (const [index, value] of frame.payload.sources.entries()) {
      if (
        value === null
        || Array.isArray(value)
        || typeof value !== 'object'
      ) {
        problems.push(`sources[${index}] is not an object`);
        continue;
      }
      const source = value as Record<string, JsonValue>;
      if (Object.keys(source).sort().join('\0') !== 'particle\0stream_id') {
        problems.push(`sources[${index}] does not have its exact key set`);
      }
      const sourceStream = source.stream_id;
      const validStream =
        typeof sourceStream === 'string'
        && (
          isRappid(sourceStream)
          || MEMORY_STREAM.test(sourceStream)
          || SWARM_STREAM.test(sourceStream)
        );
      if (!validStream) problems.push(`sources[${index}].stream_id is invalid`);
      if (
        typeof source.particle !== 'string'
        || !HEX64.test(source.particle)
      ) {
        problems.push(`sources[${index}].particle is not 64hex`);
      }
      if (
        typeof sourceStream === 'string'
        && typeof source.particle === 'string'
      ) {
        sourceOrder.push(`${sourceStream}\0${source.particle}`);
      }
    }
    if (
      sourceOrder.join('\x01')
      !== [...new Set(sourceOrder)].sort().join('\x01')
    ) {
      problems.push('sources is not sorted and de-duplicated');
    }
  }
  const expectedSeq = head === null ? 0 : head.seq + 1;
  const expectedPrev = head === null ? null : head.payload_hash;
  if (frame.seq !== expectedSeq) problems.push(`seq ${frame.seq} does not continue ${expectedSeq}`);
  if (frame.prev !== expectedPrev) problems.push('prev does not link the predecessor particle');
  if (frame.prev_wave !== null) problems.push('prev_wave is not null on a body stream');
  if (frame.payload_hash !== rappH(RAPP_PARTICLE_DOMAIN, frame.payload)) {
    problems.push('payload_hash does not cover the payload');
  }
  if (frame.frame_hash !== bodyFrameDigest(frame)) {
    problems.push('frame_hash does not cover the wave preimage');
  }
  if (frame.payload.traits_hash !== rappH(RAPP_PARTICLE_DOMAIN, frame.payload.traits)) {
    problems.push('traits_hash does not cover traits');
  }
  return problems;
}

function frameFileName(seq: number): string {
  return `${String(seq).padStart(6, '0')}.json`;
}

export function loadFrames(directory: string): BodyFrame[] {
  const framesDir = join(directory, FRAMES_DIRECTORY);
  if (!existsSync(framesDir)) return [];
  const files = readdirSync(framesDir)
    .filter((file) => file.endsWith('.json'))
    .sort();
  return files.map((file) => parseBodyFrame(readJson(join(framesDir, file)), `${FRAMES_DIRECTORY}/${file}`));
}

export function loadOrganism(directory: string): LoadedOrganism {
  const root = resolve(directory);
  const document = parseRappidDocument(readJson(join(root, RAPPID_DOCUMENT)), RAPPID_DOCUMENT);
  const traits = parseTraitsDocument(readJson(join(root, TRAITS_DOCUMENT)), TRAITS_DOCUMENT);
  return { directory: root, document, traits, sonic: loadSonicProfile(root), frames: loadFrames(root) };
}

/**
 * The sonic profile, with the evidence that proves it has not been edited.
 *
 * Two revisions of the manifest are in the wild: one embeds `manifest_sha256`
 * over its own canonical JSON, the next writes a `sha256sum`-style sidecar over
 * the file bytes. Both are read, because refusing to load an organism whose
 * dimension grew a new integrity spelling would be the loader deciding it
 * knows better than the creature.
 */
export function loadSonicProfile(root: string): SonicProfile | null {
  const profilePath = join(root, SONIC_PROFILE);
  if (!existsSync(profilePath)) return null;
  const bytes = readFileSync(profilePath);
  let parsed: JsonValue;
  try {
    parsed = JSON.parse(bytes.toString('utf8')) as JsonValue;
  } catch (error) {
    throw new QuantumRappidError(
      'invalid-json',
      `${SONIC_PROFILE} is not JSON: ${(error as Error).message}`,
    );
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new QuantumRappidError('invalid-json', `${SONIC_PROFILE} must contain a JSON object`);
  }
  return parseSonicProfile(parsed, SONIC_PROFILE, {
    fileSha256: sha256Hex(bytes),
    sidecarSha256: readSidecarDigest(join(root, SONIC_PROFILE_SIDECAR)),
  });
}

/** `<sha256>  <filename>` — the format `shasum -a 256` writes. */
export function readSidecarDigest(path: string): string | null {
  if (!existsSync(path)) return null;
  const first = readFileSync(path, 'utf8').split('\n')[0].trim();
  const digest = first.split(/\s+/)[0];
  if (!/^[0-9a-f]{64}$/.test(digest)) {
    throw new QuantumRappidError(
      'invalid-sidecar',
      `${basename(path)} does not start with a sha-256 digest`,
    );
  }
  return digest;
}

/** Every organism directory in a habitat, in a stable order. */
export function listOrganismDirectories(root = rappidsHome()): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => join(root, entry.name))
    .filter((directory) => {
      const manifest = join(directory, RAPPID_DOCUMENT);
      if (!existsSync(manifest)) return false;
      try {
        const raw = readJson(manifest);
        const quantum = raw.quantum;
        return (
          raw.kind === 'quantum-rappid'
          && quantum !== null
          && typeof quantum === 'object'
          && !Array.isArray(quantum)
          && quantum.schema === 'quantum-rappid/1.0'
        );
      } catch {
        return false;
      }
    })
    .sort();
}

export function loadOrganisms(root = rappidsHome()): LoadedOrganism[] {
  return listOrganismDirectories(root).map(loadOrganism);
}

export function loadOrganismByRappid(rappid: string, root = rappidsHome()): LoadedOrganism {
  parseRappid(rappid);
  for (const directory of listOrganismDirectories(root)) {
    const organism = loadOrganism(directory);
    if (organism.document.rappid === rappid) return organism;
  }
  throw new QuantumRappidError('not-found', `no organism in ${root} carries ${rappid}`);
}

/** The directory a dimension's manifest paths are relative to. */
export function dimensionRoot(organism: LoadedOrganism, dimension: string): string {
  return resolveWithin(organism.directory, dimension);
}

export function assetBytes(organism: LoadedOrganism, dimension: string, path: string): Buffer {
  const target = resolveWithin(dimensionRoot(organism, dimension), path);
  return readFileSync(target);
}

export function assetExists(organism: LoadedOrganism, dimension: string, path: string): boolean {
  const target = resolveWithin(dimensionRoot(organism, dimension), path);
  return existsSync(target) && statSync(target).isFile();
}

export function objectPath(organism: LoadedOrganism, hash: string): string {
  if (!/^[0-9a-f]{64}$/.test(hash)) {
    throw new QuantumRappidError('object-hash', `invalid RAPP/1 object hash: ${hash}`);
  }
  return resolveWithin(
    organism.directory,
    `${OBJECTS_DIRECTORY}/${hash}`,
  );
}

export function readRappObject(
  organism: LoadedOrganism,
  hash: string,
): Buffer | null {
  const target = objectPath(organism, hash);
  return existsSync(target) && statSync(target).isFile()
    ? readFileSync(target)
    : null;
}

export function storeRappObject(
  organism: LoadedOrganism,
  bytes: Buffer,
): string {
  const hash = rappHb(RAPP_EGG_DOMAIN, bytes);
  const target = objectPath(organism, hash);
  if (existsSync(target)) {
    const existing = readFileSync(target);
    if (rappHb(RAPP_EGG_DOMAIN, existing) !== hash) {
      throw new QuantumRappidError(
        'object-collision',
        `RAPP/1 object ${hash} exists with different bytes`,
      );
    }
    return hash;
  }
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, bytes, { flag: 'wx', mode: 0o600 });
  return hash;
}

/**
 * Write a content-addressed asset into a dimension.
 *
 * Content addressing makes this idempotent: the same bytes always land on the
 * same name, so re-running growth cannot fork an organism into two copies of
 * one asset. A name that already holds *different* bytes is a collision that
 * must never be papered over, so it raises rather than overwrites.
 */
export function writeDimensionAsset(
  organism: LoadedOrganism,
  dimension: string,
  path: string,
  bytes: Buffer,
): AssetRecord {
  const target = resolveWithin(dimensionRoot(organism, dimension), path);
  const digest = sha256Hex(bytes);
  storeRappObject(organism, bytes);
  if (existsSync(target)) {
    const existing = readFileSync(target);
    if (sha256Hex(existing) !== digest) {
      throw new QuantumRappidError(
        'asset-collision',
        `${dimension}/${path} already exists with different bytes`,
      );
    }
  } else {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes, { mode: 0o600 });
  }
  return {
    path,
    bytes: bytes.length,
    sha256: digest,
    mediaType: mediaTypeForPath(path),
    durationSeconds: null,
  };
}

/**
 * Append one body frame. The only writer of organism history.
 *
 * `wx` is the whole guarantee: the file is created or the call fails. A frame
 * whose index already exists means two writers raced or history is being
 * rewritten, and both deserve an error rather than a silent overwrite.
 */
export function appendBodyFrame(organism: LoadedOrganism, frame: BodyFrame): string {
  if (!FRAME_TIME_PATTERN.test(frame.utc)) {
    throw new QuantumRappidError(
      'frame-time',
      `frame utc ${frame.utc} is not YYYY-MM-DDTHH:MM:SS.mmmZ`,
    );
  }
  const head = organism.frames.at(-1) ?? null;
  const problems = bodyFrameProblems(
    frame,
    head,
    organism.document.rappid,
  );
  if (problems.length > 0) {
    throw new QuantumRappidError(
      'frame-invalid',
      `RAPP/1 frame refused: ${problems.join('; ')}`,
    );
  }

  const framesDir = join(organism.directory, FRAMES_DIRECTORY);
  mkdirSync(framesDir, { recursive: true });
  const target = join(framesDir, frameFileName(frame.seq));
  const temporary = `${target}.partial`;
  const payload = `${JSON.stringify(bodyFrameToJson(frame), null, 2)}\n`;
  // Create-exclusive on the temp file too: a leftover `.partial` from a killed
  // process is evidence, not scratch space to reuse.
  const handle = openSync(temporary, 'wx', 0o600);
  try {
    writeSync(handle, payload);
  } finally {
    closeSync(handle);
  }
  if (existsSync(target)) {
    throw new QuantumRappidError('frame-exists', `${basename(target)} already exists; history is append-only`);
  }
  renameSync(temporary, target);
  organism.frames.push(frame);
  return target;
}
