/**
 * There were two answers to "is this field name a secret?", and each missed
 * what the other caught:
 *
 *     config display    token password key secret apikey api_key
 *     gateway logging   token password secret credential authorization
 *
 * So the gateway wrote `apiKey`, `privateKey`, `signingKey`, `openaiApiKey`
 * and `sessionKey` into the structured log in the clear, while `config show`
 * printed `credential`, `credentials` and `authorization` in the clear. Two
 * lists, two different holes, neither visible from the other file.
 */
import { describe, it, expect } from 'vitest';
import { isSecretKey } from './secret-keys.js';
import { redactSecrets } from '../cli/config.js';

describe('isSecretKey', () => {
  it.each([
    // Missed by the gateway logger before this existed.
    'apiKey', 'privateKey', 'signingKey', 'openaiApiKey', 'sessionKey',
    // Missed by config display before this existed.
    'credential', 'credentials', 'authorization',
    // Caught by both, and still caught.
    'githubToken', 'password', 'clientSecret', 'webhookSecret',
    // Spelling variants.
    'api_key', 'ACCESS_TOKEN', 'refresh_token', 'passphrase', 'authToken',
    'api-key', 'Cookie', 'signature',
  ])('treats %s as secret', (key) => {
    expect(isSecretKey(key)).toBe(true);
  });

  it.each([
    // The old config list matched `key` as a bare substring and redacted all
    // of these. Harmless when displaying config, but it would blank useful
    // fields now that the gateway logger shares the same answer.
    'monkey', 'keyword', 'keyboard', 'author',
    'name', 'port', 'host', 'model', 'sessionId', 'requestId', 'durationMs', 'outcome',
  ])('does not treat %s as secret', (key) => {
    expect(isSecretKey(key)).toBe(false);
  });
});

describe('redactSecrets', () => {
  it('redacts the keys config display used to print in the clear', () => {
    const redacted = redactSecrets({
      credential: 'abc',
      credentials: 'def',
      authorization: 'Bearer xyz',
    }) as Record<string, unknown>;

    expect(redacted.credential).toBe('***REDACTED***');
    expect(redacted.credentials).toBe('***REDACTED***');
    expect(redacted.authorization).toBe('***REDACTED***');
  });

  it('still redacts what it always did', () => {
    const redacted = redactSecrets({
      apiKey: 'abc', password: 'p', gateway: { token: 't' },
    }) as Record<string, unknown>;

    expect(redacted.apiKey).toBe('***REDACTED***');
    expect(redacted.password).toBe('***REDACTED***');
    expect((redacted.gateway as Record<string, unknown>).token).toBe('***REDACTED***');
  });

  it('leaves ordinary configuration readable', () => {
    // Without this, redacting everything would satisfy the tests above and
    // make `config show` useless.
    const redacted = redactSecrets({
      gateway: { port: 18790, host: '127.0.0.1' },
      agent: { model: 'gpt-4o' },
    }) as Record<string, Record<string, unknown>>;

    expect(redacted.gateway.port).toBe(18790);
    expect(redacted.gateway.host).toBe('127.0.0.1');
    expect(redacted.agent.model).toBe('gpt-4o');
  });
});
