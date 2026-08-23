import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import {
  chmodSync,
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
 *
 * #159 registered config and doctor. This pass registers skills, agents,
 * models, update, gateway and the delegating rappterhub/clawhub. Four modules
 * remain deliberately unregistered — see the header of src/cli/index.ts for
 * why each of them would ship a command that lies.
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
    // Setting HOME alone is not enough: the data directory resolves through
    // OPENRAPPTER_HOME first, and this spreads process.env, so the suite-wide
    // temp home would otherwise be inherited and outrank the one under test.
    OPENRAPPTER_HOME: join(home, '.openrappter'),
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
  'skills',
  'agents',
  'models',
  'update',
  'gateway',
  'rappterhub',
  'clawhub',
  'memory',
  'clever-girl',
];

/**
 * Modules that stay unregistered on purpose.
 *
 * Without this list the next person to notice an exported-but-unreachable
 * module has no way to tell a decision from an oversight, and "make it
 * reachable" is the obvious wrong move for all of them.
 *
 * `memory` left this list in #204. It was here because the module built a
 * `MemoryManager`, which has no file I/O, so registering it would have shipped
 * an `add` that discarded what it stored. It now drives `MemoryAgent`, which is
 * the memory the product actually keeps, so reachable is no longer the wrong
 * move — the objection was to the implementation, not to the command existing.
 */
const DELIBERATELY_UNREGISTERED = ['send', 'login'];

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

  it.each(DELIBERATELY_UNREGISTERED)('does not register %s', (name) => {
    expect(commands).not.toContain(name);
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

  it('skills list reads the registry lock file the runtime installs into', () => {
    // The old implementation asked ClawHubClient, whose listInstalled() is
    // `return []`. It printed "(none)" over any number of installed skills.
    const home = mkdtempSync(join(tmpdir(), 'openrappter-skills-list-'));
    try {
      const skillsDir = join(home, '.openrappter', 'skills');
      mkdirSync(skillsDir, { recursive: true });
      writeFileSync(
        join(skillsDir, 'openrappter-skills.lock'),
        JSON.stringify({
          skills: [
            {
              manifest: {
                id: 'kody-w/rappterverse',
                name: 'rappterverse',
                version: '2.1.0',
                description: 'Installed on disk, invisible to the old command',
              },
              path: join(skillsDir, 'kody-w--rappterverse'),
              installedAt: '2026-01-01T00:00:00.000Z',
              enabled: true,
            },
          ],
        }),
      );

      const result = spawnSync(
        process.execPath,
        tsxArgs('skills', 'list', '--user'),
        { encoding: 'utf-8', env: isolatedHomeEnv(home), timeout: 120_000 },
      );

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('kody-w/rappterverse');
      expect(result.stdout).toContain('2.1.0');
      expect(result.stdout).not.toContain('(none)');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 180_000);

  it('skills install refuses a reference it cannot install instead of reporting success', () => {
    // ClawHubClient.install() wrote nothing and returned status 'success', and
    // the command printed "Successfully installed" and exited 0 over it.
    const home = mkdtempSync(join(tmpdir(), 'openrappter-skills-install-'));
    try {
      const result = spawnSync(
        process.execPath,
        tsxArgs('skills', 'install', 'not-a-repo-reference'),
        { encoding: 'utf-8', env: isolatedHomeEnv(home), timeout: 120_000 },
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('owner/repo');
      expect(`${result.stdout}${result.stderr}`).not.toMatch(/Successfully installed/);
      // Nothing was written for a reference that was never installable.
      expect(existsSync(join(home, '.openrappter', 'skills', 'openrappter-skills.lock')))
        .toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 180_000);

  it('skills install exits nonzero when the registry could not install it', () => {
    // Well-formed reference, unresolvable repo: `SkillsRegistry.install` logs
    // and returns null both offline and against a 404, and the command has to
    // treat that as a failure rather than fall off the end at exit 0.
    const home = mkdtempSync(join(tmpdir(), 'openrappter-skills-missing-'));
    try {
      const result = spawnSync(
        process.execPath,
        tsxArgs('skills', 'install', 'openrappter-tests/definitely-missing-skill-xyz'),
        { encoding: 'utf-8', env: isolatedHomeEnv(home), timeout: 120_000 },
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Failed to install skill');
      expect(`${result.stdout}${result.stderr}`).not.toMatch(/Successfully installed/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 180_000);

  it('models get reports the model the runtime resolves, not the shadowed file', () => {
    // hydrateManagedEnv copies .env into process.env only for keys that are
    // not already set, so an exported OPENRAPPTER_MODEL is what every model
    // read in the runtime sees. The command resolved the file first.
    const home = mkdtempSync(join(tmpdir(), 'openrappter-models-get-'));
    try {
      mkdirSync(join(home, '.openrappter'), { recursive: true });
      writeFileSync(
        join(home, '.openrappter', '.env'),
        'OPENRAPPTER_MODEL="model-from-file"\n',
      );

      const result = spawnSync(
        process.execPath,
        tsxArgs('models', 'get'),
        {
          encoding: 'utf-8',
          env: { ...isolatedHomeEnv(home), OPENRAPPTER_MODEL: 'model-from-environment' },
          timeout: 120_000,
        },
      );

      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe('model-from-environment');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 180_000);

  it('models set warns that an exported model still overrides what it just saved', () => {
    const home = mkdtempSync(join(tmpdir(), 'openrappter-models-set-'));
    try {
      const result = spawnSync(
        process.execPath,
        tsxArgs('models', 'set', 'claude-sonnet-4'),
        {
          encoding: 'utf-8',
          env: { ...isolatedHomeEnv(home), OPENRAPPTER_MODEL: 'model-from-environment' },
          timeout: 120_000,
        },
      );

      expect(result.status).toBe(0);
      // The file really was written…
      expect(readFileSync(join(home, '.openrappter', '.env'), 'utf-8'))
        .toContain('claude-sonnet-4');
      // …and is still ignored, which is the part the user has to be told.
      expect(result.stdout).toContain('OPENRAPPTER_MODEL is exported');
      expect(result.stdout).not.toContain('Restart the gateway');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 180_000);

  it('models set does not mistake its own hydrated .env for an exported override', () => {
    // index.ts calls hydrateManagedEnv() before parsing, so the file's value is
    // already in process.env when the action runs. A naive "process.env wins"
    // check warns about a shadow that does not exist, on every single set.
    const home = mkdtempSync(join(tmpdir(), 'openrappter-models-hydrated-'));
    try {
      mkdirSync(join(home, '.openrappter'), { recursive: true });
      writeFileSync(
        join(home, '.openrappter', '.env'),
        'OPENRAPPTER_MODEL="model-from-file"\nGITHUB_TOKEN="ghp_not_a_real_token"\n',
      );

      const env = { ...isolatedHomeEnv(home) };
      delete env.OPENRAPPTER_MODEL;

      const result = spawnSync(
        process.execPath,
        tsxArgs('models', 'set', 'claude-sonnet-4'),
        { encoding: 'utf-8', env, timeout: 120_000 },
      );

      expect(result.status).toBe(0);
      expect(result.stdout).not.toContain('OPENRAPPTER_MODEL is exported');
      expect(result.stdout).toContain('Restart the gateway');

      // Rewriting the file must not drop the other keys that live in it.
      const written = readFileSync(join(home, '.openrappter', '.env'), 'utf-8');
      expect(written).toContain('claude-sonnet-4');
      expect(written).toContain('GITHUB_TOKEN');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 180_000);

  it('rappterhub hands its arguments to the Python runtime and returns its exit code', () => {
    const home = mkdtempSync(join(tmpdir(), 'openrappter-hub-delegate-'));
    try {
      const pyHome = join(home, 'runtime');
      mkdirSync(join(pyHome, 'python', 'openrappter'), { recursive: true });
      writeFileSync(join(pyHome, 'python', 'openrappter', 'cli.py'), '');
      mkdirSync(join(pyHome, '.venv', 'bin'), { recursive: true });
      const stub = join(pyHome, '.venv', 'bin', 'python');
      writeFileSync(stub, '#!/bin/sh\necho "ARGV: $*"\nexit 7\n');
      chmodSync(stub, 0o755);

      const result = spawnSync(
        process.execPath,
        tsxArgs('rappterhub', 'install', 'kody-w/git-helper', '--force'),
        {
          encoding: 'utf-8',
          env: { ...isolatedHomeEnv(home), OPENRAPPTER_HOME: pyHome },
          timeout: 120_000,
        },
      );

      expect(result.stdout).toContain(
        'ARGV: -m openrappter.cli rappterhub install kody-w/git-helper --force',
      );
      // Not 0: a failed install must not read as a successful one just because
      // the delegation itself worked.
      expect(result.status).toBe(7);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 180_000);

  it('clawhub says the runtime is missing instead of answering as the chat model', () => {
    // Before registration these words were a chat prompt: `openrappter
    // rappterhub list` reached the agent and exited 0.
    const home = mkdtempSync(join(tmpdir(), 'openrappter-hub-missing-'));
    try {
      const result = spawnSync(
        process.execPath,
        tsxArgs('clawhub', 'list'),
        {
          encoding: 'utf-8',
          env: { ...isolatedHomeEnv(home), OPENRAPPTER_HOME: join(home, 'nowhere') },
          timeout: 120_000,
        },
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Python runtime');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 180_000);

  it('gateway is the daemon runtime, not a second one', () => {
    const home = mkdtempSync(join(tmpdir(), 'openrappter-gateway-help-'));
    try {
      const result = spawnSync(
        process.execPath,
        tsxArgs('gateway', '--help'),
        { encoding: 'utf-8', env: isolatedHomeEnv(home), timeout: 120_000 },
      );

      expect(result.status).toBe(0);
      expect(result.stdout).toMatch(/Usage: .*gateway/);
      expect(result.stdout).toContain('--daemon');
      // The abandoned cli/gateway.ts advertised these; the bare GatewayServer
      // it started had no Assistant and no agent handler behind them.
      expect(result.stdout).not.toContain('--bind');
      expect(result.stdout).not.toContain('--token');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 180_000);
});
