/**
 * An unknown POST path is 404, not 200. — kody-w/openrappter#95
 *
 * A peer discovers capabilities by asking. Before this, every unrecognised POST
 * path fell into a generic echo branch and answered:
 *
 *   POST /twin                 -> 200 {"response":"Received: …","status":{…}}
 *   POST /definitely-not-real  -> 200 {"response":"Received: {}","status":{…}}
 *
 * `/twin` does not exist on either runtime — the brainstem answers 404. So a
 * peer probing for the twin envelope was told it was supported, and no probe
 * could ever distinguish an implemented endpoint from an imaginary one.
 *
 * The echoed `status` also carried port, uptime, version, startedAt and metrics
 * to any unauthenticated caller who POSTed any path at all — a fingerprint
 * handed over on request, on a wire whose whole premise is that a peer cannot
 * tell a rappter from a brainstem from a person.
 *
 * Same branch `POST /chat?x=1` fell into before #92 matched the route on the
 * path, which let a caller skip the entire request contract and be told it had
 * succeeded.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GatewayServer } from '../server.js';
import type { AgentRequest } from '../types.js';

const PORT = 19813;
const BASE = `http://127.0.0.1:${PORT}`;

let server: GatewayServer;
let dataDir: string;

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'gw-404-'));
  server = new GatewayServer({
    port: PORT,
    bind: 'loopback',
    auth: { mode: 'none' },
    heartbeatInterval: 60000,
    dataDir,
  });
  server.setAgentHandler(async (req: AgentRequest) => ({
    sessionId: req.sessionId ?? 'gen',
    content: `Echo: ${req.message}`,
    finishReason: 'stop',
  }));
  await server.start();
});

afterAll(async () => {
  await server.stop();
  rmSync(dataDir, { recursive: true, force: true });
});

async function post(target: string, raw: string) {
  const res = await fetch(BASE + target, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Connection: 'close' },
    body: raw,
  });
  const text = await res.text();
  let body: unknown;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body, text };
}

describe('a path this runtime does not implement', () => {
  // /twin motivated this check and is deliberately NOT in this list any more:
  // it was implemented in #96, so it is no longer an unknown path. The property
  // under test is "a path this runtime does not implement answers 404", and
  // /twin now answers 400 to a malformed envelope, which is the /twin contract
  // rather than a regression here. Removing it is the honest update; leaving it
  // would mean asserting an endpoint stays missing.
  for (const target of ['/definitely-not-real', '/rm-rf', '/chatter']) {
    it(`answers 404 for ${target}`, async () => {
      const got = await post(target, '{"schema":"rapp-twin-chat/1.0","kind":"say"}');
      expect(got.status).toBe(404);
      expect(got.text).not.toContain('Received:');
    });
  }

  it('leaks no identity or state to an unauthenticated probe', async () => {
    const got = await post('/definitely-not-real', '{}');
    // The old body carried all of these to anyone who asked, on any path.
    for (const leak of ['uptime', 'version', 'startedAt', 'port', 'metrics', 'connections']) {
      expect(got.text, `${leak} leaked`).not.toContain(leak);
    }
  });
});

describe('the paths it does implement are unaffected', () => {
  it('still answers /chat', async () => {
    const got = await post('/chat', '{"user_input":"hello","session_id":"n404-1"}');
    expect(got.status).toBe(200);
    expect((got.body as Record<string, unknown>).response).toBe('Echo: hello');
  });

  it('still validates /chat rather than 404-ing it', async () => {
    const got = await post('/chat', '{"user_input":123}');
    expect(got.status).toBe(400);
    expect(got.body).toEqual({ error: 'user_input must be a string' });
  });

  it('still treats /chat with a query string as /chat', async () => {
    const got = await post('/chat?x=1', '{"user_input":"hi","conversation_history":"nope"}');
    expect(got.status).toBe(400);
    expect(got.body).toEqual({ error: 'conversation_history must be an array' });
  });
});
