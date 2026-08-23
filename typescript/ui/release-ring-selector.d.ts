export const RELEASE_RINGS: readonly ['stable', 'beta', 'canary', 'alpha', 'nightly'];
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
export declare function compareSemVer(left: string, right: string): -1 | 0 | 1;
export declare function loadReleaseRing(): Promise<ReleaseRingState>;
export declare function previewReleaseRing(ring: ReleaseRing): Promise<ReleaseRingStatus>;
export declare function applyReleaseRing(
  ring: ReleaseRing,
  allowDowngrade: boolean,
): Promise<{ applied: true; selectedRing: ReleaseRing; resolved: ReleaseRingStatus }>;
export declare class OpenRappterReleaseRingSwitcher extends HTMLElement {}
declare global {
  interface HTMLElementTagNameMap {
    'openrappter-release-ring-switcher': OpenRappterReleaseRingSwitcher;
  }
}
