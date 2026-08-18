import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { sanitizeFlightValue } from './redaction.js';

/**
 * A credential in a query string is still a credential.
 *
 * `sanitizeFlightValue` scans recorded values for embedded secrets, and it
 * already caught `?token=`, `?api_key=`, `?access_token=` and
 * `https://user:pass@host`. It did not catch `?key=`, which is the parameter
 * name Google uses — and which the shipped Gemini provider builds:
 *
 *     `…/models/${model}:generateContent?key=${apiKey}`
 *
 * so a recorded value carrying that URL wrote the API key into the ledger
 * verbatim. `?sig=` had the same hole, which is how Azure signs a blob URL.
 */

const here = path.dirname(fileURLToPath(import.meta.url));

describe('flight recorder redaction of credentials in URLs', () => {
  it('redacts a Google-style key parameter', () => {
    const url =
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-pro'
      + ':generateContent?key=EXAMPLE-NOT-A-REAL-VALUE-000000';
    expect(sanitizeFlightValue(url)).toBe('[redacted]');
  });

  it('redacts signature parameters', () => {
    for (const url of [
      'https://blob.example.net/container/file?sig=abcdef1234567890XYZ',
      'https://api.example.com/v1?signature=abcdef1234567890XYZ',
    ]) {
      expect(sanitizeFlightValue(url), url).toBe('[redacted]');
    }
  });

  it('still redacts the parameter names it already knew', () => {
    // Anti-regression: the new pattern must not have replaced the old one.
    for (const url of [
      'https://api.example.com/v1?token=EXAMPLE-NOT-A-REAL-VALUE-333333',
      'https://api.example.com/v1?api_key=EXAMPLE-NOT-A-REAL-VALUE-222222',
      'https://api.example.com/v1?access_token=EXAMPLE-NOT-A-REAL-VALUE-111111',
      'https://user:not-a-real-password@api.example.com/v1',
    ]) {
      expect(sanitizeFlightValue(url), url).toBe('[redacted]');
    }
  });

  it('leaves an ordinary short key parameter alone', () => {
    // Over-redaction has a cost too: a recorder that blanks everything tells
    // you nothing. `key` is a common non-secret parameter name.
    for (const url of [
      'https://api.example.com/items?key=name',
      'https://api.example.com/docs?key=id',
      'https://api.example.com/x?sig=v2',
    ]) {
      expect(sanitizeFlightValue(url), url).toBe(url);
    }
  });

  it('covers the parameter the Gemini provider actually builds', () => {
    // Pins the link between the provider and this rule: if that URL shape
    // changes, this test should be revisited rather than quietly passing.
    const provider = readFileSync(
      path.join(here, '..', 'providers', 'gemini.ts'),
      'utf8',
    );
    expect(provider).toMatch(/\?key=\$\{apiKey\}/);
  });
});
