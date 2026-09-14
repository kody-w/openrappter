import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { checkReleaseTagAncestry } from '../../../scripts/check-release-tag-ancestry.mjs';
import { commitFixture, put, scratch } from './helpers.mjs';

function git(root, ...args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

test('release tag ancestry accepts main ancestors and rejects branch-only tags', async t => {
  const directory = await scratch(t);
  const root = path.join(directory, 'repository');
  const remote = path.join(directory, 'origin.git');
  await mkdir(root, { recursive: true, mode: 0o700 });
  execFileSync('git', ['init', '--quiet', '--template=', root]);
  await put(root, 'release.txt', 'base\n');
  commitFixture(root);
  git(root, 'branch', '-M', 'main');
  const baseCommit = git(root, 'rev-parse', 'HEAD');
  git(root, 'tag', 'v2.0.0');
  git(root, '-c', 'user.name=Release Acceptance', '-c', 'user.email=release-tests@example.invalid',
    '-c', 'tag.gpgSign=false', 'tag', '--annotate', 'v2.0.1', '--message', 'Annotated release');

  execFileSync('git', ['init', '--bare', '--quiet', '--template=', remote]);
  git(root, 'remote', 'add', 'origin', remote);
  git(root, 'push', '--quiet', 'origin', 'main');
  await put(root, 'release.txt', 'main\n');
  commitFixture(root);
  const mainCommit = git(root, 'rev-parse', 'HEAD');
  git(root, 'push', '--quiet', 'origin', 'main');

  for (const tag of ['v2.0.0', 'v2.0.1']) {
    assert.deepEqual(checkReleaseTagAncestry({ root, tag }), {
      status: 'passed',
      tag,
      tagCommit: baseCommit,
      mainRef: 'refs/remotes/origin/main',
      mainCommit,
    });
  }

  git(root, 'checkout', '--quiet', '-b', 'branch-only', baseCommit);
  await put(root, 'release.txt', 'branch only\n');
  commitFixture(root);
  git(root, 'tag', 'v2.0.2');
  assert.throws(
    () => checkReleaseTagAncestry({ root, tag: 'v2.0.2' }),
    /not reachable from origin\/main/u,
  );
  assert.throws(
    () => checkReleaseTagAncestry({ root, tag: 'release-2.0.0' }),
    /must match v\*/u,
  );
  assert.throws(
    () => checkReleaseTagAncestry({ root, tag: 'v9.9.9' }),
    /does not resolve to a commit/u,
  );
});
