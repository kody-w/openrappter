import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, readlink, realpath } from 'node:fs/promises';
import path from 'node:path';
import { digest, invariant, requireRealDirectory, safeRelative, sha256, validateHash } from './common.mjs';

const LOCKFILE = /(?:^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml)$/u;
const gitBlobHash = bytes => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export async function inventoryTree(directory) {
  const root = await requireRealDirectory(directory);
  const entries = [];
  const names = new Set();
  async function visit(relative) {
    const absolute = path.join(root, relative);
    const stat = await lstat(absolute);
    if (relative) {
      safeRelative(relative);
      const folded = relative.normalize('NFC').toLowerCase();
      invariant(!names.has(folded), `Case-colliding artifact path: ${relative}`);
      names.add(folded);
    }
    if (stat.isDirectory()) {
      if (relative) entries.push({ path: relative, type: 'directory', mode: 0o755 });
      for (const name of (await readdir(absolute)).sort()) await visit(relative ? `${relative}/${name}` : name);
    } else if (stat.isFile()) {
      invariant(stat.nlink === 1 && (stat.mode & 0o6000) === 0, `Linked or privileged artifact file: ${relative}`);
      const bytes = await readFile(absolute);
      entries.push({ path: relative, type: 'file', mode: (stat.mode & 0o111) ? 0o755 : 0o644, size: bytes.length, sha256: sha256(bytes) });
    } else if (stat.isSymbolicLink()) {
      const target = await readlink(absolute);
      invariant(!path.isAbsolute(target) && !/[\u0000-\u001f]/u.test(target), `Unsafe artifact symlink: ${relative}`);
      invariant(inside(root, await realpath(absolute)), `Escaping artifact symlink: ${relative}`);
      entries.push({ path: relative, type: 'symlink', target });
    } else {
      throw new Error(`Special files are not releasable: ${relative}`);
    }
  }
  await visit('');
  entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return { digest: digest(entries), entries };
}

export function validateInventory(inventory, label) {
  invariant(inventory && Array.isArray(inventory.entries) && inventory.entries.length > 0, `${label} inventory is empty`);
  validateHash(inventory.digest, `${label} tree digest`);
  const paths = new Set();
  let previous = '';
  for (const entry of inventory.entries) {
    safeRelative(entry.path);
    invariant(entry.path > previous && !paths.has(entry.path.toLowerCase()), `${label} inventory must be unique and sorted`);
    paths.add(entry.path.toLowerCase());
    previous = entry.path;
    if (entry.type === 'file') {
      invariant([0o644, 0o755].includes(entry.mode), `${label} file mode is invalid`);
      invariant(Number.isSafeInteger(entry.size) && entry.size >= 0, `${label} file size is invalid`);
      validateHash(entry.sha256, `${label} content digest`);
    } else if (entry.type === 'symlink') {
      invariant(typeof entry.target === 'string' && !path.isAbsolute(entry.target), `${label} symlink is invalid`);
    } else {
      invariant(entry.type === 'directory' && entry.mode === 0o755, `${label} entry type is invalid`);
    }
  }
  invariant(digest(inventory.entries) === inventory.digest, `${label} inventory digest does not match`);
}

export async function sourceSnapshot(root, { requireClean = true } = {}) {
  root = await requireRealDirectory(root);
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1' } });
  invariant(path.resolve(git('rev-parse', '--show-toplevel').trim()) === root, 'Source must be the complete repository root');
  const commit = git('rev-parse', 'HEAD').trim();
  invariant(/^[a-f0-9]{40}$/u.test(commit), 'Source commit must be an exact SHA-1 Git commit');
  const status = git('status', '--porcelain=v1', '--untracked-files=all', '--ignore-submodules=none');
  invariant(!requireClean || status.length === 0, 'Production requires an exact clean committed source tree');
  let dirty = status.length !== 0;
  const entries = [];
  const index = git('ls-files', '--stage', '-z').split('\0').filter(Boolean).map(line => {
    const match = /^(\d+) ([a-f0-9]+) 0\t([\s\S]+)$/u.exec(line);
    invariant(match, 'Unmerged source paths cannot be released');
    return { mode: match[1], objectId: match[2], relative: match[3] };
  });
  if (!requireClean) {
    for (const relative of git('ls-files', '--others', '--exclude-standard', '-z').split('\0').filter(Boolean)) index.push({ mode: null, objectId: null, relative });
  }
  const seen = new Set();
  for (const indexed of index) {
    const { relative } = indexed;
    safeRelative(relative);
    invariant(!seen.has(relative.toLowerCase()), `Case-colliding source path: ${relative}`);
    seen.add(relative.toLowerCase());
    invariant(indexed.mode !== '160000', 'Submodules are not a complete self-contained source release');
    const absolute = path.join(root, relative);
    const stat = await lstat(absolute).catch(error => {
      if (!requireClean && error.code === 'ENOENT') return null;
      throw error;
    });
    if (!stat) continue;
    const mode = indexed.mode ?? (stat.isSymbolicLink() ? '120000' : (stat.mode & 0o111) ? '100755' : '100644');
    if (mode === '120000') {
      invariant(stat.isSymbolicLink(), `Source symlink changed type: ${relative}`);
      const target = await readlink(absolute);
      invariant(!path.isAbsolute(target) && inside(root, await realpath(absolute)), `Escaping source symlink: ${relative}`);
      if (indexed.objectId && gitBlobHash(Buffer.from(target)) !== indexed.objectId) {
        dirty = true;
        invariant(!requireClean, `Working source differs from its committed blob: ${relative}`);
      }
      entries.push({ path: relative, type: 'symlink', target });
    } else {
      invariant(['100644', '100755'].includes(mode) && stat.isFile(), `Unsupported source type: ${relative}`);
      invariant((stat.mode & 0o6000) === 0, `Privileged source file is not releasable: ${relative}`);
      const actualMode = (stat.mode & 0o111) ? '100755' : '100644';
      invariant(!requireClean || actualMode === mode, `Source executable mode differs from Git: ${relative}`);
      const bytes = await readFile(absolute);
      if (actualMode !== mode || (indexed.objectId && gitBlobHash(bytes) !== indexed.objectId)) {
        dirty = true;
        invariant(!requireClean, `Working source differs from its committed blob: ${relative}`);
      }
      entries.push({ path: relative, type: 'file', mode: actualMode === '100755' ? 0o755 : 0o644, size: bytes.length, sha256: sha256(bytes) });
    }
  }
  entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  invariant(entries.length > 0, 'The source tree is empty');
  const locks = entries.filter(entry => entry.type === 'file' && LOCKFILE.test(entry.path));
  invariant(locks.some(entry => entry.path === 'package-lock.json'), 'A committed root package-lock.json is required');
  return { commit, dirty, digest: digest(entries), entries, locks: { digest: digest(locks), entries: locks } };
}

export async function fileDigest(filename) {
  const stat = await lstat(filename);
  invariant(stat.isFile() && !stat.isSymbolicLink(), 'Artifact must be a regular file');
  const bytes = await readFile(filename);
  return { size: bytes.length, sha256: sha256(bytes) };
}

export async function verifySource(root, expected) {
  const actual = await sourceSnapshot(root, { requireClean: !expected.dirty });
  invariant(actual.commit === expected.commit && actual.digest === expected.digest, 'Complete source tree does not match provenance');
  invariant(actual.locks.digest === expected.locks.digest, 'Complete lockfile set does not match provenance');
  return actual;
}
