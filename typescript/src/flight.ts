import { VERSION } from './version.js';

/**
 * Release rings, least-stable first. Kept in sync with scripts/ring.mjs, which
 * is the source of truth used by the release-train tooling.
 */
export const FLIGHT_RINGS = ['canary', 'nightly', 'alpha', 'beta', 'stable'] as const;

export type FlightRing = (typeof FLIGHT_RINGS)[number];

export interface FlightInfo {
  version: string;
  ring: FlightRing;
  /** The MAJOR.MINOR.PATCH this build is heading toward. */
  baseVersion: string;
  /** True for anything that is not the stable production build. */
  experimental: boolean;
  /** canary sha8 / nightly date / alpha|beta counter, when present. */
  detail?: string;
}

// Mirrors the ring grammar: 1.11.0-<rank>.<ring>.<suffix>
const RING_VERSION = /^(\d+\.\d+\.\d+)-(\d+)\.([a-z]+)\.([0-9A-Za-z-]+)$/;
const RANK: Record<string, number> = {
  canary: 0,
  nightly: 1,
  alpha: 2,
  beta: 3,
  stable: 4,
};

/** Describe the build currently running, derived from its own version string. */
export function flightInfo(version: string = VERSION): FlightInfo {
  const match = RING_VERSION.exec(version);
  if (!match) {
    // No ring suffix -> this is a stable production build.
    return { version, ring: 'stable', baseVersion: version, experimental: false };
  }

  const [, baseVersion, rankText, ring, detail] = match;
  // A rank that disagrees with the ring name is not a build this train made;
  // treat it as stable rather than trusting a mislabelled version.
  if (!(ring in RANK) || ring === 'stable' || Number(rankText) !== RANK[ring]) {
    return { version, ring: 'stable', baseVersion: version, experimental: false };
  }

  return {
    version,
    ring: ring as FlightRing,
    baseVersion,
    experimental: true,
    detail,
  };
}

const RING_EMOJI: Record<FlightRing, string> = {
  canary: '🐤',
  nightly: '🌙',
  alpha: '🅰️',
  beta: '🅱️',
  stable: '🟢',
};

/** Human-readable flight report for the `openrappter flight` command. */
export function renderFlight(info: FlightInfo = flightInfo()): string {
  const lines = [
    '',
    `  ${RING_EMOJI[info.ring]} OpenRappter flight`,
    '  ──────────────────────────',
    `  Ring:        ${info.ring}${info.experimental ? ' (experimental)' : ''}`,
    `  Version:     ${info.version}`,
  ];
  if (info.experimental) {
    lines.push(`  Heading to:  ${info.baseVersion}`);
    if (info.detail) lines.push(`  Build:       ${info.detail}`);
    lines.push('  Note:        pre-release flight — not the production build.');
  }
  lines.push('');
  return lines.join('\n');
}
