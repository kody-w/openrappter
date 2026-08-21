import { TextEncoder } from 'node:util';

import { canonicalJson, sha256Hex } from '../rappids/canonical.js';
import type { JsonValue } from '../rappids/types.js';
import {
  challengeValue,
  ed25519PublicKey,
  makeDeepLink,
  manifestHash,
  signAuthorization,
  signManifest,
  signPolicy,
  signRevocations,
} from './contract.js';
import { BoundedCardStateStore } from './replay-cache.js';
import { simulateRappidCardFixtureMode } from './simulator.js';
import {
  RAPPID_CARD_AUTHORIZATION_SCHEMA,
  RAPPID_CARD_POLICY_SCHEMA,
  RAPPID_CARD_PROTOCOL,
  RAPPID_CARD_REVOCATIONS_SCHEMA,
  RAPPID_CARD_SCHEMA,
  RAPPID_CARD_TEST_PROFILE,
  RappidCardReconnectError,
} from './types.js';
import type {
  CardProviders,
  CardScope,
  CardSimulationSnapshot,
  ContinuityChallengeRequest,
  RappidCardAuthorization,
  RappidCardManifest,
  RappidCardPart,
  RappidCardPolicy,
  RappidCardRevocations,
} from './types.js';

export const RAPPID_CARD_FIXTURE_NOW = '2035-01-01T12:00:00Z';
export const FIXTURE_ENDPOINT =
  'https://fixture.openrappter.test/rappid-card';
export const FIXTURE_ORIGIN = 'https://fixture.openrappter.test';
export const FIXTURE_POLICY_ID = 'fixture-policy-1';
export const FIXTURE_AUTHORIZATION_ID = 'fixture-authorization-1';
export const FIXTURE_AUTHORITY_KEY_ID = 'fixture-authority-1';
export const FIXTURE_SIGNING_KEY_ID = 'fixture-signer-1';
export const FIXTURE_CHALLENGE_KEY_ID = FIXTURE_SIGNING_KEY_ID;

const encoder = new TextEncoder();
const FIXTURE_AUTHORITY_SEED = Buffer.from(
  sha256Hex('rappid-card-test/1:synthetic-authority-seed'),
  'hex',
);
const FIXTURE_SIGNER_SEED = Buffer.from(
  sha256Hex('rappid-card-test/1:synthetic-signer-seed'),
  'hex',
);
const FIXTURE_AUTHORITY_PUBLIC_KEY =
  ed25519PublicKey(FIXTURE_AUTHORITY_SEED);
const FIXTURE_SIGNER_PUBLIC_KEY = ed25519PublicKey(FIXTURE_SIGNER_SEED);
const FIXTURE_RAPPID =
  `rappid:@openrappter/virtual-debug-card:${sha256Hex('rappid-card-test/1:virtual-debug-card')}`;

export const RAPPID_CARD_FIXTURE_NAMES = [
  'valid',
  'expired',
  'revoked',
  'wrong-hash',
  'unknown-key',
  'incompatible-runtime-protocol',
  'classification-violation',
  'insufficient-scope',
  'missing-part',
  'challenge-failure',
  'reconnect-during-hydration',
  'duplicate-nonce',
  'physical-payload-reproduction',
] as const;

export type RappidCardFixtureName =
  (typeof RAPPID_CARD_FIXTURE_NAMES)[number];

interface FixtureContent {
  part: RappidCardPart;
  bytes: Uint8Array;
}

export interface RappidCardFixture {
  name: RappidCardFixtureName;
  label: string;
  description: string;
  transport: 'virtual' | 'physical-reproduction';
  manifest: RappidCardManifest;
  manifestHash: string;
  deepLink: string;
  policy: RappidCardPolicy;
  authorization: RappidCardAuthorization;
  revocations: RappidCardRevocations;
  expectedState: CardSimulationSnapshot['state'];
  expectedError: string | null;
  providers: CardProviders;
  stateStore: BoundedCardStateStore;
}

const DESCRIPTIONS: Record<
  RappidCardFixtureName,
  {
    label: string;
    description: string;
    expectedState: CardSimulationSnapshot['state'];
    expectedError: string | null;
  }
> = {
  valid: {
    label: 'Valid card',
    description: 'Authorized signer, current policy, monotonic revocations, approved origin, and valid challenge.',
    expectedState: 'awake',
    expectedError: null,
  },
  expired: {
    label: 'Expired card',
    description: 'A correctly signed and authorized card whose expiry is in the past.',
    expectedState: 'failed',
    expectedError: 'card_expired',
  },
  revoked: {
    label: 'Revoked card',
    description: 'A signed monotonic revocation view rejects the manifest hash.',
    expectedState: 'failed',
    expectedError: 'revoked',
  },
  'wrong-hash': {
    label: 'Wrong manifest hash',
    description: 'The endpoint returns a card that does not match m= in the link.',
    expectedState: 'failed',
    expectedError: 'manifest_hash_mismatch',
  },
  'unknown-key': {
    label: 'Unknown signing key',
    description: 'No signed authorization binds the named signer to the subject RAPPID.',
    expectedState: 'failed',
    expectedError: 'unknown_key',
  },
  'incompatible-runtime-protocol': {
    label: 'Incompatible runtime / protocol',
    description: 'An authorized card requires a future link protocol and runtime.',
    expectedState: 'failed',
    expectedError: 'incompatible_protocol',
  },
  'classification-violation': {
    label: 'Classification violation',
    description: 'The card exceeds signed policy and signer classification authority.',
    expectedState: 'failed',
    expectedError: 'classification_violation',
  },
  'insufficient-scope': {
    label: 'Insufficient scope',
    description: 'A required part asks for a scope absent from the signed card grant.',
    expectedState: 'failed',
    expectedError: 'insufficient_scope',
  },
  'missing-part': {
    label: 'Missing required part',
    description: 'Verification succeeds, then the content provider cannot hydrate a required hash.',
    expectedState: 'failed',
    expectedError: 'missing_part',
  },
  'challenge-failure': {
    label: 'Continuity challenge failure',
    description: 'All parts hydrate, but the authorized signer challenge is invalid.',
    expectedState: 'failed',
    expectedError: 'challenge_failed',
  },
  'reconnect-during-hydration': {
    label: 'Reconnect during hydration',
    description: 'The provider reconnects once; verified authorization resumes without weakening trust.',
    expectedState: 'awake',
    expectedError: null,
  },
  'duplicate-nonce': {
    label: 'Duplicate nonce',
    description: 'The transactional replay store already contains the signed nonce.',
    expectedState: 'failed',
    expectedError: 'duplicate_nonce',
  },
  'physical-payload-reproduction': {
    label: 'Physical payload reproduction',
    description: 'The exact approved-origin HTTPS endpoint survives QR/deep-link reproduction.',
    expectedState: 'awake',
    expectedError: null,
  },
};

function content(
  name: RappidCardPart['name'],
  value: JsonValue,
  scope: CardScope,
  mediaType: RappidCardPart['mediaType'] = 'application/json',
): FixtureContent {
  const bytes = encoder.encode(canonicalJson(value));
  return {
    bytes,
    part: {
      name,
      hash: sha256Hex(bytes),
      bytes: bytes.byteLength,
      mediaType,
      classification: 'public',
      scope,
      required: true,
    },
  };
}

function baseContents(): FixtureContent[] {
  return [
    content(
      'identity',
      {
        displayName: 'Virtual Debug RAPPID',
        kind: 'synthetic-test',
        rappid: FIXTURE_RAPPID,
      },
      'identity:read',
    ),
    content(
      'traits',
      {
        continuity: 1000,
        evidenceBound: 1000,
        localFirst: 1000,
      },
      'traits:read',
    ),
  ];
}

function unsignedBase(
  name: RappidCardFixtureName,
  parts: RappidCardPart[],
): Omit<RappidCardManifest, 'signature'> {
  return {
    schema: RAPPID_CARD_SCHEMA,
    profile: RAPPID_CARD_TEST_PROFILE,
    policyId: FIXTURE_POLICY_ID,
    rappid: FIXTURE_RAPPID,
    endpoint: FIXTURE_ENDPOINT,
    nonce: sha256Hex(`rappid-card-test/1:nonce:${name}`).slice(0, 32),
    issuedAt: '2035-01-01T00:00:00Z',
    expiresAt: '2035-01-02T00:00:00Z',
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
      algorithm: 'ed25519-test',
      keyId: FIXTURE_SIGNING_KEY_ID,
    },
  };
}

export function signFixtureManifest(
  manifest: Omit<RappidCardManifest, 'signature'>,
  keyId = FIXTURE_SIGNING_KEY_ID,
): RappidCardManifest {
  return signManifest(manifest, {
    algorithm: 'ed25519-test',
    keyId,
    privateKey: FIXTURE_SIGNER_SEED,
  });
}

export function signFixturePolicy(
  policy: Omit<RappidCardPolicy, 'signature'>,
): RappidCardPolicy {
  return signPolicy(policy, {
    algorithm: 'ed25519-test',
    keyId: FIXTURE_AUTHORITY_KEY_ID,
    privateKey: FIXTURE_AUTHORITY_SEED,
  });
}

export function signFixtureAuthorization(
  authorization: Omit<RappidCardAuthorization, 'signature'>,
): RappidCardAuthorization {
  return signAuthorization(authorization, {
    algorithm: 'ed25519-test',
    keyId: FIXTURE_AUTHORITY_KEY_ID,
    privateKey: FIXTURE_AUTHORITY_SEED,
  });
}

export function signFixtureRevocations(
  revocations: Omit<RappidCardRevocations, 'signature'>,
): RappidCardRevocations {
  return signRevocations(revocations, {
    algorithm: 'ed25519-test',
    keyId: FIXTURE_AUTHORITY_KEY_ID,
    privateKey: FIXTURE_AUTHORITY_SEED,
  });
}

function fixturePolicy(): RappidCardPolicy {
  return signFixturePolicy({
    schema: RAPPID_CARD_POLICY_SCHEMA,
    policyId: FIXTURE_POLICY_ID,
    sequence: 7,
    issuedAt: '2034-12-01T00:00:00Z',
    expiresAt: '2036-01-01T00:00:00Z',
    allowedProfiles: [RAPPID_CARD_TEST_PROFILE],
    protocol: RAPPID_CARD_PROTOCOL,
    runtime: {
      name: 'openrappter',
      minimum: '1.13.0',
      maximum: '1.99.0',
    },
    maxClassification: 'public',
    grantedScopes: [
      'identity:read',
      'traits:read',
      'skill:hydrate',
      'sonic:hydrate',
      'capability:hydrate',
    ],
    approvedOrigins: [FIXTURE_ORIGIN],
  });
}

function fixtureAuthorization(): RappidCardAuthorization {
  return signFixtureAuthorization({
    schema: RAPPID_CARD_AUTHORIZATION_SCHEMA,
    authorizationId: FIXTURE_AUTHORIZATION_ID,
    policyId: FIXTURE_POLICY_ID,
    sequence: 3,
    subjectRappid: FIXTURE_RAPPID,
    signerKeyId: FIXTURE_SIGNING_KEY_ID,
    signerAlgorithm: 'ed25519-test',
    signerPublicKey: FIXTURE_SIGNER_PUBLIC_KEY,
    notBefore: '2034-12-01T00:00:00Z',
    notAfter: '2036-01-01T00:00:00Z',
    maxClassification: 'public',
    grantedScopes: [
      'identity:read',
      'traits:read',
      'skill:hydrate',
      'sonic:hydrate',
      'capability:hydrate',
    ],
    approvedOrigins: [FIXTURE_ORIGIN],
  });
}

function fixtureRevocations(
  revokedManifestHashes: string[] = [],
): RappidCardRevocations {
  return signFixtureRevocations({
    schema: RAPPID_CARD_REVOCATIONS_SCHEMA,
    policyId: FIXTURE_POLICY_ID,
    sequence: 11,
    issuedAt: '2035-01-01T00:00:00Z',
    expiresAt: '2036-01-01T00:00:00Z',
    revokedManifestHashes,
    revokedSignerKeyIds: [],
    revokedAuthorizationIds: [],
  });
}

function wrongHash(hash: string): string {
  return `${hash[0] === '0' ? '1' : '0'}${hash.slice(1)}`;
}

export function buildRappidCardFixture(
  name: RappidCardFixtureName,
): RappidCardFixture {
  const definition = DESCRIPTIONS[name];
  if (!definition) throw new RangeError(`unknown RAPPID card fixture: ${name}`);
  const contents = baseContents();
  const unsigned = unsignedBase(name, contents.map((entry) => entry.part));
  let signatureKeyId = FIXTURE_SIGNING_KEY_ID;
  let includeAllContent = true;
  let challengeFails = false;
  let reconnectHash: string | null = null;

  switch (name) {
    case 'expired':
      unsigned.issuedAt = '2034-12-30T00:00:00Z';
      unsigned.expiresAt = '2034-12-31T00:00:00Z';
      break;
    case 'unknown-key':
      signatureKeyId = 'fixture-unknown-key';
      unsigned.challenge.keyId = signatureKeyId;
      break;
    case 'incompatible-runtime-protocol':
      unsigned.protocol = 'rappid-link/99';
      unsigned.runtime.minimum = '99.0.0';
      unsigned.runtime.maximum = '99.9.9';
      break;
    case 'classification-violation':
      unsigned.classification = 'internal';
      break;
    case 'insufficient-scope': {
      const extra = content(
        'skill-manifest',
        {
          actions: [],
          executable: false,
          fixture: true,
        },
        'skill:hydrate',
        'application/vnd.rapp.skill+json',
      );
      contents.push(extra);
      unsigned.parts.push(extra.part);
      break;
    }
    case 'missing-part': {
      const extra = content(
        'sonic-profile',
        {
          fixture: true,
          playback: 'none',
        },
        'sonic:hydrate',
        'application/vnd.rapp.sonic+json',
      );
      contents.push(extra);
      unsigned.parts.push(extra.part);
      unsigned.scopes.push('sonic:hydrate');
      includeAllContent = false;
      break;
    }
    case 'challenge-failure':
      challengeFails = true;
      break;
    case 'reconnect-during-hydration':
      reconnectHash = contents[0].part.hash;
      break;
    default:
      break;
  }

  const manifest = signFixtureManifest(unsigned, signatureKeyId);
  const actualHash = manifestHash(manifest);
  const linkHash = name === 'wrong-hash' ? wrongHash(actualHash) : actualHash;
  const deepLink = makeDeepLink(manifest, linkHash);
  const policy = fixturePolicy();
  const authorization = fixtureAuthorization();
  const revocations = fixtureRevocations(
    name === 'revoked' ? [actualHash] : [],
  );
  const contentMap = new Map<string, Uint8Array>();
  contents.forEach((entry, index) => {
    if (includeAllContent || index < contents.length - 1) {
      contentMap.set(entry.part.hash, entry.bytes);
    }
  });
  let reconnected = false;
  const providers: CardProviders = {
    manifests: {
      getManifest(endpoint, requestedHash) {
        if (endpoint !== FIXTURE_ENDPOINT || requestedHash !== linkHash) return null;
        return structuredClone(manifest);
      },
    },
    trust: {
      getPolicyForOrigin(origin) {
        return origin === FIXTURE_ORIGIN
          ? structuredClone(policy)
          : null;
      },
      getAuthorization(policyId, signerKeyId, subjectRappid) {
        return (
          policyId === FIXTURE_POLICY_ID
          && signerKeyId === FIXTURE_SIGNING_KEY_ID
          && subjectRappid === FIXTURE_RAPPID
        )
          ? structuredClone(authorization)
          : null;
      },
      getRevocations(policyId) {
        return policyId === FIXTURE_POLICY_ID
          ? structuredClone(revocations)
          : null;
      },
      getAuthorityKey(keyId, algorithm) {
        return (
          keyId === FIXTURE_AUTHORITY_KEY_ID
          && algorithm === 'ed25519-test'
        )
          ? FIXTURE_AUTHORITY_PUBLIC_KEY
          : null;
      },
    },
    content: {
      getPart(hash) {
        if (hash === reconnectHash && !reconnected) {
          reconnected = true;
          throw new RappidCardReconnectError();
        }
        return contentMap.get(hash) ?? null;
      },
    },
    challenge: {
      respond(request: ContinuityChallengeRequest) {
        if (challengeFails) return '0'.repeat(86);
        return challengeValue(request, FIXTURE_SIGNER_SEED);
      },
    },
  };
  const stateStore = new BoundedCardStateStore(
    undefined,
    name === 'duplicate-nonce' ? [manifest.nonce] : [],
  );
  return {
    name,
    label: definition.label,
    description: definition.description,
    transport:
      name === 'physical-payload-reproduction'
        ? 'physical-reproduction'
        : 'virtual',
    manifest,
    manifestHash: linkHash,
    deepLink,
    policy,
    authorization,
    revocations,
    expectedState: definition.expectedState,
    expectedError: definition.expectedError,
    providers,
    stateStore,
  };
}

export function listRappidCardFixtures(): Array<{
  name: RappidCardFixtureName;
  label: string;
  description: string;
  transport: RappidCardFixture['transport'];
  expectedState: CardSimulationSnapshot['state'];
  expectedError: string | null;
}> {
  return RAPPID_CARD_FIXTURE_NAMES.map((name) => {
    const fixture = buildRappidCardFixture(name);
    return {
      name,
      label: fixture.label,
      description: fixture.description,
      transport: fixture.transport,
      expectedState: fixture.expectedState,
      expectedError: fixture.expectedError,
    };
  });
}

export async function simulateRappidCardFixture(
  name: RappidCardFixtureName,
  approve: boolean,
): Promise<CardSimulationSnapshot> {
  const fixture = buildRappidCardFixture(name);
  return simulateRappidCardFixtureMode(fixture.deepLink, {
    approve,
    providers: fixture.providers,
    stateStore: fixture.stateStore,
  }, RAPPID_CARD_FIXTURE_NOW);
}

export async function simulateRappidCardFixtureInput(
  fixture: RappidCardFixture,
  approve: boolean,
): Promise<CardSimulationSnapshot> {
  return simulateRappidCardFixtureMode(fixture.deepLink, {
    approve,
    providers: fixture.providers,
    stateStore: fixture.stateStore,
  }, RAPPID_CARD_FIXTURE_NOW);
}

export async function buildRappidCardVectorDocument(): Promise<{
  schema: 'rappid-card-vectors/2';
  fixtureNow: string;
  fixtures: Array<{
    name: RappidCardFixtureName;
    manifest: RappidCardManifest;
    manifestHash: string;
    deepLink: string;
    policy: RappidCardPolicy;
    authorization: RappidCardAuthorization;
    revocations: RappidCardRevocations;
    preview: CardSimulationSnapshot;
    approved: CardSimulationSnapshot;
  }>;
}> {
  const fixtures = [];
  for (const name of RAPPID_CARD_FIXTURE_NAMES) {
    const fixture = buildRappidCardFixture(name);
    fixtures.push({
      name,
      manifest: fixture.manifest,
      manifestHash: fixture.manifestHash,
      deepLink: fixture.deepLink,
      policy: fixture.policy,
      authorization: fixture.authorization,
      revocations: fixture.revocations,
      preview: await simulateRappidCardFixture(name, false),
      approved: await simulateRappidCardFixture(name, true),
    });
  }
  return {
    schema: 'rappid-card-vectors/2',
    fixtureNow: RAPPID_CARD_FIXTURE_NOW,
    fixtures,
  };
}
