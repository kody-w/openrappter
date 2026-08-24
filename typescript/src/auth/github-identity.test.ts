import { describe, expect, it, vi } from 'vitest';
import { resolveVerifiedGitHubIdentity } from './github-identity.js';

function response(options: {
  ok?: boolean;
  status?: number;
  url?: string;
  body?: unknown;
}): Response {
  return {
    ok: options.ok ?? true,
    status: options.status ?? 200,
    url: options.url ?? 'https://api.github.com/user',
    json: async () => options.body ?? { id: 42, login: 'octocat' },
  } as Response;
}

describe('resolveVerifiedGitHubIdentity', () => {
  it('accepts a well-formed identity only from the exact GitHub user endpoint', async () => {
    const fetchImpl = vi.fn(async () => response({}));
    await expect(resolveVerifiedGitHubIdentity(
      'mock-token',
      fetchImpl as typeof fetch,
    )).resolves.toEqual({ id: 42, login: 'octocat' });
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.github.com/user',
      expect.objectContaining({ redirect: 'error' }),
    );
  });

  it.each([
    response({ url: 'https://api.github.com.evil.example/user' }),
    response({ body: { id: 42, login: '' } }),
    response({ body: { id: '42', login: 'octocat' } }),
    response({ body: { id: 42, login: 'bad/login' } }),
  ])('rejects an unverified or malformed identity response', async (result) => {
    await expect(resolveVerifiedGitHubIdentity(
      'mock-token',
      vi.fn(async () => result) as typeof fetch,
    )).rejects.toMatchObject({ reason: 'exchange-error' });
  });

  it('classifies identity authentication and offline failures without returning the token', async () => {
    const auth = resolveVerifiedGitHubIdentity(
      'private-auth-token',
      vi.fn(async () => response({ ok: false, status: 401 })) as typeof fetch,
    );
    await expect(auth).rejects.toMatchObject({ reason: 'http-401' });
    await auth.catch((error) => {
      expect(JSON.stringify(error)).not.toContain('private-auth-token');
    });

    await expect(resolveVerifiedGitHubIdentity(
      'private-offline-token',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      }) as typeof fetch,
    )).rejects.toMatchObject({ reason: 'offline' });
  });
});
