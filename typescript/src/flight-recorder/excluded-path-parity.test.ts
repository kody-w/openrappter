/**
 * Both runtimes must exclude the same credential-bearing files.
 *
 * Exclusion is not about hiding the path — a path is not a secret. When a
 * recorded object carries a file locator for an excluded path, *every* sibling
 * field in that object is replaced with `[excluded-path]`, including `content`.
 * So a credential file missing from the list means its **contents** are written
 * to the flight log.
 *
 * Measured before this test existed, `.netrc`, `.npmrc`, `.pypirc`, `.pgpass`,
 * `.htpasswd`, `.docker/config.json`, `.kube/config`, `.gnupg` and the
 * `.pfx`/`.jks` siblings of the already-excluded `.p12` were all absent.
 * Value-pattern matching rescued some contents by luck, but an `.npmrc` auth
 * token and a `.pgpass` line reached the log verbatim.
 *
 * `must_keep` matters as much: a false positive here blanks a whole record, not
 * one field.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { isExcludedFlightPath, sanitizeFlightMetadata } from './redaction.js';

const CORPUS = resolve(__dirname, '../../../contracts/excluded-path-corpus.json');
const cases = JSON.parse(readFileSync(CORPUS, 'utf8')) as {
  must_exclude: string[];
  must_keep: string[];
  safe_metadata_fields: {
    numeric: string[];
    text: string[];
    maxTextBytes: number;
  };
  depth_guard: {
    maxTraversalDepth: number;
    nonContainerIsNeverAContainerOfLocators: boolean;
  };
};

/**
 * Matches no value pattern, so only the path exclusion can keep it out. Named
 * without the word "secret": a high-entropy literal under a secret-shaped name is
 * what a scanner looks for, and the repo may not contain one even in a test.
 */
const OPAQUE_VALUE = 'a7Fq2Xm9Lp4Rt8Wz';
const EXCLUDED = '[excluded-path]';

describe('flight-recorder path exclusion', () => {
  it.each(cases.must_exclude)('excludes %s', path => {
    expect(isExcludedFlightPath(path)).toBe(true);
  });

  // The point of the exclusion: siblings are blanked, not just the locator.
  it.each(cases.must_exclude)('never records the contents of %s', path => {
    const recorded = sanitizeFlightMetadata({
      path,
      content: OPAQUE_VALUE,
    }) as Record<string, unknown>;
    expect(recorded.content).toBe(EXCLUDED);
  });

  // A false positive blanks every sibling field, destroying the record.
  it.each(cases.must_keep)('leaves %s alone', path => {
    expect(isExcludedFlightPath(path)).toBe(false);
  });
});

// --- the one deliberate hole in the blanking sweep -------------------------

const SAFE = cases.safe_metadata_fields;
const EXCLUDED_FILE = cases.must_exclude[0];

const record = (field: string, value: unknown) =>
  sanitizeFlightMetadata({
    path: EXCLUDED_FILE,
    [field]: value,
  }) as Record<string, unknown>;

describe('file metadata that survives next to an excluded path', () => {
  // These describe the file rather than reveal it, so they ride along.
  it.each(SAFE.numeric)('keeps the numeric field %s', field => {
    expect(record(field, 12)[field]).toBe(12);
  });

  it.each(SAFE.text)('keeps the text field %s', field => {
    expect(record(field, 'text/plain')[field]).toBe('text/plain');
  });

  // The allowlist is the whole hole: everything else is still blanked.
  it.each(['content', 'body', 'text', 'data', 'lines'])(
    'still blanks %s',
    field => {
      expect(record(field, OPAQUE_VALUE)[field]).toBe(EXCLUDED);
    },
  );

  /**
   * A runtime's idea of string length is not a byte budget. `.length` counts
   * UTF-16 code units and Python's `len()` counts code points, so an astral
   * string sits on opposite sides of the same numeric limit in the two
   * runtimes. Measured before this test existed: Python kept a 200-emoji
   * `mime` value verbatim next to an excluded credential path while
   * TypeScript blanked it. The Cyrillic case overruns the budget by byte
   * while fitting both runtimes' native length, so it was kept by both.
   */
  describe.each([
    ['astral', '\u{1F600}'.repeat(200)],
    ['cyrillic', '\u044f'.repeat(200)],
  ])('a %s value over the byte budget', (_label, value) => {
    it('overruns the budget by byte, not by code point', () => {
      expect(Array.from(value).length).toBeLessThanOrEqual(SAFE.maxTextBytes);
      expect(Buffer.byteLength(value, 'utf8')).toBeGreaterThan(
        SAFE.maxTextBytes,
      );
    });

    it.each(SAFE.text)('is blanked in %s', field => {
      expect(record(field, value)[field]).toBe(EXCLUDED);
    });
  });

  it.each(SAFE.text)('keeps %s when it fits the byte budget', field => {
    const value = 'a'.repeat(SAFE.maxTextBytes);
    expect(record(field, value)[field]).toBe(value);
  });
});

/**
 * Pin the data, not just the behaviour. Every other test here is parametrized
 * over the contract, so quietly dropping a name from it would shrink the suite
 * instead of failing it.
 */
describe('the allowlist itself', () => {
  it('is what both runtimes implement', () => {
    expect([...SAFE.numeric].sort()).toEqual(['length', 'size']);
    expect([...SAFE.text].sort()).toEqual([
      'extension',
      'language',
      'mime',
      'mimetype',
    ]);
    expect(SAFE.maxTextBytes).toBe(256);
  });
});

/**
 * Deeply nested data that holds no excluded path anywhere.
 *
 * Classifying a value as "hides an excluded file locator" requires walking it,
 * and the walk gives up past a depth budget and fails closed. That guard is
 * only meaningful for containers: a leaf has no keys, so the answer is exact
 * at any depth. If the guard is consulted before that is noticed, two
 * structures of identical shape are classified differently purely because one
 * ends in a string and the other ends in a number.
 */
describe('deep nesting with no excluded path in it', () => {
  const DEPTH = cases.depth_guard;
  const LEAVES: Array<[string, unknown]> = [
    ['boolean', true],
    ['null', null],
    ['number', 42],
    ['string', 'leaf'],
  ];

  const chain = (depth: number, leaf: unknown): unknown => {
    let node: unknown = leaf;
    for (let i = 0; i < depth; i += 1) node = { n: node };
    return node;
  };

  /** How many levels survive, and what sits at the bottom. */
  const nest = (node: unknown): [number, unknown] => {
    let levels = 0;
    for (;;) {
      if (
        node !== null &&
        typeof node === 'object' &&
        !Array.isArray(node) &&
        Object.keys(node as object).length === 1 &&
        Object.keys(node as object)[0] === 'n'
      ) {
        node = (node as { n: unknown }).n;
      } else if (Array.isArray(node) && node.length === 1) {
        node = node[0];
      } else {
        return [levels, node];
      }
      levels += 1;
    }
  };

  it('consults the depth guard only for containers', () => {
    expect(DEPTH.maxTraversalDepth).toBe(16);
    expect(DEPTH.nonContainerIsNeverAContainerOfLocators).toBe(true);
  });

  describe.each(LEAVES)('ending in a %s', (_name, leaf) => {
    it('is not decided by the leaf type', () => {
      const depth = DEPTH.maxTraversalDepth + 1;
      const reference = sanitizeFlightMetadata({ deep: chain(depth, 'leaf') });
      const recorded = sanitizeFlightMetadata({ deep: chain(depth, leaf) });
      expect(nest(recorded.deep)[0]).toBe(nest(reference.deep)[0]);
    });

    it('survives within the depth budget', () => {
      const depth = DEPTH.maxTraversalDepth;
      const recorded = sanitizeFlightMetadata({ deep: chain(depth, leaf) });
      expect(nest(recorded.deep)).toEqual([depth, leaf]);
    });

    it('is not mistaken for a path when nested in arrays', () => {
      let node: unknown = leaf;
      for (let i = 0; i < DEPTH.maxTraversalDepth; i += 1) node = [node];
      const recorded = sanitizeFlightMetadata({ top: node });
      expect(recorded.top).not.toBe(EXCLUDED);
      expect(nest(recorded.top)).toEqual([DEPTH.maxTraversalDepth, leaf]);
    });

    it('never grows an excluded-path marker when shallow', () => {
      const recorded = sanitizeFlightMetadata({ deep: chain(8, leaf) });
      expect(JSON.stringify(recorded)).not.toContain(EXCLUDED);
    });
  });

  // The guard must keep working: this is what the depth budget protects.
  it.each([1, 5, 16, 17, 20])(
    'still catches a real excluded path nested %i deep',
    (depth) => {
      let node: unknown = {
        path: cases.must_exclude[0],
        content: 'TOPSECRET',
      };
      for (let i = 0; i < depth; i += 1) node = { n: node };
      const recorded = sanitizeFlightMetadata({
        wrap: node,
        sib: OPAQUE_VALUE,
      });
      expect(JSON.stringify(recorded)).not.toContain('TOPSECRET');
      expect(recorded.sib).toBe(EXCLUDED);
    },
  );
});

describe('the edges of the depth budget', () => {
  const DEPTH = cases.depth_guard;

  /**
   * Pins the far edge of the budget, which is what makes the number real.
   * Beyond it the recorder cannot prove the data is clean, so it fails closed
   * and replaces it -- the deliberate cost of a bounded walk.
   */
  it.each([
    ['boolean', true],
    ['null', null],
    ['number', 42],
    ['string', 'leaf'],
  ])('gives up one level past the budget ending in a %s', (_name, leaf) => {
    let node: unknown = leaf;
    for (let i = 0; i < DEPTH.maxTraversalDepth + 1; i += 1) node = { n: node };
    expect(sanitizeFlightMetadata({ deep: node }).deep).toBe(EXCLUDED);
  });

  // A value already being walked cannot introduce a locator it did not have.
  it('does not mistake a cycle for a hidden path', () => {
    const node: Record<string, unknown> = { x: 1 };
    node.self = node;
    const recorded = sanitizeFlightMetadata({ top: node });
    expect((recorded.top as Record<string, unknown>).x).toBe(1);
  });
});
