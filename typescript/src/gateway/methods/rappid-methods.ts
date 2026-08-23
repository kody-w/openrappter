/**
 * Quantum RAPPID habitat RPC.
 *
 * Reads are authenticated because organism metadata can point at private local
 * engrams. Mutations are authenticated and require a single-use approval
 * authority bound to the exact operation.
 */

import { join } from 'node:path';

import {
  attachSkillDimension,
  growRappid,
  inspectOrganism,
  listOrganismSummaries,
  proposeGrowth,
  readAssetPayload,
  verifyRappid,
} from '../../rappids/index.js';
import type {
  MutationApprovalBinding,
  PairingRequest,
} from '../../rappids/host-authority.js';
import { RappidHostAuthority } from '../../rappids/host-authority.js';

interface MethodRegistrar {
  registerMethod<P = unknown, R = unknown>(
    name: string,
    handler: (params: P, connection: unknown) => Promise<R>,
    options?: { requiresAuth?: boolean },
  ): void;
}

export interface RappidMethodsOptions {
  root?: string;
  dataDir: string;
  authorizeMutation?: (
    request: RappidMutationAuthorization,
    connection: unknown,
  ) => Promise<boolean>;
}

export interface RappidMutationAuthorization {
  approvalId: string;
  operation: 'grow' | 'attach-skill';
  rappid: string;
  proposalId?: string;
  sessionId?: string;
  contentHash?: string;
}

function required(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} is required`);
  }
  return value.trim();
}

async function requireMutationAuthorization(
  options: RappidMethodsOptions,
  request: RappidMutationAuthorization,
  connection: unknown,
): Promise<void> {
  if (!options.authorizeMutation) {
    throw new Error('RAPPID mutation approval authority is unavailable');
  }
  if (!await options.authorizeMutation(request, connection)) {
    throw new Error('RAPPID mutation approval was refused or already consumed');
  }
}

export function registerRappidMethods(
  server: MethodRegistrar,
  options: RappidMethodsOptions,
): void {
  const habitat = options.root === undefined ? {} : { root: options.root };
  const auth = { requiresAuth: true };

  server.registerMethod('rappid.list', async () =>
    listOrganismSummaries(habitat), auth);

  server.registerMethod<{ rappid?: string }>('rappid.inspect', async (params) =>
    inspectOrganism(required(params?.rappid, 'rappid'), habitat), auth);

  server.registerMethod<{ rappid?: string }>('rappid.verify', async (params) =>
    verifyRappid(required(params?.rappid, 'rappid'), habitat), auth);

  server.registerMethod<{ rappid?: string; asset?: string }>(
    'rappid.asset',
    async (params) =>
      readAssetPayload(
        required(params?.rappid, 'rappid'),
        required(params?.asset, 'asset'),
        habitat,
      ),
    auth,
  );

  server.registerMethod<{ rappid?: string; dimension?: string }>(
    'rappid.autocomplete',
    async (params) =>
      proposeGrowth(
        required(params?.rappid, 'rappid'),
        required(params?.dimension, 'dimension'),
        habitat,
      ),
    auth,
  );

  server.registerMethod<{ rappid?: string; proposalId?: string; approvalId?: string }>(
    'rappid.grow',
    async (params, connection) => {
      const rappid = required(params?.rappid, 'rappid');
      const proposalId = required(params?.proposalId, 'proposalId');
      await requireMutationAuthorization(options, {
        approvalId: required(params?.approvalId, 'approvalId'),
        operation: 'grow',
        rappid,
        proposalId,
      }, connection);
      return growRappid(rappid, proposalId, habitat);
    },
    auth,
  );

  server.registerMethod<{
    rappid?: string;
    sessionId?: string;
    name?: string;
    artifactPath?: string;
    contentHash?: string;
    approvalId?: string;
  }>(
    'rappid.attach-skill',
    async (params, connection) => {
      const rappid = required(params?.rappid, 'rappid');
      const sessionId = required(params?.sessionId, 'sessionId');
      const contentHash = required(params?.contentHash, 'contentHash');
      await requireMutationAuthorization(options, {
        approvalId: required(params?.approvalId, 'approvalId'),
        operation: 'attach-skill',
        rappid,
        sessionId,
        contentHash,
      }, connection);
      return attachSkillDimension(rappid, {
        ...habitat,
        sessionId,
        name: required(params?.name, 'name'),
        artifactPath: required(params?.artifactPath, 'artifactPath'),
        contentHash,
        artifactRoot: join(options.dataDir, 'skills'),
      });
    },
    auth,
  );
}

interface RappidConnectionContext {
  metadata?: {
    rappidDeviceId?: unknown;
    rappidScopes?: unknown;
  };
}

function principal(connection: unknown): {
  id: string;
  scopes?: string[];
  pairedDevice: boolean;
} {
  const context = connection as RappidConnectionContext | undefined;
  const deviceId = context?.metadata?.rappidDeviceId;
  const scopes = context?.metadata?.rappidScopes;
  if (typeof deviceId === 'string' && Array.isArray(scopes)) {
    return {
      id: deviceId,
      scopes: scopes.filter((scope): scope is string => typeof scope === 'string'),
      pairedDevice: true,
    };
  }
  return { id: 'operator', pairedDevice: false };
}

export function registerRappidHostMethods(
  server: MethodRegistrar,
  authority: RappidHostAuthority,
): void {
  server.registerMethod<{ host?: string }>(
    'rappid.pairing.begin',
    async (params, connection) => {
      if (principal(connection).pairedDevice) {
        throw new Error('paired devices cannot create pairing offers');
      }
      return authority.beginPairing(required(params?.host, 'host'));
    },
    { requiresAuth: true },
  );

  server.registerMethod<PairingRequest>(
    'rappid.pairing.complete',
    async (params) => authority.completePairing(params),
  );

  server.registerMethod<MutationApprovalBinding>(
    'rappid.approval.issue',
    async (params, connection) => {
      const caller = principal(connection);
      return authority.issueMutationApproval(caller.id, caller.scopes, params);
    },
    { requiresAuth: true },
  );

  server.registerMethod<{ credentialID?: string }>(
    'rappid.pairing.revoke',
    async (params, connection) => {
      if (principal(connection).pairedDevice) {
        throw new Error('paired devices cannot revoke device credentials');
      }
      const credentialID = required(params?.credentialID, 'credentialID');
      if (!authority.revokeDevice(credentialID)) {
        throw new Error('credential is unknown or already revoked');
      }
      return { revoked: true };
    },
    { requiresAuth: true },
  );
}
