import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * A third-party action must be pinned to a commit.
 *
 * A tag is mutable. `uses: someone/action@v2` runs whatever that maintainer
 * decides `v2` means at the moment the job starts, which for a workflow with
 * repository credentials is a standing invitation.
 *
 * This repository already knew that: `pypa/gh-action-pypi-publish` and
 * `softprops/action-gh-release` are pinned by SHA, and `release-bar.yml` pins
 * `swift-actions/setup-swift`. But `ci.yml` referenced that same action as
 * `@v2` — the identical inconsistency as the credential broker in #272, where
 * two workflows pinned an installer and the one running on every pull request
 * did not.
 *
 * SCOPE. `actions/*` and `github/*` are exempt. They are published by GitHub
 * itself from the same trust boundary the runner already lives in, they
 * receive security fixes within a major tag, and this repository has no
 * Dependabot to refresh a frozen SHA. Pinning those 49 references is a
 * maintenance policy for the owner to choose, not a rule to smuggle in through
 * a test — see the issue this test's PR links. The rule here is only the one
 * the repository already follows everywhere else.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const workflowsDir = path.resolve(here, '../../../..', '.github/workflows');

const FIRST_PARTY = /^(actions|github)\//;
const COMMIT_SHA = /^[0-9a-f]{40}$/;

interface Ref {
  workflow: string;
  action: string;
  ref: string;
}

function actionReferences(): Ref[] {
  const refs: Ref[] = [];
  for (const file of readdirSync(workflowsDir).filter((f) => /\.ya?ml$/.test(f))) {
    const source = readFileSync(path.join(workflowsDir, file), 'utf8');
    for (const line of source.split('\n')) {
      // Skip comments so a commented-out example cannot fail the build.
      if (/^\s*#/.test(line)) continue;
      const m = /^\s*-?\s*uses:\s*["']?([^"'\s@]+)@([^"'\s#]+)/.exec(line);
      if (!m) continue;
      const [, action, ref] = m;
      if (action.startsWith('./') || action.startsWith('docker://')) continue;
      refs.push({ workflow: file, action, ref });
    }
  }
  return refs;
}

describe('third-party actions are pinned to a commit', () => {
  it('finds the actions this repository uses', () => {
    // Anti-vacuity: a parse that matched nothing would make the rule below
    // hold over an empty set.
    const refs = actionReferences();
    expect(refs.length).toBeGreaterThan(20);
    expect(refs.some((r) => FIRST_PARTY.test(r.action))).toBe(true);
    expect(refs.some((r) => !FIRST_PARTY.test(r.action))).toBe(true);
  });

  it('every third-party action is referenced by commit, never a tag', () => {
    const mutable = actionReferences()
      .filter((r) => !FIRST_PARTY.test(r.action))
      .filter((r) => !COMMIT_SHA.test(r.ref))
      .map((r) => `${r.workflow}: ${r.action}@${r.ref} is a mutable reference`);
    expect(mutable).toEqual([]);
  });

  it('the same action is not pinned two different ways', () => {
    // The failure in #272 and here was not an unpinned dependency in the
    // abstract — it was one workflow disagreeing with another about the same
    // dependency, which is how a hardened pattern grows a hole.
    const byAction = new Map<string, Set<string>>();
    for (const r of actionReferences()) {
      if (FIRST_PARTY.test(r.action)) continue;
      if (!byAction.has(r.action)) byAction.set(r.action, new Set());
      byAction.get(r.action)!.add(r.ref);
    }
    const divergent = [...byAction.entries()]
      .filter(([, refs]) => refs.size > 1)
      .map(([action, refs]) => `${action} is referenced as ${[...refs].join(' and ')}`);
    expect(divergent).toEqual([]);
  });
});
