import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const LOCK_FILE = join(homedir(), '.openrappter', 'gateway.pid');

export function acquireLock(): boolean {
  if (isGatewayRunning()) {
    return false;
  }

  try {
    writeFileSync(LOCK_FILE, String(process.pid), 'utf-8');
    return true;
  } catch {
    return false;
  }
}

export function releaseLock(): void {
  try {
    if (existsSync(LOCK_FILE)) {
      unlinkSync(LOCK_FILE);
    }
  } catch {
    // Ignore errors during cleanup
  }
}

export function isGatewayRunning(): boolean {
  if (!existsSync(LOCK_FILE)) {
    return false;
  }

  try {
    const pidStr = readFileSync(LOCK_FILE, 'utf-8').trim();
    const pid = parseInt(pidStr, 10);

    if (isNaN(pid)) {
      return false;
    }

    // Check if process is alive
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      // Process is not running, clean up stale lock file
      unlinkSync(LOCK_FILE);
      return false;
    }
  } catch {
    return false;
  }
}
