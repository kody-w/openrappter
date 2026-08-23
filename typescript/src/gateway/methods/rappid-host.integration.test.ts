import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { buildOrganism, makeHabitat, removeHabitat } from '../../rappids/__tests__/fixture.js';
import { rappidPairingProof } from '../../rappids/host-authority.js';
import { GatewayServer } from '../server.js';

const OPERATOR_TOKEN = 'operator-gateway-token';
let server: GatewayServer | undefined;
let dataDir: string | undefined;
let habitat: string | undefined;
const originalHome = process.env.RAPP_RAPPIDS_HOME;

afterEach(async () => {
  await server?.stop();
  server = undefined;
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  if (habitat) removeHabitat(habitat);
  dataDir = undefined;
  habitat = undefined;
  if (originalHome === undefined) delete process.env.RAPP_RAPPIDS_HOME;
  else process.env.RAPP_RAPPIDS_HOME = originalHome;
});

async function rpc(
  port: number,
  method: string,
  params: Record<string, unknown>,
  token?: string,
): Promise<{
  status: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}> {
  const response = await fetch(`http://127.0.0.1:${port}/`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'rappid-host', method, params }),
  });
  return {
    status: response.status,
    ...(await response.json()) as {
      result?: Record<string, unknown>;
      error?: { code: number; message: string };
    },
  };
}

describe('RAPPID real host pairing and approval integration', () => {
  it('pairs once, scopes the bearer, and consumes an exact mutation approval', async () => {
    dataDir = join(process.cwd(), `.rappid-host-gateway-${process.pid}`);
    rmSync(dataDir, { recursive: true, force: true });
    habitat = makeHabitat('host-gateway');
    process.env.RAPP_RAPPIDS_HOME = habitat;
    const fixture = buildOrganism({ habitat });
    server = new GatewayServer({
      port: 0,
      bind: 'loopback',
      auth: { mode: 'token', tokens: [OPERATOR_TOKEN] },
      dataDir,
    });
    await server.start();
    const port = server.port;

    const offerResponse = await rpc(
      port,
      'rappid.pairing.begin',
      { host: `http://127.0.0.1:${port}` },
      OPERATOR_TOKEN,
    );
    const offer = offerResponse.result as {
      code: string;
      hostFingerprint: string;
    };
    const nonce = 'field-device-nonce-0001';
    const installID = 'field-install-0001';
    const pairingRequest = {
      schema: 'rappid-field-pair/1',
      deviceName: 'Field phone',
      deviceInstallID: installID,
      requestedScopes: [
        'rappid.list',
        'rappid.asset',
        'rappid.autocomplete',
        'rappid.grow',
      ],
      nonce,
      proof: rappidPairingProof(offer.code, nonce, installID),
    };
    const paired = await rpc(port, 'rappid.pairing.complete', pairingRequest);
    expect(paired.status).toBe(200);
    const credential = paired.result as {
      credentialID: string;
      token: string;
      scopes: string[];
      isSyntheticGrant: boolean;
    };
    expect(credential.isSyntheticGrant).toBe(false);
    expect(credential.token).not.toBe('******');

    const replayedPair = await rpc(port, 'rappid.pairing.complete', pairingRequest);
    expect(replayedPair.error?.message).toContain('invalid or expired');

    const listed = await rpc(port, 'rappid.list', {}, credential.token);
    expect(listed.status).toBe(200);
    expect(listed.result).toBeDefined();

    const forbidden = await rpc(port, 'methods', {}, credential.token);
    expect(forbidden.status).toBe(403);
    expect(forbidden.error?.message).toContain('not scoped');

    const proposalResponse = await rpc(
      port,
      'rappid.autocomplete',
      { rappid: fixture.rappid, dimension: 'sonic' },
      credential.token,
    );
    const proposal = proposalResponse.result as {
      id: string;
      predictedStats: { frameHeight: number };
    };
    expect(proposal.predictedStats.frameHeight).toBe(1);

    const approvalResponse = await rpc(
      port,
      'rappid.approval.issue',
      {
        operation: 'grow',
        rappid: fixture.rappid,
        proposalId: proposal.id,
      },
      credential.token,
    );
    const approval = approvalResponse.result as { approvalId: string };
    expect(approval.approvalId).toMatch(/^rappid_approval_/);

    const grown = await rpc(
      port,
      'rappid.grow',
      {
        rappid: fixture.rappid,
        proposalId: proposal.id,
        approvalId: approval.approvalId,
      },
      credential.token,
    );
    expect(grown.result).toMatchObject({
      appended: {
        seq: 0,
        frame_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
    });

    const replay = await rpc(
      port,
      'rappid.grow',
      {
        rappid: fixture.rappid,
        proposalId: proposal.id,
        approvalId: approval.approvalId,
      },
      credential.token,
    );
    expect(replay.error?.message).toContain('refused or already consumed');

    const revoked = await rpc(
      port,
      'rappid.pairing.revoke',
      { credentialID: credential.credentialID },
      OPERATOR_TOKEN,
    );
    expect(revoked.result).toEqual({ revoked: true });
    const afterRevocation = await rpc(port, 'rappid.list', {}, credential.token);
    expect(afterRevocation.status).toBe(401);
  });
});
