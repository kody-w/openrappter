import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * The operating system's start marker for a PID.
 *
 * A PID alone is reusable. Callers that persist process ownership must pair it
 * with this marker so a later process receiving the same PID is not mistaken
 * for the original owner.
 */
export function readProcessIncarnation(pid: number): string | null {
  try {
    if (process.platform === 'linux') {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const fields = stat
        .slice(stat.lastIndexOf(')') + 2)
        .trim()
        .split(/\s+/);
      const startTicks = fields[19];
      return startTicks ? `linux:${startTicks}` : null;
    }
    if (process.platform === 'win32') {
      return `win:${execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `(Get-Process -Id ${pid}).StartTime.ToUniversalTime().ToFileTimeUtc()`,
        ],
        { encoding: 'utf8', windowsHide: true },
      ).trim()}`;
    }
    const started = execFileSync(
      'ps',
      ['-o', 'lstart=', '-p', String(pid)],
      {
        encoding: 'utf8',
        env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
      },
    ).trim();
    return started ? `ps-c-utc:${started}` : null;
  } catch {
    return null;
  }
}

export const CURRENT_PROCESS_INCARNATION =
  readProcessIncarnation(process.pid) ?? undefined;

/**
 * Always-available marker for live identity.
 *
 * The OS marker is preferred because another process can independently verify
 * it. A per-process nonce is the safe fallback: unavailable evidence must not
 * collapse a restarted process onto an earlier live ID.
 */
export const CURRENT_PROCESS_START_MARKER =
  CURRENT_PROCESS_INCARNATION ?? `runtime:${randomUUID()}`;

export function processMatchesIncarnation(
  pid: number,
  incarnation: string | undefined,
): boolean {
  if (!processAlive(pid)) return false;
  if (!incarnation) return true;
  const current =
    pid === process.pid
      ? CURRENT_PROCESS_INCARNATION
      : readProcessIncarnation(pid);
  return current === null || current === incarnation;
}
