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
