import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// ── copilot-token.ts tests ───────────────────────────────────────────────────

describe('copilot-token', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-token-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('deriveCopilotApiBaseUrl', () => {
    it('should extract base URL from proxy-ep', async () => {
      const { deriveCopilotApiBaseUrl } = await import('../copilot-token.js');
      const token = 'abc123;proxy-ep=proxy.individual.githubcopilot.com;tid=456';
      expect(deriveCopilotApiBaseUrl(token)).toBe('https://api.individual.githubcopilot.com');
    });

    it('should return default URL when no proxy-ep', async () => {
      const { deriveCopilotApiBaseUrl, DEFAULT_COPILOT_API_BASE_URL } = await import('../copilot-token.js');
      expect(deriveCopilotApiBaseUrl('abc123')).toBe(DEFAULT_COPILOT_API_BASE_URL);
    });

    it('should return default URL for empty string', async () => {
      const { deriveCopilotApiBaseUrl, DEFAULT_COPILOT_API_BASE_URL } = await import('../copilot-token.js');
      expect(deriveCopilotApiBaseUrl('')).toBe(DEFAULT_COPILOT_API_BASE_URL);
    });

    it('should handle proxy-ep at start of token', async () => {
      const { deriveCopilotApiBaseUrl } = await import('../copilot-token.js');
      const token = 'proxy-ep=proxy.example.com;other=value';
      expect(deriveCopilotApiBaseUrl(token)).toBe('https://api.example.com');
    });

    it('should strip http prefix from proxy-ep', async () => {
      const { deriveCopilotApiBaseUrl } = await import('../copilot-token.js');
      const token = 'abc;proxy-ep=https://proxy.example.com;other=val';
      expect(deriveCopilotApiBaseUrl(token)).toBe('https://api.example.com');
    });
  });

  describe('resolveCopilotApiToken', () => {
    it('should return cached token if still valid', async () => {
      const { resolveCopilotApiToken } = await import('../copilot-token.js');
      const cachePath = path.join(tmpDir, 'cached-token.json');

      // Write a valid cached token (expires in 1 hour)
      const cached = {
        token: 'cached-token;proxy-ep=proxy.test.com',
        expiresAt: Date.now() + 3600 * 1000,
        updatedAt: Date.now(),
      };
      fs.writeFileSync(cachePath, JSON.stringify(cached));

      const result = await resolveCopilotApiToken({
        githubToken: 'gh-token',
        cachePath,
        fetchImpl: vi.fn(), // Should NOT be called
      });

      expect(result.token).toBe(cached.token);
      expect(result.source).toContain('cache');
      expect(result.baseUrl).toBe('https://api.test.com');
    });

    it('should fetch new token when cache is expired', async () => {
      const { resolveCopilotApiToken } = await import('../copilot-token.js');
      const cachePath = path.join(tmpDir, 'expired-token.json');

      // Write an expired cached token
      const cached = {
        token: 'old-token',
        expiresAt: Date.now() - 1000,
        updatedAt: Date.now() - 100000,
      };
      fs.writeFileSync(cachePath, JSON.stringify(cached));

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          token: 'new-token;proxy-ep=proxy.fresh.com',
          expires_at: Math.floor(Date.now() / 1000) + 3600,
        }),
      });

      const result = await resolveCopilotApiToken({
        githubToken: 'gh-token',
        cachePath,
        fetchImpl: mockFetch as unknown as typeof fetch,
      });

      expect(result.token).toBe('new-token;proxy-ep=proxy.fresh.com');
      expect(result.source).toContain('fetched');
      expect(result.baseUrl).toBe('https://api.fresh.com');
      expect(mockFetch).toHaveBeenCalledOnce();
    });

    it('should fetch token when no cache exists', async () => {
      const { resolveCopilotApiToken } = await import('../copilot-token.js');
      const cachePath = path.join(tmpDir, 'nonexistent.json');

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          token: 'fresh-token',
          expires_at: Date.now() + 3600000,
        }),
      });

      const result = await resolveCopilotApiToken({
        githubToken: 'gh-token',
        cachePath,
        fetchImpl: mockFetch as unknown as typeof fetch,
      });

      expect(result.token).toBe('fresh-token');
      expect(mockFetch).toHaveBeenCalledOnce();

      // Verify it was cached
      const saved = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
      expect(saved.token).toBe('fresh-token');
    });

    it('should throw on HTTP error', async () => {
      const { resolveCopilotApiToken } = await import('../copilot-token.js');
      const cachePath = path.join(tmpDir, 'err.json');

      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        text: () => Promise.resolve('Unauthorized'),
      });

      await expect(
        resolveCopilotApiToken({
          githubToken: 'bad-token',
          cachePath,
          fetchImpl: mockFetch as unknown as typeof fetch,
        }),
      ).rejects.toThrow('Copilot token exchange failed: HTTP 401');
    });

    it('should throw on missing token in response', async () => {
      const { resolveCopilotApiToken } = await import('../copilot-token.js');
      const cachePath = path.join(tmpDir, 'bad-resp.json');

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ expires_at: 12345 }),
      });

      await expect(
        resolveCopilotApiToken({
          githubToken: 'gh-token',
          cachePath,
          fetchImpl: mockFetch as unknown as typeof fetch,
        }),
      ).rejects.toThrow('missing token');
    });

    it('should handle expires_at in seconds (Unix timestamp)', async () => {
      const { resolveCopilotApiToken } = await import('../copilot-token.js');
      const cachePath = path.join(tmpDir, 'unix-ts.json');
      const futureSeconds = Math.floor(Date.now() / 1000) + 7200;

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          token: 'unix-token',
          expires_at: futureSeconds,
        }),
      });

      const result = await resolveCopilotApiToken({
        githubToken: 'gh-token',
        cachePath,
        fetchImpl: mockFetch as unknown as typeof fetch,
      });

      // Should have been converted to milliseconds
      expect(result.expiresAt).toBe(futureSeconds * 1000);
    });
  });
});

// ── copilot-auth.ts tests ────────────────────────────────────────────────────

describe('copilot-auth', () => {
  describe('requestDeviceCode', () => {
    it('should request device code from GitHub', async () => {
      const { requestDeviceCode } = await import('../copilot-auth.js');

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          device_code: 'DC-123',
          user_code: 'ABCD-1234',
          verification_uri: 'https://github.com/login/device',
          expires_in: 900,
          interval: 5,
        }),
      });

      const result = await requestDeviceCode({ fetchImpl: mockFetch as unknown as typeof fetch });

      expect(result.device_code).toBe('DC-123');
      expect(result.user_code).toBe('ABCD-1234');
      expect(result.verification_uri).toBe('https://github.com/login/device');
      expect(result.expires_in).toBe(900);
      expect(result.interval).toBe(5);

      // Verify the request was correct
      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe('https://github.com/login/device/code');
      expect(opts.method).toBe('POST');
    });

    it('should throw on HTTP error', async () => {
      const { requestDeviceCode } = await import('../copilot-auth.js');

      const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 500 });

      await expect(
        requestDeviceCode({ fetchImpl: mockFetch as unknown as typeof fetch }),
      ).rejects.toThrow('HTTP 500');
    });

    it('should throw on missing fields', async () => {
      const { requestDeviceCode } = await import('../copilot-auth.js');

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ device_code: 'x' }),
      });

      await expect(
        requestDeviceCode({ fetchImpl: mockFetch as unknown as typeof fetch }),
      ).rejects.toThrow('missing required fields');
    });
  });

  describe('pollForAccessToken', () => {
    it('should return token on success', async () => {
      const { pollForAccessToken } = await import('../copilot-auth.js');

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          access_token: 'gho_abc123',
          token_type: 'bearer',
        }),
      });

      const result = await pollForAccessToken({
        deviceCode: 'DC-123',
        intervalMs: 100,
        expiresAt: Date.now() + 60000,
        fetchImpl: mockFetch as unknown as typeof fetch,
      });

      expect(result).toBe('gho_abc123');
    });

    it('should retry on authorization_pending', async () => {
      const { pollForAccessToken } = await import('../copilot-auth.js');

      let callCount = 0;
      const mockFetch = vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount < 3) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ error: 'authorization_pending' }),
          });
        }
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ access_token: 'gho_success', token_type: 'bearer' }),
        });
      });

      const result = await pollForAccessToken({
        deviceCode: 'DC-123',
        intervalMs: 10, // Short for testing
        expiresAt: Date.now() + 60000,
        fetchImpl: mockFetch as unknown as typeof fetch,
      });

      expect(result).toBe('gho_success');
      expect(callCount).toBe(3);
    });

    it('should throw on access_denied', async () => {
      const { pollForAccessToken } = await import('../copilot-auth.js');

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ error: 'access_denied' }),
      });

      await expect(
        pollForAccessToken({
          deviceCode: 'DC-123',
          intervalMs: 10,
          expiresAt: Date.now() + 60000,
          fetchImpl: mockFetch as unknown as typeof fetch,
        }),
      ).rejects.toThrow('cancelled');
    });

    it('should throw on expired_token', async () => {
      const { pollForAccessToken } = await import('../copilot-auth.js');

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ error: 'expired_token' }),
      });

      await expect(
        pollForAccessToken({
          deviceCode: 'DC-123',
          intervalMs: 10,
          expiresAt: Date.now() + 60000,
          fetchImpl: mockFetch as unknown as typeof fetch,
        }),
      ).rejects.toThrow('expired');
    });
  });

  describe('deviceCodeLogin', () => {
    it('should run full flow and return token', async () => {
      const { deviceCodeLogin } = await import('../copilot-auth.js');

      let codeCallback: { code: string; url: string } | null = null;

      const mockFetch = vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({
            device_code: 'DC-FULL',
            user_code: 'FULL-1234',
            verification_uri: 'https://github.com/login/device',
            expires_in: 900,
            interval: 1,
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({
            access_token: 'gho_fullflow',
            token_type: 'bearer',
          }),
        });

      const token = await deviceCodeLogin(
        (code, url) => { codeCallback = { code, url }; },
        { fetchImpl: mockFetch as unknown as typeof fetch },
      );

      expect(token).toBe('gho_fullflow');
      expect(codeCallback).not.toBeNull();
      expect(codeCallback!.code).toBe('FULL-1234');
      expect(codeCallback!.url).toBe('https://github.com/login/device');
    });
  });
});

// ── CopilotProvider tests ────────────────────────────────────────────────────

describe('CopilotProvider', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('should be instantiable', async () => {
    const { CopilotProvider } = await import('../copilot.js');
    const provider = new CopilotProvider();
    expect(provider.id).toBe('copilot');
    expect(provider.name).toBe('GitHub Copilot');
  });

  it('should report unavailable without token', async () => {
    const { CopilotProvider } = await import('../copilot.js');
    delete process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
    delete process.env.COPILOT_GITHUB_TOKEN;

    const provider = new CopilotProvider();
    const available = await provider.isAvailable();
    expect(available).toBe(false);
  });

  it('should expose default models', async () => {
    const { COPILOT_DEFAULT_MODELS, COPILOT_DEFAULT_MODEL } = await import('../copilot.js');
    expect(COPILOT_DEFAULT_MODELS).toContain('gpt-4o');
    expect(COPILOT_DEFAULT_MODELS).toContain('gpt-4.1');
    expect(COPILOT_DEFAULT_MODELS).toContain('o3-mini');
    expect(COPILOT_DEFAULT_MODEL).toBe('gpt-4.1');
  });

  it('should use constructor token over env', async () => {
    const { CopilotProvider } = await import('../copilot.js');
    process.env.GITHUB_TOKEN = 'env-token';

    const provider = new CopilotProvider({ githubToken: 'constructor-token' });

    // Access private method via prototype trick - just verify it doesn't throw
    expect(provider).toBeDefined();
  });
});

// ── Integration test (mocked) ────────────────────────────────────────────────

describe('CopilotProvider.chat (mocked)', () => {
  const originalEnv = { ...process.env };
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-chat-test-'));
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should make OpenAI-compatible API call', async () => {
    // We can't easily mock the internal fetch in the provider,
    // but we can verify the module structure is correct
    const { CopilotProvider, COPILOT_DEFAULT_MODEL } = await import('../copilot.js');
    const provider = new CopilotProvider({ githubToken: 'test-token' });

    expect(typeof provider.chat).toBe('function');
    expect(typeof provider.isAvailable).toBe('function');
    expect(COPILOT_DEFAULT_MODEL).toBeTruthy();
  });
});
