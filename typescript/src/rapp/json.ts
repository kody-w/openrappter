import type { JsonValue } from '../rappids/types.js';

export const RAPP_PARTICLE_DOMAIN = 'rapp/1:particle';
export const RAPP_WAVE_DOMAIN = 'rapp/1:wave';
export const RAPP_EGG_DOMAIN = 'rapp/1:egg';
export const RAPP_MAX_CANONICAL_BYTES = 1024 * 1024;
export const RAPP_MAX_CANONICAL_DEPTH = 64;

const SAFE_OBJECT_KEYS = Object.keys;
const SAFE_REFLECT_APPLY = Reflect.apply;
const SAFE_DEFINE_PROPERTY = Object.defineProperty;
const SAFE_ARRAY_SORT = Array.prototype.sort;
const SAFE_ARRAY_JOIN = Array.prototype.join;
const UTF8_ENCODE = TextEncoder.prototype.encode.bind(new TextEncoder());

function safeArraySet(values: string[], index: number, value: string): void {
  SAFE_DEFINE_PROPERTY(values, String(index), {
    value, configurable: true, enumerable: true, writable: true,
  });
}

export function validateRappString(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const following = value.charCodeAt(index + 1);
      if (!Number.isInteger(following) || following < 0xdc00 || following > 0xdfff) {
        throw new TypeError('RAPP/1 string contains an unpaired surrogate');
      }
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new TypeError('RAPP/1 string contains an unpaired surrogate');
    }
  }
}

export function assertRappCanonicalValue(value: unknown, depth = 1): asserts value is JsonValue {
  if (depth > RAPP_MAX_CANONICAL_DEPTH) {
    throw new TypeError(`RAPP/1 value exceeds depth ${RAPP_MAX_CANONICAL_DEPTH}`);
  }
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    if (typeof value === 'string') validateRappString(value);
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('RAPP/1 canonical numbers must be finite binary64 values');
    return;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) assertRappCanonicalValue(value[index], depth + 1);
    return;
  }
  if (
    typeof value !== 'object' || value === null
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  ) throw new TypeError(`RAPP/1 value is not I-JSON: ${typeof value}`);
  const object = value as Record<string, unknown>;
  const keys = SAFE_OBJECT_KEYS(object);
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    validateRappString(key);
    assertRappCanonicalValue(object[key], depth + 1);
  }
}

function renderRappCanonical(value: JsonValue): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number' || typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    const items: string[] = [];
    for (let index = 0; index < value.length; index += 1) {
      safeArraySet(items, index, renderRappCanonical(value[index]));
    }
    return `[${SAFE_REFLECT_APPLY(SAFE_ARRAY_JOIN, items, [','])}]`;
  }
  const keys = SAFE_REFLECT_APPLY(SAFE_ARRAY_SORT, SAFE_OBJECT_KEYS(value), []) as string[];
  const entries: string[] = [];
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    safeArraySet(entries, index, `${JSON.stringify(key)}:${renderRappCanonical(value[key])}`);
  }
  return `{${SAFE_REFLECT_APPLY(SAFE_ARRAY_JOIN, entries, [','])}}`;
}

/** Shared RFC 8785 bytes for Node and browser verification, not a second codec. */
export function rappCanonicalJson(value: JsonValue): string {
  assertRappCanonicalValue(value);
  const rendered = renderRappCanonical(value);
  if (UTF8_ENCODE(rendered).byteLength > RAPP_MAX_CANONICAL_BYTES) {
    throw new TypeError('RAPP/1 canonical form exceeds 1 MiB');
  }
  return rendered;
}
