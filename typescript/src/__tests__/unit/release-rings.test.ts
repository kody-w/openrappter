import { describe, expect, it, vi } from 'vitest';
import {
  RINGS,
  RING_MANIFEST_URLS,
  downloadAndVerify,
  fetchRingManifest,
  resolveRing,
  selectRing,
  validateRingManifest,
} from '../../release-rings.js';

const stable = {
  schema: 'openrappter-ring/v1',
  ring: 'stable',
  source: { repository: 'kody-w/openrappter', commit: 'a'.repeat(40), tag: 'v1.9.8' },
  version: '1.9.8',
  artifact: {
    url: 'https://registry.npmjs.org/openrappter/-/openrappter-1.9.8.tgz',
    install_url: 'https://registry.npmjs.org/openrappter/-/openrappter-1.9.8.tgz',
    sha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    provenance: 'npm-registry-download-sha256',
  },
  promoted_at: '2026-05-16T01:48:41Z',
  predecessor: 'beta',
  status: 'published',
  reason: null,
  receipt: null,
} as const;

const response = (body: unknown, ok = true) => ({
  ok,
  status: ok ? 200 : 404,
  json: async () => body,
}) as Response;

describe('ring selection', () => {
  it('defaults safely to stable', () => expect(selectRing({ env: {} })).toBe('stable'));
  it('uses CLI over OPENRAPPTER_RING over legacy channel', () => {
    expect(selectRing({ cliRing: 'alpha', env: { OPENRAPPTER_RING: 'beta' } })).toBe('alpha');
    expect(selectRing({ env: { OPENRAPPTER_RING: 'canary', OPENRAPPTER_CHANNEL: 'beta' } })).toBe('canary');
  });
  it('maps every ring to only its known repository', () => {
    for (const ring of RINGS) expect(RING_MANIFEST_URLS[ring]).toContain(`openrappter${ring === 'stable' ? '' : `-${ring}`}/main/.ring/manifest.json`);
  });
  it('rejects unknown rings', () => expect(() => selectRing({ cliRing: 'evil' })).toThrow());
});

describe('closed manifests', () => {
  it('accepts an exact pinned stable identity', () => {
    expect(validateRingManifest(stable, 'stable', new Date('2026-08-23T20:00:00Z')).source.commit).toHaveLength(40);
  });
  it.each([
    ['unknown field', { ...stable, repo: 'evil/repo' }],
    ['repository injection', { ...stable, source: { ...stable.source, repository: 'evil/repo' } }],
    ['URL injection', { ...stable, artifact: { ...stable.artifact, url: 'https://evil.example/a.tgz' } }],
    ['future timestamp', { ...stable, promoted_at: '2999-01-01T00:00:00Z' }],
  ])('rejects %s', (_label, manifest) => {
    expect(() => validateRingManifest(manifest, 'stable', new Date('2026-08-23T20:00:00Z'))).toThrow();
  });
});

describe('resolution', () => {
  it('fetches only the hardcoded ring URL and exact ref', async () => {
    const fetchImpl = vi.fn(async () => response(stable));
    const manifest = await fetchRingManifest('stable', { fetchImpl: fetchImpl as typeof fetch });
    expect(fetchImpl).toHaveBeenCalledWith(RING_MANIFEST_URLS.stable, expect.anything());
    expect(manifest.source.commit).toBe('a'.repeat(40));
  });
  it('fails on unreachable and nonpublished rings', async () => {
    await expect(fetchRingManifest('stable', { fetchImpl: vi.fn(async () => response({}, false)) as typeof fetch })).rejects.toThrow('could not reach');
    const disabled = { ...stable, ring: 'alpha', predecessor: 'nightly', status: 'disabled', reason: 'not promoted', artifact: { ...stable.artifact, install_url: null } };
    await expect(resolveRing('alpha', { fetchImpl: vi.fn(async () => response(disabled)) as typeof fetch })).rejects.toThrow('disabled');
  });
  it('rejects downgrade unless explicit', async () => {
    const fetchImpl = vi.fn(async () => response(stable)) as typeof fetch;
    await expect(resolveRing('stable', { fetchImpl, currentVersion: '2.0.0' })).rejects.toThrow('refusing downgrade');
    await expect(resolveRing('stable', { fetchImpl, currentVersion: '2.0.0', allowDowngrade: true })).resolves.toMatchObject({ version: '1.9.8' });
  });
  it('verifies artifact bytes and rejects mismatch', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, arrayBuffer: async () => new TextEncoder().encode('hello').buffer }) as Response) as typeof fetch;
    await expect(downloadAndVerify(stable, fetchImpl)).resolves.toHaveLength(5);
    await expect(downloadAndVerify({ ...stable, artifact: { ...stable.artifact, sha256: '0'.repeat(64) } }, fetchImpl)).rejects.toThrow('checksum mismatch');
  });
});
