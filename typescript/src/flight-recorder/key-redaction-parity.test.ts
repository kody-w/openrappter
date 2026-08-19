/**
 * Both runtimes' flight recorders must redact the same field names.
 *
 * The question here is deliberately narrow: given a key, does its *name* say the
 * value must never be recorded? Its sibling `value-redaction-parity.test.ts`
 * asks whether a value *looks* like a secret. Either check alone leaves a hole,
 * and this was the open one — an opaque random string, which is what most API
 * keys and session keys actually are, matches no value pattern at all and can
 * only be caught by its key.
 *
 * Measured before this test existed, both runtimes wrote 19 secret-bearing field
 * names to disk in the clear. The rules matched `token`, `secret` and
 * `authorization` as exact words while matching `password`, `credential` and
 * `cookie` as prefixes, so `secrets`, `tokens`, `clientSecrets` and `apiTokens`
 * were recorded verbatim while their singulars were redacted.
 *
 * `must_keep` matters as much as `must_redact`. The flight recorder is
 * deliberately conservative and this test is the record of that: `key`, `auth`,
 * `salt`, `nonce` and `bearer` stay readable on purpose, because a ledger that
 * redacts too much keeps the record and loses the ability to read it.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { sanitizeFlightMetadata } from './redaction.js';

const CORPUS = resolve(__dirname, '../../../contracts/key-redaction-corpus.json');
const cases = JSON.parse(readFileSync(CORPUS, 'utf8')) as {
  must_redact: string[];
  must_keep: string[];
  counts: string[];
};

/** Matches no SECRET_VALUE_PATTERN, so only the key's name can save it. */
const OPAQUE = 'a7Fq2Xm9Lp4Rt8Wz';

function recorded(key: string, value: unknown = OPAQUE): unknown {
  return (sanitizeFlightMetadata({ [key]: value }) as Record<string, unknown>)[key];
}

describe('flight-recorder key redaction', () => {
  it.each(cases.must_redact)('never writes %s to the flight log in the clear', key => {
    expect(recorded(key)).not.toBe(OPAQUE);
  });

  // Over-redaction is a real failure, not a safe default. The damage from
  // adding a word here is invisible: nothing fails, the ledger just quietly
  // stops saying anything.
  it.each(cases.must_keep)('leaves %s readable', key => {
    expect(recorded(key)).toBe(OPAQUE);
  });

  // `token` is the one secret word that doubles as a unit of measurement.
  describe('token is also a unit', () => {
    it.each(cases.counts)('keeps %s when it carries a number', key => {
      expect(recorded(key, 120)).toBe(120);
    });

    it.each(cases.counts)('still redacts %s when it carries a string', key => {
      expect(recorded(key, OPAQUE)).not.toBe(OPAQUE);
    });
  });
});
