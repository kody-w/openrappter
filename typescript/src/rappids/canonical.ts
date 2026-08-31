/**
 * Canonical bytes, content addresses, and the one PRNG both runtimes share.
 *
 * Two runtimes only agree about a hash if they agree about the bytes. The
 * historical `canonicalJson` helper remains ASCII-escaped for its existing
 * Quantum RAPPID callers; `rappCanonicalJson` is the RAPP/1 RFC 8785 form:
 * UTF-16 key ordering, raw UTF-8 strings, no whitespace, and ECMAScript
 * binary64 number serialization.
 *
 * RAPP values use the full RFC 8785 binary64 number profile. JavaScript's
 * JSON.stringify implements the required ECMAScript serialization; the strict
 * parser additionally proves that an incoming decimal token denotes the same
 * mathematical value after binary64 parsing, so lossy tokens are refused.
 *
 * The PRNG is a SHA-256 counter stream rather than a language RNG on purpose.
 * The generator that seeded the live sonic dimension used Python's Mersenne
 * Twister, which TypeScript cannot reproduce; a "deterministic" provider that
 * only agrees with itself inside one runtime is not deterministic in a
 * two-runtime product. Everything downstream of `DeterministicStream` is
 * integer arithmetic for the same reason: a float comparison that lands one
 * ulp apart would silently select a different candidate on the other runtime.
 *
 * Mirrored by `python/openrappter/rappids/canonical.py`.
 */

import { createHash } from 'node:crypto';
import { types as utilTypes } from 'node:util';

import type { JsonObject, JsonValue } from './types.js';

// Post-import poisoning is in scope and covered by tests. Same-realm intrinsic
// replacement before module initialization is unsupported without a fresh
// realm from which to obtain authenticated ECMAScript intrinsics.
const SAFE_OWN_KEYS = Reflect.ownKeys;
const SAFE_GET_OWN_PROPERTY_DESCRIPTOR = Object.getOwnPropertyDescriptor;
const SAFE_HAS_OWN = Object.hasOwn;
const SAFE_OBJECT_KEYS = Object.keys;
const SAFE_REFLECT_APPLY = Reflect.apply;
const SAFE_DEFINE_PROPERTY = Object.defineProperty;
const SAFE_ARRAY_SORT = Array.prototype.sort;
const SAFE_ARRAY_JOIN = Array.prototype.join;
const SAFE_ARRAY_REVERSE = Array.prototype.reverse;

function safeSort(values: string[]): string[] {
  return SAFE_REFLECT_APPLY(SAFE_ARRAY_SORT, values, []) as string[];
}

function safeJoin(values: readonly string[], separator: string): string {
  return SAFE_REFLECT_APPLY(
    SAFE_ARRAY_JOIN,
    values,
    [separator],
  ) as string;
}

function safeReverse<TValue>(values: TValue[]): TValue[] {
  return SAFE_REFLECT_APPLY(SAFE_ARRAY_REVERSE, values, []) as TValue[];
}

function safeArraySet<TValue>(
  values: TValue[],
  index: number,
  value: TValue,
): void {
  SAFE_DEFINE_PROPERTY(values, String(index), {
    value,
    configurable: true,
    enumerable: true,
    writable: true,
  });
}

/**
 * Domain separation, in the shape RAPP/1 §5 already established and
 * `src/identity/name.ts` already uses (`rapp/1:rappid`). New domains are added
 * here rather than by concatenating raw values, so a seed for one purpose can
 * never collide with a seed for another.
 */
export const AUTOCOMPLETE_DOMAIN = 'quantum-rappid/1:autocomplete';
export const PROPOSAL_DOMAIN = 'quantum-rappid/1:proposal';
export const RAPP_PARTICLE_DOMAIN = 'rapp/1:particle';
export const RAPP_WAVE_DOMAIN = 'rapp/1:wave';
export const RAPP_EGG_DOMAIN = 'rapp/1:egg';
export const RAPP_MAX_CANONICAL_BYTES = 1024 * 1024;
export const RAPP_MAX_CANONICAL_DEPTH = 64;

/** JSON with sorted keys, no spaces and ASCII escapes. */
export function canonicalJson(value: JsonValue): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return canonicalNumber(value);
  if (typeof value === 'string') return canonicalString(value);
  if (Array.isArray(value)) {
    const items: string[] = [];
    for (let index = 0; index < value.length; index += 1) {
      safeArraySet(items, index, canonicalJson(value[index]));
    }
    return `[${safeJoin(items, ',')}]`;
  }
  const keys = safeSort(SAFE_OBJECT_KEYS(value));
  const body: string[] = [];
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    safeArraySet(body, index, `${canonicalString(key)}:${canonicalJson(value[key])}`);
  }
  return `{${safeJoin(body, ',')}}`;
}

/**
 * Integers print as integers. A non-finite number has no JSON form, and
 * quietly writing `null` for one would change a content address without
 * changing the value that produced it.
 */
function canonicalNumber(value: number): string {
  if (!Number.isFinite(value)) {
    throw new TypeError(`cannot canonicalise non-finite number: ${String(value)}`);
  }
  if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
    throw new TypeError(`cannot canonicalise unsafe integer: ${String(value)}`);
  }
  return JSON.stringify(value);
}

const JSON_ESCAPES: Record<string, string> = {
  '"': '\\"',
  '\\': '\\\\',
  '\b': '\\b',
  '\f': '\\f',
  '\n': '\\n',
  '\r': '\\r',
  '\t': '\\t',
};

/** `ensure_ascii=True`: every code unit above 0x7f becomes `\uXXXX`. */
function canonicalString(value: string): string {
  let out = '"';
  for (const character of value) {
    for (let index = 0; index < character.length; index += 1) {
      const unit = character.charCodeAt(index);
      const escape = JSON_ESCAPES[character[index]];
      if (escape !== undefined) out += escape;
      else if (unit < 0x20 || unit > 0x7e) out += `\\u${unit.toString(16).padStart(4, '0')}`;
      else out += character[index];
    }
  }
  return `${out}"`;
}

export function sha256Hex(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}

function validateRappString(value: string): void {
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

/**
 * Refuse values outside the finite binary64 RAPP/1 profile before hashing.
 *
 * JavaScript's default string comparison is lexicographic over UTF-16 code
 * units, which is exactly RFC 8785 member ordering. Valid surrogate pairs are
 * therefore accepted in keys; only unpaired surrogates are non-I-JSON.
 */
export function assertRappCanonicalValue(
  value: unknown,
  depth = 1,
): asserts value is JsonValue {
  if (depth > RAPP_MAX_CANONICAL_DEPTH) {
    throw new TypeError(`RAPP/1 value exceeds depth ${RAPP_MAX_CANONICAL_DEPTH}`);
  }
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    if (typeof value === 'string') validateRappString(value);
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('RAPP/1 canonical numbers must be finite binary64 values');
    }
    return;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      assertRappCanonicalValue(value[index], depth + 1);
    }
    return;
  }
  if (
    typeof value !== 'object'
    || value === null
    || (
      Object.getPrototypeOf(value) !== Object.prototype
      && Object.getPrototypeOf(value) !== null
    )
  ) {
    throw new TypeError(`RAPP/1 value is not I-JSON: ${typeof value}`);
  }
  const object = value as Record<string, unknown>;
  const keys = SAFE_OBJECT_KEYS(object);
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    validateRappString(key);
    assertRappCanonicalValue(object[key], depth + 1);
  }
}

/**
 * Materialize a hostile programmatic JSON value without invoking accessors or
 * rereading properties. Proxies are refused because their descriptor/ownKeys
 * traps can present mutually inconsistent objects during one verification.
 */
export function snapshotRappJsonValue(value: unknown): JsonValue {
  interface SnapshotNode {
    object: object;
    value: JsonValue;
    next: SnapshotNode | null;
  }
  interface ActiveNode {
    object: object;
    next: ActiveNode | null;
  }
  let snapshots: SnapshotNode | null = null;
  let active: ActiveNode | null = null;

  const snapshotFor = (object: object): JsonValue | undefined => {
    let node = snapshots;
    while (node !== null) {
      if (node.object === object) return node.value;
      node = node.next;
    }
    return undefined;
  };
  const isActive = (object: object): boolean => {
    let node = active;
    while (node !== null) {
      if (node.object === object) return true;
      node = node.next;
    }
    return false;
  };
  const remember = (object: object, snapshot: JsonValue): void => {
    const node = Object.create(null) as SnapshotNode;
    SAFE_DEFINE_PROPERTY(node, 'object', { value: object, enumerable: true });
    SAFE_DEFINE_PROPERTY(node, 'value', { value: snapshot, enumerable: true });
    SAFE_DEFINE_PROPERTY(node, 'next', { value: snapshots, enumerable: true });
    snapshots = Object.freeze(node);
  };

  const visit = (current: unknown, path: string): JsonValue => {
    if (
      current === null
      || typeof current === 'string'
      || typeof current === 'boolean'
      || typeof current === 'number'
    ) {
      return current;
    }
    if (typeof current !== 'object') {
      throw new TypeError(`${path} is not a JSON value`);
    }
    if (utilTypes.isProxy(current)) {
      throw new TypeError(`${path} is a Proxy; RAPP verification requires stable descriptors`);
    }
    if (isActive(current)) throw new TypeError(`${path} contains a JSON cycle`);
    const cached = snapshotFor(current);
    if (cached !== undefined) return cached;

    const keys = SAFE_OWN_KEYS(current);
    const stringKeys = keys as string[];
    const descriptors = Object.create(null) as Record<string, PropertyDescriptor>;
    const seen = Object.create(null) as Record<string, true>;
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];
      if (typeof key === 'symbol') {
        throw new TypeError(`${path} contains a symbol key`);
      }
      if (SAFE_GET_OWN_PROPERTY_DESCRIPTOR(seen, key) !== undefined) {
        throw new TypeError(`${path} contains duplicate own keys`);
      }
      seen[key] = true;
      const descriptor = SAFE_GET_OWN_PROPERTY_DESCRIPTOR(current, key);
      if (descriptor === undefined) {
        throw new TypeError(`${path}.${key} changed shape during snapshot`);
      }
      if (!SAFE_HAS_OWN(descriptor, 'value')) {
        throw new TypeError(`${path}.${key} is an accessor property`);
      }
      descriptors[key] = descriptor;
    }

    const activeNode = Object.create(null) as ActiveNode;
    SAFE_DEFINE_PROPERTY(activeNode, 'object', { value: current, enumerable: true });
    SAFE_DEFINE_PROPERTY(activeNode, 'next', { value: active, enumerable: true });
    active = Object.freeze(activeNode);
    try {
      if (Array.isArray(current)) {
        const lengthDescriptor = descriptors.length;
        if (
          lengthDescriptor === undefined
          || typeof lengthDescriptor.value !== 'number'
          || !Number.isSafeInteger(lengthDescriptor.value)
          || lengthDescriptor.value < 0
        ) {
          throw new TypeError(`${path}.length is invalid`);
        }
        const length = lengthDescriptor.value;
        let indexKeyCount = 0;
        for (let index = 0; index < stringKeys.length; index += 1) {
          const key = stringKeys[index];
          if (key === 'length') continue;
          indexKeyCount += 1;
          if (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= length) {
            throw new TypeError(`${path} contains a non-index array property`);
          }
        }
        if (indexKeyCount !== length) {
          throw new TypeError(`${path} contains an array hole`);
        }
        const result: JsonValue[] = [];
        remember(current, result);
        for (let index = 0; index < length; index += 1) {
          const descriptor = descriptors[String(index)];
          if (descriptor === undefined || descriptor.enumerable !== true) {
            throw new TypeError(`${path}[${index}] is missing or non-enumerable`);
          }
          safeArraySet(result, index, visit(descriptor.value, `${path}[${index}]`));
        }
        return Object.freeze(result) as unknown as JsonValue[];
      }

      const prototype = Object.getPrototypeOf(current);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new TypeError(`${path} is not a plain JSON object`);
      }
      const result = Object.create(null) as JsonObject;
      remember(current, result);
      for (let index = 0; index < stringKeys.length; index += 1) {
        const key = stringKeys[index];
        const descriptor = descriptors[key];
        if (descriptor.enumerable !== true) {
          throw new TypeError(`${path}.${key} is non-enumerable`);
        }
        result[key] = visit(descriptor.value, `${path}.${key}`);
      }
      return Object.freeze(result);
    } finally {
      active = activeNode.next;
    }
  };

  const snapshot = visit(value, '$');
  assertRappCanonicalValue(snapshot);
  return snapshot;
}

/**
 * Parse the RAPP/1 I-JSON profile without losing duplicate members or lossy
 * number tokens through JSON.parse's last-value-wins behavior.
 */
export function parseRappJson(source: string): JsonValue {
  if (typeof source !== 'string') {
    throw new TypeError('RAPP/1 JSON input must be a string');
  }
  if (Buffer.byteLength(source, 'utf8') > RAPP_MAX_CANONICAL_BYTES) {
    throw new TypeError('RAPP/1 JSON input exceeds 1 MiB');
  }

  let offset = 0;
  const whitespace = (): void => {
    while (
      source[offset] === ' '
      || source[offset] === '\n'
      || source[offset] === '\r'
      || source[offset] === '\t'
    ) {
      offset += 1;
    }
  };
  const stringValue = (): string => {
    if (source[offset] !== '"') throw new TypeError(`expected string at offset ${offset}`);
    const start = offset;
    offset += 1;
    let escaped = false;
    while (offset < source.length) {
      const character = source[offset];
      if (!escaped && character === '"') {
        offset += 1;
        let value: unknown;
        try {
          value = JSON.parse(source.slice(start, offset));
        } catch {
          throw new TypeError(`invalid JSON string at offset ${start}`);
        }
        if (typeof value !== 'string') throw new TypeError(`invalid JSON string at offset ${start}`);
        validateRappString(value);
        return value;
      }
      if (!escaped && character === '\\') escaped = true;
      else escaped = false;
      offset += 1;
    }
    throw new TypeError(`unterminated JSON string at offset ${start}`);
  };
  interface SignedDecimalInteger {
    negative: boolean;
    digits: string;
  }
  const signedInteger = (token: string): SignedDecimalInteger => {
    const negative = token.startsWith('-');
    const digits = token.replace(/^[+-]?0*/, '') || '0';
    return { negative: digits === '0' ? false : negative, digits };
  };
  const compareMagnitude = (left: string, right: string): number => {
    if (left.length !== right.length) return left.length < right.length ? -1 : 1;
    return left === right ? 0 : left < right ? -1 : 1;
  };
  const addMagnitude = (left: string, right: string): string => {
    let carry = 0;
    const result: string[] = [];
    for (
      let index = 0;
      index < Math.max(left.length, right.length) || carry > 0;
      index += 1
    ) {
      const sum =
        Number(left[left.length - 1 - index] ?? 0)
        + Number(right[right.length - 1 - index] ?? 0)
        + carry;
      safeArraySet(result, result.length, String(sum % 10));
      carry = Math.floor(sum / 10);
    }
    return safeJoin(safeReverse(result), '').replace(/^0+/, '') || '0';
  };
  const subtractMagnitude = (left: string, right: string): string => {
    let borrow = 0;
    const result: string[] = [];
    for (let index = 0; index < left.length; index += 1) {
      let difference =
        Number(left[left.length - 1 - index])
        - Number(right[right.length - 1 - index] ?? 0)
        - borrow;
      if (difference < 0) {
        difference += 10;
        borrow = 1;
      } else {
        borrow = 0;
      }
      safeArraySet(result, result.length, String(difference));
    }
    return safeJoin(safeReverse(result), '').replace(/^0+/, '') || '0';
  };
  const addSigned = (
    left: SignedDecimalInteger,
    right: SignedDecimalInteger,
  ): SignedDecimalInteger => {
    if (left.negative === right.negative) {
      return {
        negative: left.negative,
        digits: addMagnitude(left.digits, right.digits),
      };
    }
    const comparison = compareMagnitude(left.digits, right.digits);
    if (comparison === 0) return { negative: false, digits: '0' };
    const larger = comparison > 0 ? left : right;
    const smaller = comparison > 0 ? right : left;
    return {
      negative: larger.negative,
      digits: subtractMagnitude(larger.digits, smaller.digits),
    };
  };
  const signedSmallInteger = (value: number): SignedDecimalInteger => ({
    negative: value < 0,
    digits: String(Math.abs(value)),
  });
  const decimalIdentity = (token: string): string => {
    const match =
      /^(-)?(0|[1-9]\d*)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(token);
    if (match === null) throw new TypeError('invalid JSON number token');
    let digits = `${match[2]}${match[3] ?? ''}`.replace(/^0+/, '');
    if (digits.length === 0) return '0';
    let trailing = 0;
    while (digits.endsWith('0')) {
      digits = digits.slice(0, -1);
      trailing += 1;
    }
    const exponent = addSigned(
      signedInteger(match[4] ?? '0'),
      signedSmallInteger(trailing - (match[3] ?? '').length),
    );
    const exponentText =
      `${exponent.negative ? '-' : ''}${exponent.digits}`;
    return `${match[1] ?? ''}${digits}e${exponentText}`;
  };
  const numberValue = (): number => {
    const start = offset;
    const matcher =
      /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
    matcher.lastIndex = offset;
    const match = matcher.exec(source);
    if (match === null) throw new TypeError(`invalid JSON number at offset ${start}`);
    offset = matcher.lastIndex;
    const token = source.slice(start, offset);
    const value = Number(token);
    if (!Number.isFinite(value)) {
      throw new TypeError('RAPP/1 number token is not a finite binary64 value');
    }
    const canonical = JSON.stringify(value);
    if (canonical === undefined || decimalIdentity(token) !== decimalIdentity(canonical)) {
      throw new TypeError('RAPP/1 number token does not survive the binary64 round-trip');
    }
    return value;
  };
  const value = (depth: number): JsonValue => {
    if (depth > RAPP_MAX_CANONICAL_DEPTH) {
      throw new TypeError(`RAPP/1 value exceeds depth ${RAPP_MAX_CANONICAL_DEPTH}`);
    }
    whitespace();
    const character = source[offset];
    if (character === '"') return stringValue();
    if (character === '[') {
      offset += 1;
      whitespace();
      const result: JsonValue[] = [];
      if (source[offset] === ']') {
        offset += 1;
        return result;
      }
      for (;;) {
        safeArraySet(result, result.length, value(depth + 1));
        whitespace();
        if (source[offset] === ']') {
          offset += 1;
          return result;
        }
        if (source[offset] !== ',') {
          throw new TypeError(`expected comma or ] at offset ${offset}`);
        }
        offset += 1;
      }
    }
    if (character === '{') {
      offset += 1;
      whitespace();
      const result: JsonObject = Object.create(null) as JsonObject;
      const keys = Object.create(null) as Record<string, true>;
      if (source[offset] === '}') {
        offset += 1;
        return result;
      }
      for (;;) {
        whitespace();
        const key = stringValue();
        if (SAFE_GET_OWN_PROPERTY_DESCRIPTOR(keys, key) !== undefined) {
          throw new TypeError(`duplicate JSON member: ${key}`);
        }
        keys[key] = true;
        whitespace();
        if (source[offset] !== ':') throw new TypeError(`expected colon at offset ${offset}`);
        offset += 1;
        result[key] = value(depth + 1);
        whitespace();
        if (source[offset] === '}') {
          offset += 1;
          return result;
        }
        if (source[offset] !== ',') {
          throw new TypeError(`expected comma or } at offset ${offset}`);
        }
        offset += 1;
      }
    }
    if (source.startsWith('true', offset)) {
      offset += 4;
      return true;
    }
    if (source.startsWith('false', offset)) {
      offset += 5;
      return false;
    }
    if (source.startsWith('null', offset)) {
      offset += 4;
      return null;
    }
    if (character === '-' || /[0-9]/.test(character ?? '')) return numberValue();
    throw new TypeError(`invalid JSON value at offset ${offset}`);
  };

  const parsed = value(1);
  whitespace();
  if (offset !== source.length) {
    throw new TypeError(`trailing JSON data at offset ${offset}`);
  }
  // Applies canonical byte size and all decoded string/value checks.
  rappCanonicalJson(parsed);
  return parsed;
}

function renderRappCanonical(value: JsonValue): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return JSON.stringify(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    const items: string[] = [];
    for (let index = 0; index < value.length; index += 1) {
      safeArraySet(items, index, renderRappCanonical(value[index]));
    }
    return `[${safeJoin(items, ',')}]`;
  }
  // The captured default sort orders by UTF-16 code units, matching RFC 8785
  // even when a valid key is outside the BMP.
  const keys = safeSort(SAFE_OBJECT_KEYS(value));
  const entries: string[] = [];
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    safeArraySet(
      entries,
      index,
      `${JSON.stringify(key)}:${renderRappCanonical(value[key])}`,
    );
  }
  return `{${safeJoin(entries, ',')}}`;
}

/** RAPP/1's exact-value canonical profile: UTF-8, sorted keys, no whitespace. */
export function rappCanonicalJson(value: JsonValue): string {
  assertRappCanonicalValue(value);
  const rendered = renderRappCanonical(value);
  if (Buffer.byteLength(rendered, 'utf8') > RAPP_MAX_CANONICAL_BYTES) {
    throw new TypeError('RAPP/1 canonical form exceeds 1 MiB');
  }
  return rendered;
}

export function rappH(space: string, value: JsonValue): string {
  return rappHashCanonical(space, rappCanonicalJson(value));
}

export function rappHashCanonical(space: string, canonical: string): string {
  return sha256Hex(Buffer.from(`${space}\n${canonical}`, 'utf8'));
}

export function rappHb(space: string, bytes: Uint8Array): string {
  return sha256Hex(Buffer.concat([
    Buffer.from(`${space}\n`, 'ascii'),
    Buffer.from(bytes),
  ]));
}

/** The content address of a value: sha256 over its canonical bytes. */
export function canonicalDigest(value: JsonValue): string {
  return sha256Hex(Buffer.from(canonicalJson(value), 'utf8'));
}

/** `sha256("<domain>\n<value>")` — RAPP/1 §5 domain separation. */
export function domainDigest(domain: string, value: string): string {
  return sha256Hex(Buffer.from(`${domain}\n${value}`, 'utf8'));
}

/**
 * Floor division for non-negative operands.
 *
 * Named rather than inlined because Python's `//` and JavaScript's `/` disagree
 * about everything except this case, and every use site here must be the case
 * they agree about.
 */
export function idiv(numerator: number, denominator: number): number {
  if (denominator <= 0) throw new RangeError('idiv requires a positive denominator');
  if (numerator < 0) throw new RangeError('idiv requires a non-negative numerator');
  return Math.floor(numerator / denominator);
}

/**
 * Half-up rounding, spelled out.
 *
 * `Math.round` and Python's `round` differ at exactly `.5` — JavaScript rounds
 * up, Python rounds to even — so neither built-in can be used where the two
 * runtimes must agree.
 */
export function roundHalfUp(value: number): number {
  return Math.floor(value + 0.5);
}

/** A trait as an exact integer in thousandths, the only form scoring sees. */
export function traitMilli(value: number): number {
  if (!Number.isFinite(value)) throw new TypeError('trait must be a finite number');
  return roundHalfUp(value * 1000);
}

/** Millionths back to a float, for presentation only. Never for comparison. */
export function microToFloat(micro: number): number {
  return micro / 1_000_000;
}

/**
 * A deterministic byte stream, seeded by a hex digest.
 *
 * `block_n = sha256("<seed>:<n>")`, consumed a byte at a time. Both runtimes
 * produce the same bytes for the same seed, forever, offline.
 */
export class DeterministicStream {
  private readonly seed: string;
  private counter = 0;
  private block: Buffer;
  private offset: number;

  constructor(seed: string) {
    if (seed.length === 0) throw new RangeError('DeterministicStream requires a seed');
    this.seed = seed;
    this.block = Buffer.alloc(0);
    this.offset = 0;
  }

  private nextByte(): number {
    if (this.offset >= this.block.length) {
      this.block = createHash('sha256').update(`${this.seed}:${this.counter}`, 'utf8').digest();
      this.counter += 1;
      this.offset = 0;
    }
    const byte = this.block[this.offset];
    this.offset += 1;
    return byte;
  }

  nextUint32(): number {
    return (
      this.nextByte() * 0x1000000
      + this.nextByte() * 0x10000
      + this.nextByte() * 0x100
      + this.nextByte()
    );
  }

  /** A uniform integer in `[0, bound)`. Rejection sampled, so unbiased. */
  nextBelow(bound: number): number {
    if (!Number.isInteger(bound) || bound <= 0) {
      throw new RangeError('nextBelow requires a positive integer bound');
    }
    const limit = Math.floor(0x100000000 / bound) * bound;
    for (;;) {
      const value = this.nextUint32();
      if (value < limit) return value % bound;
    }
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new RangeError('pick requires a non-empty list');
    return items[this.nextBelow(items.length)];
  }

  /** Index chosen in proportion to integer weights. */
  weightedIndex(weights: readonly number[]): number {
    let total = 0;
    for (const weight of weights) {
      if (!Number.isInteger(weight) || weight < 0) {
        throw new RangeError('weights must be non-negative integers');
      }
      total += weight;
    }
    if (total <= 0) throw new RangeError('weights must not sum to zero');
    let roll = this.nextBelow(total);
    for (let index = 0; index < weights.length; index += 1) {
      if (roll < weights[index]) return index;
      roll -= weights[index];
    }
    // Unreachable: `roll < total` and the weights sum to `total`.
    throw new RangeError('weighted selection fell through');
  }
}
