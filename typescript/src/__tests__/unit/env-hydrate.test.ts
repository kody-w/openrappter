/**
 * Regression tests for kody-w/openrappter#44.
 *
 * The `openrappter` wrapper sources `~/.openrappter/.env` before exec, so every
 * interactive command sees it. launchd runs `node` directly with a fixed
 * environment (`HOME`, `PATH`, `NODE_ENV`, `OPENRAPPTER_LAUNCHD`), so a
 * supervised gateway started with none of it — the Copilot provider had no
 * credential and the iMessage model preflight failed forever, while `diagnose`
 * (running under the wrapper) reported `Copilot token: configured`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

import { hydrateManagedEnv } from '../../env.js';

let dir: string;
let envFile: string;
const TOUCHED = ['COPILOT_GITHUB_TOKEN', 'OPENRAPPTER_MODEL', 'OPENRAPPTER_PORT'];
let saved: Record<string, string | undefined>;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'openrappter-env-'));
  envFile = path.join(dir, '.env');
  saved = Object.fromEntries(TOUCHED.map(k => [k, process.env[k]]));
  for (const k of TOUCHED) delete process.env[k];
});

afterEach(async () => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await fs.rm(dir, { recursive: true, force: true });
});

describe('hydrateManagedEnv', () => {
  it('applies .env values that launchd would never have supplied', async () => {
    await fs.writeFile(envFile, 'COPILOT_GITHUB_TOKEN=ghu_example\nOPENRAPPTER_MODEL=gpt-5.6-sol\n');

    const applied = await hydrateManagedEnv(envFile);

    expect(process.env.COPILOT_GITHUB_TOKEN).toBe('ghu_example');
    expect(process.env.OPENRAPPTER_MODEL).toBe('gpt-5.6-sol');
    expect(applied.sort()).toEqual(['COPILOT_GITHUB_TOKEN', 'OPENRAPPTER_MODEL']);
  });

  it('never overrides a variable that is already exported', async () => {
    process.env.OPENRAPPTER_MODEL = 'already-set';
    await fs.writeFile(envFile, 'OPENRAPPTER_MODEL=from-file\nOPENRAPPTER_PORT=19999\n');

    const applied = await hydrateManagedEnv(envFile);

    expect(process.env.OPENRAPPTER_MODEL).toBe('already-set');
    expect(process.env.OPENRAPPTER_PORT).toBe('19999');
    expect(applied).toEqual(['OPENRAPPTER_PORT']);
  });

  it('is a no-op when there is no .env, rather than throwing', async () => {
    await expect(hydrateManagedEnv(path.join(dir, 'absent.env'))).resolves.toEqual([]);
    expect(process.env.COPILOT_GITHUB_TOKEN).toBeUndefined();
  });

  it('reports nothing applied when every key is already present', async () => {
    process.env.COPILOT_GITHUB_TOKEN = 'exported';
    await fs.writeFile(envFile, 'COPILOT_GITHUB_TOKEN=from-file\n');

    expect(await hydrateManagedEnv(envFile)).toEqual([]);
    expect(process.env.COPILOT_GITHUB_TOKEN).toBe('exported');
  });

  it('makes the credential resolvable exactly as the provider looks for it', async () => {
    // CopilotCliProvider reads these keys, in this order, from process.env.
    const TOKEN_ENV_KEYS = ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'];
    expect(TOKEN_ENV_KEYS.some(k => process.env[k])).toBe(false);

    await fs.writeFile(envFile, 'COPILOT_GITHUB_TOKEN=ghu_example\n');
    await hydrateManagedEnv(envFile);

    expect(TOKEN_ENV_KEYS.some(k => process.env[k])).toBe(true);
  });
});
