import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';
import { MemoryAgent } from '../agents/MemoryAgent.js';
import { readMemoryFile, withMemoryTransaction } from './json-store.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const require = createRequire(import.meta.url);
const loader = pathToFileURL(require.resolve('tsx/esm')).href;
const nativeWindows = process.platform === 'win32';
type Runtime = 'typescript' | 'python';
let home: string;
let file: string;
const children: Array<{ child: ChildProcessWithoutNullStreams; exited: Promise<number | null> }> = [];

beforeEach(() => {
  home = fs.mkdtempSync(path.join(process.env.OPENRAPPTER_HOME!, 'memory-process-'));
  file = path.join(home, 'memory.json');
  fs.writeFileSync(file, JSON.stringify({ legacy: { message: 'existing fact', theme: 'fact' } }));
});

afterEach(async () => {
  for (const { child } of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  await Promise.all(children.splice(0).map(({ exited }) => exited));
  vi.restoreAllMocks();
  fs.rmSync(home, { recursive: true, force: true });
});

async function worker(runtime: Runtime, mode: string, prefix = 'child', count = 1, directory = home) {
  const command = runtime === 'python'
    ? (process.env.PYTHON ?? (nativeWindows ? 'python' : 'python3'))
    : process.execPath;
  const args = runtime === 'python'
    ? ['-B', path.join(root, 'python/tests/fixtures/memory_writer.py')]
    : ['--import', loader, path.join(root, 'typescript/src/agents/__tests__/fixtures/memory-writer.ts')];
  const child = spawn(command, [...args, directory, mode, prefix, String(count)], {
    cwd: root,
    env: {
      PATH: process.env.PATH,
      HOME: home,
      USERPROFILE: home,
      SystemRoot: process.env.SystemRoot ?? process.env.SYSTEMROOT,
      WINDIR: process.env.WINDIR,
      OPENRAPPTER_HOME: home,
      TMPDIR: home,
      TEMP: home,
      TMP: home,
      PYTHONPATH: path.join(root, 'python'),
      PYTHONDONTWRITEBYTECODE: '1',
      TSX_DISABLE_CACHE: '1',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += String(chunk); });
  const exited = new Promise<number | null>(resolve => {
    child.once('exit', resolve);
    child.once('error', error => { stderr += String(error); resolve(-1); });
  });
  children.push({ child, exited });
  const lines: string[] = [];
  const input = createInterface({ input: child.stdout });
  input.on('line', line => lines.push(line));
  const line = async () => {
    await vi.waitFor(() => {
      if (lines.length === 0 && (child.exitCode !== null || child.signalCode !== null)) {
        throw new Error(`Worker exited without a result: ${stderr}`);
      }
      expect(lines.length).toBeGreaterThan(0);
    }, { timeout: 10_000, interval: 10 });
    return lines.shift()!;
  };
  expect(await line()).toBe('ready');
  return {
    child,
    exited,
    line,
    async release() {
      child.stdin.end('go\n');
      expect(await line()).toBe('attempting');
    },
  };
}

function messages(): string[] {
  return Object.values(readMemoryFile(file)).map(entry => entry.message).sort();
}

describe('memory transaction process protocol', () => {
  it('uses one lock identity through directory aliases', async () => {
    const alias = path.join(home, 'alias');
    fs.symlinkSync(home, alias, nativeWindows ? 'junction' : 'dir');
    const first = await worker('typescript', 'write', 'first', 8);
    const second = await worker('python', 'write', 'second', 8, alias);
    await Promise.all([first.release(), second.release()]);
    expect(JSON.parse(await first.line())).toHaveLength(8);
    expect(JSON.parse(await second.line())).toHaveLength(8);
    expect(await first.exited).toBe(0);
    expect(await second.exited).toBe(0);
    expect(messages()).toHaveLength(17);
  });

  it.each([
    ['typescript', 'typescript'],
    ['python', 'python'],
    ['typescript', 'python'],
  ] as const)('coordinates %s and %s writers through the real agents', async (first, second) => {
    const writers = await Promise.all([
      worker(first, 'write', 'first', 10),
      worker(second, 'write', 'second', 10),
    ]);
    await Promise.all(writers.map(writer => writer.release()));
    for (const writer of writers) {
      const results = JSON.parse(await writer.line());
      expect(results).toHaveLength(10);
      expect(results.every((result: { status: string }) => result.status === 'success')).toBe(true);
      expect(await writer.exited).toBe(0);
    }
    expect(messages()).toEqual([
      'existing fact',
      ...Array.from({ length: 10 }, (_, index) => `first-${index}`),
      ...Array.from({ length: 10 }, (_, index) => `second-${index}`),
    ].sort());
  });

  it.each([
    ['typescript', 'python'],
    ['python', 'typescript'],
  ] as const)('a %s lock excludes a %s writer, and dies with its process', async (first, second) => {
    const holder = await worker(first, 'hold');
    await holder.release();
    expect(await holder.line()).toBe('locked');
    const writer = await worker(second, 'write');
    await writer.release();
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(writer.child.exitCode).toBeNull();
    expect(messages()).toEqual(['existing fact']);
    holder.child.kill('SIGKILL');
    await holder.exited;
    expect(JSON.parse(await writer.line())[0].status).toBe('success');
    expect(await writer.exited).toBe(0);
    expect(messages()).toEqual(['child-0', 'existing fact']);
  });

  it.each(['typescript', 'python'] as const)('bounds lock waiting while a %s writer owns it', async runtime => {
    const holder = await worker(runtime, 'hold');
    await holder.release();
    expect(await holder.line()).toBe('locked');
    const inode = fs.statSync(`${file}.lock.sqlite3`).ino;
    const operation = vi.fn();
    let timerRan = false;
    const timer = setTimeout(() => { timerRan = true; }, 1);
    await expect(withMemoryTransaction(file, operation, 30)).rejects.toThrow('lock could not be acquired');
    clearTimeout(timer);
    expect(timerRan).toBe(true);
    expect(operation).not.toHaveBeenCalled();
    expect(fs.statSync(`${file}.lock.sqlite3`).ino).toBe(inode);
    expect(messages()).toEqual(['existing fact']);
  });

  it.each([
    ['typescript', 'before-replace'],
    ['typescript', 'after-replace'],
    ['python', 'before-replace'],
    ['python', 'after-replace'],
  ] as const)('recovers after killing %s %s', async (runtime, phase) => {
    const writer = await worker(runtime, phase);
    await writer.release();
    expect(await writer.line()).toBe(phase);
    writer.child.kill('SIGKILL');
    await writer.exited;
    const next = JSON.parse(await new MemoryAgent(home).perform({ action: 'remember', message: 'after recovery' }));
    expect(next.status).toBe('success');
    expect(messages()).toEqual(
      (phase === 'before-replace'
        ? ['after recovery', 'existing fact']
        : ['after recovery', 'child-0', 'existing fact']).sort(),
    );
  });

  it.each(['typescript', 'python'] as const)('retains an acknowledged %s fact after SIGKILL and restart', async runtime => {
    const writer = await worker(runtime, 'acknowledged');
    await writer.release();
    expect(JSON.parse(await writer.line())[0].status).toBe('success');
    writer.child.kill('SIGKILL');
    await writer.exited;
    expect(JSON.parse(await new MemoryAgent(home).perform({ action: 'remember', message: 'after restart' })).status).toBe('success');
    expect(messages()).toEqual(['after restart', 'child-0', 'existing fact']);
  });
});

describe('memory transaction failures', () => {
  it('rejects async transaction callbacks before they can run outside the lock', async () => {
    let called = false;
    await expect(withMemoryTransaction(file, async () => { called = true; }))
      .rejects.toThrow('synchronous callback');
    expect(called).toBe(false);
  });

  describe('platform-specific memory persistence', () => {
    function windowsFileHandles() {
      vi.spyOn(os, 'platform').mockReturnValue('win32');
      const open = fs.openSync;
      const directories: string[] = [];
      vi.spyOn(fs, 'openSync').mockImplementation(((target, ...args) => {
        if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
          directories.push(String(target));
          throw Object.assign(new Error('Windows CRT cannot open directories'), { code: 'EACCES' });
        }
        return open(target, ...args);
      }) as typeof fs.openSync);
      return directories;
    }

    it.each([false, true])('writes on Windows without directory handles (new directory: %s)', async nested => {
      const directories = windowsFileHandles();
      const directory = nested ? path.join(home, 'new', 'nested') : home;
      const order: string[] = [];
      const fsync = fs.fsyncSync;
      const rename = fs.renameSync;
      let replaced = false;
      vi.spyOn(fs, 'fsyncSync').mockImplementation(descriptor => {
        expect(fs.fstatSync(descriptor).isFile()).toBe(true);
        order.push(replaced ? 'published-file-sync' : 'staged-file-sync');
        fsync(descriptor);
      });
      vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
        rename(from, to);
        replaced = true;
        order.push('replace');
      });
      const result = JSON.parse(await new MemoryAgent(directory).perform({ action: 'remember', message: 'Windows fact' }));
      expect(result.status).toBe('success');
      expect(directories).toEqual([]);
      expect(order).toEqual(['staged-file-sync', 'replace', 'published-file-sync']);
      expect(readMemoryFile(path.join(directory, 'memory.json'))[result.key].message).toBe('Windows fact');
    });

    it.each([1, 2])('propagates Windows file-flush failure at stage %s', async failedStage => {
      windowsFileHandles();
      const before = fs.readFileSync(file);
      const fsync = fs.fsyncSync;
      let stage = 0;
      vi.spyOn(fs, 'fsyncSync').mockImplementation(descriptor => {
        if (++stage === failedStage) throw new Error('injected Windows file-flush failure');
        fsync(descriptor);
      });
      await expect(new MemoryAgent(home).perform({ action: 'remember', message: 'not acknowledged' }))
        .rejects.toThrow('Windows file-flush failure');
      if (failedStage === 1) expect(fs.readFileSync(file)).toEqual(before);
      else expect(messages()).toContain('not acknowledged');
    });

    it('does not swallow an access error when reopening the published Windows file', async () => {
      vi.spyOn(os, 'platform').mockReturnValue('win32');
      const open = fs.openSync;
      vi.spyOn(fs, 'openSync').mockImplementation(((target, flags, ...args) => {
        if (target === file && flags === fs.constants.O_RDWR) {
          throw Object.assign(new Error('published file access denied'), { code: 'EACCES' });
        }
        return open(target, flags, ...args);
      }) as typeof fs.openSync);
      await expect(new MemoryAgent(home).perform({ action: 'remember', message: 'not acknowledged' }))
        .rejects.toThrow('published file access denied');
    });

    it('keeps POSIX directory-open failures fatal', async () => {
      vi.spyOn(os, 'platform').mockReturnValue('linux');
      const before = fs.readFileSync(file);
      const open = fs.openSync;
      vi.spyOn(fs, 'openSync').mockImplementation(((target, ...args) => {
        if (target === home) throw Object.assign(new Error('directory access denied'), { code: 'EACCES' });
        return open(target, ...args);
      }) as typeof fs.openSync);
      await expect(new MemoryAgent(home).perform({ action: 'remember', message: 'must not commit' }))
        .rejects.toThrow('directory access denied');
      expect(fs.readFileSync(file)).toEqual(before);
    });
  });

  it.each(['symlink', 'hardlink'])('refuses a %s memory file instead of splitting lock identities', async kind => {
    const destination = path.join(home, 'original.json');
    fs.renameSync(file, destination);
    if (kind === 'symlink') fs.symlinkSync(destination, file);
    else fs.linkSync(destination, file);
    const before = fs.readFileSync(destination);
    await expect(new MemoryAgent(home).perform({ action: 'remember', message: 'must not commit' })).rejects.toThrow();
    expect(fs.readFileSync(destination)).toEqual(before);
  });

  it('durably creates a missing store directory before acknowledging its first fact', async () => {
    const directory = path.join(home, 'new', 'nested');
    const syncedDirectories: string[] = [];
    const descriptors = new Map<number, string>();
    const open = fs.openSync;
    const fsync = fs.fsyncSync;
    vi.spyOn(fs, 'openSync').mockImplementation(((target, ...args) => {
      const descriptor = open(target, ...args);
      if (fs.fstatSync(descriptor).isDirectory()) descriptors.set(descriptor, String(target));
      else descriptors.delete(descriptor);
      return descriptor;
    }) as typeof fs.openSync);
    vi.spyOn(fs, 'fsyncSync').mockImplementation(descriptor => {
      if (descriptors.has(descriptor)) syncedDirectories.push(descriptors.get(descriptor)!);
      fsync(descriptor);
    });
    const response = JSON.parse(await new MemoryAgent(directory).perform({ action: 'remember', message: 'first fact' }));
    expect(response.status).toBe('success');
    expect(syncedDirectories).toEqual(nativeWindows ? [] : [directory, path.dirname(directory), home, directory]);
    expect(readMemoryFile(path.join(directory, 'memory.json'))[response.key].message).toBe('first fact');
  });

  it.each(['corrupt', 'directory', 'symlink'])('fails closed on a %s lock path', async kind => {
    const before = fs.readFileSync(file);
    const lock = `${file}.lock.sqlite3`;
    if (kind === 'corrupt') fs.writeFileSync(lock, 'not a database');
    if (kind === 'directory') fs.mkdirSync(lock);
    if (kind === 'symlink') fs.symlinkSync(file, lock);
    await expect(new MemoryAgent(home).perform({ action: 'remember', message: 'must not commit' })).rejects.toThrow();
    expect(fs.readFileSync(file)).toEqual(before);
  });

  it('does not acknowledge a rename failure or leave its staged file behind', async () => {
    const before = fs.readFileSync(file);
    vi.spyOn(fs, 'renameSync').mockImplementation(() => { throw new Error('injected rename failure'); });
    await expect(new MemoryAgent(home).perform({ action: 'remember', message: 'must not commit' })).rejects.toThrow('rename failure');
    expect(fs.readFileSync(file)).toEqual(before);
    expect(fs.readdirSync(home).filter(name => name.endsWith('.pending'))).toEqual([]);
  });

  it('flushes before replacement and completes the platform commit flush before acknowledging', async () => {
    const order: string[] = [];
    const fsync = fs.fsyncSync;
    const rename = fs.renameSync;
    vi.spyOn(fs, 'fsyncSync').mockImplementation(descriptor => {
      order.push(fs.fstatSync(descriptor).isDirectory() ? 'directory-sync' : 'file-sync');
      fsync(descriptor);
    });
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      order.push('replace');
      rename(from, to);
    });
    expect(JSON.parse(await new MemoryAgent(home).perform({ action: 'remember', message: 'durable fact' })).status).toBe('success');
    expect(order).toEqual(['file-sync', 'replace', nativeWindows ? 'file-sync' : 'directory-sync']);
    if (!nativeWindows) expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it.each([false, true])('does not acknowledge fsync failure (after replacement: %s)', async afterReplacement => {
    const before = fs.readFileSync(file);
    const fsync = fs.fsyncSync;
    let stage = 0;
    vi.spyOn(fs, 'fsyncSync').mockImplementation(descriptor => {
      if (++stage === (afterReplacement ? 2 : 1)) throw new Error('injected fsync failure');
      fsync(descriptor);
    });
    await expect(new MemoryAgent(home).perform({ action: 'remember', message: 'not acknowledged' })).rejects.toThrow('fsync failure');
    if (!afterReplacement) expect(fs.readFileSync(file)).toEqual(before);
    else expect(messages()).toContain('not acknowledged'); // Ambiguous outcome, never false success.
  });

  it('never replaces an unreadable existing store with an empty snapshot', async () => {
    const before = fs.readFileSync(file);
    const open = fs.openSync;
    vi.spyOn(fs, 'openSync').mockImplementation(((target, ...args) => {
      if (target === file) throw Object.assign(new Error('injected access denial'), { code: 'EACCES' });
      return open(target, ...args);
    }) as typeof fs.openSync);
    await expect(new MemoryAgent(home).perform({ action: 'remember', message: 'must not commit' })).rejects.toThrow();
    vi.restoreAllMocks();
    expect(fs.readFileSync(file)).toEqual(before);
  });
});
