import type { Command } from 'commander';
import { promises as fs } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { spawn } from 'child_process';

const CONFIG_DIR = join(homedir(), '.openrappter');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

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

function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce((curr: any, key) => curr?.[key], obj);
}

function setNestedValue(obj: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split('.');
  const last = keys.pop()!;
  const target = keys.reduce((curr: any, key) => {
    if (!(key in curr)) curr[key] = {};
    return curr[key];
  }, obj);
  target[last] = value;
}

export function registerConfigCommand(program: Command): void {
  const config = program.command('config').description('Manage configuration');

  config
    .command('get [key]')
    .description('Get configuration value')
    .action(async (key?: string) => {
      const cfg = await loadConfig();
      if (key) {
        const value = getNestedValue(cfg, key);
        console.log(JSON.stringify(value, null, 2));
      } else {
        console.log(JSON.stringify(cfg, null, 2));
      }
    });

  config
    .command('set <key> <value>')
    .description('Set configuration value')
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
    .command('edit')
    .description('Edit configuration file')
    .action(async () => {
      const editor = process.env.EDITOR || 'vim';
      await fs.mkdir(CONFIG_DIR, { recursive: true });
      const child = spawn(editor, [CONFIG_FILE], { stdio: 'inherit' });
      await new Promise((resolve) => child.on('close', resolve));
    });
}
