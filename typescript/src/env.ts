import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import JSON5 from 'json5';

export const HOME_DIR = path.join(os.homedir(), '.openrappter');
export const CONFIG_FILE = path.join(HOME_DIR, 'config.json');
/**
 * The schema-validated loader (`config/loader.ts`) reads `config.json5`, so a
 * user who follows the Zod config schema writes there — while every consumer
 * that goes through this module reads `config.json`. That split silently
 * discarded real configuration (notably `channels.imessage`), and the error
 * text then told the user to set the very thing they had just set.
 */
export const CONFIG_FILE_JSON5 = path.join(HOME_DIR, 'config.json5');
export const ENV_FILE = path.join(HOME_DIR, '.env');

export async function ensureHomeDir(): Promise<void> {
  await fs.mkdir(HOME_DIR, { recursive: true });
}

export async function loadEnv(filePath: string = ENV_FILE): Promise<Record<string, string>> {
  try {
    const data = await fs.readFile(filePath, 'utf-8');
    const env: Record<string, string> = {};
    for (const line of data.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx > 0) {
        const key = trimmed.slice(0, eqIdx).trim();
        let val = trimmed.slice(eqIdx + 1).trim();
        // Strip surrounding quotes
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        env[key] = val;
      }
    }
    return env;
  } catch {
    return {};
  }
}

/**
 * Copy `~/.openrappter/.env` into `process.env` for keys that are not already
 * set, and report which keys were applied.
 *
 * The `openrappter` shell wrapper sources `.env` before exec, so every
 * interactive command sees it. launchd does not — it runs `node` directly with
 * a fixed environment — so a supervised gateway started with none of it, the
 * Copilot provider had no credential, and the iMessage model preflight failed
 * forever while `diagnose` (running under the wrapper) reported the token as
 * configured. Existing values always win, so this can never override a
 * deliberately exported variable.
 */
export async function hydrateManagedEnv(filePath: string = ENV_FILE): Promise<string[]> {
  const applied: string[] = [];
  const managed = await loadEnv(filePath);
  for (const [key, value] of Object.entries(managed)) {
    if (!process.env[key]) {
      process.env[key] = value;
      applied.push(key);
    }
  }
  return applied;
}

export async function saveEnv(env: Record<string, string>, filePath: string = ENV_FILE): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const lines = ['# openrappter environment — managed by `openrappter onboard`', ''];
  for (const [key, val] of Object.entries(env)) {
    lines.push(`${key}="${val}"`);
  }
  lines.push('');
  const content = lines.join('\n');
  await fs.writeFile(filePath, content);

  // Read-back verification
  const readBack = await fs.readFile(filePath, 'utf-8');
  if (readBack !== content) {
    throw new Error(`Env file verification failed: written content does not match read-back at ${filePath}`);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Recursive merge where `override` wins on conflict. */
function mergeConfigObjects(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const existing = merged[key];
    merged[key] = isPlainObject(existing) && isPlainObject(value)
      ? mergeConfigObjects(existing, value)
      : value;
  }
  return merged;
}

async function readJsonFile(filePath: string): Promise<Record<string, unknown>> {
  try {
    const data = await fs.readFile(filePath, 'utf-8');
    const parsed = JSON.parse(data);
    return isPlainObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

async function readJson5File(filePath: string): Promise<Record<string, unknown>> {
  try {
    const data = await fs.readFile(filePath, 'utf-8');
    const parsed = JSON5.parse(data);
    return isPlainObject(parsed) ? parsed : {};
  } catch {
    // A malformed or absent config.json5 must never take down a runtime that
    // was previously reading config.json alone.
    return {};
  }
}

/**
 * Report which config files actually contributed, so a mismatch is visible
 * instead of looking like a missing setting.
 */
export async function resolvedConfigSources(): Promise<string[]> {
  const sources: string[] = [];
  for (const candidate of [CONFIG_FILE_JSON5, CONFIG_FILE]) {
    try {
      await fs.access(candidate);
      sources.push(candidate);
    } catch { /* not present */ }
  }
  return sources;
}

export async function loadConfig(filePath: string = CONFIG_FILE): Promise<Record<string, unknown>> {
  const primary = await readJsonFile(filePath);
  // Only merge the sibling file when loading the default location; an explicit
  // path means the caller wants exactly that file.
  if (filePath !== CONFIG_FILE) return primary;

  // `config.json` still wins every conflict, so this cannot change the
  // behaviour of an install that already worked — it only stops `config.json5`
  // from being silently discarded.
  const secondary = await readJson5File(CONFIG_FILE_JSON5);
  return mergeConfigObjects(secondary, primary);
}

export async function saveConfig(config: Record<string, unknown>, filePath: string = CONFIG_FILE): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(config, null, 2));
}
