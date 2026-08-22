/**
 * Fair, per-source asynchronous read/write fencing.
 *
 * Python agents execute a stable pathname while imports atomically replace that
 * pathname. Readers may share one source; a writer waits for existing readers
 * and prevents later readers from bypassing it. Locks for different canonical
 * source paths are independent.
 */

import { realpathSync } from "node:fs";
import path from "node:path";

type AccessMode = "read" | "write";
type Release = () => void;

interface Waiter {
  mode: AccessMode;
  grant: (release: Release) => void;
}

interface SourceLockState {
  readers: number;
  writer: boolean;
  queue: Waiter[];
}

const sourceLocks = new Map<string, SourceLockState>();

/**
 * Canonicalize the containing directory while preserving the stable leaf path.
 *
 * Resolving the complete file would follow a symlink and could change the lock
 * key when an atomic rename replaces that symlink. The parent-plus-leaf identity
 * remains stable across generations.
 */
export function canonicalAgentSourcePath(file: string): string {
  const absolute = path.resolve(file);
  const parent = path.dirname(absolute);
  try {
    return path.join(realpathSync.native(parent), path.basename(absolute));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return absolute;
    }
    throw error;
  }
}

function stateFor(key: string): SourceLockState {
  const existing = sourceLocks.get(key);
  if (existing) return existing;
  const created: SourceLockState = {
    readers: 0,
    writer: false,
    queue: [],
  };
  sourceLocks.set(key, created);
  return created;
}

function releaseFor(
  key: string,
  state: SourceLockState,
  mode: AccessMode,
): Release {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (mode === "read") {
      state.readers -= 1;
    } else {
      state.writer = false;
    }
    drain(key, state);
  };
}

function grantReader(
  key: string,
  state: SourceLockState,
  waiter: Waiter,
): void {
  state.readers += 1;
  waiter.grant(releaseFor(key, state, "read"));
}

function grantWriter(
  key: string,
  state: SourceLockState,
  waiter: Waiter,
): void {
  state.writer = true;
  waiter.grant(releaseFor(key, state, "write"));
}

function drain(key: string, state: SourceLockState): void {
  if (state.writer) return;

  if (state.readers > 0) {
    while (state.queue[0]?.mode === "read") {
      const reader = state.queue.shift();
      if (!reader) break;
      grantReader(key, state, reader);
    }
    return;
  }

  const first = state.queue.shift();
  if (!first) {
    if (sourceLocks.get(key) === state) sourceLocks.delete(key);
    return;
  }
  if (first.mode === "write") {
    grantWriter(key, state, first);
    return;
  }

  grantReader(key, state, first);
  while (state.queue[0]?.mode === "read") {
    const reader = state.queue.shift();
    if (!reader) break;
    grantReader(key, state, reader);
  }
}

function acquire(file: string, mode: AccessMode): Promise<Release> {
  const key = canonicalAgentSourcePath(file);
  const state = stateFor(key);
  return new Promise((grant) => {
    state.queue.push({ mode, grant });
    drain(key, state);
  });
}

async function withSourceLock<T>(
  file: string,
  mode: AccessMode,
  operation: () => Promise<T>,
): Promise<T> {
  const release = await acquire(file, mode);
  try {
    return await operation();
  } finally {
    release();
  }
}

export function withSourceReadLock<T>(
  file: string,
  operation: () => Promise<T>,
): Promise<T> {
  return withSourceLock(file, "read", operation);
}

export function withSourceWriteLock<T>(
  file: string,
  operation: () => Promise<T>,
): Promise<T> {
  return withSourceLock(file, "write", operation);
}
