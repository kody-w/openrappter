import fs from 'fs/promises';
import path from 'path';
import os from 'os';

export const HOME_DIR = path.join(os.homedir(), '.openrappter');
export const CONFIG_FILE = path.join(HOME_DIR, 'config.json');
export const ENV_FILE = path.join(HOME_DIR, '.env');

export async function ensureHomeDir(): Promise<void> {
  await fs.mkdir(HOME_DIR, { recursive: true });
}

export async function loadEnv(filePath: string = ENV_FILE): Promise<Record<string, string>> {
  try {
    const data = await fs.readFile(filePath, 'utf-8');
    const env: Record<string, string> = {};
    for (const line of data.split('\n')) {
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

export async function loadConfig(filePath: string = CONFIG_FILE): Promise<Record<string, unknown>> {
  try {
    const data = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(data);
  } catch {
    return {};
  }
}

export async function saveConfig(config: Record<string, unknown>, filePath: string = CONFIG_FILE): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(config, null, 2));
}
