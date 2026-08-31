import {
  RAPP_PARTICLE_DOMAIN,
  RAPP_WAVE_DOMAIN,
  parseRappJson,
  rappCanonicalJson,
  rappH,
} from '../rappids/canonical.js';
import type { JsonObject, JsonValue } from '../rappids/types.js';
import {
  ACCEPTED_RAPP_PROTOCOL_AUTHORITY,
  ProtocolAuthority,
  type ProtocolAuthorityIdentity,
  type RappStreamFamily,
} from './authority.js';

export const RAPP_FRAME_SPEC = 'rapp/1' as const;
export const RAPP_FRAME_KEYS = [
  'spec',
  'kind',
  'stream_id',
  'seq',
  'utc',
  'payload',
  'payload_hash',
  'frame_hash',
  'prev',
  'prev_wave',
  'sig',
] as const;
export const RAPP_UINT53_MAX = 2 ** 53 - 1;
export const RAPP_FRAME_TIME_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export interface RappFrame<
  TPayload extends JsonObject = JsonObject,
  TKind extends string = string,
> {
  spec: typeof RAPP_FRAME_SPEC;
  kind: TKind;
  stream_id: string;
  seq: number;
  utc: string;
  payload: TPayload;
  payload_hash: string;
  frame_hash: string;
  prev: string | null;
  prev_wave: string | null;
  sig: string | null;
}

export type RappFrameHead = Pick<
  RappFrame,
  'stream_id' | 'seq' | 'utc' | 'payload_hash' | 'frame_hash'
>;

export interface RappTrustAssessment {
  classification: 'integrity-only' | 'legacy-integrity-only';
  promotionGrade: false;
  authority: Readonly<ProtocolAuthorityIdentity> | null;
  genesis: 'unbound' | 'trusted';
  persistedHead: 'untracked' | 'matched' | 'advanced';
}

const PROFILE_BRAND: unique symbol = Symbol('rapp-frame-profile');

export interface RappFrameProfile<
  TPayload extends JsonObject,
  TKind extends string,
> {
  readonly [PROFILE_BRAND]: true;
  readonly name: string;
  readonly kind: TKind;
  readonly family: RappStreamFamily;
  readonly authority: ProtocolAuthority | null;
  readonly mode: 'authority' | 'legacy-integrity';
  readonly signature: 'unsigned-local';
  readonly validatePayload?: (payload: JsonObject) =>
    | { ok: true; payload: TPayload }
    | { ok: false; error: string };
  readonly uniquePayloads: boolean;
}

export interface CreateRappFrameProfileInput<
  TPayload extends JsonObject,
  TKind extends string,
> {
  name: string;
  kind: TKind;
  authority?: ProtocolAuthority;
  signature?: 'unsigned-local';
  validatePayload?: RappFrameProfile<TPayload, TKind>['validatePayload'];
  uniquePayloads?: boolean;
}

export function createRappFrameProfile<
  TPayload extends JsonObject,
  TKind extends string,
>(
  input: CreateRappFrameProfileInput<TPayload, TKind>,
): Readonly<RappFrameProfile<TPayload, TKind>> {
  const authority = input.authority ?? ACCEPTED_RAPP_PROTOCOL_AUTHORITY;
  if (!(authority instanceof ProtocolAuthority)) {
    throw new TypeError('frame profiles require an immutable selected ProtocolAuthority');
  }
  const family = authority.familyForKind(input.kind);
  if (family === null) {
    throw new TypeError(
      `kind ${input.kind} is not registered by accepted authority ${authority.revision}`,
    );
  }
  return Object.freeze({
    [PROFILE_BRAND]: true as const,
    name: input.name,
    kind: input.kind,
    family,
    authority,
    mode: 'authority' as const,
    signature: input.signature ?? 'unsigned-local',
    validatePayload: input.validatePayload,
    uniquePayloads: input.uniquePayloads ?? false,
  });
}

export function createLegacyRappIntegrityProfile<
  TPayload extends JsonObject,
  TKind extends string,
>(input: {
  name: string;
  kind: TKind;
  family: RappStreamFamily;
  validatePayload?: RappFrameProfile<TPayload, TKind>['validatePayload'];
  uniquePayloads?: boolean;
}): Readonly<RappFrameProfile<TPayload, TKind>> {
  return Object.freeze({
    [PROFILE_BRAND]: true as const,
    name: input.name,
    kind: input.kind,
    family: input.family,
    authority: null,
    mode: 'legacy-integrity' as const,
    signature: 'unsigned-local' as const,
    validatePayload: input.validatePayload,
    uniquePayloads: input.uniquePayloads ?? false,
  });
}

export const RAPP_ACCEPTED_BODY_PULSE_PROFILE = createRappFrameProfile<
  JsonObject,
  'body.pulse'
>({
  name: 'rapp-accepted-body-pulse',
  kind: 'body.pulse',
  uniquePayloads: true,
});

export type RappFrameVerificationStep = '1' | '1a' | '2' | '3' | '4' | '5' | '6';

export type RappFrameErrorCode =
  | 'profile'
  | 'authority-policy'
  | 'key-set'
  | 'spec'
  | 'kind'
  | 'unregistered-kind'
  | 'profile-kind'
  | 'kind-family'
  | 'stream-id'
  | 'seq'
  | 'utc'
  | 'payload'
  | 'canonical'
  | 'payload-profile'
  | 'payload-hash-format'
  | 'frame-hash-format'
  | 'prev-format'
  | 'prev-wave-format'
  | 'signature-format'
  | 'stream-binding'
  | 'payload-hash'
  | 'frame-hash'
  | 'genesis'
  | 'untrusted-genesis'
  | 'unauthorized-re-genesis'
  | 'seq-continuity'
  | 'prev-continuity'
  | 'time-regression'
  | 'prev-wave'
  | 'signature-required'
  | 'signature-profile'
  | 'empty-chain'
  | 'duplicate-seq'
  | 'duplicate-frame-hash'
  | 'duplicate-payload-hash'
  | 'fork'
  | 'rollback'
  | 'known-head-conflict';

export class RappFrameError extends Error {
  readonly code: RappFrameErrorCode;
  readonly step: RappFrameVerificationStep | null;
  readonly frameIndex: number | null;

  constructor(
    code: RappFrameErrorCode,
    step: RappFrameVerificationStep | null,
    message: string,
    frameIndex: number | null = null,
  ) {
    super(message);
    this.name = 'RappFrameError';
    this.code = code;
    this.step = step;
    this.frameIndex = frameIndex;
  }
}

export type RappFrameVerification<TFrame extends RappFrame = RappFrame> =
  | { ok: true; frame: TFrame; trust: Readonly<RappTrustAssessment> }
  | { ok: false; error: RappFrameError };

export type RappFrameChainVerification<TFrame extends RappFrame = RappFrame> =
  | {
    ok: true;
    frames: readonly TFrame[];
    head: TFrame;
    trust: Readonly<RappTrustAssessment>;
  }
  | { ok: false; error: RappFrameError };

export interface VerifyRappFrameOptions {
  head: RappFrameHead | null;
  streamIdOfRecord: string;
}

export interface BuildRappFrameInput<TPayload extends JsonObject, TKind extends string> {
  kind: TKind;
  streamId: string;
  utc: string;
  payload: TPayload;
  head: RappFrameHead | null;
}

export interface TrustedRappGenesis {
  streamId: string;
  frameHash: string;
  payloadHash: string;
}

export interface PersistedRappHead {
  streamId: string;
  seq: number;
  frameHash: string;
}

const TRUST_POLICY_BRAND: unique symbol = Symbol('rapp-chain-trust-policy');

export interface RappChainTrustPolicy {
  readonly [TRUST_POLICY_BRAND]: true;
  readonly authority: ProtocolAuthority;
  readonly trustedGenesis: Readonly<TrustedRappGenesis>;
  readonly persistedHead: Readonly<PersistedRappHead> | null;
}

const HEX64 = /^[0-9a-f]{64}$/;
const LCLABEL = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FRAME_KEY_SET = [...RAPP_FRAME_KEYS].sort().join('\0');
const RAPPID =
  /^rappid:@([a-z0-9]+(?:-[a-z0-9]+)*)\/([a-z0-9]+(?:-[a-z0-9]+)*):([0-9a-f]{64})$/;
const MEMORY_STREAM =
  /^(rappid:@[a-z0-9]+(?:-[a-z0-9]+)*\/[a-z0-9]+(?:-[a-z0-9]+)*:[0-9a-f]{64}):([a-z0-9]+(?:-[a-z0-9]+)*)$/;
const SWARM_STREAM = /^net:([a-z0-9]+(?:-[a-z0-9]+)*)$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && (
      Object.getPrototypeOf(value) === Object.prototype
      || Object.getPrototypeOf(value) === null
    )
  );
}

function freezeRappValue<TValue extends JsonValue>(value: TValue): TValue {
  if (value !== null && typeof value === 'object') {
    for (const child of Array.isArray(value) ? value : Object.values(value)) {
      freezeRappValue(child);
    }
    Object.freeze(value);
  }
  return value;
}

function immutableRappValue<TValue extends JsonValue>(value: TValue): TValue {
  return freezeRappValue(parseRappJson(rappCanonicalJson(value)) as TValue);
}

function trustFor(
  profile: RappFrameProfile<JsonObject, string>,
  genesis: RappTrustAssessment['genesis'],
  persistedHead: RappTrustAssessment['persistedHead'],
): Readonly<RappTrustAssessment> {
  return Object.freeze({
    classification:
      profile.mode === 'authority' ? 'integrity-only' : 'legacy-integrity-only',
    promotionGrade: false,
    authority: profile.authority?.identity() ?? null,
    genesis,
    persistedHead,
  });
}

function fail<TFrame extends RappFrame>(
  code: RappFrameErrorCode,
  step: RappFrameVerificationStep,
  message: string,
): RappFrameVerification<TFrame> {
  return { ok: false, error: new RappFrameError(code, step, message) };
}

function chainFail<TFrame extends RappFrame>(
  code: RappFrameErrorCode,
  message: string,
  frameIndex: number | null,
  step: RappFrameVerificationStep | null = '4',
): RappFrameChainVerification<TFrame> {
  return {
    ok: false,
    error: new RappFrameError(code, step, message, frameIndex),
  };
}

function profileIsValid(
  profile: RappFrameProfile<JsonObject, string>,
): boolean {
  return profile[PROFILE_BRAND] === true;
}

function policyIsValid(policy: RappChainTrustPolicy): boolean {
  return policy[TRUST_POLICY_BRAND] === true;
}

export function isRappBodyStream(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = RAPPID.exec(value);
  return match !== null && match[1].length <= 39 && match[2].length <= 100;
}

export function isRappMemoryStream(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = MEMORY_STREAM.exec(value);
  if (match === null || match[2].length > 64) return false;
  return isRappBodyStream(match[1]);
}

export function isRappSwarmStream(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = SWARM_STREAM.exec(value);
  return match !== null && match[1].length <= 64;
}

export function rappStreamFamily(value: unknown): RappStreamFamily | null {
  if (isRappBodyStream(value)) return 'body';
  if (isRappMemoryStream(value)) return 'memory';
  if (isRappSwarmStream(value)) return 'swarm';
  return null;
}

export function isRappFrameKind(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const labels = value.split('.');
  return (
    labels.length === 2
    && labels.every((label) => label.length <= 64 && LCLABEL.test(label))
  );
}

export function isRappFrameUtc(value: unknown): value is string {
  if (typeof value !== 'string' || !RAPP_FRAME_TIME_PATTERN.test(value)) {
    return false;
  }
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const hour = Number(value.slice(11, 13));
  const minute = Number(value.slice(14, 16));
  const second = Number(value.slice(17, 19));
  if (
    year < 1
    || month < 1
    || month > 12
    || hour > 23
    || minute > 59
    || second > 59
  ) {
    return false;
  }
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day >= 1 && day <= days[month - 1];
}

export function selectRappChainTrustPolicy(input: {
  authority?: ProtocolAuthority;
  trustedGenesis: TrustedRappGenesis;
  persistedHead?: PersistedRappHead | null;
}): Readonly<RappChainTrustPolicy> {
  const authority = input.authority ?? ACCEPTED_RAPP_PROTOCOL_AUTHORITY;
  if (!(authority instanceof ProtocolAuthority)) {
    throw new TypeError('chain trust policy requires an immutable selected ProtocolAuthority');
  }
  const genesis = input.trustedGenesis;
  if (
    rappStreamFamily(genesis.streamId) === null
    || !HEX64.test(genesis.frameHash)
    || !HEX64.test(genesis.payloadHash)
  ) {
    throw new TypeError('trusted genesis must name a valid stream and two 64hex addresses');
  }
  const persisted = input.persistedHead ?? null;
  if (persisted !== null) {
    if (
      persisted.streamId !== genesis.streamId
      || !Number.isSafeInteger(persisted.seq)
      || persisted.seq < 0
      || persisted.seq > RAPP_UINT53_MAX
      || !HEX64.test(persisted.frameHash)
    ) {
      throw new TypeError('persisted head is not valid for the trusted genesis stream');
    }
    if (persisted.seq === 0 && persisted.frameHash !== genesis.frameHash) {
      throw new TypeError('persisted genesis conflicts with the selected trusted genesis');
    }
  }
  return Object.freeze({
    [TRUST_POLICY_BRAND]: true as const,
    authority,
    trustedGenesis: Object.freeze({ ...genesis }),
    persistedHead: persisted === null ? null : Object.freeze({ ...persisted }),
  });
}

export function rappFrameToJson(frame: RappFrame): JsonObject {
  return {
    spec: frame.spec,
    kind: frame.kind,
    stream_id: frame.stream_id,
    seq: frame.seq,
    utc: frame.utc,
    payload: frame.payload,
    payload_hash: frame.payload_hash,
    frame_hash: frame.frame_hash,
    prev: frame.prev,
    prev_wave: frame.prev_wave,
    sig: frame.sig,
  };
}

/** The exact nine-key wave preimage: only frame_hash and sig are removed. */
export function rappFrameWavePreimage(frame: RappFrame): JsonObject {
  const value = rappFrameToJson(frame);
  delete value.frame_hash;
  delete value.sig;
  return value;
}

export function rappFrameDigest(frame: RappFrame): string {
  return rappH(RAPP_WAVE_DOMAIN, rappFrameWavePreimage(frame));
}

function profilePayloadProblem<
  TPayload extends JsonObject,
  TKind extends string,
>(
  profile: RappFrameProfile<TPayload, TKind>,
  payload: JsonObject,
): string | null {
  const result = profile.validatePayload?.(payload);
  return result === undefined || result.ok ? null : result.error;
}

function verifyThroughWave<
  TPayload extends JsonObject,
  TKind extends string,
>(
  value: unknown,
  profile: RappFrameProfile<TPayload, TKind>,
  streamIdOfRecord: string,
  predecessorStreamId?: string,
): RappFrameVerification<RappFrame<TPayload, TKind>> {
  if (!profileIsValid(profile as RappFrameProfile<JsonObject, string>)) {
    return fail('profile', '1', 'frame profile was not selected by a profile factory');
  }
  if (!isRecord(value)) {
    return fail('key-set', '1', 'frame is not a JSON object');
  }
  if (Object.keys(value).sort().join('\0') !== FRAME_KEY_SET) {
    return fail('key-set', '1', 'frame does not have the exact eleven-key RAPP/1 envelope');
  }
  if (value.spec !== RAPP_FRAME_SPEC) {
    return fail('spec', '1', 'spec is not rapp/1');
  }
  if (!isRappFrameKind(value.kind)) {
    return fail('kind', '1', 'kind does not match the RAPP/1 noun.verb grammar');
  }
  const streamFamily = rappStreamFamily(value.stream_id);
  if (streamFamily === null) {
    return fail('stream-id', '1', 'stream_id does not match a registered RAPP stream form');
  }
  if (profile.mode === 'authority') {
    const registeredFamily = profile.authority!.familyForKind(value.kind);
    if (registeredFamily === null) {
      return fail(
        'unregistered-kind',
        '1',
        `kind ${value.kind} is not registered by accepted authority ${profile.authority!.revision}`,
      );
    }
    if (registeredFamily !== streamFamily) {
      return fail(
        'kind-family',
        '1',
        `registered ${registeredFamily} kind ${value.kind} cannot use a ${streamFamily} stream`,
      );
    }
  } else if (streamFamily !== profile.family) {
    return fail(
      'kind-family',
      '1',
      `legacy ${profile.family} kind ${value.kind} cannot use a ${streamFamily} stream`,
    );
  }
  if (value.kind !== profile.kind) {
    return fail(
      'profile-kind',
      '1',
      `profile ${profile.name} verifies ${profile.kind}, not ${value.kind}`,
    );
  }
  if (
    typeof value.seq !== 'number'
    || !Number.isSafeInteger(value.seq)
    || value.seq < 0
    || value.seq > RAPP_UINT53_MAX
  ) {
    return fail('seq', '1', 'seq is not a uint53');
  }
  if (!isRappFrameUtc(value.utc)) {
    return fail('utc', '1', 'utc is not a calendar-valid fixed-width RFC 3339 timestamp');
  }
  if (!isRecord(value.payload)) {
    return fail('payload', '1', 'payload is not a JSON object');
  }
  if (typeof value.payload_hash !== 'string' || !HEX64.test(value.payload_hash)) {
    return fail('payload-hash-format', '1', 'payload_hash is not 64 lowercase hex');
  }
  if (typeof value.frame_hash !== 'string' || !HEX64.test(value.frame_hash)) {
    return fail('frame-hash-format', '1', 'frame_hash is not 64 lowercase hex');
  }
  if (value.prev !== null && (typeof value.prev !== 'string' || !HEX64.test(value.prev))) {
    return fail('prev-format', '1', 'prev is not null or 64 lowercase hex');
  }
  if (
    value.prev_wave !== null
    && (typeof value.prev_wave !== 'string' || !HEX64.test(value.prev_wave))
  ) {
    return fail('prev-wave-format', '1', 'prev_wave is not null or 64 lowercase hex');
  }
  if (value.sig !== null && typeof value.sig !== 'string') {
    return fail('signature-format', '1', 'sig is not null or a JWS string');
  }
  try {
    rappCanonicalJson(value as JsonValue);
  } catch (error) {
    return fail(
      'canonical',
      '1',
      error instanceof Error ? error.message : 'frame is outside the RAPP/1 canonical domain',
    );
  }
  const payloadProblem = profilePayloadProblem(profile, value.payload as JsonObject);
  if (payloadProblem !== null) {
    return fail('payload-profile', '1', payloadProblem);
  }
  if (value.stream_id !== streamIdOfRecord) {
    return fail('stream-binding', '1a', 'stream_id does not match the stream of record');
  }
  if (
    predecessorStreamId !== undefined
    && value.stream_id !== predecessorStreamId
  ) {
    return fail('stream-binding', '1a', 'predecessor belongs to a different stream');
  }
  if (value.payload_hash !== rappH(RAPP_PARTICLE_DOMAIN, value.payload as JsonObject)) {
    return fail('payload-hash', '2', 'payload_hash does not cover the payload');
  }
  const frame = value as unknown as RappFrame<TPayload, TKind>;
  if (value.frame_hash !== rappFrameDigest(frame)) {
    return fail('frame-hash', '3', 'frame_hash does not cover the wave preimage');
  }
  return {
    ok: true,
    frame: immutableRappValue(rappFrameToJson(frame)) as unknown as RappFrame<TPayload, TKind>,
    trust: trustFor(
      profile as unknown as RappFrameProfile<JsonObject, string>,
      'unbound',
      'untracked',
    ),
  };
}

function verifyContinuation<TFrame extends RappFrame>(
  frame: TFrame,
  profile: RappFrameProfile<JsonObject, string>,
  head: RappFrameHead | null,
): RappFrameVerification<TFrame> {
  if (head === null) {
    if (frame.seq !== 0 || frame.prev !== null) {
      return fail('genesis', '4', 'genesis must be seq 0 with prev null');
    }
  } else {
    if (head.stream_id !== frame.stream_id) {
      return fail('stream-binding', '1a', 'predecessor belongs to a different stream');
    }
    if (frame.seq !== head.seq + 1) {
      return fail('seq-continuity', '4', 'seq does not continue the predecessor');
    }
    if (frame.prev !== head.payload_hash) {
      return fail('prev-continuity', '4', 'prev does not link the predecessor payload_hash');
    }
    if (frame.utc < head.utc) {
      return fail('time-regression', '4', 'utc is earlier than the predecessor');
    }
  }

  if (profile.family === 'swarm' && frame.seq > 0) {
    if (head === null || frame.prev_wave !== head.frame_hash) {
      return fail('prev-wave', '5', 'prev_wave does not link the predecessor frame_hash');
    }
  } else if (frame.prev_wave !== null) {
    return fail('prev-wave', '5', 'prev_wave must be null off a non-genesis swarm frame');
  }

  if (profile.family === 'swarm' && frame.sig === null) {
    return fail('signature-required', '6', 'swarm frames must be signed');
  }
  if (profile.signature === 'unsigned-local' && frame.sig !== null) {
    return fail(
      'signature-profile',
      '6',
      'signed frames require a signature-verifying profile',
    );
  }
  return {
    ok: true,
    frame,
    trust: trustFor(profile, 'unbound', 'untracked'),
  };
}

export function verifyRappFrame<
  TPayload extends JsonObject,
  TKind extends string,
>(
  value: unknown,
  profile: RappFrameProfile<TPayload, TKind>,
  options: VerifyRappFrameOptions,
): RappFrameVerification<RappFrame<TPayload, TKind>> {
  const intrinsic = verifyThroughWave(
    value,
    profile,
    options.streamIdOfRecord,
    options.head?.stream_id,
  );
  if (!intrinsic.ok) return intrinsic;
  return verifyContinuation(
    intrinsic.frame,
    profile as unknown as RappFrameProfile<JsonObject, string>,
    options.head,
  );
}

export function assertRappFrame<
  TPayload extends JsonObject,
  TKind extends string,
>(
  value: unknown,
  profile: RappFrameProfile<TPayload, TKind>,
  options: VerifyRappFrameOptions,
): RappFrame<TPayload, TKind> {
  const result = verifyRappFrame(value, profile, options);
  if (!result.ok) throw result.error;
  return result.frame;
}

export function verifyRappFrameJson<
  TPayload extends JsonObject,
  TKind extends string,
>(
  source: string,
  profile: RappFrameProfile<TPayload, TKind>,
  options: VerifyRappFrameOptions,
): RappFrameVerification<RappFrame<TPayload, TKind>> {
  let value: JsonValue;
  try {
    value = parseRappJson(source);
  } catch (error) {
    return fail(
      'canonical',
      '1',
      error instanceof Error ? error.message : 'frame JSON is outside the RAPP/1 input domain',
    );
  }
  return verifyRappFrame(value, profile, options);
}

export function assertRappFrameJson<
  TPayload extends JsonObject,
  TKind extends string,
>(
  source: string,
  profile: RappFrameProfile<TPayload, TKind>,
  options: VerifyRappFrameOptions,
): RappFrame<TPayload, TKind> {
  const result = verifyRappFrameJson(source, profile, options);
  if (!result.ok) throw result.error;
  return result.frame;
}

export function buildRappFrame<
  TPayload extends JsonObject,
  TKind extends string,
>(
  input: BuildRappFrameInput<TPayload, TKind>,
  profile: RappFrameProfile<TPayload, TKind>,
): RappFrame<TPayload, TKind> {
  if (profile.mode !== 'authority') {
    throw new RappFrameError(
      'unregistered-kind',
      '1',
      `legacy integrity profile ${profile.name} is read-only and cannot emit conforming frames`,
    );
  }
  if (input.kind !== profile.kind) {
    throw new RappFrameError('profile-kind', '1', `profile ${profile.name} emits ${profile.kind}`);
  }
  if (input.head !== null && input.head.seq >= RAPP_UINT53_MAX) {
    throw new RappFrameError(
      'seq-continuity',
      '4',
      'cannot append beyond the uint53 sequence ceiling; owner-authorized re-genesis is required',
    );
  }
  let payloadHash: string;
  try {
    payloadHash = rappH(RAPP_PARTICLE_DOMAIN, input.payload);
  } catch (error) {
    throw new RappFrameError(
      'canonical',
      '1',
      error instanceof Error ? error.message : 'payload is outside the RAPP/1 canonical domain',
    );
  }
  const draft: RappFrame<TPayload, TKind> = {
    spec: RAPP_FRAME_SPEC,
    kind: input.kind,
    stream_id: input.streamId,
    seq: input.head === null ? 0 : input.head.seq + 1,
    utc: input.utc,
    payload: input.payload,
    payload_hash: payloadHash,
    frame_hash: '0'.repeat(64),
    prev: input.head === null ? null : input.head.payload_hash,
    prev_wave:
      profile.family === 'swarm' && input.head !== null
        ? input.head.frame_hash
        : null,
    sig: null,
  };
  const frame = { ...draft, frame_hash: rappFrameDigest(draft) };
  return assertRappFrame(frame, profile, {
    head: input.head,
    streamIdOfRecord: input.streamId,
  });
}

/**
 * Recompute addresses for an existing unregistered local body.dimension frame.
 *
 * This is migration/read compatibility only. The returned frame is never
 * promotion-grade and must be checked with an explicit legacy profile.
 */
export function hashLegacyRappBodyFrame<
  TPayload extends JsonObject,
  TKind extends string,
>(input: {
  kind: TKind;
  streamId: string;
  seq: number;
  utc: string;
  payload: TPayload;
  prev: string | null;
}): RappFrame<TPayload, TKind> {
  const payloadHash = rappH(RAPP_PARTICLE_DOMAIN, input.payload);
  const draft: RappFrame<TPayload, TKind> = {
    spec: RAPP_FRAME_SPEC,
    kind: input.kind,
    stream_id: input.streamId,
    seq: input.seq,
    utc: input.utc,
    payload: input.payload,
    payload_hash: payloadHash,
    frame_hash: '0'.repeat(64),
    prev: input.prev,
    prev_wave: null,
    sig: null,
  };
  return { ...draft, frame_hash: rappFrameDigest(draft) };
}

export function verifyRappFrameChain<
  TPayload extends JsonObject,
  TKind extends string,
>(
  values: readonly unknown[],
  profile: RappFrameProfile<TPayload, TKind>,
  policy: RappChainTrustPolicy,
): RappFrameChainVerification<RappFrame<TPayload, TKind>> {
  if (values.length === 0) {
    return chainFail('empty-chain', 'RAPP/1 frame chain is empty', null, null);
  }
  if (
    !policyIsValid(policy)
    || profile.mode !== 'authority'
    || profile.authority !== policy.authority
  ) {
    return chainFail(
      'authority-policy',
      'frame profile and trusted chain policy do not share one selected authority',
      null,
      '1',
    );
  }

  const streamId = policy.trustedGenesis.streamId;
  const intrinsicFrames: RappFrame<TPayload, TKind>[] = [];
  for (let index = 0; index < values.length; index += 1) {
    const result = verifyThroughWave(values[index], profile, streamId);
    if (!result.ok) {
      return {
        ok: false,
        error: new RappFrameError(
          result.error.code,
          result.error.step,
          result.error.message,
          index,
        ),
      };
    }
    intrinsicFrames.push(result.frame);
  }

  const genesis = intrinsicFrames[0];
  if (
    genesis.seq !== 0
    || genesis.prev !== null
    || genesis.frame_hash !== policy.trustedGenesis.frameHash
    || genesis.payload_hash !== policy.trustedGenesis.payloadHash
  ) {
    return chainFail(
      'untrusted-genesis',
      'presented genesis does not match the selected trusted genesis',
      0,
    );
  }
  for (let index = 1; index < intrinsicFrames.length; index += 1) {
    if (intrinsicFrames[index].seq === 0) {
      return chainFail(
        'unauthorized-re-genesis',
        'replacement genesis is not selected by the trust policy',
        index,
      );
    }
  }

  const sequence = new Map<number, { index: number; prev: string | null; frameHash: string }>();
  const frameHashes = new Map<string, number>();
  const payloadHashes = new Map<string, number>();
  for (let index = 0; index < intrinsicFrames.length; index += 1) {
    const frame = intrinsicFrames[index];
    const existingSeq = sequence.get(frame.seq);
    if (existingSeq !== undefined) {
      const fork =
        existingSeq.prev === frame.prev
        && existingSeq.frameHash !== frame.frame_hash;
      return chainFail(
        fork ? 'fork' : 'duplicate-seq',
        fork
          ? `two distinct valid frames claim seq ${frame.seq} and the same predecessor`
          : `duplicate seq ${frame.seq}`,
        index,
      );
    }
    sequence.set(frame.seq, {
      index,
      prev: frame.prev,
      frameHash: frame.frame_hash,
    });

    const existingFrame = frameHashes.get(frame.frame_hash);
    if (existingFrame !== undefined) {
      return chainFail(
        'duplicate-frame-hash',
        `duplicate frame_hash at indexes ${existingFrame} and ${index}`,
        index,
      );
    }
    frameHashes.set(frame.frame_hash, index);

    if (profile.uniquePayloads) {
      const existingPayload = payloadHashes.get(frame.payload_hash);
      if (existingPayload !== undefined) {
        return chainFail(
          'duplicate-payload-hash',
          `duplicate payload_hash at indexes ${existingPayload} and ${index}`,
          index,
        );
      }
      payloadHashes.set(frame.payload_hash, index);
    }

  }

  const accepted: RappFrame<TPayload, TKind>[] = [];
  let head: RappFrame<TPayload, TKind> | null = null;
  for (let index = 0; index < intrinsicFrames.length; index += 1) {
    const result: RappFrameVerification<RappFrame<TPayload, TKind>> =
      verifyContinuation(
        intrinsicFrames[index],
        profile as unknown as RappFrameProfile<JsonObject, string>,
        head,
      );
    if (!result.ok) {
      return {
        ok: false,
        error: new RappFrameError(
          result.error.code,
          result.error.step,
          result.error.message,
          index,
        ),
      };
    }
    accepted.push(result.frame);
    head = result.frame;
  }

  let persistedState: RappTrustAssessment['persistedHead'] = 'untracked';
  const persisted = policy.persistedHead;
  if (persisted !== null) {
    const finalHead = accepted[accepted.length - 1];
    if (finalHead.seq < persisted.seq) {
      return chainFail(
        'rollback',
        `presented head ${finalHead.seq} is below persisted head ${persisted.seq}`,
        accepted.length - 1,
      );
    }
    const knownIndex = accepted.findIndex((frame) => frame.seq === persisted.seq);
    const known = knownIndex < 0 ? undefined : accepted[knownIndex];
    if (known === undefined || known.frame_hash !== persisted.frameHash) {
      return chainFail(
        'known-head-conflict',
        `frame at persisted seq ${persisted.seq} conflicts with the known head`,
        knownIndex < 0 ? null : knownIndex,
      );
    }
    persistedState = finalHead.seq === persisted.seq ? 'matched' : 'advanced';
  }

  const frames = Object.freeze([...accepted]);
  return {
    ok: true,
    frames,
    head: frames[frames.length - 1],
    trust: trustFor(
      profile as unknown as RappFrameProfile<JsonObject, string>,
      'trusted',
      persistedState,
    ),
  };
}

export function assertRappFrameChain<
  TPayload extends JsonObject,
  TKind extends string,
>(
  values: readonly unknown[],
  profile: RappFrameProfile<TPayload, TKind>,
  policy: RappChainTrustPolicy,
): readonly RappFrame<TPayload, TKind>[] {
  const result = verifyRappFrameChain(values, profile, policy);
  if (!result.ok) throw result.error;
  return result.frames;
}
