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
import { join } from 'path';
import { homedir } from 'os';
import { spawn } from 'child_process';

const CONFIG_DIR = join(homedir(), '.openrappter');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

/** Fields whose values should be redacted in display output */
const SECRET_KEY_PATTERNS = ['token', 'password', 'key', 'secret', 'apikey', 'api_key'];

async function loadConfig(): Promise<Record<string, unknown>> {
  try {
    const data = await fs.readFile(CONFIG_FILE, 'utf-8');
    return JSON.parse(data);
  } catch {
    return {};
  }
}

async function saveConfig(config: Record<string, unknown>): Promise<void> {
  await fs.mkdir(CONFIG_DIR, { recursive: true });
  await fs.writeFile(CONFIG_FILE, JSON.stringify(config, null, 2));
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

/**
 * Recursively redact secret values in a config object for safe display.
 */
export function redactSecrets(obj: unknown, depth = 0): unknown {
  if (depth > 10) return obj;
  if (typeof obj !== 'object' || obj === null) return obj;
  if (Array.isArray(obj)) return obj.map((v) => redactSecrets(v, depth + 1));

  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const keyLower = k.toLowerCase();
    const isSecret = SECRET_KEY_PATTERNS.some((p) => keyLower.includes(p));
    if (isSecret && typeof v === 'string' && v.length > 0) {
      result[k] = '***REDACTED***';
    } else {
      result[k] = redactSecrets(v, depth + 1);
    }
  }
  return result;
}

const DEFAULT_CONFIG: Record<string, unknown> = {
  gateway: {
    port: 18790,
    host: '127.0.0.1',
  },
  agent: {
    model: 'claude-3-haiku-20240307',
    maxTokens: 4096,
  },
  memory: {
    chunkSize: 512,
    chunkOverlap: 50,
  },
  channels: {},
};

/**
 * Validate a config object against known schema rules.
 * Returns an array of validation error messages (empty = valid).
 */
function validateConfig(cfg: Record<string, unknown>): string[] {
  const errors: string[] = [];

  const gateway = cfg.gateway as any;
  if (gateway?.port !== undefined) {
    const port = Number(gateway.port);
    if (isNaN(port) || port < 1 || port > 65535) {
      errors.push('gateway.port must be a valid port number (1-65535)');
    }
  }

  const agent = cfg.agent as any;
  if (agent?.maxTokens !== undefined && typeof agent.maxTokens !== 'number') {
    errors.push('agent.maxTokens must be a number');
  }

  const memory = cfg.memory as any;
  if (memory?.chunkSize !== undefined && (typeof memory.chunkSize !== 'number' || memory.chunkSize < 1)) {
    errors.push('memory.chunkSize must be a positive number');
  }

  return errors;
}

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
        console.log(JSON.stringify(value, null, 2));
      } else {
        const safe = redactSecrets(cfg);
        console.log(JSON.stringify(safe, null, 2));
      }
    });

  config
    .command('set <key> <value>')
    .description('Set configuration value (supports dot-notation paths)')
    .action(async (key: string, value: string) => {
      const cfg = await loadConfig();
      let parsed: unknown = value;
      try {
        parsed = JSON.parse(value);
      } catch {}
      setNestedValue(cfg, key, parsed);
      await saveConfig(cfg);
      console.log(`Set ${key} = ${JSON.stringify(parsed)}`);
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
      await saveConfig(DEFAULT_CONFIG);
      console.log('Configuration reset to defaults.');
    });

  config
    .command('validate')
    .description('Validate configuration against schema')
    .action(async () => {
      const cfg = await loadConfig();
      const errors = validateConfig(cfg);
      if (errors.length === 0) {
        console.log('Configuration is valid.');
      } else {
        console.log('Configuration validation failed:');
        for (const err of errors) {
          console.log(`  - ${err}`);
        }
        process.exit(1);
      }
    });

  config
    .command('edit')
    .description('Open configuration file in $EDITOR')
    .action(async () => {
      const editor = process.env.EDITOR || 'vim';
      await fs.mkdir(CONFIG_DIR, { recursive: true });
      // Ensure file exists
      try {
        await fs.access(CONFIG_FILE);
      } catch {
        await saveConfig({});
      }
      const child = spawn(editor, [CONFIG_FILE], { stdio: 'inherit' });
      await new Promise((resolve) => child.on('close', resolve));
    });
}
