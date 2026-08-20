/**
 * Canonical bytes, content addresses, and the one PRNG both runtimes share.
 *
 * Two runtimes only agree about a hash if they agree about the bytes, so the
 * canonical form is pinned here and nowhere else: keys sorted, no whitespace,
 * ASCII-escaped. That is byte-identical to Python's
 * `json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True)`,
 * which is what already produced the manifest hash inside a live organism —
 * so this reads existing content addresses rather than inventing a new one.
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

import type { JsonValue } from './types.js';

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

/** JSON with sorted keys, no spaces and ASCII escapes. */
export function canonicalJson(value: JsonValue): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return canonicalNumber(value);
  if (typeof value === 'string') return canonicalString(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).sort();
  const body = keys.map((key) => `${canonicalString(key)}:${canonicalJson(value[key])}`);
  return `{${body.join(',')}}`;
}

/**
 * Integers print as integers, which is what Python's `json` emits and what the
 * hashes on disk were taken over. A non-finite number has no JSON form, and
 * quietly writing `null` for one would change a content address without
 * changing the value that produced it.
 */
function canonicalNumber(value: number): string {
  if (!Number.isFinite(value)) {
    throw new TypeError(`cannot canonicalise non-finite number: ${String(value)}`);
  }
  return Number.isInteger(value) ? value.toFixed(0) : String(value);
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

function validateRappValue(value: JsonValue, depth = 1): void {
  if (depth > 64) throw new TypeError('RAPP/1 value exceeds depth 64');
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    if (typeof value === 'string') {
      for (let index = 0; index < value.length; index += 1) {
        const unit = value.charCodeAt(index);
        if (
          unit >= 0xd800
          && unit <= 0xdfff
          && !(
            unit <= 0xdbff
            && index + 1 < value.length
            && value.charCodeAt(index + 1) >= 0xdc00
            && value.charCodeAt(index + 1) <= 0xdfff
          )
          && !(
            unit >= 0xdc00
            && index > 0
            && value.charCodeAt(index - 1) >= 0xd800
            && value.charCodeAt(index - 1) <= 0xdbff
          )
        ) {
          throw new TypeError('RAPP/1 string contains an unpaired surrogate');
        }
      }
    }
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new TypeError('Quantum RAPPID frames use the RAPP/1 exact-integer profile');
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) validateRappValue(item, depth + 1);
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if ([...key].some((character) => character.codePointAt(0)! > 0xffff)) {
      throw new TypeError('RAPP/1 exact profile refuses supplementary-plane object keys');
    }
    validateRappValue(key, depth + 1);
    validateRappValue(item, depth + 1);
  }
}

function renderRappCanonical(value: JsonValue): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => renderRappCanonical(item)).join(',')}]`;
  }
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${renderRappCanonical(value[key])}`,
  ).join(',')}}`;
}

/** RAPP/1's exact-value canonical profile: UTF-8, sorted keys, no whitespace. */
export function rappCanonicalJson(value: JsonValue): string {
  validateRappValue(value);
  const rendered = renderRappCanonical(value);
  if (Buffer.byteLength(rendered, 'utf8') > 1024 * 1024) {
    throw new TypeError('RAPP/1 canonical form exceeds 1 MiB');
  }
  return rendered;
}

export function rappH(space: string, value: JsonValue): string {
  return sha256Hex(Buffer.from(`${space}\n${rappCanonicalJson(value)}`, 'utf8'));
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
