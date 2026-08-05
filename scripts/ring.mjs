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
 * 2. EACH RING IS ITS OWN REPO AND ITS OWN NPM PACKAGE. This is the primary
 *    isolation boundary, and it is why the rapp release train uses separate
 *    rapp-canary / rapp-nightly / rapp-alpha / rapp-beta repositories rather
 *    than one repo with channel tags.
 *
 *      canary  -> openrappter-canary
 *      nightly -> openrappter-nightly
 *      alpha   -> openrappter-alpha
 *      beta    -> openrappter-beta
 *      stable  -> openrappter          <- the only package prod users install
 *
 *    Sharing one package across rings would mean every canary permanently
 *    consumes a version number in the production package's history, and the
 *    production `latest` tag would sit one workflow bug away from moving.
 *    Separate packages make production physically unreachable from ring work
 *    instead of merely guarded: a ring package can be deleted outright with
 *    zero production impact.
 *
 * 3. Promotion NEVER rebuilds an artifact. The tarball built once in canary is
 *    republished byte-for-byte under the next ring's package name. This mirrors
 *    the exact-commit promotion rule of the rapp release train: no phase
 *    creates a new source commit or rebuilds an asset.
 */

/** Ordered least-stable -> most-stable. Index is the semver rank. */
export const RINGS = ['canary', 'nightly', 'alpha', 'beta', 'stable'];

/** Rings that publish a semver prerelease (everything except stable). */
export const PRERELEASE_RINGS = RINGS.filter((ring) => ring !== 'stable');

/** The production package. Only the stable ring may ever publish to it. */
export const PRODUCTION_PACKAGE = 'openrappter';

/** GitHub repo that owns each ring. */
export function repoForRing(ring) {
  return requireRing(ring) === 'stable'
    ? 'kody-w/openrappter'
    : `kody-w/openrappter-${ring}`;
}

/**
 * npm package a ring publishes to. Each prerelease ring owns a DISTINCT
 * package, so nothing a ring does can be served to `npm install openrappter`.
 */
export function packageForRing(ring) {
  return requireRing(ring) === 'stable'
    ? PRODUCTION_PACKAGE
    : `${PRODUCTION_PACKAGE}-${ring}`;
}

/**
 * Within its own package, every ring simply owns `latest` — that package's
 * newest build. There is no cross-ring dist-tag juggling because there is no
 * shared package to juggle within.
 */
export function distTagForRing(ring) {
  requireRing(ring);
  return 'latest';
}

/** True only for the one package real users install. */
export function isProductionPackage(name) {
  return name === PRODUCTION_PACKAGE;
}

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
  // Promotion never reaches production. Shipping stable means running the
  // existing release workflow against a real release tag, which is a separate,
  // human-gated path — so no automated ring step can publish to `openrappter`.
  if (to === 'stable') {
    throw new Error(
      'stable is not reachable by ring promotion; publish ' +
        `${parsed.baseVersion} through the release workflow so the production ` +
        `package ${PRODUCTION_PACKAGE} is only ever written by a real release`,
    );
  }

  const fromPackage = packageForRing(from);
  const toPackage = packageForRing(to);

  // Belt and braces: a promotion target must never be the production package.
  if (isProductionPackage(toPackage)) {
    throw new Error(`refusing to promote into the production package ${toPackage}`);
  }

  return {
    version,
    from,
    to,
    fromPackage,
    toPackage,
    // Same bytes republished under the next ring's package name.
    rebuild: false,
  };
}

/**
 * Resolve what an installer should install for a ring.
 * Precedence: explicit version > ring package > production.
 */
export function resolveInstallSpec({ ring, explicitVersion }) {
  const name = ring === undefined || ring === null || ring === ''
    ? PRODUCTION_PACKAGE
    : packageForRing(ring);
  return explicitVersion ? `${name}@${explicitVersion}` : `${name}@latest`;
}
