import { constants, type Stats } from 'node:fs';
import fs, { type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { WorkspaceError } from './types.js';

const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const RESERVED_COMPONENT = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i;
const AGENT_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function validateWorkspaceAgentId(value: unknown): string {
  if (
    typeof value !== 'string' || value.length === 0 || value.length > 64
    || AGENT_ID.exec(value)?.[0] !== value || RESERVED_COMPONENT.test(value)
  ) {
    throw new WorkspaceError(
      'invalid-agent-id',
      'agentId must be a non-reserved, lowercase alphanumeric label of at most 64 characters, with single interior hyphens',
    );
  }
  return value;
}

export function validateWorkspaceRoot(value: unknown): string {
  if (
    typeof value !== 'string' || !path.isAbsolute(value) || /\p{Cc}/u.test(value)
    || (process.platform !== 'win32' && value.includes('\\'))
    || value.split(/[\\/]/).some((part) => part === '.' || part === '..')
  ) {
    throw new WorkspaceError('invalid-path', 'workspace root must be absolute and contain no dot segments or control characters');
  }
  const root = path.resolve(value);
  if (root === path.parse(root).root) {
    throw new WorkspaceError('invalid-path', 'the filesystem root cannot be a workspace store');
  }
  return root;
}

export function validateWorkspaceRelativePath(value: unknown): string {
  if (
    typeof value !== 'string' || value.length === 0 || value.length > 1024
    || /[\\%\p{Cc}]/u.test(value)
    || value.split('/').some((part) =>
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(part)
      || part.endsWith('.') || RESERVED_COMPONENT.test(part))
  ) {
    throw new WorkspaceError('invalid-path', 'file paths must be relative, portable path components without traversal or encoded separators');
  }
  return value;
}

function errno(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

function inside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root + path.sep);
}

function checkPrivate(file: string, stat: Stats): void {
  if (process.platform === 'win32') return;
  if (
    (stat.mode & 0o077) !== 0
    || (typeof process.getuid === 'function' && stat.uid !== process.getuid())
  ) {
    throw new WorkspaceError('unsafe-path', `workspace-owned path must be private and owned by the current user: ${file}`);
  }
}

function checkFile(file: string, stat: Stats, allowUnlinked = false): void {
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.nlink !== 1 && !(allowUnlinked && stat.nlink === 0))) {
    throw new WorkspaceError('unsafe-path', `expected a regular, unlinked workspace file: ${file}`);
  }
  checkPrivate(file, stat);
}

/**
 * Check every ancestor, not just the final component. Never chmod an ancestor
 * owned by the host; only directories under privateRoot must be private.
 */
export async function directoryTree(
  directory: string,
  privateRoot: string,
  create = false,
): Promise<boolean> {
  const parsedRoot = path.parse(directory).root;
  let current = parsedRoot;
  for (const part of directory.slice(parsedRoot.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let stat: Stats;
    try {
      stat = await fs.lstat(current);
    } catch (error) {
      if (errno(error) !== 'ENOENT') throw error;
      if (!create) return false;
      try {
        await fs.mkdir(current, { mode: 0o700 });
        await syncDirectory(path.dirname(current));
      } catch (mkdirError) {
        if (errno(mkdirError) !== 'EEXIST') throw mkdirError;
      }
      stat = await fs.lstat(current);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new WorkspaceError('unsafe-path', `workspace path contains a link or non-directory: ${current}`);
    }
    if (inside(privateRoot, current)) checkPrivate(current, stat);
  }
  return true;
}

export async function requireDirectory(directory: string, privateRoot: string): Promise<void> {
  if (!await directoryTree(directory, privateRoot)) {
    throw new WorkspaceError('integrity', `required workspace directory is missing: ${directory}`);
  }
}

export async function readPrivateFile(
  file: string,
  privateRoot: string,
  maxBytes: number,
  atomicSnapshot = false,
): Promise<Buffer> {
  await requireDirectory(path.dirname(file), privateRoot);
  let handle: FileHandle | undefined;
  try {
    const entry = await fs.lstat(file);
    checkFile(file, entry, atomicSnapshot);
    handle = await fs.open(file, constants.O_RDONLY | NOFOLLOW | constants.O_NONBLOCK);
    const before = await handle.stat();
    checkFile(file, before, atomicSnapshot);
    // A reader may race the manifest's atomic rename. Either checked inode is
    // a valid snapshot; immutable identity/frame objects may not be replaced.
    if (!atomicSnapshot && (before.ino !== entry.ino || before.dev !== entry.dev)) {
      throw new WorkspaceError('unsafe-path', `workspace file changed while opening: ${file}`);
    }
    if (before.size > maxBytes) {
      throw new WorkspaceError('limit-exceeded', `workspace file exceeds ${maxBytes} bytes: ${file}`);
    }
    // A bounded read also fails closed if another process grows the file.
    const bytes = Buffer.alloc(before.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (read.bytesRead === 0) break;
      offset += read.bytesRead;
    }
    const after = await handle.stat();
    checkFile(file, after, atomicSnapshot);
    const renamedSnapshot = atomicSnapshot && before.nlink === 1 && after.nlink === 0;
    if (
      offset !== before.size || after.size !== before.size
      || after.mtimeMs !== before.mtimeMs || (after.ctimeMs !== before.ctimeMs && !renamedSnapshot)
    ) {
      throw new WorkspaceError('integrity', `workspace file changed while reading: ${file}`);
    }
    return bytes.subarray(0, offset);
  } catch (error) {
    if (errno(error) === 'ENOENT') {
      throw new WorkspaceError('integrity', `required workspace file is missing: ${file}`, error);
    }
    if (errno(error) === 'ELOOP') {
      throw new WorkspaceError('unsafe-path', `workspace file is a symbolic link: ${file}`, error);
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

export async function writePrivateFile(file: string, bytes: Buffer, privateRoot: string): Promise<void> {
  await requireDirectory(path.dirname(file), privateRoot);
  const handle = await fs.open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function syncDirectory(directory: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await fs.open(directory, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | NOFOLLOW);
    await handle.sync();
  } catch (error) {
    // Windows does not expose directory fsync on all supported filesystems.
    if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EINVAL', 'ENOTSUP', 'EISDIR', 'EBADF'].includes(errno(error) ?? '')) {
      throw error;
    }
  } finally {
    await handle?.close();
  }
}

/** Publish an immutable object without ever overwriting an existing frame. */
export async function publishFrame(file: string, bytes: Buffer, privateRoot: string): Promise<void> {
  const staging = path.join(path.dirname(file), `.frame-${randomUUID()}`);
  try {
    await writePrivateFile(staging, bytes, privateRoot);
    try {
      await fs.link(staging, file);
    } catch (error) {
      if (errno(error) !== 'EEXIST') throw error;
      const existing = await readPrivateFile(file, privateRoot, bytes.length);
      if (!existing.equals(bytes)) {
        throw new WorkspaceError('integrity', `an existing frame object conflicts with its address: ${file}`);
      }
    }
  } finally {
    await fs.rm(staging, { force: true });
  }
  await syncDirectory(path.dirname(file));
}

/** The manifest rename is the only commit point for the three streams. */
export async function replaceManifest(file: string, bytes: Buffer, privateRoot: string): Promise<void> {
  const staging = path.join(path.dirname(file), `.manifest-${randomUUID()}`);
  try {
    await writePrivateFile(staging, bytes, privateRoot);
    await fs.rename(staging, file);
    await syncDirectory(path.dirname(file));
  } finally {
    await fs.rm(staging, { force: true });
  }
}

export async function withWorkspaceLock<T>(
  root: string,
  agentId: string,
  timeoutMs: number,
  operation: () => Promise<T>,
): Promise<T> {
  const locks = path.join(root, '.locks');
  await directoryTree(locks, root, true);
  const lock = path.join(locks, `${agentId}.lock`);
  const deadline = performance.now() + timeoutMs;
  let handle: FileHandle;
  while (true) {
    await requireDirectory(locks, root);
    try {
      handle = await fs.open(lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600);
      break;
    } catch (error) {
      if (errno(error) !== 'EEXIST') throw error;
      try {
        checkFile(lock, await fs.lstat(lock));
      } catch (inspectError) {
        if (errno(inspectError) === 'ENOENT') continue;
        throw inspectError;
      }
      if (performance.now() >= deadline) {
        throw new WorkspaceError('busy', `writer lock is held at ${lock}; verify the writer has stopped before manually removing a stale lock`);
      }
      await sleep(Math.min(25, Math.max(1, deadline - performance.now())));
    }
  }
  const held = await handle.stat();
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid, token: randomUUID() }) + '\n');
    await handle.sync();
    return await operation();
  } finally {
    await handle.close();
    await requireDirectory(locks, root);
    const current = await fs.lstat(lock);
    if (current.ino !== held.ino || current.dev !== held.dev || !current.isFile() || current.isSymbolicLink()) {
      throw new WorkspaceError('unsafe-path', 'workspace writer lock was replaced');
    }
    await fs.unlink(lock);
    await syncDirectory(locks);
  }
}

export async function resolveContentPath(
  root: string,
  area: string,
  relative: string,
): Promise<string> {
  const parts = relative.split('/');
  const target = path.join(area, ...parts);
  await requireDirectory(area, root);
  if (!await directoryTree(path.dirname(target), root)) return target;
  try {
    const stat = await fs.lstat(target);
    if (stat.isSymbolicLink() || (!stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1))) {
      throw new WorkspaceError('unsafe-path', 'file/task paths may not reference links or special files');
    }
  } catch (error) {
    if (errno(error) !== 'ENOENT') throw error;
  }
  return target;
}
