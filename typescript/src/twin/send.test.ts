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
