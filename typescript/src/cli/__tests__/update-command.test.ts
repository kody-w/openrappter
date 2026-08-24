/**
 * `openrappter update` — behaviour when the registry cannot be reached.
 *
 * `checkForUpdate` catches every failure and returns `hasUpdate: false,
 * latestVersion: currentVersion`. The command read that as "up to date" and
 * printed "You are using the latest version." with exit 0 — the same answer a
 * genuinely current install gets, and the wrong one to give someone offline on
 * a version with a fix in it.
 *
 * fetch is stubbed rather than reached, so this proves the branch without a
 * network.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { Command } from 'commander';

const ringMocks = vi.hoisted(() => ({
  selectRing: vi.fn(() => 'stable'),
  resolveRing: vi.fn(async () => ({
    ring: 'stable',
    version: '1.9.8',
    source: { commit: 'a'.repeat(40) },
    artifact: { install_url: 'https://registry.npmjs.org/openrappter/-/openrappter-1.9.8.tgz' },
  })),
}));
vi.mock('../../release-rings.js', () => ringMocks);

import { registerUpdateCommand } from '../update.js';
import { checkForUpdate } from '../../infra/update-check.js';

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number | undefined;
}

async function runUpdate(args: string[]): Promise<RunResult> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  let exitCode: number | undefined;

  const logSpy = vi.spyOn(console, 'log').mockImplementation((...a) => {
    stdout.push(a.join(' '));
  });
  const errSpy = vi.spyOn(console, 'error').mockImplementation((...a) => {
    stderr.push(a.join(' '));
  });
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exitCode = code;
    throw new Error('__exit__');
  }) as never);

  const program = new Command();
  program.exitOverride();
  registerUpdateCommand(program);

  try {
    await program.parseAsync(['node', 'openrappter', 'update', ...args]);
  } catch (err) {
    if ((err as Error).message !== '__exit__') throw err;
  } finally {
    logSpy.mockRestore();
    errSpy.mockRestore();
    exitSpy.mockRestore();
  }

  return { stdout: stdout.join('\n'), stderr: stderr.join('\n'), exitCode };
}

afterEach(() => {
  vi.unstubAllGlobals();
  ringMocks.selectRing.mockReset().mockReturnValue('stable');
  ringMocks.resolveRing.mockReset().mockResolvedValue({
    ring: 'stable',
    version: '1.9.8',
    source: { commit: 'a'.repeat(40) },
    artifact: { install_url: 'https://registry.npmjs.org/openrappter/-/openrappter-1.9.8.tgz' },
  });
});

describe('checkForUpdate', () => {
  it('reports that it could not check rather than inventing a version', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('getaddrinfo ENOTFOUND')));

    const result = await checkForUpdate('1.13.0');

    expect(result.checked).toBe(false);
    expect(result.error).toContain('ENOTFOUND');
    expect(result.hasUpdate).toBe(false);
  });

  it('marks a real answer as checked', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ version: '1.14.0' }) }),
    );

    const result = await checkForUpdate('1.13.0');

    expect(result.checked).toBe(true);
    expect(result.hasUpdate).toBe(true);
    expect(result.latestVersion).toBe('1.14.0');
  });

  it('does not accept a registry response with no version', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));

    const result = await checkForUpdate('1.13.0');

    expect(result.checked).toBe(false);
  });
});

describe('update command', () => {
  it('always resolves the effective persisted/default ring even without --ring', async () => {
    ringMocks.selectRing.mockReturnValue('beta');
    const result = await runUpdate([]);
    expect(result.exitCode).toBeUndefined();
    expect(ringMocks.selectRing).toHaveBeenCalledWith({ cliRing: undefined });
    expect(ringMocks.resolveRing).toHaveBeenCalledWith('beta', expect.anything());
  });

  it('fails nonzero when the effective ring cannot be resolved', async () => {
    ringMocks.resolveRing.mockRejectedValueOnce(new Error('immutable receipt unreachable'));
    const result = await runUpdate([]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('immutable receipt unreachable');
  });

  it('emits the exact resolved identity as JSON', async () => {
    const result = await runUpdate(['--json']);
    expect(result.exitCode).toBeUndefined();
    expect(JSON.parse(result.stdout).version).toBe('1.9.8');
  });

  it('passes explicit CLI ring into the shared precedence resolver', async () => {
    await runUpdate(['--ring', 'alpha', '--allow-downgrade']);
    expect(ringMocks.selectRing).toHaveBeenCalledWith({ cliRing: 'alpha' });
    expect(ringMocks.resolveRing).toHaveBeenCalledWith(
      'stable',
      expect.objectContaining({ allowDowngrade: true }),
    );
  });
});
