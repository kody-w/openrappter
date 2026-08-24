import { describe, expect, it, vi } from 'vitest';
import { registerReleaseRingMethods } from './release-ring-rpc.js';
import type { RingManifest, RingName } from '../release-rings.js';

function manifest(
  ring: RingName,
  options: Partial<RingManifest> = {},
): RingManifest {
  const train = ['nightly', 'alpha', 'canary', 'beta', 'stable'] as const;
  return {
    schema: 'openrappter-ring/v1',
    ring,
    source: {
      repository: 'kody-w/openrappter',
      commit: 'a'.repeat(40),
      tag: ring === 'stable' ? 'v1.9.8' : null,
    },
    version: '1.9.8',
    artifact: {
      url: 'https://registry.npmjs.org/openrappter/-/openrappter-1.9.8.tgz',
      install_url: 'https://registry.npmjs.org/openrappter/-/openrappter-1.9.8.tgz',
      sha256: 'b'.repeat(64),
      provenance: 'npm-registry-download-sha256',
    },
    promoted_at: '2026-05-16T01:48:41Z',
    predecessor: ring === 'nightly' ? null : train[train.indexOf(ring) - 1],
    status: 'published',
    reason: null,
    receipt: null,
    ...options,
  } as RingManifest;
}

function setup(options: {
  selected?: RingName;
  currentVersion?: string;
  value?: RingManifest;
} = {}) {
  const methods = new Map<string, (params?: unknown, connection?: unknown) => Promise<unknown>>();
  const auth = new Map<string, boolean>();
  const persistRing = vi.fn();
  const value = options.value ?? manifest('stable');
  const fetchManifest = vi.fn(async (ring: RingName) => ({ ...value, ring }) as RingManifest);
  registerReleaseRingMethods({
    registerMethod(name, handler, methodOptions) {
      methods.set(
        name,
        handler as unknown as (params?: unknown, connection?: unknown) => Promise<unknown>,
      );
      auth.set(name, methodOptions?.requiresAuth === true);
    },
  }, {
    currentVersion: options.currentVersion ?? '1.9.8',
    selectedRing: () => options.selected ?? 'stable',
    fetchManifest,
    persistRing,
  });
  return { methods, auth, persistRing, fetchManifest };
}

describe('release-ring RPC', () => {
  it('reports the persisted selection and exact identity', async () => {
    const { methods } = setup();
    const result = await methods.get('rings.get')!() as {
      allowedRings: string[];
      selectedRing: string;
      resolved: { version: string; commit: string; status: string };
    };
    expect(result.allowedRings).toEqual(['stable', 'beta', 'canary', 'alpha', 'nightly']);
    expect(result.selectedRing).toBe('stable');
    expect(result.resolved).toMatchObject({
      version: '1.9.8',
      commit: 'a'.repeat(40),
      status: 'published',
    });
  });

  it('rejects arbitrary ring values before fetching or persisting', async () => {
    const { methods, persistRing } = setup();
    await expect(methods.get('rings.preview')!({ ring: 'evil' })).rejects.toThrow(
      'stable, beta, canary, alpha, nightly',
    );
    await expect(methods.get('rings.apply')!({ ring: 'evil' })).rejects.toThrow();
    expect(persistRing).not.toHaveBeenCalled();
  });

  it('cannot apply an unpublished ring', async () => {
    const value = manifest('beta', {
      status: 'unpublished',
      reason: 'artifact not published',
      artifact: { ...manifest('beta').artifact, install_url: null },
    });
    const { methods, persistRing } = setup({ value });
    await expect(methods.get('rings.apply')!({ ring: 'beta' })).rejects.toThrow(
      'artifact not published',
    );
    expect(persistRing).not.toHaveBeenCalled();
  });

  it('requires explicit downgrade approval and applies only on the mutation RPC', async () => {
    const { methods, persistRing, auth, fetchManifest } = setup({ currentVersion: '2.0.0' });
    await methods.get('rings.preview')!({ ring: 'beta' });
    expect(persistRing).not.toHaveBeenCalled();
    await expect(methods.get('rings.apply')!({
      ring: 'beta',
      allowDowngrade: false,
    })).rejects.toThrow('explicit downgrade approval');
    await methods.get('rings.apply')!({ ring: 'beta', allowDowngrade: true });
    expect(persistRing).toHaveBeenCalledTimes(1);
    expect(persistRing).toHaveBeenCalledWith('beta');
    expect(fetchManifest).toHaveBeenCalledTimes(3);
    // preview + refused apply + successful apply: each operation uses exactly
    // one validated snapshot and never refetches after persistence.
    expect(auth.get('rings.apply')).toBe(true);
  });
});
