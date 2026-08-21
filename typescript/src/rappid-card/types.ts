export const RAPP_SPEC = 'rapp/1' as const;
export const CARD_PROFILE = 'rappid-card/1' as const;
export const CARD_TEST_PROFILE = 'rappid-card-test/1' as const;
export const CARD_VIRTUAL_SUFFIX = '.rappid-card.json' as const;
export const CARD_CALLING = 'body.calling-card' as const;
export const CARD_DEBUG = 'body.debug-card' as const;
export const CARD_RUNTIME_POLICY_SCHEMA = 'rappid-card-runtime-policy/1' as const;
export const CARD_AUTHORITY_SCHEMA = 'rappid-card-authority/1' as const;
export const CARD_REVOCATION_SCHEMA = 'rappid-card-revocations/1' as const;
export const CARD_CLASSIFICATIONS = [
  'public',
  'internal',
  'confidential',
  'restricted',
] as const;
export const CARD_REQUIRED_PARTS = [
  'engram',
  'reflex-capability',
  'soul',
] as const;
export const CARD_VERIFY_STEPS = [
  'parse',
  'content-address',
  'schema',
  'signature',
  'expiry',
  'revocation',
  'compatibility',
  'classification-scope',
  'replay-nonce',
  'hydration',
  'continuity',
] as const;
export const FRAME_KEYS = [
  'frame_hash',
  'kind',
  'payload',
  'payload_hash',
  'prev',
  'prev_wave',
  'seq',
  'sig',
  'spec',
  'stream_id',
  'utc',
] as const;
export const CARD_PAYLOAD_KEYS = [
  'classification',
  'compatibility',
  'endpoint_origin',
  'engram_root',
  'expires_utc',
  'inventory',
  'key_id',
  'parent',
  'profile',
  'rappid',
  'reflex_capability_root',
  'requested_scope',
  'revocation_url',
  'soul_hash',
  'wake_challenge',
] as const;
export const CARD_COMPATIBILITY_KEYS = [
  'features',
  'protocol',
  'runtime',
] as const;
export const CARD_INVENTORY_KEYS = [
  'bytes',
  'hash',
  'part',
  'required',
  'space',
] as const;
export const CARD_CONTINUITY_KEYS = [
  'engram_root',
  'nonce',
  'parent',
  'rappid',
  'reflex_capability_root',
  'soul_hash',
] as const;
export const CARD_PROVENANCE_KEYS = ['channel', 'source'] as const;
export const CARD_FETCH_HOP_KEYS = ['resolved_ip', 'url'] as const;
export const CARD_REVOCATION_ENTRY_KEYS = [
  'effective_utc',
  'reason',
  'target',
  'target_type',
] as const;
export const CARD_RUNTIME_POLICY_KEYS = [
  'authority_rappid',
  'card_authority',
  'effective_utc',
  'expires_utc',
  'features',
  'generated_utc',
  'granted_scope',
  'max_classification',
  'max_registry_age_seconds',
  'policy_seq',
  'profiles',
  'protocol',
  'provenance',
  'runtime',
  'schema',
  'sig',
  'signer_key_id',
] as const;
export const CARD_AUTHORITY_VIEW_KEYS = [
  'approved_origins',
  'authorizations',
  'authority_rappid',
  'effective_utc',
  'expires_utc',
  'generated_utc',
  'provenance',
  'registry_seq',
  'schema',
  'sig',
  'signer_key_id',
] as const;
export const CARD_REVOCATION_VIEW_KEYS = [
  'authority_rappid',
  'effective_utc',
  'entries',
  'expires_utc',
  'generated_utc',
  'provenance',
  'registry_seq',
  'schema',
  'sig',
  'signer_key_id',
] as const;

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };
export type CardProfile = typeof CARD_PROFILE | typeof CARD_TEST_PROFILE;
export type CardKind = typeof CARD_CALLING | typeof CARD_DEBUG;
export type CardClassification = (typeof CARD_CLASSIFICATIONS)[number];
export type CardStep = (typeof CARD_VERIFY_STEPS)[number];

export interface CardParent {
  rappid: string;
  particle: string;
}

export interface CardCompatibility {
  protocol: string;
  runtime: string;
  features: string[];
}

export interface CardInventoryEntry {
  part: string;
  space: 'rapp/1:egg';
  hash: string;
  bytes: number;
  required: boolean;
}

export interface CardPayload {
  profile: CardProfile;
  rappid: string;
  soul_hash: string;
  parent: CardParent | null;
  engram_root: string;
  reflex_capability_root: string;
  compatibility: CardCompatibility;
  classification: CardClassification;
  requested_scope: string[];
  expires_utc: string;
  revocation_url: string;
  endpoint_origin: string;
  wake_challenge: string;
  inventory: CardInventoryEntry[];
  key_id: string;
}

export interface CardFrame {
  spec: 'rapp/1';
  kind: CardKind;
  stream_id: string;
  seq: number;
  utc: string;
  payload: CardPayload;
  payload_hash: string;
  frame_hash: string;
  prev: string | null;
  prev_wave: string | null;
  sig: string;
}

export interface CardProvenance {
  source: string;
  channel: string;
}

export interface CardRuntimePolicy {
  schema: 'rappid-card-runtime-policy/1';
  policy_seq: number;
  generated_utc: string;
  effective_utc: string;
  expires_utc: string;
  authority_rappid: string;
  signer_key_id: string;
  provenance: CardProvenance;
  card_authority: string;
  protocol: string;
  runtime: string;
  features: string[];
  profiles: string[];
  max_classification: CardClassification;
  granted_scope: string[];
  max_registry_age_seconds: number;
  sig: string;
}

export interface CardAuthorization {
  issuer_key_id: string;
  subject_rappid: string | null;
  role: 'subject' | 'card-issuer';
  not_before_utc: string;
  not_after_utc: string;
  revoked_utc: string | null;
}

export interface CardAuthorityView {
  schema: 'rappid-card-authority/1';
  registry_seq: number;
  generated_utc: string;
  effective_utc: string;
  expires_utc: string;
  authority_rappid: string;
  signer_key_id: string;
  provenance: CardProvenance;
  approved_origins: string[];
  authorizations: CardAuthorization[];
  sig: string;
}

export interface CardRevocationEntry {
  target_type: 'manifest-hash' | 'key-id' | 'subject-rappid';
  target: string;
  effective_utc: string;
  reason: string;
}

export interface CardRevocationView {
  schema: 'rappid-card-revocations/1';
  registry_seq: number;
  generated_utc: string;
  effective_utc: string;
  expires_utc: string;
  authority_rappid: string;
  signer_key_id: string;
  provenance: CardProvenance;
  entries: CardRevocationEntry[];
  sig: string;
}

export interface CardFetchHop {
  url: string;
  resolved_ip: string;
}

export interface CardContinuity {
  rappid: string;
  soul_hash: string;
  parent: CardParent | null;
  engram_root: string;
  reflex_capability_root: string;
  nonce: string;
}

export interface ParsedCardLink {
  rappid: string;
  manifest_hash: string;
  endpoint: string;
  endpoint_origin: string;
  nonce: string;
}

export interface CardAwakeResult {
  status: 'awake';
  profile: CardProfile;
  rappid: string;
  manifest_hash: string;
  nonce: string;
  runtime_policy_seq: number;
  authority_seq: number;
  revocation_seq: number;
}

export interface CardVerificationResult {
  ok: boolean;
  step: CardStep | null;
  reason: string;
  result: CardAwakeResult | null;
}

export interface CardVector {
  name: string;
  frame: CardFrame;
  link: string;
  runtime_policy_authority: string;
  runtime_policy: CardRuntimePolicy;
  authority_view: CardAuthorityView;
  revocation_view: CardRevocationView | null;
  now_utc: string;
  connection_id: string;
  fetch_trace: CardFetchHop[];
  hydrated_parts: string[];
  continuity: CardContinuity;
  state_seed: {
    nonces: Array<{
      nonce: string;
      connection_id: string;
      state: 'hydrating' | 'awake';
      utc: string;
    }>;
    sequences: Array<{
      namespace: string;
      authority: string;
      seq: number;
      view_hash: string;
    }>;
  };
  physical: boolean;
  scanner_control: boolean;
  expected: {
    ok: boolean;
    step: CardStep | null;
    reason_contains: string | null;
  };
}

export interface CardDeck {
  schema: 'rappid-card-vectors/2';
  production_profile: 'rappid-card/1';
  test_profile: 'rappid-card-test/1';
  virtual_suffix: '.rappid-card.json';
  mandatory_scenarios: string[];
  parts_b64: Record<string, string>;
  trust: Array<{ kid: string; spki_der_b64: string }>;
  vectors: CardVector[];
}

export abstract class CardStateBackend {
  abstract claimNonce(
    nonce: string,
    connectionId: string,
    utc: string,
  ): [boolean, string];
  abstract markAwake(
    nonce: string,
    connectionId: string,
    utc: string,
  ): [boolean, string];
  abstract acceptSequence(
    namespace: string,
    authority: string,
    seq: number,
    viewHash: string,
  ): [boolean, string];
}

export class RappidCardError extends Error {
  constructor(
    readonly step: CardStep | 'parse' | 'schema',
    message: string,
  ) {
    super(message);
    this.name = 'RappidCardError';
  }
}
