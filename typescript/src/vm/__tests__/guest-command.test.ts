import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { guestExecCommand } from '../tart-vm-supervisor.js';

const execute = promisify(execFile);
let directory: string;
let base: string;
let outside: string;

// Exercise the actual two-shell contract on Unix, without SSH or a VM.
// macOS's BSD realpath requires existing paths without GNU's explicit -e.
describe.skipIf(process.platform === 'win32')('guest shell argument and physical cwd contract', () => {
  beforeEach(async () => {
    const root = path.join(process.cwd(), '.test-scratch');
    await fs.mkdir(root, { recursive: true });
    directory = await fs.mkdtemp(path.join(root, "guest's workspace-"));
    base = path.join(directory, 'workspaces', 'agent-a', 'project-1');
    outside = `${base}-other`;
    await fs.mkdir(path.join(base, 'src'), { recursive: true });
    await fs.mkdir(outside);
  });
  afterEach(async () => { await fs.rm(directory, { recursive: true, force: true }); });

  async function guest(cwd: string, argv: string[]) {
    const original = guestExecCommand(base, cwd, argv);
    const command = process.platform === 'darwin'
      ? original.replaceAll('/usr/bin/realpath -e --', '/bin/realpath --')
      : original;
    try {
      const { stdout, stderr } = await execute('/bin/sh', ['-c', command], {
        cwd: directory, timeout: 2000, env: { PATH: '/usr/bin:/bin' },
      });
      return { stdout, stderr, exitCode: 0 };
    } catch (error) {
      const failure = error as { stdout: string; stderr: string; code: number };
      return { stdout: failure.stdout, stderr: failure.stderr, exitCode: failure.code };
    }
  }

  const printCwd = [process.execPath, '-e', 'process.stdout.write(process.cwd())'];

  it('starts in the requested physical subdirectory', async () => {
    expect(await guest(path.join(base, 'src'), printCwd)).toMatchObject({
      stdout: path.join(base, 'src'), exitCode: 0,
    });
  });

  it('passes quotes, substitutions, operators and globs as literal argv data', async () => {
    const args = ["a'b", '$(echo INJECTED)', '`echo INJECTED`', 'a; echo INJECTED', '*', 'a b', '-oProxyCommand=echo'];
    const response = await guest(base, [process.execPath, '-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', '--', ...args]);
    expect(response.exitCode).toBe(0);
    expect(JSON.parse(response.stdout)).toEqual(args);
  });

  it('fails a missing directory instead of executing in the guest home', async () => {
    const response = await guest(path.join(base, 'missing'), printCwd);
    expect(response.exitCode).toBe(125);
    expect(response.stdout).toBe('');
  });

  it('rejects siblings and a symlink that escapes the workspace', async () => {
    await fs.symlink(outside, path.join(base, 'escape'));
    for (const cwd of [outside, path.join(base, 'escape')]) {
      const response = await guest(cwd, printCwd);
      expect(response.exitCode).toBe(126);
      expect(response.stdout).toBe('');
    }
  });

  it('rejects a symlinked identity root, but accepts an in-workspace directory symlink', async () => {
    await fs.symlink(path.join(base, 'src'), path.join(base, 'inside'));
    expect(await guest(path.join(base, 'inside'), printCwd)).toMatchObject({ stdout: path.join(base, 'src'), exitCode: 0 });
    await fs.rm(base, { recursive: true });
    await fs.symlink(outside, base);
    expect(await guest(base, printCwd)).toMatchObject({ stdout: '', exitCode: 126 });
  });
});
