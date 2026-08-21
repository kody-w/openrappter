import { sha256Hex } from '../rappids/canonical.js';
import {
  canonicalDocumentHash,
  classificationRank,
  compareSemver,
  endpointOrigin,
  manifestHash,
  parseDeepLink,
  parseManifestJson,
  validateAuthorization,
  validateManifest,
  validatePolicy,
  validateRevocations,
  verifyAuthorizationSignature,
  verifyChallenge,
  verifyManifestSignature,
  verifyPolicySignature,
  verifyRevocationsSignature,
} from './contract.js';
import {
  MAX_AUDIT_EVENTS,
  RAPPID_CARD_PRODUCTION_PROFILE,
  RAPPID_CARD_PROTOCOL,
  RAPPID_CARD_RUNTIME_NAME,
  RAPPID_CARD_RUNTIME_VERSION,
  RAPPID_CARD_TEST_PROFILE,
  RappidCardError,
  RappidCardReconnectError,
} from './types.js';
import type {
  CardAlgorithm,
  CardAuditEvent,
  CardMachineEvent,
  CardPreview,
  CardProviders,
  CardSimulationOptions,
  CardSimulationSnapshot,
  CardStateStore,
  CardTrustStateInput,
  HydratedCardPart,
  RappidCardAuthorization,
  RappidCardManifest,
  RappidCardPolicy,
  RappidCardRevocations,
} from './types.js';

interface InternalSimulationOptions {
  approve: boolean;
  providers: CardProviders;
  stateStore: CardStateStore;
  maxReconnects?: number;
}

interface VerifiedTrust {
  policy: RappidCardPolicy;
  authorization: RappidCardAuthorization;
  revocations: RappidCardRevocations;
  origin: string;
  state: CardTrustStateInput;
}

interface VerifiedPolicy {
  policy: RappidCardPolicy;
  authorityKey: string;
  origin: string;
}

export function initialCardSnapshot(): CardSimulationSnapshot {
  return {
    state: 'idle',
    outcome: 'pending',
    error: null,
    manifestHash: null,
    deepLink: null,
    preview: null,
    hydrated: [],
    audit: [],
  };
}

/** Pure state transition. Provider effects live in the simulation driver. */
export function reduceCardState(
  snapshot: CardSimulationSnapshot,
  transition: CardMachineEvent,
): CardSimulationSnapshot {
  const audit: CardAuditEvent[] = [
    ...snapshot.audit,
    {
      seq: snapshot.audit.length
        ? snapshot.audit[snapshot.audit.length - 1].seq + 1
        : 1,
      state: transition.state,
      event: transition.event,
      detail: transition.detail,
    },
  ].slice(-MAX_AUDIT_EVENTS);
  return {
    ...snapshot,
    state: transition.state,
    outcome: transition.outcome ?? snapshot.outcome,
    error: transition.error === undefined ? snapshot.error : transition.error,
    manifestHash:
      transition.manifestHash === undefined
        ? snapshot.manifestHash
        : transition.manifestHash,
    deepLink:
      transition.deepLink === undefined
        ? snapshot.deepLink
        : transition.deepLink,
    preview:
      transition.preview === undefined
        ? snapshot.preview
        : transition.preview,
    hydrated:
      transition.hydrated === undefined
        ? snapshot.hydrated
        : transition.hydrated,
    audit,
  };
}

function fail(
  snapshot: CardSimulationSnapshot,
  error: RappidCardError,
): CardSimulationSnapshot {
  return reduceCardState(snapshot, {
    state: 'failed',
    event: 'card.failed',
    detail: error.code,
    outcome: 'failed',
    error: { code: error.code, message: error.message },
  });
}

function providerError(error: unknown): RappidCardError {
  if (error instanceof RappidCardError) return error;
  return new RappidCardError(
    'provider_error',
    error instanceof Error ? error.message : String(error),
  );
}

function previewFor(
  manifest: RappidCardManifest,
  trust: VerifiedTrust,
): CardPreview {
  return {
    rappid: manifest.rappid,
    profile: manifest.profile,
    policyId: trust.policy.policyId,
    authorizationId: trust.authorization.authorizationId,
    endpoint: manifest.endpoint,
    origin: trust.origin,
    issuerKeyId: manifest.signature.keyId,
    classification: manifest.classification,
    scopes: [...manifest.scopes],
    policySequence: trust.policy.sequence,
    authorizationSequence: trust.authorization.sequence,
    revocationSequence: trust.revocations.sequence,
    parts: manifest.parts.map((part) => ({
      name: part.name,
      hash: part.hash,
      bytes: part.bytes,
      mediaType: part.mediaType,
      required: part.required,
    })),
  };
}

function assertCurrent(
  notBefore: string,
  notAfter: string,
  now: number,
  codePrefix: string,
): void {
  if (Date.parse(notBefore) > now) {
    throw new RappidCardError(
      `${codePrefix}_not_yet_valid`,
      `${codePrefix.replaceAll('_', ' ')} has not reached its validity window`,
    );
  }
  if (Date.parse(notAfter) <= now) {
    throw new RappidCardError(
      `${codePrefix}_expired`,
      `${codePrefix.replaceAll('_', ' ')} has expired`,
    );
  }
}

function assertRuntime(
  runtime: RappidCardManifest['runtime'],
  code: string,
): void {
  if (
    runtime.name !== RAPPID_CARD_RUNTIME_NAME
    || compareSemver(RAPPID_CARD_RUNTIME_VERSION, runtime.minimum) < 0
    || compareSemver(RAPPID_CARD_RUNTIME_VERSION, runtime.maximum) > 0
  ) {
    throw new RappidCardError(
      code,
      `requires ${runtime.name} ${runtime.minimum}..${runtime.maximum}`,
    );
  }
}

function expectedAlgorithm(allowTestProfile: boolean): CardAlgorithm {
  return allowTestProfile ? 'ed25519-test' : 'ed25519';
}

function assertProfile(
  manifest: RappidCardManifest,
  allowTestProfile: boolean,
): CardAlgorithm {
  if (!allowTestProfile && manifest.profile === RAPPID_CARD_TEST_PROFILE) {
    throw new RappidCardError(
      'test_profile_forbidden',
      'production mode refuses the test profile',
    );
  }
  const profile = allowTestProfile
    ? RAPPID_CARD_TEST_PROFILE
    : RAPPID_CARD_PRODUCTION_PROFILE;
  const algorithm = expectedAlgorithm(allowTestProfile);
  if (manifest.profile !== profile) {
    throw new RappidCardError(
      allowTestProfile ? 'fixture_profile_required' : 'profile_forbidden',
      allowTestProfile
        ? 'fixture mode accepts only the synthetic test profile'
        : 'production mode requires the production profile',
    );
  }
  if (
    manifest.signature.algorithm !== algorithm
    || manifest.challenge.algorithm !== algorithm
  ) {
    throw new RappidCardError(
      allowTestProfile
        ? 'fixture_signature_required'
        : 'test_signature_forbidden',
      allowTestProfile
        ? 'fixture mode requires Ed25519 test signatures'
        : 'production mode refuses synthetic test signatures',
    );
  }
  return algorithm;
}

async function verifiedTrust(
  manifest: RappidCardManifest,
  linkHash: string,
  providers: CardProviders,
  allowTestProfile: boolean,
  now: number,
  preflight: VerifiedPolicy,
): Promise<VerifiedTrust> {
  assertProfile(manifest, allowTestProfile);
  assertCurrent(manifest.issuedAt, manifest.expiresAt, now, 'card');
  if (manifest.protocol !== RAPPID_CARD_PROTOCOL) {
    throw new RappidCardError(
      'incompatible_protocol',
      `card requires ${manifest.protocol}; runtime provides ${RAPPID_CARD_PROTOCOL}`,
    );
  }
  assertRuntime(manifest.runtime, 'incompatible_runtime');
  const { policy, authorityKey, origin } = preflight;
  if (policy.policyId !== manifest.policyId) {
    throw new RappidCardError('policy_mismatch', 'signed policy id does not match the card');
  }
  if (!policy.allowedProfiles.includes(manifest.profile)) {
    throw new RappidCardError(
      'profile_forbidden',
      'signed habitat policy does not allow this card profile',
    );
  }
  if (policy.protocol !== manifest.protocol) {
    throw new RappidCardError(
      'policy_protocol_mismatch',
      'signed habitat policy does not authorize this protocol',
    );
  }

  const rawAuthorization = await providers.trust.getAuthorization(
    manifest.policyId,
    manifest.signature.keyId,
    manifest.rappid,
  );
  if (rawAuthorization === null || rawAuthorization === undefined) {
    throw new RappidCardError(
      'unknown_key',
      `no signed authorization binds ${manifest.signature.keyId} to ${manifest.rappid}`,
    );
  }
  const authorization = validateAuthorization(rawAuthorization);
  if (
    authorization.signature.keyId !== policy.signature.keyId
    || authorization.signature.algorithm !== policy.signature.algorithm
    || !verifyAuthorizationSignature(authorization, authorityKey)
  ) {
    throw new RappidCardError(
      'authorization_signature_invalid',
      'signer authorization verification failed',
    );
  }
  if (
    authorization.policyId !== policy.policyId
    || authorization.subjectRappid !== manifest.rappid
    || authorization.signerKeyId !== manifest.signature.keyId
    || authorization.signerAlgorithm !== manifest.signature.algorithm
  ) {
    throw new RappidCardError(
      'signer_subject_unauthorized',
      'signed authorization does not bind this signer to this RAPPID',
    );
  }
  assertCurrent(
    authorization.notBefore,
    authorization.notAfter,
    now,
    'authorization',
  );
  if (!authorization.approvedOrigins.includes(origin)) {
    throw new RappidCardError(
      'signer_origin_unauthorized',
      `signer authorization does not permit endpoint origin ${origin}`,
    );
  }
  if (!verifyManifestSignature(manifest, authorization.signerPublicKey)) {
    throw new RappidCardError(
      'signature_invalid',
      'card signature verification failed',
    );
  }

  if (
    classificationRank(manifest.classification)
      > classificationRank(policy.maxClassification)
    || classificationRank(manifest.classification)
      > classificationRank(authorization.maxClassification)
  ) {
    throw new RappidCardError(
      'classification_violation',
      `card classification ${manifest.classification} exceeds signed authority`,
    );
  }
  const policyScopes = new Set(policy.grantedScopes);
  const authorizationScopes = new Set(authorization.grantedScopes);
  for (const part of manifest.parts) {
    if (
      classificationRank(part.classification)
        > classificationRank(manifest.classification)
      || classificationRank(part.classification)
        > classificationRank(policy.maxClassification)
      || classificationRank(part.classification)
        > classificationRank(authorization.maxClassification)
    ) {
      throw new RappidCardError(
        'classification_violation',
        `part ${part.name} exceeds the permitted classification`,
      );
    }
    if (
      !manifest.scopes.includes(part.scope)
      || !policyScopes.has(part.scope)
      || !authorizationScopes.has(part.scope)
    ) {
      throw new RappidCardError(
        'insufficient_scope',
        `part ${part.name} requires ${part.scope}`,
      );
    }
  }

  const rawRevocations = await providers.trust.getRevocations(policy.policyId);
  if (rawRevocations === null || rawRevocations === undefined) {
    throw new RappidCardError(
      'revocation_view_missing',
      'signed revocation view is unavailable',
    );
  }
  const revocations = validateRevocations(rawRevocations);
  if (
    revocations.policyId !== policy.policyId
    || revocations.signature.keyId !== policy.signature.keyId
    || revocations.signature.algorithm !== policy.signature.algorithm
    || !verifyRevocationsSignature(revocations, authorityKey)
  ) {
    throw new RappidCardError(
      'revocation_signature_invalid',
      'signed revocation view verification failed',
    );
  }
  assertCurrent(
    revocations.issuedAt,
    revocations.expiresAt,
    now,
    'revocation_view',
  );
  if (
    revocations.revokedManifestHashes.includes(linkHash)
    || revocations.revokedSignerKeyIds.includes(manifest.signature.keyId)
    || revocations.revokedAuthorizationIds.includes(
      authorization.authorizationId,
    )
  ) {
    throw new RappidCardError(
      'revoked',
      'card, signer, or signer authorization is revoked',
    );
  }
  return {
    policy,
    authorization,
    revocations,
    origin,
    state: {
      policyId: policy.policyId,
      policySequence: policy.sequence,
      policyHash: canonicalDocumentHash(policy),
      authorizationId: authorization.authorizationId,
      authorizationSequence: authorization.sequence,
      authorizationHash: canonicalDocumentHash(authorization),
      revocationSequence: revocations.sequence,
      revocationHash: canonicalDocumentHash(revocations),
      nonce: manifest.nonce,
      manifestHash: linkHash,
    },
  };
}

async function verifiedPolicyForEndpoint(
  endpoint: string,
  providers: CardProviders,
  stateStore: CardStateStore,
  allowTestProfile: boolean,
  now: number,
): Promise<VerifiedPolicy> {
  const algorithm = expectedAlgorithm(allowTestProfile);
  const origin = endpointOrigin(endpoint);
  const rawPolicy = await providers.trust.getPolicyForOrigin(origin);
  if (rawPolicy === null || rawPolicy === undefined) {
    throw new RappidCardError(
      'policy_not_found',
      `no signed habitat policy is configured for endpoint origin ${origin}`,
    );
  }
  const policy = validatePolicy(rawPolicy);
  if (policy.signature.algorithm !== algorithm) {
    throw new RappidCardError(
      !allowTestProfile && policy.signature.algorithm === 'ed25519-test'
        ? 'test_signature_forbidden'
        : 'policy_signature_invalid',
      !allowTestProfile && policy.signature.algorithm === 'ed25519-test'
        ? 'production mode refuses synthetic test signatures'
        : 'signed policy uses the wrong trust profile',
    );
  }
  const authorityKey = await providers.trust.getAuthorityKey(
    policy.signature.keyId,
    policy.signature.algorithm,
  );
  if (authorityKey === null) {
    throw new RappidCardError(
      'unknown_authority',
      `policy authority ${policy.signature.keyId} is unknown`,
    );
  }
  if (!verifyPolicySignature(policy, authorityKey)) {
    throw new RappidCardError(
      'policy_signature_invalid',
      'signed habitat policy verification failed',
    );
  }
  assertCurrent(policy.issuedAt, policy.expiresAt, now, 'policy');
  if (policy.protocol !== RAPPID_CARD_PROTOCOL) {
    throw new RappidCardError(
      'policy_protocol_mismatch',
      'signed habitat policy does not authorize this protocol',
    );
  }
  assertRuntime(policy.runtime, 'policy_runtime_mismatch');
  if (!policy.approvedOrigins.includes(origin)) {
    throw new RappidCardError(
      'origin_not_approved',
      `endpoint origin ${origin} is not approved by signed policy`,
    );
  }
  await stateStore.recordPolicy(
    policy.policyId,
    policy.sequence,
    canonicalDocumentHash(policy),
  );
  return { policy, authorityKey, origin };
}

async function hydratePart(
  manifest: RappidCardManifest,
  index: number,
  options: InternalSimulationOptions,
  onReconnect: () => void,
): Promise<HydratedCardPart | null> {
  const part = manifest.parts[index];
  const maximumReconnects = options.maxReconnects ?? 1;
  let reconnects = 0;
  for (;;) {
    try {
      const content = await options.providers.content.getPart(part.hash);
      if (content === null) {
        if (!part.required) return null;
        throw new RappidCardError(
          'missing_part',
          `required part ${part.name} is unavailable`,
        );
      }
      if (content.byteLength !== part.bytes) {
        throw new RappidCardError(
          'part_size_mismatch',
          `part ${part.name} does not match its declared byte count`,
        );
      }
      if (sha256Hex(content) !== part.hash) {
        throw new RappidCardError(
          'part_hash_mismatch',
          `part ${part.name} does not match its content address`,
        );
      }
      return {
        name: part.name,
        hash: part.hash,
        bytes: part.bytes,
        mediaType: part.mediaType,
      };
    } catch (error) {
      if (
        error instanceof RappidCardReconnectError
        && reconnects < maximumReconnects
      ) {
        reconnects += 1;
        onReconnect();
        continue;
      }
      throw error;
    }
  }
}

async function simulateInternal(
  deepLink: string,
  options: InternalSimulationOptions,
  allowTestProfile: boolean,
  now: number,
): Promise<CardSimulationSnapshot> {
  let snapshot = initialCardSnapshot();
  try {
    const link = parseDeepLink(deepLink);
    snapshot = reduceCardState(snapshot, {
      state: 'parsed',
      event: 'link.parsed',
      detail: link.endpoint,
      manifestHash: link.manifestHash,
      deepLink: link.deepLink,
    });
    const preflight = await verifiedPolicyForEndpoint(
      link.endpoint,
      options.providers,
      options.stateStore,
      allowTestProfile,
      now,
    );
    const raw = await options.providers.manifests.getManifest(
      link.endpoint,
      link.manifestHash,
    );
    if (raw === null || raw === undefined) {
      throw new RappidCardError(
        'manifest_not_found',
        'manifest provider returned no card',
      );
    }
    const manifest =
      typeof raw === 'string'
        ? parseManifestJson(raw)
        : validateManifest(raw);
    if (manifestHash(manifest) !== link.manifestHash) {
      throw new RappidCardError(
        'manifest_hash_mismatch',
        'manifest hash does not match deep link',
      );
    }
    if (
      manifest.rappid !== link.rappid
      || manifest.endpoint !== link.endpoint
      || manifest.nonce !== link.nonce
    ) {
      throw new RappidCardError(
        'link_manifest_mismatch',
        'manifest identity, endpoint, or nonce does not match deep link',
      );
    }
    const trust = await verifiedTrust(
      manifest,
      link.manifestHash,
      options.providers,
      allowTestProfile,
      now,
      preflight,
    );
    await options.stateStore.record(trust.state, false);
    snapshot = reduceCardState(snapshot, {
      state: 'verified',
      event: 'card.verified',
      detail: trust.authorization.authorizationId,
    });
    snapshot = reduceCardState(snapshot, {
      state: 'preview',
      event: 'preview.ready',
      detail: `${manifest.parts.length} content-addressed parts`,
      preview: previewFor(manifest, trust),
    });
    if (!options.approve) return snapshot;

    snapshot = reduceCardState(snapshot, {
      state: 'approved',
      event: 'approval.explicit',
      detail: 'developer approved hydration',
    });
    await options.stateStore.record(trust.state, true);
    snapshot = reduceCardState(snapshot, {
      state: 'hydrating',
      event: 'hydration.started',
      detail: `${manifest.parts.length} permitted parts`,
    });
    const hydrated: HydratedCardPart[] = [];
    for (let index = 0; index < manifest.parts.length; index += 1) {
      const part = await hydratePart(manifest, index, options, () => {
        snapshot = reduceCardState(snapshot, {
          state: 'hydrating',
          event: 'hydration.reconnected',
          detail: manifest.parts[index].name,
        });
      });
      if (part !== null) hydrated.push(part);
      snapshot = reduceCardState(snapshot, {
        state: 'hydrating',
        event: 'part.hydrated',
        detail: manifest.parts[index].name,
        hydrated: [...hydrated],
      });
    }
    snapshot = reduceCardState(snapshot, {
      state: 'challenging',
      event: 'challenge.started',
      detail: manifest.challenge.keyId,
    });
    const request = {
      algorithm: manifest.challenge.algorithm,
      keyId: manifest.challenge.keyId,
      manifestHash: link.manifestHash,
      nonce: manifest.nonce,
      partHashes: hydrated.map((part) => part.hash),
    };
    const response = await options.providers.challenge.respond(request);
    if (
      !verifyChallenge(
        response,
        request,
        trust.authorization.signerPublicKey,
      )
    ) {
      throw new RappidCardError(
        'challenge_failed',
        'continuity challenge verification failed',
      );
    }
    return reduceCardState(snapshot, {
      state: 'awake',
      event: 'card.awake',
      detail: `${hydrated.length} verified parts`,
      outcome: 'awake',
      error: null,
    });
  } catch (error) {
    return fail(snapshot, providerError(error));
  }
}

export async function simulateRappidCard(
  deepLink: string,
  options: CardSimulationOptions,
): Promise<CardSimulationSnapshot> {
  const { SqliteCardStateStore } = await import('./sqlite-state-store.js');
  if (!(options.stateStore instanceof SqliteCardStateStore)) {
    return fail(
      initialCardSnapshot(),
      new RappidCardError(
        'durable_state_required',
        'production mode requires the transactional SQLite card state store',
      ),
    );
  }
  return simulateInternal(deepLink, options, false, Date.now());
}

/** Test-profile entry point. Production callers must use `simulateRappidCard`. */
export async function simulateRappidCardFixtureMode(
  deepLink: string,
  options: InternalSimulationOptions,
  fixtureNow = '2035-01-01T12:00:00Z',
): Promise<CardSimulationSnapshot> {
  return simulateInternal(
    deepLink,
    options,
    true,
    Date.parse(fixtureNow),
  );
}
