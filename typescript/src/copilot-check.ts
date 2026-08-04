import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import os from 'os';

const execAsync = promisify(exec);

const OPENRAPPTER_DIR = path.join(os.homedir(), '.openrappter');
const CREDENTIALS_DIR = path.join(OPENRAPPTER_DIR, 'credentials');
const GITHUB_TOKEN_FILE = path.join(CREDENTIALS_DIR, 'github-token.json');
const AUTH_PROFILES_FILE = path.join(OPENRAPPTER_DIR, 'auth-profiles.json');

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

/** Load a token from auth-profiles.json (saved by device-code flow via auth.login RPC) */
function loadAuthProfileToken(): string | null {
  try {
    const data = fs.readFileSync(AUTH_PROFILES_FILE, 'utf-8');
    const profiles = JSON.parse(data) as Array<{
      provider?: string;
      token?: string;
      default?: boolean;
    }>;
    // Look for the default copilot profile first
    const defaultCopilot = profiles.find(
      (p) => p.provider === 'copilot' && p.default && typeof p.token === 'string' && p.token.length > 10
    );
    if (defaultCopilot?.token) return defaultCopilot.token;
    // Fall back to any copilot profile with a real token
    const anyCopilot = profiles.find(
      (p) => p.provider === 'copilot' && typeof p.token === 'string' && p.token.length > 10
    );
    if (anyCopilot?.token) return anyCopilot.token;
  } catch { /* no auth profiles */ }
  return null;
}

/** Save a GitHub token to the credentials file */
export function saveGitHubToken(token: string, source: CachedGitHubToken['source']): void {
  try {
    fs.mkdirSync(CREDENTIALS_DIR, { recursive: true, mode: 0o700 });
    const payload: CachedGitHubToken = { token, savedAt: Date.now(), source };
    fs.writeFileSync(GITHUB_TOKEN_FILE, JSON.stringify(payload, null, 2), { mode: 0o600 });
  } catch { /* non-fatal */ }
}

/** Check if Copilot is available via direct token exchange (no CLI needed) */
export async function hasCopilotAvailable(): Promise<boolean> {
  const token = await resolveGithubToken();
  return token !== null;
}

/**
 * Resolve a GitHub token from (in priority order):
 * 1. COPILOT_GITHUB_TOKEN env var (explicit Copilot token always wins)
 * 2. Cached credentials file (~/.openrappter/credentials/github-token.json)
 * 3. Auth profiles store (~/.openrappter/auth-profiles.json — copilot provider)
 * 4. ~/.openrappter/.env file (saved by onboard/installer device code flow)
 * 5. GH_TOKEN / GITHUB_TOKEN env vars (may be from gh CLI — different OAuth app)
 * 6. gh CLI token (least preferred — usually doesn't have Copilot access)
 *
 * Note: Steps 2-4 are prioritized over generic env vars because the
 * onboard/installer device code flow produces tokens with Copilot access,
 * while GH_TOKEN/GITHUB_TOKEN from gh CLI typically do not.
 */
export async function resolveGithubToken(): Promise<string | null> {
  // Collect all candidate tokens in priority order, validate the first one that works
  const candidates: { token: string; source: string }[] = [];

  // 1. Explicit Copilot token always wins
  if (process.env.COPILOT_GITHUB_TOKEN) {
    candidates.push({ token: process.env.COPILOT_GITHUB_TOKEN, source: 'env:COPILOT_GITHUB_TOKEN' });
  }

  // 2. Cached credentials file (saved by device code flow or onboard)
  const cached = loadCachedGitHubToken();
  if (cached) candidates.push({ token: cached, source: 'credentials' });

  // 3. Auth profiles store (saved by auth.login RPC or web UI device-code flow)
  const profileToken = loadAuthProfileToken();
  if (profileToken) candidates.push({ token: profileToken, source: 'auth-profile' });

  // 4. ~/.openrappter/.env file (saved by installer/onboard — has Copilot access)
  try {
    const envFile = path.join(os.homedir(), '.openrappter', '.env');
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

  // 5. Generic env vars (may not have Copilot access)
  const envToken = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  if (envToken) candidates.push({ token: envToken, source: 'env:GH_TOKEN|GITHUB_TOKEN' });

  // 6. gh CLI token (least preferred — usually different OAuth app)
  try {
    const { stdout } = await execAsync('gh auth token 2>/dev/null');
    if (stdout.trim()) candidates.push({ token: stdout.trim(), source: 'gh-cli' });
  } catch { /* gh not available */ }

  // Deduplicate by token value, preserving priority order
  const seen = new Set<string>();
  const unique = candidates.filter(c => {
    if (seen.has(c.token)) return false;
    seen.add(c.token);
    return true;
  });

  // Try each candidate — validate with Copilot API, return first that works
  for (const candidate of unique) {
    try {
      const { resolveCopilotApiToken } = await import('./providers/copilot-token.js');
      await resolveCopilotApiToken({ githubToken: candidate.token });
      // This token works — sync it to all sources so they stay consistent
      if (candidate.source !== 'credentials') {
        saveGitHubToken(candidate.token, 'device_code');
      }
      return candidate.token;
    } catch {
      // Token doesn't work with Copilot — try next
    }
  }

  // Every discovered token failed the Copilot exchange. Returning one would
  // trap callers in a permanent 401 loop instead of triggering re-auth.
  return null;
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
}): Promise<CopilotAuthOutcome> {
  let rejected = false;
  const existing = await (options?.discoverToken ?? resolveGithubToken)();
  if (existing) {
    // Validate the existing token actually works with Copilot
    try {
      if (options?.validateToken) {
        await options.validateToken(existing);
      } else {
        const { resolveCopilotApiToken } = await import('./providers/copilot-token.js');
        await resolveCopilotApiToken({ githubToken: existing });
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
