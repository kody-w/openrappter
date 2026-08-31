import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  __spawnManagedProcessTreeForTest,
  ProcessTreeCleanupError,
  ProcessTreeContainmentError,
  ProcessTreeOutputError,
  ProcessTreeStartupError,
  spawnManagedProcessTree,
  type ManagedPidEvidence,
} from './process-tree.js';

const running: Array<Awaited<ReturnType<typeof spawnManagedProcessTree>>> = [];
const parentSecret = 'PROCESS_TREE_PARENT_SECRET';

vi.setConfig({
  testTimeout: process.platform === 'win32' ? 120_000 : 5_000,
  hookTimeout: process.platform === 'win32' ? 120_000 : 10_000,
});

function targetEnvironment(): Record<string, string> {
  if (process.platform !== 'win32') return {};
  return Object.fromEntries(
    ['SystemRoot', 'WINDIR', 'TEMP', 'TMP']
      .map((key) => [key, process.env[key]])
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
}

async function managed(
  script: string,
  options: {
    args?: string[];
    signal?: AbortSignal;
    gracefulTerminationMs?: number;
    forceTerminationMs?: number;
  } = {},
) {
  const tree = await spawnManagedProcessTree({
    command: process.execPath,
    args: ['-e', script, '--', ...(options.args ?? [])],
    env: targetEnvironment(),
    gracefulTerminationMs: options.gracefulTerminationMs ?? 1_000,
    forceTerminationMs: options.forceTerminationMs ?? 1_000,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  running.push(tree);
  return tree;
}

async function readLine(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffered = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      const newline = buffered.indexOf(0x0a);
      if (newline < 0) return;
      cleanup();
      resolve(buffered.subarray(0, newline).toString('utf8'));
    };
    const onEnd = () => {
      cleanup();
      reject(new Error('stream ended before a line was received'));
    };
    const cleanup = () => {
      stream.off('data', onData);
      stream.off('end', onEnd);
    };
    stream.on('data', onData);
    stream.once('end', onEnd);
  });
}

async function collect(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function sameProcessAlive(evidence: ManagedPidEvidence): boolean {
  try {
    process.kill(evidence.pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function expectDead(evidence: ManagedPidEvidence): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (sameProcessAlive(evidence) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  expect(sameProcessAlive(evidence), `PID ${evidence.pid} survived cleanup`).toBe(false);
}

afterEach(async () => {
  for (const tree of running.splice(0)) {
    await tree.terminate().catch(() => undefined);
  }
  delete process.env[parentSecret];
});

describe.skipIf(process.platform === 'win32')('POSIX managed process tree', () => {
  it('cleans up a real child and grandchild in one process group', async () => {
    const tree = await managed(`
      const { spawn } = require('node:child_process');
      const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        stdio: ['ignore', 'inherit', 'inherit']
      });
      process.stdout.write(String(grandchild.pid) + '\\n');
      setInterval(() => {}, 1000);
    `);
    const grandchild = {
      pid: Number(await readLine(tree.stdout)),
      incarnation: null,
    };

    expect(tree.helper?.incarnation).toBeTruthy();
    expect(tree.target.incarnation).toBeTruthy();
    expect(sameProcessAlive(tree.target!)).toBe(true);
    expect(sameProcessAlive(grandchild)).toBe(true);
    const cleanup = await tree.terminate();

    expect(cleanup.containmentEmpty).toBe(true);
    expect(cleanup.reaped).toBe(true);
    await expectDead(tree.target!);
    await expectDead(grandchild);
    await expectDead(tree.helper!);
  });

  it('gracefully terminates a cooperative target through the guardian', async () => {
    const tree = await managed(`
      process.stdout.write('ready\\n');
      setInterval(() => {}, 1000);
    `);
    expect(await readLine(tree.stdout)).toBe('ready');

    const cleanup = await tree.terminate();

    expect(cleanup.graceful).toBe(true);
    expect(cleanup.forced).toBe(false);
    expect(cleanup.exit.signal).toBe('SIGTERM');
  });

  it('retains containment when the process-group leader exits first', async () => {
    const tree = await managed(`
      const { spawn } = require('node:child_process');
      const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        stdio: ['ignore', 'inherit', 'inherit']
      });
      grandchild.unref();
      process.stdout.write(String(grandchild.pid) + '\\n');
    `);
    const grandchild = {
      pid: Number(await readLine(tree.stdout)),
      incarnation: null,
    };

    expect((await tree.wait()).code).toBe(0);
    expect(sameProcessAlive(grandchild)).toBe(true);
    expect((await tree.terminate()).containmentEmpty).toBe(true);
    await expectDead(grandchild);
  });

  it('forces a target that ignores TERM, after TERM plus SIGCONT grace', async () => {
    const tree = await managed(`
      process.on('SIGTERM', () => {});
      process.stdout.write('ready\\n');
      setInterval(() => {}, 1000);
    `, { gracefulTerminationMs: 40 });
    expect(await readLine(tree.stdout)).toBe('ready');

    const started = Date.now();
    const cleanup = await tree.terminate();

    expect(cleanup.forced).toBe(true);
    expect(cleanup.exit.signal).toBe('SIGKILL');
    expect(Date.now() - started).toBeLessThan(1_500);
  });

  it('cancels through the same verified cleanup path', async () => {
    const controller = new AbortController();
    const tree = await managed('setInterval(() => {}, 1000)', {
      signal: controller.signal,
    });

    controller.abort();
    const exit = await Promise.race([
      tree.wait(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('abort cleanup timed out')), 2_000)),
    ]);

    expect(exit.signal).toMatch(/SIGTERM|SIGKILL/);
    expect((await tree.terminate()).containmentEmpty).toBe(true);
  });

  it('does not orphan a process when cancellation races post-spawn setup', async () => {
    const controller = new AbortController();
    let target: ManagedPidEvidence | undefined;

    await expect(__spawnManagedProcessTreeForTest({
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      env: {},
      signal: controller.signal,
      gracefulTerminationMs: 40,
      forceTerminationMs: 1_000,
    }, {
      afterSpawn: (tree) => {
        target = tree.target;
        controller.abort();
      },
    })).rejects.toMatchObject({ name: 'AbortError' });

    expect(target).toBeDefined();
    await expectDead(target!);
  });

  it('allows termination retry after an injected signalling failure', async () => {
    let fail = true;
    const tree = await __spawnManagedProcessTreeForTest({
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      env: {},
      gracefulTerminationMs: 40,
      forceTerminationMs: 1_000,
    }, {
      writePosixControl: (control, command) => {
        if (command === 'terminate' && fail) {
          fail = false;
          return Promise.reject(new Error('injected control failure'));
        }
        return new Promise((resolve, reject) => {
          control.write(`${command}\n`, (error) => {
            if (error) reject(error); else resolve();
          });
        });
      },
    });
    running.push(tree);

    await expect(tree.terminate()).rejects.toBeInstanceOf(ProcessTreeCleanupError);
    expect((await tree.terminate()).containmentEmpty).toBe(true);
  });

  it('never signals a reused PGID after guardian ownership is gone', async () => {
    let strangerOwnsGroup = true;
    const writeControl = vi.fn();
    const tree = await __spawnManagedProcessTreeForTest({
      command: process.execPath,
      args: ['-e', 'process.stdout.write("done")'],
      env: {},
      gracefulTerminationMs: 20,
      forceTerminationMs: 100,
    }, {
      processGroupMembers: () => strangerOwnsGroup ? [424_242] : [],
      processGroupExists: () => strangerOwnsGroup,
      writePosixControl: async (...args) => {
        writeControl(...args);
      },
    });
    await tree.wait();
    process.kill(tree.helper!.pid, 'SIGKILL');
    await expectDead(tree.helper!);

    await expect(tree.terminate()).rejects.toBeInstanceOf(ProcessTreeCleanupError);
    expect(writeControl).not.toHaveBeenCalled();

    strangerOwnsGroup = false;
    expect((await tree.terminate()).containmentEmpty).toBe(true);
  });

  it('proves cleanup when setup fails after the child has spawned', async () => {
    let target: ManagedPidEvidence | undefined;
    let thrown: Error | undefined;
    try {
      await __spawnManagedProcessTreeForTest({
        command: process.execPath,
        args: ['-e', `
          process.stdout.write('ready\\n');
          setInterval(() => {}, 1000);
        `],
        env: {},
        gracefulTerminationMs: 100,
        forceTerminationMs: 2_000,
      }, {
        afterSpawn: async (tree) => {
          target = tree.target;
          await readLine(tree.stdout);
          throw new Error('injected post-spawn setup failure');
        },
      });
    } catch (error) {
      thrown = error as Error;
    }

    expect(thrown).toBeDefined();
    if (thrown instanceof ProcessTreeStartupError) {
      // A transient observation/signalling failure is allowed only because the
      // thrown error retains the live handle for a retry.
      expect((await thrown.tree.terminate()).containmentEmpty).toBe(true);
    } else {
      expect(thrown!.message).toContain('injected post-spawn setup failure');
    }
    expect(target).toBeDefined();
    await expectDead(target!);
  });

  it('retains a retryable handle when startup cleanup itself fails', async () => {
    let fail = true;
    let startupError: ProcessTreeStartupError | undefined;
    try {
      await __spawnManagedProcessTreeForTest({
        command: process.execPath,
        args: ['-e', `
          process.stdout.write('ready\\n');
          setInterval(() => {}, 1000);
        `],
        env: {},
        gracefulTerminationMs: 40,
        forceTerminationMs: 1_000,
      }, {
        writePosixControl: (control, command) => {
          if (command === 'terminate' && fail) {
            fail = false;
            return Promise.reject(new Error('injected control failure'));
          }
          return new Promise((resolve, reject) => {
            control.write(`${command}\n`, (error) => {
              if (error) reject(error); else resolve();
            });
          });
        },
        afterSpawn: async (tree) => {
          await readLine(tree.stdout);
          throw new Error('injected setup failure');
        },
      });

    } catch (error) {
      startupError = error as ProcessTreeStartupError;
    }

    expect(startupError).toBeInstanceOf(ProcessTreeStartupError);
    expect(startupError!.tree.target).toBeDefined();
    expect((await startupError!.tree.terminate()).containmentEmpty).toBe(true);
    await expectDead(startupError!.tree.target!);
  });

  it('keeps all numeric group signalling inside the live guardian', () => {
    const directory = path.dirname(fileURLToPath(import.meta.url));
    const guardian = readFileSync(
      path.join(directory, 'process-tree-posix-helper.mjs'),
      'utf8',
    );
    const supervisor = readFileSync(
      path.join(directory, 'process-tree-posix.ts'),
      'utf8',
    );

    expect(guardian).toContain("process.kill(-process.pid, 'SIGTERM')");
    expect(guardian).toContain("process.kill(-process.pid, 'SIGCONT')");
    expect(guardian).toContain("process.kill(-process.pid, 'SIGKILL')");
    expect(supervisor).not.toMatch(/process\.kill\(\s*-[^,]+,\s*'SIG/);
  });

  it('fails closed before spawn when hostile setsid containment is requested', async () => {
    const spawn = vi.fn();

    await expect(__spawnManagedProcessTreeForTest({
      command: process.execPath,
      args: [],
      env: {},
      containment: 'hostile',
    }, { spawn: spawn as never })).rejects.toMatchObject({
      name: ProcessTreeContainmentError.name,
      quarantineRequired: true,
    });

    expect(spawn).not.toHaveBeenCalled();
  });
});

describe('managed process-tree byte and input contracts', () => {
  it('does not alter split stdout bytes', async () => {
    const tree = await managed(`
      process.stdout.write(Buffer.from([0, 1]));
      setTimeout(() => process.stdout.write(Buffer.from([254, 255])), 10);
    `);

    const output = await collect(tree.stdout);
    expect((await tree.wait()).code).toBe(0);
    expect([...output]).toEqual([0, 1, 254, 255]);
    expect((await tree.terminate()).containmentEmpty).toBe(true);
  });

  it('relays stdin and stdout as unmodified bytes', async () => {
    const tree = await managed('process.stdin.pipe(process.stdout)');
    const bytes = Buffer.from([0, 10, 13, 34, 92, 128, 254, 255]);

    tree.stdin.end(bytes);

    expect(await collect(tree.stdout)).toEqual(bytes);
    expect((await tree.wait()).code).toBe(0);
  });

  it('passes paths and metacharacters as literal argv entries without a shell', async () => {
    const args = [
      'path with spaces/file.txt',
      'semi;colon',
      'ampersand&value',
      '$(not-a-command)',
      'quote"value',
      'trailing\\',
    ];
    const tree = await managed(
      'process.stdout.write(JSON.stringify(process.argv.slice(1)))',
      { args },
    );

    expect(JSON.parse((await collect(tree.stdout)).toString('utf8'))).toEqual(args);
    expect((await tree.wait()).code).toBe(0);
  });

  it('uses only the explicit sanitized target environment', async () => {
    process.env[parentSecret] = 'must-not-cross';
    const env = {
      ...targetEnvironment(),
      PROCESS_TREE_ALLOWED: 'present',
    };
    const tree = await spawnManagedProcessTree({
      command: process.execPath,
      args: ['-e', `
        process.stdout.write(JSON.stringify({
          allowed: process.env.PROCESS_TREE_ALLOWED,
          secret: process.env.${parentSecret}
        }));
      `],
      env,
    });
    running.push(tree);

    const observed = JSON.parse((await collect(tree.stdout)).toString('utf8'));
    expect(observed).toEqual({ allowed: 'present' });
    expect((await tree.wait()).code).toBe(0);
  });

  it('rejects unbounded timeouts and protocol inputs before spawning', async () => {
    const spawn = vi.fn();
    await expect(__spawnManagedProcessTreeForTest({
      command: process.execPath,
      env: {},
      gracefulTerminationMs: 60_001,
    }, { spawn: spawn as never })).rejects.toThrow(/0 through 60000/);
    await expect(__spawnManagedProcessTreeForTest({
      command: process.execPath,
      args: new Array(257).fill('x'),
      env: {},
    }, { spawn: spawn as never })).rejects.toThrow(/at most 256/);
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe('Windows Job Object helper contract', () => {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const helperPath = path.join(directory, 'process-tree-windows.ps1');
  const source = readFileSync(helperPath, 'utf8');
  const launcherSource = readFileSync(
    path.join(directory, 'process-tree-windows.ts'),
    'utf8',
  );

  it('sets kill-on-close, joins the helper before target launch, and forbids breakaway', () => {
    expect(source).toContain('JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE');
    expect(source).toContain('CreateJobObject');
    expect(source).toContain('SetInformationJobObject');
    expect(source).toContain('AssignProcessToJobObject');
    expect(source).toContain('TerminateJobObject');
    expect(source).not.toContain('JOB_OBJECT_LIMIT_BREAKAWAY_OK');
    expect(source).not.toContain('JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK');

    const assign = source.lastIndexOf('AssignProcessToJobObject(job');
    const launch = source.indexOf('target.Start()');
    expect(assign).toBeGreaterThan(0);
    expect(launch).toBeGreaterThan(assign);
  });

  it('launches directly, quotes Windows argv, clears inherited env, and never logs config', () => {
    expect(source).toContain('QuoteWindowsArgument');
    expect(source).toContain('UseShellExecute = false');
    expect(source).toContain('start.EnvironmentVariables.Clear()');
    expect(source).not.toMatch(/cmd(?:\.exe)?\s*\/c/i);
    expect(source).not.toContain('WriteLine(config');
    expect(source).not.toContain('Write-Host');
    expect(source).not.toContain('[Console]::Error.WriteLine');
    expect(source).not.toContain('Exception.Message');
    expect(source).not.toMatch(/File\.(?:Write|Append)|WriteAllText|WriteAllBytes/);
    expect(launcherSource).toContain('child.stdin.write(config)');
    expect(launcherSource).toContain('shell: false');
    expect(launcherSource).toContain('env: helperEnvironment(process.env)');
  });

  it('bounds and validates the in-memory helper protocol', () => {
    expect(source).toContain('ConfigMaxBytes = 1048576');
    expect(source).toContain('config.args.Length > 256');
    expect(source).toContain('config.env.Count > 256');
    expect(source).toContain('"^[A-Za-z0-9-]+$"');
    expect(launcherSource).toContain('CONFIG_MAX_BYTES = 1_048_576');
    expect(launcherSource).toContain('READY_MAX_BYTES = 4_096');
  });

  it('is copied by the build and required by package smoke', () => {
    const packageJson = readFileSync(path.join(directory, '../../package.json'), 'utf8');
    const packageSmoke = readFileSync(
      path.join(directory, '../../scripts/package-smoke.mjs'),
      'utf8',
    );
    expect(packageJson).toContain('process-tree-posix-helper.mjs');
    expect(packageJson).toContain('process-tree-windows.ps1');
    expect(packageSmoke).toContain('dist/infra/process-tree-posix-helper.mjs');
    expect(packageSmoke).toContain('dist/infra/process-tree-windows.ps1');
  });

  it('uses bounded full relay completion instead of the former 250ms window', () => {
    expect(source).toContain('RelayTimeoutMs = 10000');
    expect(source).toContain('TerminateRemainingJobProcesses(job)');
    expect(source).toContain('AwaitOutputRelays(stdout, stderr)');
    expect(source).toContain('"output_or_cleanup_failed"');
    expect(source).not.toContain('Task.WaitAll(new[] { stdout, stderr }, 250)');
    expect(source.indexOf('WaitForControlConnection(control)'))
      .toBeLessThan(source.indexOf('target.WaitForExit()'));
  });

  it('runs native Job Object tests in CI and budgets exactly two non-Windows skips', () => {
    const workflow = readFileSync(
      path.join(directory, '../../../.github/workflows/process-tree.yml'),
      'utf8',
    );
    const reportGate = readFileSync(
      path.join(directory, '../../../tools/process-tree-report.mjs'),
      'utf8',
    );
    const skipBudget = readFileSync(
      path.join(directory, '../../../tools/skip-budget.mjs'),
      'utf8',
    );
    expect(workflow).toContain(
      'npx vitest run src/infra/process-tree.test.ts',
    );
    expect(workflow).toContain('os: [ubuntu-latest, windows-latest]');
    expect(workflow).toContain('timeout-minutes: 12');
    expect(workflow).toContain('npm run build:server');
    expect(workflow).not.toContain('npm run build\n');
    expect(workflow).toContain('tools/process-tree-report.mjs');
    expect(reportGate).toContain('windows.length !== 2');
    expect(reportGate).toContain('windowsSkipped.length !== 0');
    expect(skipBudget).toMatch(
      /'src\/infra\/process-tree\.test\.ts':\s*\{\s*max:\s*2,/,
    );
    expect(skipBudget).toContain('process-tree.yml');
  });
});

describe.runIf(process.platform === 'win32')('Windows Job Object integration', () => {
  it('kills the target and grandchild when the helper itself dies', async () => {
    const tree = await managed(`
      const { spawn } = require('node:child_process');
      const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        detached: true,
        stdio: 'ignore'
      });
      process.stdout.write(String(grandchild.pid) + '\\n');
      setInterval(() => {}, 1000);
    `);
    const grandchild = {
      pid: Number(await readLine(tree.stdout)),
      incarnation: null,
    };

    process.kill(tree.helper!.pid, 'SIGKILL');
    await expect(tree.wait()).rejects.toBeInstanceOf(ProcessTreeOutputError);
    await expectDead(tree.target!);
    await expectDead(grandchild);
  });

  it('handles natural/fast exit, full delayed relay, and explicit relay failure', async () => {
    const tree = await managed(`
      const { spawn } = require('node:child_process');
      const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        detached: true,
        stdio: 'ignore'
      });
      grandchild.unref();
      process.stdout.write(String(grandchild.pid) + '\\n');
    `);
    const grandchild = {
      pid: Number(await readLine(tree.stdout)),
      incarnation: null,
    };

    expect((await tree.wait()).code).toBe(0);
    await expectDead(grandchild);
    expect((await tree.terminate()).containmentEmpty).toBe(true);

    const fast = await managed('process.stdout.write("fast-target")');
    expect((await collect(fast.stdout)).toString('utf8')).toBe('fast-target');
    expect((await fast.wait()).code).toBe(0);
    expect((await fast.terminate()).containmentEmpty).toBe(true);

    const byteCount = 2 * 1024 * 1024;
    const delayedRelay = await managed(
      `process.stdout.write(Buffer.alloc(${byteCount}, 0x5a))`,
      { forceTerminationMs: 5_000 },
    );
    await new Promise((resolve) => setTimeout(resolve, 400));
    const delayedOutput = await collect(delayedRelay.stdout);
    expect(delayedOutput).toHaveLength(byteCount);
    expect(delayedOutput.every((byte) => byte === 0x5a)).toBe(true);
    expect((await delayedRelay.wait()).code).toBe(0);
    expect((await delayedRelay.terminate()).containmentEmpty).toBe(true);

    const relayFailure = await __spawnManagedProcessTreeForTest({
      command: process.execPath,
      args: ['-e', 'process.stdout.write("relay-failure")'],
      env: targetEnvironment(),
      gracefulTerminationMs: 100,
      forceTerminationMs: 5_000,
    }, {
      simulateWindowsRelayFailure: true,
    });
    running.push(relayFailure);
    await expect(relayFailure.wait()).rejects.toBeInstanceOf(ProcessTreeOutputError);
    await expect(relayFailure.terminate()).rejects.toBeInstanceOf(ProcessTreeCleanupError);
  });
});
