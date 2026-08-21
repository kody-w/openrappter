import { TextEncoder } from 'node:util';

import { canonicalJson, sha256Hex } from '../rappids/canonical.js';
import type { JsonValue } from '../rappids/types.js';
import {
  challengeValue,
  makeDeepLink,
  manifestHash,
  signManifest,
} from './contract.js';
import { BoundedReplayCache } from './replay-cache.js';
import { simulateRappidCard } from './simulator.js';
import {
  RAPPID_CARD_PROTOCOL,
  RAPPID_CARD_SCHEMA,
  RAPPID_CARD_TEST_PROFILE,
  RappidCardReconnectError,
} from './types.js';
import type {
  CardPolicy,
  CardProviders,
  CardScope,
  CardSimulationSnapshot,
  ContinuityChallengeRequest,
  RappidCardManifest,
  RappidCardPart,
} from './types.js';

export const RAPPID_CARD_FIXTURE_NOW = '2035-01-01T12:00:00Z';
export const FIXTURE_ENDPOINT = 'fixture-habitat';
export const FIXTURE_SIGNING_KEY_ID = 'fixture-signing-1';
export const FIXTURE_CHALLENGE_KEY_ID = 'fixture-continuity-1';

const encoder = new TextEncoder();
const FIXTURE_SIGNING_KEY = Buffer.from(
  sha256Hex('rappid-card-test/1:synthetic-signing-key'),
  'hex',
);
const FIXTURE_CHALLENGE_KEY = Buffer.from(
  sha256Hex('rappid-card-test/1:synthetic-continuity-key'),
  'hex',
);
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
  expectedState: CardSimulationSnapshot['state'];
  expectedError: string | null;
  policy: CardPolicy;
  providers: CardProviders;
  replayCache: BoundedReplayCache;
}

const DESCRIPTIONS: Record<
  RappidCardFixtureName,
  { label: string; description: string; expectedState: CardSimulationSnapshot['state']; expectedError: string | null }
> = {
  valid: {
    label: 'Valid card',
    description: 'Signed, current, permitted, content-addressed, and challenge-complete.',
    expectedState: 'awake',
    expectedError: null,
  },
  expired: {
    label: 'Expired card',
    description: 'A correctly signed card whose expiry is in the past.',
    expectedState: 'failed',
    expectedError: 'expired',
  },
  revoked: {
    label: 'Revoked card',
    description: 'A correctly signed card rejected by the injected revocation provider.',
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
    description: 'The manifest names a key the injected key provider does not know.',
    expectedState: 'failed',
    expectedError: 'unknown_key',
  },
  'incompatible-runtime-protocol': {
    label: 'Incompatible runtime / protocol',
    description: 'A signed card that requires a future link protocol and runtime.',
    expectedState: 'failed',
    expectedError: 'incompatible_protocol',
  },
  'classification-violation': {
    label: 'Classification violation',
    description: 'A signed internal card presented to a public-only simulator.',
    expectedState: 'failed',
    expectedError: 'classification_violation',
  },
  'insufficient-scope': {
    label: 'Insufficient scope',
    description: 'A required part asks for a scope absent from the manifest grant.',
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
    description: 'All parts hydrate, but the injected challenge response is invalid.',
    expectedState: 'failed',
    expectedError: 'challenge_failed',
  },
  'reconnect-during-hydration': {
    label: 'Reconnect during hydration',
    description: 'The provider reconnects once; the verified state resumes without re-authorizing.',
    expectedState: 'awake',
    expectedError: null,
  },
  'duplicate-nonce': {
    label: 'Duplicate nonce',
    description: 'The bounded replay cache already contains the signed nonce.',
    expectedState: 'failed',
    expectedError: 'duplicate_nonce',
  },
  'physical-payload-reproduction': {
    label: 'Physical payload reproduction',
    description: 'The exact compact link is rendered as QR and re-entered without changing bytes.',
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
      algorithm: 'hmac-sha256-test',
      keyId: FIXTURE_CHALLENGE_KEY_ID,
    },
  };
}

function fixturePolicy(): CardPolicy {
  return {
    mode: 'fixture',
    now: RAPPID_CARD_FIXTURE_NOW,
    runtimeName: 'openrappter',
    runtimeVersion: '1.13.0',
    protocol: RAPPID_CARD_PROTOCOL,
    maxClassification: 'public',
    grantedScopes: [
      'identity:read',
      'traits:read',
      'skill:hydrate',
      'sonic:hydrate',
      'capability:hydrate',
    ],
  };
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

  const manifest = signManifest(unsigned, {
    algorithm: 'hmac-sha256-test',
    keyId: signatureKeyId,
    key: FIXTURE_SIGNING_KEY,
  });
  const actualHash = manifestHash(manifest);
  const linkHash = name === 'wrong-hash' ? wrongHash(actualHash) : actualHash;
  const deepLink = makeDeepLink(manifest, linkHash);
  const contentMap = new Map<string, Uint8Array>();
  contents.forEach((entry, index) => {
    if (includeAllContent || index < contents.length - 1) {
      contentMap.set(entry.part.hash, entry.bytes);
    }
  });
  const keyMap = new Map<string, Uint8Array>([
    [FIXTURE_SIGNING_KEY_ID, FIXTURE_SIGNING_KEY],
    [FIXTURE_CHALLENGE_KEY_ID, FIXTURE_CHALLENGE_KEY],
  ]);
  const revoked = new Set(
    name === 'revoked' ? [actualHash] : [],
  );
  let reconnected = false;
  const providers: CardProviders = {
    manifests: {
      getManifest(endpoint, requestedHash) {
        if (endpoint !== FIXTURE_ENDPOINT || requestedHash !== linkHash) return null;
        return structuredClone(manifest);
      },
    },
    keys: {
      getKey(keyId) {
        return keyMap.get(keyId) ?? null;
      },
    },
    revocations: {
      isRevoked(requestedHash) {
        return revoked.has(requestedHash);
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
        if (challengeFails) return '0'.repeat(64);
        return challengeValue(request, FIXTURE_CHALLENGE_KEY);
      },
    },
  };
  const replayCache = new BoundedReplayCache(
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
    expectedState: definition.expectedState,
    expectedError: definition.expectedError,
    policy: fixturePolicy(),
    providers,
    replayCache,
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
  return simulateRappidCard(fixture.deepLink, {
    approve,
    policy: fixture.policy,
    providers: fixture.providers,
    replayCache: fixture.replayCache,
  });
}

export async function buildRappidCardVectorDocument(): Promise<{
  schema: 'rappid-card-vectors/1';
  fixtureNow: string;
  fixtures: Array<{
    name: RappidCardFixtureName;
    manifest: RappidCardManifest;
    manifestHash: string;
    deepLink: string;
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
      preview: await simulateRappidCardFixture(name, false),
      approved: await simulateRappidCardFixture(name, true),
    });
  }
  return {
    schema: 'rappid-card-vectors/1',
    fixtureNow: RAPPID_CARD_FIXTURE_NOW,
    fixtures,
  };
}
