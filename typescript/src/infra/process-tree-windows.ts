import {
  spawn as nodeSpawn,
  type ChildProcessWithoutNullStreams,
} from 'node:child_process';
import { randomUUID } from 'node:crypto';
import net, { type Socket } from 'node:net';
import path from 'node:path';
import { PassThrough, type Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';

import {
  abortError,
  childExit,
  defaultProcessAlive,
  ManagedTreeBase,
  ProcessTreeCleanupError,
  ProcessTreeStartupError,
  sleep,
  waitForSpawn,
  type ManagedPidEvidence,
  type ManagedProcessCleanup,
  type ManagedProcessExit,
  type ManagedProcessTree,
  type NormalizedProcessTreeOptions,
  type ProcessTreeTestHooks,
} from './process-tree-internal.js';

const CONFIG_MAX_BYTES = 1_048_576;
const READY_MAX_BYTES = 4_096;
const CONTROL_CONNECT_MS = 5_000;

interface WindowsReady {
  protocol: 1;
  helper_pid: number;
  helper_incarnation: string;
  target_pid: number;
  target_incarnation: string;
}

function powerShellPath(environment: NodeJS.ProcessEnv): string {
  const systemRoot = environment.SystemRoot ?? environment.WINDIR;
  if (!systemRoot) {
    throw new Error('Windows process-tree helper requires SystemRoot or WINDIR.');
  }
  return path.join(
    systemRoot,
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
}

function helperEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> {
  const allowed = ['SystemRoot', 'WINDIR', 'TEMP', 'TMP'] as const;
  const result: Record<string, string> = {};
  for (const key of allowed) {
    const value = environment[key];
    if (value) result[key] = value;
  }
  return result;
}

function parseReady(value: unknown): WindowsReady {
  const ready = value as Partial<WindowsReady>;
  if (
    ready?.protocol !== 1
    || !Number.isSafeInteger(ready.helper_pid)
    || ready.helper_pid! <= 0
    || typeof ready.helper_incarnation !== 'string'
    || !ready.helper_incarnation
    || !Number.isSafeInteger(ready.target_pid)
    || ready.target_pid! <= 0
    || typeof ready.target_incarnation !== 'string'
    || !ready.target_incarnation
  ) {
    throw new Error('Windows process-tree helper returned an invalid ready record.');
  }
  return ready as WindowsReady;
}

function readReady(
  child: ChildProcessWithoutNullStreams,
  output: PassThrough,
): Promise<WindowsReady> {
  return new Promise((resolve, reject) => {
    let buffered = Buffer.alloc(0);
    const onClose = () => {
      cleanup();
      reject(new Error('Windows process-tree helper exited before declaring its target.'));
    };
    const onData = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.length > READY_MAX_BYTES) {
        cleanup();
        reject(new Error('Windows process-tree helper ready record exceeded its bound.'));
        return;
      }
      const newline = buffered.indexOf(0x0a);
      if (newline < 0) return;
      try {
        const ready = parseReady(
          JSON.parse(buffered.subarray(0, newline).toString('utf8')),
        );
        const remaining = buffered.subarray(newline + 1);
        cleanup();
        if (remaining.length > 0) output.write(remaining);
        child.stdout.pipe(output);
        resolve(ready);
      } catch (error) {
        cleanup();
        reject(error);
      }
    };
    const cleanup = () => {
      child.stdout.off('data', onData);
      child.off('close', onClose);
    };
    child.stdout.on('data', onData);
    child.once('close', onClose);
  });
}

async function connectControl(
  pipeName: string,
  timeoutMs: number,
): Promise<Socket> {
  const deadline = Date.now() + timeoutMs;
  let lastError: Error | undefined;
  while (Date.now() <= deadline) {
    const socket = await new Promise<Socket | null>((resolve) => {
      const candidate = net.connect(`\\\\.\\pipe\\${pipeName}`);
      const timer = setTimeout(() => {
        candidate.destroy();
        resolve(null);
      }, Math.min(250, Math.max(1, deadline - Date.now())));
      candidate.once('connect', () => {
        clearTimeout(timer);
        resolve(candidate);
      });
      candidate.once('error', (error) => {
        clearTimeout(timer);
        lastError = error;
        candidate.destroy();
        resolve(null);
      });
    });
    if (socket) {
      socket.on('error', () => {
        // terminate() observes write failures and can retry/fall back.
      });
      return socket;
    }
    await sleep(20);
  }
  throw new Error(
    `Windows process-tree control pipe was unavailable: ${lastError?.message ?? 'timed out'}`,
  );
}

class WindowsManagedProcessTree extends ManagedTreeBase {
  readonly platform = 'windows' as const;
  target: ManagedPidEvidence | undefined;
  helper: ManagedPidEvidence | undefined;
  readonly stdin: Writable;
  readonly stdout: PassThrough;
  readonly stderr: PassThrough;

  private readonly exitState;
  private control: Socket | undefined;

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly options: NormalizedProcessTreeOptions,
    private readonly hooks: ProcessTreeTestHooks,
  ) {
    super();
    this.helper = child.pid
      ? { pid: child.pid, incarnation: null }
      : undefined;
    this.stdin = child.stdin;
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    child.stderr.pipe(this.stderr);
    this.exitState = childExit(child);
  }

  declareReady(ready: WindowsReady): void {
    if (this.child.pid !== ready.helper_pid) {
      throw new Error('Windows helper PID does not match the spawned process.');
    }
    this.helper = {
      pid: ready.helper_pid,
      incarnation: ready.helper_incarnation,
    };
    this.target = {
      pid: ready.target_pid,
      incarnation: ready.target_incarnation,
    };
  }

  attachControl(socket: Socket): void {
    this.control = socket;
  }

  wait(): Promise<ManagedProcessExit> {
    return this.exitState.promise;
  }

  private sameOwnedProcessAlive(evidence: ManagedPidEvidence | undefined): boolean {
    if (!evidence) return false;
    return (this.hooks.processAlive ?? defaultProcessAlive)(evidence);
  }

  private async cleanupObserved(deadline: number): Promise<boolean> {
    do {
      // Helper exit closes the sole Job Object handle. KILL_ON_JOB_CLOSE is
      // the kernel proof that no contained descendant can remain; the PID
      // evidence below additionally rejects a still-live/reused root process.
      if (
        this.exitState.current()
        && !this.sameOwnedProcessAlive(this.helper)
        && !this.sameOwnedProcessAlive(this.target)
      ) {
        return true;
      }
      if (Date.now() >= deadline) return false;
      await sleep(Math.min(10, deadline - Date.now()));
    } while (true);
  }

  private writeControl(
    command: 'terminate' | 'kill',
    timeoutMs: number,
  ): Promise<void> {
    if (!this.control || this.control.destroyed || !this.control.writable) {
      return Promise.reject(new Error('Windows process-tree control pipe is closed.'));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Windows process-tree ${command} command timed out.`)),
        Math.max(1, timeoutMs),
      );
      this.control!.write(`${command}\n`, (error) => {
        clearTimeout(timer);
        if (error) reject(error); else resolve();
      });
    });
  }

  private killHelper(): void {
    if (this.exitState.current()) return;
    const killed = (this.hooks.killHelper ?? ((child) => child.kill('SIGKILL')))(this.child);
    if (!killed && !this.exitState.current()) {
      throw new Error('Windows process-tree helper could not be terminated.');
    }
  }

  protected async terminateOnce(): Promise<ManagedProcessCleanup> {
    let forced = false;
    try {
      if (await this.cleanupObserved(Date.now())) {
        const exit = await this.wait();
        this.control?.destroy();
        this.unbindAbort();
        return {
          exit,
          graceful: true,
          forced: false,
          reaped: true,
          containmentEmpty: true,
          quarantineRequired: false,
        };
      }
      this.stdin.end();
      try {
        await this.writeControl(
          'terminate',
          Math.min(250, Math.max(1, this.options.gracefulTerminationMs)),
        );
      } catch {
        // No control channel means graceful shutdown is unavailable; closing
        // the reviewed helper remains the Job Object's forced cleanup path.
      }

      const gracefulDeadline = Date.now() + this.options.gracefulTerminationMs;
      if (!await this.cleanupObserved(gracefulDeadline)) {
        forced = true;
        const forceDeadline = Date.now() + this.options.forceTerminationMs;
        try {
          await this.writeControl(
            'kill',
            Math.min(250, Math.max(1, this.options.forceTerminationMs)),
          );
        } catch {
          this.killHelper();
        }
        const controlDeadline = Date.now()
          + Math.floor(Math.max(0, forceDeadline - Date.now()) / 2);
        if (!await this.cleanupObserved(controlDeadline)) {
          this.killHelper();
        }
        if (!await this.cleanupObserved(forceDeadline)) {
          throw new ProcessTreeCleanupError(
            'Windows Job Object helper did not exit and empty owned containment within the cleanup deadline; quarantine is required.',
            this,
          );
        }
      }

      const exit = await this.wait();
      this.control?.destroy();
      this.unbindAbort();
      return {
        exit,
        graceful: !forced,
        forced,
        reaped: true,
        containmentEmpty: true,
        quarantineRequired: false,
      };
    } catch (error) {
      if (error instanceof ProcessTreeCleanupError) throw error;
      throw new ProcessTreeCleanupError(
        `Windows process-tree cleanup could not be verified: ${(error as Error).message}`,
        this,
        { cause: error },
      );
    }
  }
}

export async function spawnWindowsProcessTree(
  options: NormalizedProcessTreeOptions,
  hooks: ProcessTreeTestHooks,
): Promise<ManagedProcessTree> {
  const spawn = hooks.spawn ?? nodeSpawn;
  const pipeName = `openrappter-process-tree-${randomUUID()}`;
  const helperPath = hooks.windowsHelperPath
    ?? fileURLToPath(new URL('./process-tree-windows.ps1', import.meta.url));
  const config = Buffer.from(`${JSON.stringify({
    version: 1,
    command: options.command,
    args: options.args,
    cwd: options.cwd ?? null,
    env: options.env,
    control_pipe: pipeName,
  })}\n`, 'utf8');
  if (config.length > CONFIG_MAX_BYTES) {
    throw new Error(`Windows process-tree configuration exceeds ${CONFIG_MAX_BYTES} bytes.`);
  }

  const child = spawn(
    powerShellPath(process.env),
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      helperPath,
    ],
    {
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: helperEnvironment(process.env),
    },
  ) as ChildProcessWithoutNullStreams;
  const tree = new WindowsManagedProcessTree(child, options, hooks);
  tree.bindAbort(options.signal);

  try {
    await waitForSpawn(child);
    child.stdin.write(config);
    const ready = await readReady(child, tree.stdout);
    tree.declareReady(ready);
    const control = await (
      hooks.connectWindowsControl ?? connectControl
    )(pipeName, CONTROL_CONNECT_MS);
    tree.attachControl(control);
    await hooks.afterSpawn?.(tree);
    if (options.signal?.aborted) {
      await tree.terminate();
      throw abortError();
    }
  } catch (error) {
    try {
      await tree.terminate();
    } catch (cleanupError) {
      throw new ProcessTreeStartupError(
        'Windows process-tree startup failed and Job Object cleanup could not be verified.',
        tree,
        { cause: cleanupError },
      );
    }
    if (options.signal?.aborted) throw abortError();
    throw error;
  }

  if (!tree.target) {
    throw new ProcessTreeStartupError(
      'Windows process-tree helper completed startup without target evidence.',
      tree,
    );
  }
  return tree as ManagedProcessTree;
}
