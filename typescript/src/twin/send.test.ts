/**
 * Speaking to a twin. — kody-w/openrappter#100
 *
 * The receiver was strict about two fields long before anything could send
 * them, so these tests are mostly about the sender agreeing with its own
 * sibling: an envelope this module builds must be one `parseTwinEnvelope`
 * accepts. Two halves of one protocol disagreeing is exactly the failure that
 * is invisible until a peer answers 400.
 */

import { describe, it, expect, vi } from 'vitest';
import { parseTwinEnvelope, TWIN_SCHEMA } from '../gateway/twin-chat.js';
import {
  buildTwinSay, deviceRappid, sendTwin, twinNonce, twinUtc,
} from './send.js';

const ME = deviceRappid('kody-w', 'alpha');
const YOU = deviceRappid('kody-w', 'scout');

describe('the sender agrees with the receiver', () => {
  // THE POINT. Anything built here must survive the parser on the far side.
  it('builds an envelope its own receiver accepts', () => {
    const env = buildTwinSay({ fromRappid: ME, toRappid: YOU, text: 'are you there?' });
    const parsed = parseTwinEnvelope(env);
    expect(parsed.ok, parsed.ok ? '' : parsed.error).toBe(true);
  });

  it('emits a utc the receiver will not reject', () => {
    const utc = twinUtc(new Date('2026-08-05T04:59:59.987Z'));
    // toISOString() would give '...59.987Z', which §6a forbids and the
    // receiver rejects — this is the whole reason the helper exists.
    expect(utc).toBe('2026-08-05T04:59:59Z');
    expect(new Date().toISOString()).not.toBe(twinUtc());
  });

  it('emits a nonce of exactly 128 bits of lowercase hex', () => {
    for (let i = 0; i < 20; i++) {
      const n = twinNonce();
      expect(n).toMatch(/^[0-9a-f]{32}$/);
    }
    expect(twinNonce()).not.toBe(twinNonce());
  });
});

describe('identity is stable, and is not a credential', () => {
  it('gives the same device the same rappid across calls', () => {
    expect(deviceRappid('kody-w', 'alpha')).toBe(deviceRappid('kody-w', 'alpha'));
    // A rappid minted per call would make every message look like a stranger.
    expect(deviceRappid('kody-w', 'alpha')).not.toBe(deviceRappid('kody-w', 'scout'));
  });

  it('produces the shape the receiver validates', () => {
    expect(parseTwinEnvelope(buildTwinSay({ fromRappid: ME, toRappid: YOU, text: 'x' })).ok).toBe(true);
    expect(ME).toMatch(/^rappid:@[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+:[0-9a-f]{64}$/);
  });

  it('does not let a hostile owner or slug break the shape', () => {
    const weird = deviceRappid('../../root', 'a b/c');
    expect(weird).toMatch(/^rappid:@[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+:[0-9a-f]{64}$/);
    const env = buildTwinSay({ fromRappid: weird, toRappid: YOU, text: 'x' });
    expect(parseTwinEnvelope(env).ok).toBe(true);
  });
});

describe('what the sender refuses', () => {
  // Refused at BOTH ends. A sender that can emit console is a way to smuggle
  // one past a peer that trusts its neighbours.
  it('will not send a console envelope', async () => {
    await expect(sendTwin({
      to: 'http://127.0.0.1:1', fromRappid: ME, toRappid: YOU,
      text: 'id', kind: 'console',
    })).rejects.toThrow(/sealed-only/i);
  });
});

describe('sending', () => {
  it('posts the envelope to the peer and reports what it said', async () => {
    const seen: { url?: string; body?: unknown } = {};
    const fakeFetch = vi.fn(async (url: string, init: RequestInit) => {
      seen.url = String(url);
      seen.body = JSON.parse(String(init.body));
      return new Response(JSON.stringify({
        schema: 'rapp-twin-chat-response/1.0',
        channel: '5a-tether',
        envelope: seen.body,
        status: 200,
        response: { response: 'I am here.', session_id: 'n', agent_logs: '', voice_mode: false },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as unknown as typeof fetch;

    const out = await sendTwin({
      to: 'http://127.0.0.1:19901/', fromRappid: ME, toRappid: YOU,
      text: 'are you there?', fetchImpl: fakeFetch,
    });

    expect(seen.url).toBe('http://127.0.0.1:19901/twin');
    expect(out.status).toBe(200);
    expect(out.said).toBe('I am here.');
    // And what went out is what a receiver would accept.
    expect(parseTwinEnvelope(seen.body).ok).toBe(true);
    expect((seen.body as Record<string, unknown>).schema).toBe(TWIN_SCHEMA);
  });

  it('surfaces a peer refusal rather than pretending it succeeded', async () => {
    const fakeFetch = vi.fn(async () => new Response(
      JSON.stringify({ error: 'from_rappid must be a rappid' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    )) as unknown as typeof fetch;

    const out = await sendTwin({
      to: 'http://127.0.0.1:19901', fromRappid: ME, toRappid: YOU,
      text: 'x', fetchImpl: fakeFetch,
    });
    expect(out.status).toBe(400);
    expect(out.said).toBe('');
    expect(out.body.error).toBe('from_rappid must be a rappid');
  });
});

/**
 * A peer that speaks only /chat is still in the neighborhood. — #125
 *
 * The architecture names TWO wires: "through a neighborhood they all interact
 * over /twin and /chat, and none of them can tell whether a peer is a rappter,
 * a brainstem, or a person." This sender spoke one of them, so a rappter could
 * only ever reach other rappters.
 *
 * Measured against the live brainstem, which answers /chat and 404s /twin:
 *
 *   $ openrappter twin say --to http://127.0.0.1:7071 --text "what are you?"
 *     alpha → http://127.0.0.1:7071
 *     peer answered 404: {}
 *
 * The indistinguishability property was fine — asked over /chat what it was
 * talking to, the brainstem answered "You're a person — specifically Kody."
 * What was missing was any way to reach it.
 *
 * `{}` was also a fabrication: the brainstem replied with a Flask HTML page,
 * and `JSON.stringify` of a parse failure is `{}`. A peer answering "this
 * endpoint does not exist" in HTML — the most likely shape there is — was
 * reported as having said nothing.
 */
describe('a peer that speaks only /chat can still be reached', () => {
  function fakeFetch(routes: Record<string, { status: number; body: string }>) {
    const seen: string[] = [];
    const impl = async (url: string) => {
      seen.push(url);
      const key = Object.keys(routes).find((k) => url.endsWith(k));
      const r = key ? routes[key]! : { status: 404, body: '<!doctype html><h1>Not Found</h1>' };
      return {
        status: r.status,
        text: async () => r.body,
      } as unknown as Response;
    };
    return { impl, seen };
  }

  const args = {
    to: 'http://peer.invalid',
    fromRappid: 'rappid:@kody-w/alpha:' + 'a'.repeat(64),
    toRappid: 'rappid:@kody-w/peer:' + 'b'.repeat(64),
    text: 'what are you?',
  };

  it('falls back to /chat when the peer does not implement /twin', async () => {
    const { impl, seen } = fakeFetch({
      '/twin': { status: 404, body: '<!doctype html><h1>Not Found</h1>' },
      '/chat': { status: 200, body: JSON.stringify({ response: 'I am the brainstem' }) },
    });
    const out = await sendTwin({ ...args, fetchImpl: impl as never });

    expect(out.status).toBe(200);
    expect(out.said).toBe('I am the brainstem');
    // /twin is tried FIRST — the fallback must not become the default, or a
    // rappter would stop exchanging rappids with peers that do speak it.
    expect(seen[0]).toContain('/twin');
    expect(seen[1]).toContain('/chat');
  });

  it('says which wire answered, because /chat exchanges no identity', async () => {
    const { impl } = fakeFetch({
      '/twin': { status: 404, body: 'nope' },
      '/chat': { status: 200, body: JSON.stringify({ response: 'hi' }) },
    });
    const out = await sendTwin({ ...args, fetchImpl: impl as never });
    // Presenting this identically to a /twin reply would claim an identity
    // exchange that never happened.
    expect(out.wire).toBe('chat');
  });

  it('does not fall back when the peer DOES speak /twin', async () => {
    const { impl, seen } = fakeFetch({
      '/twin': {
        status: 200,
        body: JSON.stringify({ response: { response: 'ok' } }),
      },
    });
    const out = await sendTwin({ ...args, fetchImpl: impl as never });

    expect(out.said).toBe('ok');
    expect(out.wire).toBe('twin');
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('/twin');
  });

  it('reports a non-JSON body verbatim rather than as {}', async () => {
    // Both wires refuse, so the original failure is what gets reported — and
    // it must not be dressed up as an empty object.
    const { impl } = fakeFetch({});
    const out = await sendTwin({ ...args, fetchImpl: impl as never });

    expect(out.status).toBe(404);
    expect(out.rawBody).toContain('Not Found');
    expect(JSON.stringify(out.body)).toBe('{}');
  });

  it('reports the /twin failure when neither wire answers, not a second one', async () => {
    // A fallback that masked the original error would make a peer which speaks
    // neither protocol indistinguishable from one whose /chat is broken.
    const { impl } = fakeFetch({
      '/twin': { status: 404, body: 'no twin here' },
    });
    const out = await sendTwin({ ...args, fetchImpl: impl as never });
    expect(out.status).toBe(404);
    expect(out.wire).toBe('twin');
  });
});
