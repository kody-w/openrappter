import {
  execFile,
  spawn as nodeSpawn,
  type ChildProcessWithoutNullStreams,
} from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import type { Readable, Writable } from 'node:stream';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import {
  CURRENT_PROCESS_INCARNATION,
  processMatchesIncarnation,
  readProcessIncarnation,
} from './process-incarnation.js';
import {
  abortError,
  childExit,
  defaultProcessAlive,
  ManagedTreeBase,
  ProcessTreeCleanupError,
  ProcessTreeContainmentError,
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
const EVENT_MAX_BYTES = 4_096;
const run = promisify(execFile);

interface PosixReady {
  protocol: 1;
  type: 'ready';
  helper_pid: number;
  helper_incarnation: string;
  target_pid: number;
  target_incarnation: string;
}

interface PosixTargetExit {
  protocol: 1;
  type: 'target_exit';
  code: number | null;
  signal: NodeJS.Signals | null;
}

type PosixEvent =
  | PosixReady
  | PosixTargetExit;

interface TargetExitState {
  promise: Promise<ManagedProcessExit>;
  current(): ManagedProcessExit | undefined;
  failure(): Error | undefined;
  resolve(exit: ManagedProcessExit): void;
  reject(error: Error): void;
}

function targetExitState(): TargetExitState {
  let current: ManagedProcessExit | undefined;
  let failure: Error | undefined;
  let settled = false;
  let resolvePromise!: (exit: ManagedProcessExit) => void;
  let rejectPromise!: (error: Error) => void;
  const promise = new Promise<ManagedProcessExit>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  void promise.catch(() => {
    // wait() still exposes the rejection; this prevents an output/protocol
    // failure from becoming unhandled before the caller begins awaiting it.
  });
  return {
    promise,
    current: () => current,
    failure: () => failure,
    resolve: (exit) => {
      if (settled) return;
      settled = true;
      current = exit;
      resolvePromise(exit);
    },
    reject: (error) => {
      if (settled) return;
      settled = true;
      failure = error;
      rejectPromise(error);
    },
  };
}

function parseReady(event: PosixEvent): PosixReady {
  if (
    event.protocol !== 1
    || event.type !== 'ready'
    || !Number.isSafeInteger(event.helper_pid)
    || event.helper_pid <= 0
    || typeof event.helper_incarnation !== 'string'
    || !event.helper_incarnation
    || !Number.isSafeInteger(event.target_pid)
    || event.target_pid <= 0
    || typeof event.target_incarnation !== 'string'
    || !event.target_incarnation
  ) {
    throw new Error('POSIX process-tree guardian returned an invalid ready record.');
  }
  return event;
}

async function groupMembers(
  groupId: number,
  timeoutMs: number,
): Promise<number[]> {
  if (process.platform === 'linux') {
    const members: number[] = [];
    for (const entry of readdirSync('/proc')) {
      if (!/^\d+$/.test(entry)) continue;
      try {
        const stat = readFileSync(`/proc/${entry}/stat`, 'utf8');
        const fields = stat
          .slice(stat.lastIndexOf(')') + 2)
          .trim()
          .split(/\s+/);
        if (Number(fields[2]) === groupId) members.push(Number(entry));
      } catch {
        // The process exited between directory enumeration and stat read.
      }
    }
    return members;
  }
  try {
    const { stdout } = await run(
      'ps',
      ['-o', 'pid=', '-g', String(groupId)],
      {
        encoding: 'utf8',
        env: { PATH: '/usr/bin:/bin', LC_ALL: 'C', TZ: 'UTC' },
        maxBuffer: 1024 * 1024,
        timeout: Math.max(1, timeoutMs),
      },
    );
    return stdout
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map(Number)
      .filter((pid) => Number.isSafeInteger(pid) && pid > 0);
  } catch (error) {
    const failed = error as { code?: string | number; stdout?: string };
    if (failed.code === 1 && !(failed.stdout ?? '').trim()) return [];
    throw error;
  }
}

function guardianEnvironment(): Record<string, string> {
  return {
    PATH: '/usr/bin:/bin',
    LC_ALL: 'C',
    TZ: 'UTC',
  };
}

function processGroupExists(groupId: number): boolean {
  try {
    process.kill(-groupId, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    if (code === 'EPERM') return true;
    throw error;
  }
}

function childPipes(child: ChildProcessWithoutNullStreams): {
  commands: Writable;
  events: Readable;
} {
  const commands = child.stdio[3] as Writable | null;
  const events = child.stdio[4] as Readable | null;
  if (!commands || !events) {
    throw new Error('POSIX process-tree guardian protocol pipes are unavailable.');
  }
  return { commands, events };
}

class PosixEventProtocol {
  private buffered = Buffer.alloc(0);
  private readyResolve!: (ready: PosixReady) => void;
  private readyReject!: (error: Error) => void;
  private readonly readyPromise: Promise<PosixReady>;
  private readySeen = false;

  constructor(
    stream: Readable,
    private readonly targetExit: TargetExitState,
    private readonly onEvent?: (event: unknown) => void,
  ) {
    this.readyPromise = new Promise((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    stream.on('data', (chunk: Buffer) => this.onData(chunk));
    stream.once('end', () => this.onEnd());
    stream.once('error', (error) => this.fail(error));
  }

  ready(): Promise<PosixReady> {
    return this.readyPromise;
  }

  private onData(chunk: Buffer): void {
    this.buffered = Buffer.concat([this.buffered, chunk]);
    if (this.buffered.length > EVENT_MAX_BYTES) {
      this.fail(new Error('POSIX process-tree guardian event exceeded its bound.'));
      return;
    }
    while (true) {
      const newline = this.buffered.indexOf(0x0a);
      if (newline < 0) return;
      const line = this.buffered.subarray(0, newline);
      this.buffered = this.buffered.subarray(newline + 1);
      try {
        this.handle(JSON.parse(line.toString('utf8')) as PosixEvent);
      } catch (error) {
        this.fail(error as Error);
        return;
      }
    }
  }

  private handle(event: PosixEvent): void {
    this.onEvent?.(event);
    if (!this.readySeen) {
      const ready = parseReady(event);
      this.readySeen = true;
      this.readyResolve(ready);
      return;
    }
    if (event.protocol !== 1) throw new Error('Unsupported POSIX guardian event.');
    if (event.type === 'target_exit') {
      if (
        event.code !== null
        && (!Number.isSafeInteger(event.code) || event.code < 0)
      ) {
        throw new Error('POSIX guardian returned an invalid target exit code.');
      }
      if (event.signal !== null && typeof event.signal !== 'string') {
        throw new Error('POSIX guardian returned an invalid target signal.');
      }
      this.targetExit.resolve({ code: event.code, signal: event.signal });
      return;
    }
    throw new Error('Unknown POSIX guardian event.');
  }

  private onEnd(): void {
    const error = new Error('POSIX process-tree guardian protocol closed unexpectedly.');
    if (!this.readySeen) this.readyReject(error);
    else if (!this.targetExit.current()) this.targetExit.reject(error);
  }

  private fail(error: Error): void {
    if (!this.readySeen) this.readyReject(error);
    else this.targetExit.reject(error);
  }
}

class PosixManagedProcessTree extends ManagedTreeBase {
  readonly platform = 'posix' as const;
  target: ManagedPidEvidence | undefined;
  helper: ManagedPidEvidence | undefined;
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;

  private readonly helperExit;

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly commands: Writable,
    private readonly targetExit: TargetExitState,
    private readonly options: NormalizedProcessTreeOptions,
    private readonly hooks: ProcessTreeTestHooks,
  ) {
    super();
    this.helper = child.pid
      ? { pid: child.pid, incarnation: readProcessIncarnation(child.pid) }
      : undefined;
    this.stdin = child.stdin;
    this.stdout = child.stdout;
    this.stderr = child.stderr;
    this.helperExit = childExit(child);
  }

  declareReady(ready: PosixReady): void {
    if (this.child.pid !== ready.helper_pid) {
      throw new Error('POSIX guardian PID does not match the spawned helper.');
    }
    if (
      this.helper?.incarnation
      && this.helper.incarnation !== ready.helper_incarnation
    ) {
      throw new Error('POSIX guardian incarnation changed during startup.');
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

  wait(): Promise<ManagedProcessExit> {
    return this.targetExit.promise;
  }

  private guardianOwned(): boolean {
    if (!this.helper || this.helperExit.current()) return false;
    return (this.hooks.processAlive ?? defaultProcessAlive)(this.helper);
  }

  private async members(deadline: number): Promise<number[]> {
    if (!this.helper) return [];
    return await Promise.resolve(
      (this.hooks.processGroupMembers ?? groupMembers)(
        this.helper.pid,
        Math.max(1, deadline - Date.now()),
      ),
    );
  }

  private async onlyGuardianRemains(deadline: number): Promise<boolean> {
    if (!this.helper || !this.targetExit.current()) return false;
    const members = await this.members(deadline);
    return members.length === 1 && members[0] === this.helper.pid;
  }

  private async onlyGuardianRemainsOrFalse(deadline: number): Promise<boolean> {
    try {
      return await this.onlyGuardianRemains(deadline);
    } catch {
      // Failure to prove graceful emptiness is not success. The exact guardian
      // control channel remains available for bounded forced cleanup.
      return false;
    }
  }

  private writeControl(command: 'terminate' | 'kill'): Promise<void> {
    if (!this.guardianOwned()) {
      return Promise.reject(
        new Error('POSIX guardian ownership is no longer incarnation-verifiable.'),
      );
    }
    if (this.hooks.writePosixControl) {
      return this.hooks.writePosixControl(this.commands, command);
    }
    return new Promise((resolve, reject) => {
      this.commands.write(`${command}\n`, (error) => {
        if (error) reject(error); else resolve();
      });
    });
  }

  private async observeOnlyGuardian(deadline: number): Promise<boolean> {
    do {
      if (this.helperExit.current()) return false;
      if (await this.onlyGuardianRemainsOrFalse(deadline)) return true;
      if (Date.now() >= deadline) return false;
      await sleep(Math.min(10, deadline - Date.now()));
    } while (true);
  }

  private async observeEmpty(deadline: number): Promise<boolean> {
    do {
      if (
        this.helperExit.current()
        && !(this.hooks.processGroupExists ?? processGroupExists)(
          this.helper!.pid,
        )
      ) return true;
      if (Date.now() >= deadline) return false;
      await sleep(Math.min(10, deadline - Date.now()));
    } while (true);
  }

  private async finishGuardian(deadline: number): Promise<boolean> {
    if (!this.guardianOwned()) {
      throw new Error('POSIX guardian ownership is no longer incarnation-verifiable.');
    }
    const signalled = (
      this.hooks.finishPosixGuardian
      ?? ((child) => child.kill('SIGHUP'))
    )(this.child);
    if (!signalled && !this.helperExit.current()) {
      throw new Error('POSIX guardian could not be asked to finish.');
    }
    return this.observeEmpty(deadline);
  }

  private cleanupResult(
    graceful: boolean,
    forced: boolean,
  ): ManagedProcessCleanup {
    const targetExit = this.targetExit.current();
    const targetFailure = this.targetExit.failure();
    const fallbackExit = this.helperExit.current() ?? {
      code: null,
      signal: null,
    };
    return {
      complete: true,
      exit: targetExit ?? fallbackExit,
      ...(targetFailure
        ? {
            targetError: {
              name: targetFailure.name,
              message: targetFailure.message,
            },
          }
        : {}),
      graceful,
      forced,
      reaped: true,
      containmentEmpty: true,
      quarantineRequired: false,
    };
  }

  protected async terminateOnce(): Promise<ManagedProcessCleanup> {
    let forced = false;
    try {
      if (
        this.helperExit.current()
        && !(this.hooks.processGroupExists ?? processGroupExists)(
          this.helper!.pid,
        )
      ) {
        const exit = this.targetExit.current() ?? this.helperExit.current()!;
        this.unbindAbort();
        return {
          ...this.cleanupResult(true, false),
          exit,
        };
      }
      const gracefulDeadline = Date.now() + this.options.gracefulTerminationMs;
      if (
        !await this.onlyGuardianRemainsOrFalse(gracefulDeadline)
        && this.helperExit.current() === undefined
      ) {
        await this.writeControl('terminate');
      }
      if (
        await this.observeOnlyGuardian(gracefulDeadline)
        && await this.finishGuardian(
          Date.now() + this.options.forceTerminationMs,
        )
      ) {
        this.unbindAbort();
        return this.cleanupResult(true, false);
      }
      if (await this.observeEmpty(gracefulDeadline)) {
        const exit = this.targetExit.current() ?? this.helperExit.current()!;
        this.unbindAbort();
        return {
          ...this.cleanupResult(true, false),
          exit,
        };
      }

      forced = true;
      await this.writeControl('kill');
      if (!this.targetExit.current()) {
        this.targetExit.resolve({ code: null, signal: 'SIGKILL' });
      }
      const forceDeadline = Date.now() + this.options.forceTerminationMs;
      if (!await this.observeEmpty(forceDeadline)) {
        throw new ProcessTreeCleanupError(
          'POSIX guardian did not exit and empty its owned process group within the cleanup deadline; quarantine is required.',
          this,
        );
      }
      this.unbindAbort();
      return this.cleanupResult(false, forced);
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
  const helperPath = hooks.posixHelperPath
    ?? fileURLToPath(new URL('./process-tree-posix-helper.mjs', import.meta.url));
  const child = spawn(
    process.execPath,
    [helperPath],
    {
      shell: false,
      // The guardian, not the target, remains the durable session/group leader.
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe'],
      env: guardianEnvironment(),
    },
  ) as ChildProcessWithoutNullStreams;
  const { commands, events } = childPipes(child);
  const targetExit = targetExitState();
  const protocol = new PosixEventProtocol(
    events,
    targetExit,
    hooks.onPosixEvent,
  );
  const tree = new PosixManagedProcessTree(
    child,
    commands,
    targetExit,
    options,
    hooks,
  );
  tree.bindAbort(options.signal);

  try {
    await waitForSpawn(child);
    const config = Buffer.from(`${JSON.stringify({
      version: 1,
      command: options.command,
      args: options.args,
      cwd: options.cwd ?? null,
      env: options.env,
      parent_pid: process.pid,
      parent_incarnation: CURRENT_PROCESS_INCARNATION ?? null,
    })}\n`, 'utf8');
    if (config.length > CONFIG_MAX_BYTES) {
      throw new Error(`POSIX guardian configuration exceeds ${CONFIG_MAX_BYTES} bytes.`);
    }
    commands.write(config);
    const ready = await protocol.ready();
    tree.declareReady(ready);

    if (!processMatchesIncarnation(ready.helper_pid, ready.helper_incarnation)) {
      throw new Error('POSIX guardian incarnation could not be verified.');
    }
    const targetMatches = processMatchesIncarnation(
      ready.target_pid,
      ready.target_incarnation,
    );
    if (!targetMatches && !ready.target_incarnation.startsWith('completed:')) {
      await Promise.race([
        targetExit.promise.catch(() => undefined),
        sleep(250),
      ]);
      if (!targetExit.current()) {
        throw new Error('POSIX target incarnation could not be verified.');
      }
    }

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
        'POSIX process-tree startup failed and guardian cleanup could not be verified.',
        tree,
        { cause: cleanupError },
      );
    }
    if (options.signal?.aborted) throw abortError();
    throw error;
  }

  if (!tree.target) {
    throw new ProcessTreeStartupError(
      'POSIX process-tree guardian completed startup without target evidence.',
      tree,
    );
  }
  return tree as ManagedProcessTree;
}
