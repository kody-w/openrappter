/**
 * A rappter calls itself what the roster calls it. — #142
 *
 * The declared name is what `/health`, the anatomy surface and the Neighbor
 * agent all report. Every name the roster expects is canonical, because the
 * instance directory and the lock are derived through `canonicalInstanceKey`.
 * Publishing the raw `--instance` string made those two disagree, and the
 * ownership check added in #131 called a live twin dead.
 *
 * Fixing the comparison alone would have been enough to stop that, and is
 * covered in the roster suite. It would still have left `/health` reporting
 * "review demo twin" while `openrappter twins` printed `review_demo_twin` — the
 * same fact under two names, which is how this class of defect starts. So the
 * declaration is pinned here too, because a negative control showed the roster
 * tests could not see it.
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  declareCurrentInstance,
  currentInstanceName,
  currentInstanceDeclared,
  __resetCurrentInstanceForTest,
} from '../../infra/current-instance.js';
import { canonicalInstanceKey } from '../../infra/gateway-lock.js';

afterEach(() => __resetCurrentInstanceForTest());

describe('the declared instance is the key the roster uses', () => {
  it('stores a name that needed escaping as the escaped key', () => {
    declareCurrentInstance('review demo twin');

    expect(currentInstanceName()).toBe('review_demo_twin');
    expect(currentInstanceName()).toBe(canonicalInstanceKey('review demo twin'));
  });

  it('agrees with the key for every shape a name can take', () => {
    // The space was the case that bit. Cover the space of shapes rather than
    // the one example, which is the lesson from the channel-guard tests.
    for (const raw of ['plain', 'Mixed_Case', 'has space', 'a@b', 'dots.and-dashes', 'tab\there']) {
      __resetCurrentInstanceForTest();
      declareCurrentInstance(raw);
      expect(currentInstanceName()).toBe(canonicalInstanceKey(raw));
    }
  });

  it('leaves the alpha as undefined rather than canonicalising nothing', () => {
    declareCurrentInstance(undefined);

    expect(currentInstanceDeclared()).toBe(true);
    expect(currentInstanceName()).toBeUndefined();
  });

  it('treats a blank name as the alpha, not as an instance called ""', () => {
    declareCurrentInstance('   ');

    expect(currentInstanceName()).toBeUndefined();
  });
});
