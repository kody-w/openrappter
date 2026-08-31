import {
  abortError,
  ProcessTreeCleanupError,
  ProcessTreeContainmentError,
  ProcessTreeStartupError,
  type ManagedPidEvidence,
  type ManagedProcessCleanup,
  type ManagedProcessExit,
  type ManagedProcessTree,
  type ManagedProcessTreeHandle,
  type NormalizedProcessTreeOptions,
  type ProcessTreeTestHooks,
  type SpawnManagedProcessTreeOptions,
} from './process-tree-internal.js';
import { spawnPosixProcessTree } from './process-tree-posix.js';
import { spawnWindowsProcessTree } from './process-tree-windows.js';

const DEFAULT_GRACE_MS = 1_000;
const DEFAULT_FORCE_MS = 2_000;
const MAX_TERMINATION_MS = 60_000;

export {
  ProcessTreeCleanupError,
  ProcessTreeContainmentError,
  ProcessTreeStartupError,
};
export type {
  ManagedPidEvidence,
  ManagedProcessCleanup,
  ManagedProcessExit,
  ManagedProcessTree,
  ManagedProcessTreeHandle,
  SpawnManagedProcessTreeOptions,
};

function boundedTimeout(name: string, value: number | undefined, fallback: number): number {
  const timeout = value ?? fallback;
  if (!Number.isSafeInteger(timeout) || timeout < 0 || timeout > MAX_TERMINATION_MS) {
    throw new RangeError(`${name} must be an integer from 0 through ${MAX_TERMINATION_MS} ms.`);
  }
  return timeout;
}

function boundedText(name: string, value: string, max = 32_767): string {
  if (!value || value.includes('\0') || Buffer.byteLength(value, 'utf8') > max) {
    throw new Error(`${name} must be non-empty, NUL-free, and at most ${max} UTF-8 bytes.`);
  }
  return value;
}

function normalizeOptions(
  options: SpawnManagedProcessTreeOptions,
): NormalizedProcessTreeOptions {
  const command = boundedText('command', options.command);
  const args = [...(options.args ?? [])];
  if (args.length > 256) throw new Error('args may contain at most 256 entries.');
  for (const [index, arg] of args.entries()) {
    if (typeof arg !== 'string' || arg.includes('\0') || Buffer.byteLength(arg, 'utf8') > 32_767) {
      throw new Error(`args[${index}] must be NUL-free and at most 32767 UTF-8 bytes.`);
    }
  }
  if (options.cwd !== undefined) boundedText('cwd', options.cwd);

  const entries = Object.entries(options.env);
  if (entries.length > 256) throw new Error('env may contain at most 256 entries.');
  const env: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [key, value] of entries) {
    if (
      !key
      || key.includes('\0')
      || key.includes('=')
      || Buffer.byteLength(key, 'utf8') > 32_767
      || typeof value !== 'string'
      || value.includes('\0')
      || Buffer.byteLength(value, 'utf8') > 32_767
    ) {
      throw new Error(`env entry ${JSON.stringify(key)} is not a bounded process environment value.`);
    }
    env[key] = value;
  }

  return {
    command,
    args,
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    env,
    gracefulTerminationMs: boundedTimeout(
      'gracefulTerminationMs',
      options.gracefulTerminationMs,
      DEFAULT_GRACE_MS,
    ),
    forceTerminationMs: boundedTimeout(
      'forceTerminationMs',
      options.forceTerminationMs,
      DEFAULT_FORCE_MS,
    ),
    ...(options.signal ? { signal: options.signal } : {}),
    containment: options.containment ?? 'cooperative',
  };
}

async function spawnWithHooks(
  options: SpawnManagedProcessTreeOptions,
  hooks: ProcessTreeTestHooks,
): Promise<ManagedProcessTree> {
  const normalized = normalizeOptions(options);
  if (normalized.signal?.aborted) throw abortError();
  const platform = hooks.platform ?? process.platform;
  return platform === 'win32'
    ? spawnWindowsProcessTree(normalized, hooks)
    : spawnPosixProcessTree(normalized, hooks);
}

/** Spawn one directly-executed target in owned, platform-specific containment. */
export function spawnManagedProcessTree(
  options: SpawnManagedProcessTreeOptions,
): Promise<ManagedProcessTree> {
  return spawnWithHooks(options, {});
}

/** Test seam; intentionally not re-exported from `infra/index.ts`. */
export function __spawnManagedProcessTreeForTest(
  options: SpawnManagedProcessTreeOptions,
  hooks: ProcessTreeTestHooks,
): Promise<ManagedProcessTree> {
  return spawnWithHooks(options, hooks);
}
