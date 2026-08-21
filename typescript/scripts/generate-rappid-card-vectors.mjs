import { createHash } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import {
  RAPPID_CARD_AUTHORIZATION_SCHEMA,
  RAPPID_CARD_POLICY_SCHEMA,
  RAPPID_CARD_PRODUCTION_PROFILE,
  RAPPID_CARD_PROTOCOL,
  RAPPID_CARD_REVOCATIONS_SCHEMA,
  RAPPID_CARD_SCHEMA,
  SqliteCardStateStore,
  buildRappidCardVectorDocument,
  challengeValue,
  ed25519PublicKey,
  makeDeepLink,
  manifestHash,
  signAuthorization,
  signManifest,
  signPolicy,
  signRevocations,
  simulateRappidCard,
} from '../dist/rappid-card/index.js';
import {
  canonicalJson,
  sha256Hex,
} from '../dist/rappids/canonical.js';

const output = new URL('../../tests/rappid-card-vectors.json', import.meta.url);
const productionOutput = new URL(
  '../../tests/rappid-card-production-vectors.json',
  import.meta.url,
);
const stateUrl = new URL('../.rappid-card-production-vectors.sqlite', import.meta.url);
const statePath = fileURLToPath(stateUrl);

function seed(label) {
  return createHash('sha256').update(label, 'utf8').digest();
}

const authoritySeed = seed('rappid-card-production-vector/1:authority');
const signerSeed = seed('rappid-card-production-vector/1:signer');
const authorityPublicKey = ed25519PublicKey(authoritySeed);
const signerPublicKey = ed25519PublicKey(signerSeed);
const policyId = 'production-vector-policy';
const authorizationId = 'production-vector-authorization';
const authorityKeyId = 'production-vector-authority';
const signerKeyId = 'production-vector-signer';
const origin = 'https://cards.openrappter.example';
const endpoint = `${origin}/rappid-card`;
const rappid =
  `rappid:@openrappter/production-vector:${sha256Hex('rappid-card-production-vector/1:subject')}`;
const identity = Buffer.from(canonicalJson({
  displayName: 'Production Vector RAPPID',
  kind: 'positive-production-vector',
  rappid,
}), 'utf8');
const traits = Buffer.from(canonicalJson({
  continuity: 1000,
  evidenceBound: 1000,
  localFirst: 1000,
}), 'utf8');
const contents = new Map([
  [sha256Hex(identity), identity],
  [sha256Hex(traits), traits],
]);
const parts = [
  {
    name: 'identity',
    hash: sha256Hex(identity),
    bytes: identity.byteLength,
    mediaType: 'application/json',
    classification: 'public',
    scope: 'identity:read',
    required: true,
  },
  {
    name: 'traits',
    hash: sha256Hex(traits),
    bytes: traits.byteLength,
    mediaType: 'application/json',
    classification: 'public',
    scope: 'traits:read',
    required: true,
  },
];

function makeVector(name, policySequence, authorizationSequence, revocationSequence) {
  const policy = signPolicy({
    schema: RAPPID_CARD_POLICY_SCHEMA,
    policyId,
    sequence: policySequence,
    issuedAt: '2020-01-01T00:00:00Z',
    expiresAt: '2099-01-01T00:00:00Z',
    allowedProfiles: [RAPPID_CARD_PRODUCTION_PROFILE],
    protocol: RAPPID_CARD_PROTOCOL,
    runtime: {
      name: 'openrappter',
      minimum: '1.13.0',
      maximum: '1.99.0',
    },
    maxClassification: 'public',
    grantedScopes: ['identity:read', 'traits:read'],
    approvedOrigins: [origin],
  }, {
    algorithm: 'ed25519',
    keyId: authorityKeyId,
    privateKey: authoritySeed,
  });
  const authorization = signAuthorization({
    schema: RAPPID_CARD_AUTHORIZATION_SCHEMA,
    authorizationId,
    policyId,
    sequence: authorizationSequence,
    subjectRappid: rappid,
    signerKeyId,
    signerAlgorithm: 'ed25519',
    signerPublicKey,
    notBefore: '2020-01-01T00:00:00Z',
    notAfter: '2099-01-01T00:00:00Z',
    maxClassification: 'public',
    grantedScopes: ['identity:read', 'traits:read'],
    approvedOrigins: [origin],
  }, {
    algorithm: 'ed25519',
    keyId: authorityKeyId,
    privateKey: authoritySeed,
  });
  const revocations = signRevocations({
    schema: RAPPID_CARD_REVOCATIONS_SCHEMA,
    policyId,
    sequence: revocationSequence,
    issuedAt: '2020-01-01T00:00:00Z',
    expiresAt: '2099-01-01T00:00:00Z',
    revokedManifestHashes: [],
    revokedSignerKeyIds: [],
    revokedAuthorizationIds: [],
  }, {
    algorithm: 'ed25519',
    keyId: authorityKeyId,
    privateKey: authoritySeed,
  });
  const manifest = signManifest({
    schema: RAPPID_CARD_SCHEMA,
    profile: RAPPID_CARD_PRODUCTION_PROFILE,
    policyId,
    rappid,
    endpoint,
    nonce: sha256Hex(`rappid-card-production-vector/1:nonce:${name}`).slice(0, 32),
    issuedAt: '2020-01-01T00:00:00Z',
    expiresAt: '2099-01-01T00:00:00Z',
    protocol: RAPPID_CARD_PROTOCOL,
    runtime: {
      name: 'openrappter',
      minimum: '1.13.0',
      maximum: '1.99.0',
    },
    classification: 'public',
    scopes: ['identity:read', 'traits:read'],
    parts,
    challenge: {
      algorithm: 'ed25519',
      keyId: signerKeyId,
    },
  }, {
    algorithm: 'ed25519',
    keyId: signerKeyId,
    privateKey: signerSeed,
  });
  const hash = manifestHash(manifest);
  const deepLink = makeDeepLink(manifest, hash);
  const challengeResponse = challengeValue({
    manifestHash: hash,
    nonce: manifest.nonce,
    partHashes: parts.map((part) => part.hash),
  }, signerSeed);
  const vector = {
    name,
    manifest,
    manifestHash: hash,
    deepLink,
    policy,
    authorization,
    revocations,
    authorityKeys: {
      [authorityKeyId]: authorityPublicKey,
    },
    contents: Object.fromEntries(
      [...contents.entries()].map(([contentHash, bytes]) => [
        contentHash,
        bytes.toString('base64'),
      ]),
    ),
    challengeResponse,
  };
  return vector;
}

function providers(vector) {
  return {
    manifests: { getManifest: () => structuredClone(vector.manifest) },
    trust: {
      getPolicyForOrigin: () => structuredClone(vector.policy),
      getAuthorization: () => structuredClone(vector.authorization),
      getRevocations: () => structuredClone(vector.revocations),
      getAuthorityKey: (keyId) => vector.authorityKeys[keyId] ?? null,
    },
    content: {
      getPart: (hash) => {
        const encoded = vector.contents[hash];
        return encoded === undefined ? null : Buffer.from(encoded, 'base64');
      },
    },
    challenge: { respond: () => vector.challengeResponse },
  };
}

for (const suffix of ['', '-wal', '-shm']) {
  await rm(`${statePath}${suffix}`, { force: true });
}
const stateStore = await SqliteCardStateStore.open(statePath);
try {
  const definitions = [
    makeVector('production-valid', 20, 10, 30),
    makeVector('production-rotated', 21, 11, 31),
    makeVector('production-rollback', 20, 10, 30),
  ];
  const vectors = [];
  for (const vector of definitions) {
    const preview = await simulateRappidCard(vector.deepLink, {
      approve: false,
      providers: providers(vector),
      stateStore,
    });
    const approved = preview.state === 'preview'
      ? await simulateRappidCard(vector.deepLink, {
          approve: true,
          providers: providers(vector),
          stateStore,
        })
      : preview;
    vectors.push({ ...vector, preview, approved });
  }
  await writeFile(
    productionOutput,
    `${JSON.stringify({
      schema: 'rappid-card-production-vectors/1',
      vectors,
    }, null, 2)}\n`,
    'utf8',
  );
} finally {
  stateStore.close();
  for (const suffix of ['', '-wal', '-shm']) {
    await rm(`${statePath}${suffix}`, { force: true });
  }
}

const fixtureVectors = await buildRappidCardVectorDocument();
await writeFile(output, `${JSON.stringify(fixtureVectors, null, 2)}\n`, 'utf8');
console.log(
  `wrote ${fixtureVectors.fixtures.length} fixture and 3 production RAPPID card vectors`,
);
