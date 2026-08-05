/**
 * The gateway will not read an unbounded POST body.
 *
 * MEASURED FIRST, then written. Against both runtimes on this machine, a 10 MB
 * `/chat` body was accepted by BOTH, buffered whole, and forwarded to the paid
 * model API — which rejected it with 413. So the old behaviour did not merely
 * risk memory: it spent an upstream call on garbage, and the two runtimes then
 * disagreed about the wreckage (brainstem 502, openrappter 503).
 *
 *   brainstem     10MB -> HTTP 502 :: {"detail":"Request Entity Too Large", ...}
 *   openrappter   10MB -> HTTP 503 :: {"error":"Copilot API error: HTTP 413 ..."}
 *
 * The accumulation was `body += chunk.toString()` with no limit, on a gateway
 * meant to face peers on a shared wire — where untrusted is the normal case.
 *
 * This is a DELIBERATE divergence from the brainstem, which has no cap.
 * Everywhere else on /chat the rule is to match it exactly; here, matching it
 * would mean copying a hole.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GatewayServer } from '../server.js';
import type { AgentRequest } from '../types.js';

const PORT = 19812;
const BASE = `http://127.0.0.1:${PORT}`;
const CAP = 2 * 1024 * 1024;

let server: GatewayServer;
let dataDir: string;
/** Proves the oversized request never reached the expensive half. */
let handlerCalls = 0;

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'gw-cap-'));
  server = new GatewayServer({
    port: PORT,
    bind: 'loopback',
    auth: { mode: 'none' },
    heartbeatInterval: 60000,
    dataDir,
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

async function postRaw(target: string, raw: string) {
  const res = await fetch(BASE + target, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Connection: 'close' },
    body: raw,
  });
  const text = await res.text();
  let body: unknown;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
}

describe('an oversized body is refused at the door', () => {
  it('answers 413 instead of buffering it', async () => {
    const before = handlerCalls;
    const huge = JSON.stringify({ user_input: 'x'.repeat(CAP + 1024) });
    const got = await postRaw('/chat', huge);

    expect(got.status).toBe(413);
    // Bare {error}, like every other rejection on this wire.
    expect(got.body).toEqual({ error: 'Request body too large' });
    // THE POINT: the agent — and behind it a paid API — was never invoked.
    expect(handlerCalls).toBe(before);
  });

  /**
   * The case the first version of this file missed.
   *
   * A 2 MB overage flushes before the response can race it, so destroying the
   * socket on the first offending chunk still looked fine here — and then a
   * live daemon, probed with 10 MB, returned a connection error instead of an
   * answer. The limit must still produce a READABLE 413 when the client is
   * mid-upload, which means draining rather than slamming the socket.
   */
  it('still delivers a readable 413 when the client is far over the limit', async () => {
    const before = handlerCalls;
    const enormous = JSON.stringify({ user_input: 'x'.repeat(CAP * 5) });
    const got = await postRaw('/chat', enormous);

    expect(got.status).toBe(413);
    expect(got.body).toEqual({ error: 'Request body too large' });
    expect(handlerCalls).toBe(before);
  });

  it('refuses through a query string too, where /chat once stopped being /chat', async () => {
    const huge = JSON.stringify({ user_input: 'x'.repeat(CAP + 1024) });
    const got = await postRaw('/chat?x=1', huge);
    expect(got.status).toBe(413);
    expect(got.body).toEqual({ error: 'Request body too large' });
  });

  it('names the limit on non-chat POSTs, which have no parity obligation', async () => {
    const huge = JSON.stringify({ filename: 'a.js', contents: 'x'.repeat(CAP + 1024) });
    const got = await postRaw('/agents/import', huge);
    expect(got.status).toBe(413);
    expect(got.body).toHaveProperty('limit_bytes', CAP);
  });
});

describe('the cap never bites a real request', () => {
  it('answers a normal turn', async () => {
    const got = await postRaw('/chat', JSON.stringify({ user_input: 'hello', session_id: 'cap-1' }));
    expect(got.status).toBe(200);
    expect((got.body as Record<string, unknown>).response).toBe('Echo: hello');
  });

  it('answers a large but legitimate turn — forty turns of history', async () => {
    const history = Array.from({ length: 40 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: 'a reasonably long conversational turn. '.repeat(60),
    }));
    const raw = JSON.stringify({ user_input: 'and then?', conversation_history: history });
    // Comfortably real, comfortably under the cap — the case that must not break.
    expect(raw.length).toBeLessThan(CAP);
    expect(raw.length).toBeGreaterThan(80_000);

    const got = await postRaw('/chat', raw);
    expect(got.status).toBe(200);
    expect((got.body as Record<string, unknown>).response).toBe('Echo: and then?');
  });

  it('still rejects a malformed body on its own terms, not as oversize', async () => {
    const got = await postRaw('/chat', '{"user_input":123}');
    expect(got.status).toBe(400);
    expect(got.body).toEqual({ error: 'user_input must be a string' });
  });
});
