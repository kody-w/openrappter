import {
  spawn as nodeSpawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from 'node:child_process';
import type { Readable, Writable } from 'node:stream';

import { readProcessIncarnation } from './process-incarnation.js';
import {
  abortError,
  childExit,
  ManagedTreeBase,
  ProcessTreeCleanupError,
  ProcessTreeContainmentError,
  ProcessTreeStartupError,
  sleep,
  waitForSpawn,
  type GroupSignal,
  type ManagedPidEvidence,
  type ManagedProcessCleanup,
  type ManagedProcessExit,
  type ManagedProcessTree,
  type NormalizedProcessTreeOptions,
  type ProcessTreeTestHooks,
} from './process-tree-internal.js';

function signalProcessGroup(processGroupId: number, signal: GroupSignal): void {
  process.kill(-processGroupId, signal);
}

function processGroupEmpty(processGroupId: number): boolean {
  try {
    process.kill(-processGroupId, 0);
    return false;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return true;
    if (code === 'EPERM') return false;
    throw error;
  }
}

class PosixManagedProcessTree extends ManagedTreeBase {
  readonly platform = 'posix' as const;
  readonly helper = undefined;
  readonly target: ManagedPidEvidence;
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;

  private readonly exitState;

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly options: NormalizedProcessTreeOptions,
    private readonly hooks: ProcessTreeTestHooks,
  ) {
    super();
    this.target = {
      pid: child.pid!,
      incarnation: readProcessIncarnation(child.pid!),
    };
    this.stdin = child.stdin;
    this.stdout = child.stdout;
    this.stderr = child.stderr;
    this.exitState = childExit(child);
  }

  wait(): Promise<ManagedProcessExit> {
    return this.exitState.promise;
  }

  private signal(signal: GroupSignal): void {
    try {
      (this.hooks.signalProcessGroup ?? signalProcessGroup)(
        this.target.pid,
        signal,
      );
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ESRCH') return;
      // macOS can report EPERM for SIGCONT after SIGTERM has already removed
      // the last process in the group. SIGCONT is only the best-effort wake-up
      // half of graceful shutdown; cleanup observation below still fails
      // closed unless the group is actually empty and the leader reaped.
      if (signal === 'SIGCONT' && code === 'EPERM') return;
      throw error;
    }
  }

  private async cleanupObserved(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    do {
      const empty = (this.hooks.processGroupEmpty ?? processGroupEmpty)(
        this.target.pid,
      );
      if (empty && this.exitState.current()) return true;
      if (Date.now() >= deadline) return false;
      await sleep(Math.min(10, deadline - Date.now()));
    } while (true);
  }

  protected async terminateOnce(): Promise<ManagedProcessCleanup> {
    let forced = false;
    try {
      if (await this.cleanupObserved(0)) {
        const exit = await this.wait();
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
      this.signal('SIGTERM');
      this.signal('SIGCONT');
      if (!await this.cleanupObserved(this.options.gracefulTerminationMs)) {
        forced = true;
        this.signal('SIGKILL');
        if (!await this.cleanupObserved(this.options.forceTerminationMs)) {
          throw new ProcessTreeCleanupError(
            'POSIX process group did not become empty and reaped within the cleanup deadline; quarantine is required.',
            this,
          );
        }
      }
      const exit = await this.wait();
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
        `POSIX process-tree cleanup could not be verified: ${(error as Error).message}`,
        this,
        { cause: error },
      );
    }
  }
}

export async function spawnPosixProcessTree(
  options: NormalizedProcessTreeOptions,
  hooks: ProcessTreeTestHooks,
): Promise<ManagedProcessTree> {
  if (options.containment === 'hostile') {
    throw new ProcessTreeContainmentError(
      'Hostile POSIX setsid escape requires stronger containment; spawn refused and workload must remain quarantined.',
    );
  }
  const spawn = hooks.spawn ?? nodeSpawn;
  const spawnOptions: SpawnOptionsWithoutStdio = {
    shell: false,
    // POSIX detached spawn calls setsid(2): the target becomes the leader of a
    // new session and process group that can be signalled without name lookup.
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: options.env,
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
  };
  const child = spawn(
    options.command,
    options.args,
    spawnOptions,
  ) as ChildProcessWithoutNullStreams;
  await waitForSpawn(child);
  if (!child.pid) throw new Error('Managed target spawned without a PID.');

  const tree = new PosixManagedProcessTree(child, options, hooks);
  tree.bindAbort(options.signal);
  try {
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
        'Managed process-tree startup failed and cleanup could not be verified.',
        tree,
        { cause: cleanupError },
      );
    }
    if (options.signal?.aborted) throw abortError();
    throw error;
  }
  return tree as ManagedProcessTree;
}
