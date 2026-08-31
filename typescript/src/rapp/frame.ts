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
import { types as utilTypes } from 'node:util';
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

// Post-import intrinsic poisoning is in scope; same-realm poisoning before
// this module initializes is unsupported because no JavaScript module can
// authenticate already-replaced language intrinsics without a separate realm.
const SAFE_OWN_KEYS = Reflect.ownKeys;
const SAFE_GET_OWN_PROPERTY_DESCRIPTOR = Object.getOwnPropertyDescriptor;
const SAFE_HAS_OWN = Object.hasOwn;

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
const PROFILE_OPTION_KEYS = [
  'name',
  'kind',
  'authority',
  'signature',
  'validatePayload',
  'uniquePayloads',
] as const;
const LEGACY_PROFILE_OPTION_KEYS = [
  'name',
  'kind',
  'family',
  'validatePayload',
  'uniquePayloads',
] as const;
interface RappFrameProfileRecord<
  TPayload extends JsonObject = JsonObject,
  TKind extends string = string,
> {
  name: string;
  kind: TKind | null;
  family: RappStreamFamily;
  authority: ProtocolAuthority | null;
  mode: 'authority' | 'legacy-integrity';
  signature: 'unsigned-local';
  validatePayload?: RappFrameProfile<TPayload, TKind>['validatePayload'];
  uniquePayloads: boolean;
}
const PROFILE_OBJECTS: object[] = [];
const PROFILE_RECORDS: RappFrameProfileRecord<JsonObject, string>[] = [];

export interface RappFrameProfile<
  TPayload extends JsonObject,
  TKind extends string,
> {
  readonly [PROFILE_BRAND]: true;
  readonly name: string;
  readonly kind: TKind | null;
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
  PROFILE_OBJECTS[PROFILE_OBJECTS.length] = profile;
  PROFILE_RECORDS[PROFILE_RECORDS.length] = frozenNullRecord({
      name,
      kind,
      family,
      authority,
      mode: 'authority',
      signature: (signature ?? 'unsigned-local') as 'unsigned-local',
      validatePayload: validatePayload as RappFrameProfile<JsonObject, string>['validatePayload'],
      uniquePayloads: uniquePayloads ?? false,
    }) as RappFrameProfileRecord<JsonObject, string>;
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
    || (
      family !== 'body'
      && family !== 'memory'
      && family !== 'swarm'
    )
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
  PROFILE_OBJECTS[PROFILE_OBJECTS.length] = profile;
  PROFILE_RECORDS[PROFILE_RECORDS.length] = frozenNullRecord({
      name,
      kind,
      family: family as RappStreamFamily,
      authority: null,
      mode: 'legacy-integrity',
      signature: 'unsigned-local',
      validatePayload: validatePayload as RappFrameProfile<JsonObject, string>['validatePayload'],
      uniquePayloads: uniquePayloads ?? false,
    }) as RappFrameProfileRecord<JsonObject, string>;
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

function createAuthorityStreamProfile(
  name: string,
  family: RappStreamFamily,
  authority: ProtocolAuthority,
): Readonly<RappFrameProfile<JsonObject, string>> {
  if (!isSelectedProtocolAuthority(authority)) {
    throw new TypeError('stream profiles require an immutable selected ProtocolAuthority');
  }
  const profile = Object.freeze({
    [PROFILE_BRAND]: true as const,
    name,
    kind: null,
    family,
    authority,
    mode: 'authority' as const,
    signature: 'unsigned-local' as const,
    uniquePayloads: true,
  });
  PROFILE_OBJECTS[PROFILE_OBJECTS.length] = profile;
  PROFILE_RECORDS[PROFILE_RECORDS.length] = frozenNullRecord({
    name,
    kind: null,
    family,
    authority,
    mode: 'authority',
    signature: 'unsigned-local',
    uniquePayloads: true,
  });
  return profile;
}

/** Generic accepted body-stream verification; kind policy resolves per frame. */
export const RAPP_ACCEPTED_BODY_STREAM_PROFILE = createAuthorityStreamProfile(
  'rapp-accepted-body-stream',
  'body',
  ACCEPTED_RAPP_PROTOCOL_AUTHORITY,
);

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
  | 're-genesis-profile'
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

const VERIFY_FRAME_OPTION_KEYS = ['head', 'streamIdOfRecord'] as const;
const BUILD_FRAME_INPUT_KEYS = [
  'kind',
  'streamId',
  'utc',
  'payload',
  'head',
] as const;
const LEGACY_HASH_INPUT_KEYS = [
  'kind',
  'streamId',
  'seq',
  'utc',
  'payload',
  'prev',
] as const;
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
const TRUST_POLICY_OPTION_KEYS = [
  'authority',
  'trustedGenesis',
  'persistedHead',
] as const;
const TRUSTED_GENESIS_KEYS = [
  'streamId',
  'frameHash',
  'payloadHash',
] as const;
const PERSISTED_HEAD_KEYS = [
  'streamId',
  'seq',
  'frameHash',
] as const;
interface RappChainTrustPolicyRecord {
  authority: ProtocolAuthority;
  trustedGenesis: Readonly<TrustedRappGenesis>;
  persistedHead: Readonly<PersistedRappHead> | null;
}
const TRUST_POLICY_OBJECTS: object[] = [];
const TRUST_POLICY_RECORDS: RappChainTrustPolicyRecord[] = [];

export interface RappChainTrustPolicy {
  readonly [TRUST_POLICY_BRAND]: true;
  readonly authority: ProtocolAuthority;
  readonly trustedGenesis: Readonly<TrustedRappGenesis>;
  readonly persistedHead: Readonly<PersistedRappHead> | null;
}

const HEX64 = /^[0-9a-f]{64}$/;
const LCLABEL = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
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
  const descriptor = SAFE_GET_OWN_PROPERTY_DESCRIPTOR(value, key);
  return descriptor !== undefined && SAFE_HAS_OWN(descriptor, 'value')
    ? descriptor.value
    : undefined;
}

function assertOptionMap(
  value: unknown,
  allowed: readonly string[],
  required: readonly string[],
  label: string,
): asserts value is Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError(`${label} must be a plain object`);
  const keys = SAFE_OWN_KEYS(value);
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    let supported = false;
    if (typeof key === 'string') {
      for (let allowedIndex = 0; allowedIndex < allowed.length; allowedIndex += 1) {
        if (allowed[allowedIndex] === key) {
          supported = true;
          break;
        }
      }
    }
    if (!supported) {
      throw new TypeError(`${label} contains unsupported own key ${String(key)}`);
    }
    const descriptor = SAFE_GET_OWN_PROPERTY_DESCRIPTOR(value, key);
    if (descriptor === undefined || !SAFE_HAS_OWN(descriptor, 'value')) {
      throw new TypeError(`${label}.${String(key)} must be an own data property`);
    }
  }
  for (let index = 0; index < required.length; index += 1) {
    const key = required[index];
    if (SAFE_GET_OWN_PROPERTY_DESCRIPTOR(value, key) === undefined) {
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
  for (let index = 0; index < required.length; index += 1) {
    const key = required[index];
    if (SAFE_GET_OWN_PROPERTY_DESCRIPTOR(value, key) === undefined) {
      throw new TypeError(`${label} is missing own key ${key}`);
    }
  }
}

function hasExactOwnKeys(
  value: object,
  expected: readonly string[],
): boolean {
  const keys = SAFE_OWN_KEYS(value);
  if (keys.length !== expected.length) return false;
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (typeof key !== 'string') return false;
    let found = false;
    for (let expectedIndex = 0; expectedIndex < expected.length; expectedIndex += 1) {
      if (expected[expectedIndex] === key) {
        found = true;
        break;
      }
    }
    if (!found) return false;
  }
  return true;
}

function snapshotChainContainer(value: unknown): readonly unknown[] {
  if (!Array.isArray(value) || utilTypes.isProxy(value)) {
    throw new TypeError('frame chain must be a stable ordinary array');
  }
  const keys = SAFE_OWN_KEYS(value);
  const descriptors = Object.create(null) as Record<string, PropertyDescriptor>;
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (typeof key !== 'string') {
      throw new TypeError('frame chain contains a symbol key');
    }
    const descriptor = SAFE_GET_OWN_PROPERTY_DESCRIPTOR(value, key);
    if (descriptor === undefined || !SAFE_HAS_OWN(descriptor, 'value')) {
      throw new TypeError(`frame chain ${key} is missing or an accessor`);
    }
    descriptors[key] = descriptor;
  }
  const lengthDescriptor = descriptors.length;
  if (
    lengthDescriptor === undefined
    || typeof lengthDescriptor.value !== 'number'
    || !Number.isSafeInteger(lengthDescriptor.value)
    || lengthDescriptor.value < 0
  ) {
    throw new TypeError('frame chain length is invalid');
  }
  const length = lengthDescriptor.value;
  if (keys.length !== length + 1) {
    throw new TypeError('frame chain contains holes or extra properties');
  }
  const snapshot: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (descriptor === undefined || descriptor.enumerable !== true) {
      throw new TypeError(`frame chain index ${index} is missing or non-enumerable`);
    }
    snapshot[index] = descriptor.value;
  }
  return Object.freeze(snapshot);
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
  for (let index = 0; index < PROFILE_OBJECTS.length; index += 1) {
    if (PROFILE_OBJECTS[index] === profile) return true;
  }
  return false;
}

function policyIsValid(policy: RappChainTrustPolicy): boolean {
  for (let index = 0; index < TRUST_POLICY_OBJECTS.length; index += 1) {
    if (TRUST_POLICY_OBJECTS[index] === policy) return true;
  }
  return false;
}

function profileRecord(
  profile: RappFrameProfile<JsonObject, string>,
): RappFrameProfileRecord<JsonObject, string> {
  for (let index = 0; index < PROFILE_OBJECTS.length; index += 1) {
    if (PROFILE_OBJECTS[index] === profile) return PROFILE_RECORDS[index];
  }
  throw new TypeError('frame profile is not an exact module-owned profile');
}

function policyRecord(policy: RappChainTrustPolicy): RappChainTrustPolicyRecord {
  for (let index = 0; index < TRUST_POLICY_OBJECTS.length; index += 1) {
    if (TRUST_POLICY_OBJECTS[index] === policy) return TRUST_POLICY_RECORDS[index];
  }
  throw new TypeError('chain trust policy is not an exact module-owned policy');
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

function isRappReGenesisKind(kind: string): boolean {
  const suffix = '.re-genesis';
  return kind.length > suffix.length
    && kind.slice(kind.length - suffix.length) === suffix;
}

interface RappKindPolicy {
  kind: string;
  family: RappStreamFamily;
  signature: 'unsigned-local' | 'signature-required' | 're-genesis-dedicated';
}

function authorityKindPolicy(
  authority: ProtocolAuthority,
  kind: string,
): Readonly<RappKindPolicy> | null {
  const family = protocolAuthorityFamilyForKind(authority, kind);
  if (family === null) return null;
  const signature: RappKindPolicy['signature'] =
    isRappReGenesisKind(kind)
      ? 're-genesis-dedicated'
      : family === 'swarm'
        ? 'signature-required'
        : 'unsigned-local';
  return frozenNullRecord<RappKindPolicy>({
    kind,
    family,
    signature,
  });
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
  TRUST_POLICY_OBJECTS[TRUST_POLICY_OBJECTS.length] = policy;
  TRUST_POLICY_RECORDS[TRUST_POLICY_RECORDS.length] = frozenNullRecord({
    authority,
    trustedGenesis,
    persistedHead,
  });
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
  if (!hasExactOwnKeys(snapshot, RAPP_FRAME_KEYS)) {
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
    const kindPolicy = authorityKindPolicy(
      selectedProfile.authority!,
      snapshot.kind,
    );
    if (kindPolicy === null) {
      const identity = protocolAuthorityIdentity(selectedProfile.authority!);
      return fail(
        'unregistered-kind',
        '1',
        `kind ${snapshot.kind} is not registered by accepted authority ${identity.revision}`,
      );
    }
    if (kindPolicy.family !== streamFamily) {
      return fail(
        'kind-family',
        '1',
        `registered ${kindPolicy.family} kind ${snapshot.kind} cannot use a ${streamFamily} stream`,
      );
    }
    if (kindPolicy.family !== selectedProfile.family) {
      return fail(
        'profile-kind',
        '1',
        `profile ${selectedProfile.name} is for ${selectedProfile.family} streams, not ${kindPolicy.family}`,
      );
    }
  } else if (streamFamily !== selectedProfile.family) {
    return fail(
      'kind-family',
      '1',
      `legacy ${selectedProfile.family} kind ${snapshot.kind} cannot use a ${streamFamily} stream`,
    );
  }
  if (
    selectedProfile.kind !== null
    && snapshot.kind !== selectedProfile.kind
  ) {
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
  let kindPolicy: Readonly<RappKindPolicy>;
  if (selectedProfile.authority === null) {
    kindPolicy = frozenNullRecord({
      kind: frame.kind,
      family: selectedProfile.family,
      signature: 'unsigned-local' as const,
    });
  } else {
    const resolved = authorityKindPolicy(selectedProfile.authority, frame.kind);
    if (resolved === null) {
      return fail('unregistered-kind', '1', `kind ${frame.kind} is not registered`);
    }
    kindPolicy = resolved;
  }
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

  if (kindPolicy.family === 'swarm' && frame.seq > 0) {
    if (head === null || frame.prev_wave !== head.frame_hash) {
      return fail('prev-wave', '5', 'prev_wave does not link the predecessor frame_hash');
    }
  } else if (frame.prev_wave !== null) {
    return fail('prev-wave', '5', 'prev_wave must be null off a non-genesis swarm frame');
  }

  if (kindPolicy.signature === 're-genesis-dedicated') {
    return fail(
      're-genesis-profile',
      '6',
      're-genesis requires a dedicated owner-signed, registry-authorized profile',
    );
  }
  if (kindPolicy.signature === 'signature-required' && frame.sig === null) {
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
  if (selectedProfile.kind === null) {
    throw new RappFrameError(
      'profile-kind',
      '1',
      'generic stream profiles cannot emit; select an exact registered kind profile',
    );
  }
  if (kind !== selectedProfile.kind) {
    throw new RappFrameError(
      'profile-kind',
      '1',
      `profile ${selectedProfile.name} emits ${selectedProfile.kind}`,
    );
  }
  const kindPolicy = authorityKindPolicy(selectedProfile.authority!, kind);
  if (kindPolicy === null) {
    throw new RappFrameError(
      'unregistered-kind',
      '1',
      `kind ${kind} is not registered by the selected authority`,
    );
  }
  if (kindPolicy.signature === 're-genesis-dedicated') {
    throw new RappFrameError(
      're-genesis-profile',
      '6',
      'generic unsigned builders cannot emit owner-authorized re-genesis',
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
      kindPolicy.family === 'swarm' && selectedHead !== null
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
  let chainValues: readonly unknown[];
  try {
    chainValues = snapshotChainContainer(values);
  } catch (error) {
    return chainFail(
      'key-set',
      error instanceof Error ? error.message : 'frame chain container is invalid',
      null,
      '1',
    );
  }
  if (chainValues.length === 0) {
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
  for (let index = 0; index < chainValues.length; index += 1) {
    const result = verifyThroughWave(chainValues[index], profile, streamId);
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
    intrinsicFrames[intrinsicFrames.length] = result.frame;
  }

  const candidateFrames: RappFrame<TPayload, TKind>[] = [];
  for (let index = 0; index < intrinsicFrames.length; index += 1) {
    const frame = intrinsicFrames[index];
    let predecessor: RappFrame<TPayload, TKind> | null = null;
    if (frame.seq > 0) {
      for (
        let candidateIndex = 0;
        candidateIndex < candidateFrames.length;
        candidateIndex += 1
      ) {
        if (candidateFrames[candidateIndex].payload_hash === frame.prev) {
          predecessor = candidateFrames[candidateIndex];
          break;
        }
      }
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
    candidateFrames[candidateFrames.length] = result.frame;
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

  const sequence = Object.create(null) as Record<
    string,
    { index: number; prev: string | null; frameHash: string }
  >;
  const frameHashes = Object.create(null) as Record<string, number>;
  const payloadHashes = Object.create(null) as Record<string, number>;
  for (let index = 0; index < candidateFrames.length; index += 1) {
    const frame = candidateFrames[index];
    const sequenceKey = String(frame.seq);
    const existingSeqDescriptor =
      SAFE_GET_OWN_PROPERTY_DESCRIPTOR(sequence, sequenceKey);
    if (existingSeqDescriptor !== undefined) {
      const existingSeq = existingSeqDescriptor.value as {
        index: number;
        prev: string | null;
        frameHash: string;
      };
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
    sequence[sequenceKey] = {
      index,
      prev: frame.prev,
      frameHash: frame.frame_hash,
    };

    const existingFrameDescriptor =
      SAFE_GET_OWN_PROPERTY_DESCRIPTOR(frameHashes, frame.frame_hash);
    if (existingFrameDescriptor !== undefined) {
      const existingFrame = existingFrameDescriptor.value as number;
      return chainFail(
        'duplicate-frame-hash',
        `duplicate frame_hash at indexes ${existingFrame} and ${index}`,
        index,
      );
    }
    frameHashes[frame.frame_hash] = index;

    if (selectedProfile.uniquePayloads) {
      const existingPayloadDescriptor =
        SAFE_GET_OWN_PROPERTY_DESCRIPTOR(payloadHashes, frame.payload_hash);
      if (existingPayloadDescriptor !== undefined) {
        const existingPayload = existingPayloadDescriptor.value as number;
        return chainFail(
          'duplicate-payload-hash',
          `duplicate payload_hash at indexes ${existingPayload} and ${index}`,
          index,
        );
      }
      payloadHashes[frame.payload_hash] = index;
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
    let knownIndex = -1;
    for (let index = 0; index < accepted.length; index += 1) {
      if (accepted[index].seq === persisted.seq) {
        knownIndex = index;
        break;
      }
    }
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

  const frameCopy: RappFrame<TPayload, TKind>[] = [];
  for (let index = 0; index < accepted.length; index += 1) {
    frameCopy[index] = accepted[index];
  }
  const frames = Object.freeze(frameCopy);
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
