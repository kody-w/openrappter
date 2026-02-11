/**
 * Configuration loader - reads and parses config files
 */

import { readFileSync, existsSync, writeFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import JSON5 from 'json5';
import { validateConfig, type ValidatedConfig } from './schema.js';
import type { OpenRappterConfig } from './types.js';

const DEFAULT_CONFIG_DIR = join(homedir(), '.openrappter');
const DEFAULT_CONFIG_FILE = 'config.json5';

export function substituteEnvVars(value: string): string {
  return value.replace(/\$\{(\w+)\}/g, (_, key) => process.env[key] ?? '');
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
