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
        onAuthTokenUpdate: (token: string | null) => tokenUpdates.push(token),
      },
    );

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(tokenUpdates).toEqual(['token-first']);
    tokenUpdates.length = 0;

    await methods.get('auth.remove')?.({ id: 'first' }, {});
    expect(tokenUpdates).toEqual(['token-second']);

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
        fetchGitHubUsername: async () => 'completed-user',
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
        fetchGitHubUsername: async () => 'wrong-account',
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

  it('reuses one pending device flow instead of opening duplicate dialogs', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'openrappter-auth-dedupe-'));
    cleanup.push(dataDir);
    const methods = new Map<string, Handler>();
    const requestDeviceCode = vi.fn(async () => ({
      device_code: 'dedupe-device',
      user_code: 'ONE-FLOW',
      verification_uri: 'https://github.com/login/device',
      expires_in: 900,
      interval: 1,
    }));
    registerAuthMethods(
      {
        registerMethod(name, handler) {
          methods.set(name, handler as Handler);
        },
      },
      {
        dataDir,
        requestDeviceCode,
        pollForAccessToken: async (params: { signal?: AbortSignal }) =>
          new Promise<never>((_, reject) => {
            params.signal?.addEventListener('abort', () => reject(
              new DOMException('cancelled', 'AbortError'),
            ), { once: true });
          }),
      },
    );

    const first = await methods.get('auth.login')?.({}, {});
    const second = await methods.get('auth.login')?.({}, {});
    expect(second).toEqual(first);
    expect(requestDeviceCode).toHaveBeenCalledOnce();
    await methods.get('auth.cancel')?.({ deviceCode: 'dedupe-device' }, {});
  });
});
