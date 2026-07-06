/**
 * Soul Config Persistence — save/load rappter soul configs as JSON files.
 *
 * Each soul config lives at <soulsDir>/<id>.json (default ~/.openrappter/souls/).
 * The store only handles configs; RappterManager decides when to load them
 * into live souls (see RappterManager.restoreSouls).
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { RappterSoulConfig } from './rappter-manager.js';

/** Soul ids must be safe to use as filenames — no separators, no dot-prefix. */
const SOUL_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

export function isValidSoulId(id: unknown): id is string {
  return typeof id === 'string' && SOUL_ID_PATTERN.test(id);
}

function isValidConfig(value: unknown): value is RappterSoulConfig {
  if (typeof value !== 'object' || value === null) return false;
  const config = value as Record<string, unknown>;
  return (
    isValidSoulId(config.id) &&
    typeof config.name === 'string' && config.name.length > 0 &&
    typeof config.description === 'string' && config.description.length > 0
  );
}

export class SoulStore {
  readonly soulsDir: string;

  constructor(soulsDir?: string) {
    this.soulsDir = soulsDir ?? path.join(os.homedir(), '.openrappter', 'souls');
  }

  private filePath(id: string): string {
    return path.join(this.soulsDir, `${id}.json`);
  }

  /** Persist a soul config. Returns the file path written. */
  async save(config: RappterSoulConfig): Promise<string> {
    if (!isValidSoulId(config.id)) {
      throw new Error(`Invalid soul id: ${JSON.stringify(config.id)}`);
    }
    if (typeof config.name !== 'string' || config.name.length === 0) {
      throw new Error('Soul config requires a non-empty name');
    }
    if (typeof config.description !== 'string' || config.description.length === 0) {
      throw new Error('Soul config requires a non-empty description');
    }

    await fs.mkdir(this.soulsDir, { recursive: true });
    const filePath = this.filePath(config.id);
    await fs.writeFile(filePath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
    return filePath;
  }

  /** Load one persisted config, or undefined if missing/invalid. */
  async load(id: string): Promise<RappterSoulConfig | undefined> {
    if (!isValidSoulId(id)) return undefined;
    try {
      const raw = await fs.readFile(this.filePath(id), 'utf-8');
      const parsed = JSON.parse(raw);
      return isValidConfig(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  /** List all persisted configs, skipping corrupt or invalid files. */
  async list(): Promise<RappterSoulConfig[]> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.soulsDir);
    } catch {
      return [];
    }

    const configs: RappterSoulConfig[] = [];
    for (const entry of entries.filter((e) => e.endsWith('.json')).sort()) {
      try {
        const raw = await fs.readFile(path.join(this.soulsDir, entry), 'utf-8');
        const parsed = JSON.parse(raw);
        if (isValidConfig(parsed)) configs.push(parsed);
      } catch {
        // Corrupt file — skip it rather than failing the whole listing
      }
    }
    return configs;
  }

  /** Delete a persisted config. Returns true if a file was removed. */
  async remove(id: string): Promise<boolean> {
    if (!isValidSoulId(id)) return false;
    try {
      await fs.unlink(this.filePath(id));
      return true;
    } catch {
      return false;
    }
  }
}
