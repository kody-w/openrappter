import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NodeVmCommandRunner } from '../command-runner.js';
import { guestExecCommand } from '../tart-vm-supervisor.js';

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  signals: string[] = [];
  kill(signal: string) {
    this.signals.push(signal);
    this.emit('close', null, signal);
    return true;
  }
}

function runnerFixture() {
  const child = new FakeChild();
  const spawn = vi.fn((_file: string, _argv: string[], _options: SpawnOptions) => {
    queueMicrotask(() => child.emit('spawn'));
    return child as unknown as ChildProcess;
  });
  return { child, spawn, runner: new NodeVmCommandRunner(spawn) };
}

afterEach(() => { vi.useRealTimers(); });

describe('Node command runner adapter', () => {
  it('spawns an argv vector without shell, forwarding, detachment, or arbitrary inherited env', async () => {
    const { runner, child, spawn } = runnerFixture();
    const process = await runner.spawn('/opt/homebrew/bin/tart', ['run', 'rapp-work-omarchy']);
    expect(spawn).toHaveBeenCalledWith('/opt/homebrew/bin/tart', ['run', 'rapp-work-omarchy'], expect.objectContaining({
      shell: false, detached: false, stdio: ['ignore', 'pipe', 'pipe'],
    }));
    const environment = spawn.mock.calls[0][2].env!;
    expect(Object.keys(environment).sort()).toEqual(['HOME', 'LANG', 'LC_ALL', 'PATH']);
    child.emit('close', 0, null);
    expect(await process.exited).toMatchObject({ exitCode: 0 });
  });

  it('bounds combined output without dropping the exit status', async () => {
    const { runner, child } = runnerFixture();
    const process = await runner.spawn('/opt/homebrew/bin/tart', ['list']);
    child.stdout.write(Buffer.alloc(100_000, 'x'));
    child.stderr.write(Buffer.alloc(100_000, 'y'));
    child.emit('close', 7, null);
    const result = await process.exited;
    expect(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(65536);
    expect(result).toMatchObject({ exitCode: 7, truncated: true });
  });

  it('reports a bounded timeout and signals only its child', async () => {
    vi.useFakeTimers();
    const { runner, child } = runnerFixture();
    const completed = runner.run('/usr/bin/ssh', ['guest', '/usr/bin/true'], { timeoutMs: 100 });
    await vi.advanceTimersByTimeAsync(101);
    expect(await completed).toMatchObject({ timedOut: true, signal: 'SIGKILL', exitCode: null });
    expect(child.signals).toEqual(['SIGKILL']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('honors cancellation both before and during spawn and removes its timers', async () => {
    const { runner, child, spawn } = runnerFixture();
    const controller = new AbortController();
    controller.abort();
    expect(await runner.run('/usr/bin/ssh', [], { timeoutMs: 100, signal: controller.signal })).toMatchObject({ aborted: true });
    expect(spawn).not.toHaveBeenCalled();
    const other = new AbortController();
    const completed = runner.run('/usr/bin/ssh', [], { timeoutMs: 1000, signal: other.signal });
    other.abort();
    expect(await completed).toMatchObject({ aborted: true, signal: 'SIGKILL' });
    expect(child.signals).toEqual(['SIGKILL']);
  });

  it('propagates missing binary errors without converting them into successful exits', async () => {
    const child = new FakeChild();
    const runner = new NodeVmCommandRunner(() => {
      queueMicrotask(() => {
        child.emit('error', Object.assign(new Error('missing'), { code: 'ENOENT' }));
        child.emit('close', -2, null);
      });
      return child as unknown as ChildProcess;
    });
    await expect(runner.run('/missing/tart', [], { timeoutMs: 100 })).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('SSH guest command contract', () => {
  it('quotes both the remote login shell and the fixed workspace-checking script', () => {
    const command = guestExecCommand('/workspaces/a/b', '/workspaces/a/b/src', [
      '/usr/bin/printf', '%s', "a'; echo injected; '", '$(id)', '`id`', 'a b',
    ]);
    expect(command).toMatch(/^\/bin\/sh -c 'set -eu\n/);
    // A single quote in an argument must survive two distinct shell parsings.
    expect(command).toContain("'\\''");
    expect(command).toContain('case "$target" in "$base"|"$base"/*)');
    expect(command).toContain('case "$actual" in "$base"|"$base"/*)');
    expect(command).toContain('cd -P -- "$target"');
    expect(command).toContain('exit 125');
    expect(command).toContain('exit 126');
  });
});
