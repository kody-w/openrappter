import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerAuthMethods } from '../../gateway/methods/auth-methods.js';
import { CopilotAuthStateService } from '../../auth/copilot-auth-state.js';
import { CopilotTokenError } from '../../providers/copilot-token.js';

type Handler = (params: unknown, connection: unknown) => Promise<unknown>;

const cleanup: string[] = [];

afterEach(() => {
  for (const directory of cleanup.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('auth.remove live token updates', () => {
  it('publishes an explicit signed-out state from an empty persisted store', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'openrappter-auth-empty-'));
    cleanup.push(dataDir);
    writeFileSync(join(dataDir, 'auth-profiles.json'), '[]', { mode: 0o600 });
    const tokenUpdates: Array<string | null> = [];

    registerAuthMethods(
      { registerMethod() {} },
      {
        dataDir,
        onAuthTokenUpdate: (token: string | null) => tokenUpdates.push(token),
      },
    );

    expect(tokenUpdates).toEqual([null]);
  });

  it('activates the replacement profile and clears the final credential', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'openrappter-auth-methods-'));
    cleanup.push(dataDir);
    writeFileSync(
      join(dataDir, 'auth-profiles.json'),
      JSON.stringify([
        {
          id: 'first',
          provider: 'copilot',
          type: 'device-code',
          token: 'token-first',
          default: true,
          createdAt: '2026-08-15T00:00:00.000Z',
        },
        {
          id: 'second',
          provider: 'copilot',
          type: 'device-code',
          token: 'token-second',
          default: false,
          createdAt: '2026-08-15T00:00:01.000Z',
        },
      ]),
      { mode: 0o600 },
    );

    const methods = new Map<string, Handler>();
    const tokenUpdates: Array<string | null> = [];
    registerAuthMethods(
      {
        registerMethod(name, handler) {
          methods.set(name, handler as Handler);
        },
      },
      {
        dataDir,
        copilotAuthStateService: new CopilotAuthStateService(async () => undefined),
        resolveGitHubIdentity: async (token: string) => ({
          id: token === 'token-first' ? 1 : 2,
          login: token === 'token-first' ? 'first' : 'second',
        }),
        onAuthTokenUpdate: (token: string | null) => tokenUpdates.push(token),
      },
    );

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(tokenUpdates).toEqual(['token-first']);
    tokenUpdates.length = 0;

    await methods.get('auth.remove')?.({ id: 'first' }, {});
    expect(tokenUpdates).toEqual([null, 'token-second']);

    tokenUpdates.length = 0;
    await methods.get('auth.remove')?.({ id: 'second' }, {});
    expect(tokenUpdates).toEqual([null]);
  });

  it('cancels the detached device flow before it can save a profile', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'openrappter-auth-cancel-'));
    cleanup.push(dataDir);
    const methods = new Map<string, Handler>();
    const tokenUpdates: Array<string | null> = [];
    let observedSignal: AbortSignal | undefined;

    registerAuthMethods(
      {
        registerMethod(name, handler) {
          methods.set(name, handler as Handler);
        },
      },
      {
        dataDir,
        requestDeviceCode: async () => ({
          device_code: 'cancel-device',
          user_code: 'CANCEL-ME',
          verification_uri: 'https://github.com/login/device',
          expires_in: 900,
          interval: 1,
        }),
        pollForAccessToken: async (params: { signal?: AbortSignal }) => {
          observedSignal = params.signal;
          await new Promise<never>((_, reject) => {
            params.signal?.addEventListener(
              'abort',
              () => reject(new DOMException('cancelled', 'AbortError')),
              { once: true },
            );
          });
          throw new Error('unreachable');
        },
        onAuthTokenUpdate: (token: string | null) => tokenUpdates.push(token),
      },
    );

    await methods.get('auth.login')?.({}, {});
    const result = await methods.get('auth.cancel')?.(
      { deviceCode: 'cancel-device' },
      {},
    );
    await Promise.resolve();

    expect(result).toEqual({ ok: true, status: 'cancelled' });
    expect(observedSignal?.aborted).toBe(true);
    expect(tokenUpdates).toEqual([]);
    expect(await methods.get('auth.active')?.({}, {})).toBeNull();
  });

  it('reports completion instead of pretending a persisted login was cancelled', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'openrappter-auth-complete-'));
    cleanup.push(dataDir);
    const methods = new Map<string, Handler>();
    const tokenUpdates: Array<string | null> = [];

    registerAuthMethods(
      {
        registerMethod(name, handler) {
          methods.set(name, handler as Handler);
        },
      },
      {
        dataDir,
        requestDeviceCode: async () => ({
          device_code: 'completed-device',
          user_code: 'DONE-NOW',
          verification_uri: 'https://github.com/login/device',
          expires_in: 900,
          interval: 1,
        }),
        pollForAccessToken: async () => 'completed-token',
        resolveGitHubIdentity: async () => ({
          id: 1,
          login: 'completed-user',
        }),
        copilotAuthStateService: new CopilotAuthStateService(async () => undefined),
        onAuthTokenUpdate: (token: string | null) => tokenUpdates.push(token),
      },
    );

    await methods.get('auth.login')?.({}, {});
    await new Promise<void>((resolve) => setImmediate(resolve));
    const result = await methods.get('auth.cancel')?.(
      { deviceCode: 'completed-device' },
      {},
    );

    expect(result).toEqual({ ok: false, status: 'completed' });
    expect(await methods.get('auth.active')?.({}, {})).toMatchObject({
      id: 'completed-user',
    });
    expect(tokenUpdates).toEqual(['completed-token']);
  });

  it('keeps a wrong account inactive and reports no entitlement without returning its token', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'openrappter-auth-wrong-account-'));
    cleanup.push(dataDir);
    const methods = new Map<string, Handler>();
    const tokenUpdates: Array<string | null> = [];
    registerAuthMethods(
      {
        registerMethod(name, handler) {
          methods.set(name, handler as Handler);
        },
      },
      {
        dataDir,
        requestDeviceCode: async () => ({
          device_code: 'wrong-account-device',
          user_code: 'WRONG-ONE',
          verification_uri: 'https://github.com/login/device',
          expires_in: 900,
          interval: 1,
        }),
        pollForAccessToken: async () => 'wrong-account-secret-token',
        resolveGitHubIdentity: async () => ({
          id: 2,
          login: 'wrong-account',
        }),
        copilotAuthStateService: new CopilotAuthStateService(async () => {
          throw new CopilotTokenError('no-entitlement', 403);
        }),
        onAuthTokenUpdate: (token: string | null) => tokenUpdates.push(token),
      },
    );

    await methods.get('auth.login')?.({}, {});
    await new Promise<void>((resolve) => setImmediate(resolve));
    const result = await methods.get('auth.poll')?.(
      { deviceCode: 'wrong-account-device' },
      {},
    ) as Record<string, unknown>;

    expect(result).toMatchObject({
      status: 'error',
      auth: {
        status: 'no-entitlement',
        code: 'COPILOT_NO_ENTITLEMENT',
      },
    });
    expect(JSON.stringify(result)).not.toContain('wrong-account-secret-token');
    expect(await methods.get('auth.active')?.({}, {})).toBeNull();
    expect(await methods.get('auth.profiles')?.({}, {})).toEqual([
      expect.objectContaining({ id: 'wrong-account', default: false }),
    ]);
    expect(tokenUpdates).toEqual([]);
  });

  it('atomically reuses one pending device flow across concurrent windows', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'openrappter-auth-dedupe-'));
    cleanup.push(dataDir);
    const methods = new Map<string, Handler>();
    let releaseDevice!: () => void;
    const deviceGate = new Promise<void>((resolve) => {
      releaseDevice = resolve;
    });
    const requestDeviceCode = vi.fn(async () => {
      await deviceGate;
      return {
        device_code: 'dedupe-device',
        user_code: 'ONE-FLOW',
        verification_uri: 'https://github.com/login/device',
        expires_in: 900,
        interval: 1,
      };
    });
    const pollForAccessToken = vi.fn(
      async (params: { signal?: AbortSignal }) =>
        new Promise<never>((_, reject) => {
          params.signal?.addEventListener('abort', () => reject(
            new DOMException('cancelled', 'AbortError'),
          ), { once: true });
        }),
    );
    registerAuthMethods(
      {
        registerMethod(name, handler) {
          methods.set(name, handler as Handler);
        },
      },
      {
        dataDir,
        requestDeviceCode,
        pollForAccessToken,
      },
    );

    const pending = Promise.all([
      methods.get('auth.login')?.({}, { window: 1 }),
      methods.get('auth.login')?.({}, { window: 2 }),
    ]);
    await Promise.resolve();
    expect(requestDeviceCode).toHaveBeenCalledOnce();
    releaseDevice();
    const [first, second] = await pending;
    expect(second).toEqual(first);
    expect(requestDeviceCode).toHaveBeenCalledOnce();
    expect(pollForAccessToken).toHaveBeenCalledOnce();
    await methods.get('auth.cancel')?.({ deviceCode: 'dedupe-device' }, {});
  });

  it('clears the active runtime and leaves it clear when replacement verification fails', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'openrappter-auth-failed-replacement-'));
    cleanup.push(dataDir);
    writeFileSync(join(dataDir, 'auth-profiles.json'), JSON.stringify([
      {
        id: 'active',
        provider: 'copilot',
        type: 'device-code',
        token: 'active-token',
        default: true,
        createdAt: '2026-08-15T00:00:00.000Z',
      },
      {
        id: 'replacement',
        provider: 'copilot',
        type: 'device-code',
        token: 'rejected-token',
        default: false,
        createdAt: '2026-08-15T00:00:01.000Z',
      },
    ]), { mode: 0o600 });
    const methods = new Map<string, Handler>();
    const updates: Array<string | null> = [];
    registerAuthMethods({
      registerMethod(name, handler) {
        methods.set(name, handler as Handler);
      },
    }, {
      dataDir,
      copilotAuthStateService: new CopilotAuthStateService(async (token) => {
        if (token === 'rejected-token') {
          throw new CopilotTokenError('no-entitlement', 403);
        }
      }),
      resolveGitHubIdentity: async (token: string) => ({
        id: token === 'active-token' ? 1 : 2,
        login: token === 'active-token' ? 'active' : 'replacement',
      }),
      onAuthTokenUpdate: (token: string | null) => updates.push(token),
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    updates.length = 0;

    await methods.get('auth.remove')?.({ id: 'active' }, {});

    expect(updates).toEqual([null]);
    expect(await methods.get('auth.active')?.({}, {})).toBeNull();
  });

  it('does not reactivate a replacement removed by a concurrent request', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'openrappter-auth-concurrent-remove-'));
    cleanup.push(dataDir);
    writeFileSync(join(dataDir, 'auth-profiles.json'), JSON.stringify([
      {
        id: 'active',
        provider: 'copilot',
        type: 'device-code',
        token: 'active-token',
        default: true,
        createdAt: '2026-08-15T00:00:00.000Z',
      },
      {
        id: 'replacement',
        provider: 'copilot',
        type: 'device-code',
        token: 'replacement-token',
        default: false,
        createdAt: '2026-08-15T00:00:01.000Z',
      },
    ]), { mode: 0o600 });
    let releaseReplacement!: () => void;
    const replacementGate = new Promise<void>((resolve) => {
      releaseReplacement = resolve;
    });
    const methods = new Map<string, Handler>();
    const updates: Array<string | null> = [];
    registerAuthMethods({
      registerMethod(name, handler) {
        methods.set(name, handler as Handler);
      },
    }, {
      dataDir,
      copilotAuthStateService: new CopilotAuthStateService(async (token) => {
        if (token === 'replacement-token') await replacementGate;
      }),
      resolveGitHubIdentity: async (token: string) => ({
        id: token === 'active-token' ? 1 : 2,
        login: token === 'active-token' ? 'active' : 'replacement',
      }),
      onAuthTokenUpdate: (token: string | null) => updates.push(token),
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    updates.length = 0;

    const removeActive = methods.get('auth.remove')!({ id: 'active' }, {});
    await Promise.resolve();
    await methods.get('auth.remove')!({ id: 'replacement' }, {});
    releaseReplacement();
    await removeActive;

    expect(updates).toEqual([null]);
    expect(await methods.get('auth.active')?.({}, {})).toBeNull();
  });

  it('stores nothing when verified identity lookup repeatedly fails', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'openrappter-auth-identity-failure-'));
    cleanup.push(dataDir);
    const methods = new Map<string, Handler>();
    let attempt = 0;
    registerAuthMethods({
      registerMethod(name, handler) {
        methods.set(name, handler as Handler);
      },
    }, {
      dataDir,
      requestDeviceCode: async () => {
        attempt += 1;
        return {
          device_code: `identity-failure-${attempt}`,
          user_code: `FAIL-${attempt}`,
          verification_uri: 'https://github.com/login/device',
          expires_in: 900,
          interval: 1,
        };
      },
      pollForAccessToken: async () => `unpersisted-token-${attempt}`,
      resolveGitHubIdentity: async () => {
        throw new CopilotTokenError('offline');
      },
      copilotAuthStateService: new CopilotAuthStateService(async () => undefined),
    });

    for (let expectedAttempt = 1; expectedAttempt <= 2; expectedAttempt += 1) {
      const login = await methods.get('auth.login')!({}, {}) as {
        deviceCode: string;
      };
      await new Promise<void>((resolve) => setImmediate(resolve));
      const result = await methods.get('auth.poll')!(
        { deviceCode: login.deviceCode },
        {},
      );
      expect(result).toMatchObject({
        status: 'error',
        auth: { status: 'offline' },
      });
      expect(await methods.get('auth.profiles')!({}, {})).toEqual([]);
    }
    expect(attempt).toBe(2);
  });

  it('starts a fresh single polling loop after a completed flow is consumed', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'openrappter-auth-retry-complete-'));
    cleanup.push(dataDir);
    const methods = new Map<string, Handler>();
    let attempt = 0;
    const requestDeviceCode = vi.fn(async () => {
      attempt += 1;
      return {
        device_code: `complete-${attempt}`,
        user_code: `DONE-${attempt}`,
        verification_uri: 'https://github.com/login/device',
        expires_in: 900,
        interval: 1,
      };
    });
    const pollForAccessToken = vi.fn(async () => `token-${attempt}`);
    registerAuthMethods({
      registerMethod(name, handler) {
        methods.set(name, handler as Handler);
      },
    }, {
      dataDir,
      requestDeviceCode,
      pollForAccessToken,
      resolveGitHubIdentity: async () => ({ id: 5, login: 'octocat' }),
      copilotAuthStateService: new CopilotAuthStateService(async () => undefined),
    });

    for (let expectedAttempt = 1; expectedAttempt <= 2; expectedAttempt += 1) {
      const login = await methods.get('auth.login')!({}, {}) as {
        deviceCode: string;
      };
      await new Promise<void>((resolve) => setImmediate(resolve));
      await expect(methods.get('auth.poll')!(
        { deviceCode: login.deviceCode },
        {},
      )).resolves.toMatchObject({ status: 'success' });
    }

    expect(requestDeviceCode).toHaveBeenCalledTimes(2);
    expect(pollForAccessToken).toHaveBeenCalledTimes(2);
  });
});
