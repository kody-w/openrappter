import { createHash } from 'node:crypto';
import { types } from 'node:util';

export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
export interface JsonObject { [key: string]: JsonValue }

export const MAX_CANONICAL_BYTES = 1024 * 1024;
export const MAX_CANONICAL_DEPTH = 64;
export const PARTICLE_DOMAIN = 'rapp/1:particle';
export const WAVE_DOMAIN = 'rapp/1:wave';
export const IDENTITY_DOMAIN = 'rapp/1:rappid';
export const EGG_DOMAIN = 'rapp/1:egg';

const ownKeys = Reflect.ownKeys;
const descriptor = Object.getOwnPropertyDescriptor;
const getPrototype = Object.getPrototypeOf;
const objectPrototype = Object.prototype;
const define = Object.defineProperty;
const freeze = Object.freeze;
const isArray = Array.isArray;
const isProxy = types.isProxy;
const hasOwn = Object.hasOwn;
const stringify = JSON.stringify;
const decode = JSON.parse;
const sort = Function.call.bind(Array.prototype.sort) as (values: string[]) => string[];
const join = Function.call.bind(Array.prototype.join) as (values: string[], separator: string) => string;

export function assertUnicode(value: string): void {
  for (let i = 0; i < value.length; i++) {
    const unit = value.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new TypeError('Unpaired UTF-16 surrogate');
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new TypeError('Unpaired UTF-16 surrogate');
    }
  }
}

/** Options are inspected without executing caller code, even for non-JSON capabilities. */
export function assertOptions<T>(
  value: T, allowed: readonly string[], required: readonly string[] = allowed,
): asserts value is T & Record<string, unknown> {
  if (value === null || typeof value !== 'object' || isProxy(value) || isArray(value)
    || (getPrototype(value) !== objectPrototype && getPrototype(value) !== null)) {
    throw new TypeError('Expected a plain own-property options object');
  }
  for (const key of ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.includes(key)) throw new TypeError('Unexpected option key');
    const property = descriptor(value, key);
    if (!property || !hasOwn(property, 'value') || !property.enumerable) {
      throw new TypeError('Options must be enumerable data properties');
    }
  }
  for (const key of required) {
    if (!descriptor(value, key)) throw new TypeError(`Missing option: ${key}`);
  }
}

export function arrayItems(value: unknown, max = 100_000): readonly unknown[] {
  if (typeof value !== 'object' || value === null || isProxy(value) || !isArray(value)) {
    throw new TypeError('Expected a dense own-property array');
  }
  const length = descriptor(value, 'length')?.value as unknown;
  if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0 || length > max
    || ownKeys(value).length !== length + 1) throw new TypeError('Invalid array length or properties');
  const result: unknown[] = [];
  for (let i = 0; i < length; i++) {
    const item = descriptor(value, String(i));
    if (!item || !hasOwn(item, 'value') || !item.enumerable) throw new TypeError('Array hole or accessor');
    define(result, String(i), { value: item.value, enumerable: true });
  }
  return freeze(result);
}

export function isJsonObject(value: JsonValue): value is JsonObject {
  return value !== null && typeof value === 'object' && !isArray(value);
}

/** Copy once, reject accessors/proxies/exotics, and never call toJSON or normalize text. */
export function snapshotJson(value: unknown): JsonValue {
  const active = new WeakSet<object>();
  let nodes = 0;
  const visit = (current: unknown, depth: number): JsonValue => {
    if (depth > MAX_CANONICAL_DEPTH || ++nodes > MAX_CANONICAL_BYTES) {
      throw new TypeError('Canonical JSON depth or size limit exceeded');
    }
    if (current === null || typeof current === 'boolean') return current;
    if (typeof current === 'string') {
      assertUnicode(current);
      if (Buffer.byteLength(current) > MAX_CANONICAL_BYTES) throw new TypeError('JSON string exceeds 1 MiB');
      return current;
    }
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) throw new TypeError('JSON number is not finite binary64');
      return current;
    }
    if (typeof current !== 'object' || isProxy(current)) {
      throw new TypeError('JSON requires stable data; functions, proxies and non-values are refused');
    }
    if (active.has(current)) throw new TypeError('JSON cycle');
    active.add(current);
    try {
      const keys = ownKeys(current);
      const array = isArray(current);
      if (!array && getPrototype(current) !== objectPrototype && getPrototype(current) !== null) {
        throw new TypeError('Non-plain JSON object');
      }
      const length = array ? descriptor(current, 'length')?.value as unknown : null;
      if (array && (typeof length !== 'number' || length > MAX_CANONICAL_BYTES
        || !Number.isSafeInteger(length) || length < 0 || keys.length !== length + 1)) {
        throw new TypeError('Sparse or oversized JSON array');
      }
      const result: JsonObject | JsonValue[] = array ? [] : Object.create(null) as JsonObject;
      for (let i = 0; i < keys.length; i++) {
        const key = keys[i]!;
        if (typeof key !== 'string') throw new TypeError('JSON symbol key');
        const property = descriptor(current, key);
        if (!property || !hasOwn(property, 'value')) throw new TypeError('JSON accessor');
        if (array && key === 'length') continue;
        if (!property.enumerable) throw new TypeError('Non-enumerable JSON property');
        if (array && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= (length as number))) {
          throw new TypeError('Non-index JSON array property');
        }
        assertUnicode(key);
        define(result, key, { value: visit(property.value, depth + 1), enumerable: true });
      }
      return freeze(result) as JsonValue;
    } finally {
      active.delete(current);
    }
  };
  return visit(value, 1);
}

function render(value: JsonValue): string {
  if (value === null || typeof value !== 'object') return stringify(value);
  const parts: string[] = [];
  if (isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      define(parts, String(i), { value: render(value[i]!), enumerable: true, configurable: true });
    }
    return `[${join(parts, ',')}]`;
  }
  const keys = sort(ownKeys(value) as string[]);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i]!;
    define(parts, String(i), {
      value: `${stringify(key)}:${render(value[key]!)}`, enumerable: true, configurable: true,
    });
  }
  return `{${join(parts, ',')}}`;
}

export function canonicalJson(value: unknown): string {
  const result = render(snapshotJson(value));
  if (Buffer.byteLength(result) > MAX_CANONICAL_BYTES) throw new TypeError('Canonical JSON exceeds 1 MiB');
  return result;
}

function decimalIdentity(token: string): string {
  const match = /^(-)?(0|[1-9]\d*)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(token);
  if (!match) throw new TypeError('Invalid number');
  const fraction = match[3] ?? '';
  const allDigits = `${match[2]}${fraction}`.replace(/^0+/, '');
  if (!allDigits) return '0';
  const digits = allDigits.replace(/0+$/, '');
  const exponent = Number(match[4] ?? 0) - fraction.length + allDigits.length - digits.length;
  if (!Number.isSafeInteger(exponent)) throw new TypeError('Lossy decimal exponent');
  return `${match[1] ?? ''}${digits}e${exponent}`;
}

/** RFC 8785 plus rev-14's duplicate-member and decimal round-trip refusal rules. */
export function parseJson(source: string | Uint8Array): JsonValue {
  let text: string;
  if (typeof source === 'string') text = source;
  else if (source instanceof Uint8Array && !isProxy(source)) {
    if (source.byteLength > MAX_CANONICAL_BYTES) throw new TypeError('JSON exceeds 1 MiB');
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(source);
  } else throw new TypeError('JSON input must be text or UTF-8 bytes');
  if (Buffer.byteLength(text) > MAX_CANONICAL_BYTES) throw new TypeError('JSON exceeds 1 MiB');
  let offset = 0;
  const space = (): void => { while (/[ \t\r\n]/.test(text[offset] ?? 'x')) offset++; };
  const string = (): string => {
    const start = offset++;
    if (text[start] !== '"') throw new TypeError('Expected JSON string');
    let escaped = false;
    while (offset < text.length) {
      const char = text[offset++]!;
      if (!escaped && char === '"') {
        const result = decode(text.slice(start, offset)) as string;
        assertUnicode(result);
        return result;
      }
      escaped = !escaped && char === '\\';
    }
    throw new TypeError('Unterminated JSON string');
  };
  const value = (depth: number): JsonValue => {
    if (depth > MAX_CANONICAL_DEPTH) throw new TypeError('JSON exceeds depth 64');
    space();
    if (text[offset] === '"') return string();
    if (text[offset] === '{') {
      offset++;
      space();
      const result = Object.create(null) as JsonObject;
      if (text[offset] === '}') { offset++; return result; }
      for (;;) {
        space();
        const key = string();
        if (descriptor(result, key)) throw new TypeError('Duplicate JSON member');
        space();
        if (text[offset++] !== ':') throw new TypeError('Expected colon');
        define(result, key, { value: value(depth + 1), enumerable: true });
        space();
        const delimiter = text[offset++];
        if (delimiter === '}') return result;
        if (delimiter !== ',') throw new TypeError('Expected comma or closing brace');
      }
    }
    if (text[offset] === '[') {
      offset++;
      space();
      const result: JsonValue[] = [];
      if (text[offset] === ']') { offset++; return result; }
      for (;;) {
        define(result, String(result.length), { value: value(depth + 1), enumerable: true });
        space();
        const delimiter = text[offset++];
        if (delimiter === ']') return result;
        if (delimiter !== ',') throw new TypeError('Expected comma or closing bracket');
      }
    }
    for (const [literal, result] of [['true', true], ['false', false], ['null', null]] as const) {
      if (text.startsWith(literal, offset)) { offset += literal.length; return result; }
    }
    const number = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
    number.lastIndex = offset;
    const match = number.exec(text);
    if (!match) throw new TypeError(`Invalid JSON at ${offset}`);
    offset = number.lastIndex;
    const result = Number(match[0]);
    if (!Number.isFinite(result) || decimalIdentity(match[0]) !== decimalIdentity(stringify(result))) {
      throw new TypeError('Number does not survive the binary64 round-trip');
    }
    return result;
  };
  const parsed = value(1);
  space();
  if (offset !== text.length) throw new TypeError('Trailing JSON data');
  canonicalJson(parsed);
  return snapshotJson(parsed);
}

export function parseCanonicalJson(source: string | Uint8Array): JsonValue {
  const parsed = parseJson(source);
  const original = typeof source === 'string' ? source : Buffer.from(source).toString('utf8');
  if (canonicalJson(parsed) !== original) throw new TypeError('Non-canonical JSON bytes; repair is forbidden');
  return parsed;
}

export function sha256(bytes: string | Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function assertDomain(domain: string): void {
  if (typeof domain !== 'string' || !/^[\x21-\x7e]+$/.test(domain)) throw new TypeError('Invalid hash domain');
}

export function hashValue(domain: string, value: unknown): string {
  assertDomain(domain);
  return sha256(`${domain}\n${canonicalJson(value)}`);
}

export function hashBytes(domain: string, bytes: Uint8Array): string {
  assertDomain(domain);
  if (!(bytes instanceof Uint8Array) || isProxy(bytes)) throw new TypeError('Expected raw bytes');
  return createHash('sha256').update(`${domain}\n`).update(bytes).digest('hex');
}
