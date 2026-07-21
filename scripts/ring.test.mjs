import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  RINGS,
  PRERELEASE_RINGS,
  compareVersions,
  distTagForRing,
  nextRing,
  parseRingVersion,
  planPromotion,
  resolveInstallSpec,
  ringRank,
  ringVersion,
} from './ring.mjs';

const BASE = '1.11.0';

describe('train topology', () => {
  it('orders rings least-stable to most-stable', () => {
    assert.deepEqual(RINGS, ['canary', 'nightly', 'alpha', 'beta', 'stable']);
    assert.deepEqual(PRERELEASE_RINGS, ['canary', 'nightly', 'alpha', 'beta']);
  });

  it('advances one ring at a time and terminates at stable', () => {
    assert.equal(nextRing('canary'), 'nightly');
    assert.equal(nextRing('alpha'), 'beta');
    assert.equal(nextRing('beta'), 'stable');
    assert.equal(nextRing('stable'), undefined);
  });

  it('gives latest to stable only', () => {
    assert.equal(distTagForRing('stable'), 'latest');
    for (const ring of PRERELEASE_RINGS) {
      assert.notEqual(distTagForRing(ring), 'latest');
      assert.equal(distTagForRing(ring), ring);
    }
  });

  it('rejects unknown rings', () => {
    assert.throws(() => ringRank('lts'), /unknown ring/);
  });
});

describe('ringVersion', () => {
  it('builds a canary version from a commit sha', () => {
    assert.equal(
      ringVersion({ ring: 'canary', baseVersion: BASE, sha: 'a1b2c3d4e5f6' }),
      '1.11.0-0.canary.a1b2c3d4',
    );
  });

  it('builds a nightly version from a date stamp', () => {
    assert.equal(
      ringVersion({ ring: 'nightly', baseVersion: BASE, date: '20260721' }),
      '1.11.0-1.nightly.20260721',
    );
  });

  it('builds alpha and beta versions from counters', () => {
    assert.equal(ringVersion({ ring: 'alpha', baseVersion: BASE, counter: 1 }), '1.11.0-2.alpha.1');
    assert.equal(ringVersion({ ring: 'beta', baseVersion: BASE, counter: 12 }), '1.11.0-3.beta.12');
  });

  it('stable is the bare base version', () => {
    assert.equal(ringVersion({ ring: 'stable', baseVersion: BASE }), BASE);
  });

  it('rejects malformed inputs', () => {
    assert.throws(() => ringVersion({ ring: 'canary', baseVersion: BASE, sha: 'zz' }), /commit sha/);
    assert.throws(() => ringVersion({ ring: 'nightly', baseVersion: BASE, date: '7/21' }), /YYYYMMDD/);
    assert.throws(() => ringVersion({ ring: 'beta', baseVersion: BASE, counter: 0 }), /counter/);
    assert.throws(() => ringVersion({ ring: 'canary', baseVersion: '1.11' }), /MAJOR\.MINOR\.PATCH/);
  });
});

describe('semver precedence matches the train order', () => {
  // This is the property the whole ring grammar exists to guarantee.
  const ascending = [
    ringVersion({ ring: 'canary', baseVersion: BASE, sha: 'a1b2c3d4' }),
    ringVersion({ ring: 'nightly', baseVersion: BASE, date: '20260721' }),
    ringVersion({ ring: 'alpha', baseVersion: BASE, counter: 1 }),
    ringVersion({ ring: 'beta', baseVersion: BASE, counter: 1 }),
    ringVersion({ ring: 'stable', baseVersion: BASE }),
  ];

  it('sorts canary < nightly < alpha < beta < stable', () => {
    for (let i = 0; i < ascending.length - 1; i += 1) {
      assert.equal(
        compareVersions(ascending[i], ascending[i + 1]),
        -1,
        `${ascending[i]} should precede ${ascending[i + 1]}`,
      );
    }
  });

  it('is stable under sorting', () => {
    const shuffled = [ascending[3], ascending[0], ascending[4], ascending[1], ascending[2]];
    assert.deepEqual([...shuffled].sort(compareVersions), ascending);
  });

  it('would have inverted without the numeric rank prefix', () => {
    // Guards the design decision. Semver compares alphanumeric prerelease
    // identifiers in ASCII order, so bare ring names sort alphabetically:
    // 'beta' < 'canary' would put beta BELOW canary and invert the train.
    assert.ok('beta' < 'canary', 'bare ring names sort alphabetically');
    assert.ok('alpha' < 'beta' && 'canary' < 'nightly');
    // The rank prefix restores train order for the same two rings.
    assert.equal(compareVersions('1.11.0-0.canary.a1b2c3d4', '1.11.0-3.beta.1'), -1);
  });

  it('rejects prerelease shapes that carry no ring rank', () => {
    // An un-ranked prerelease has no defined position in the train, so the
    // comparator refuses it rather than guessing.
    assert.throws(() => compareVersions('1.11.0-beta.1', BASE), /not a train version/);
    assert.throws(() => compareVersions('1.10.4-bar', BASE), /not a train version/);
  });

  it('never ranks a prerelease above its own release', () => {
    for (const version of ascending.slice(0, -1)) {
      assert.equal(compareVersions(version, BASE), -1);
    }
  });

  it('orders successive builds within a ring', () => {
    assert.equal(compareVersions('1.11.0-3.beta.2', '1.11.0-3.beta.10'), -1);
    assert.equal(compareVersions('1.11.0-1.nightly.20260721', '1.11.0-1.nightly.20260722'), -1);
  });

  it('orders across base versions', () => {
    assert.equal(compareVersions('1.11.0', '1.12.0-0.canary.a1b2c3d4'), -1);
    assert.equal(compareVersions('1.11.0-3.beta.1', '1.12.0-0.canary.a1b2c3d4'), -1);
  });
});

describe('parseRingVersion', () => {
  it('round-trips every ring', () => {
    for (const ring of PRERELEASE_RINGS) {
      const version = ringVersion({
        ring, baseVersion: BASE, sha: 'a1b2c3d4', date: '20260721', counter: 3,
      });
      const parsed = parseRingVersion(version);
      assert.equal(parsed.ring, ring);
      assert.equal(parsed.baseVersion, BASE);
      assert.equal(parsed.rank, ringRank(ring));
    }
  });

  it('reads a bare version as stable', () => {
    assert.deepEqual(parseRingVersion(BASE), {
      version: BASE, baseVersion: BASE, ring: 'stable', rank: 4, suffix: undefined,
    });
  });

  it('rejects a rank that disagrees with the ring name', () => {
    // Sorts fine by accident, but lies about provenance.
    assert.equal(parseRingVersion('1.11.0-3.canary.a1b2c3d4'), undefined);
  });

  it('rejects foreign prerelease shapes', () => {
    assert.equal(parseRingVersion('1.11.0-rc.1'), undefined);
    assert.equal(parseRingVersion('1.10.4-bar'), undefined);
    assert.equal(parseRingVersion('not-a-version'), undefined);
  });
});

describe('planPromotion', () => {
  const canary = ringVersion({ ring: 'canary', baseVersion: BASE, sha: 'a1b2c3d4' });
  const published = [canary];

  it('promotes one ring forward without rebuilding', () => {
    const plan = planPromotion({ version: canary, from: 'canary', to: 'nightly', publishedVersions: published });
    assert.equal(plan.rebuild, false);
    assert.equal(plan.distTag, 'nightly');
    assert.equal(plan.version, canary);
  });

  it('refuses to skip rings', () => {
    assert.throws(
      () => planPromotion({ version: canary, from: 'canary', to: 'beta', publishedVersions: published }),
      /may not skip rings/,
    );
  });

  it('refuses to run backwards', () => {
    assert.throws(
      () => planPromotion({ version: canary, from: 'nightly', to: 'canary', publishedVersions: published }),
      /must advance the train/,
    );
  });

  it('refuses to promote an unpublished version', () => {
    assert.throws(
      () => planPromotion({ version: canary, from: 'canary', to: 'nightly', publishedVersions: [] }),
      /unpublished/,
    );
  });

  it('refuses a version that is not from the claimed ring', () => {
    assert.throws(
      () => planPromotion({ version: canary, from: 'alpha', to: 'beta', publishedVersions: published }),
      /belongs to ring canary/,
    );
  });

  it('never lets latest point at a prerelease', () => {
    const beta = ringVersion({ ring: 'beta', baseVersion: BASE, counter: 1 });
    assert.throws(
      () => planPromotion({ version: beta, from: 'beta', to: 'stable', publishedVersions: [beta] }),
      /latest never points at a prerelease/,
    );
  });
});

describe('resolveInstallSpec', () => {
  const pkg = 'openrappter';

  it('defaults to latest when no ring is given', () => {
    assert.equal(resolveInstallSpec({ packageName: pkg, ring: undefined }), 'openrappter@latest');
    assert.equal(resolveInstallSpec({ packageName: pkg, ring: '' }), 'openrappter@latest');
  });

  it('maps each ring to its dist-tag', () => {
    assert.equal(resolveInstallSpec({ packageName: pkg, ring: 'canary' }), 'openrappter@canary');
    assert.equal(resolveInstallSpec({ packageName: pkg, ring: 'beta' }), 'openrappter@beta');
    assert.equal(resolveInstallSpec({ packageName: pkg, ring: 'stable' }), 'openrappter@latest');
  });

  it('lets an explicit version win over the ring', () => {
    assert.equal(
      resolveInstallSpec({ packageName: pkg, ring: 'canary', explicitVersion: '1.9.8' }),
      'openrappter@1.9.8',
    );
  });
});
