import { gateway } from './gateway.js';

export const RELEASE_RINGS = ['stable', 'beta', 'canary', 'alpha', 'nightly'] as const;
export type ReleaseRing = (typeof RELEASE_RINGS)[number];

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
