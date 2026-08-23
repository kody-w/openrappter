import { gateway } from './gateway.js';

export const RELEASE_RINGS = ['stable', 'beta', 'canary', 'alpha', 'nightly'] as const;
export type ReleaseRing = (typeof RELEASE_RINGS)[number];

export function compareSemVer(left: string, right: string): -1 | 0 | 1 {
  const parse = (value: string) => {
    const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(value);
    if (!match) throw new Error(`invalid SemVer: ${value}`);
    const prerelease = match[4]?.split('.') ?? null;
    if (prerelease?.some(id => /^\d+$/.test(id) && /^0\d+/.test(id))) {
      throw new Error(`invalid SemVer: ${value}`);
    }
    return { core: match.slice(1, 4).map(Number), prerelease };
  };
  const a = parse(left);
  const b = parse(right);
  for (let i = 0; i < 3; i += 1) {
    if (a.core[i] !== b.core[i]) return a.core[i] < b.core[i] ? -1 : 1;
  }
  if (a.prerelease === null && b.prerelease === null) return 0;
  if (a.prerelease === null) return 1;
  if (b.prerelease === null) return -1;
  for (let i = 0; i < Math.max(a.prerelease.length, b.prerelease.length); i += 1) {
    const x = a.prerelease[i];
    const y = b.prerelease[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) return BigInt(x) < BigInt(y) ? -1 : 1;
    if (xn !== yn) return xn ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

export interface ReleaseRingStatus {
  ring: ReleaseRing;
  version: string | null;
  commit: string | null;
  status: 'published' | 'unpublished' | 'disabled' | 'unreachable';
  reason: string | null;
  selected: boolean;
  nonStable: boolean;
  olderThanCurrent: boolean;
  canApply: boolean;
}

export interface ReleaseRingState {
  allowedRings: readonly ReleaseRing[];
  selectedRing: ReleaseRing;
  currentVersion: string;
  resolved: ReleaseRingStatus;
}

export async function loadReleaseRing(): Promise<ReleaseRingState> {
  return gateway.call<ReleaseRingState>('rings.get', {});
}

export async function previewReleaseRing(ring: ReleaseRing): Promise<ReleaseRingStatus> {
  return gateway.call<ReleaseRingStatus>('rings.preview', { ring });
}

export async function applyReleaseRing(
  ring: ReleaseRing,
  allowDowngrade: boolean,
): Promise<{ applied: true; selectedRing: ReleaseRing; resolved: ReleaseRingStatus }> {
  return gateway.call('rings.apply', { ring, allowDowngrade });
}
