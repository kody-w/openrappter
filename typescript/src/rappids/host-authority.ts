import {
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { canonicalJson } from './canonical.js';

export const RAPPID_DEVICE_SCOPES = [
  'rappid.list',
  'rappid.asset',
  'rappid.autocomplete',
  'rappid.grow',
] as const;

export type RappidDeviceScope = typeof RAPPID_DEVICE_SCOPES[number];
export type RappidMutationOperation = 'grow' | 'attach-skill';

export interface PairingRequest {
  schema: string;
  deviceName: string;
  deviceInstallID: string;
  requestedScopes: string[];
  nonce: string;
  proof: string;
}

export interface PairingOffer {
  schema: 'rappid-field-pair-offer/1';
  host: string;
  code: string;
  hostFingerprint: string;
  expiresAt: string;
  link: string;
}

export interface DeviceCredential {
  credentialID: string;
  token: string;
  scopes: RappidDeviceScope[];
  hostURL: string;
  hostFingerprint: string;
  issuedAt: string;
  expiresAt: string;
  isSyntheticGrant: false;
}

export interface AuthenticatedRappidDevice {
  deviceId: string;
  deviceName: string;
  scopes: RappidDeviceScope[];
}

export interface MutationApprovalBinding {
  operation: RappidMutationOperation;
  rappid: string;
  proposalId?: string;
  sessionId?: string;
  contentHash?: string;
}

export interface MutationApproval extends MutationApprovalBinding {
  approvalId: string;
  expiresAt: string;
}

interface PendingPairing {
  code: string;
  host: string;
  expiresAtMs: number;
}

interface StoredGrant {
  credentialID: string;
  tokenHash: string;
  deviceName: string;
  deviceInstallID: string;
  scopes: RappidDeviceScope[];
  hostURL: string;
  issuedAt: string;
  expiresAt: string;
  revoked: boolean;
}

interface PendingApproval extends MutationApprovalBinding {
  approvalId: string;
  principalId: string;
  expiresAtMs: number;
}

interface PersistedAuthority {
  schema: 'rappid-host-authority/1';
  hostFingerprint: string;
  grants: StoredGrant[];
}

interface AuthorityOptions {
  now?: () => number;
  pairingTtlMs?: number;
  credentialTtlMs?: number;
  approvalTtlMs?: number;
}

const CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
const PAIRING_SCHEMA = 'rappid-field-pair/1';
const PAIRING_PROOF_DOMAIN = 'rappid-field/1:pair';

function tokenHash(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function constantTimeHex(left: string, right: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(left) || !/^[0-9a-f]{64}$/.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

function pairingProof(code: string, nonce: string, deviceInstallID: string): string {
  const body = canonicalJson({
    code,
    device_install_id: deviceInstallID,
    nonce,
  });
  return createHash('sha256')
    .update(`${PAIRING_PROOF_DOMAIN}\n${body}`, 'utf8')
    .digest('hex');
}

function normalizeHost(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('pairing host must be an absolute URL');
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const loopbackHttp = url.protocol === 'http:' && LOOPBACK_HOSTS.has(hostname);
  if (url.protocol !== 'https:' && !loopbackHttp) {
    throw new Error('pairing host must use HTTPS or literal loopback HTTP');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('pairing host must not contain credentials, query, or fragment');
  }
  if (url.pathname !== '' && url.pathname !== '/') {
    throw new Error('pairing host must be an origin without a path');
  }
  return url.origin;
}

function normalizedScopes(values: string[]): RappidDeviceScope[] {
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error('requestedScopes must be a non-empty array');
  }
  if (new Set(values).size !== values.length) {
    throw new Error('requestedScopes contains a duplicate');
  }
  const allowed = new Set<string>(RAPPID_DEVICE_SCOPES);
  if (values.some((value) => !allowed.has(value))) {
    throw new Error('requestedScopes contains a scope the host will not grant');
  }
  return values as RappidDeviceScope[];
}

export class RappidHostAuthority {
  private readonly statePath: string;
  private readonly now: () => number;
  private readonly pairingTtlMs: number;
  private readonly credentialTtlMs: number;
  private readonly approvalTtlMs: number;
  private readonly pendingPairings: PendingPairing[] = [];
  private readonly approvals = new Map<string, PendingApproval>();
  private grants = new Map<string, StoredGrant>();
  private hostFingerprint: string;

  constructor(dataDir: string, options: AuthorityOptions = {}) {
    this.now = options.now ?? Date.now;
    this.pairingTtlMs = options.pairingTtlMs ?? 5 * 60_000;
    this.credentialTtlMs = options.credentialTtlMs ?? 90 * 24 * 60 * 60_000;
    this.approvalTtlMs = options.approvalTtlMs ?? 2 * 60_000;
    mkdirSync(dataDir, { recursive: true });
    this.statePath = join(dataDir, 'rappid-host-authority.json');
    this.hostFingerprint = randomBytes(4).toString('hex');
    this.load();
  }

  private load(): void {
    if (!existsSync(this.statePath)) {
      this.persist();
      return;
    }
    const parsed = JSON.parse(readFileSync(this.statePath, 'utf8')) as PersistedAuthority;
    if (
      parsed.schema !== 'rappid-host-authority/1'
      || !/^[0-9a-f]{8}$/.test(parsed.hostFingerprint)
      || !Array.isArray(parsed.grants)
    ) {
      throw new Error('RAPPID host authority state is invalid');
    }
    this.hostFingerprint = parsed.hostFingerprint;
    this.grants = new Map(parsed.grants.map((grant) => [grant.tokenHash, grant]));
  }

  private persist(): void {
    const value: PersistedAuthority = {
      schema: 'rappid-host-authority/1',
      hostFingerprint: this.hostFingerprint,
      grants: [...this.grants.values()],
    };
    const next = `${this.statePath}.next`;
    writeFileSync(next, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    chmodSync(next, 0o600);
    renameSync(next, this.statePath);
    chmodSync(this.statePath, 0o600);
  }

  private purgeExpired(): void {
    const now = this.now();
    while (this.pendingPairings.length && this.pendingPairings[0]!.expiresAtMs <= now) {
      this.pendingPairings.shift();
    }
    for (const [id, approval] of this.approvals) {
      if (approval.expiresAtMs <= now) this.approvals.delete(id);
    }
  }

  beginPairing(hostValue: string): PairingOffer {
    this.purgeExpired();
    const host = normalizeHost(hostValue);
    while (this.pendingPairings.length >= 8) this.pendingPairings.shift();
    let code = '';
    for (let index = 0; index < 12; index += 1) {
      code += CODE_ALPHABET[randomBytes(1)[0]! % CODE_ALPHABET.length];
    }
    const expiresAtMs = this.now() + this.pairingTtlMs;
    this.pendingPairings.push({ code, host, expiresAtMs });
    const displayCode = code.match(/.{1,4}/g)!.join('-');
    const link = new URL('rappid-link://pair');
    link.searchParams.set('host', host);
    link.searchParams.set('code', displayCode);
    link.searchParams.set('fp', this.hostFingerprint);
    return {
      schema: 'rappid-field-pair-offer/1',
      host,
      code: displayCode,
      hostFingerprint: this.hostFingerprint,
      expiresAt: new Date(expiresAtMs).toISOString(),
      link: link.toString(),
    };
  }

  completePairing(request: PairingRequest): DeviceCredential {
    this.purgeExpired();
    if (
      !request
      || Object.keys(request).sort().join(',') !== [
        'deviceInstallID',
        'deviceName',
        'nonce',
        'proof',
        'requestedScopes',
        'schema',
      ].join(',')
      || request.schema !== PAIRING_SCHEMA
      || typeof request.deviceName !== 'string'
      || request.deviceName.trim().length === 0
      || request.deviceName.length > 128
      || typeof request.deviceInstallID !== 'string'
      || !/^[A-Za-z0-9._-]{8,128}$/.test(request.deviceInstallID)
      || typeof request.nonce !== 'string'
      || !/^[A-Za-z0-9._-]{8,128}$/.test(request.nonce)
      || typeof request.proof !== 'string'
    ) {
      throw new Error('pairing request has an invalid closed schema');
    }
    const scopes = normalizedScopes(request.requestedScopes);
    const index = this.pendingPairings.findIndex((pending) =>
      constantTimeHex(
        pairingProof(pending.code, request.nonce, request.deviceInstallID),
        request.proof,
      ));
    if (index < 0) throw new Error('pairing proof is invalid or expired');
    const [pending] = this.pendingPairings.splice(index, 1);
    const issuedAtMs = this.now();
    const expiresAtMs = issuedAtMs + this.credentialTtlMs;
    const token = randomBytes(32).toString('base64url');
    const credentialID = `rappid_device_${randomBytes(12).toString('hex')}`;
    const grant: StoredGrant = {
      credentialID,
      tokenHash: tokenHash(token),
      deviceName: request.deviceName.trim(),
      deviceInstallID: request.deviceInstallID,
      scopes,
      hostURL: pending!.host,
      issuedAt: new Date(issuedAtMs).toISOString(),
      expiresAt: new Date(expiresAtMs).toISOString(),
      revoked: false,
    };
    this.grants.set(grant.tokenHash, grant);
    this.persist();
    return {
      credentialID,
      token,
      scopes,
      hostURL: grant.hostURL,
      hostFingerprint: this.hostFingerprint,
      issuedAt: grant.issuedAt,
      expiresAt: grant.expiresAt,
      isSyntheticGrant: false,
    };
  }

  authenticateBearer(token: string | undefined): AuthenticatedRappidDevice | undefined {
    if (!token) return undefined;
    const grant = this.grants.get(tokenHash(token));
    if (!grant || grant.revoked || Date.parse(grant.expiresAt) <= this.now()) return undefined;
    return {
      deviceId: grant.credentialID,
      deviceName: grant.deviceName,
      scopes: [...grant.scopes],
    };
  }

  revokeDevice(credentialID: string): boolean {
    const grant = [...this.grants.values()].find(
      (candidate) => candidate.credentialID === credentialID,
    );
    if (!grant || grant.revoked) return false;
    grant.revoked = true;
    this.persist();
    return true;
  }

  issueMutationApproval(
    principalId: string,
    principalScopes: readonly string[] | undefined,
    binding: MutationApprovalBinding,
  ): MutationApproval {
    this.purgeExpired();
    const requiredScope = binding.operation === 'grow'
      ? 'rappid.grow'
      : 'rappid.attach-skill';
    if (principalScopes && !principalScopes.includes(requiredScope)) {
      throw new Error(`paired credential lacks ${requiredScope} scope`);
    }
    if (
      typeof binding.rappid !== 'string'
      || binding.rappid.trim() === ''
      || (binding.operation === 'grow'
        ? typeof binding.proposalId !== 'string' || binding.proposalId.trim() === ''
        : typeof binding.contentHash !== 'string' || binding.contentHash.trim() === '')
    ) {
      throw new Error('mutation approval binding is incomplete');
    }
    const approvalId = `rappid_approval_${randomBytes(24).toString('base64url')}`;
    const expiresAtMs = this.now() + this.approvalTtlMs;
    this.approvals.set(approvalId, {
      ...binding,
      approvalId,
      principalId,
      expiresAtMs,
    });
    return {
      ...binding,
      approvalId,
      expiresAt: new Date(expiresAtMs).toISOString(),
    };
  }

  consumeMutationApproval(
    principalId: string,
    binding: MutationApprovalBinding & { approvalId: string },
  ): boolean {
    this.purgeExpired();
    const approval = this.approvals.get(binding.approvalId);
    if (!approval || approval.principalId !== principalId) return false;
    const matches = (
      approval.operation === binding.operation
      && approval.rappid === binding.rappid
      && approval.proposalId === binding.proposalId
      && approval.sessionId === binding.sessionId
      && approval.contentHash === binding.contentHash
    );
    if (!matches) return false;
    this.approvals.delete(binding.approvalId);
    return true;
  }
}

export function rappidPairingProof(
  code: string,
  nonce: string,
  deviceInstallID: string,
): string {
  return pairingProof(code.replaceAll('-', '').toUpperCase(), nonce, deviceInstallID);
}
