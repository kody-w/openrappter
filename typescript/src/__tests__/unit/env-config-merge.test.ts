/**
 * Regression tests for kody-w/openrappter#43.
 *
 * `config/loader.ts` (schema-validated) reads `config.json5`, while every
 * consumer going through `env.ts` reads `config.json`. Configuration written to
 * `config.json5` — which is the file the Zod schema describes — was silently
 * discarded, so `channels.imessage` could never be enabled that way and
 * `install-service` told the user to set what they had already set.
 *
 * `config.json` still wins every conflict, so an install that already worked
 * cannot change behaviour.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

let home: string;
let originalHome: string | undefined;

/** Import env.ts fresh so its module-level path constants see the temp HOME. */
async function freshEnv() {
  const { resetModules } = await import('vitest').then(m => ({ resetModules: m.vi.resetModules }));
  resetModules();
  return import('../../env.js');
}

async function writeConfig(name: string, body: string) {
  await fs.writeFile(path.join(home, name), body, 'utf-8');
}

beforeEach(async () => {
  originalHome = process.env.HOME;
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'openrappter-cfg-'));
  // os.homedir() honours $HOME on POSIX, so this relocates HOME_DIR/CONFIG_FILE.
  process.env.HOME = home;
  // The data directory resolves OPENRAPPTER_HOME before HOME, and the
  // suite sets it globally (vitest.setup.ts), so redirecting HOME alone
  // would leave this test pointed at the shared temp home.
  process.env.OPENRAPPTER_HOME = `${home}/.openrappter`;
  await fs.mkdir(path.join(home, '.openrappter'), { recursive: true });
  home = path.join(home, '.openrappter');
});

afterEach(async () => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  await fs.rm(path.dirname(home), { recursive: true, force: true });
});

describe('loadConfig merges config.json5 without displacing config.json', () => {
  it('still returns config.json alone when it is the only file', async () => {
    await writeConfig('config.json', JSON.stringify({ setupComplete: true }));
    const env = await freshEnv();
    expect(await env.loadConfig()).toEqual({ setupComplete: true });
  });

  it('no longer discards config written to config.json5 (the bug)', async () => {
    await writeConfig('config.json', JSON.stringify({ setupComplete: true }));
    await writeConfig(
      'config.json5',
      `{
        // the Zod schema describes this file
        channels: { imessage: { enabled: true, allowFrom: ['+15551234567'] } },
      }`,
    );
    const env = await freshEnv();
    const cfg = await env.loadConfig() as Record<string, any>;

    expect(cfg.channels.imessage.enabled).toBe(true);
    expect(cfg.channels.imessage.allowFrom).toEqual(['+15551234567']);
    expect(cfg.setupComplete).toBe(true);
  });

  it('works when only config.json5 exists', async () => {
    await writeConfig('config.json5', `{ channels: { imessage: { enabled: true } } }`);
    const env = await freshEnv();
    const cfg = await env.loadConfig() as Record<string, any>;
    expect(cfg.channels.imessage.enabled).toBe(true);
  });

  it('lets config.json win every conflict, so working installs cannot change', async () => {
    await writeConfig('config.json', JSON.stringify({
      channels: { imessage: { enabled: true, allowFrom: ['+15550000000'] } },
    }));
    await writeConfig('config.json5', `{
      channels: { imessage: { enabled: false, allowFrom: ['+15551111111'], mode: 'applescript' } },
    }`);
    const env = await freshEnv();
    const cfg = await env.loadConfig() as Record<string, any>;

    expect(cfg.channels.imessage.enabled).toBe(true);
    expect(cfg.channels.imessage.allowFrom).toEqual(['+15550000000']);
    // non-conflicting keys from config.json5 still fill in
    expect(cfg.channels.imessage.mode).toBe('applescript');
  });

  it('survives a malformed config.json5 rather than taking the runtime down', async () => {
    await writeConfig('config.json', JSON.stringify({ setupComplete: true }));
    await writeConfig('config.json5', '{ this is not valid json5 ');
    const env = await freshEnv();
    await expect(env.loadConfig()).resolves.toEqual({ setupComplete: true });
  });

  it('reads only the given file when an explicit path is passed', async () => {
    await writeConfig('config.json5', `{ channels: { imessage: { enabled: true } } }`);
    await writeConfig('other.json', JSON.stringify({ only: 'this' }));
    const env = await freshEnv();
    expect(await env.loadConfig(path.join(home, 'other.json'))).toEqual({ only: 'this' });
  });

  it('reports which config files actually contributed', async () => {
    await writeConfig('config.json', JSON.stringify({ a: 1 }));
    const env = await freshEnv();
    expect(await env.resolvedConfigSources()).toEqual([env.CONFIG_FILE]);

    await writeConfig('config.json5', '{ b: 2 }');
    expect(await env.resolvedConfigSources()).toEqual([env.CONFIG_FILE_JSON5, env.CONFIG_FILE]);
  });
});
