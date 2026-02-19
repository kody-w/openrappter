import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

/** Check if Copilot is available via direct token exchange (no CLI needed) */
export async function hasCopilotAvailable(): Promise<boolean> {
  const token = process.env.COPILOT_GITHUB_TOKEN ?? process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  if (token) return true;

  // Try gh CLI token as fallback
  try {
    const { stdout } = await execAsync('gh auth token 2>/dev/null');
    if (stdout.trim()) return true;
  } catch { /* gh not available */ }

  return false;
}

/** Resolve a GitHub token from env or gh CLI */
export async function resolveGithubToken(): Promise<string | null> {
  const envToken = process.env.COPILOT_GITHUB_TOKEN ?? process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  if (envToken) return envToken;

  try {
    const { stdout } = await execAsync('gh auth token 2>/dev/null');
    if (stdout.trim()) return stdout.trim();
  } catch { /* gh not available */ }

  return null;
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
