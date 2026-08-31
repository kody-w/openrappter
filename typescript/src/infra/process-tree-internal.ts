import {
  spawn as nodeSpawn,
  type ChildProcessWithoutNullStreams,
} from 'node:child_process';
import type { Socket } from 'node:net';
import type { Readable, Writable } from 'node:stream';

import { processMatchesIncarnation } from './process-incarnation.js';

export interface ManagedPidEvidence {
  pid: number;
  /** OS process-start marker. Null means the platform could not provide one. */
  incarnation: string | null;
}

export interface ManagedProcessExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface ManagedProcessCleanup {
  exit: ManagedProcessExit;
  graceful: boolean;
  forced: boolean;
  reaped: true;
  containmentEmpty: true;
  quarantineRequired: false;
}

export interface SpawnManagedProcessTreeOptions {
  command: string;
  args?: readonly string[];
  cwd?: string;
  /**
   * The complete target environment. Nothing from the parent is merged.
   * Callers must explicitly pass every variable the target is allowed to see.
   */
  env: Readonly<Record<string, string>>;
  gracefulTerminationMs?: number;
  forceTerminationMs?: number;
  signal?: AbortSignal;
  /**
   * POSIX process groups contain cooperative descendants, not a process that
   * deliberately calls setsid(2). Requesting hostile containment fails closed
   * before spawn; use a cgroup/container/sandbox backend and quarantine the
   * workload instead. Windows Job Objects provide hostile containment.
   */
  containment?: 'cooperative' | 'hostile';
}

export interface ManagedProcessTreeHandle {
  readonly platform: 'posix' | 'windows';
  readonly target: ManagedPidEvidence | undefined;
  readonly helper: ManagedPidEvidence | undefined;
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  /**
   * Wait for the root target (POSIX) or reviewed helper (Windows) to exit.
   * On POSIX, root exit alone does not prove descendants are gone; terminate()
   * performs verified process-group cleanup.
   */
  wait(): Promise<ManagedProcessExit>;
  /**
   * Retry-safe, bounded cleanup. A rejected attempt is never cached, so a
   * supervisor can retry after a transient signalling or observation failure.
   */
  terminate(): Promise<ManagedProcessCleanup>;
}

/** A successfully-started tree always has target PID/incarnation evidence. */
export interface ManagedProcessTree extends ManagedProcessTreeHandle {
  readonly target: ManagedPidEvidence;
}

export class ProcessTreeCleanupError extends Error {
  readonly quarantineRequired = true;

  constructor(
    message: string,
    readonly tree: ManagedProcessTreeHandle,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ProcessTreeCleanupError';
  }
}

export class ProcessTreeStartupError extends Error {
  readonly quarantineRequired = true;

  constructor(
    message: string,
    readonly tree: ManagedProcessTreeHandle,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ProcessTreeStartupError';
  }
}

export class ProcessTreeContainmentError extends Error {
  readonly quarantineRequired = true;

  constructor(message: string) {
    super(message);
    this.name = 'ProcessTreeContainmentError';
  }
}

export class ProcessTreeOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProcessTreeOutputError';
  }
}

export interface ProcessTreeTestHooks {
  platform?: NodeJS.Platform;
  spawn?: typeof nodeSpawn;
  processGroupMembers?: (
    processGroupId: number,
    timeoutMs: number,
  ) => number[] | Promise<number[]>;
  processGroupExists?: (processGroupId: number) => boolean;
  processAlive?: (evidence: ManagedPidEvidence) => boolean;
  killHelper?: (child: ChildProcessWithoutNullStreams) => boolean;
  writePosixControl?: (
    control: Writable,
    command: 'terminate' | 'kill',
  ) => Promise<void>;
  finishPosixGuardian?: (child: ChildProcessWithoutNullStreams) => boolean;
  simulateWindowsRelayFailure?: boolean;
  onPosixEvent?: (event: unknown) => void;
  afterSpawn?: (tree: ManagedProcessTreeHandle) => void | Promise<void>;
  posixHelperPath?: string;
  windowsHelperPath?: string;
  connectWindowsControl?: (pipeName: string, timeoutMs: number) => Promise<Socket>;
}

export interface NormalizedProcessTreeOptions {
  command: string;
  args: string[];
  cwd?: string;
  env: Record<string, string>;
  gracefulTerminationMs: number;
  forceTerminationMs: number;
  signal?: AbortSignal;
  containment: 'cooperative' | 'hostile';
}

export function abortError(): Error {
  const error = new Error('Managed process-tree startup was cancelled.');
  error.name = 'AbortError';
  return error;
}

export function childExit(child: ChildProcessWithoutNullStreams): {
  promise: Promise<ManagedProcessExit>;
  current: () => ManagedProcessExit | undefined;
} {
  let result: ManagedProcessExit | undefined;
  child.on('error', () => {
    // Spawn errors are handled by waitForSpawn(). Later child-process errors
    // must not become unhandled exceptions; terminate() proves cleanup from
    // process/group evidence rather than trusting an event message.
  });
  const promise = new Promise<ManagedProcessExit>((resolve) => {
    const settle = (code: number | null, signal: NodeJS.Signals | null) => {
      if (result) return;
      result = { code, signal };
      resolve(result);
    };
    // `exit` proves the direct child was reaped even if one of its descendants
    // inherited a stdio handle and keeps that stream open. `close` is the
    // fallback for a spawn failure, which does not emit `exit`.
    child.once('exit', settle);
    child.once('close', settle);
  });
  return { promise, current: () => result };
}

export function waitForSpawn(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolve, reject) => {
    const onSpawn = () => {
      child.off('error', onError);
      resolve();
    };
    const onError = (error: Error) => {
      child.off('spawn', onSpawn);
      reject(error);
    };
    child.once('spawn', onSpawn);
    child.once('error', onError);
  });
}

export function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function defaultProcessAlive(evidence: ManagedPidEvidence): boolean {
  if (evidence.incarnation) {
    return processMatchesIncarnation(evidence.pid, evidence.incarnation);
  }
  try {
    process.kill(evidence.pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export abstract class ManagedTreeBase implements ManagedProcessTreeHandle {
  abstract readonly platform: 'posix' | 'windows';
  abstract readonly target: ManagedPidEvidence | undefined;
  abstract readonly helper: ManagedPidEvidence | undefined;
  abstract readonly stdin: Writable;
  abstract readonly stdout: Readable;
  abstract readonly stderr: Readable;

  private terminationPromise: Promise<ManagedProcessCleanup> | undefined;
  private abortSignal: AbortSignal | undefined;
  private abortListener: (() => void) | undefined;

  abstract wait(): Promise<ManagedProcessExit>;
  protected abstract terminateOnce(): Promise<ManagedProcessCleanup>;

  bindAbort(signal: AbortSignal | undefined): void {
    if (!signal) return;
    this.abortSignal = signal;
    this.abortListener = () => {
      void this.terminate().catch(() => {
        // A supervisor may retry terminate(); never create an unhandled rejection.
      });
    };
    signal.addEventListener('abort', this.abortListener, { once: true });
    if (signal.aborted) this.abortListener();
  }

  protected unbindAbort(): void {
    if (this.abortSignal && this.abortListener) {
      this.abortSignal.removeEventListener('abort', this.abortListener);
    }
    this.abortSignal = undefined;
    this.abortListener = undefined;
  }

  terminate(): Promise<ManagedProcessCleanup> {
    if (this.terminationPromise) return this.terminationPromise;
    const attempt = this.terminateOnce();
    this.terminationPromise = attempt;
    void attempt.catch(() => {
      if (this.terminationPromise === attempt) this.terminationPromise = undefined;
    });
    return attempt;
  }
}
