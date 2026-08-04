import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { createRequire } from 'module';
import { homedir } from 'os';
import { dirname, join } from 'path';

export const DEFAULT_GATEWAY_LOCK_FILE = join(
  homedir(),
  '.openrappter',
  'gateway.pid',
);

export interface GatewayLockOptions {
  filePath?: string;
  pid?: number;
}

interface LockDatabase {
  exec(sql: string): void;
  pragma(sql: string): unknown;
  close(): void;
}

type LockDatabaseConstructor = new (filePath: string) => LockDatabase;

interface HeldLock {
  pid: number;
  database: LockDatabase;
}

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3') as LockDatabaseConstructor;
const heldLocks = new Map<string, HeldLock>();

function databasePath(filePath: string): string {
  return `${filePath}.sqlite`;
}

function openExclusiveDatabase(filePath: string): LockDatabase | null {
  let database: LockDatabase | undefined;
  try {
    database = new Database(databasePath(filePath));
    database.pragma('busy_timeout = 0');
    database.pragma('journal_mode = DELETE');
    database.exec(`
      CREATE TABLE IF NOT EXISTS gateway_lock (
        id INTEGER PRIMARY KEY CHECK (id = 1)
      )
    `);
    database.exec('BEGIN EXCLUSIVE');
    chmodSync(databasePath(filePath), 0o600);
    return database;
  } catch {
    try {
      database?.close();
    } catch {
      // The operating system releases any partial lock when the handle closes.
    }
    return null;
  }
}

function writeOwner(filePath: string, pid: number): void {
  const temporaryPath = `${filePath}.${pid}.tmp`;
  const descriptor = openSync(temporaryPath, 'wx', 0o600);
  try {
    writeFileSync(descriptor, `${pid}\n`, 'utf8');
  } finally {
    closeSync(descriptor);
  }
  try {
    renameSync(temporaryPath, filePath);
    chmodSync(filePath, 0o600);
  } finally {
    try {
      unlinkSync(temporaryPath);
    } catch {
      // The atomic rename normally removes the temporary path.
    }
  }
}

function readOwner(filePath: string): number | null {
  try {
    const pid = Number.parseInt(readFileSync(filePath, 'utf8').trim(), 10);
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

export function acquireLock(options: GatewayLockOptions = {}): boolean {
  const filePath = options.filePath ?? DEFAULT_GATEWAY_LOCK_FILE;
  const pid = options.pid ?? process.pid;
  const held = heldLocks.get(filePath);
  if (held) return held.pid === pid;

  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
  chmodSync(dirname(filePath), 0o700);
  const database = openExclusiveDatabase(filePath);
  if (!database) return false;
  try {
    writeOwner(filePath, pid);
    heldLocks.set(filePath, { pid, database });
    return true;
  } catch {
    try {
      database.exec('ROLLBACK');
    } catch {
      // Closing below releases the exclusive lock even if rollback fails.
    }
    database.close();
    return false;
  }
}

export function releaseLock(options: GatewayLockOptions = {}): void {
  const filePath = options.filePath ?? DEFAULT_GATEWAY_LOCK_FILE;
  const pid = options.pid ?? process.pid;
  const held = heldLocks.get(filePath);
  if (!held || held.pid !== pid) return;

  if (readOwner(filePath) === pid) {
    try {
      unlinkSync(filePath);
    } catch {
      // The PID file is advisory; the SQLite transaction is authoritative.
    }
  }
  try {
    held.database.exec('ROLLBACK');
  } catch {
    // Closing releases the kernel lock.
  }
  held.database.close();
  heldLocks.delete(filePath);
}

export interface GatewayLockOwner {
  /** PID recorded in the lock file, or null when absent/unreadable/malformed. */
  pid: number | null;
  /** Whether that recorded PID is a live process this user can signal. */
  alive: boolean;
}

/**
 * Report who the lock file says owns the gateway.
 *
 * `isGatewayRunning()` answers *whether* the gateway is held, which is not
 * enough to debug the case that matters: another supervisor holding the lock
 * while the installed launch agent loops on "Another OpenRappter gateway
 * already owns the runtime lock". Then `install-service` reports live/ready for
 * a listener it does not own, and the symptoms look like a credential problem
 * instead of an ownership one.
 */
export function readGatewayLockOwner(options: GatewayLockOptions = {}): GatewayLockOwner {
  const filePath = options.filePath ?? DEFAULT_GATEWAY_LOCK_FILE;
  let pid: number | null = null;
  try {
    const raw = readFileSync(filePath, 'utf-8').trim();
    // The file may carry trailing content; only a leading integer is meaningful.
    const parsed = Number.parseInt(raw, 10);
    if (Number.isSafeInteger(parsed) && parsed > 0) pid = parsed;
  } catch {
    return { pid: null, alive: false };
  }
  if (pid === null) return { pid: null, alive: false };

  let alive = false;
  try {
    // Signal 0 tests for existence without delivering anything.
    process.kill(pid, 0);
    alive = true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else.
    alive = (error as NodeJS.ErrnoException).code === 'EPERM';
  }
  return { pid, alive };
}

export function isGatewayRunning(options: GatewayLockOptions = {}): boolean {
  const filePath = options.filePath ?? DEFAULT_GATEWAY_LOCK_FILE;
  if (heldLocks.has(filePath)) return true;

  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
  chmodSync(dirname(filePath), 0o700);
  const probe = openExclusiveDatabase(filePath);
  if (!probe) return true;
  try {
    probe.exec('ROLLBACK');
  } catch {
    // Closing still releases the probe lock.
  }
  probe.close();
  return false;
}
