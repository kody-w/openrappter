/**
 * Auth RPC methods — GitHub account login, switch, and removal
 *
 * Methods:
 *   auth.status    — Read the shared typed Copilot auth state
 *   auth.check     — Re-verify the active account's Copilot access
 *   auth.profiles  — List all saved GitHub auth profiles
 *   auth.active    — Get the current active profile
 *   auth.login     — Start device code flow (returns user_code + URL)
 *   auth.poll      — Poll device flow and entitlement verification
 *   auth.cancel    — Cancel a pending device code flow
 *   auth.switch    — Set a different profile as default
 *   auth.remove    — Remove a saved profile
 */

import { AuthProfileStore } from '../../auth/profiles.js';
import {
  requestDeviceCode,
  pollForAccessToken,
} from '../../providers/copilot-auth.js';
import {
  CopilotAuthUnavailableError,
  CopilotAuthStateService,
  type CopilotAuthState,
} from '../../auth/copilot-auth-state.js';

interface MethodRegistrar {
  registerMethod<P = unknown, R = unknown>(
    name: string,
    handler: (params: P, connection: unknown) => Promise<R>,
    options?: { requiresAuth?: boolean }
  ): void;
}

interface ProfileInfo {
  id: string;
  provider: string;
  type: string;
  username?: string;
  default: boolean;
  createdAt: string;
}

// In-memory map of pending device-code flows (keyed by device_code)
const pendingFlows = new Map<
  string,
  {
    deviceCode: string;
    expiresAt: number;
    intervalMs: number;
    resolved: boolean;
    controller: AbortController;
    userCode: string;
    verificationUri: string;
    persisted?: boolean;
    username?: string;
    authState?: CopilotAuthState;
  }
>();

/**
 * Fetch the GitHub username for a given access token.
 */
async function fetchGitHubUsername(token: string): Promise<string | undefined> {
  try {
    const res = await fetch('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
      },
    });
    if (!res.ok) return undefined;
    const json = (await res.json()) as { login?: string };
    return json.login;
  } catch {
    return undefined;
  }
}

export function registerAuthMethods(
  server: MethodRegistrar,
  _deps?: Record<string, unknown>
): void {
  const store = new AuthProfileStore(_deps?.dataDir as string | undefined);
  const requestDeviceCodeImpl = (
    _deps?.requestDeviceCode ?? requestDeviceCode
  ) as typeof requestDeviceCode;
  const pollForAccessTokenImpl = (
    _deps?.pollForAccessToken ?? pollForAccessToken
  ) as typeof pollForAccessToken;
  const fetchGitHubUsernameImpl = (
    _deps?.fetchGitHubUsername ?? fetchGitHubUsername
  ) as typeof fetchGitHubUsername;
  const authStateService = (
    _deps?.copilotAuthStateService ?? new CopilotAuthStateService()
  ) as CopilotAuthStateService;

  // If a profile already exists, notify the caller so the provider can use it
  const onTokenUpdate = _deps?.onAuthTokenUpdate as (
    (token: string | null) => void
  ) | undefined;
  const existingProfile = store.get('copilot');
  if (existingProfile?.token) {
    void authStateService.check(existingProfile.token, existingProfile.id)
      .then((state) => {
        if (state.status === 'ready') onTokenUpdate?.(existingProfile.token!);
      });
  } else if (store.hasPersistedState()) {
    authStateService.needsSignIn();
    onTokenUpdate?.(null);
  }

  server.registerMethod<void, CopilotAuthState>('auth.status', async () =>
    authStateService.current()
  );

  server.registerMethod<void, CopilotAuthState>('auth.check', async () => {
    const profile = store.get('copilot');
    const state = await authStateService.check(profile?.token, profile?.id);
    if (state.status === 'ready' && profile?.token) {
      onTokenUpdate?.(profile.token);
    }
    return state;
  });

  // ── auth.profiles — list all saved profiles ────────────────────────────────
  server.registerMethod<void, ProfileInfo[]>('auth.profiles', async () => {
    const profiles = store.list('copilot');
    return profiles.map((p) => ({
      id: p.id,
      provider: p.provider,
      type: p.type,
      username: p.id, // profile id IS the username
      default: !!p.default,
      createdAt: p.createdAt,
    }));
  });

  // ── auth.active — get the current default profile ─────────────────────────
  server.registerMethod<void, ProfileInfo | null>('auth.active', async () => {
    const profile = store.get('copilot');
    if (!profile) return null;
    return {
      id: profile.id,
      provider: profile.provider,
      type: profile.type,
      username: profile.id,
      default: !!profile.default,
      createdAt: profile.createdAt,
    };
  });

  // ── auth.login — start device code flow ────────────────────────────────────
  server.registerMethod<void, { userCode: string; verificationUri: string; deviceCode: string }>(
    'auth.login',
    async () => {
      const activeFlow = Array.from(pendingFlows.values()).find(
        (flow) => !flow.resolved && Date.now() <= flow.expiresAt,
      );
      if (activeFlow) {
        return {
          userCode: activeFlow.userCode,
          verificationUri: activeFlow.verificationUri,
          deviceCode: activeFlow.deviceCode,
        };
      }

      authStateService.checking();
      let device;
      try {
        device = await requestDeviceCodeImpl();
      } catch (error) {
        throw new CopilotAuthUnavailableError(
          authStateService.reportFailure(error),
        );
      }
      const expiresAt = Date.now() + device.expires_in * 1000;
      const intervalMs = Math.max(1000, device.interval * 1000);
      const controller = new AbortController();

      // Store the pending flow
      pendingFlows.set(device.device_code, {
        deviceCode: device.device_code,
        expiresAt,
        intervalMs,
        resolved: false,
        controller,
        userCode: device.user_code,
        verificationUri: device.verification_uri,
      });

      // Start polling in the background
      pollForAccessTokenImpl({
        deviceCode: device.device_code,
        intervalMs,
        expiresAt,
        signal: controller.signal,
      })
        .then(async (token) => {
          const flow = pendingFlows.get(device.device_code);
          if (!flow) return;

          // Verify entitlement before making this identity active. The token is
          // never returned over RPC and is persisted only in the existing
          // credential store.
          const username = (
            await fetchGitHubUsernameImpl(token)
          ) ?? `account-${Date.now()}`;
          if (pendingFlows.get(device.device_code) !== flow) return;
          const state = await authStateService.check(
            token,
            username,
            controller.signal,
          );
          if (pendingFlows.get(device.device_code) !== flow) return;
          flow.username = username;
          flow.authState = state;
          flow.resolved = true;

          if (state.status === 'ready') {
            store.remove('copilot', username);
            store.add({
              id: username,
              provider: 'copilot',
              type: 'device-code',
              token,
              default: true,
            });
            flow.persisted = true;
            onTokenUpdate?.(token);
          } else if (state.status === 'no-entitlement') {
            store.remove('copilot', username);
            store.add({
              id: username,
              provider: 'copilot',
              type: 'device-code',
              token,
              default: false,
            }, { autoDefault: false });
            flow.persisted = true;
          }
        })
        .catch((err) => {
          const flow = pendingFlows.get(device.device_code);
          if (flow) {
            flow.authState = authStateService.reportFailure(err);
            flow.resolved = true;
          }
        });

      return {
        userCode: device.user_code,
        verificationUri: device.verification_uri,
        deviceCode: device.device_code,
      };
    }
  );

  // ── auth.pollLogin — check if a pending login completed ────────────────────
  server.registerMethod<
    { deviceCode: string },
    {
      status: 'pending' | 'success' | 'error';
      username?: string;
      error?: string;
      auth: CopilotAuthState;
    }
  >(
    'auth.poll',
    async (params) => {
      const flow = pendingFlows.get(params.deviceCode);
      if (!flow) {
        const auth = authStateService.current();
        return { status: 'error', error: auth.message, auth };
      }

      if (!flow.resolved) {
        if (Date.now() > flow.expiresAt) {
          pendingFlows.delete(params.deviceCode);
          flow.controller.abort();
          const auth = authStateService.reportFailure(
            new Error('Device code expired'),
          );
          return { status: 'error', error: auth.message, auth };
        }
        return { status: 'pending', auth: authStateService.current() };
      }

      // Flow completed
      pendingFlows.delete(params.deviceCode);

      if (flow.authState?.status !== 'ready') {
        const auth = flow.authState ?? authStateService.current();
        return { status: 'error', error: auth.message, auth };
      }

      // Determine the username that was saved
      return {
        status: 'success',
        username: flow.username ?? 'unknown',
        auth: flow.authState,
      };
    }
  );

  // ── auth.cancel — stop a pending login flow ────────────────────────────────
  server.registerMethod<
    { deviceCode: string },
    { ok: boolean; status: 'cancelled' | 'completed' | 'missing' }
  >(
    'auth.cancel',
    async (params) => {
      const flow = pendingFlows.get(params.deviceCode);
      if (!flow) return { ok: false, status: 'missing' };
      pendingFlows.delete(params.deviceCode);
      if (flow.resolved && flow.persisted) {
        return { ok: false, status: 'completed' };
      }
      flow.controller.abort();
      authStateService.needsSignIn('COPILOT_AUTH_CANCELLED');
      return { ok: true, status: 'cancelled' };
    }
  );

  // ── auth.switch — set a profile as default ─────────────────────────────────
  server.registerMethod<{ id: string }, { ok: boolean }>(
    'auth.switch',
    async (params) => {
      const profile = store.get('copilot', params.id);
      if (!profile?.token) return { ok: false };
      const state = await authStateService.check(profile.token, profile.id);
      if (state.status !== 'ready') return { ok: false };
      const ok = store.setDefault('copilot', params.id);
      if (ok) onTokenUpdate?.(profile.token);
      return { ok };
    }
  );

  // ── auth.remove — delete a saved profile ───────────────────────────────────
  server.registerMethod<{ id: string }, { ok: boolean }>(
    'auth.remove',
    async (params) => {
      const activeProfileId = store.get('copilot')?.id;
      const ok = store.remove('copilot', params.id);
      if (ok && activeProfileId === params.id && onTokenUpdate) {
        const replacement = store.get('copilot');
        if (replacement?.token) {
          const state = await authStateService.check(
            replacement.token,
            replacement.id,
          );
          if (state.status === 'ready') onTokenUpdate(replacement.token);
        } else {
          authStateService.needsSignIn();
          onTokenUpdate(null);
        }
      }
      return { ok };
    }
  );
}
