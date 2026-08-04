import { describe, it, expect } from 'vitest';
import { BasicAgent } from '../../agents/BasicAgent.js';
import type { AgentMetadata } from '../../agents/types.js';

/**
 * Regression tests for kody-w/openrappter#41.
 *
 * `execute()` used to assert `kwargs.query as string` and hand the value
 * straight to `slosh()`, so any non-string query threw
 * `TypeError: query.toLowerCase is not a function` inside the framework —
 * before `perform()` ran. An agent could not validate its own inputs.
 */

class EchoAgent extends BasicAgent {
  seen: Record<string, unknown> | null = null;

  constructor() {
    const metadata: AgentMetadata = {
      name: 'Echo',
      description: 'Echoes the received query type',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'User input' } },
        required: [],
      },
    };
    super('Echo', metadata);
  }

  async perform(kwargs: Record<string, unknown>): Promise<string> {
    this.seen = kwargs;
    return JSON.stringify({ status: 'success', received: kwargs.query ?? null });
  }
}

const NON_STRING_QUERIES: Array<[string, unknown]> = [
  ['number', 42],
  ['boolean', true],
  ['array', ['a', 'b']],
  ['object', { a: 1 }],
  ['float', 3.5],
];

describe('BasicAgent non-string query guard', () => {
  it.each(NON_STRING_QUERIES)(
    'executes instead of throwing when query is a %s',
    async (_label, value) => {
      const agent = new EchoAgent();
      const result = await agent.execute({ query: value });
      expect(JSON.parse(result).status).toBe('success');
    },
  );

  it.each(NON_STRING_QUERIES)(
    'passes the untouched %s value through to perform()',
    async (_label, value) => {
      const agent = new EchoAgent();
      await agent.execute({ query: value });
      expect(agent.seen?.query).toEqual(value);
    },
  );

  it('still sloshes a full context for a non-string query', async () => {
    const agent = new EchoAgent();
    await agent.execute({ query: 42 });

    expect(agent.context).not.toBeNull();
    expect(agent.context?.temporal).toBeDefined();
    expect(agent.context?.query_signals).toBeDefined();
    expect(agent.context?.orientation).toBeDefined();
  });

  it('treats a non-string query as empty text when sloshing', async () => {
    const nonString = new EchoAgent();
    await nonString.execute({ query: ['ignored', 'tokens'] });

    const empty = new EchoAgent();
    await empty.execute({ query: '' });

    expect(nonString.context?.query_signals).toEqual(empty.context?.query_signals);
  });

  it('still sloshes real text for a string query', async () => {
    const agent = new EchoAgent();
    await agent.execute({ query: 'deploy the staging cluster now' });

    expect(agent.context?.query_signals).not.toEqual(
      new EchoAgent().slosh('').query_signals,
    );
  });

  it('falls through nullish keys to request and user_input', async () => {
    const viaRequest = new EchoAgent();
    await viaRequest.execute({ query: null, request: 'from request' });

    const viaUserInput = new EchoAgent();
    await viaUserInput.execute({ query: null, request: null, user_input: 'from user_input' });

    const direct = new EchoAgent();

    expect(viaRequest.context?.query_signals).toEqual(
      direct.slosh('from request').query_signals,
    );
    expect(viaUserInput.context?.query_signals).toEqual(
      direct.slosh('from user_input').query_signals,
    );
  });

  it('does not fall through to request when query is present but non-string', async () => {
    const agent = new EchoAgent();
    await agent.execute({ query: 42, request: 'should not be used' });

    const empty = new EchoAgent();
    await empty.execute({ query: '' });

    expect(agent.context?.query_signals).toEqual(empty.context?.query_signals);
  });

  it('does not throw when slosh() is called directly with a non-string', () => {
    const agent = new EchoAgent();
    for (const [, value] of NON_STRING_QUERIES) {
      expect(() => agent.slosh(value as unknown as string)).not.toThrow();
    }
  });
});
