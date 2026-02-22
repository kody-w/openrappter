/**
 * File Manager
 * Provides temp file lifecycle management with TOCTOU protection and
 * automatic cleanup on process exit.
 */

import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { randomBytes } from 'crypto';

// Global registry of all tracked temp files across all FileManager instances
const _globalTracked: Set<string> = new Set();
let _globalHandlerRegistered = false;

function registerGlobalExitHandler(): void {
  if (_globalHandlerRegistered) return;
  _globalHandlerRegistered = true;

  const cleanup = () => {
    for (const path of _globalTracked) {
      try {
        const { unlinkSync } = require('fs');
        unlinkSync(path);
      } catch {
        // Ignore errors during exit cleanup
      }
    }
  };

  process.on('exit', cleanup);
  process.on('SIGINT', () => { cleanup(); process.exit(130); });
  process.on('SIGTERM', () => { cleanup(); process.exit(143); });
}

export class FileManager {
  private trackedFiles: Set<string> = new Set();

  constructor() {
    registerGlobalExitHandler();
  }

  /**
   * Create a unique temp file path in the system temp directory.
   * The path is tracked for automatic cleanup.
   * @param prefix - Filename prefix
   * @param ext - File extension (e.g. '.jpg', '.tmp')
   * @returns Absolute path to the temp file location
   */
  async createTemp(prefix: string, ext: string): Promise<string> {
    const id = randomBytes(12).toString('hex');
    const filename = `openrappter-${prefix}-${id}${ext}`;
    const path = join(tmpdir(), filename);
    this.trackedFiles.add(path);
    _globalTracked.add(path);
    return path;
  }

  /**
   * Atomically write data to a path using a write-to-temp-then-rename strategy.
   * This prevents partial writes and provides TOCTOU protection.
   * @param path - Target file path
   * @param data - Data to write (Buffer or string)
   */
  async atomicWrite(path: string, data: Buffer | string): Promise<void> {
    const dir = dirname(path);
    const tmpPath = join(dir, `.tmp-${randomBytes(8).toString('hex')}`);

    try {
      // Ensure directory exists
      await fs.mkdir(dir, { recursive: true });

      // Write to temp file first
      await fs.writeFile(tmpPath, data);

      // Atomically rename to target
      await fs.rename(tmpPath, path);
    } catch (err) {
      // Clean up temp file if rename failed
      await fs.unlink(tmpPath).catch(() => {});
      throw err;
    }
  }

  /**
   * Remove a tracked temp file. Silently ignores non-existent files.
   * @param path - Path to remove
   */
  async cleanup(path: string): Promise<void> {
    try {
      await fs.unlink(path);
    } catch {
      // Ignore all errors (ENOENT = already gone, others = best-effort cleanup)
    } finally {
      this.trackedFiles.delete(path);
      _globalTracked.delete(path);
    }
  }

  /**
   * Remove all tracked temp files.
   */
  async cleanupAll(): Promise<void> {
    const paths = [...this.trackedFiles];
    await Promise.all(paths.map((p) => this.cleanup(p)));
  }

  /**
   * Get the size of a file in bytes.
   * @param path - Path to the file
   */
  async getSize(path: string): Promise<number> {
    const stat = await fs.stat(path);
    return stat.size;
  }

  /**
   * Get all currently tracked temp file paths.
   */
  getTrackedFiles(): string[] {
    return [...this.trackedFiles];
  }
}

// Singleton file manager instance for shared use
let _sharedManager: FileManager | null = null;

export function getFileManager(): FileManager {
  if (!_sharedManager) {
    _sharedManager = new FileManager();
  }
  return _sharedManager;
}
