import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { buildOrganism, makeHabitat, removeHabitat } from '../../rappids/__tests__/fixture.js';
import { registerRappidMethods } from './rappid-methods.js';
import type { RappidMutationAuthorization } from './rappid-methods.js';

type Handler = (params: Record<string, unknown>) => Promise<unknown>;

function registrar(
  root: string,
  authorizeMutation?: (request: RappidMutationAuthorization) => Promise<boolean>,
): {
  methods: Map<string, Handler>;
  auth: Map<string, boolean>;
} {
  const methods = new Map<string, Handler>();
  const auth = new Map<string, boolean>();
  registerRappidMethods({
    registerMethod(name, handler, options) {
      const invoke = handler as unknown as (
        params: Record<string, unknown>,
        connection: unknown,
      ) => Promise<unknown>;
      methods.set(name, (params) => invoke(params, {}));
      auth.set(name, options?.requiresAuth === true);
    },
  }, { root, dataDir: root, authorizeMutation });
  return { methods, auth };
}

describe('Quantum RAPPID gateway methods', () => {
  let root: string | undefined;

  afterEach(() => {
    if (root) removeHabitat(root);
    root = undefined;
  });

  it('lists, verifies, serves assets, and previews growth through authenticated RPC', async () => {
    root = makeHabitat('gateway');
    const fixture = buildOrganism({ habitat: root });
    const { methods, auth } = registrar(root);

    for (const name of [
      'rappid.list',
      'rappid.inspect',
      'rappid.verify',
      'rappid.asset',
      'rappid.autocomplete',
      'rappid.grow',
      'rappid.attach-skill',
    ]) {
      expect(methods.has(name), name).toBe(true);
      expect(auth.get(name), name).toBe(true);
    }

    const listed = await methods.get('rappid.list')!({}) as Array<{ rappid: string }>;
    expect(listed.map((item) => item.rappid)).toEqual([fixture.rappid]);

    const verification = await methods.get('rappid.verify')!({
      rappid: fixture.rappid,
    }) as { ok: boolean };
    expect(verification.ok).toBe(true);

    const asset = await methods.get('rappid.asset')!({
      rappid: fixture.rappid,
      asset: 'midi-dna',
    }) as { bytes: number; base64: string };
    expect(asset.bytes).toBe(fixture.promptMidiBytes);
    expect(Buffer.from(asset.base64, 'base64')).toHaveLength(
      fixture.promptMidiBytes,
    );

    const proposal = await methods.get('rappid.autocomplete')!({
      rappid: fixture.rappid,
      dimension: 'stats',
    }) as { authoritative: boolean; appendable: boolean };
    expect(proposal.authoritative).toBe(false);
    expect(proposal.appendable).toBe(false);
  });

  it('refuses missing required parameters', async () => {
    root = makeHabitat('gateway-required');
    const { methods } = registrar(root);
    await expect(methods.get('rappid.asset')!({})).rejects.toThrow(
      'rappid is required',
    );
  });

  it('fails closed when no mutation approval authority is configured', async () => {
    root = makeHabitat('gateway-no-approval');
    const fixture = buildOrganism({ habitat: root });
    const { methods } = registrar(root);

    await expect(methods.get('rappid.grow')!({
      rappid: fixture.rappid,
      proposalId: 'proposal',
      approvalId: 'approval',
    })).rejects.toThrow('approval authority is unavailable');
  });

  it('attaches only a hash-matched private recorded skill as a RAPP/1 frame', async () => {
    root = makeHabitat('gateway-skill');
    const fixture = buildOrganism({ habitat: root });
    const authorizations: RappidMutationAuthorization[] = [];
    const { methods } = registrar(root, async (request) => {
      authorizations.push(request);
      return request.approvalId === 'approval-skill-1';
    });
    const directory = join(root, 'skills', 'recorded-skill');
    mkdirSync(directory, { recursive: true });
    const skill = '# Recorded skill\n\nDo the reviewed thing.\n';
    const manifest = '{"sourceSessionId":"session-1"}\n';
    writeFileSync(join(directory, 'SKILL.md'), skill);
    writeFileSync(join(directory, 'manifest.json'), manifest);
    const contentHash = createHash('sha256')
      .update(skill)
      .update('\0')
      .update(manifest)
      .digest('hex');

    const result = await methods.get('rappid.attach-skill')!({
      rappid: fixture.rappid,
      sessionId: 'session-1',
      name: 'recorded-skill',
      artifactPath: join(directory, 'SKILL.md'),
      contentHash,
      approvalId: 'approval-skill-1',
    }) as {
      appended: { spec: string; kind: string; seq: number };
      verification: { ok: boolean };
      summary: { stats: { frameHeight: number } };
    };

    expect(result.appended).toMatchObject({
      spec: 'rapp/1',
      kind: 'body.dimension',
      seq: 0,
    });
    expect(result.verification.ok).toBe(true);
    expect(result.summary.stats.frameHeight).toBe(1);
    expect(authorizations).toEqual([{
      approvalId: 'approval-skill-1',
      operation: 'attach-skill',
      rappid: fixture.rappid,
      sessionId: 'session-1',
      contentHash,
    }]);
  });
});
