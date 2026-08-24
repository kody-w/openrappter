import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RINGS,
  RING_MANIFEST_URLS,
  compareSemVer,
  parseCandidateBundleUrl,
  downloadAndVerify,
  fetchRingManifest,
  isVersionDowngrade,
  readPersistedRing,
  resolveRing,
  selectRing,
  validateRingManifest,
  writePersistedRing,
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
  promotion_id: 'e'.repeat(64),
  intended_release_tag: null,
  channel_version: null,
} as const;

const response = (body: unknown, ok = true) => ({
  ok,
  status: ok ? 200 : 404,
  json: async () => body,
}) as Response;

function canonicalDigest(value: unknown): string {
  const canonical = (input: unknown): unknown => Array.isArray(input)
    ? input.map(canonical)
    : input && typeof input === 'object'
      ? Object.fromEntries(Object.entries(input as Record<string, unknown>).sort().map(([k, v]) => [k, canonical(v)]))
      : input;
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

function trustedFetch(
  manifest: typeof stable | Record<string, unknown>,
  targetMainReplay?: Record<string, unknown>,
) {
  const ring = String(manifest.ring);
  const repo = ring === 'stable' ? 'kody-w/openrappter' : `kody-w/openrappter-${ring}`;
  const receipt = {
    schema: 'openrappter-promotion-receipt/v1',
    receipt_kind: 'bootstrap',
    promotion_id: manifest.promotion_id,
    target_repository: repo,
    target_ring: ring,
    target_manifest_sha256: canonicalDigest(manifest),
    target_manifest_commit: 'c'.repeat(40),
    source_repository: (manifest.source as typeof stable.source).repository,
    source_commit: (manifest.source as typeof stable.source).commit,
    source_tag: (manifest.source as typeof stable.source).tag,
    version: manifest.version,
    artifact_url: (manifest.artifact as typeof stable.artifact).url,
    install_url: (manifest.artifact as typeof stable.artifact).install_url,
    artifact_sha256: (manifest.artifact as typeof stable.artifact).sha256,
    artifact_provenance: (manifest.artifact as typeof stable.artifact).provenance,
    predecessor_manifest_sha256: 'f'.repeat(64),
    emitted_at: '2026-08-23T20:00:00Z',
  };
  const bodies = [
    {
      schema: 'openrappter-ring-head/v1',
      ring,
      sequence: 7,
      promotion_id: manifest.promotion_id,
      authority_commit: 'd'.repeat(40),
      receipt_path: `receipts/${ring}/${manifest.promotion_id}.json`,
      receipt_sha256: canonicalDigest(receipt),
      target_repository: repo,
      target_manifest_commit: 'c'.repeat(40),
      target_manifest_sha256: canonicalDigest(manifest),
    },
    receipt,
    manifest,
  ];
  return vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    if (targetMainReplay && String(input) === RING_MANIFEST_URLS[ring as keyof typeof RING_MANIFEST_URLS]) {
      return response(targetMainReplay);
    }
    return response(bodies.shift());
  });
}

describe('ring selection', () => {
  it('defaults safely to stable', () => expect(selectRing({ env: {}, persistedRing: null })).toBe('stable'));
  it('uses CLI over OPENRAPPTER_RING over legacy channel', () => {
    expect(selectRing({
      cliRing: 'alpha',
      env: { OPENRAPPTER_RING: 'beta' },
      persistedRing: 'nightly',
    })).toBe('alpha');
    expect(selectRing({
      env: { OPENRAPPTER_RING: 'canary', OPENRAPPTER_CHANNEL: 'beta' },
      persistedRing: 'nightly',
    })).toBe('canary');
    expect(selectRing({ env: {}, persistedRing: 'beta' })).toBe('beta');
  });

  describe('closed candidate bundle URL', () => {
    const fixture = JSON.parse(fs.readFileSync(path.resolve('..', 'contracts', 'candidate-url-v1.json'), 'utf8')).fixture;
    it('parses the exact allowlisted fixture', () => {
      expect(parseCandidateBundleUrl(fixture.url)).toEqual({
        ref: fixture.ref, sourceCommit: fixture.source_commit, kind: fixture.kind,
        candidateId: fixture.candidate_id, sha256: fixture.sha256,
      });
    });
    it.each([
      '?x=1', '#x', 'HOST', 'PORT', 'CREDS', 'REPO', 'REF', 'COMMIT', 'KIND',
      'ID', 'HASH', 'TRAVERSAL', 'ENCODED', 'UNICODE', 'EXTRA',
    ])('rejects candidate URL mutation %s', mutation => {
      let value = fixture.url;
      if (mutation === '?x=1' || mutation === '#x') value += mutation;
      if (mutation === 'HOST') value = value.replace('raw.githubusercontent.com', 'evil.example');
      if (mutation === 'PORT') value = value.replace('raw.githubusercontent.com', 'raw.githubusercontent.com:443');
      if (mutation === 'CREDS') value = value.replace('https://', 'https://user@');
      if (mutation === 'REPO') value = value.replace('/openrappter/', '/wrong/');
      if (mutation === 'REF') value = value.replace(`/${fixture.ref}/`, `/${'g'.repeat(40)}/`);
      if (mutation === 'COMMIT') value = value.replace(`/${fixture.source_commit}/`, `/${'g'.repeat(40)}/`);
      if (mutation === 'KIND') value = value.replace('/release/', '/beta/');
      if (mutation === 'ID') value = value.replace(`/${fixture.candidate_id}/`, '/-invalid/');
      if (mutation === 'HASH') value = value.replace(fixture.sha256, 'f'.repeat(63));
      if (mutation === 'TRAVERSAL') value = value.replace(`/${fixture.candidate_id}/`, '/../');
      if (mutation === 'ENCODED') value = value.replace(`/${fixture.candidate_id}/`, '/%2e%2e/');
      if (mutation === 'UNICODE') value = value.replace(`/${fixture.candidate_id}/`, '/täg/');
      if (mutation === 'EXTRA') value = value.replace('.tar.gz', '/extra.tar.gz');
      expect(() => parseCandidateBundleUrl(value)).toThrow();
    });
  });

  describe('complete SemVer ordering', () => {
    it.each([
      ['1.9.8-beta.1', '1.9.8', -1],
      ['1.9.8-beta.2', '1.9.8-beta.10', -1],
      ['1.9.8-2', '1.9.8-beta', -1],
      ['1.9.8-beta.10', '1.9.8-beta.2', 1],
      ['1.9.8-beta', '1.9.8-beta.1', -1],
      ['1.9.8+build.2', '1.9.8+build.1', 0],
    ])('compares %s to %s', (left, right, expected) => {
      expect(compareSemVer(left, right)).toBe(expected);
    });

    it('treats release to same-core prerelease as a downgrade', () => {
      expect(isVersionDowngrade('1.9.8', '1.9.8-beta.1')).toBe(true);
      expect(isVersionDowngrade('1.9.8-beta.10', '1.9.8-beta.2')).toBe(true);
    });
  });

  describe('shared persisted ring setting', () => {
    const home = path.resolve('.test-release-ring-setting');
    let previousHome: string | undefined;

    beforeEach(() => {
      previousHome = process.env.OPENRAPPTER_HOME;
      process.env.OPENRAPPTER_HOME = home;
      fs.rmSync(home, { recursive: true, force: true });
    });

    describe('pull-only promotion setup', () => {
      it('contains no cross-repository token or dispatch dependency', () => {
        const workflowDir = path.resolve('..', '.github', 'workflows');
        const workflows = fs.readdirSync(workflowDir)
          .filter(name => name.endsWith('.yml'))
          .map(name => fs.readFileSync(path.join(workflowDir, name), 'utf8'))
          .join('\n');
        expect(workflows).not.toMatch(/RING_AUTHORITY_TOKEN|RING_ENABLED|repository_dispatch/);
        expect(workflows).toMatch(/gh pr create/);
        expect(workflows).not.toMatch(/push origin (?:HEAD:)?main/);
      });
    });

    afterEach(() => {
      fs.rmSync(home, { recursive: true, force: true });
      if (previousHome === undefined) delete process.env.OPENRAPPTER_HOME;
      else process.env.OPENRAPPTER_HOME = previousHome;
    });

    it('round-trips only an allowlisted value through the CLI/installer setting', () => {
      writePersistedRing('nightly');
      expect(readPersistedRing()).toBe('nightly');
      expect(fs.readFileSync(path.join(home, 'ring'), 'utf8')).toBe('nightly\n');
      expect(selectRing({ env: {} })).toBe('nightly');
    });

    it('fails closed on a tampered persisted value', () => {
      fs.mkdirSync(home, { recursive: true });
      fs.writeFileSync(path.join(home, 'ring'), 'attacker/repo\n');
      expect(() => readPersistedRing()).toThrow('invalid');
      expect(() => selectRing({ env: {} })).toThrow('invalid');
    });
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
  it('resolves authority head before immutable receipt and target commit', async () => {
    const fetchImpl = trustedFetch(stable);
    const manifest = await fetchRingManifest('stable', { fetchImpl: fetchImpl as typeof fetch });
    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      'https://raw.githubusercontent.com/kody-w/openrappter-release-train/main/heads/stable.json',
      expect.anything(),
    );
    const urls = fetchImpl.mock.calls.map(call => String(call[0]));
    expect(urls).not.toContain(RING_MANIFEST_URLS.stable);
    expect(urls[2]).toContain(`${'c'.repeat(40)}/.ring/manifest.json`);
    expect(manifest.source.commit).toBe('a'.repeat(40));
  });
  it('ignores a coherent older target-main manifest and pointer replay', async () => {
    const older = {
      ...stable,
      version: '1.9.7',
      source: { ...stable.source, commit: 'b'.repeat(40), tag: 'v1.9.7' },
      promotion_id: '9'.repeat(64),
    };
    const fetchImpl = trustedFetch(stable, older);
    const resolved = await fetchRingManifest('stable', { fetchImpl });
    expect(resolved.version).toBe('1.9.8');
    expect(resolved.source.commit).toBe('a'.repeat(40));
    expect(fetchImpl.mock.calls.map(call => String(call[0]))).not.toContain(
      RING_MANIFEST_URLS.stable,
    );
  });
  it('fails on unreachable and nonpublished rings', async () => {
    await expect(fetchRingManifest('stable', { fetchImpl: vi.fn(async () => response({}, false)) as typeof fetch })).rejects.toThrow('could not reach');
    const disabled = {
      ...stable,
      ring: 'alpha',
      predecessor: 'nightly',
      status: 'disabled',
      reason: 'not promoted',
      source: { ...stable.source, tag: null },
      artifact: {
        ...stable.artifact,
        url: `https://github.com/kody-w/openrappter/archive/${stable.source.commit}.tar.gz`,
        install_url: null,
        provenance: 'github-commit-archive-sha256',
      },
    };
    await expect(resolveRing('alpha', { fetchImpl: trustedFetch(disabled) })).rejects.toThrow('disabled');
  });
  it('rejects downgrade unless explicit', async () => {
    await expect(resolveRing('stable', {
      fetchImpl: trustedFetch(stable),
      currentVersion: '2.0.0',
    })).rejects.toThrow('refusing downgrade');
    await expect(resolveRing('stable', {
      fetchImpl: trustedFetch(stable),
      currentVersion: '2.0.0',
      allowDowngrade: true,
    })).resolves.toMatchObject({ version: '1.9.8' });
  });
  it('verifies artifact bytes and rejects mismatch', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, arrayBuffer: async () => new TextEncoder().encode('hello').buffer }) as Response) as typeof fetch;
    await expect(downloadAndVerify(stable, fetchImpl)).resolves.toHaveLength(5);
    await expect(downloadAndVerify({ ...stable, artifact: { ...stable.artifact, sha256: '0'.repeat(64) } }, fetchImpl)).rejects.toThrow('checksum mismatch');
  });
});
