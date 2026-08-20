/**
 * Quantum RAPPID habitat RPC.
 *
 * Reads are authenticated because organism metadata can point at private local
 * engrams. Mutations are authenticated and still preserve the ordinary
 * proposal/approval boundary in the client.
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
}

function required(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} is required`);
  }
  return value.trim();
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

  server.registerMethod<{ rappid?: string; proposalId?: string }>(
    'rappid.grow',
    async (params) =>
      growRappid(
        required(params?.rappid, 'rappid'),
        required(params?.proposalId, 'proposalId'),
        habitat,
      ),
    auth,
  );

  server.registerMethod<{
    rappid?: string;
    sessionId?: string;
    name?: string;
    artifactPath?: string;
    contentHash?: string;
  }>(
    'rappid.attach-skill',
    async (params) =>
      attachSkillDimension(required(params?.rappid, 'rappid'), {
        ...habitat,
        sessionId: required(params?.sessionId, 'sessionId'),
        name: required(params?.name, 'name'),
        artifactPath: required(params?.artifactPath, 'artifactPath'),
        contentHash: required(params?.contentHash, 'contentHash'),
        artifactRoot: join(options.dataDir, 'skills'),
      }),
    auth,
  );
}
