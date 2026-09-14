#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseOptions } from '../packages/release/src/cli-options.mjs';
import { invariant, REPOSITORY_ROOT } from '../packages/release/src/common.mjs';

const ORIGIN_MAIN = 'refs/remotes/origin/main';

function git(root, args) {
  const result = spawnSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  invariant(!result.error, `Unable to execute git: ${result.error?.message}`);
  return result;
}

function resolveCommit(root, ref, label) {
  const result = git(root, ['rev-parse', '--verify', `${ref}^{commit}`]);
  invariant(result.status === 0, `${label} does not resolve to a commit`);
  const commit = result.stdout.trim();
  invariant(/^[a-f0-9]{40,64}$/u.test(commit), `${label} resolved to an invalid commit`);
  return commit;
}

export function checkReleaseTagAncestry({ root = REPOSITORY_ROOT, tag } = {}) {
  root = path.resolve(root);
  invariant(typeof tag === 'string' && tag.startsWith('v'), 'Production release tag must match v*');
  const tagRef = `refs/tags/${tag}`;
  invariant(git(root, ['check-ref-format', tagRef]).status === 0, 'Production release tag must be a valid Git tag');

  invariant(
    git(root, ['fetch', '--no-tags', '--force', 'origin', '+refs/heads/main:refs/remotes/origin/main']).status === 0,
    'Unable to fetch authoritative origin/main',
  );
  const tagCommit = resolveCommit(root, tagRef, `Release tag ${tag}`);
  const mainCommit = resolveCommit(root, ORIGIN_MAIN, 'origin/main');
  const ancestry = git(root, ['merge-base', '--is-ancestor', tagCommit, mainCommit]);
  invariant(ancestry.status === 0 || ancestry.status === 1, 'Unable to compare release tag ancestry');
  invariant(ancestry.status === 0, `Release tag ${tag} peels to ${tagCommit}, which is not reachable from origin/main`);
  return { status: 'passed', tag, tagCommit, mainRef: ORIGIN_MAIN, mainCommit };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseOptions(process.argv.slice(2), ['root', 'tag']);
    console.log(JSON.stringify(checkReleaseTagAncestry({ root: options.root, tag: options.tag }), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
