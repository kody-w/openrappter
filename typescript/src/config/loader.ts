/**
 * Configuration loader - reads and parses config files
 */

import { readFileSync, existsSync, writeFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import JSON5 from 'json5';
import { validateConfig } from './schema.js';
import type { OpenRappterConfig } from './types.js';
import { expandEnvVars } from './env-expand.js';

const DEFAULT_CONFIG_DIR = join(homedir(), '.openrappter');
const DEFAULT_CONFIG_FILE = 'config.json5';

/**
 * Expand `${VAR}` and `${VAR:-default}` in a config value.
 *
 * This used to carry its own regex, `/\$\{(\w+)\}/g`, while `config/env-expand.ts`
 * carried a second one that also understood `:-default`. Only this copy ran:
 * nothing outside its own tests imported the other. So the documented
 * `${ANTHROPIC_API_KEY:-sk-placeholder}` form matched nothing here — neither `:`
 * nor `-` is `\w` — and survived into the config as that literal string, to fail
 * later as a bad credential rather than at load. The tests covering the fallback
 * passed the whole time, because they exercised the copy that was never wired in.
 *
 * One implementation now, the one with the behaviour the documentation promises.
 */
export function substituteEnvVars(value: string): string {
  return expandEnvVars(value);
}

function substituteDeep(obj: unknown): unknown {
  if (typeof obj === 'string') {
    return substituteEnvVars(obj);
  }
  if (Array.isArray(obj)) {
    return obj.map(substituteDeep);
  }
  if (obj && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(obj)) {
      result[key] = substituteDeep(val);
    }
    return result;
  }
  return obj;
}

export function getConfigPath(profile?: string): string {
  if (profile) {
    return join(DEFAULT_CONFIG_DIR, `config.${profile}.json5`);
  }
  return join(DEFAULT_CONFIG_DIR, DEFAULT_CONFIG_FILE);
}

export function parseConfigContent(content: string): unknown {
  return JSON5.parse(content);
}

export function loadConfig(options?: { profile?: string; path?: string }): OpenRappterConfig {
  const configPath = options?.path ?? getConfigPath(options?.profile);

  if (!existsSync(configPath)) {
    return {};
  }

  const content = readFileSync(configPath, 'utf-8');
  const parsed = parseConfigContent(content);
  const substituted = substituteDeep(parsed);

  const result = validateConfig(substituted);
  if (!result.success) {
    throw new Error(`Invalid config: ${result.error}`);
  }

  return result.data as OpenRappterConfig;
}

export function saveConfig(config: OpenRappterConfig, options?: { profile?: string; path?: string }): void {
  const configPath = options?.path ?? getConfigPath(options?.profile);

  // Create backup
  if (existsSync(configPath)) {
    const backupPath = configPath.replace(/\.json5$/, '.backup.json5');
    copyFileSync(configPath, backupPath);
  }

  const content = JSON5.stringify(config, null, 2);
  writeFileSync(configPath, content, 'utf-8');
}

export function mergeConfigs(...configs: Partial<OpenRappterConfig>[]): OpenRappterConfig {
  const merged: OpenRappterConfig = {};

  for (const config of configs) {
    if (config.models) {
      merged.models = [...(merged.models ?? []), ...config.models];
    }
    if (config.agents) {
      merged.agents = {
        ...merged.agents,
        ...config.agents,
        list: [...(merged.agents?.list ?? []), ...(config.agents.list ?? [])],
      };
    }
    if (config.channels) {
      merged.channels = { ...merged.channels, ...config.channels };
    }
    if (config.gateway) {
      merged.gateway = { ...merged.gateway, ...config.gateway };
    }
    if (config.cron) {
      merged.cron = { ...merged.cron, ...config.cron };
    }
    if (config.memory) {
      merged.memory = { ...merged.memory, ...config.memory };
    }
  }

  return merged;
}
