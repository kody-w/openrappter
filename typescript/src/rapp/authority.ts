export type RappStreamFamily = 'body' | 'memory' | 'swarm';
export type ProtocolAuthorityStatus = 'accepted';

export interface ProtocolAuthorityIdentity {
  revision: string;
  frame_hash: string;
  payload_hash: string;
}

export interface ProtocolAuthorityDetails extends ProtocolAuthorityIdentity {
  repository: string;
  checkpoint_commit: string;
  normative_sha256: string;
  bootstrap_profile_sha256: string | null;
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

const ACCEPTED_KIND_FAMILIES: ReadonlyMap<string, RappStreamFamily> =
  new Map([
    ['body.pulse', 'body'],
    ['body.re-genesis', 'body'],
    ['body.reconstructed', 'body'],
    ['body.twin-pulse', 'body'],
    ['memory.chat-turn', 'memory'],
    ['memory.re-genesis', 'memory'],
    ['memory.reconstructed', 'memory'],
    ['memory.save', 'memory'],
    ['memory.tool-call', 'memory'],
    ['swarm.echo', 'swarm'],
    ['swarm.guidance', 'swarm'],
    ['swarm.re-genesis', 'swarm'],
    ['swarm.reconstructed', 'swarm'],
    ['swarm.telemetry', 'swarm'],
  ] as const);

const AUTHORITY_CAPABILITY = Symbol('selected-protocol-authority');
const MODULE_OWNED_AUTHORITIES = new WeakSet<ProtocolAuthority>();
interface ProtocolAuthorityRecord {
  revision: string;
  frameHash: string;
  payloadHash: string;
  repository: string;
  checkpointCommit: string;
  normativeSha256: string;
  bootstrapProfileSha256: string | null;
  kindFamilies: ReadonlyMap<string, RappStreamFamily>;
}
const AUTHORITY_RECORDS = new WeakMap<ProtocolAuthority, ProtocolAuthorityRecord>();

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

  private constructor(input: ProtocolAuthorityRecord, capability: symbol) {
    if (capability !== AUTHORITY_CAPABILITY) {
      throw new TypeError('ProtocolAuthority can only be created from a module-owned accepted checkpoint');
    }
    const record = Object.freeze(
      Object.assign(Object.create(null), input),
    ) as ProtocolAuthorityRecord;
    this.revision = record.revision;
    this.frameHash = record.frameHash;
    this.payloadHash = record.payloadHash;
    this.repository = record.repository;
    this.checkpointCommit = record.checkpointCommit;
    this.normativeSha256 = record.normativeSha256;
    this.bootstrapProfileSha256 = record.bootstrapProfileSha256;
    this.kindFamilies = Object.freeze(Object.assign(
      Object.create(null),
      Object.fromEntries(record.kindFamilies),
    )) as Readonly<Record<string, RappStreamFamily>>;
    MODULE_OWNED_AUTHORITIES.add(this);
    AUTHORITY_RECORDS.set(this, record);
    Object.freeze(this);
  }

  identity(): Readonly<ProtocolAuthorityIdentity> {
    return protocolAuthorityIdentity(this);
  }

  familyForKind(kind: string): RappStreamFamily | null {
    return protocolAuthorityFamilyForKind(this, kind);
  }

  registeredKinds(): readonly string[] {
    return protocolAuthorityRegisteredKinds(this);
  }
}

const ACCEPTED_AUTHORITIES: ReadonlyMap<string, ProtocolAuthority> =
  new Map([
    ['rev-13', ProtocolAuthority.acceptedRev13],
    ['rev-14', ProtocolAuthority.acceptedRev14],
  ]);

/** True only for the exact frozen authority objects owned by this module. */
export function isSelectedProtocolAuthority(
  value: unknown,
): value is ProtocolAuthority {
  if (
    typeof value !== 'object'
    || value === null
    || !MODULE_OWNED_AUTHORITIES.has(value as ProtocolAuthority)
  ) {
    return false;
  }
  const record = AUTHORITY_RECORDS.get(value as ProtocolAuthority);
  return record !== undefined && ACCEPTED_AUTHORITIES.get(record.revision) === value;
}

function authorityRecord(authority: ProtocolAuthority): ProtocolAuthorityRecord {
  if (!isSelectedProtocolAuthority(authority)) {
    throw new TypeError('authority is not an exact module-owned accepted checkpoint');
  }
  return AUTHORITY_RECORDS.get(authority)!;
}

export function protocolAuthorityIdentity(
  authority: ProtocolAuthority,
): Readonly<ProtocolAuthorityIdentity> {
  const record = authorityRecord(authority);
  return Object.freeze({
    revision: record.revision,
    frame_hash: record.frameHash,
    payload_hash: record.payloadHash,
  });
}

export function protocolAuthorityDetails(
  authority: ProtocolAuthority,
): Readonly<ProtocolAuthorityDetails> {
  const record = authorityRecord(authority);
  return Object.freeze({
    revision: record.revision,
    frame_hash: record.frameHash,
    payload_hash: record.payloadHash,
    repository: record.repository,
    checkpoint_commit: record.checkpointCommit,
    normative_sha256: record.normativeSha256,
    bootstrap_profile_sha256: record.bootstrapProfileSha256,
  });
}

export function protocolAuthorityFamilyForKind(
  authority: ProtocolAuthority,
  kind: string,
): RappStreamFamily | null {
  const families = authorityRecord(authority).kindFamilies;
  return families.has(kind) ? families.get(kind)! : null;
}

export function protocolAuthorityRegisteredKinds(
  authority: ProtocolAuthority,
): readonly string[] {
  return Object.freeze(
    [...authorityRecord(authority).kindFamilies.keys()].sort(),
  );
}

Object.freeze(ProtocolAuthority.prototype);
Object.freeze(ProtocolAuthority);

/** The selected authority used when callers do not explicitly supply one. */
export const ACCEPTED_RAPP_PROTOCOL_AUTHORITY = ProtocolAuthority.acceptedRev14;

/** Resolve an accepted historical checkpoint without changing the selected default. */
export function resolveProtocolAuthority(
  revision: string,
): ProtocolAuthority | null {
  return ACCEPTED_AUTHORITIES.get(revision) ?? null;
}
