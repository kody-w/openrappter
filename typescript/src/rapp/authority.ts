export type RappStreamFamily = 'body' | 'memory' | 'swarm';
export type ProtocolAuthorityStatus = 'accepted';

export interface ProtocolAuthorityIdentity {
  revision: string;
  frame_hash: string;
  payload_hash: string;
}

/**
 * Metadata about an unselected protocol draft.
 *
 * Draft metadata is intentionally not constructible as ProtocolAuthority and
 * cannot be supplied to frame/evidence profiles.
 */
export interface ProtocolAuthorityDraftMetadata {
  status: 'draft';
  revision: string;
  checkpoint?: string;
}

const ACCEPTED_KIND_FAMILIES: Readonly<Record<string, RappStreamFamily>> =
  Object.freeze({
    'body.pulse': 'body',
    'body.re-genesis': 'body',
    'body.reconstructed': 'body',
    'body.twin-pulse': 'body',
    'memory.chat-turn': 'memory',
    'memory.re-genesis': 'memory',
    'memory.reconstructed': 'memory',
    'memory.save': 'memory',
    'memory.tool-call': 'memory',
    'swarm.echo': 'swarm',
    'swarm.guidance': 'swarm',
    'swarm.re-genesis': 'swarm',
    'swarm.reconstructed': 'swarm',
    'swarm.telemetry': 'swarm',
  });

const AUTHORITY_CAPABILITY = Symbol('selected-protocol-authority');
const MODULE_OWNED_AUTHORITIES = new WeakSet<ProtocolAuthority>();

/**
 * Immutable, selected protocol authority.
 *
 * The private constructor prevents a caller from blessing an arbitrary kind
 * allowlist. New instances require a code change backed by a verified accepted
 * checkpoint fixture.
 */
export class ProtocolAuthority {
  static readonly acceptedRev13 = new ProtocolAuthority({
    revision: 'rev-13',
    frameHash: 'bbcee75ebbbf82d11d8ffd666fdda34c8233642de6d6e4f45910d43a24a001e3',
    payloadHash: '78a89c06509b5100494b9c7e0f551acdc6209fd90aded734321f3580b0f07051',
    repository: 'https://github.com/kody-w/rapp-1',
    checkpointCommit: '85b0b04cc0d39702278e7ee2a8ada3467ca9a045',
    normativeSha256: 'e5abd6a32801761fdd5c151a4f90fa4c989b545da02d3cd26dfc4765fab8409a',
    bootstrapProfileSha256: null,
    kindFamilies: ACCEPTED_KIND_FAMILIES,
  }, AUTHORITY_CAPABILITY);

  static readonly acceptedRev14 = new ProtocolAuthority({
    revision: 'rev-14',
    frameHash: '59629adab4e26d156f3d66ecfb766e08705919ea1d2adc92ba0ad2b17337dfc2',
    payloadHash: 'c7549bbd3e133b833930e24e008817ea295734b870f41706455d3f45821aba3a',
    repository: 'https://github.com/kody-w/rapp-1',
    checkpointCommit: 'caf6ef276cafa92aa744499af90dc1a28559941a',
    normativeSha256: 'd345235be5bc698d78c5893285abd09f2e62a398f781123d1de8da313a01c7de',
    bootstrapProfileSha256: '1666e44acf532f854d4bf74868c9af9f9b362055692189ac858a7c8b52dcd5bb',
    kindFamilies: ACCEPTED_KIND_FAMILIES,
  }, AUTHORITY_CAPABILITY);

  readonly status: ProtocolAuthorityStatus = 'accepted';
  readonly revision: string;
  readonly frameHash: string;
  readonly payloadHash: string;
  readonly repository: string;
  readonly checkpointCommit: string;
  readonly normativeSha256: string;
  readonly bootstrapProfileSha256: string | null;
  readonly kindFamilies: Readonly<Record<string, RappStreamFamily>>;

  private constructor(input: {
    revision: string;
    frameHash: string;
    payloadHash: string;
    repository: string;
    checkpointCommit: string;
    normativeSha256: string;
    bootstrapProfileSha256: string | null;
    kindFamilies: Readonly<Record<string, RappStreamFamily>>;
  }, capability: symbol) {
    if (capability !== AUTHORITY_CAPABILITY) {
      throw new TypeError('ProtocolAuthority can only be created from a module-owned accepted checkpoint');
    }
    this.revision = input.revision;
    this.frameHash = input.frameHash;
    this.payloadHash = input.payloadHash;
    this.repository = input.repository;
    this.checkpointCommit = input.checkpointCommit;
    this.normativeSha256 = input.normativeSha256;
    this.bootstrapProfileSha256 = input.bootstrapProfileSha256;
    this.kindFamilies = input.kindFamilies;
    MODULE_OWNED_AUTHORITIES.add(this);
    Object.freeze(this);
  }

  identity(): Readonly<ProtocolAuthorityIdentity> {
    return Object.freeze({
      revision: this.revision,
      frame_hash: this.frameHash,
      payload_hash: this.payloadHash,
    });
  }

  familyForKind(kind: string): RappStreamFamily | null {
    return this.kindFamilies[kind] ?? null;
  }

  registeredKinds(): readonly string[] {
    return Object.freeze(Object.keys(this.kindFamilies).sort());
  }
}

/** The selected authority used when callers do not explicitly supply one. */
export const ACCEPTED_RAPP_PROTOCOL_AUTHORITY = ProtocolAuthority.acceptedRev14;

const ACCEPTED_AUTHORITIES: Readonly<Record<string, ProtocolAuthority>> =
  Object.freeze({
    'rev-13': ProtocolAuthority.acceptedRev13,
    'rev-14': ProtocolAuthority.acceptedRev14,
  });

/** True only for the exact frozen authority objects owned by this module. */
export function isSelectedProtocolAuthority(
  value: unknown,
): value is ProtocolAuthority {
  if (!(value instanceof ProtocolAuthority) || !MODULE_OWNED_AUTHORITIES.has(value)) {
    return false;
  }
  return ACCEPTED_AUTHORITIES[value.revision] === value;
}

/** Resolve an accepted historical checkpoint without changing the selected default. */
export function resolveProtocolAuthority(
  revision: string,
): ProtocolAuthority | null {
  return ACCEPTED_AUTHORITIES[revision] ?? null;
}
