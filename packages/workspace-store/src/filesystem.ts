import { randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import * as fs from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { canonicalJson, parseCanonicalJson, MAX_CANONICAL_BYTES } from '@rapp-work/rapp1';
export { artifactPath } from '@rapp-work/security';

export class WorkspaceError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'WorkspaceError'; }
}

function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === 'ENOENT'; }
function exists(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === 'EEXIST'; }
function same(a: Stats, b: Stats): boolean { return a.dev === b.dev && a.ino === b.ino; }

function privateNode(stat: Stats, directory: boolean): void {
  if ((directory ? !stat.isDirectory() : !stat.isFile()) || stat.isSymbolicLink()
    || (stat.mode & 0o777) !== (directory ? 0o700 : 0o600)
    || (typeof process.getuid === 'function' && stat.uid !== process.getuid())
    || (!directory && stat.nlink !== 1)) {
    throw new WorkspaceError('unsafe-node', 'Workspace nodes must be private owned regular files/directories, never links');
  }
}

/** Private POSIX roots are an integrity boundary, not a sandbox against the host UID. */
export class PrivateRoot {
  readonly #root: string;
  readonly #anchor: Stats;
  private constructor(root: string, anchor: Stats) { this.#root = root; this.#anchor = anchor; }

  static async open(root: string, create = false): Promise<PrivateRoot> {
    if (typeof root !== 'string' || !isAbsolute(root) || resolve(root) !== root || root === parse(root).root) {
      throw new WorkspaceError('root', 'A canonical absolute private root is required');
    }
    await PrivateRoot.ancestors(root);
    let stat: Stats;
    try { stat = await fs.lstat(root); } catch (error) {
      if (!missing(error) || !create) throw error;
      try { await fs.mkdir(root, { mode: 0o700 }); } catch (race) { if (!exists(race)) throw race; }
      stat = await fs.lstat(root);
    }
    privateNode(stat, true);
    return new PrivateRoot(root, stat);
  }

  private static async ancestors(path: string): Promise<void> {
    let current = parse(path).root;
    const parts = path.slice(current.length).split(sep).slice(0, -1);
    for (const part of parts) {
      current = join(current, part);
      const stat = await fs.lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new WorkspaceError('symlink', 'Ancestor symlinks are forbidden');
    }
  }

  #path(relative: string): string {
    if (typeof relative !== 'string' || isAbsolute(relative) || relative.includes('\\')
      || relative.split('/').some((part) => !part || part === '.' || part === '..' || part.includes('\0'))) {
      throw new WorkspaceError('path', 'Invalid internal workspace path');
    }
    return join(this.#root, relative);
  }

  async guard(relative?: string): Promise<void> {
    await PrivateRoot.ancestors(this.#root);
    const current = await fs.lstat(this.#root);
    privateNode(current, true);
    if (!same(current, this.#anchor)) throw new WorkspaceError('root-replaced', 'Private root was replaced');
    if (relative === undefined) return;
    this.#path(relative);
    let directory = this.#root;
    for (const component of relative.split('/').slice(0, -1)) {
      directory = join(directory, component);
      privateNode(await fs.lstat(directory), true);
    }
  }

  async stat(relative: string): Promise<Stats | null> {
    await this.guard(relative);
    try { return await fs.lstat(this.#path(relative)); } catch (error) { if (missing(error)) return null; throw error; }
  }

  async child(relative: string, create = false): Promise<PrivateRoot> {
    await this.guard(relative);
    return PrivateRoot.open(this.#path(relative), create);
  }

  async mkdir(relative: string): Promise<boolean> {
    await this.guard(relative);
    let created = true;
    try { await fs.mkdir(this.#path(relative), { mode: 0o700 }); } catch (error) {
      if (!exists(error)) throw error;
      created = false;
    }
    privateNode(await fs.lstat(this.#path(relative)), true);
    await this.syncDirectory(dirname(relative) === '.' ? undefined : dirname(relative));
    return created;
  }

  async directoryTree(relative: string): Promise<void> {
    let current = '';
    for (const part of relative.split('/')) {
      current = current ? `${current}/${part}` : part;
      await this.mkdir(current);
    }
  }

  async list(relative?: string): Promise<string[]> {
    await this.guard(relative === undefined ? undefined : `${relative}/entry`);
    return (await fs.readdir(relative === undefined ? this.#root : this.#path(relative))).sort();
  }

  async read(relative: string, maxBytes = MAX_CANONICAL_BYTES): Promise<Buffer> {
    await this.guard(relative);
    const path = this.#path(relative);
    const handle = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = await handle.stat();
      privateNode(before, false);
      if (before.size > maxBytes) throw new WorkspaceError('size', 'Private file exceeds its size bound');
      const linked = await fs.lstat(path);
      if (!same(before, linked) || linked.isSymbolicLink()) throw new WorkspaceError('file-replaced', 'File changed during open');
      await this.guard(relative);
      const bytes = await handle.readFile();
      const after = await handle.stat();
      if (bytes.length > maxBytes || !same(before, after) || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
        throw new WorkspaceError('file-changed', 'Immutable file changed during read');
      }
      const linkedAfter = await fs.lstat(path);
      privateNode(linkedAfter, false);
      if (!same(before, linkedAfter)) throw new WorkspaceError('file-replaced', 'File was replaced during read');
      await this.guard(relative);
      return bytes;
    } finally { await handle.close(); }
  }

  async writeAtomic(relative: string, bytes: Uint8Array | string, replace = false): Promise<void> {
    await this.guard(relative);
    const existing = await this.stat(relative);
    if (existing) {
      privateNode(existing, false);
      if (!replace) throw new WorkspaceError('already-exists', 'Mint-once/append-only file already exists');
    }
    const parent = dirname(relative);
    const stage = parent === '.' ? `.stage-${randomUUID()}` : `${parent}/.stage-${randomUUID()}`;
    const target = this.#path(relative);
    const stagePath = this.#path(stage);
    const handle = await fs.open(stagePath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    let stageExists = true;
    try {
      privateNode(await handle.stat(), false);
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
      await this.guard(relative);
      const latest = await this.stat(relative);
      if (latest) privateNode(latest, false);
      if (replace) {
        if ((existing === null) !== (latest === null) || (existing && latest && !same(existing, latest))) {
          throw new WorkspaceError('file-replaced', 'Atomic replacement target changed');
        }
        await fs.rename(stagePath, target);
        stageExists = false;
      } else {
        // link is the POSIX atomic no-replace publish; rename would overwrite a raced identity.
        await fs.link(stagePath, target);
        await fs.unlink(stagePath);
        stageExists = false;
      }
      await this.syncDirectory(parent === '.' ? undefined : parent);
      await this.guard(relative);
    } finally {
      await handle.close().catch(() => undefined);
      if (stageExists) await fs.unlink(stagePath).catch((error: unknown) => { if (!missing(error)) throw error; });
    }
  }

  async remove(relative: string): Promise<void> {
    await this.guard(relative);
    const stat = await this.stat(relative);
    if (stat === null) return;
    privateNode(stat, false);
    await fs.unlink(this.#path(relative));
    await this.syncDirectory(dirname(relative) === '.' ? undefined : dirname(relative));
  }

  async removeDirectory(relative: string): Promise<void> {
    await this.guard(relative);
    privateNode(await fs.lstat(this.#path(relative)), true);
    await fs.rmdir(this.#path(relative));
    await this.syncDirectory(dirname(relative) === '.' ? undefined : dirname(relative));
  }

  async syncDirectory(relative?: string): Promise<void> {
    await this.guard(relative === undefined ? undefined : `${relative}/entry`);
    const handle = await fs.open(relative === undefined ? this.#root : this.#path(relative),
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { privateNode(await handle.stat(), true); await handle.sync(); } finally { await handle.close(); }
  }

  async lock<T>(run: () => Promise<T>, timeoutMs: number): Promise<T> {
    const start = Date.now();
    const token = randomUUID();
    for (;;) {
      await this.guard();
      let acquired = false;
      try { acquired = await this.stat('.lock-recovery') === null && await this.mkdir('.lock'); }
      catch (error) {
        // The previous holder may remove its lock between mkdir(EEXIST) and lstat.
        if (!missing(error)) throw error;
      }
      if (acquired) {
        try {
          await this.writeAtomic('.lock/owner.json', canonicalJson({ pid: process.pid, token }));
        } catch (error) {
          // A partially minted lock is deliberately not guessed away.
          throw new WorkspaceError('lock-incomplete', error instanceof Error ? error.message : 'Lock ownership failed');
        }
        break;
      }
      await this.#reapDeadLock();
      if (Date.now() - start >= timeoutMs) throw new WorkspaceError('lock-timeout', 'Workspace is locked; live locks are never age-stolen');
      await delay(10);
    }
    try { return await run(); }
    finally {
      const owner = parseCanonicalJson(await this.read('.lock/owner.json', 4096)) as { token: string };
      if (owner.token !== token) throw new WorkspaceError('lock-owner', 'Lock ownership changed');
      await this.remove('.lock/owner.json');
      await this.removeDirectory('.lock');
    }
  }

  async #reapDeadLock(): Promise<void> {
    const lock = await this.stat('.lock');
    if (lock === null) return;
    privateNode(lock, true);
    let pid: number;
    try {
      const owner = parseCanonicalJson(await this.read('.lock/owner.json', 4096)) as { pid?: unknown };
      if (!Number.isSafeInteger(owner.pid) || (owner.pid as number) <= 0) return;
      pid = owner.pid as number;
    } catch (error) {
      if (missing(error)) return;
      // An atomic no-replace publish briefly has two links; an unlocking holder
      // can also unlink an already-open owner record. Neither is proof of death.
      if (error instanceof WorkspaceError
        && ['unsafe-node', 'file-replaced', 'file-changed'].includes(error.code)) return;
      throw error;
    }
    if (alive(pid)) return;
    // One reaper rechecks the inode and process under an exclusive guard.
    // A crash in this guard fails closed instead of risking a newly acquired lock.
    if (!await this.mkdir('.lock-recovery')) return;
    try {
      const latest = await this.stat('.lock');
      if (!latest || !same(latest, lock) || alive(pid)) return;
      await this.remove('.lock/owner.json');
      await this.removeDirectory('.lock');
    } finally { await this.removeDirectory('.lock-recovery'); }
  }
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}
