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

type KindFamilyEntry = readonly [string, RappStreamFamily];
const ACCEPTED_KIND_FAMILIES: readonly KindFamilyEntry[] = [
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
] as const;
for (let index = 0; index < ACCEPTED_KIND_FAMILIES.length; index += 1) {
  Object.freeze(ACCEPTED_KIND_FAMILIES[index]);
}
Object.freeze(ACCEPTED_KIND_FAMILIES);

const AUTHORITY_CAPABILITY = Symbol('selected-protocol-authority');
interface ProtocolAuthorityRecord {
  revision: string;
  frameHash: string;
  payloadHash: string;
  repository: string;
  checkpointCommit: string;
  normativeSha256: string;
  bootstrapProfileSha256: string | null;
  kindFamilies: readonly KindFamilyEntry[];
}
const AUTHORITY_OBJECTS: ProtocolAuthority[] = [];
const AUTHORITY_RECORDS: ProtocolAuthorityRecord[] = [];

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
    const publicFamilies = Object.create(null) as Record<string, RappStreamFamily>;
    for (let index = 0; index < record.kindFamilies.length; index += 1) {
      const entry = record.kindFamilies[index];
      publicFamilies[entry[0]] = entry[1];
    }
    this.kindFamilies = Object.freeze(publicFamilies);
    AUTHORITY_OBJECTS[AUTHORITY_OBJECTS.length] = this;
    AUTHORITY_RECORDS[AUTHORITY_RECORDS.length] = record;
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

const ACCEPTED_AUTHORITIES: readonly (
  readonly [string, ProtocolAuthority]
)[] = [
    ['rev-13', ProtocolAuthority.acceptedRev13],
    ['rev-14', ProtocolAuthority.acceptedRev14],
] as const;
for (let index = 0; index < ACCEPTED_AUTHORITIES.length; index += 1) {
  Object.freeze(ACCEPTED_AUTHORITIES[index]);
}
Object.freeze(ACCEPTED_AUTHORITIES);
Object.freeze(AUTHORITY_OBJECTS);
Object.freeze(AUTHORITY_RECORDS);

function findAuthorityRecord(value: unknown): ProtocolAuthorityRecord | null {
  for (let index = 0; index < AUTHORITY_OBJECTS.length; index += 1) {
    if (AUTHORITY_OBJECTS[index] === value) return AUTHORITY_RECORDS[index];
  }
  return null;
}

/** True only for the exact frozen authority objects owned by this module. */
export function isSelectedProtocolAuthority(
  value: unknown,
): value is ProtocolAuthority {
  const record = findAuthorityRecord(value);
  if (record === null) return false;
  for (let index = 0; index < ACCEPTED_AUTHORITIES.length; index += 1) {
    const entry = ACCEPTED_AUTHORITIES[index];
    if (entry[0] === record.revision) return entry[1] === value;
  }
  return false;
}

function authorityRecord(authority: ProtocolAuthority): ProtocolAuthorityRecord {
  if (!isSelectedProtocolAuthority(authority)) {
    throw new TypeError('authority is not an exact module-owned accepted checkpoint');
  }
  return findAuthorityRecord(authority)!;
}

export function protocolAuthorityIdentity(
  authority: ProtocolAuthority,
): Readonly<ProtocolAuthorityIdentity> {
  const record = authorityRecord(authority);
  return Object.freeze(Object.assign(Object.create(null), {
    revision: record.revision,
    frame_hash: record.frameHash,
    payload_hash: record.payloadHash,
  })) as Readonly<ProtocolAuthorityIdentity>;
}

export function protocolAuthorityDetails(
  authority: ProtocolAuthority,
): Readonly<ProtocolAuthorityDetails> {
  const record = authorityRecord(authority);
  return Object.freeze(Object.assign(Object.create(null), {
    revision: record.revision,
    frame_hash: record.frameHash,
    payload_hash: record.payloadHash,
    repository: record.repository,
    checkpoint_commit: record.checkpointCommit,
    normative_sha256: record.normativeSha256,
    bootstrap_profile_sha256: record.bootstrapProfileSha256,
  })) as Readonly<ProtocolAuthorityDetails>;
}

export function protocolAuthorityFamilyForKind(
  authority: ProtocolAuthority,
  kind: string,
): RappStreamFamily | null {
  const families = authorityRecord(authority).kindFamilies;
  for (let index = 0; index < families.length; index += 1) {
    if (families[index][0] === kind) return families[index][1];
  }
  return null;
}

export function protocolAuthorityRegisteredKinds(
  authority: ProtocolAuthority,
): readonly string[] {
  const families = authorityRecord(authority).kindFamilies;
  const kinds: string[] = [];
  for (let index = 0; index < families.length; index += 1) {
    kinds[index] = families[index][0];
  }
  return Object.freeze(kinds);
}

Object.freeze(ProtocolAuthority.prototype);
Object.freeze(ProtocolAuthority);

/** The selected authority used when callers do not explicitly supply one. */
export const ACCEPTED_RAPP_PROTOCOL_AUTHORITY = ProtocolAuthority.acceptedRev14;

/** Resolve an accepted historical checkpoint without changing the selected default. */
export function resolveProtocolAuthority(
  revision: string,
): ProtocolAuthority | null {
  for (let index = 0; index < ACCEPTED_AUTHORITIES.length; index += 1) {
    if (ACCEPTED_AUTHORITIES[index][0] === revision) {
      return ACCEPTED_AUTHORITIES[index][1];
    }
  }
  return null;
}
