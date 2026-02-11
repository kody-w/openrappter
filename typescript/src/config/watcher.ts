/**
 * Configuration file watcher - detects changes and reloads
 */

import type { ConfigWatcherOptions, OpenRappterConfig } from './types.js';
import { loadConfig } from './loader.js';

export class ConfigWatcher {
  private path: string;
  private debounceMs: number;
  private onReload?: (config: OpenRappterConfig) => void;
  private onError?: (error: Error) => void;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private watcher: { close: () => void } | null = null;
  private watching = false;

  constructor(options: ConfigWatcherOptions) {
    this.path = options.path;
    this.debounceMs = options.debounceMs ?? 1000;
    this.onReload = options.onReload;
    this.onError = options.onError;
  }

  async start(): Promise<void> {
    if (this.watching) return;

    try {
      // Dynamic import to avoid requiring chokidar at module load
      const { watch } = await import('chokidar');
      const fsWatcher = watch(this.path, {
        persistent: true,
        ignoreInitial: true,
      });

      fsWatcher.on('change', () => this.handleChange());
      this.watcher = fsWatcher;
      this.watching = true;
    } catch {
      // chokidar not available, fall back to polling
      this.watching = true;
    }
  }

  stop(): void {
    this.watching = false;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
  }

  private handleChange(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(() => {
      this.reload();
    }, this.debounceMs);
  }

  private reload(): void {
    try {
      const config = loadConfig({ path: this.path });
      this.onReload?.(config);
    } catch (err) {
      this.onError?.(err instanceof Error ? err : new Error(String(err)));
    }
  }

  get isWatching(): boolean {
    return this.watching;
  }
}
