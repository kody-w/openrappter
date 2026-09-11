import type { JsonObject } from '../rappids/types.js';
import type { RappFrame } from './frame.js';
import type { RappStreamFamily } from './authority.js';

export const RAPP_FRAME_SPEC = 'rapp/1' as const;
export const RAPP_FRAME_KEYS = [
  'spec', 'kind', 'stream_id', 'seq', 'utc', 'payload',
  'payload_hash', 'frame_hash', 'prev', 'prev_wave', 'sig',
] as const;
export const RAPP_UINT53_MAX = 2 ** 53 - 1;
export const RAPP_FRAME_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const LCLABEL = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const RAPPID = /^rappid:@([a-z0-9]+(?:-[a-z0-9]+)*)\/([a-z0-9]+(?:-[a-z0-9]+)*):([0-9a-f]{64})$/;
const MEMORY_STREAM = /^(rappid:@[a-z0-9]+(?:-[a-z0-9]+)*\/[a-z0-9]+(?:-[a-z0-9]+)*:[0-9a-f]{64}):([a-z0-9]+(?:-[a-z0-9]+)*)$/;
const SWARM_STREAM = /^net:([a-z0-9]+(?:-[a-z0-9]+)*)$/;

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
  return labels.length === 2 && labels.every((label) => label.length <= 64 && LCLABEL.test(label));
}

export function isRappFrameUtc(value: unknown): value is string {
  if (typeof value !== 'string' || !RAPP_FRAME_TIME_PATTERN.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const hour = Number(value.slice(11, 13));
  const minute = Number(value.slice(14, 16));
  const second = Number(value.slice(17, 19));
  if (year < 1 || month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day >= 1 && day <= days[month - 1];
}

export function rappFrameToJson(frame: RappFrame): JsonObject {
  return {
    spec: frame.spec, kind: frame.kind, stream_id: frame.stream_id, seq: frame.seq,
    utc: frame.utc, payload: frame.payload, payload_hash: frame.payload_hash,
    frame_hash: frame.frame_hash, prev: frame.prev, prev_wave: frame.prev_wave, sig: frame.sig,
  };
}

/** The existing nine-key RAPP wave preimage excludes frame_hash and sig. */
export function rappFrameWavePreimage(frame: RappFrame): JsonObject {
  const value = rappFrameToJson(frame);
  delete value.frame_hash;
  delete value.sig;
  return value;
}
