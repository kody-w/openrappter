/**
 * Storage module exports
 */

export * from './types.js';
export * from './sqlite.js';
export * from './migrations.js';

import type { StorageAdapter, StorageConfig } from './types.js';
import { SQLiteAdapter } from './sqlite.js';

let defaultAdapter: StorageAdapter | null = null;

/**
 * Create a storage adapter based on config
 */
export function createStorageAdapter(config: StorageConfig): StorageAdapter {
  switch (config.type) {
    case 'sqlite':
      return new SQLiteAdapter(config);
    case 'memory':
      return new SQLiteAdapter({ ...config, inMemory: true });
    default:
      throw new Error(`Unknown storage type: ${config.type}`);
  }
}

/**
 * Get or create the default storage adapter
 */
export async function getDefaultStorage(config?: StorageConfig): Promise<StorageAdapter> {
  if (!defaultAdapter) {
    const defaultConfig: StorageConfig = config ?? {
      type: 'sqlite',
      path: 'openrappter.db',
    };
    defaultAdapter = createStorageAdapter(defaultConfig);
    await defaultAdapter.initialize();
  }
  return defaultAdapter;
}

/**
 * Close the default storage adapter
 */
export async function closeDefaultStorage(): Promise<void> {
  if (defaultAdapter) {
    await defaultAdapter.close();
    defaultAdapter = null;
  }
}
