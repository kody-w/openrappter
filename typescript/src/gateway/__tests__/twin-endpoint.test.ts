/**
 * POST /twin — the neighborhood wire. — kody-w/openrappter#96
 *
 * A device runs an alpha rappter plus hatched twins, and they interact over
 * /twin and /chat without knowing what kind of peer answered. /chat carries a
 * turn; /twin carries a turn between two *named* peers.
 *
 * Before #95 this path answered `200 {"response":"Received: …"}` to anything,
 * so a peer probing for twin support was told yes. Then it honestly 404'd. Now
 * it exists — and the most important tests here are the ones asserting what it
 * REFUSES.
 *
 * Shapes: rapp-neighborhood-protocol/1.0 §6a (request), §6e (response).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GatewayServer } from '../server.js';
import type { AgentRequest } from '../types.js';

const PORT = 19814;
const BASE = `http://127.0.0.1:${PORT}`;

let server: GatewayServer;
let dataDir: string;
let handlerCalls = 0;

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'gw-twin-'));
  server = new GatewayServer({
    port: PORT, bind: 'loopback', auth: { mode: 'none' },
    heartbeatInterval: 60000, dataDir,
  });
  server.setAgentHandler(async (req: AgentRequest) => {
    handlerCalls += 1;
    return { sessionId: req.sessionId ?? 'gen', content: `Echo: ${req.message}`, finishReason: 'stop' };
  });
  await server.start();
});

afterAll(async () => {
  await server.stop();
  rmSync(dataDir, { recursive: true, force: true });
});

const A = 'rappid:@kody-w/alpha:' + 'a'.repeat(64);
const B = 'rappid:@kody-w/scout:' + 'b'.repeat(64);

function envelope(over: Record<string, unknown> = {}) {
  return {
    schema: 'rapp-twin-chat/1.0',
    from_rappid: B,
    to_rappid: A,
    utc: '2026-08-05T03:30:00Z',
    nonce: 'f'.repeat(32),
    kind: 'say',
    payload: { text: 'are you there?' },
    facets: [],
    ...over,
  };
}

async function post(body: unknown, target = '/twin') {
  const res = await fetch(BASE + target, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Connection: 'close' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: res.status, body: parsed as Record<string, unknown>, text };
}

describe('what /twin refuses', () => {
  // THE ONE THAT MATTERS. `console` operates a neighbor's runtime and is
  // sealed-only. This gateway has no seal, so it must refuse — not queue it,
  // not accept it quietly, and above all not run it.
  it('refuses console outright, because it has no seal', async () => {
    const before = handlerCalls;
    const got = await post(envelope({ kind: 'console', payload: { cmd: 'rm -rf /' } }));

    expect(got.status).toBe(403);
    expect(String(got.body.error)).toMatch(/sealed-only/i);
    // Never reached anything that could execute it.
    expect(handlerCalls).toBe(before);
    // And did not quietly succeed under another name.
    expect(got.text).not.toContain('rapp-twin-chat-response');
  });

  it('rejects a rappid that is not a rappid', async () => {
    for (const bad of ['kody-w/alpha', 'rappid:@kody-w/alpha:tooshort', '', 'rappid:@a/b:' + 'z'.repeat(64)]) {
      const got = await post(envelope({ from_rappid: bad }));
      expect(got.status, bad).toBe(400);
      expect(String(got.body.error)).toMatch(/from_rappid must be a rappid/);
    }
  });

  it('rejects a utc carrying fractional seconds, which the spec forbids', async () => {
    const got = await post(envelope({ utc: '2026-08-05T03:30:00.123Z' }));
    expect(got.status).toBe(400);
    expect(String(got.body.error)).toMatch(/fractional/);
  });

  it('rejects a nonce that is not 128 bits of hex', async () => {
    for (const bad of ['abc', 'F'.repeat(32), 'f'.repeat(31)]) {
      const got = await post(envelope({ nonce: bad }));
      expect(got.status, bad).toBe(400);
    }
  });

  it('rejects the wrong schema and an unknown kind', async () => {
    expect((await post(envelope({ schema: 'rapp-twin-chat/2.0' }))).status).toBe(400);
    expect((await post(envelope({ kind: 'demand' }))).status).toBe(400);
  });

  it('rejects a say carrying no text rather than prompting on nothing', async () => {
    const before = handlerCalls;
    const got = await post(envelope({ payload: {} }));
    expect(got.status).toBe(400);
    expect(handlerCalls).toBe(before);
  });
});

describe('what /twin answers', () => {
  it('carries a say to the agent and replies in the §6e envelope', async () => {
    const env = envelope();
    const got = await post(env);

    expect(got.status).toBe(200);
    expect(got.body.schema).toBe('rapp-twin-chat-response/1.0');
    expect(got.body.channel).toBe('5a-tether');
    // Echoed, so a peer can match a reply to what it sent.
    expect(got.body.envelope).toEqual(env);

    const inner = got.body.response as Record<string, unknown>;
    expect(inner.response).toBe('Echo: are you there?');
    // The same four keys /chat returns, so a peer reads one shape either way.
    for (const k of ['response', 'session_id', 'agent_logs', 'voice_mode']) {
      expect(inner, `missing ${k}`).toHaveProperty(k);
    }
  });

  it('accepts the text under the field a brainstem client would use', async () => {
    const got = await post(envelope({ payload: { user_input: 'via user_input' } }));
    expect((got.body.response as Record<string, unknown>).response).toBe('Echo: via user_input');
  });

  it('acknowledges an ack without spending a model call', async () => {
    const before = handlerCalls;
    const got = await post(envelope({ kind: 'ack', payload: {} }));

    expect(got.status).toBe(200);
    expect(got.body.schema).toBe('rapp-twin-chat-response/1.0');
    // An ack is not a question. Answering it with a model call would be a way
    // to bill someone for saying "got it".
    expect(handlerCalls).toBe(before);
  });
});

describe('it did not disturb what already worked', () => {
  it('still answers /chat', async () => {
    const got = await post({ user_input: 'hello', session_id: 'twin-1' }, '/chat');
    expect(got.status).toBe(200);
    expect(got.body.response).toBe('Echo: hello');
  });

  it('still 404s a path it does not implement', async () => {
    const got = await post({}, '/definitely-not-real');
    expect(got.status).toBe(404);
  });

  it('treats /twin with a query string as /twin', async () => {
    const got = await post(envelope(), '/twin?x=1');
    expect(got.status).toBe(200);
    expect(got.body.schema).toBe('rapp-twin-chat-response/1.0');
  });
});

describe('the voice seam never reaches a peer', () => {
  /**
   * #97. The live daemon returned `'ok\n|||VOICE|||\nok'` to a peer immediately
   * after /twin shipped: an internal marker, a duplicated answer, and a tell no
   * brainstem would emit. The tests above could not see it — they inject a fake
   * handler that returns plain text, so no marker is ever produced. Only a real
   * model with VOICE_MODE emits one.
   *
   * So this one makes the handler behave like the real thing.
   */
  it('splits |||VOICE||| out of the reply, as /chat does', async () => {
    server.setAgentHandler(async (req: AgentRequest) => ({
      sessionId: req.sessionId ?? 'gen',
      content: 'The full written answer.\n|||VOICE|||\nThe spoken one.',
      finishReason: 'stop',
    }));
    try {
      const got = await post(envelope());
      const inner = got.body.response as Record<string, unknown>;

      expect(inner.response).toBe('The full written answer.');
      expect(String(inner.response)).not.toContain('|||VOICE|||');
      expect(JSON.stringify(got.body)).not.toContain('|||VOICE|||');
      expect(inner.voice_response).toBe('The spoken one.');
      expect(inner.voice_mode).toBe(true);
    } finally {
      server.setAgentHandler(async (req: AgentRequest) => {
        handlerCalls += 1;
        return { sessionId: req.sessionId ?? 'gen', content: `Echo: ${req.message}`, finishReason: 'stop' };
      });
    }
  });

  it('leaves a reply with no marker exactly as it was', async () => {
    const got = await post(envelope());
    const inner = got.body.response as Record<string, unknown>;
    expect(inner.response).toBe('Echo: are you there?');
    expect(inner).not.toHaveProperty('voice_response');
    expect(inner.voice_mode).toBe(false);
  });
});

/**
 * /twin requires the same credential /chat does. — #113
 *
 * `openrappter gateway --bind all --token SECRET` exists so the agent is not
 * reachable by anyone who can route to the port. `/chat` enforced it and
 * `/twin` did not, while both route into the same `agentHandler` — the same
 * model spend and the same tool loop.
 *
 * Measured on a real server before the fix:
 *
 *   POST /chat  no token  -> 401 Authentication required
 *   POST /chat  w/ token  -> 200 agent ran
 *   POST /twin  no token  -> 200 agent ran          <- walked past the credential
 *
 * `validateRequestSource` does not close it: its loopback check is gated on
 * `bind === 'loopback'` and is skipped under `--bind all`, which is the only
 * configuration in which a token means anything at all.
 *
 * Refusing `console` — which this endpoint already does — is not a substitute.
 * A `say` reaches the model just as surely.
 *
 * The suite above runs with `auth: { mode: 'none' }`, so a separate server is
 * needed here; a credential that is never configured cannot be shown to be
 * enforced.
 */
describe('/twin and the gateway credential', () => {
  const TOKEN = 'SECRET-TOKEN';
  const AUTH_PORT = 18_795;
  const AUTH_BASE = `http://127.0.0.1:${AUTH_PORT}`;
  let guarded: GatewayServer;
  let guardedDir: string;
  let ran = 0;

  beforeAll(async () => {
    guardedDir = mkdtempSync(join(tmpdir(), 'gw-twin-auth-'));
    guarded = new GatewayServer({
      port: AUTH_PORT, bind: 'loopback',
      auth: { mode: 'token', tokens: [TOKEN] },
      heartbeatInterval: 60_000, dataDir: guardedDir,
    });
    guarded.setAgentHandler(async (req: AgentRequest) => {
      ran += 1;
      return { sessionId: req.sessionId ?? 'gen', content: 'AGENT RAN', finishReason: 'stop' };
    });
    await guarded.start();
  });

  afterAll(async () => {
    await guarded.stop();
    rmSync(guardedDir, { recursive: true, force: true });
  });

  async function postTo(headers: Record<string, string> = {}) {
    return fetch(`${AUTH_BASE}/twin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Connection: 'close', ...headers },
      body: JSON.stringify(envelope()),
    });
  }

  it('refuses an unauthenticated say, and the agent does not run', async () => {
    const before = ran;
    const res = await postTo();
    expect(res.status).toBe(401);
    // The status alone is not the point. The point is that nothing reached the
    // model — a 401 that still spent a model call would be a worse defect than
    // the one being fixed.
    expect(ran).toBe(before);
  });

  it('accepts the same say once the credential is presented', async () => {
    const before = ran;
    const res = await postTo({ Authorization: `Bearer ${TOKEN}` });
    expect(res.status).toBe(200);
    expect(ran).toBe(before + 1);
  });

  it('tells an unauthenticated caller nothing about envelope validity', async () => {
    // The check runs before parsing on purpose. If a malformed envelope got a
    // 400 while a well-formed one got a 401, the endpoint would be an oracle
    // for probing the wire format without a credential.
    const res = await fetch(`${AUTH_BASE}/twin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Connection: 'close' },
      body: JSON.stringify({ schema: 'nonsense' }),
    });
    expect(res.status).toBe(401);
  });

  it('still refuses console, with the credential presented', async () => {
    // Authentication must not become a way in for the sealed-only kind.
    const res = await fetch(`${AUTH_BASE}/twin`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json', Connection: 'close',
        Authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify(envelope({ kind: 'console' })),
    });
    expect(res.status).toBe(403);
  });
});
