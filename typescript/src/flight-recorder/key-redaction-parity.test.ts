/**
 * Both runtimes' flight recorders must redact the same field names.
 *
 * The question this file asks is deliberately narrow: given a key, does its
 * *name* say the value must never be recorded? Its sibling
 * `value-redaction-parity.test.ts` asks whether a value *looks* like a secret.
 * Either check alone leaves a hole, and this was the open one — an opaque
 * random string, which is what most API keys and session keys actually are,
 * matches no value pattern at all and can only be caught by its key.
 *
 * Measured before this test existed, the flight recorder wrote 19 secret-bearing
 * field names to disk in the clear, in both runtimes, including `secrets`,
 * `tokens`, `auth`, `bearer`, `jwt`, `sshKey` and `sessionKey`. The cause was a
 * fourth private copy of rules that `security/secret-keys.ts` already exists to
 * be the single answer to — a module whose own docstring records that this
 * project keeps growing separate copies of this list and that each one misses
 * what the others catch.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { sanitizeFlightMetadata } from './redaction.js';
import { isSecretKey } from '../security/secret-keys.js';

const CORPUS = resolve(__dirname, '../../../contracts/key-redaction-corpus.json');
const cases = JSON.parse(readFileSync(CORPUS, 'utf8')) as {
  must_redact: string[];
  must_keep: string[];
};

/** Matches no SECRET_VALUE_PATTERN, so only the key's name can save it. */
const OPAQUE = 'a7Fq2Xm9Lp4Rt8Wz';

function recorded(key: string): unknown {
  return (sanitizeFlightMetadata({ [key]: OPAQUE }) as Record<string, unknown>)[key];
}

describe('flight-recorder key redaction', () => {
  it.each(cases.must_redact)('never writes %s to the flight log in the clear', key => {
    expect(recorded(key)).not.toBe(OPAQUE);
  });

  // A ledger that blanks ordinary fields keeps the record and loses the ability
  // to read it, so over-redaction is a real failure and not a safe default.
  it.each(cases.must_keep)('leaves %s readable', key => {
    expect(recorded(key)).toBe(OPAQUE);
  });

  /**
   * The structural guard, and the reason this class of bug is now closed.
   *
   * Any private list will drift from the shared one eventually; the fix that
   * lasts is making drift a test failure rather than trusting the next person
   * to notice. This asserts containment rather than equality, because the
   * flight recorder legitimately redacts more (prototype-pollution keys, and
   * whatever the operator names in `privacy.redactedKeys`).
   */
  it('redacts everything the canonical module calls secret', () => {
    const missed = [...cases.must_redact, ...cases.must_keep].filter(
      key => isSecretKey(key) && recorded(key) === OPAQUE,
    );
    expect(missed).toEqual([]);
  });
});
