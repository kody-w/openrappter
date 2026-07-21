/**
 * Ring (release-train channel) primitives for openrappter.
 *
 * Train topology, least-stable first:
 *
 *   canary -> nightly -> alpha -> beta -> stable
 *
 * Design notes
 * ------------
 * 1. Ring rank is encoded as a leading NUMERIC semver prerelease identifier.
 *    Semver compares prerelease identifiers left-to-right; numeric identifiers
 *    compare numerically and always rank below alphanumeric ones. Encoding the
 *    rank first is what makes precedence match the train order:
 *
 *      1.11.0-0.canary.a1b2c3d < 1.11.0-1.nightly.20260721
 *                              < 1.11.0-2.alpha.1
 *                              < 1.11.0-3.beta.1
 *                              < 1.11.0
 *
 *    Naming rings without the rank (e.g. `-canary.1` vs `-beta.1`) would sort
 *    alphabetically and invert the train, making canary look newer than beta.
 *
 * 2. Promotion NEVER rebuilds an artifact. A version is built once in canary and
 *    advances by re-pointing an npm dist-tag at the same published version. This
 *    mirrors the exact-commit promotion rule used by the rapp release train:
 *    no phase creates a new source commit or rebuilds an asset.
 *
 * 3. Only `stable` may own the `latest` dist-tag. Prereleases must never move
 *    `latest`, or `npm install openrappter` would serve an unstable build.
 */

/** Ordered least-stable -> most-stable. Index is the semver rank. */
export const RINGS = ['canary', 'nightly', 'alpha', 'beta', 'stable'];

/** Rings that publish a semver prerelease (everything except stable). */
export const PRERELEASE_RINGS = RINGS.filter((ring) => ring !== 'stable');

/** npm dist-tag that each ring owns. Only stable owns `latest`. */
const DIST_TAGS = {
  canary: 'canary',
  nightly: 'nightly',
  alpha: 'alpha',
  beta: 'beta',
  stable: 'latest',
};

const NUM = '(?:0|[1-9]\\d*)';
const CORE = `${NUM}\\.${NUM}\\.${NUM}`;
const CORE_PATTERN = new RegExp(`^(${NUM})\\.(${NUM})\\.(${NUM})$`);

/** Matches a ring prerelease version, e.g. 1.11.0-0.canary.a1b2c3d */
const RING_VERSION_PATTERN = new RegExp(
  `^(${CORE})-(${NUM})\\.([a-z]+)\\.([0-9A-Za-z-]+)$`,
);

/** Matches any version this train can produce (ring prerelease or stable). */
export const TRAIN_VERSION_PATTERN = new RegExp(
  `^${CORE}(?:-${NUM}\\.[a-z]+\\.[0-9A-Za-z-]+)?$`,
);

export function isRing(ring) {
  return RINGS.includes(ring);
}

export function requireRing(ring) {
  if (!isRing(ring)) {
    throw new Error(
      `unknown ring ${JSON.stringify(ring)}; expected one of ${RINGS.join(', ')}`,
    );
  }
  return ring;
}

export function ringRank(ring) {
  return RINGS.indexOf(requireRing(ring));
}

export function distTagForRing(ring) {
  return DIST_TAGS[requireRing(ring)];
}

/** The ring a build is promoted into next, or undefined if already stable. */
export function nextRing(ring) {
  const rank = ringRank(ring);
  return rank === RINGS.length - 1 ? undefined : RINGS[rank + 1];
}

function requireCoreVersion(version, label = 'version') {
  if (typeof version !== 'string' || !CORE_PATTERN.test(version)) {
    throw new Error(`${label} must be MAJOR.MINOR.PATCH, received ${JSON.stringify(version)}`);
  }
  return version;
}

/**
 * Build the version string a ring publishes.
 *
 * @param {object}  options
 * @param {string}  options.ring         one of RINGS
 * @param {string}  options.baseVersion  MAJOR.MINOR.PATCH the train is heading toward
 * @param {string} [options.sha]         short commit sha (canary)
 * @param {string} [options.date]        YYYYMMDD stamp (nightly)
 * @param {number} [options.counter]     monotonic counter (alpha/beta)
 */
export function ringVersion({ ring, baseVersion, sha, date, counter }) {
  requireRing(ring);
  requireCoreVersion(baseVersion, 'baseVersion');

  if (ring === 'stable') return baseVersion;

  const rank = ringRank(ring);
  const suffix = ringSuffix({ ring, sha, date, counter });
  return `${baseVersion}-${rank}.${ring}.${suffix}`;
}

function ringSuffix({ ring, sha, date, counter }) {
  if (ring === 'canary') {
    const short = String(sha ?? '').trim().toLowerCase();
    if (!/^[0-9a-f]{7,40}$/.test(short)) {
      throw new Error(`canary ring requires a commit sha, received ${JSON.stringify(sha)}`);
    }
    return short.slice(0, 8);
  }

  if (ring === 'nightly') {
    const stamp = String(date ?? '').trim();
    if (!/^\d{8}$/.test(stamp)) {
      throw new Error(`nightly ring requires a YYYYMMDD date, received ${JSON.stringify(date)}`);
    }
    return stamp;
  }

  // alpha | beta -> monotonic counter
  if (!Number.isInteger(counter) || counter < 1) {
    throw new Error(`${ring} ring requires a positive integer counter, received ${counter}`);
  }
  return String(counter);
}

/** Parse a version produced by this train. Returns undefined if not ours. */
export function parseRingVersion(version) {
  if (typeof version !== 'string') return undefined;

  if (CORE_PATTERN.test(version)) {
    return { version, baseVersion: version, ring: 'stable', rank: ringRank('stable'), suffix: undefined };
  }

  const match = RING_VERSION_PATTERN.exec(version);
  if (!match) return undefined;

  const [, baseVersion, rankText, ring, suffix] = match;
  // Reject a rank that disagrees with the ring name — that combination would
  // sort correctly by accident but lie about which ring produced the build.
  if (!isRing(ring) || ring === 'stable') return undefined;
  if (Number(rankText) !== ringRank(ring)) return undefined;

  return { version, baseVersion, ring, rank: Number(rankText), suffix };
}

/** Semver precedence: -1 | 0 | 1. Handles our ring prereleases correctly. */
export function compareVersions(left, right) {
  const a = splitVersion(left);
  const b = splitVersion(right);

  for (let i = 0; i < 3; i += 1) {
    if (a.core[i] !== b.core[i]) return a.core[i] < b.core[i] ? -1 : 1;
  }

  // A version with a prerelease has LOWER precedence than one without.
  if (a.pre.length === 0 && b.pre.length === 0) return 0;
  if (a.pre.length === 0) return 1;
  if (b.pre.length === 0) return -1;

  const length = Math.max(a.pre.length, b.pre.length);
  for (let i = 0; i < length; i += 1) {
    const x = a.pre[i];
    const y = b.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;

    const xNum = /^\d+$/.test(x);
    const yNum = /^\d+$/.test(y);
    if (xNum && yNum) {
      if (Number(x) !== Number(y)) return Number(x) < Number(y) ? -1 : 1;
      continue;
    }
    // Numeric identifiers always have lower precedence than alphanumeric ones.
    if (xNum !== yNum) return xNum ? -1 : 1;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

function splitVersion(version) {
  if (typeof version !== 'string' || !TRAIN_VERSION_PATTERN.test(version)) {
    throw new Error(`not a train version: ${JSON.stringify(version)}`);
  }
  const [core, pre = ''] = version.split('-');
  return {
    core: core.split('.').map(Number),
    pre: pre === '' ? [] : pre.split('.'),
  };
}

/**
 * Validate a promotion request.
 *
 * Promotion re-points a dist-tag at an ALREADY PUBLISHED version. It must not
 * skip rings, must not run backwards, and must not move `latest` to anything
 * that is not a stable release.
 */
export function planPromotion({ version, from, to, publishedVersions = [] }) {
  requireRing(from);
  requireRing(to);

  const parsed = parseRingVersion(version);
  if (!parsed) throw new Error(`not a train version: ${JSON.stringify(version)}`);

  if (ringRank(to) <= ringRank(from)) {
    throw new Error(`promotion must advance the train: ${from} -> ${to} does not`);
  }
  if (ringRank(to) !== ringRank(from) + 1) {
    throw new Error(
      `promotion may not skip rings: ${from} -> ${to} skips ${RINGS
        .slice(ringRank(from) + 1, ringRank(to))
        .join(', ')}`,
    );
  }
  if (parsed.ring !== from) {
    throw new Error(`version ${version} belongs to ring ${parsed.ring}, not ${from}`);
  }
  if (!publishedVersions.includes(version)) {
    throw new Error(`refusing to promote unpublished version ${version}`);
  }
  // `stable` is a real rebuild-free re-publish of the base version, not a
  // dist-tag move of a prerelease: `latest` must never point at a prerelease.
  if (to === 'stable') {
    throw new Error(
      'stable is not reachable by dist-tag promotion; publish the release version ' +
        `${parsed.baseVersion} through the release workflow so latest never points at a prerelease`,
    );
  }

  return { version, from, to, distTag: distTagForRing(to), rebuild: false };
}

/**
 * Resolve what an installer should install for a ring.
 * Precedence: explicit version > ring dist-tag > stable.
 */
export function resolveInstallSpec({ packageName, ring, explicitVersion }) {
  if (explicitVersion) return `${packageName}@${explicitVersion}`;
  if (ring === undefined || ring === null || ring === '') {
    return `${packageName}@${distTagForRing('stable')}`;
  }
  return `${packageName}@${distTagForRing(ring)}`;
}
