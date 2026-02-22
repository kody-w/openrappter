import { describe, it, expect, vi, afterEach } from 'vitest';
import { validateTelegramToken } from '../../copilot-check.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('validateTelegramToken', () => {
  it('should return valid for a correct token', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ ok: true, result: { username: 'testbot' } }),
    });

    const result = await validateTelegramToken('123456:ABC-DEF');
    expect(result.valid).toBe(true);
    expect(result.username).toBe('testbot');
  });

  it('should return invalid for a bad token', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ ok: false, description: 'Unauthorized' }),
    });

    const result = await validateTelegramToken('bad-token');
    expect(result.valid).toBe(false);
    expect(result.error).toBe('Unauthorized');
  });

  it('should handle network errors', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network unreachable'));

    const result = await validateTelegramToken('123456:ABC-DEF');
    expect(result.valid).toBe(false);
    expect(result.error).toBe('Network unreachable');
  });

  it('should return invalid with default error if no description', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ ok: false }),
    });

    const result = await validateTelegramToken('123456:ABC-DEF');
    expect(result.valid).toBe(false);
    expect(result.error).toBe('Invalid token');
  });
});
