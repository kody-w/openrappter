import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { UpdateAgent } from '../UpdateAgent.js';

/**
 * The updater stashes local changes, pulls, rebuilds, and pops.
 *
 * Two things went wrong with that, and both are about the stash *stack* rather
 * than the stash itself.
 *
 * `git stash` on a clean tree prints "No local changes to save" and exits 0
 * without creating an entry. The old code popped unconditionally, so an update
 * run on a clean checkout restored — and dropped — whatever the owner had
 * stashed previously, possibly days earlier.
 *
 * And the pop was written `git stash pop 2>/dev/null || true`, so a pop that
 * conflicted with the freshly pulled version left conflict markers in the
 * working tree, kept the entry, and the update reported success.
 *
 * These run against a real repository with a real remote, because the bug was
 * in what git does, not in what the code says it does.
 */

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf-8' });
}

describe('UpdateAgent stash handling', () => {
  let root: string;
  let origin: string;
  let home: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'update-agent-'));
    origin = path.join(root, 'origin');
    home = path.join(root, '.openrappter');

    mkdirSync(origin);
    git(origin, 'init', '-q', '--bare', '--initial-branch=main');

    const seed = path.join(root, 'seed');
    mkdirSync(seed);
    git(seed, 'init', '-q', '--initial-branch=main');
    git(seed, 'config', 'user.email', 'test@example.com');
    git(seed, 'config', 'user.name', 'Test');
    writeFileSync(path.join(seed, 'file.txt'), 'v1\n');
    git(seed, 'add', '.');
    git(seed, 'commit', '-qm', 'init');
    git(seed, 'remote', 'add', 'origin', origin);
    git(seed, 'push', '-q', 'origin', 'main');

    execFileSync('git', ['clone', '-q', origin, home], { encoding: 'utf-8' });
    git(home, 'config', 'user.email', 'test@example.com');
    git(home, 'config', 'user.name', 'Test');
    // typescript/ must exist: the agent reads a version file from it.
    mkdirSync(path.join(home, 'typescript'), { recursive: true });
    writeFileSync(
      path.join(home, 'typescript', 'package.json'),
      JSON.stringify({ name: 'openrappter', version: '1.0.0' }),
    );
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('does not restore a stash it did not create', async () => {
    // The owner stashed something earlier and their tree is now clean.
    writeFileSync(path.join(home, 'file.txt'), 'WORK FROM LAST TUESDAY\n');
    git(home, 'stash', 'push', '-q', '--include-untracked', '-m', 'owner-work');
    expect(git(home, 'stash', 'list')).toContain('owner-work');
    expect(git(home, 'status', '--porcelain').trim()).toBe('');

    await new UpdateAgent(home).perform({ action: 'update' });

    // The old entry must still be there, and must not have been dumped into
    // the working tree.
    expect(git(home, 'stash', 'list')).toContain('owner-work');
    expect(readFileSync(path.join(home, 'file.txt'), 'utf-8')).toBe('v1\n');
  });

  it('restores changes it did stash', async () => {
    writeFileSync(path.join(home, 'file.txt'), 'MY EDIT\n');

    await new UpdateAgent(home).perform({ action: 'update' });

    expect(readFileSync(path.join(home, 'file.txt'), 'utf-8')).toBe('MY EDIT\n');
    expect(git(home, 'stash', 'list').trim()).toBe('');
  });

  it('says where the work is when the update fails before restoring it', async () => {
    // Local edit to the same line the upstream update changes.
    writeFileSync(path.join(home, 'file.txt'), 'MY EDIT\n');

    // Upstream moves that line.
    const seed = path.join(root, 'seed');
    writeFileSync(path.join(seed, 'file.txt'), 'v2-from-upstream\n');
    git(seed, 'commit', '-qam', 'upstream change');
    git(seed, 'push', '-q', 'origin', 'main');

    const raw = await new UpdateAgent(home).perform({ action: 'update' });
    const result = JSON.parse(raw as string);

    // The rebuild fails here (this fixture is not an npm project), which is
    // the realistic case: anything between the stash and the pop can fail.
    expect(result.status).toBe('error');
    expect(result.message).toMatch(/stash entry "openrappter-update-/);
    expect(result.message).toMatch(/git stash pop/);
    // And the work really is there to recover.
    expect(git(home, 'stash', 'list')).toContain('openrappter-update-');
  });
});
