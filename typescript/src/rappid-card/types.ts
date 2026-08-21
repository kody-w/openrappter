export const RAPPID_CARD_SCHEMA = 'rappid-card/1' as const;
export const RAPPID_CARD_TEST_PROFILE = 'rappid-card-test/1' as const;
export const RAPPID_CARD_PRODUCTION_PROFILE = 'rappid-card-production/1' as const;
export const RAPPID_CARD_PROTOCOL = 'rappid-link/1' as const;
export const RAPPID_CARD_FILENAME = '.rappid-card.json' as const;
export const MAX_AUDIT_EVENTS = 64;
export const MAX_REPLAY_NONCES = 128;

export type CardProfile =
  | typeof RAPPID_CARD_TEST_PROFILE
  | typeof RAPPID_CARD_PRODUCTION_PROFILE;
export type CardMode = 'fixture' | 'production';
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
export type CardAlgorithm = 'hmac-sha256-test' | 'hmac-sha256';

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

export interface ParsedRappidCardLink {
  rappid: string;
  manifestHash: string;
  endpoint: string;
  nonce: string;
  deepLink: string;
}

export interface CardPolicy {
  mode: CardMode;
  now: string;
  runtimeName: string;
  runtimeVersion: string;
  protocol: string;
  maxClassification: CardClassification;
  grantedScopes: CardScope[];
}

export interface CardManifestProvider {
  getManifest(
    endpoint: string,
    manifestHash: string,
  ): Promise<unknown> | unknown;
}

export interface CardKeyProvider {
  getKey(keyId: string, algorithm: CardAlgorithm): Promise<Uint8Array | null> | Uint8Array | null;
}

export interface CardRevocationProvider {
  isRevoked(
    manifestHash: string,
    keyId: string,
  ): Promise<boolean> | boolean;
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
  keys: CardKeyProvider;
  revocations: CardRevocationProvider;
  content: CardContentProvider;
  challenge: CardChallengeProvider;
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
  endpoint: string;
  issuerKeyId: string;
  classification: CardClassification;
  scopes: CardScope[];
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
  policy: CardPolicy;
  providers: CardProviders;
  replayCache?: ReplayCache;
  maxReconnects?: number;
}

export interface ReplayCache {
  has(nonce: string): boolean;
  add(nonce: string): void;
  values(): string[];
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
