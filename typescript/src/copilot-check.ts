import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import os from 'os';

const execAsync = promisify(exec);

const CREDENTIALS_DIR = path.join(os.homedir(), '.openrappter', 'credentials');
const GITHUB_TOKEN_FILE = path.join(CREDENTIALS_DIR, 'github-token.json');

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

/** Save a GitHub token to the credentials file */
export function saveGitHubToken(token: string, source: CachedGitHubToken['source']): void {
  try {
    fs.mkdirSync(CREDENTIALS_DIR, { recursive: true });
    const payload: CachedGitHubToken = { token, savedAt: Date.now(), source };
    fs.writeFileSync(GITHUB_TOKEN_FILE, JSON.stringify(payload, null, 2));
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
 * 3. ~/.openrappter/.env file (saved by onboard/installer device code flow)
 * 4. GH_TOKEN / GITHUB_TOKEN env vars (may be from gh CLI — different OAuth app)
 * 5. gh CLI token (least preferred — usually doesn't have Copilot access)
 *
 * Note: Steps 2-3 are prioritized over generic env vars because the
 * onboard/installer device code flow produces tokens with Copilot access,
 * while GH_TOKEN/GITHUB_TOKEN from gh CLI typically do not.
 */
export async function resolveGithubToken(): Promise<string | null> {
  // 1. Explicit Copilot token always wins
  if (process.env.COPILOT_GITHUB_TOKEN) return process.env.COPILOT_GITHUB_TOKEN;

  // 2. Cached credentials file (saved by device code flow or onboard)
  const cached = loadCachedGitHubToken();
  if (cached) return cached;

  // 3. ~/.openrappter/.env file (saved by installer/onboard — has Copilot access)
  try {
    const envFile = path.join(os.homedir(), '.openrappter', '.env');
    const data = fs.readFileSync(envFile, 'utf-8');
    for (const line of data.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('GITHUB_TOKEN=')) {
        let val = trimmed.slice('GITHUB_TOKEN='.length).trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        if (val.length > 0) return val;
      }
    }
  } catch { /* no .env file */ }

  // 4. Generic env vars (may not have Copilot access)
  const envToken = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  if (envToken) return envToken;

  // 5. gh CLI token (least preferred — usually different OAuth app)
  try {
    const { stdout } = await execAsync('gh auth token 2>/dev/null');
    if (stdout.trim()) return stdout.trim();
  } catch { /* gh not available */ }

  return null;
}

/**
 * Run inline device code auth when no cached token exists.
 * Saves the token to credentials file and .env for future use.
 * Returns the token or null if the flow was skipped/failed.
 */
export async function autoAuthIfNeeded(options?: {
  silent?: boolean;
}): Promise<string | null> {
  const existing = await resolveGithubToken();
  if (existing) {
    // Validate the existing token actually works with Copilot
    try {
      const { resolveCopilotApiToken } = await import('./providers/copilot-token.js');
      await resolveCopilotApiToken({ githubToken: existing });
      // Token is valid and cached — save to credentials file if not already there
      if (!loadCachedGitHubToken()) {
        saveGitHubToken(existing, 'env');
      }
      return existing;
    } catch {
      // Token exists but doesn't work with Copilot — fall through to re-auth
      if (!options?.silent) {
        console.warn('🦖 Cached GitHub token rejected by Copilot API — re-authenticating…');
      }
    }
  }

  // No TTY = can't do interactive auth
  if (!process.stdin.isTTY) {
    return null;
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

    return token;
  } catch (err) {
    if (!options?.silent) {
      console.warn(`🦖 Auth failed: ${(err as Error).message}`);
      console.warn("🦖 Run 'openrappter onboard' for full setup.\n");
    }
    return null;
  }
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
