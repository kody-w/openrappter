import { describe, expect, it } from 'vitest';

import { registerRappidCardMethods } from './rappid-card-methods.js';

type Handler = (params: Record<string, unknown>) => Promise<unknown>;

function registrar(): {
  methods: Map<string, Handler>;
  auth: Map<string, boolean>;
} {
  const methods = new Map<string, Handler>();
  const auth = new Map<string, boolean>();
  registerRappidCardMethods({
    registerMethod(name, handler, options) {
      const invoke = handler as unknown as (
        params: Record<string, unknown>,
        connection: unknown,
      ) => Promise<unknown>;
      methods.set(name, (params) => invoke(params, {}));
      auth.set(name, options?.requiresAuth === true);
    },
  });
  return { methods, auth };
}

describe('RAPPID card gateway methods', () => {
  it('keeps every developer simulation method behind gateway authentication', () => {
    const { methods, auth } = registrar();
    expect([...methods.keys()].sort()).toEqual([
      'rappid.card.fixtures',
      'rappid.card.preview',
      'rappid.card.simulate',
    ]);
    expect([...auth.values()]).toEqual([true, true, true]);
  });

  it('lists the full deck and exposes exact link plus real SVG at preview', async () => {
    const { methods } = registrar();
    const fixtures = await methods.get('rappid.card.fixtures')!({}) as unknown[];
    expect(fixtures).toHaveLength(13);
    const result = await methods.get('rappid.card.preview')!({
      fixture: 'valid',
    }) as {
      exactDeepLink: string;
      qrSvg: string;
      simulation: { state: string; hydrated: unknown[] };
    };
    expect(result.exactDeepLink).toMatch(/^rappid:\/\/link\//);
    expect(result.qrSvg).toContain('<svg');
    expect(result.simulation).toMatchObject({
      state: 'preview',
      hydrated: [],
    });
  });

  it('requires explicit approve=true and surfaces awake/failure states', async () => {
    const { methods } = registrar();
    await expect(methods.get('rappid.card.simulate')!({
      fixture: 'valid',
    })).rejects.toThrow('explicit approve=true');

    const awake = await methods.get('rappid.card.simulate')!({
      fixture: 'valid',
      approve: true,
    }) as { simulation: { state: string } };
    const failed = await methods.get('rappid.card.simulate')!({
      fixture: 'challenge-failure',
      approve: true,
    }) as { simulation: { state: string; error: { code: string } } };
    expect(awake.simulation.state).toBe('awake');
    expect(failed.simulation).toMatchObject({
      state: 'failed',
      error: { code: 'challenge_failed' },
    });
  });
});
