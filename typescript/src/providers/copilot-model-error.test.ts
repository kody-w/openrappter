import { afterEach, describe, expect, it, vi } from 'vitest';
import { CopilotProvider } from './copilot.js';

function provider() {
  return new CopilotProvider({
    githubToken: 'mock-github-token',
    tokenResolver: async () => ({
      token: 'mock-api-token',
      expiresAt: Date.now() + 60 * 60_000,
      source: 'test',
      baseUrl: 'https://api.example',
    }),
    clearTokenCache: () => undefined,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Copilot model_not_supported handling', () => {
  it('refreshes once and retries with a verified replacement', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: {
          code: 'model_not_supported',
          message: 'private-token-bearing-body mock-api-token',
        },
      }), { status: 400 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'completion',
        model: 'supported-model',
        choices: [{
          message: { role: 'assistant', content: 'safe answer' },
          finish_reason: 'stop',
        }],
      }), { status: 200 }));
    vi.stubGlobal('fetch', fetchImpl);
    const instance = provider();
    const refresh = vi.fn(async () => 'supported-model');
    instance.setModelNotSupportedHandler(refresh);

    await expect(instance.chat(
      [{ role: 'user', content: 'hello' }],
      { model: 'unsupported-model' },
    )).resolves.toMatchObject({ content: 'safe answer' });
    expect(refresh).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('returns a typed redacted error when explicit selection is required', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      error: {
        code: 'model_not_supported',
        message: 'do-not-display mock-api-token',
      },
    }), { status: 400 })));
    const instance = provider();
    instance.setModelNotSupportedHandler(async () => null);

    const request = instance.chat(
      [{ role: 'user', content: 'hello' }],
      { model: 'unsupported-model' },
    );
    await expect(request).rejects.toMatchObject({
      name: 'CopilotModelNotSupportedError',
      model: 'unsupported-model',
    });
    await request.catch((error) => {
      expect((error as Error).message).not.toContain('mock-api-token');
      expect((error as Error).message).not.toContain('model_not_supported');
    });
  });

  it('cancels an in-flight request when model selection changes', async () => {
    const fetchImpl = vi.fn((_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('cancelled', 'AbortError'));
        }, { once: true });
      })
    );
    vi.stubGlobal('fetch', fetchImpl);
    const instance = provider();
    const pending = instance.chat(
      [{ role: 'user', content: 'hello' }],
      { model: 'old-model' },
    );
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce());
    instance.cancelPendingRequests();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });
});
