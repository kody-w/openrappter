import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createRequire } from 'module';

/**
 * What the CLI actually exposes, asked of the CLI.
 *
 * The neighbouring cli-commands.test.ts reads the source files instead. That
 * is why twelve fully implemented command modules under src/cli could sit
 * unregistered without a single test going red: the files were present and
 * exported, and nothing ever asked the program what it had registered.
 */

const ENTRY = join(__dirname, '../../index.ts');
const TSX_CLI = createRequire(import.meta.url).resolve('tsx/cli');

function tsxArgs(...args: string[]): string[] {
  return [TSX_CLI, ENTRY, ...args];
}

function isolatedHomeEnv(home: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
  };
}

/** Commands the CLI is known to expose. Each is asserted individually. */
const REGISTERED = [
  'onboard',
  'service',
  'imessage',
  'reset',
  'bar',
  'channel',
  'call',
  'twin',
  'cron',
  'config',
  'doctor',
];

let commands: string[];

function parseCommands(help: string): string[] {
  const section = help.slice(help.indexOf('Commands:'));
  return section
    .split('\n')
    .slice(1)
    .map((line) => line.match(/^\s{2}([a-z][a-z-]*)/)?.[1])
    .filter((name): name is string => Boolean(name));
}

beforeAll(() => {
  // A throwaway HOME so nothing here can read or write the real config.
  const home = mkdtempSync(join(tmpdir(), 'openrappter-cli-'));
  const help = execFileSync(
    process.execPath,
    tsxArgs('--help'),
    { encoding: 'utf-8', env: isolatedHomeEnv(home), timeout: 120_000 },
  );
  commands = parseCommands(help);
}, 180_000);

describe('CLI command registration, observed from outside', () => {
  it.each(REGISTERED)('registers %s', (name) => {
    expect(commands).toContain(name);
  });

  it('parses a plausible command list at all', () => {
    // Guards the parser above: if --help changed shape, every assertion in
    // this file would pass vacuously against an empty list.
    expect(commands.length).toBeGreaterThanOrEqual(REGISTERED.length);
  });

  it('config validate reads the JSON5 source the runtime reads', () => {
    const home = mkdtempSync(join(tmpdir(), 'openrappter-config-command-'));
    try {
      const configDir = join(home, '.openrappter');
      mkdirSync(configDir, { recursive: true });
      writeFileSync(
        join(configDir, 'config.json5'),
        '{ gateway: { port: 70000, }, }',
      );

      const result = spawnSync(
        process.execPath,
        tsxArgs('config', 'validate'),
        {
          encoding: 'utf-8',
          env: isolatedHomeEnv(home),
          timeout: 120_000,
        },
      );

      expect(result.status).toBe(1);
      expect(result.stdout).toContain('gateway.port');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 180_000);

  it('config validate rejects malformed JSON5 instead of calling it empty and valid', () => {
    const home = mkdtempSync(join(tmpdir(), 'openrappter-config-malformed-'));
    try {
      const configDir = join(home, '.openrappter');
      mkdirSync(configDir, { recursive: true });
      writeFileSync(join(configDir, 'config.json5'), '{ gateway: {');

      const result = spawnSync(
        process.execPath,
        tsxArgs('config', 'validate'),
        {
          encoding: 'utf-8',
          env: isolatedHomeEnv(home),
          timeout: 120_000,
        },
      );

      expect(result.status).toBe(1);
      expect(result.stdout).toContain('Cannot parse');
      expect(result.stdout).toContain('config.json5');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 180_000);

  it('config set writes only the JSON override, not the resolved JSON5 merge', () => {
    const home = mkdtempSync(join(tmpdir(), 'openrappter-config-set-'));
    try {
      const configDir = join(home, '.openrappter');
      mkdirSync(configDir, { recursive: true });
      writeFileSync(
        join(configDir, 'config.json5'),
        '{ gateway: { bind: "all" }, channels: { sms: { enabled: true } } }',
      );

      const result = spawnSync(
        process.execPath,
        tsxArgs('config', 'set', 'gateway.port', '19000'),
        {
          encoding: 'utf-8',
          env: isolatedHomeEnv(home),
          timeout: 120_000,
        },
      );

      expect(result.status).toBe(0);
      const written = JSON.parse(
        readFileSync(join(configDir, 'config.json'), 'utf8'),
      ) as Record<string, unknown>;
      expect(written).toEqual({ gateway: { port: 19000 } });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 180_000);

  it('config get and set never echo a credential value', () => {
    const home = mkdtempSync(join(tmpdir(), 'openrappter-config-secrets-'));
    const secret = ['never', 'print', 'this', 'value'].join('-');
    try {
      const configDir = join(home, '.openrappter');
      mkdirSync(configDir, { recursive: true });

      const set = spawnSync(
        process.execPath,
        tsxArgs('config', 'set', 'channels.telegram.token', secret),
        {
          encoding: 'utf-8',
          env: isolatedHomeEnv(home),
          timeout: 120_000,
        },
      );
      expect(set.status).toBe(0);
      expect(set.stdout).not.toContain(secret);
      expect(set.stdout).toContain('REDACTED');

      const get = spawnSync(
        process.execPath,
        tsxArgs('config', 'get', 'channels.telegram.token'),
        {
          encoding: 'utf-8',
          env: isolatedHomeEnv(home),
          timeout: 120_000,
        },
      );
      expect(get.status).toBe(0);
      expect(get.stdout).not.toContain(secret);
      expect(get.stdout).toContain('REDACTED');

      const persisted = JSON.parse(
        readFileSync(join(configDir, 'config.json'), 'utf8'),
      ) as { channels: { telegram: { token: string } } };
      expect(persisted.channels.telegram.token).toBe(secret);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 180_000);

  it('config reset clears JSON5 settings instead of leaving them active', () => {
    const home = mkdtempSync(join(tmpdir(), 'openrappter-config-reset-'));
    try {
      const configDir = join(home, '.openrappter');
      mkdirSync(configDir, { recursive: true });
      const json5Path = join(configDir, 'config.json5');
      writeFileSync(json5Path, '{ channels: { sms: { enabled: true } } }');

      const result = spawnSync(
        process.execPath,
        tsxArgs('config', 'reset', '--yes'),
        {
          encoding: 'utf-8',
          env: isolatedHomeEnv(home),
          timeout: 120_000,
        },
      );

      expect(result.status).toBe(0);
      expect(existsSync(json5Path)).toBe(false);
      expect(existsSync(join(configDir, 'config.json'))).toBe(true);

      const validate = spawnSync(
        process.execPath,
        tsxArgs('config', 'validate'),
        {
          encoding: 'utf-8',
          env: isolatedHomeEnv(home),
          timeout: 120_000,
        },
      );
      expect(validate.status).toBe(0);
      expect(validate.stdout).toContain('Configuration is valid');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 180_000);

  it('config validate rejects reset-era keys the runtime does not consume', () => {
    const home = mkdtempSync(join(tmpdir(), 'openrappter-config-legacy-'));
    try {
      const configDir = join(home, '.openrappter');
      mkdirSync(configDir, { recursive: true });
      writeFileSync(
        join(configDir, 'config.json'),
        JSON.stringify({
          agent: { maxTokens: 'bad' },
          gateway: { host: '0.0.0.0' },
          memory: { chunkSize: -1 },
        }),
      );

      const result = spawnSync(
        process.execPath,
        tsxArgs('config', 'validate'),
        {
          encoding: 'utf-8',
          env: isolatedHomeEnv(home),
          timeout: 120_000,
        },
      );

      expect(result.status).toBe(1);
      expect(result.stdout).toContain('agents.defaults');
      expect(result.stdout).toContain('gateway.bind');
      expect(result.stdout).toContain('memory.chunkTokens');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 180_000);

  it('config edit reports a missing editor instead of crashing', () => {
    const home = mkdtempSync(join(tmpdir(), 'openrappter-config-editor-'));
    try {
      const result = spawnSync(
        process.execPath,
        tsxArgs('config', 'edit'),
        {
          encoding: 'utf-8',
          env: {
            ...isolatedHomeEnv(home),
            EDITOR: 'openrappter-editor-that-does-not-exist',
          },
          timeout: 120_000,
        },
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Could not open config editor');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 180_000);

  it('doctor --help reaches the doctor command and advertises JSON output', () => {
    const home = mkdtempSync(join(tmpdir(), 'openrappter-doctor-command-'));
    try {
      const result = spawnSync(
        process.execPath,
        tsxArgs('doctor', '--help'),
        {
          encoding: 'utf-8',
          env: isolatedHomeEnv(home),
          timeout: 120_000,
        },
      );

      expect(result.status).toBe(0);
      expect(result.stdout).toMatch(/Usage: .*doctor/);
      expect(result.stdout).toContain('--json');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 180_000);
});
