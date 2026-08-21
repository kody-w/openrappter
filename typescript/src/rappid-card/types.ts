export const RAPPID_CARD_SCHEMA = 'rappid-card/1' as const;
export const RAPPID_CARD_POLICY_SCHEMA = 'rappid-card-policy/1' as const;
export const RAPPID_CARD_AUTHORIZATION_SCHEMA = 'rappid-card-authorization/1' as const;
export const RAPPID_CARD_REVOCATIONS_SCHEMA = 'rappid-card-revocations/1' as const;
export const RAPPID_CARD_TEST_PROFILE = 'rappid-card-test/1' as const;
export const RAPPID_CARD_PRODUCTION_PROFILE = 'rappid-card-production/1' as const;
export const RAPPID_CARD_PROTOCOL = 'rappid-link/1' as const;
export const RAPPID_CARD_RUNTIME_NAME = 'openrappter' as const;
export const RAPPID_CARD_RUNTIME_VERSION = '1.13.0' as const;
export const RAPPID_CARD_FILENAME = '.rappid-card.json' as const;
export const MAX_AUDIT_EVENTS = 64;
export const MAX_REPLAY_NONCES = 128;

export type CardProfile =
  | typeof RAPPID_CARD_TEST_PROFILE
  | typeof RAPPID_CARD_PRODUCTION_PROFILE;
export type CardClassification = 'public' | 'internal' | 'restricted';
export type CardScope =
  | 'identity:read'
  | 'traits:read'
  | 'skill:hydrate'
  | 'sonic:hydrate'
  | 'capability:hydrate';
export type CardPartName =
  | 'identity'
  | 'traits'
  | 'skill-manifest'
  | 'sonic-profile'
  | 'capability-manifest';
export type CardMediaType =
  | 'application/json'
  | 'text/plain'
  | 'application/vnd.rapp.skill+json'
  | 'application/vnd.rapp.sonic+json'
  | 'application/vnd.rapp.capability+json';
export type CardAlgorithm = 'ed25519-test' | 'ed25519';

export interface RappidCardPart {
  name: CardPartName;
  hash: string;
  bytes: number;
  mediaType: CardMediaType;
  classification: CardClassification;
  scope: CardScope;
  required: boolean;
}

export interface RappidCardAuthenticator {
  algorithm: CardAlgorithm;
  keyId: string;
}

export interface RappidCardSignature extends RappidCardAuthenticator {
  value: string;
}

export interface RappidCardManifest {
  schema: typeof RAPPID_CARD_SCHEMA;
  profile: CardProfile;
  policyId: string;
  rappid: string;
  endpoint: string;
  nonce: string;
  issuedAt: string;
  expiresAt: string;
  protocol: string;
  runtime: {
    name: string;
    minimum: string;
    maximum: string;
  };
  classification: CardClassification;
  scopes: CardScope[];
  parts: RappidCardPart[];
  challenge: RappidCardAuthenticator;
  signature: RappidCardSignature;
}

export interface RappidCardPolicy {
  schema: typeof RAPPID_CARD_POLICY_SCHEMA;
  policyId: string;
  sequence: number;
  issuedAt: string;
  expiresAt: string;
  allowedProfiles: CardProfile[];
  protocol: string;
  runtime: {
    name: string;
    minimum: string;
    maximum: string;
  };
  maxClassification: CardClassification;
  grantedScopes: CardScope[];
  approvedOrigins: string[];
  signature: RappidCardSignature;
}

export interface RappidCardAuthorization {
  schema: typeof RAPPID_CARD_AUTHORIZATION_SCHEMA;
  authorizationId: string;
  policyId: string;
  sequence: number;
  subjectRappid: string;
  signerKeyId: string;
  signerAlgorithm: CardAlgorithm;
  signerPublicKey: string;
  notBefore: string;
  notAfter: string;
  maxClassification: CardClassification;
  grantedScopes: CardScope[];
  approvedOrigins: string[];
  signature: RappidCardSignature;
}

export interface RappidCardRevocations {
  schema: typeof RAPPID_CARD_REVOCATIONS_SCHEMA;
  policyId: string;
  sequence: number;
  issuedAt: string;
  expiresAt: string;
  revokedManifestHashes: string[];
  revokedSignerKeyIds: string[];
  revokedAuthorizationIds: string[];
  signature: RappidCardSignature;
}

export interface ParsedRappidCardLink {
  rappid: string;
  manifestHash: string;
  endpoint: string;
  nonce: string;
  deepLink: string;
}

export interface CardManifestProvider {
  getManifest(
    endpoint: string,
    manifestHash: string,
  ): Promise<unknown> | unknown;
}

export interface CardTrustProvider {
  getPolicyForOrigin(origin: string): Promise<unknown> | unknown;
  getAuthorization(
    policyId: string,
    signerKeyId: string,
    subjectRappid: string,
  ): Promise<unknown> | unknown;
  getRevocations(policyId: string): Promise<unknown> | unknown;
  getAuthorityKey(
    keyId: string,
    algorithm: CardAlgorithm,
  ): Promise<string | null> | string | null;
}

export interface CardContentProvider {
  getPart(hash: string): Promise<Uint8Array | null> | Uint8Array | null;
}

export interface ContinuityChallengeRequest {
  algorithm: CardAlgorithm;
  keyId: string;
  manifestHash: string;
  nonce: string;
  partHashes: string[];
}

export interface CardChallengeProvider {
  respond(
    request: ContinuityChallengeRequest,
  ): Promise<string> | string;
}

export interface CardProviders {
  manifests: CardManifestProvider;
  trust: CardTrustProvider;
  content: CardContentProvider;
  challenge: CardChallengeProvider;
}

export interface CardTrustStateInput {
  policyId: string;
  policySequence: number;
  policyHash: string;
  authorizationId: string;
  authorizationSequence: number;
  authorizationHash: string;
  revocationSequence: number;
  revocationHash: string;
  nonce: string;
  manifestHash: string;
}

export abstract class CardStateStore {
  abstract recordPolicy(
    policyId: string,
    sequence: number,
    documentHash: string,
  ): Promise<void> | void;

  abstract record(
    input: CardTrustStateInput,
    claimNonce: boolean,
  ): Promise<void> | void;
}

export abstract class DurableCardStateStore extends CardStateStore {
  readonly #durableCardStateStore = true;

  protected assertDurableBrand(): void {
    if (!this.#durableCardStateStore) throw new Error('unreachable');
  }

  abstract close(): Promise<void> | void;
}

export type CardState =
  | 'idle'
  | 'parsed'
  | 'verified'
  | 'preview'
  | 'approved'
  | 'hydrating'
  | 'challenging'
  | 'awake'
  | 'failed';

export interface CardAuditEvent {
  seq: number;
  state: CardState;
  event: string;
  detail: string;
}

export interface CardPreview {
  rappid: string;
  profile: CardProfile;
  policyId: string;
  authorizationId: string;
  endpoint: string;
  origin: string;
  issuerKeyId: string;
  classification: CardClassification;
  scopes: CardScope[];
  policySequence: number;
  authorizationSequence: number;
  revocationSequence: number;
  parts: Array<{
    name: CardPartName;
    hash: string;
    bytes: number;
    mediaType: CardMediaType;
    required: boolean;
  }>;
}

export interface HydratedCardPart {
  name: CardPartName;
  hash: string;
  bytes: number;
  mediaType: CardMediaType;
}

export interface CardFailure {
  code: string;
  message: string;
}

export interface CardMachineEvent {
  state: CardState;
  event: string;
  detail: string;
  outcome?: CardSimulationSnapshot['outcome'];
  error?: CardFailure | null;
  manifestHash?: string | null;
  deepLink?: string | null;
  preview?: CardPreview | null;
  hydrated?: HydratedCardPart[];
}

export interface CardSimulationSnapshot {
  state: CardState;
  outcome: 'pending' | 'awake' | 'failed';
  error: CardFailure | null;
  manifestHash: string | null;
  deepLink: string | null;
  preview: CardPreview | null;
  hydrated: HydratedCardPart[];
  audit: CardAuditEvent[];
}

export interface CardSimulationOptions {
  approve: boolean;
  providers: CardProviders;
  stateStore: DurableCardStateStore;
  maxReconnects?: number;
}

export class RappidCardError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'RappidCardError';
  }
}

export class RappidCardReconnectError extends Error {
  constructor(message = 'content provider reconnected during hydration') {
    super(message);
    this.name = 'RappidCardReconnectError';
  }
}
