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
