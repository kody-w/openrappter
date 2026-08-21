import { sha256Hex } from '../rappids/canonical.js';
import {
  classificationRank,
  compareSemver,
  manifestHash,
  parseDeepLink,
  parseManifestJson,
  validateManifest,
  verifyChallenge,
  verifySignature,
} from './contract.js';
import { BoundedReplayCache } from './replay-cache.js';
import {
  MAX_AUDIT_EVENTS,
  RAPPID_CARD_PRODUCTION_PROFILE,
  RAPPID_CARD_TEST_PROFILE,
  RappidCardError,
  RappidCardReconnectError,
} from './types.js';
import type {
  CardAuditEvent,
  CardMachineEvent,
  CardPreview,
  CardSimulationOptions,
  CardSimulationSnapshot,
  HydratedCardPart,
  RappidCardManifest,
} from './types.js';

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

/** Pure state transition. Provider effects live in `simulateRappidCard`. */
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

function previewFor(manifest: RappidCardManifest): CardPreview {
  return {
    rappid: manifest.rappid,
    profile: manifest.profile,
    endpoint: manifest.endpoint,
    issuerKeyId: manifest.signature.keyId,
    classification: manifest.classification,
    scopes: [...manifest.scopes],
    parts: manifest.parts.map((part) => ({
      name: part.name,
      hash: part.hash,
      bytes: part.bytes,
      mediaType: part.mediaType,
      required: part.required,
    })),
  };
}

function verifyMode(manifest: RappidCardManifest, mode: CardSimulationOptions['policy']['mode']): void {
  if (mode === 'production') {
    if (manifest.profile === RAPPID_CARD_TEST_PROFILE) {
      throw new RappidCardError(
        'test_profile_forbidden',
        'production mode refuses the test profile',
      );
    }
    if (
      manifest.signature.algorithm === 'hmac-sha256-test'
      || manifest.challenge.algorithm === 'hmac-sha256-test'
    ) {
      throw new RappidCardError(
        'test_signature_forbidden',
        'production mode refuses synthetic test authenticators',
      );
    }
    if (manifest.profile !== RAPPID_CARD_PRODUCTION_PROFILE) {
      throw new RappidCardError(
        'profile_forbidden',
        'production mode requires the production profile',
      );
    }
    return;
  }
  if (
    manifest.profile !== RAPPID_CARD_TEST_PROFILE
    || manifest.signature.algorithm !== 'hmac-sha256-test'
    || manifest.challenge.algorithm !== 'hmac-sha256-test'
  ) {
    throw new RappidCardError(
      'fixture_profile_required',
      'fixture mode accepts only the synthetic test profile and authenticators',
    );
  }
}

function verifyPolicy(
  manifest: RappidCardManifest,
  options: CardSimulationOptions,
): void {
  const policy = options.policy;
  verifyMode(manifest, policy.mode);
  const now = Date.parse(policy.now);
  if (Number.isNaN(now)) {
    throw new RappidCardError('policy_invalid', 'policy.now must be RFC3339');
  }
  if (Date.parse(manifest.issuedAt) > now) {
    throw new RappidCardError('not_yet_valid', 'card has not reached issuedAt');
  }
  if (Date.parse(manifest.expiresAt) <= now) {
    throw new RappidCardError('expired', 'card has expired');
  }
  if (manifest.protocol !== policy.protocol) {
    throw new RappidCardError(
      'incompatible_protocol',
      `card requires ${manifest.protocol}; runtime provides ${policy.protocol}`,
    );
  }
  if (
    manifest.runtime.name !== policy.runtimeName
    || compareSemver(policy.runtimeVersion, manifest.runtime.minimum) < 0
    || compareSemver(policy.runtimeVersion, manifest.runtime.maximum) > 0
  ) {
    throw new RappidCardError(
      'incompatible_runtime',
      `card requires ${manifest.runtime.name} ${manifest.runtime.minimum}..${manifest.runtime.maximum}`,
    );
  }
  if (
    classificationRank(manifest.classification)
    > classificationRank(policy.maxClassification)
  ) {
    throw new RappidCardError(
      'classification_violation',
      `card classification ${manifest.classification} exceeds ${policy.maxClassification}`,
    );
  }
  const granted = new Set(policy.grantedScopes);
  for (const part of manifest.parts) {
    if (
      classificationRank(part.classification)
      > classificationRank(manifest.classification)
      || classificationRank(part.classification)
      > classificationRank(policy.maxClassification)
    ) {
      throw new RappidCardError(
        'classification_violation',
        `part ${part.name} exceeds the permitted classification`,
      );
    }
    if (!manifest.scopes.includes(part.scope) || !granted.has(part.scope)) {
      throw new RappidCardError(
        'insufficient_scope',
        `part ${part.name} requires ${part.scope}`,
      );
    }
  }
}

async function hydratePart(
  manifest: RappidCardManifest,
  index: number,
  options: CardSimulationOptions,
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

export async function simulateRappidCard(
  deepLink: string,
  options: CardSimulationOptions,
): Promise<CardSimulationSnapshot> {
  let snapshot = initialCardSnapshot();
  const replay = options.replayCache ?? new BoundedReplayCache();
  try {
    const link = parseDeepLink(deepLink);
    snapshot = reduceCardState(snapshot, {
      state: 'parsed',
      event: 'link.parsed',
      detail: link.endpoint,
      manifestHash: link.manifestHash,
      deepLink: link.deepLink,
    });

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
    verifyPolicy(manifest, options);
    if (
      await options.providers.revocations.isRevoked(
        link.manifestHash,
        manifest.signature.keyId,
      )
    ) {
      throw new RappidCardError('revoked', 'card or signing key is revoked');
    }
    const signatureKey = await options.providers.keys.getKey(
      manifest.signature.keyId,
      manifest.signature.algorithm,
    );
    if (signatureKey === null) {
      throw new RappidCardError(
        'unknown_key',
        `signing key ${manifest.signature.keyId} is unknown`,
      );
    }
    if (!verifySignature(manifest, signatureKey)) {
      throw new RappidCardError(
        'signature_invalid',
        'card signature verification failed',
      );
    }
    if (replay.has(manifest.nonce)) {
      throw new RappidCardError(
        'duplicate_nonce',
        'card nonce has already been accepted',
      );
    }
    snapshot = reduceCardState(snapshot, {
      state: 'verified',
      event: 'card.verified',
      detail: manifest.signature.keyId,
    });
    snapshot = reduceCardState(snapshot, {
      state: 'preview',
      event: 'preview.ready',
      detail: `${manifest.parts.length} content-addressed parts`,
      preview: previewFor(manifest),
    });
    if (!options.approve) return snapshot;

    snapshot = reduceCardState(snapshot, {
      state: 'approved',
      event: 'approval.explicit',
      detail: 'developer approved hydration',
    });
    if (replay.has(manifest.nonce)) {
      throw new RappidCardError(
        'duplicate_nonce',
        'card nonce has already been accepted',
      );
    }
    replay.add(manifest.nonce);
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
    const challengeKey = await options.providers.keys.getKey(
      manifest.challenge.keyId,
      manifest.challenge.algorithm,
    );
    if (challengeKey === null) {
      throw new RappidCardError(
        'unknown_challenge_key',
        `challenge key ${manifest.challenge.keyId} is unknown`,
      );
    }
    const request = {
      algorithm: manifest.challenge.algorithm,
      keyId: manifest.challenge.keyId,
      manifestHash: link.manifestHash,
      nonce: manifest.nonce,
      partHashes: hydrated.map((part) => part.hash),
    };
    const response = await options.providers.challenge.respond(request);
    if (!verifyChallenge(response, request, challengeKey)) {
      throw new RappidCardError(
        'challenge_failed',
        'continuity challenge verification failed',
      );
    }
    snapshot = reduceCardState(snapshot, {
      state: 'awake',
      event: 'card.awake',
      detail: `${hydrated.length} verified parts`,
      outcome: 'awake',
      error: null,
    });
    return snapshot;
  } catch (error) {
    return fail(snapshot, providerError(error));
  }
}
