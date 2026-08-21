import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  BoundedReplayCache,
  RAPPID_CARD_FIXTURE_NAMES,
  buildRappidCardFixture,
  buildRappidCardVectorDocument,
  challengeValue,
  makeDeepLink,
  manifestHash,
  parseDeepLink,
  parseManifestJson,
  reduceCardState,
  renderRappidCardQrPng,
  renderRappidCardQrSvg,
  signManifest,
  simulateRappidCard,
  simulateRappidCardFixture,
  unsignedManifest,
  validateManifest,
  writeRappidCardFixtureDeck,
} from './index.js';
import type {
  CardPolicy,
  CardProviders,
  CardSimulationSnapshot,
  RappidCardManifest,
} from './index.js';

const vectors = JSON.parse(
  readFileSync(
    new URL('../../../tests/rappid-card-vectors.json', import.meta.url),
    'utf8',
  ),
) as Awaited<ReturnType<typeof buildRappidCardVectorDocument>>;

const generatedDirectories: string[] = [];

afterEach(() => {
  for (const directory of generatedDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function providersFor(
  manifest: RappidCardManifest,
  providers: CardProviders,
): CardProviders {
  return {
    ...providers,
    manifests: { getManifest: () => structuredClone(manifest) },
  };
}

describe('virtual RAPPID card contract', () => {
  it('matches the shared TypeScript/Python vector document byte-for-byte', async () => {
    expect(await buildRappidCardVectorDocument()).toEqual(vectors);
    expect(vectors.fixtures).toHaveLength(13);
  });

  it('keeps the test profile separate from production and refuses it in production mode', async () => {
    const fixture = buildRappidCardFixture('valid');
    const result = await simulateRappidCard(fixture.deepLink, {
      approve: false,
      policy: { ...fixture.policy, mode: 'production' },
      providers: fixture.providers,
    });
    expect(result.error?.code).toBe('test_profile_forbidden');
  });

  it('accepts a production profile only with explicitly injected production keys', async () => {
    const fixture = buildRappidCardFixture('valid');
    const key = Buffer.from('44'.repeat(32), 'hex');
    const unsigned = structuredClone(unsignedManifest(fixture.manifest));
    unsigned.profile = 'rappid-card-production/1';
    unsigned.challenge = {
      algorithm: 'hmac-sha256',
      keyId: 'production-card-key',
    };
    const manifest = signManifest(unsigned, {
      algorithm: 'hmac-sha256',
      keyId: 'production-card-key',
      key,
    });
    const deepLink = makeDeepLink(manifest);
    const providers: CardProviders = {
      manifests: { getManifest: () => structuredClone(manifest) },
      keys: { getKey: () => key },
      revocations: { isRevoked: () => false },
      content: fixture.providers.content,
      challenge: { respond: (request) => challengeValue(request, key) },
    };
    const result = await simulateRappidCard(deepLink, {
      approve: true,
      policy: { ...fixture.policy, mode: 'production' },
      providers,
    });
    expect(result.state).toBe('awake');
  });

  it('rejects secret, memory, command, credential, path, and inline payload fields', () => {
    const manifest = buildRappidCardFixture('valid').manifest;
    for (const field of [
      'secret',
      'privateMemory',
      'command',
      'credentials',
      'path',
      'payload',
    ]) {
      expect(() => validateManifest({ ...manifest, [field]: 'forbidden' }))
        .toThrow(/card is closed/);
    }
    expect(() =>
      validateManifest({
        ...manifest,
        parts: [{ ...manifest.parts[0], path: '../../private' }],
      }),
    ).toThrow(/card\.parts\[0\] is closed/);
    expect(() =>
      validateManifest({
        ...manifest,
        parts: [{ ...manifest.parts[0], mediaType: 'application/x-executable' }],
      }),
    ).toThrow(/mediaType is invalid/);
  });

  it('uses a deterministic canonical hash independent of object insertion order', () => {
    const manifest = buildRappidCardFixture('valid').manifest;
    const reordered = Object.fromEntries(
      Object.entries(manifest).reverse(),
    );
    expect(manifestHash(validateManifest(reordered))).toBe(manifestHash(manifest));
  });

  it('requires the canonical compact URI with exactly m, e, and n', () => {
    const fixture = buildRappidCardFixture('valid');
    expect(parseDeepLink(fixture.deepLink).deepLink).toBe(fixture.deepLink);
    expect(() => parseDeepLink(`${fixture.deepLink}&extra=1`))
      .toThrow(/exactly m, e, and n/);
  });

  it('rejects duplicate JSON object keys before canonicalization', () => {
    const raw = JSON.stringify(buildRappidCardFixture('valid').manifest);
    expect(() =>
      parseManifestJson(raw.replace(
        '"schema":"rappid-card/1"',
        '"schema":"rappid-card/1","schema":"rappid-card/1"',
      )),
    ).toThrow(/duplicate JSON object key: schema/);
  });
});

describe('virtual RAPPID card simulator', () => {
  it.each(RAPPID_CARD_FIXTURE_NAMES)(
    'runs the %s fixture deterministically',
    async (name) => {
      const fixture = buildRappidCardFixture(name);
      const result = await simulateRappidCardFixture(name, true);
      expect(result.state).toBe(fixture.expectedState);
      expect(result.error?.code ?? null).toBe(fixture.expectedError);
    },
  );

  it('stops at preview until approval is explicit', async () => {
    const preview = await simulateRappidCardFixture('valid', false);
    expect(preview.state).toBe('preview');
    expect(preview.hydrated).toEqual([]);
    expect(preview.audit.map((event) => event.event)).not.toContain(
      'approval.explicit',
    );
  });

  it('fails a signature mutation even when the link hash is updated', async () => {
    const fixture = buildRappidCardFixture('valid');
    const manifest = structuredClone(fixture.manifest);
    manifest.signature.value =
      `${manifest.signature.value[0] === '0' ? '1' : '0'}${manifest.signature.value.slice(1)}`;
    const result = await simulateRappidCard(makeDeepLink(manifest), {
      approve: false,
      policy: fixture.policy,
      providers: providersFor(manifest, fixture.providers),
    });
    expect(result.error?.code).toBe('signature_invalid');
  });

  it('fails hash, classification, scope, and challenge mutation controls', async () => {
    const results = await Promise.all([
      simulateRappidCardFixture('wrong-hash', true),
      simulateRappidCardFixture('classification-violation', true),
      simulateRappidCardFixture('insufficient-scope', true),
      simulateRappidCardFixture('challenge-failure', true),
    ]);
    expect(results.map((result) => result.error?.code)).toEqual([
      'manifest_hash_mismatch',
      'classification_violation',
      'insufficient_scope',
      'challenge_failed',
    ]);
  });

  it('fails a same-length hydrated content mutation', async () => {
    const fixture = buildRappidCardFixture('valid');
    let corrupted = false;
    const providers: CardProviders = {
      ...fixture.providers,
      content: {
        async getPart(hash) {
          const value = await fixture.providers.content.getPart(hash);
          if (value === null || corrupted) return value;
          corrupted = true;
          const copy = Uint8Array.from(value);
          copy[0] ^= 0xff;
          return copy;
        },
      },
    };
    const result = await simulateRappidCard(fixture.deepLink, {
      approve: true,
      policy: fixture.policy,
      providers,
    });
    expect(result.error?.code).toBe('part_hash_mismatch');
  });

  it('fails incompatible runtime independently of protocol', async () => {
    const fixture = buildRappidCardFixture('valid');
    const policy: CardPolicy = {
      ...fixture.policy,
      runtimeVersion: '2.0.0',
    };
    const result = await simulateRappidCard(fixture.deepLink, {
      approve: false,
      policy,
      providers: fixture.providers,
    });
    expect(result.error?.code).toBe('incompatible_runtime');
  });

  it('records a nonce once and rejects replay on the second simulation', async () => {
    const fixture = buildRappidCardFixture('valid');
    const replay = new BoundedReplayCache();
    const first = await simulateRappidCard(fixture.deepLink, {
      approve: true,
      policy: fixture.policy,
      providers: fixture.providers,
      replayCache: replay,
    });
    const second = await simulateRappidCard(fixture.deepLink, {
      approve: true,
      policy: fixture.policy,
      providers: fixture.providers,
      replayCache: replay,
    });
    expect(first.state).toBe('awake');
    expect(second.error?.code).toBe('duplicate_nonce');
  });

  it('bounds replay entries and audit events', () => {
    const replay = new BoundedReplayCache(3);
    ['a', 'b', 'c', 'd'].forEach((nonce) => replay.add(nonce));
    expect(replay.values()).toEqual(['b', 'c', 'd']);

    let snapshot: CardSimulationSnapshot = {
      state: 'idle',
      outcome: 'pending',
      error: null,
      manifestHash: null,
      deepLink: null,
      preview: null,
      hydrated: [],
      audit: [],
    };
    for (let index = 0; index < 100; index += 1) {
      snapshot = reduceCardState(snapshot, {
        state: 'parsed',
        event: 'bounded',
        detail: String(index),
      });
    }
    expect(snapshot.audit).toHaveLength(64);
    expect(snapshot.audit[0].seq).toBe(37);
    expect(snapshot.audit.at(-1)?.seq).toBe(100);
  });
});

describe('real QR and fixture artifacts', () => {
  it('renders genuine QR SVG and PNG bytes for the exact link', async () => {
    const link = buildRappidCardFixture('physical-payload-reproduction').deepLink;
    const svg = await renderRappidCardQrSvg(link);
    const png = await renderRappidCardQrPng(link);
    expect(svg).toContain('<svg');
    expect(svg).toContain('<path');
    expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  });

  it('writes all cards using the .rappid-card.json convention with link and QR sidecars', async () => {
    const directory = join(
      process.cwd(),
      `.rappid-card-test-output-${process.pid}`,
    );
    generatedDirectories.push(directory);
    const result = await writeRappidCardFixtureDeck(directory, 'svg');
    expect(result.fixtures).toBe(13);
    expect(result.files.filter((file) => file.endsWith('/.rappid-card.json')))
      .toHaveLength(13);
    const physical = buildRappidCardFixture('physical-payload-reproduction');
    expect(
      readFileSync(
        join(
          directory,
          'physical-payload-reproduction',
          'rappid-card.link.txt',
        ),
        'utf8',
      ).trim(),
    ).toBe(physical.deepLink);
  });
});
