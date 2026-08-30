import { openrappterHome, openrappterPath } from './infra/openrappter-home.js';
import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import {
  CopilotAuthority,
  CopilotAuthorityError,
  copilotCredentialToken,
  createCopilotAccount,
  type CopilotAccount,
} from './providers/copilot-authority.js';
import { writeCopilotSecretJsonAtomically } from './providers/copilot-secure-file.js';

const execAsync = promisify(exec);

const CREDENTIALS_DIR = path.join(openrappterHome(), 'credentials');
const GITHUB_TOKEN_FILE = path.join(CREDENTIALS_DIR, 'github-token.json');
const AUTH_PROFILES_FILE = path.join(openrappterHome(), 'auth-profiles.json');

interface CachedGitHubToken {
  token: string;
  savedAt: number;
  source: 'device_code' | 'manual' | 'env' | 'gh_cli';
}

/** Load a cached GitHub token from the credentials file */
function loadCachedGitHubToken(): string | null {
  try {
    const data = fs.readFileSync(GITHUB_TOKEN_FILE, 'utf-8');
    const cached = JSON.parse(data) as CachedGitHubToken;
    if (typeof cached.token === 'string' && cached.token.length > 0) {
      return cached.token;
    }
  } catch { /* no cached token */ }
  return null;
}

interface StoredCopilotProfile {
  id?: string;
  provider?: string;
  token?: string;
  refreshToken?: string;
  expiresAt?: number;
  default?: boolean;
}

/** An existing profile store is authoritative, including an explicit empty store. */
function loadAuthProfileState(): {
  authoritative: boolean;
  token: string | null;
  profiles: StoredCopilotProfile[];
} {
  if (!fs.existsSync(AUTH_PROFILES_FILE)) {
    return { authoritative: false, token: null, profiles: [] };
  }

  try {
    const data = fs.readFileSync(AUTH_PROFILES_FILE, 'utf-8');
    const profiles = JSON.parse(data) as StoredCopilotProfile[];
    const copilotProfiles = profiles.filter(
      (profile) => profile.provider === 'copilot'
        && typeof profile.token === 'string'
        && profile.token.length > 10,
    );
    // Look for the default copilot profile first
    const defaultCopilot = copilotProfiles.find((profile) => profile.default);
    if (defaultCopilot?.token) {
      return {
        authoritative: true,
        token: defaultCopilot.token,
        profiles: copilotProfiles,
      };
    }
    // Fall back to any copilot profile with a real token
    const anyCopilot = copilotProfiles[0];
    if (anyCopilot?.token) {
      return {
        authoritative: true,
        token: anyCopilot.token,
        profiles: copilotProfiles,
      };
    }
  } catch { /* a corrupt explicit store must not restore ambient credentials */ }
  return { authoritative: true, token: null, profiles: [] };
}

export function hasAuthProfileAuthority(): boolean {
  return Boolean(process.env.OPENRAPPTER_DESKTOP_OWNER_PID)
    && loadAuthProfileState().authoritative;
}

/** Save a GitHub token to the credentials file */
export function saveGitHubToken(token: string, source: CachedGitHubToken['source']): void {
  try {
    const payload: CachedGitHubToken = { token, savedAt: Date.now(), source };
    writeCopilotSecretJsonAtomically(GITHUB_TOKEN_FILE, payload);
  } catch { /* non-fatal */ }
}

/** Check if Copilot is available via direct token exchange (no CLI needed) */
export async function hasCopilotAvailable(): Promise<boolean> {
  const token = await resolveGithubToken();
  return token !== null;
}

/**
 * A Desktop-owned gateway treats auth-profiles.json as the sole account
 * authority, including an empty store created by explicit sign-out. Standalone
 * runtimes retain legacy env, credential-cache, .env, and gh CLI discovery.
 */
export async function discoverCopilotAccounts(): Promise<CopilotAccount[]> {
  // Collect all candidate tokens in priority order, validate the first one that works
  const candidates: Array<{
    token: string;
    source: string;
    id?: string;
    default?: boolean;
    refreshToken?: string;
    expiresAt?: number;
  }> = [];
  const profileState = loadAuthProfileState();
  const profileIsAuthoritative =
    Boolean(process.env.OPENRAPPTER_DESKTOP_OWNER_PID)
    && profileState.authoritative;

  if (profileIsAuthoritative) {
    const orderedProfiles = [...profileState.profiles].sort(
      (left, right) => Number(Boolean(right.default)) - Number(Boolean(left.default)),
    );
    for (const profile of orderedProfiles) {
      if (profile.token) {
        candidates.push({
          token: profile.token,
          source: `auth-profile:${profile.id ?? 'unknown'}:${profile.default ? 'default' : 'secondary'}`,
          id: profile.id,
          default: profile.default,
          refreshToken: profile.refreshToken,
          expiresAt: profile.expiresAt,
        });
      }
    }
  } else {
    // Legacy discovery remains available until the first profile-store action.
    if (process.env.COPILOT_GITHUB_TOKEN) {
      candidates.push({ token: process.env.COPILOT_GITHUB_TOKEN, source: 'env:COPILOT_GITHUB_TOKEN' });
    }

    const cached = loadCachedGitHubToken();
    if (cached) candidates.push({ token: cached, source: 'credentials' });
    const orderedProfiles = [...profileState.profiles].sort(
      (left, right) => Number(Boolean(right.default)) - Number(Boolean(left.default)),
    );
    for (const profile of orderedProfiles) {
      if (profile.token) {
        candidates.push({
          token: profile.token,
          source: `auth-profile:${profile.id ?? 'unknown'}:${profile.default ? 'default' : 'secondary'}`,
          id: profile.id,
          default: profile.default,
          refreshToken: profile.refreshToken,
          expiresAt: profile.expiresAt,
        });
      }
    }

    try {
      const envFile = openrappterPath('.env');
      const data = fs.readFileSync(envFile, 'utf-8');
      for (const line of data.split(/\r?\n/)) {
        const trimmed = line.trim();
        const prefixes = ['COPILOT_GITHUB_TOKEN=', 'GITHUB_TOKEN='];
        for (const prefix of prefixes) {
          if (trimmed.startsWith(prefix)) {
            let val = trimmed.slice(prefix.length).trim();
            if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
              val = val.slice(1, -1);
            }
            if (val.length > 0) {
              candidates.push({ token: val, source: `env-file:${prefix.replace('=', '')}` });
            }
          }
        }
      }
    } catch { /* no .env file */ }

    const envToken = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
    if (envToken) candidates.push({ token: envToken, source: 'env:GH_TOKEN|GITHUB_TOKEN' });

    try {
      const { stdout } = await execAsync('gh auth token 2>/dev/null');
      if (stdout.trim()) candidates.push({ token: stdout.trim(), source: 'gh-cli' });
    } catch { /* gh not available */ }
  }

  // Deduplicate by token value, preserving priority order
  const seen = new Set<string>();
  const unique = candidates.filter(c => {
    if (seen.has(c.token)) return false;
    seen.add(c.token);
    return true;
  });

  return unique.map((candidate, index) =>
    createCopilotAccount({
      token: candidate.token,
      id: candidate.id ?? `legacy:${index}:${candidate.source}`,
      source: candidate.source.startsWith('auth-profile:')
        ? 'auth-profile'
        : candidate.source === 'credentials'
          ? 'credential-cache'
          : candidate.source === 'gh-cli'
            ? 'github-cli'
            : candidate.source.startsWith('env-file:')
              ? 'environment-file'
              : 'environment',
      // Precedence is the order above. A profile's `default` flag orders
      // profiles relative to one another, but must not jump ahead of the
      // explicit Copilot env/cache sources used by standalone runtimes.
      default: index === 0,
      refreshToken: candidate.refreshToken,
      expiresAt: candidate.expiresAt,
    })
  );
}

export async function resolveGithubToken(): Promise<string | null> {
  const accounts = await discoverCopilotAccounts();
  const authority = new CopilotAuthority({
    accounts,
    allowAmbientCredentials: false,
  });
  try {
    const resolved = await authority.resolveCredential();
    const token = copilotCredentialToken(resolved.account.credential);
    if (resolved.account.source !== 'credential-cache') {
      saveGitHubToken(token, 'device_code');
    }
    return token;
  } catch {
    // Every discovered token failed the Copilot exchange. Returning one would
    // trap callers in a permanent 401 loop instead of triggering re-auth.
    return null;
  }
}

/**
 * Why authentication did not produce a usable Copilot token.
 *
 * These are genuinely different failures with different fixes, and collapsing
 * them into `null` made the daemon report the wrong one. A token that Copilot
 * *rejected* was announced as "No GitHub token found", which sends an operator
 * to `onboard` to fix an absence that is not the problem — the token is present
 * and stale. Under launchd there is no TTY either, so the re-auth that message
 * implies cannot run at all.
 */
export type CopilotAuthOutcome =
  /** A token was obtained and Copilot accepted it. */
  | { status: 'authenticated'; token: string; source: 'cache' | 'device-code' }
  /** A token was found, Copilot refused it, and no TTY was available to redo it. */
  | { status: 'rejected'; interactive: false }
  /** No token was discovered anywhere, and no TTY was available to obtain one. */
  | { status: 'missing'; interactive: false }
  /** Interactive auth ran and failed. */
  | { status: 'failed'; error: string };

/**
 * Resolve a Copilot-capable GitHub token, saying *why* when it cannot.
 *
 * Prefer this over {@link autoAuthIfNeeded} when the caller reports the result
 * to a human: it is the difference between "no token" and "the token you have
 * is no longer good", which are not the same instruction.
 */
export async function resolveCopilotAuth(options?: {
  silent?: boolean;
  /** Test seam: how a token is discovered. Defaults to {@link resolveGithubToken}. */
  discoverToken?: () => Promise<string | null>;
  /** Test seam: how a token is checked against Copilot. Rejects when unusable. */
  validateToken?: (token: string) => Promise<void>;
  /** Test seam: whether an interactive prompt is possible. Defaults to `stdin.isTTY`. */
  interactive?: boolean;
  /** Shared process authority used by long-running runtimes. */
  authority?: CopilotAuthority;
}): Promise<CopilotAuthOutcome> {
  let rejected = false;
  let existing: string | null;
  if (options?.authority && !options.discoverToken && !options.validateToken) {
    try {
      const resolved = await options.authority.resolveCredential();
      existing = copilotCredentialToken(resolved.account.credential);
    } catch (error) {
      existing = null;
      rejected = error instanceof CopilotAuthorityError
        && (error.code === 'no_entitlement' || error.code === 'exchange_failure');
    }
  } else {
    existing = await (options?.discoverToken ?? resolveGithubToken)();
  }
  if (existing) {
    // Validate the existing token actually works with Copilot
    try {
      if (options?.authority && !options.validateToken) {
        await options.authority.resolveSession();
      } else if (options?.validateToken) {
        await options.validateToken(existing);
      } else {
        await new CopilotAuthority({
          githubToken: existing,
          allowAmbientCredentials: false,
        }).resolveSession();
      }
      // Token is valid and cached — save to credentials file if not already there
      if (!loadCachedGitHubToken()) {
        saveGitHubToken(existing, 'env');
      }
      return { status: 'authenticated', token: existing, source: 'cache' };
    } catch {
      // Token exists but doesn't work with Copilot — fall through to re-auth
      rejected = true;
      if (!options?.silent) {
        console.warn('🦖 Cached GitHub token rejected by Copilot API — re-authenticating…');
      }
    }
  }

  // No TTY = can't do interactive auth. Report which of the two states we are
  // in, because the remedy differs and the caller cannot tell from `null`.
  const interactive = options?.interactive ?? Boolean(process.stdin.isTTY);
  if (!interactive) {
    return rejected
      ? { status: 'rejected', interactive: false }
      : { status: 'missing', interactive: false };
  }

  try {
    const { deviceCodeLogin } = await import('./providers/copilot-auth.js');
    const chalk = (await import('chalk')).default;

    if (!options?.silent) {
      console.log('\n🦖 GitHub Copilot authentication required (one-time setup)\n');
    }

    const token = await deviceCodeLogin((code, url) => {
      console.log(`  Open:  ${chalk.cyan(url)}`);
      console.log(`  Code:  ${chalk.bold(code)}\n`);
      // Try to open browser
      const openCmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
      execAsync(`${openCmd} ${url}`).catch(() => {});
      console.log('  Waiting for authorization…');
    });

    // Save to credentials file
    saveGitHubToken(token, 'device_code');
    options?.authority?.setCredential(token, {
      accountId: `device-code:${Date.now()}`,
      source: 'explicit',
    });

    // Also save to auth-profiles.json for the web UI auth system
    try {
      const { AuthProfileStore } = await import('./auth/profiles.js');
      const store = new AuthProfileStore();
      store.add({
        id: `copilot-${Date.now()}`,
        provider: 'copilot',
        type: 'device-code',
        token,
        default: true,
      });
    } catch { /* non-fatal */ }

    // Also save to .env for backward compatibility
    try {
      const { loadEnv, saveEnv } = await import('./env.js');
      const env = await loadEnv();
      env.GITHUB_TOKEN = token;
      await saveEnv(env);
    } catch { /* non-fatal */ }

    if (!options?.silent) {
      console.log(chalk.green('\n  ✓ Authenticated! Token cached locally.\n'));
    }

    return { status: 'authenticated', token, source: 'device-code' };
  } catch (err) {
    const error = (err as Error).message;
    if (!options?.silent) {
      console.warn(`🦖 Auth failed: ${error}`);
      console.warn("🦖 Run 'openrappter onboard' for full setup.\n");
    }
    return { status: 'failed', error };
  }
}

/**
 * Back-compatible wrapper: the token, or `null` for every failure.
 *
 * Callers that report to a human should use {@link resolveCopilotAuth} instead,
 * so they can name the actual cause.
 */
export async function autoAuthIfNeeded(
  options?: Parameters<typeof resolveCopilotAuth>[0],
): Promise<string | null> {
  const outcome = await resolveCopilotAuth(options);
  return outcome.status === 'authenticated' ? outcome.token : null;
}

export async function validateTelegramToken(token: string): Promise<{ valid: boolean; username?: string; error?: string }> {
  try {
    const resp = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    const data = await resp.json() as { ok: boolean; result?: { username?: string }; description?: string };
    if (data.ok && data.result) {
      return { valid: true, username: data.result.username };
    }
    return { valid: false, error: data.description || 'Invalid token' };
  } catch (err) {
    return { valid: false, error: err instanceof Error ? err.message : 'Network error' };
  }
}
