import { afterEach, describe, expect, it, vi } from 'vitest';
import { CopilotProvider } from './copilot.js';
import type { ResolvedCopilotToken } from './copilot-token.js';

const token = (value: string): ResolvedCopilotToken => ({
  token: value,
  expiresAt: Date.now() + 60 * 60_000,
  source: 'test',
  baseUrl: 'https://api.test.invalid',
});

describe('CopilotProvider credential refresh', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('refreshes a rejected short-lived token once and returns only the successful answer', async () => {
    const tokenResolver = vi.fn()
      .mockResolvedValueOnce(token('expired-api-token'))
      .mockResolvedValueOnce(token('refreshed-api-token'));
    const clearTokenCache = vi.fn();
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'completion-1',
        model: 'gpt-test',
        choices: [{
          message: { role: 'assistant', content: 'verified answer' },
          finish_reason: 'stop',
        }],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));
    vi.stubGlobal('fetch', fetchImpl);
    const provider = new CopilotProvider({
      githubToken: 'mock-github-token',
      tokenResolver,
      clearTokenCache,
    });

    await expect(provider.chat([{ role: 'user', content: 'hello' }]))
      .resolves.toMatchObject({ content: 'verified answer' });
    expect(tokenResolver).toHaveBeenCalledTimes(2);
    expect(clearTokenCache).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
