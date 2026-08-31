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

const REV13_KIND_FAMILIES: Readonly<Record<string, RappStreamFamily>> =
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
    kindFamilies: REV13_KIND_FAMILIES,
  });

  readonly status: ProtocolAuthorityStatus = 'accepted';
  readonly revision: string;
  readonly frameHash: string;
  readonly payloadHash: string;
  readonly repository: string;
  readonly checkpointCommit: string;
  readonly kindFamilies: Readonly<Record<string, RappStreamFamily>>;

  private constructor(input: {
    revision: string;
    frameHash: string;
    payloadHash: string;
    repository: string;
    checkpointCommit: string;
    kindFamilies: Readonly<Record<string, RappStreamFamily>>;
  }) {
    this.revision = input.revision;
    this.frameHash = input.frameHash;
    this.payloadHash = input.payloadHash;
    this.repository = input.repository;
    this.checkpointCommit = input.checkpointCommit;
    this.kindFamilies = input.kindFamilies;
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
export const ACCEPTED_RAPP_PROTOCOL_AUTHORITY = ProtocolAuthority.acceptedRev13;
