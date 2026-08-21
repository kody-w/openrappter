import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  BoundedCardStateStore,
  RAPPID_CARD_FIXTURE_NAMES,
  SqliteCardStateStore,
  buildRappidCardFixture,
  buildRappidCardVectorDocument,
  makeDeepLink,
  manifestHash,
  parseDeepLink,
  parseManifestJson,
  reduceCardState,
  renderRappidCardQrPng,
  renderRappidCardQrSvg,
  signFixtureAuthorization,
  signFixtureManifest,
  signFixturePolicy,
  signFixtureRevocations,
  simulateRappidCard,
  simulateRappidCardFixture,
  simulateRappidCardFixtureInput,
  unsignedDocument,
  validateManifest,
  writeRappidCardFixtureDeck,
} from './index.js';
import type {
  CardProviders,
  CardSimulationSnapshot,
  RappidCardFixture,
  RappidCardManifest,
} from './index.js';

const vectors = JSON.parse(
  readFileSync(
    new URL('../../../tests/rappid-card-vectors.json', import.meta.url),
    'utf8',
  ),
) as Awaited<ReturnType<typeof buildRappidCardVectorDocument>>;

interface ProductionVector {
  name: string;
  manifest: RappidCardManifest;
  manifestHash: string;
  deepLink: string;
  policy: unknown;
  authorization: unknown;
  revocations: unknown;
  authorityKeys: Record<string, string>;
  contents: Record<string, string>;
  challengeResponse: string;
  preview: CardSimulationSnapshot;
  approved: CardSimulationSnapshot;
}

const productionVectors = JSON.parse(
  readFileSync(
    new URL('../../../tests/rappid-card-production-vectors.json', import.meta.url),
    'utf8',
  ),
) as {
  schema: string;
  vectors: ProductionVector[];
};

const generatedPaths: string[] = [];

afterEach(() => {
  for (const path of generatedPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true });
    rmSync(`${path}-wal`, { force: true });
    rmSync(`${path}-shm`, { force: true });
  }
});

function fixtureWithManifest(
  fixture: RappidCardFixture,
  manifest: RappidCardManifest,
): RappidCardFixture {
  const hash = manifestHash(manifest);
  return {
    ...fixture,
    manifest,
    manifestHash: hash,
    deepLink: makeDeepLink(manifest, hash),
    providers: {
      ...fixture.providers,
      manifests: { getManifest: () => structuredClone(manifest) },
    },
    stateStore: new BoundedCardStateStore(),
  };
}

function productionProviders(vector: ProductionVector): CardProviders {
  return {
    manifests: {
      getManifest: () => structuredClone(vector.manifest),
    },
    trust: {
      getPolicyForOrigin: () => structuredClone(vector.policy),
      getAuthorization: () => structuredClone(vector.authorization),
      getRevocations: () => structuredClone(vector.revocations),
      getAuthorityKey(keyId) {
        return vector.authorityKeys[keyId] ?? null;
      },
    },
    content: {
      getPart(hash) {
        const value = vector.contents[hash];
        return value === undefined ? null : Buffer.from(value, 'base64');
      },
    },
    challenge: {
      respond: () => vector.challengeResponse,
    },
  };
}

async function sqliteStore(label: string): Promise<SqliteCardStateStore> {
  const path = join(
    process.cwd(),
    `.rappid-card-${label}-${process.pid}.sqlite`,
  );
  generatedPaths.push(path);
  return SqliteCardStateStore.open(path);
}

describe('authenticated virtual RAPPID card contract', () => {
  it('matches the shared TypeScript/Python signed-trust vectors', async () => {
    expect(await buildRappidCardVectorDocument()).toEqual(vectors);
    expect(vectors.schema).toBe('rappid-card-vectors/2');
    expect(vectors.fixtures).toHaveLength(13);
  });

  it('rejects caller-selected fixture trust on the production entry point', async () => {
    const fixture = buildRappidCardFixture('valid');
    const store = await sqliteStore('test-profile-refusal');
    try {
      const result = await simulateRappidCard(fixture.deepLink, {
        approve: false,
        providers: fixture.providers,
        stateStore: store,
      });
      expect(result.error?.code).toBe('test_signature_forbidden');
    } finally {
      store.close();
    }
  });

  it('requires the concrete durable state store in production', async () => {
    const vector = productionVectors.vectors[0];
    const result = await simulateRappidCard(vector.deepLink, {
      approve: false,
      providers: productionProviders(vector),
      stateStore: new BoundedCardStateStore() as never,
    });
    expect(result.error?.code).toBe('durable_state_required');
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
  });

  it('keeps deterministic canonical hashes independent of insertion order', () => {
    const manifest = buildRappidCardFixture('valid').manifest;
    const reordered = Object.fromEntries(Object.entries(manifest).reverse());
    expect(manifestHash(validateManifest(reordered))).toBe(manifestHash(manifest));
  });

  it('requires canonical m/e/n ordering and decoded secret-free HTTPS endpoints', () => {
    const fixture = buildRappidCardFixture('valid');
    expect(parseDeepLink(fixture.deepLink).deepLink).toBe(fixture.deepLink);
    expect(() => parseDeepLink(`${fixture.deepLink}&extra=1`))
      .toThrow(/exactly m, e, and n/);
    const secretEndpoint = encodeURIComponent(
      'https://user:password@fixture.openrappter.test/rappid-card',
    );
    expect(() =>
      parseDeepLink(
        fixture.deepLink.replace(
          /&e=[^&]+/,
          `&e=${secretEndpoint}`,
        ),
      ),
    ).toThrow(/must not contain userinfo/);
    const queryEndpoint = encodeURIComponent(
      'https://fixture.openrappter.test/rappid-card?token=secret',
    );
    expect(() =>
      parseDeepLink(
        fixture.deepLink.replace(/&e=[^&]+/, `&e=${queryEndpoint}`),
      ),
    ).toThrow(/must not contain userinfo/);
  });

  it('rejects duplicate JSON keys before canonicalization', () => {
    const raw = JSON.stringify(buildRappidCardFixture('valid').manifest);
    expect(() =>
      parseManifestJson(raw.replace(
        '"schema":"rappid-card/1"',
        '"schema":"rappid-card/1","schema":"rappid-card/1"',
      )),
    ).toThrow(/duplicate JSON object key: schema/);
  });
});

describe('signed trust and mutation controls', () => {
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
    expect(preview.preview).toMatchObject({
      policyId: 'fixture-policy-1',
      authorizationId: 'fixture-authorization-1',
      origin: 'https://fixture.openrappter.test',
      policySequence: 7,
      authorizationSequence: 3,
      revocationSequence: 11,
    });
  });

  it('fails a card signature mutation even when the link hash is updated', async () => {
    const fixture = buildRappidCardFixture('valid');
    const manifest = structuredClone(fixture.manifest);
    manifest.signature.value =
      `${manifest.signature.value[0] === 'A' ? 'B' : 'A'}${manifest.signature.value.slice(1)}`;
    const result = await simulateRappidCardFixtureInput(
      fixtureWithManifest(fixture, manifest),
      false,
    );
    expect(result.error?.code).toBe('signature_invalid');
  });

  it('rejects policy and revocation tampering before using their contents', async () => {
    const policyFixture = buildRappidCardFixture('valid');
    const policy = structuredClone(policyFixture.policy);
    policy.maxClassification = 'restricted';
    policyFixture.providers = {
      ...policyFixture.providers,
      trust: {
        ...policyFixture.providers.trust,
        getPolicyForOrigin: () => policy,
      },
    };
    expect(
      (await simulateRappidCardFixtureInput(policyFixture, false)).error?.code,
    ).toBe('policy_signature_invalid');

    const revocationFixture = buildRappidCardFixture('valid');
    const revocations = structuredClone(revocationFixture.revocations);
    revocations.revokedManifestHashes.push(revocationFixture.manifestHash);
    revocationFixture.providers = {
      ...revocationFixture.providers,
      trust: {
        ...revocationFixture.providers.trust,
        getRevocations: () => revocations,
      },
    };
    expect(
      (await simulateRappidCardFixtureInput(revocationFixture, false)).error?.code,
    ).toBe('revocation_signature_invalid');
  });

  it('enforces signer-to-subject authorization after authority verification', async () => {
    const fixture = buildRappidCardFixture('valid');
    const authorization = signFixtureAuthorization({
      ...unsignedDocument(fixture.authorization),
      subjectRappid:
        `rappid:@openrappter/other-subject:${'a'.repeat(64)}`,
    });
    fixture.providers = {
      ...fixture.providers,
      trust: {
        ...fixture.providers.trust,
        getAuthorization: () => authorization,
      },
    };
    const result = await simulateRappidCardFixtureInput(fixture, false);
    expect(result.error?.code).toBe('signer_subject_unauthorized');
  });

  it('requires endpoint origin in both signed policy and signer authorization', async () => {
    const fixture = buildRappidCardFixture('valid');
    const unsigned = {
      ...unsignedDocument(fixture.manifest),
      endpoint: 'https://unapproved.openrappter.test/rappid-card',
    };
    const changed = fixtureWithManifest(
      fixture,
      signFixtureManifest(unsigned),
    );
    let manifestFetched = false;
    changed.providers = {
      ...changed.providers,
      manifests: {
        getManifest: () => {
          manifestFetched = true;
          return structuredClone(changed.manifest);
        },
      },
      trust: {
        ...changed.providers.trust,
        getPolicyForOrigin: () => structuredClone(changed.policy),
      },
    };
    const result = await simulateRappidCardFixtureInput(changed, false);
    expect(result.error?.code).toBe('origin_not_approved');
    expect(manifestFetched).toBe(false);
  });

  it('fails hash, classification, scope, and challenge controls', async () => {
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
    const originalContent = fixture.providers.content;
    fixture.providers = {
      ...fixture.providers,
      content: {
        async getPart(hash) {
          const value = await originalContent.getPart(hash);
          if (value === null || corrupted) return value;
          corrupted = true;
          const copy = Uint8Array.from(value);
          copy[0] ^= 0xff;
          return copy;
        },
      },
    };
    const result = await simulateRappidCardFixtureInput(fixture, true);
    expect(result.error?.code).toBe('part_hash_mismatch');
  });

  it('fails incompatible runtime independently of protocol', async () => {
    const fixture = buildRappidCardFixture('valid');
    const manifest = signFixtureManifest({
      ...unsignedDocument(fixture.manifest),
      runtime: {
        name: 'openrappter',
        minimum: '2.0.0',
        maximum: '2.0.0',
      },
    });
    const result = await simulateRappidCardFixtureInput(
      fixtureWithManifest(fixture, manifest),
      false,
    );
    expect(result.error?.code).toBe('incompatible_runtime');
  });

  it('rejects a signed revocation rollback through the state transaction', async () => {
    const store = new BoundedCardStateStore();
    const current = buildRappidCardFixture('valid');
    current.stateStore = store;
    current.revocations = signFixtureRevocations({
      ...unsignedDocument(current.revocations),
      sequence: 12,
    });
    current.providers = {
      ...current.providers,
      trust: {
        ...current.providers.trust,
        getRevocations: () => structuredClone(current.revocations),
      },
    };
    expect(
      (await simulateRappidCardFixtureInput(current, false)).state,
    ).toBe('preview');

    const stale = buildRappidCardFixture('valid');
    stale.stateStore = store;
    const result = await simulateRappidCardFixtureInput(stale, false);
    expect(result.error?.code).toBe('revocation_rollback');
  });

  it('rejects same-sequence signed revocation equivocation', async () => {
    const store = new BoundedCardStateStore();
    const first = buildRappidCardFixture('valid');
    first.stateStore = store;
    expect(
      (await simulateRappidCardFixtureInput(first, false)).state,
    ).toBe('preview');

    const fork = buildRappidCardFixture('valid');
    fork.stateStore = store;
    fork.revocations = signFixtureRevocations({
      ...unsignedDocument(fork.revocations),
      revokedManifestHashes: ['e'.repeat(64)],
    });
    fork.providers = {
      ...fork.providers,
      trust: {
        ...fork.providers.trust,
        getRevocations: () => structuredClone(fork.revocations),
      },
    };
    const result = await simulateRappidCardFixtureInput(fork, false);
    expect(result.error?.code).toBe('revocation_equivocation');
  });

  it('rejects policy rollback before calling the manifest provider', async () => {
    const store = new BoundedCardStateStore();
    const current = buildRappidCardFixture('valid');
    current.stateStore = store;
    current.policy = signFixturePolicy({
      ...unsignedDocument(current.policy),
      sequence: 8,
    });
    current.providers = {
      ...current.providers,
      trust: {
        ...current.providers.trust,
        getPolicyForOrigin: () => structuredClone(current.policy),
      },
    };
    expect(
      (await simulateRappidCardFixtureInput(current, false)).state,
    ).toBe('preview');

    const stale = buildRappidCardFixture('valid');
    stale.stateStore = store;
    let manifestFetched = false;
    stale.providers = {
      ...stale.providers,
      manifests: {
        getManifest: () => {
          manifestFetched = true;
          return structuredClone(stale.manifest);
        },
      },
    };
    const result = await simulateRappidCardFixtureInput(stale, false);
    expect(result.error?.code).toBe('policy_rollback');
    expect(manifestFetched).toBe(false);
  });

  it('atomically records a nonce and rejects replay', async () => {
    const fixture = buildRappidCardFixture('valid');
    const store = new BoundedCardStateStore();
    fixture.stateStore = store;
    const first = await simulateRappidCardFixtureInput(fixture, true);
    const secondFixture = buildRappidCardFixture('valid');
    secondFixture.stateStore = store;
    const second = await simulateRappidCardFixtureInput(secondFixture, true);
    expect(first.state).toBe('awake');
    expect(second.error?.code).toBe('duplicate_nonce');
  });

  it('persists replay across SQLite close and reopen', async () => {
    const vector = productionVectors.vectors[0];
    const path = join(
      process.cwd(),
      `.rappid-card-durable-replay-${process.pid}.sqlite`,
    );
    generatedPaths.push(path);
    let store = await SqliteCardStateStore.open(path);
    const first = await simulateRappidCard(vector.deepLink, {
      approve: true,
      providers: productionProviders(vector),
      stateStore: store,
    });
    store.close();
    store = await SqliteCardStateStore.open(path);
    try {
      const second = await simulateRappidCard(vector.deepLink, {
        approve: true,
        providers: productionProviders(vector),
        stateStore: store,
      });
      expect(first.state).toBe('awake');
      expect(second.error?.code).toBe('duplicate_nonce');
    } finally {
      store.close();
    }
  });

  it('bounds fixture replay entries and audit events', () => {
    const store = new BoundedCardStateStore(3);
    for (const [index, nonce] of ['a', 'b', 'c', 'd'].entries()) {
      store.record({
        policyId: 'p',
        policySequence: index,
        policyHash: `${index}`.padStart(64, '0'),
        authorizationId: 'a',
        authorizationSequence: index,
        authorizationHash: `${index + 10}`.padStart(64, '0'),
        revocationSequence: index,
        revocationHash: `${index + 20}`.padStart(64, '0'),
        nonce,
        manifestHash: 'f'.repeat(64),
      }, true);
    }
    expect(store.values()).toEqual(['b', 'c', 'd']);

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

describe('positive production vectors', () => {
  it('accepts valid and rotated Ed25519 trust views, then rejects rollback', async () => {
    const store = await sqliteStore('production-vectors');
    try {
      for (const vector of productionVectors.vectors) {
        const preview = await simulateRappidCard(vector.deepLink, {
          approve: false,
          providers: productionProviders(vector),
          stateStore: store,
        });
        expect(preview).toEqual(vector.preview);
        if (vector.approved.state === 'awake') {
          const approved = await simulateRappidCard(vector.deepLink, {
            approve: true,
            providers: productionProviders(vector),
            stateStore: store,
          });
          expect(approved).toEqual(vector.approved);
        } else {
          expect(preview).toEqual(vector.approved);
        }
      }
    } finally {
      store.close();
    }
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

  it('writes cards with signed trust and QR sidecars', async () => {
    const directory = join(
      process.cwd(),
      `.rappid-card-test-output-${process.pid}`,
    );
    generatedPaths.push(directory);
    const result = await writeRappidCardFixtureDeck(directory, 'svg');
    expect(result.fixtures).toBe(13);
    expect(result.files.filter((file) => file.endsWith('/.rappid-card.json')))
      .toHaveLength(13);
    expect(
      result.files.filter((file) => file.endsWith('rappid-card.policy.json')),
    ).toHaveLength(13);
  });
});
