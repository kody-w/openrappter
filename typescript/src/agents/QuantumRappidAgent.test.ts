import { afterEach, describe, expect, it } from 'vitest';

import { buildOrganism, makeHabitat, removeHabitat } from '../rappids/__tests__/fixture.js';
import { QuantumRappidAgent } from './QuantumRappidAgent.js';

describe('QuantumRappidAgent', () => {
  let root: string | undefined;

  afterEach(() => {
    delete process.env.RAPP_RAPPIDS_HOME;
    if (root) removeHabitat(root);
    root = undefined;
  });

  it('reads and proposes without exposing a mutation operation', async () => {
    root = makeHabitat('agent');
    process.env.RAPP_RAPPIDS_HOME = root;
    const fixture = buildOrganism({ habitat: root });
    const agent = new QuantumRappidAgent();

    const listed = JSON.parse(await agent.perform({ operation: 'list' }));
    expect(listed.organisms.map((item: { rappid: string }) => item.rappid))
      .toEqual([fixture.rappid]);
    expect(listed.organisms[0].externalEpisode).toBeUndefined();

    const inspected = JSON.parse(await agent.perform({
      operation: 'inspect',
      rappid: fixture.rappid,
    }));
    expect(inspected.result.directory).toBeUndefined();
    expect(inspected.result.summary.externalEpisode).toBeUndefined();

    const proposed = JSON.parse(await agent.perform({
      operation: 'propose',
      rappid: fixture.rappid,
      dimension: 'stats',
    }));
    expect(proposed.status).toBe('success');
    expect(proposed.result.authoritative).toBe(false);
    expect(proposed.result.appendable).toBe(false);
    expect(proposed.data_slush.mutation).toBe(false);

    const mutation = JSON.parse(await agent.perform({
      operation: 'grow',
      rappid: fixture.rappid,
    }));
    expect(mutation.status).toBe('error');
    expect(mutation.message).toContain('authenticated Habitat');
  });
});
