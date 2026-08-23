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
  authorizeMutation?: (request: RappidMutationAuthorization) => Promise<boolean>;
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
): Promise<void> {
  if (!options.authorizeMutation) {
    throw new Error('RAPPID mutation approval authority is unavailable');
  }
  if (!await options.authorizeMutation(request)) {
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
    async (params) => {
      const rappid = required(params?.rappid, 'rappid');
      const proposalId = required(params?.proposalId, 'proposalId');
      await requireMutationAuthorization(options, {
        approvalId: required(params?.approvalId, 'approvalId'),
        operation: 'grow',
        rappid,
        proposalId,
      });
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
    async (params) => {
      const rappid = required(params?.rappid, 'rappid');
      const sessionId = required(params?.sessionId, 'sessionId');
      const contentHash = required(params?.contentHash, 'contentHash');
      await requireMutationAuthorization(options, {
        approvalId: required(params?.approvalId, 'approvalId'),
        operation: 'attach-skill',
        rappid,
        sessionId,
        contentHash,
      });
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
