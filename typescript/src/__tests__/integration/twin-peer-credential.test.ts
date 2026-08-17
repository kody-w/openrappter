import { describe, it, expect } from 'vitest';
import { peerHeaders, sendTwin } from '../../twin/send.js';

/**
 * A rappter presents a credential to a neighbour when it has one.
 *
 * Both wires sent only a content type, while `/twin` and `/chat` each call
 * `resolveHttpAuthenticated` before parsing (#113, #119). Those facts were
 * compatible only because authentication was off: `isAuthCredentialValid`
 * returns true immediately when `authMode` is `none`. So the neighborhood
 * worked *because* the security control was off, and turning it on anywhere
 * severed it — a peer with a token refused both senders, including one whose
 * own environment held the credential (#133).
 *
 * These assert on the request the sender actually builds, because that is the
 * half that was wrong. The gateway's acceptance of `Authorization: Bearer` is
 * already covered by its own auth tests; what nothing checked was whether
 * anybody ever sent one.
 */

function capturingFetch(): {
  calls: { url: string; headers: Record<string, string> }[];
  impl: typeof fetch;
} {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const impl = (async (url: unknown, init?: RequestInit) => {
    calls.push({
      url: String(url),
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ok: true, reply: 'ack' }),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { calls, impl };
}

describe('presenting a credential to a neighbour', () => {
  it('sends Bearer when a token is configured', () => {
    expect(peerHeaders({ OPENRAPPTER_TOKEN: 'sec' })).toEqual({
      'Content-Type': 'application/json',
      Authorization: 'Bearer sec',
    });
  });

  it('sends no Authorization header when there is no token', () => {
    // Sending `Bearer undefined` would be worse than sending nothing: the peer
    // would see a malformed credential rather than an anonymous caller.
    expect(peerHeaders({})).toEqual({ 'Content-Type': 'application/json' });
    expect(peerHeaders({ OPENRAPPTER_TOKEN: '' })).toEqual({
      'Content-Type': 'application/json',
    });
    expect(peerHeaders({ OPENRAPPTER_TOKEN: '   ' })).toEqual({
      'Content-Type': 'application/json',
    });
  });

  it('trims a token that arrived with whitespace', () => {
    expect(peerHeaders({ OPENRAPPTER_TOKEN: '  sec  ' }).Authorization)
      .toBe('Bearer sec');
  });

  it('the /twin wire carries the credential', async () => {
    const previous = process.env.OPENRAPPTER_TOKEN;
    process.env.OPENRAPPTER_TOKEN = 'wire-token';
    try {
      const { calls, impl } = capturingFetch();
      await sendTwin({
        to: 'http://127.0.0.1:19167',
        text: 'hello',
        fromRappid: 'rappid:@kody-w/alpha:1',
        toRappid: 'rappid:@kody-w/slate:1',
        fetchImpl: impl,
      });
      const twinCall = calls.find((c) => c.url.endsWith('/twin'));
      expect(twinCall?.headers.Authorization).toBe('Bearer wire-token');
    } finally {
      if (previous === undefined) delete process.env.OPENRAPPTER_TOKEN;
      else process.env.OPENRAPPTER_TOKEN = previous;
    }
  });

  it('an anonymous sender still reaches an unauthenticated peer', async () => {
    // The neighborhood must keep working on a deployment with auth off, which
    // is every deployment today. A fix that required a token would trade one
    // severed configuration for another.
    const previous = process.env.OPENRAPPTER_TOKEN;
    delete process.env.OPENRAPPTER_TOKEN;
    try {
      const { calls, impl } = capturingFetch();
      await sendTwin({
        to: 'http://127.0.0.1:19167',
        text: 'hello',
        fromRappid: 'rappid:@kody-w/alpha:1',
        toRappid: 'rappid:@kody-w/slate:1',
        fetchImpl: impl,
      });
      const twinCall = calls.find((c) => c.url.endsWith('/twin'));
      expect(twinCall).toBeDefined();
      expect(twinCall?.headers.Authorization).toBeUndefined();
    } finally {
      if (previous !== undefined) process.env.OPENRAPPTER_TOKEN = previous;
    }
  });
});
