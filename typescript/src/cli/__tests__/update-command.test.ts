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
  it('does not claim you are up to date when the check never happened', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('getaddrinfo ENOTFOUND')));

    const result = await runUpdate([]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Could not check for updates');
    expect(`${result.stdout}${result.stderr}`).not.toContain('latest version');
  });

  it('exits nonzero in JSON mode too, the way doctor does', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));

    const result = await runUpdate(['--json']);

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout).checked).toBe(false);
  });

  it('says you are up to date only when the registry actually said so', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ version: '0.0.1' }) }),
    );

    const result = await runUpdate([]);

    expect(result.exitCode).toBeUndefined();
    expect(result.stdout).toContain('You are using the latest version.');
  });

  /**
   * `backup.create` was documented as auto-running before updates. It never
   * did — nothing called it, and updating is a manual `npm install -g`, so
   * there is no in-product step it could have hung off. Since the product
   * cannot snapshot for you, the moment it tells you to change the
   * installation is where it should say a snapshot is possible.
   */
  it('points at a backup when it offers an update', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ version: '999.0.0' }) }),
    );

    const result = await runUpdate([]);

    expect(result.stdout).toContain('A new version is available!');
    expect(result.stdout).toContain('openrappter backup create');
  });

  it('does not mention backups when there is nothing to update to', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ version: '0.0.1' }) }),
    );

    const result = await runUpdate([]);

    expect(result.stdout).not.toContain('openrappter backup create');
  });
});
