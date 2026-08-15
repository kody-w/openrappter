import { beforeEach, describe, expect, it, vi } from 'vitest';

const { fetchGuardedMock } = vi.hoisted(() => ({
  fetchGuardedMock: vi.fn(),
}));

vi.mock('../net/url-guard.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../net/url-guard.js')>();
  return {
    ...actual,
    fetchGuarded: fetchGuardedMock,
  };
});

import { MediaProcessor } from './processor.js';

beforeEach(() => {
  fetchGuardedMock.mockReset();
  fetchGuardedMock.mockImplementation(
    async (
      url: string,
      _init: RequestInit | undefined,
      _hostLookup: unknown,
      assertUrl: (target: string) => void,
    ) => {
      // The real guarded fetch runs this before every hop. Calling it here
      // keeps the test in processUrl without touching DNS or the network.
      assertUrl(url);
      return new Response('ok', {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      });
    },
  );
});

describe('MediaProcessor domain policy boundaries', () => {
  it.each([
    'https://example.com/media',
    'https://cdn.example.com/media',
  ])('allows the configured domain and a real subdomain: %s', async (url) => {
    await expect(
      new MediaProcessor({ allowedDomains: ['example.com'] }).processUrl(url),
    ).resolves.toMatchObject({ type: 'document' });
  });

  it('does not let a hyphenated lookalike satisfy the allowlist', async () => {
    await expect(
      new MediaProcessor({ allowedDomains: ['example.com'] }).processUrl(
        'https://evil-example.com/media',
      ),
    ).rejects.toThrow(/not in allowed list/i);
  });

  it('normalizes case, whitespace, a leading dot, and a trailing DNS dot', async () => {
    await expect(
      new MediaProcessor({ allowedDomains: [' .EXAMPLE.COM. '] }).processUrl(
        'https://cdn.example.com./media',
      ),
    ).resolves.toMatchObject({ type: 'document' });
  });

  it('does not treat an empty allowlist entry as a wildcard', async () => {
    await expect(
      new MediaProcessor({ allowedDomains: [''] }).processUrl(
        'https://example.com/media',
      ),
    ).rejects.toThrow(/not in allowed list/i);
  });

  it.each([
    'https://example.com/media',
    'https://cdn.example.com/media',
  ])('blocks the configured domain and a real subdomain: %s', async (url) => {
    await expect(
      new MediaProcessor({ blockedDomains: ['example.com'] }).processUrl(url),
    ).rejects.toThrow(/blocked/i);
  });

  it('does not over-block a hyphenated lookalike', async () => {
    await expect(
      new MediaProcessor({ blockedDomains: ['example.com'] }).processUrl(
        'https://evil-example.com/media',
      ),
    ).resolves.toMatchObject({ type: 'document' });
  });
});
