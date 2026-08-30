import {
  RAPP_PARTICLE_DOMAIN,
  RAPP_WAVE_DOMAIN,
  parseRappJson,
  rappCanonicalJson,
  rappH,
} from '../rappids/canonical.js';
import type { JsonObject, JsonValue } from '../rappids/types.js';

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

export const RAPP_REV14_AUTHORITY = Object.freeze({
  revision: 'rev-14',
  frame_hash: 'aa9af1c34eefab67d08c6fe814206d635d6a20f48a3ebbe30d0724b218d0afd9',
  payload_hash: 'b4f960786ad7867f60949eafd18293a636ea9f68d3d184c987d6cba00787b11c',
} as const);

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

export interface RappBodyFrameProfile<
  TPayload extends JsonObject,
  TKind extends string,
> {
  name: string;
  kinds: readonly TKind[];
  signature: 'unsigned-local';
  validatePayload?: (payload: JsonObject) =>
    | { ok: true; payload: TPayload }
    | { ok: false; error: string };
  /** Evidence streams may forbid replaying the same particle as a new event. */
  uniquePayloads?: boolean;
}

export const RAPP_REV14_BODY_PULSE_PROFILE:
Readonly<RappBodyFrameProfile<JsonObject, 'body.pulse'>> = Object.freeze({
  name: 'rapp-rev-14-body-pulse',
  kinds: Object.freeze(['body.pulse'] as const),
  signature: 'unsigned-local',
  uniquePayloads: true,
});

export type RappFrameVerificationStep = '1' | '1a' | '2' | '3' | '4' | '5' | '6';

export type RappFrameErrorCode =
  | 'key-set'
  | 'spec'
  | 'kind'
  | 'unregistered-kind'
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
  | 'seq-continuity'
  | 'prev-continuity'
  | 'time-regression'
  | 'prev-wave'
  | 'signature-profile'
  | 'empty-chain'
  | 'duplicate-seq'
  | 'duplicate-frame-hash'
  | 'duplicate-payload-hash'
  | 'fork';

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
  | { ok: true; frame: TFrame }
  | { ok: false; error: RappFrameError };

export type RappFrameChainVerification<TFrame extends RappFrame = RappFrame> =
  | { ok: true; frames: readonly TFrame[]; head: TFrame }
  | { ok: false; error: RappFrameError };

export interface VerifyRappFrameOptions {
  head: RappFrameHead | null;
  streamIdOfRecord?: string;
}

export interface BuildRappFrameInput<TPayload extends JsonObject, TKind extends string> {
  kind: TKind;
  streamId: string;
  utc: string;
  payload: TPayload;
  head: RappFrameHead | null;
}

const HEX64 = /^[0-9a-f]{64}$/;
const LCLABEL = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FRAME_KEY_SET = [...RAPP_FRAME_KEYS].sort().join('\0');
const RAPPID =
  /^rappid:@([a-z0-9]+(?:-[a-z0-9]+)*)\/([a-z0-9]+(?:-[a-z0-9]+)*):([0-9a-f]{64})$/;

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
  return freezeRappValue(
    parseRappJson(rappCanonicalJson(value)) as TValue,
  );
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

export function isRappBodyStream(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = RAPPID.exec(value);
  return match !== null && match[1].length <= 39 && match[2].length <= 100;
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
  const days = [
    31,
    leap ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  return day >= 1 && day <= days[month - 1];
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
  profile: RappBodyFrameProfile<TPayload, TKind>,
  payload: JsonObject,
): string | null {
  const result = profile.validatePayload?.(payload);
  return result === undefined || result.ok ? null : result.error;
}

export function verifyRappFrame<
  TPayload extends JsonObject,
  TKind extends string,
>(
  value: unknown,
  profile: RappBodyFrameProfile<TPayload, TKind>,
  options: VerifyRappFrameOptions,
): RappFrameVerification<RappFrame<TPayload, TKind>> {
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
  if (!profile.kinds.includes(value.kind as TKind)) {
    return fail(
      'unregistered-kind',
      '1',
      `kind ${value.kind} is not registered by profile ${profile.name}`,
    );
  }
  if (!isRappBodyStream(value.stream_id)) {
    return fail('stream-id', '1', 'stream_id is not a body-stream RAPPID');
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

  if (
    options.streamIdOfRecord !== undefined
    && value.stream_id !== options.streamIdOfRecord
  ) {
    return fail('stream-binding', '1a', 'stream_id does not match the stream of record');
  }
  if (options.head !== null && options.head.stream_id !== value.stream_id) {
    return fail('stream-binding', '1a', 'predecessor belongs to a different stream');
  }

  if (value.payload_hash !== rappH(RAPP_PARTICLE_DOMAIN, value.payload as JsonObject)) {
    return fail('payload-hash', '2', 'payload_hash does not cover the payload');
  }

  const frame = value as unknown as RappFrame<TPayload, TKind>;
  if (value.frame_hash !== rappFrameDigest(frame)) {
    return fail('frame-hash', '3', 'frame_hash does not cover the wave preimage');
  }

  if (options.head === null) {
    if (value.seq !== 0 || value.prev !== null) {
      return fail('genesis', '4', 'genesis must be seq 0 with prev null');
    }
  } else {
    if (value.seq !== options.head.seq + 1) {
      return fail('seq-continuity', '4', 'seq does not continue the predecessor');
    }
    if (value.prev !== options.head.payload_hash) {
      return fail('prev-continuity', '4', 'prev does not link the predecessor payload_hash');
    }
    if (value.utc < options.head.utc) {
      return fail('time-regression', '4', 'utc is earlier than the predecessor');
    }
  }

  if (value.prev_wave !== null) {
    return fail('prev-wave', '5', 'prev_wave must be null on a body stream');
  }

  if (profile.signature === 'unsigned-local' && value.sig !== null) {
    return fail(
      'signature-profile',
      '6',
      'sig must be null under the unsigned local body-stream profile',
    );
  }

  return {
    ok: true,
    frame: immutableRappValue(
      rappFrameToJson(frame),
    ) as unknown as RappFrame<TPayload, TKind>,
  };
}

export function assertRappFrame<
  TPayload extends JsonObject,
  TKind extends string,
>(
  value: unknown,
  profile: RappBodyFrameProfile<TPayload, TKind>,
  options: VerifyRappFrameOptions,
): RappFrame<TPayload, TKind> {
  const result = verifyRappFrame(value, profile, options);
  if (!result.ok) throw result.error;
  return result.frame;
}

/**
 * Verify wire/storage JSON without allowing JSON.parse to erase duplicate
 * members or unsafe number tokens before the frame verifier sees them.
 */
export function verifyRappFrameJson<
  TPayload extends JsonObject,
  TKind extends string,
>(
  source: string,
  profile: RappBodyFrameProfile<TPayload, TKind>,
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
  profile: RappBodyFrameProfile<TPayload, TKind>,
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
  profile: RappBodyFrameProfile<TPayload, TKind>,
): RappFrame<TPayload, TKind> {
  if (input.head !== null && input.head.seq >= RAPP_UINT53_MAX) {
    throw new RappFrameError(
      'seq-continuity',
      '4',
      'cannot append beyond the uint53 sequence ceiling; re-genesis is required',
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
    prev_wave: null,
    sig: null,
  };
  const frame = { ...draft, frame_hash: rappFrameDigest(draft) };
  return assertRappFrame(frame, profile, {
    head: input.head,
    streamIdOfRecord: input.streamId,
  });
}

/**
 * Hash an already-positioned body frame.
 *
 * This preserves the established body.dimension builder, whose callers pass
 * seq/prev explicitly and verify continuity at the append door.
 */
export function hashRappBodyFrame<
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
  profile: RappBodyFrameProfile<TPayload, TKind>,
  streamIdOfRecord?: string,
): RappFrameChainVerification<RappFrame<TPayload, TKind>> {
  if (values.length === 0) {
    return chainFail('empty-chain', 'RAPP/1 frame chain is empty', null, null);
  }
  const first = values[0];
  const streamId = streamIdOfRecord
    ?? (isRecord(first) && typeof first.stream_id === 'string' ? first.stream_id : '');
  const frames: RappFrame<TPayload, TKind>[] = [];
  const sequence = new Map<number, { index: number; prev: unknown; frameHash: unknown }>();
  const frameHashes = new Map<string, number>();
  const payloadHashes = new Map<string, number>();
  const children = new Map<string, number>();
  let head: RappFrame<TPayload, TKind> | null = null;

  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (isRecord(value) && typeof value.seq === 'number') {
      const existing = sequence.get(value.seq);
      if (existing !== undefined) {
        const isFork = (
          existing.prev === value.prev
          && existing.frameHash !== value.frame_hash
        );
        return chainFail(
          isFork ? 'fork' : 'duplicate-seq',
          isFork
            ? `fork at seq ${value.seq}: two frames claim the same predecessor`
            : `duplicate seq ${value.seq}`,
          index,
        );
      }
      sequence.set(value.seq, {
        index,
        prev: value.prev,
        frameHash: value.frame_hash,
      });
    }
    if (isRecord(value) && typeof value.frame_hash === 'string') {
      const existing = frameHashes.get(value.frame_hash);
      if (existing !== undefined) {
        return chainFail(
          'duplicate-frame-hash',
          `duplicate frame_hash at indexes ${existing} and ${index}`,
          index,
        );
      }
      frameHashes.set(value.frame_hash, index);
    }
    if (
      profile.uniquePayloads
      && isRecord(value)
      && typeof value.payload_hash === 'string'
    ) {
      const existing = payloadHashes.get(value.payload_hash);
      if (existing !== undefined) {
        return chainFail(
          'duplicate-payload-hash',
          `duplicate payload_hash at indexes ${existing} and ${index}`,
          index,
        );
      }
      payloadHashes.set(value.payload_hash, index);
    }
    if (isRecord(value) && typeof value.prev === 'string') {
      const existing = children.get(value.prev);
      if (existing !== undefined) {
        return chainFail(
          'fork',
          `payload ${value.prev} has children at indexes ${existing} and ${index}`,
          index,
        );
      }
      children.set(value.prev, index);
    }

    const result: RappFrameVerification<RappFrame<TPayload, TKind>> =
      verifyRappFrame(value, profile, {
      head,
      streamIdOfRecord: streamId,
    });
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
    frames.push(result.frame);
    head = result.frame;
  }

  const accepted = Object.freeze([...frames]);
  return { ok: true, frames: accepted, head: accepted[accepted.length - 1] };
}

export function assertRappFrameChain<
  TPayload extends JsonObject,
  TKind extends string,
>(
  values: readonly unknown[],
  profile: RappBodyFrameProfile<TPayload, TKind>,
  streamIdOfRecord?: string,
): readonly RappFrame<TPayload, TKind>[] {
  const result = verifyRappFrameChain(values, profile, streamIdOfRecord);
  if (!result.ok) throw result.error;
  return result.frames;
}
