import {
  RINGS,
  fetchRingManifest,
  isRing,
  isVersionDowngrade,
  selectRing,
  writePersistedRing,
  type RingManifest,
  type RingName,
} from '../../release-rings.js';
import { VERSION } from '../../version.js';

interface MethodRegistrar {
  registerMethod<P = unknown, R = unknown>(
    name: string,
    handler: (params: P, connection: unknown) => Promise<R>,
    options?: { requiresAuth?: boolean }
  ): void;
}

export interface RingStatus {
  ring: RingName;
  version: string | null;
  commit: string | null;
  status: RingManifest['status'] | 'unreachable';
  reason: string | null;
  selected: boolean;
  nonStable: boolean;
  olderThanCurrent: boolean;
  canApply: boolean;
}

interface ReleaseRingDeps {
  currentVersion?: string;
  selectedRing?: () => RingName;
  fetchManifest?: (ring: RingName) => Promise<RingManifest>;
  persistRing?: (ring: RingName) => void;
}

function requireRing(value: unknown): RingName {
  if (typeof value !== 'string' || !isRing(value)) {
    throw new Error(`ring must be one of: ${RINGS.join(', ')}`);
  }
  return value;
}

export function registerReleaseRingMethods(
  server: MethodRegistrar,
  deps: ReleaseRingDeps = {},
): void {
  const currentVersion = deps.currentVersion ?? VERSION;
  const selectedRing = deps.selectedRing ?? (() => selectRing());
  const fetchManifest = deps.fetchManifest ?? ((ring) => fetchRingManifest(ring));
  const persistRing = deps.persistRing ?? writePersistedRing;

  const inspect = async (ring: RingName): Promise<RingStatus> => {
    try {
      const manifest = await fetchManifest(ring);
      const olderThanCurrent = isVersionDowngrade(currentVersion, manifest.version);
      return {
        ring,
        version: manifest.version,
        commit: manifest.source.commit,
        status: manifest.status,
        reason: manifest.reason,
        selected: ring === selectedRing(),
        nonStable: ring !== 'stable',
        olderThanCurrent,
        canApply: manifest.status === 'published',
      };
    } catch (error) {
      return {
        ring,
        version: null,
        commit: null,
        status: 'unreachable',
        reason: (error as Error).message,
        selected: ring === selectedRing(),
        nonStable: ring !== 'stable',
        olderThanCurrent: false,
        canApply: false,
      };
    }
  };

  server.registerMethod<void, {
    allowedRings: readonly RingName[];
    selectedRing: RingName;
    currentVersion: string;
    resolved: RingStatus;
  }>('rings.get', async () => {
    const selected = selectedRing();
    return {
      allowedRings: RINGS,
      selectedRing: selected,
      currentVersion,
      resolved: await inspect(selected),
    };
  });

  server.registerMethod<{ ring: unknown }, RingStatus>('rings.preview', async (params) => {
    return inspect(requireRing(params?.ring));
  });

  server.registerMethod<
    { ring: unknown; allowDowngrade?: boolean },
    { applied: true; selectedRing: RingName; resolved: RingStatus }
  >('rings.apply', async (params) => {
    const ring = requireRing(params?.ring);
    const manifest = await fetchManifest(ring);
    if (manifest.status !== 'published') {
      throw new Error(`${ring} is ${manifest.status}: ${manifest.reason}`);
    }
    if (
      isVersionDowngrade(currentVersion, manifest.version)
      && params.allowDowngrade !== true
    ) {
      throw new Error(
        `refusing downgrade ${currentVersion} -> ${manifest.version}; explicit downgrade approval is required`,
      );
    }
    persistRing(ring);
    return { applied: true, selectedRing: ring, resolved: await inspect(ring) };
  }, { requiresAuth: true });
}
