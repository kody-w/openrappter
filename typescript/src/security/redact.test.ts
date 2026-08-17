import { describe, it, expect } from 'vitest';
import { redactSecrets, redactSecretsInText, TOO_DEEP } from './redact.js';

const secret = (tag: string): string => ['S3CR3T', tag, 'v1'].join('-');

describe('redactSecrets beyond a string value', () => {
  it('covers an object held under a secret name', () => {
    const value = secret('obj');
    const out = redactSecrets({ apiKey: { raw: value } });
    expect(JSON.stringify(out)).not.toContain(value);
  });

  it('covers an array held under a secret name', () => {
    const value = secret('arr');
    const out = redactSecrets({ apiKey: [value] });
    expect(JSON.stringify(out)).not.toContain(value);
  });

  it('covers a non-string scalar held under a secret name', () => {
    const out = redactSecrets({ apiKey: 1234567890 }) as Record<string, unknown>;
    expect(out.apiKey).toBe('***REDACTED***');
  });

  it('leaves an absent or empty secret alone rather than inventing one', () => {
    const out = redactSecrets({
      apiKey: '', token: undefined, password: null,
    }) as Record<string, unknown>;
    expect(out.apiKey).toBe('');
    expect(out.token).toBeUndefined();
    expect(out.password).toBeNull();
  });
});

describe('the depth limit', () => {
  it('does not pass through a structure it never inspected', () => {
    const value = secret('deep');
    let node: Record<string, unknown> = { apiKey: value };
    for (let i = 0; i < 12; i++) node = { child: node };

    expect(JSON.stringify(redactSecrets(node))).not.toContain(value);
  });

  it('marks where it stopped instead of dropping the structure silently', () => {
    let node: Record<string, unknown> = { leaf: 1 };
    for (let i = 0; i < 12; i++) node = { child: node };

    expect(JSON.stringify(redactSecrets(node))).toContain(TOO_DEEP);
  });

  it('still redacts everything within reach', () => {
    const value = secret('shallow');
    let node: Record<string, unknown> = { apiKey: value };
    for (let i = 0; i < 8; i++) node = { child: node };

    const blob = JSON.stringify(redactSecrets(node));
    expect(blob).not.toContain(value);
    expect(blob).not.toContain(TOO_DEEP);
  });
});

describe('redactSecretsInText — the same judgement applied to a log line', () => {
  it('blanks a secret assigned inside free text', () => {
    const value = secret('line');
    const out = redactSecretsInText(`auth failed apiKey=${value} status=401`);
    expect(out).not.toContain(value);
    expect(out).toContain('status=401');
  });

  it('blanks the token after an auth scheme, not just the scheme word', () => {
    const value = secret('bearer');
    expect(redactSecretsInText(`Authorization: Bearer ${value}`)).not.toContain(value);
  });

  it('blanks a secret in a quoted pair a JSON parse never reached', () => {
    const value = secret('quoted');
    expect(redactSecretsInText(`{"token":"${value}"}`)).not.toContain(value);
  });

  it('leaves fields that merely look secret alone', () => {
    expect(redactSecretsInText('keyCount=3 monkey=curious keyword=key'))
      .toBe('keyCount=3 monkey=curious keyword=key');
  });

  it('leaves text with no assignment in it untouched', () => {
    expect(redactSecretsInText('Gateway server started on 127.0.0.1:1234'))
      .toBe('Gateway server started on 127.0.0.1:1234');
  });
});
