/**
 * Auth RPC methods — GitHub account login, switch, and removal
 *
 * Methods:
 *   auth.profiles  — List all saved GitHub auth profiles
 *   auth.active    — Get the current active profile
 *   auth.login     — Start device code flow (returns user_code + URL)
 *   auth.pollLogin — Poll for device code completion, save on success
 *   auth.cancel    — Cancel a pending device code flow
 *   auth.switch    — Set a different profile as default
 *   auth.remove    — Remove a saved profile
 */

import { AuthProfileStore } from '../../auth/profiles.js';
import {
  requestDeviceCode,
  pollForAccessToken,
} from '../../providers/copilot-auth.js';

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
    token?: string;
    username?: string;
    error?: string;
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

  // If a profile already exists, notify the caller so the provider can use it
  const onTokenUpdate = _deps?.onAuthTokenUpdate as (
    (token: string | null) => void
  ) | undefined;
  const existingProfile = store.get('copilot');
  if (existingProfile?.token && onTokenUpdate) {
    onTokenUpdate(existingProfile.token);
  } else if (store.hasPersistedState() && onTokenUpdate) {
    onTokenUpdate(null);
  }

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
      const device = await requestDeviceCodeImpl();
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

          // Fetch username and save profile before publishing success. A
          // cancellation can remove the flow while this request is in flight.
          const username = (
            await fetchGitHubUsernameImpl(token)
          ) ?? `account-${Date.now()}`;
          if (pendingFlows.get(device.device_code) !== flow) return;
          store.remove('copilot', username);
          store.add({
            id: username,
            provider: 'copilot',
            type: 'device-code',
            token,
            default: true,
          });
          flow.token = token;
          flow.username = username;
          flow.resolved = true;

          // Notify the running provider so it picks up the new token
          if (onTokenUpdate) onTokenUpdate(token);
        })
        .catch((err) => {
          const flow = pendingFlows.get(device.device_code);
          if (flow) {
            flow.error = (err as Error).message;
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
  server.registerMethod<{ deviceCode: string }, { status: string; username?: string; error?: string }>(
    'auth.poll',
    async (params) => {
      const flow = pendingFlows.get(params.deviceCode);
      if (!flow) {
        return { status: 'error', error: 'No pending login flow found' };
      }

      if (!flow.resolved) {
        if (Date.now() > flow.expiresAt) {
          pendingFlows.delete(params.deviceCode);
          return { status: 'error', error: 'Device code expired' };
        }
        return { status: 'pending' };
      }

      // Flow completed
      pendingFlows.delete(params.deviceCode);

      if (flow.error) {
        return { status: 'error', error: flow.error };
      }

      // Determine the username that was saved
      return { status: 'success', username: flow.username ?? 'unknown' };
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
      if (flow.resolved && flow.token) {
        return { ok: false, status: 'completed' };
      }
      flow.controller.abort();
      return { ok: true, status: 'cancelled' };
    }
  );

  // ── auth.switch — set a profile as default ─────────────────────────────────
  server.registerMethod<{ id: string }, { ok: boolean }>(
    'auth.switch',
    async (params) => {
      const ok = store.setDefault('copilot', params.id);
      if (ok && onTokenUpdate) {
        const profile = store.get('copilot', params.id);
        if (profile?.token) onTokenUpdate(profile.token);
      }
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
        onTokenUpdate(store.get('copilot')?.token ?? null);
      }
      return { ok };
    }
  );
}
