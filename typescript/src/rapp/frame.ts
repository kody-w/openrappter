import {
  RAPP_PARTICLE_DOMAIN,
  RAPP_WAVE_DOMAIN,
  parseRappJson,
  rappCanonicalJson,
  rappH,
  rappHashCanonical,
  snapshotRappJsonValue,
} from '../rappids/canonical.js';
import type { JsonObject, JsonValue } from '../rappids/types.js';
import {
  ACCEPTED_RAPP_PROTOCOL_AUTHORITY,
  isSelectedProtocolAuthority,
  protocolAuthorityFamilyForKind,
  protocolAuthorityIdentity,
  type ProtocolAuthority,
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
const PROFILE_OPTION_KEYS = new Set([
  'name',
  'kind',
  'authority',
  'signature',
  'validatePayload',
  'uniquePayloads',
]);
const LEGACY_PROFILE_OPTION_KEYS = new Set([
  'name',
  'kind',
  'family',
  'validatePayload',
  'uniquePayloads',
]);
interface RappFrameProfileRecord<
  TPayload extends JsonObject = JsonObject,
  TKind extends string = string,
> {
  name: string;
  kind: TKind;
  family: RappStreamFamily;
  authority: ProtocolAuthority | null;
  mode: 'authority' | 'legacy-integrity';
  signature: 'unsigned-local';
  validatePayload?: RappFrameProfile<TPayload, TKind>['validatePayload'];
  uniquePayloads: boolean;
}
const PROFILE_RECORDS =
  new WeakMap<object, RappFrameProfileRecord<JsonObject, string>>();

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
  assertOptionMap(input, PROFILE_OPTION_KEYS, ['name', 'kind'], 'frame profile options');
  const name = ownOption(input, 'name');
  const kind = ownOption(input, 'kind');
  const rawAuthority = ownOption(input, 'authority');
  const signature = ownOption(input, 'signature');
  const validatePayload = ownOption(input, 'validatePayload');
  const uniquePayloads = ownOption(input, 'uniquePayloads');
  if (typeof name !== 'string' || typeof kind !== 'string') {
    throw new TypeError('frame profile name and kind must be own string properties');
  }
  if (signature !== undefined && signature !== 'unsigned-local') {
    throw new TypeError('frame profile signature is invalid');
  }
  if (validatePayload !== undefined && typeof validatePayload !== 'function') {
    throw new TypeError('frame profile validatePayload must be a function');
  }
  if (uniquePayloads !== undefined && typeof uniquePayloads !== 'boolean') {
    throw new TypeError('frame profile uniquePayloads must be boolean');
  }
  const authority =
    rawAuthority === undefined
      ? ACCEPTED_RAPP_PROTOCOL_AUTHORITY
      : rawAuthority as ProtocolAuthority;
  if (!isSelectedProtocolAuthority(authority)) {
    throw new TypeError('frame profiles require an immutable selected ProtocolAuthority');
  }
  const family = protocolAuthorityFamilyForKind(authority, kind);
  if (family === null) {
    const identity = protocolAuthorityIdentity(authority);
    throw new TypeError(
      `kind ${kind} is not registered by accepted authority ${identity.revision}`,
    );
  }
  const profile = Object.freeze({
    [PROFILE_BRAND]: true as const,
    name,
    kind: kind as TKind,
    family,
    authority,
    mode: 'authority' as const,
    signature: signature ?? 'unsigned-local',
    validatePayload: validatePayload as RappFrameProfile<TPayload, TKind>['validatePayload'],
    uniquePayloads: uniquePayloads ?? false,
  });
  PROFILE_RECORDS.set(
    profile,
    frozenNullRecord({
      name,
      kind,
      family,
      authority,
      mode: 'authority',
      signature: (signature ?? 'unsigned-local') as 'unsigned-local',
      validatePayload: validatePayload as RappFrameProfile<JsonObject, string>['validatePayload'],
      uniquePayloads: uniquePayloads ?? false,
    }) as RappFrameProfileRecord<JsonObject, string>,
  );
  return profile;
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
  assertOptionMap(
    input,
    LEGACY_PROFILE_OPTION_KEYS,
    ['name', 'kind', 'family'],
    'legacy frame profile options',
  );
  const name = ownOption(input, 'name');
  const kind = ownOption(input, 'kind');
  const family = ownOption(input, 'family');
  const validatePayload = ownOption(input, 'validatePayload');
  const uniquePayloads = ownOption(input, 'uniquePayloads');
  if (
    typeof name !== 'string'
    || typeof kind !== 'string'
    || !['body', 'memory', 'swarm'].includes(String(family))
  ) {
    throw new TypeError('legacy frame profile requires own name, kind, and family');
  }
  if (validatePayload !== undefined && typeof validatePayload !== 'function') {
    throw new TypeError('legacy frame profile validatePayload must be a function');
  }
  if (uniquePayloads !== undefined && typeof uniquePayloads !== 'boolean') {
    throw new TypeError('legacy frame profile uniquePayloads must be boolean');
  }
  const profile = Object.freeze({
    [PROFILE_BRAND]: true as const,
    name,
    kind: kind as TKind,
    family: family as RappStreamFamily,
    authority: null,
    mode: 'legacy-integrity' as const,
    signature: 'unsigned-local' as const,
    validatePayload: validatePayload as RappFrameProfile<TPayload, TKind>['validatePayload'],
    uniquePayloads: uniquePayloads ?? false,
  });
  PROFILE_RECORDS.set(
    profile,
    frozenNullRecord({
      name,
      kind,
      family: family as RappStreamFamily,
      authority: null,
      mode: 'legacy-integrity',
      signature: 'unsigned-local',
      validatePayload: validatePayload as RappFrameProfile<JsonObject, string>['validatePayload'],
      uniquePayloads: uniquePayloads ?? false,
    }) as RappFrameProfileRecord<JsonObject, string>,
  );
  return profile;
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

const VERIFY_FRAME_OPTION_KEYS = new Set(['head', 'streamIdOfRecord']);
const BUILD_FRAME_INPUT_KEYS = new Set([
  'kind',
  'streamId',
  'utc',
  'payload',
  'head',
]);
const LEGACY_HASH_INPUT_KEYS = new Set([
  'kind',
  'streamId',
  'seq',
  'utc',
  'payload',
  'prev',
]);
const FRAME_HEAD_REQUIRED_KEYS = [
  'stream_id',
  'seq',
  'utc',
  'payload_hash',
  'frame_hash',
] as const;

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
const TRUST_POLICY_OPTION_KEYS = new Set([
  'authority',
  'trustedGenesis',
  'persistedHead',
]);
const TRUSTED_GENESIS_KEYS = new Set([
  'streamId',
  'frameHash',
  'payloadHash',
]);
const PERSISTED_HEAD_KEYS = new Set([
  'streamId',
  'seq',
  'frameHash',
]);
interface RappChainTrustPolicyRecord {
  authority: ProtocolAuthority;
  trustedGenesis: Readonly<TrustedRappGenesis>;
  persistedHead: Readonly<PersistedRappHead> | null;
}
const TRUST_POLICY_RECORDS = new WeakMap<object, RappChainTrustPolicyRecord>();

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

function frozenNullRecord<TValue extends object>(value: TValue): TValue {
  return Object.freeze(
    Object.assign(Object.create(null), value),
  ) as TValue;
}

function ownOption(
  value: Record<string, unknown>,
  key: string,
): unknown {
  return Object.hasOwn(value, key) ? value[key] : undefined;
}

function assertOptionMap(
  value: unknown,
  allowed: ReadonlySet<string>,
  required: readonly string[],
  label: string,
): asserts value is Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError(`${label} must be a plain object`);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.has(key)) {
      throw new TypeError(`${label} contains unsupported own key ${String(key)}`);
    }
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) {
      throw new TypeError(`${label} is missing own key ${key}`);
    }
  }
}

function assertOwnProperties(
  value: unknown,
  required: readonly string[],
  label: string,
): asserts value is Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError(`${label} must be a plain object`);
  for (const key of required) {
    if (!Object.hasOwn(value, key)) {
      throw new TypeError(`${label} is missing own key ${key}`);
    }
  }
}

function readFrameHead(value: unknown, label: string): RappFrameHead {
  assertOwnProperties(value, FRAME_HEAD_REQUIRED_KEYS, label);
  const streamId = ownOption(value, 'stream_id');
  const seq = ownOption(value, 'seq');
  const utc = ownOption(value, 'utc');
  const payloadHash = ownOption(value, 'payload_hash');
  const frameHash = ownOption(value, 'frame_hash');
  if (
    typeof streamId !== 'string'
    || typeof seq !== 'number'
    || !Number.isSafeInteger(seq)
    || seq < 0
    || seq > RAPP_UINT53_MAX
    || typeof utc !== 'string'
    || !isRappFrameUtc(utc)
    || typeof payloadHash !== 'string'
    || !HEX64.test(payloadHash)
    || typeof frameHash !== 'string'
    || !HEX64.test(frameHash)
  ) {
    throw new TypeError(`${label} has invalid own fields`);
  }
  return frozenNullRecord({
    stream_id: streamId,
    seq,
    utc,
    payload_hash: payloadHash,
    frame_hash: frameHash,
  });
}

function trustFor(
  profile: RappFrameProfile<JsonObject, string>,
  genesis: RappTrustAssessment['genesis'],
  persistedHead: RappTrustAssessment['persistedHead'],
): Readonly<RappTrustAssessment> {
  const selected = profileRecord(profile);
  return Object.freeze({
    classification:
      selected.mode === 'authority' ? 'integrity-only' : 'legacy-integrity-only',
    promotionGrade: false,
    authority:
      selected.authority === null
        ? null
        : protocolAuthorityIdentity(selected.authority),
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
  return PROFILE_RECORDS.has(profile);
}

function policyIsValid(policy: RappChainTrustPolicy): boolean {
  return TRUST_POLICY_RECORDS.has(policy);
}

function profileRecord(
  profile: RappFrameProfile<JsonObject, string>,
): RappFrameProfileRecord<JsonObject, string> {
  const record = PROFILE_RECORDS.get(profile);
  if (record === undefined) {
    throw new TypeError('frame profile is not an exact module-owned profile');
  }
  return record;
}

function policyRecord(policy: RappChainTrustPolicy): RappChainTrustPolicyRecord {
  const record = TRUST_POLICY_RECORDS.get(policy);
  if (record === undefined) {
    throw new TypeError('chain trust policy is not an exact module-owned policy');
  }
  return record;
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
  assertOptionMap(
    input,
    TRUST_POLICY_OPTION_KEYS,
    ['trustedGenesis'],
    'chain trust policy options',
  );
  const rawAuthority = ownOption(input, 'authority');
  const rawGenesis = ownOption(input, 'trustedGenesis');
  const rawPersisted = ownOption(input, 'persistedHead');
  const authority =
    rawAuthority === undefined
      ? ACCEPTED_RAPP_PROTOCOL_AUTHORITY
      : rawAuthority as ProtocolAuthority;
  if (!isSelectedProtocolAuthority(authority)) {
    throw new TypeError('chain trust policy requires an immutable selected ProtocolAuthority');
  }
  assertOptionMap(
    rawGenesis,
    TRUSTED_GENESIS_KEYS,
    ['streamId', 'frameHash', 'payloadHash'],
    'trusted genesis',
  );
  const genesis = frozenNullRecord({
    streamId: ownOption(rawGenesis, 'streamId'),
    frameHash: ownOption(rawGenesis, 'frameHash'),
    payloadHash: ownOption(rawGenesis, 'payloadHash'),
  }) as unknown as Readonly<TrustedRappGenesis>;
  if (
    typeof genesis.streamId !== 'string'
    || typeof genesis.frameHash !== 'string'
    || typeof genesis.payloadHash !== 'string'
    || rappStreamFamily(genesis.streamId) === null
    || !HEX64.test(genesis.frameHash)
    || !HEX64.test(genesis.payloadHash)
  ) {
    throw new TypeError('trusted genesis must name a valid stream and two 64hex addresses');
  }
  let persisted: Readonly<PersistedRappHead> | null = null;
  if (rawPersisted !== undefined && rawPersisted !== null) {
    assertOptionMap(
      rawPersisted,
      PERSISTED_HEAD_KEYS,
      ['streamId', 'seq', 'frameHash'],
      'persisted head',
    );
    persisted = frozenNullRecord({
      streamId: ownOption(rawPersisted, 'streamId'),
      seq: ownOption(rawPersisted, 'seq'),
      frameHash: ownOption(rawPersisted, 'frameHash'),
    }) as unknown as Readonly<PersistedRappHead>;
  }
  if (persisted !== null) {
    if (
      typeof persisted.streamId !== 'string'
      || typeof persisted.seq !== 'number'
      || typeof persisted.frameHash !== 'string'
      ||
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
  const trustedGenesis = genesis;
  const persistedHead = persisted;
  const policy = Object.freeze({
    [TRUST_POLICY_BRAND]: true as const,
    authority,
    trustedGenesis,
    persistedHead,
  });
  TRUST_POLICY_RECORDS.set(policy, frozenNullRecord({
    authority,
    trustedGenesis,
    persistedHead,
  }));
  return policy;
}

export function rappChainTrustAuthority(
  policy: RappChainTrustPolicy,
): ProtocolAuthority {
  return policyRecord(policy).authority;
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
  const selected = profileRecord(
    profile as unknown as RappFrameProfile<JsonObject, string>,
  );
  const result = selected.validatePayload?.(payload);
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
  const selectedProfile = profileRecord(
    profile as unknown as RappFrameProfile<JsonObject, string>,
  );
  let materialized: JsonValue;
  try {
    materialized = snapshotRappJsonValue(value);
  } catch (error) {
    return fail(
      'key-set',
      '1',
      error instanceof Error ? error.message : 'frame could not be snapshotted',
    );
  }
  if (!isRecord(materialized)) {
    return fail('key-set', '1', 'frame is not a JSON object');
  }
  const snapshot = materialized;
  if (Object.keys(snapshot).sort().join('\0') !== FRAME_KEY_SET) {
    return fail('key-set', '1', 'frame does not have the exact eleven-key RAPP/1 envelope');
  }
  if (snapshot.spec !== RAPP_FRAME_SPEC) {
    return fail('spec', '1', 'spec is not rapp/1');
  }
  if (!isRappFrameKind(snapshot.kind)) {
    return fail('kind', '1', 'kind does not match the RAPP/1 noun.verb grammar');
  }
  const streamFamily = rappStreamFamily(snapshot.stream_id);
  if (streamFamily === null) {
    return fail('stream-id', '1', 'stream_id does not match a registered RAPP stream form');
  }
  if (selectedProfile.mode === 'authority') {
    const registeredFamily = protocolAuthorityFamilyForKind(
      selectedProfile.authority!,
      snapshot.kind,
    );
    if (registeredFamily === null) {
      const identity = protocolAuthorityIdentity(selectedProfile.authority!);
      return fail(
        'unregistered-kind',
        '1',
        `kind ${snapshot.kind} is not registered by accepted authority ${identity.revision}`,
      );
    }
    if (registeredFamily !== streamFamily) {
      return fail(
        'kind-family',
        '1',
        `registered ${registeredFamily} kind ${snapshot.kind} cannot use a ${streamFamily} stream`,
      );
    }
  } else if (streamFamily !== selectedProfile.family) {
    return fail(
      'kind-family',
      '1',
      `legacy ${selectedProfile.family} kind ${snapshot.kind} cannot use a ${streamFamily} stream`,
    );
  }
  if (snapshot.kind !== selectedProfile.kind) {
    return fail(
      'profile-kind',
      '1',
      `profile ${selectedProfile.name} verifies ${selectedProfile.kind}, not ${snapshot.kind}`,
    );
  }
  if (
    typeof snapshot.seq !== 'number'
    || !Number.isSafeInteger(snapshot.seq)
    || snapshot.seq < 0
    || snapshot.seq > RAPP_UINT53_MAX
  ) {
    return fail('seq', '1', 'seq is not a uint53');
  }
  if (!isRappFrameUtc(snapshot.utc)) {
    return fail('utc', '1', 'utc is not a calendar-valid fixed-width RFC 3339 timestamp');
  }
  if (!isRecord(snapshot.payload)) {
    return fail('payload', '1', 'payload is not a JSON object');
  }
  if (typeof snapshot.payload_hash !== 'string' || !HEX64.test(snapshot.payload_hash)) {
    return fail('payload-hash-format', '1', 'payload_hash is not 64 lowercase hex');
  }
  if (typeof snapshot.frame_hash !== 'string' || !HEX64.test(snapshot.frame_hash)) {
    return fail('frame-hash-format', '1', 'frame_hash is not 64 lowercase hex');
  }
  if (
    snapshot.prev !== null
    && (typeof snapshot.prev !== 'string' || !HEX64.test(snapshot.prev))
  ) {
    return fail('prev-format', '1', 'prev is not null or 64 lowercase hex');
  }
  if (
    snapshot.prev_wave !== null
    && (typeof snapshot.prev_wave !== 'string' || !HEX64.test(snapshot.prev_wave))
  ) {
    return fail('prev-wave-format', '1', 'prev_wave is not null or 64 lowercase hex');
  }
  if (snapshot.sig !== null && typeof snapshot.sig !== 'string') {
    return fail('signature-format', '1', 'sig is not null or a JWS string');
  }
  try {
    rappCanonicalJson(snapshot);
  } catch (error) {
    return fail(
      'canonical',
      '1',
      error instanceof Error ? error.message : 'frame is outside the RAPP/1 canonical domain',
    );
  }
  const payload = snapshot.payload as JsonObject;
  const payloadProblem = profilePayloadProblem(profile, payload);
  if (payloadProblem !== null) {
    return fail('payload-profile', '1', payloadProblem);
  }
  if (snapshot.stream_id !== streamIdOfRecord) {
    return fail('stream-binding', '1a', 'stream_id does not match the stream of record');
  }
  if (
    predecessorStreamId !== undefined
    && snapshot.stream_id !== predecessorStreamId
  ) {
    return fail('stream-binding', '1a', 'predecessor belongs to a different stream');
  }
  const payloadCanonical = rappCanonicalJson(payload);
  if (
    snapshot.payload_hash
    !== rappHashCanonical(RAPP_PARTICLE_DOMAIN, payloadCanonical)
  ) {
    return fail('payload-hash', '2', 'payload_hash does not cover the payload');
  }
  const frame = snapshot as unknown as RappFrame<TPayload, TKind>;
  const waveCanonical = rappCanonicalJson(rappFrameWavePreimage(frame));
  if (
    snapshot.frame_hash
    !== rappHashCanonical(RAPP_WAVE_DOMAIN, waveCanonical)
  ) {
    return fail('frame-hash', '3', 'frame_hash does not cover the wave preimage');
  }
  return {
    ok: true,
    frame,
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
  const selectedProfile = profileRecord(profile);
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

  if (selectedProfile.family === 'swarm' && frame.seq > 0) {
    if (head === null || frame.prev_wave !== head.frame_hash) {
      return fail('prev-wave', '5', 'prev_wave does not link the predecessor frame_hash');
    }
  } else if (frame.prev_wave !== null) {
    return fail('prev-wave', '5', 'prev_wave must be null off a non-genesis swarm frame');
  }

  if (selectedProfile.family === 'swarm' && frame.sig === null) {
    return fail('signature-required', '6', 'swarm frames must be signed');
  }
  if (selectedProfile.signature === 'unsigned-local' && frame.sig !== null) {
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
  try {
    assertOptionMap(
      options,
      VERIFY_FRAME_OPTION_KEYS,
      ['head', 'streamIdOfRecord'],
      'frame verification options',
    );
  } catch (error) {
    return fail(
      'profile',
      '1',
      error instanceof Error ? error.message : 'frame verification options are invalid',
    );
  }
  const head = ownOption(options, 'head');
  const streamIdOfRecord = ownOption(options, 'streamIdOfRecord');
  if (typeof streamIdOfRecord !== 'string') {
    return fail('profile', '1', 'frame verification streamIdOfRecord must be an own string');
  }
  let selectedHead: RappFrameHead | null = null;
  if (head !== null) {
    try {
      selectedHead = readFrameHead(head, 'frame predecessor');
    } catch (error) {
      return fail(
        'profile',
        '1',
        error instanceof Error ? error.message : 'frame predecessor is invalid',
      );
    }
  }
  const intrinsic = verifyThroughWave(
    value,
    profile,
    streamIdOfRecord,
    selectedHead?.stream_id,
  );
  if (!intrinsic.ok) return intrinsic;
  return verifyContinuation(
    intrinsic.frame,
    profile as unknown as RappFrameProfile<JsonObject, string>,
    selectedHead,
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
  assertOptionMap(
    input,
    BUILD_FRAME_INPUT_KEYS,
    ['kind', 'streamId', 'utc', 'payload', 'head'],
    'frame build input',
  );
  const kind = ownOption(input, 'kind');
  const streamId = ownOption(input, 'streamId');
  const utc = ownOption(input, 'utc');
  const payload = ownOption(input, 'payload');
  const head = ownOption(input, 'head');
  if (
    typeof kind !== 'string'
    || typeof streamId !== 'string'
    || typeof utc !== 'string'
    || !isRecord(payload)
  ) {
    throw new RappFrameError('profile', '1', 'frame build input has invalid own properties');
  }
  const selectedHead =
    head === null ? null : readFrameHead(head, 'frame build predecessor');
  if (!profileIsValid(profile as RappFrameProfile<JsonObject, string>)) {
    throw new RappFrameError(
      'profile',
      '1',
      'frame profile was not selected by a profile factory',
    );
  }
  const selectedProfile = profileRecord(
    profile as unknown as RappFrameProfile<JsonObject, string>,
  );
  if (selectedProfile.mode !== 'authority') {
    throw new RappFrameError(
      'unregistered-kind',
      '1',
      `legacy integrity profile ${selectedProfile.name} is read-only and cannot emit conforming frames`,
    );
  }
  if (kind !== selectedProfile.kind) {
    throw new RappFrameError(
      'profile-kind',
      '1',
      `profile ${selectedProfile.name} emits ${selectedProfile.kind}`,
    );
  }
  if (selectedHead !== null && selectedHead.seq >= RAPP_UINT53_MAX) {
    throw new RappFrameError(
      'seq-continuity',
      '4',
      'cannot append beyond the uint53 sequence ceiling; owner-authorized re-genesis is required',
    );
  }
  let payloadHash: string;
  try {
    payloadHash = rappH(RAPP_PARTICLE_DOMAIN, payload as JsonObject);
  } catch (error) {
    throw new RappFrameError(
      'canonical',
      '1',
      error instanceof Error ? error.message : 'payload is outside the RAPP/1 canonical domain',
    );
  }
  const draft: RappFrame<TPayload, TKind> = {
    spec: RAPP_FRAME_SPEC,
    kind: kind as TKind,
    stream_id: streamId,
    seq: selectedHead === null ? 0 : selectedHead.seq + 1,
    utc,
    payload: payload as TPayload,
    payload_hash: payloadHash,
    frame_hash: '0'.repeat(64),
    prev: selectedHead === null ? null : selectedHead.payload_hash,
    prev_wave:
      selectedProfile.family === 'swarm' && selectedHead !== null
        ? selectedHead.frame_hash
        : null,
    sig: null,
  };
  const frame = { ...draft, frame_hash: rappFrameDigest(draft) };
  return assertRappFrame(frame, profile, {
    head: selectedHead,
    streamIdOfRecord: streamId,
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
  assertOptionMap(
    input,
    LEGACY_HASH_INPUT_KEYS,
    ['kind', 'streamId', 'seq', 'utc', 'payload', 'prev'],
    'legacy frame hash input',
  );
  const kind = ownOption(input, 'kind');
  const streamId = ownOption(input, 'streamId');
  const seq = ownOption(input, 'seq');
  const utc = ownOption(input, 'utc');
  const payload = ownOption(input, 'payload');
  const prev = ownOption(input, 'prev');
  if (
    typeof kind !== 'string'
    || typeof streamId !== 'string'
    || typeof seq !== 'number'
    || typeof utc !== 'string'
    || !isRecord(payload)
    || (prev !== null && typeof prev !== 'string')
  ) {
    throw new TypeError('legacy frame hash input has invalid own properties');
  }
  const payloadHash = rappH(RAPP_PARTICLE_DOMAIN, payload as JsonObject);
  const draft: RappFrame<TPayload, TKind> = {
    spec: RAPP_FRAME_SPEC,
    kind: kind as TKind,
    stream_id: streamId,
    seq,
    utc,
    payload: payload as TPayload,
    payload_hash: payloadHash,
    frame_hash: '0'.repeat(64),
    prev,
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
  const selectedProfile = profileIsValid(
    profile as RappFrameProfile<JsonObject, string>,
  )
    ? profileRecord(profile as unknown as RappFrameProfile<JsonObject, string>)
    : null;
  const selectedPolicy = policyIsValid(policy) ? policyRecord(policy) : null;
  if (
    selectedPolicy === null
    || selectedProfile === null
    || selectedProfile.mode !== 'authority'
    || selectedProfile.authority !== selectedPolicy.authority
  ) {
    return chainFail(
      'authority-policy',
      'frame profile and trusted chain policy do not share one selected authority',
      null,
      '1',
    );
  }

  const streamId = selectedPolicy.trustedGenesis.streamId;
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

  const candidateFrames: RappFrame<TPayload, TKind>[] = [];
  for (let index = 0; index < intrinsicFrames.length; index += 1) {
    const frame = intrinsicFrames[index];
    let predecessor: RappFrame<TPayload, TKind> | null = null;
    if (frame.seq > 0) {
      predecessor =
        candidateFrames.find((candidate) =>
          candidate.payload_hash === frame.prev,
        ) ?? null;
      if (predecessor === null) {
        return chainFail(
          'prev-continuity',
          'prev does not identify an earlier fully valid predecessor',
          index,
        );
      }
    }
    const result: RappFrameVerification<RappFrame<TPayload, TKind>> =
      verifyContinuation(
        frame,
        profile as unknown as RappFrameProfile<JsonObject, string>,
        predecessor,
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
    candidateFrames.push(result.frame);
  }

  const genesis = candidateFrames[0];
  if (
    genesis.seq !== 0
    || genesis.prev !== null
    || genesis.frame_hash !== selectedPolicy.trustedGenesis.frameHash
    || genesis.payload_hash !== selectedPolicy.trustedGenesis.payloadHash
  ) {
    return chainFail(
      'untrusted-genesis',
      'presented genesis does not match the selected trusted genesis',
      0,
    );
  }
  for (let index = 1; index < candidateFrames.length; index += 1) {
    if (candidateFrames[index].seq === 0) {
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
  for (let index = 0; index < candidateFrames.length; index += 1) {
    const frame = candidateFrames[index];
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

    if (selectedProfile.uniquePayloads) {
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

  const accepted = candidateFrames;
  let persistedState: RappTrustAssessment['persistedHead'] = 'untracked';
  const persisted = selectedPolicy.persistedHead;
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
