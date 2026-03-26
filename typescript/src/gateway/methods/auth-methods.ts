/**
 * Auth RPC methods — GitHub account login, switch, and removal
 *
 * Methods:
 *   auth.profiles  — List all saved GitHub auth profiles
 *   auth.active    — Get the current active profile
 *   auth.login     — Start device code flow (returns user_code + URL)
 *   auth.pollLogin — Poll for device code completion, save on success
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
    token?: string;
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
  const store = new AuthProfileStore();

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
      const device = await requestDeviceCode();
      const expiresAt = Date.now() + device.expires_in * 1000;
      const intervalMs = Math.max(1000, device.interval * 1000);

      // Store the pending flow
      pendingFlows.set(device.device_code, {
        deviceCode: device.device_code,
        expiresAt,
        intervalMs,
        resolved: false,
      });

      // Start polling in the background
      pollForAccessToken({
        deviceCode: device.device_code,
        intervalMs,
        expiresAt,
      })
        .then(async (token) => {
          const flow = pendingFlows.get(device.device_code);
          if (flow) {
            flow.token = token;
            flow.resolved = true;

            // Fetch username and save profile
            const username = (await fetchGitHubUsername(token)) ?? `account-${Date.now()}`;
            // Remove existing profile with same username to avoid duplicates
            store.remove('copilot', username);
            store.add({
              id: username,
              provider: 'copilot',
              type: 'device-code',
              token,
              default: true,
            });
          }
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
      const username = flow.token
        ? (await fetchGitHubUsername(flow.token)) ?? 'unknown'
        : 'unknown';

      return { status: 'success', username };
    }
  );

  // ── auth.switch — set a profile as default ─────────────────────────────────
  server.registerMethod<{ id: string }, { ok: boolean }>(
    'auth.switch',
    async (params) => {
      const ok = store.setDefault('copilot', params.id);
      return { ok };
    }
  );

  // ── auth.remove — delete a saved profile ───────────────────────────────────
  server.registerMethod<{ id: string }, { ok: boolean }>(
    'auth.remove',
    async (params) => {
      const ok = store.remove('copilot', params.id);
      return { ok };
    }
  );
}
