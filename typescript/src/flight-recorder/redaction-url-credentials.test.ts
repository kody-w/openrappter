import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
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

/**
 * Bare tokens, with no field name to give them away.
 *
 * The key-based rules only fire when the surrounding field is called something
 * like `apiKey`. A token quoted inside a longer recorded string has no such
 * field, so the value patterns are all that stand between it and the ledger.
 * They covered GitHub, AWS and `Bearer …` — and nothing else, while this
 * repository reads keys for OpenAI, Anthropic, Google, Slack, Telegram,
 * Discord and Tailscale.
 *
 * Every value here is assembled at runtime. A credential-shaped *literal* in
 * this file would be flagged by the R9 credential scan, correctly — which is
 * how the first version of the previous test in this file failed CI.
 */
describe('flight recorder redaction of bare provider tokens', () => {
  const shapes: Array<[string, string]> = [
    ['OpenAI', 'sk-' + 'E'.repeat(32)],
    ['OpenAI project', 'sk-proj-' + 'F'.repeat(32)],
    ['Anthropic', 'sk-ant-api03-' + 'G'.repeat(32)],
    ['Google', 'AIza' + 'H'.repeat(35)],
    ['Slack bot', 'xox' + 'b-111111111111-' + 'I'.repeat(24)],
    ['Slack app', 'xa' + 'pp-1-A11111111-' + 'J'.repeat(24)],
    ['Telegram bot', '1234567890:AA' + 'K'.repeat(33)],
    ['Tailscale', 'tskey-auth-' + 'N'.repeat(24)],
    ['JWT', 'eyJ' + 'hbGciOiJIUzI1NiJ9.' + 'P'.repeat(20) + '.' + 'Q'.repeat(20)],
    ['GitHub', 'ghp_' + 'A'.repeat(36)],
    ['AWS access key id', 'AKIA' + 'C'.repeat(16)],
  ];

  for (const [name, value] of shapes) {
    it(`redacts a ${name} token`, () => {
      expect(sanitizeFlightValue(value)).toBe('[redacted]');
    });
  }

  it('leaves ordinary text alone', () => {
    // The cost of over-redaction is a ledger you cannot read. These are the
    // near misses: right prefix, wrong length.
    for (const text of [
      'the build finished in 20 seconds',
      'sk-short',
      'AIzaShort',
      'xoxb-1',
      'commit 1234567890 was reverted',
      'version 1.13.0 released',
    ]) {
      expect(sanitizeFlightValue(text), text).toBe(text);
    }
  });

  it('knows about every credential env var this repository reads', () => {
    // The shape list is only useful while it tracks what the product handles.
    // Scanning the source means a new provider's key cannot be added without
    // someone deciding whether the redactor knows what its token looks like.
    const srcRoot = path.join(here, '..');
    const found = new Set<string>();
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== 'node_modules') walk(full);
        } else if (entry.name.endsWith('.ts') && !entry.name.includes('.test.')) {
          const text = readFileSync(full, 'utf8');
          for (const m of text.matchAll(/process\.env\.([A-Z_]*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)[A-Z_]*)/g)) {
            found.add(m[1]);
          }
        }
      }
    };
    walk(srcRoot);

    // Every credential env var, and what the redactor does about it.
    const reviewed = new Set([
      // Shape is matched by SECRET_VALUE_PATTERNS.
      'ANTHROPIC_API_KEY',        // sk-ant-…
      'OPENAI_API_KEY',           // sk-… / sk-proj-…
      'GEMINI_API_KEY',           // AIza…
      'SLACK_BOT_TOKEN',          // xoxb-…
      'SLACK_APP_TOKEN',          // xapp-…
      'TELEGRAM_BOT_TOKEN',       // digits:AA…
      'COPILOT_GITHUB_TOKEN',     // gh?_…
      'GH_TOKEN',
      'GITHUB_TOKEN',

      // No safely matchable shape. Twilio auth tokens are 32 hex characters,
      // which is also what an MD5 digest looks like, and Discord/ElevenLabs/
      // Retell tokens are opaque strings with no distinctive prefix. Matching
      // them would blank ordinary hashes and ids all over the ledger, so these
      // rely on the key-based rules instead — which cover them whenever the
      // value sits in a field named for what it is.
      'TWILIO_AUTH_TOKEN',
      'DISCORD_BOT_TOKEN',
      'ELEVENLABS_API_KEY',
      'RETELL_API_KEY',

      // Not third-party credentials: the gateway's own bearer and the flight
      // recorder's id-hashing salt.
      'OPENRAPPTER_TOKEN',
      'OPENRAPPTER_FLIGHT_ID_KEY',
      'TEST_TOKEN',
    ]);

    // Anti-vacuity: a walk that found nothing would make this pass silently.
    expect(found.size).toBeGreaterThanOrEqual(10);

    const unreviewed = [...found].filter((name) => !reviewed.has(name)).sort();
    expect(
      unreviewed,
      'a new credential env var appeared; does the redactor know its token shape?',
    ).toEqual([]);
  });
});

/**
 * What the key rules deliberately do *not* redact.
 *
 * `isSensitiveKey` splits a field name into words and fires on `token`,
 * `secret`, `password…`, `credential…`, `cookie…`, `authorization`, plus a few
 * compounds. It does not fire on `key`, `auth`, `salt`, `nonce` or `bearer`.
 *
 * That looks like a gap and is not one. `key` is one of the most common field
 * names there is — map entries, config entries, cache entries, sort keys — and
 * redacting it would blank most of a ledger whose whole purpose is to be read
 * afterwards. `salt` and `nonce` are not secrets. `bearer` appears in this
 * codebase only as a local variable holding a header value, never as a
 * recorded field.
 *
 * This is written down because the instinct on seeing the list is to add those
 * words, and the damage from doing so is invisible: nothing fails, the ledger
 * just quietly stops saying anything. I had that instinct while auditing it.
 */
describe('flight recorder redaction is deliberately conservative', () => {
  const value = 'zzzz0000zzzz0000zzzz';

  it('does not redact generic field names that are usually not secrets', () => {
    for (const name of ['key', 'auth', 'salt', 'nonce', 'id', 'name', 'path']) {
      const out = sanitizeFlightValue({ [name]: value }) as Record<string, unknown>;
      expect(out[name], `${name} should stay readable`).toBe(value);
    }
  });

  it('still redacts the compound names those words appear in', () => {
    // The conservatism is about the bare word, not the concept: a field that
    // says what it holds is still redacted.
    for (const name of ['apiKey', 'privateKey', 'identityKey', 'authToken', 'sessionToken']) {
      const out = sanitizeFlightValue({ [name]: value }) as Record<string, unknown>;
      expect(out[name], `${name} should be redacted`).toBe('[redacted]');
    }
  });

  it('redacts a client secret through the excluded-path rules', () => {
    // Not via [redacted] — `client_secret` matches DEFAULT_EXCLUDED_PATH_PATTERNS,
    // so the whole entry is replaced. Worth pinning: a reader checking only for
    // '[redacted]' would conclude this leaks, which is what I first concluded.
    const out = sanitizeFlightValue({ clientSecret: value }) as Record<string, unknown>;
    expect(Object.values(out)).not.toContain(value);
  });
});
