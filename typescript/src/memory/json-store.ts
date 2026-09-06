import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import Database from 'better-sqlite3';

export const MEMORY_LOCK_TIMEOUT_MS = 5_000;

export class MemoryStoreError extends Error {}

function regularFile(status: fs.Stats): void {
  if (!status.isFile() || status.nlink !== 1) {
    throw new MemoryStoreError('Memory store paths must be regular files, not links');
  }
}

function syncDirectory(directory: string): void {
  // Windows CRT directory opens are unsupported. File flushing below remains
  // mandatory; this is not a promise of power-loss durability for rename metadata.
  if (os.platform() === 'win32') return;
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function ensureDirectory(directory: string): void {
  const created = fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (created === undefined) return;
  const stop = path.dirname(path.resolve(created));
  for (let current = path.resolve(directory); ; current = path.dirname(current)) {
    syncDirectory(current);
    if (current === stop) break;
  }
}

function validate<T extends { message: string }>(value: unknown): Record<string, T> {
  if (
    value === null || typeof value !== 'object' || Array.isArray(value) ||
    Object.values(value).some(entry =>
      entry === null || typeof entry !== 'object' || Array.isArray(entry) ||
      typeof (entry as { message?: unknown }).message !== 'string',
    )
  ) {
    throw new MemoryStoreError('Memory store must be an object of memory entries with string messages');
  }
  return value as Record<string, T>;
}

export function readMemoryFile<T extends { message: string }>(file: string): Record<string, T> {
  let descriptor: number;
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new MemoryStoreError('Memory store could not be read', { cause: error });
  }
  let content: Buffer;
  try {
    regularFile(fs.fstatSync(descriptor));
    content = fs.readFileSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(content));
  } catch {
    throw new MemoryStoreError('Memory store is not valid JSON');
  }
  return validate<T>(parsed);
}

/**
 * Shared with Python agents/manage_memory_agent.py. Never unlink/replace the lock DB:
 * BEGIN IMMEDIATE owns the OS lock until COMMIT/ROLLBACK or process death.
 * No async work may escape this callback; the entire JSON transaction is sync.
 */
export async function withMemoryTransaction<T>(
  file: string,
  operation: () => T,
  timeoutMs = MEMORY_LOCK_TIMEOUT_MS,
): Promise<T> {
  if (operation.constructor.name === 'AsyncFunction') {
    throw new MemoryStoreError('Memory transactions require a synchronous callback');
  }
  let db: ReturnType<typeof Database>;
  try {
    ensureDirectory(path.dirname(file));
    const lock = path.join(fs.realpathSync(path.dirname(file)), `${path.basename(file)}.lock.sqlite3`);
    try {
      regularFile(fs.lstatSync(lock));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    // Opening/closing a separate fd for this inode can release POSIX locks
    // held by SQLite elsewhere in the process. SQLite alone owns its fds.
    db = Database(lock, { timeout: 0 });
    try {
      regularFile(fs.lstatSync(lock));
      fs.chmodSync(lock, 0o600);
      const deadline = performance.now() + timeoutMs;
      for (;;) {
        try {
          db.exec('BEGIN IMMEDIATE');
          break;
        } catch (error) {
          const code = (error as { code?: string }).code ?? '';
          const remaining = deadline - performance.now();
          if ((!code.startsWith('SQLITE_BUSY') && !code.startsWith('SQLITE_LOCKED')) || remaining <= 0) throw error;
          // Wait without blocking the Node event loop. Once acquired, no await
          // occurs until the JSON has been synced and the transaction released.
          await delay(Math.min(25, remaining));
        }
      }
      db.exec('CREATE TABLE IF NOT EXISTS memory_lock (id INTEGER PRIMARY KEY)');
    } catch (error) {
      db.close();
      throw error;
    }
  } catch (error) {
    throw new MemoryStoreError('Memory store lock could not be acquired', { cause: error });
  }
  try {
    const result = operation();
    if (result && typeof (result as { then?: unknown }).then === 'function') {
      throw new MemoryStoreError('Memory transactions require a synchronous callback');
    }
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // SQLite may already have rolled back a failed COMMIT.
    }
    throw error;
  } finally {
    db.close();
  }
}

/** Caller holds withMemoryTransaction across read, mutation and this commit. */
export function writeMemoryFile<T extends { message: string }>(file: string, memory: Record<string, T>): void {
  validate(memory);
  const content = `${JSON.stringify(memory, null, 2)}\n`;
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomBytes(16).toString('hex')}.pending`);
  const directory = os.platform() === 'win32'
    ? null
    : fs.openSync(path.dirname(file), fs.constants.O_RDONLY);
  let created = false;
  try {
    try {
      regularFile(fs.lstatSync(file));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const descriptor = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    created = true;
    try {
      fs.writeFileSync(descriptor, content, 'utf8');
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    fs.renameSync(temporary, file);
    if (directory !== null) {
      fs.fsyncSync(directory);
    } else {
      // FlushFileBuffers needs a writable file handle. Flush the published file
      // too, without pretending this supplies a POSIX directory-fsync guarantee.
      const published = fs.openSync(file, fs.constants.O_RDWR);
      try {
        regularFile(fs.fstatSync(published));
        fs.fsyncSync(published);
      } finally {
        fs.closeSync(published);
      }
    }
  } finally {
    if (directory !== null) fs.closeSync(directory);
    if (created) {
      try {
        fs.unlinkSync(temporary);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  }
}
