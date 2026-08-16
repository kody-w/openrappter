/**
 * Configuration Management Command
 * CLI interface for viewing, modifying, and validating openrappter configuration.
 *
 * Subcommands:
 *   config show     - display current config (with secrets redacted)
 *   config get <key>   - get a config value
 *   config set <key> <value>  - set a config value
 *   config reset    - reset config to defaults
 *   config validate - validate config against schema
 *   config edit     - open config in $EDITOR
 */

import type { Command } from 'commander';
import { promises as fs } from 'fs';
import { spawn } from 'child_process';
import JSON5 from 'json5';
import {
  CONFIG_FILE,
  CONFIG_FILE_JSON5,
  HOME_DIR as CONFIG_DIR,
  loadConfig,
  mergeConfigObjects,
  saveConfig,
} from '../env.js';
import { validateConfig as validateConfigSchema } from '../config/schema.js';
export { redactSecrets } from '../security/redact.js';
import { redactSecrets } from '../security/redact.js';
import { isSecretKey } from '../security/secret-keys.js';

/** Fields whose values should be redacted in display output */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readOptionalConfig(
  filePath: string,
  parse: (source: string) => unknown,
): Promise<Record<string, unknown>> {
  let source: string;
  try {
    source = await fs.readFile(filePath, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = parse(source);
  } catch (error) {
    throw new Error(`Cannot parse ${filePath}: ${(error as Error).message}`);
  }
  if (!isPlainObject(parsed)) {
    throw new Error(`Invalid config in ${filePath}: top level must be an object`);
  }
  return parsed;
}

/** Strict counterpart to the tolerant runtime loader, for `config validate`. */
async function loadConfigForValidation(): Promise<Record<string, unknown>> {
  const json5 = await readOptionalConfig(CONFIG_FILE_JSON5, JSON5.parse);
  const json = await readOptionalConfig(CONFIG_FILE, JSON.parse);
  return mergeConfigObjects(json5, json);
}

/** Mutations touch only the higher-priority JSON override, never the merge. */
async function loadConfigForMutation(): Promise<Record<string, unknown>> {
  return readOptionalConfig(CONFIG_FILE, JSON.parse);
}

function formatValidationErrors(error: string): string[] {
  try {
    const issues = JSON.parse(error) as unknown;
    if (!Array.isArray(issues)) return [error];
    return issues.map((issue) => {
      if (!isPlainObject(issue)) return String(issue);
      const path = Array.isArray(issue.path)
        ? issue.path.map(String).join('.')
        : '';
      const message = typeof issue.message === 'string'
        ? issue.message
        : 'Invalid value';
      return path ? `${path}: ${message}` : message;
    });
  } catch {
    return [error];
  }
}

function unsupportedConfigErrors(config: Record<string, unknown>): string[] {
  const errors: string[] = [];
  if ('agent' in config) {
    errors.push('agent is not supported; use agents.defaults');
  }
  if (
    isPlainObject(config.gateway)
    && 'host' in config.gateway
  ) {
    errors.push('gateway.host is not supported; use gateway.bind');
  }
  if (
    isPlainObject(config.memory)
    && 'chunkSize' in config.memory
  ) {
    errors.push('memory.chunkSize is not supported; use memory.chunkTokens');
  }
  return errors;
}

function redactValueAtPath(path: string, value: unknown): unknown {
  const secretSegment = path.split('.').find(isSecretKey);
  if (!secretSegment) return redactSecrets(value);
  const wrapped = redactSecrets({ [secretSegment]: value }) as Record<string, unknown>;
  return wrapped[secretSegment];
}

export function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce((curr: any, key) => curr?.[key], obj);
}

export function setNestedValue(obj: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split('.');
  const last = keys.pop()!;
  const target = keys.reduce((curr: any, key) => {
    if (!(key in curr)) curr[key] = {};
    return curr[key];
  }, obj);
  target[last] = value;
}

const DEFAULT_CONFIG: Record<string, unknown> = {
  gateway: {
    port: 18790,
    bind: 'loopback',
  },
  agents: {
    defaults: {
      model: 'claude-3-haiku-20240307',
    },
  },
  memory: {
    provider: 'openai',
    chunkTokens: 512,
    chunkOverlap: 64,
  },
  channels: {},
};

export function registerConfigCommand(program: Command): void {
  const config = program.command('config').description('Manage configuration');

  config
    .command('show')
    .description('Display current config (secrets redacted)')
    .action(async () => {
      const cfg = await loadConfig();
      const safe = redactSecrets(cfg);
      console.log(JSON.stringify(safe, null, 2));
    });

  config
    .command('get [key]')
    .description('Get configuration value')
    .action(async (key?: string) => {
      const cfg = await loadConfig();
      if (key) {
        const value = getNestedValue(cfg, key);
        console.log(JSON.stringify(redactValueAtPath(key, value), null, 2));
      } else {
        const safe = redactSecrets(cfg);
        console.log(JSON.stringify(safe, null, 2));
      }
    });

  config
    .command('set <key> <value>')
    .description('Set configuration value (supports dot-notation paths)')
    .action(async (key: string, value: string) => {
      const cfg = await loadConfigForMutation();
      let parsed: unknown = value;
      try {
        parsed = JSON.parse(value);
      } catch {}
      setNestedValue(cfg, key, parsed);
      await saveConfig(cfg);
      console.log(`Set ${key} = ${JSON.stringify(redactValueAtPath(key, parsed))}`);
    });

  config
    .command('reset')
    .description('Reset configuration to defaults')
    .option('--yes', 'Skip confirmation prompt')
    .action(async (options: { yes?: boolean }) => {
      if (!options.yes) {
        console.log('This will reset your configuration to defaults.');
        console.log('Run with --yes to confirm.');
        return;
      }
      await fs.rm(CONFIG_FILE_JSON5, { force: true });
      await saveConfig(DEFAULT_CONFIG);
      console.log('Configuration reset to defaults.');
    });

  config
    .command('validate')
    .description('Validate configuration against schema')
    .action(async () => {
      try {
        const cfg = await loadConfigForValidation();
        const unsupported = unsupportedConfigErrors(cfg);
        if (unsupported.length > 0) {
          console.log('Configuration validation failed:');
          for (const error of unsupported) console.log(`  - ${error}`);
          process.exitCode = 1;
          return;
        }
        const result = validateConfigSchema(cfg);
        if (!result.success) {
          console.log('Configuration validation failed:');
          for (const error of formatValidationErrors(result.error ?? 'Invalid config')) {
            console.log(`  - ${error}`);
          }
          process.exitCode = 1;
          return;
        }
        console.log('Configuration is valid.');
      } catch (error) {
        console.log('Configuration validation failed:');
        console.log(`  - ${(error as Error).message}`);
        process.exitCode = 1;
      }
    });

  config
    .command('edit')
    .description('Open configuration file in $EDITOR')
    .action(async () => {
      const editor = process.env.EDITOR
        || process.env.VISUAL
        || (process.platform === 'win32' ? 'notepad.exe' : 'vim');
      await fs.mkdir(CONFIG_DIR, { recursive: true });
      // Ensure file exists
      try {
        await fs.access(CONFIG_FILE);
      } catch {
        await saveConfig({});
      }
      try {
        const child = spawn(editor, [CONFIG_FILE], { stdio: 'inherit' });
        await new Promise<void>((resolve, reject) => {
          child.once('error', reject);
          child.once('close', (code) => {
            if (code === 0) resolve();
            else reject(new Error(`${editor} exited with status ${code ?? 'unknown'}`));
          });
        });
      } catch (error) {
        console.error(`Could not open config editor: ${(error as Error).message}`);
        process.exitCode = 1;
      }
    });
}
