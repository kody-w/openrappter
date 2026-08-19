/**
 * Both runtimes' flight recorders must redact the same values.
 *
 * `SECRET_VALUE_PATTERNS` exists here and in `python/openrappter/flight_recorder.py`,
 * and they had drifted: this runtime redacted `?key=`, `xox*-`, `sk-` and JWTs
 * while Python passed all four through verbatim (#287). All four in the same
 * direction, none the other way -- drift, not a deliberately smaller redactor.
 *
 * The corpus is `contracts/value-redaction-corpus.json`, read by this file and
 * by `python/tests/test_value_redaction_parity.py`, so a pattern added to one
 * list cannot silently miss the other. That is the failure mode that would
 * otherwise surface a year from now as "the Python side never caught that one".
 *
 * `must_keep` carries as much weight as `must_redact`. A ledger that blanks
 * ordinary values keeps the record and loses the ability to read it, and the
 * tight length guards in these patterns exist for exactly that reason.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { sanitizeFlightValue } from './redaction.js';

const CORPUS = resolve(__dirname, '../../../contracts/value-redaction-corpus.json');

interface Corpus {
  must_redact: string[];
  must_keep: string[];
}

function corpus(): Corpus {
  return JSON.parse(readFileSync(CORPUS, 'utf-8')) as Corpus;
}

/** The recorder changed the value, i.e. it found something to hide. */
function redacts(value: string): boolean {
  return sanitizeFlightValue(value) !== value;
}

describe('value redaction agrees with the Python runtime', () => {
  it('the corpus is substantial', () => {
    // Guard the guard: an empty corpus would make everything below pass.
    const { must_redact, must_keep } = corpus();
    expect(must_redact.length).toBeGreaterThanOrEqual(20);
    expect(must_keep.length).toBeGreaterThanOrEqual(8);
  });

  it('every secret is redacted', () => {
    const missed = corpus().must_redact.filter((v) => !redacts(v));
    expect(missed).toEqual([]);
  });

  it('no ordinary value is redacted', () => {
    // `sk-`, `Bearer`, `eyJ` and `AKIA` appear alone in the corpus on purpose:
    // each is the prefix of a real credential pattern, and a rule without a
    // length guard would blank them.
    const blanked = corpus().must_keep.filter((v) => redacts(v));
    expect(blanked).toEqual([]);
  });

  it('a short query key is not a secret', () => {
    expect(redacts('https://example.com/?key=name')).toBe(false);
    expect(redacts('https://example.com/?key=AIzaSyD-EXAMPLE-1234567890abcdef')).toBe(true);
  });
});
