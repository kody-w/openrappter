/**
 * Every POST route into a sink demands the gateway credential. — #119 / #113
 *
 * Three routes share one dispatch block: `/chat`, `/twin`, `/agents/import`.
 * They were fixed one at a time, each after someone found it:
 *
 *   #113  `/twin` reached the agent handler with no credential.
 *   #119  `/agents/import` reached the IMPORTER with no credential — and its
 *         sink is not model spend but code execution. `contents` is written to
 *         disk and loaded via `spec.loader.exec_module`, so top-level code in
 *         an uploaded `.py` runs as the daemon user.
 *
 * Measured before #119, on a token-mode server with spies and no credential:
 *
 *   /chat           no token -> 401  | agent ran:    false
 *   /agents/import  no token -> 400  | IMPORTER RAN: true
 *
 * The 400 was the importer's own validation error. It had already been handed
 * the payload. A caller shown a failure after execution is the defect, not a
 * mitigation of it.
 *
 * Fixing routes one at a time is how the second one survived the first. So this
 * pins the SET: every path in that dispatch block must answer 401 unauthenticated
 * and must not reach its sink. A new route will fail here until someone decides,
 * deliberately, what its credential policy is.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GatewayServer } from '../server.js';

const PORT = 18_796;
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'SECRET-TOKEN';

let server: GatewayServer;
let dataDir: string;
let agentRan = false;
let importerRan = false;

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'gw-auth-'));
  server = new GatewayServer({
    port: PORT, bind: 'loopback',
    auth: { mode: 'token', tokens: [TOKEN] },
    heartbeatInterval: 60_000, dataDir,
  });
  server.setAgentHandler(async () => {
    agentRan = true;
    return { sessionId: 's', content: 'AGENT RAN', finishReason: 'stop' };
  });
  // A SPY importer. It records that it was reached and executes nothing — the
  // real one loads the file, which is the whole point of the issue.
  server.setAgentImporter(async (filename: string) => {
    importerRan = true;
    return { status: 'error' as const, error: `spy saw ${filename}` };
  });
  await server.start();
});

afterAll(async () => {
  await server.stop();
  rmSync(dataDir, { recursive: true, force: true });
});

const hex = (n: number) => 'a'.repeat(n);
const RAPPID = (slug: string) => `rappid:@stranger/${slug}:${hex(64)}`;

/** A well-formed body for each route, so a 401 cannot be mistaken for a 400. */
const ROUTES: Array<{ path: string; body: unknown }> = [
  { path: '/chat', body: { user_input: 'hi', conversation_history: [], session_id: 's' } },
  {
    path: '/twin',
    body: {
      schema: 'rapp-twin-chat/1.0',
      from_rappid: RAPPID('stranger'),
      to_rappid: RAPPID('alpha'),
      utc: '2026-08-05T14:00:00Z',
      nonce: 'f'.repeat(32),
      kind: 'say',
      payload: { text: 'hello' },
      facets: [],
    },
  },
  { path: '/agents/import', body: { filename: 'x.py', contents: 'print(1)' } },
];

async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Connection: 'close', ...headers },
    body: JSON.stringify(body),
  });
}

describe('the gateway credential covers every POST route into a sink', () => {
  for (const { path, body } of ROUTES) {
    it(`${path} answers 401 without a credential, and its sink is not reached`, async () => {
      agentRan = false;
      importerRan = false;

      const res = await post(path, body);

      expect(res.status).toBe(401);
      // The status is the smaller half. What matters is that nothing ran: a 401
      // returned after the payload was already executed would be worse than the
      // defect it claims to fix.
      expect(agentRan).toBe(false);
      expect(importerRan).toBe(false);
    });

    it(`${path} still works with the credential`, async () => {
      const res = await post(path, body, { Authorization: `Bearer ${TOKEN}` });
      // Not asserting 200 — `/agents/import` legitimately 400s here because the
      // spy declines. Asserting only that the credential is no longer what
      // stops it.
      expect(res.status).not.toBe(401);
    });
  }

  it('tells an unauthenticated caller nothing about the request body', async () => {
    // Each gate runs before its own parsing and before `/agents/import`'s
    // "this daemon cannot install agents" 503, so a stranger cannot use the
    // error shapes to probe the wire format or to learn what this daemon can do.
    for (const { path } of ROUTES) {
      const res = await post(path, { total: 'nonsense' });
      expect(res.status, path).toBe(401);
    }
  });

  it('pins the set of POST routes, so a new one cannot be added ungated', async () => {
    // #113 and #119 were the same omission found twice, because each was fixed
    // as an individual route rather than as a rule.
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join: pjoin } = await import('node:path');
    const source = readFileSync(
      pjoin(dirname(fileURLToPath(import.meta.url)), '..', 'server.ts'),
      'utf8',
    );

    // Scope to the POST dispatch block. The first version of this test matched
    // every `pathOnly ===` in the file and failed on /anatomy, /anatomy.json,
    // /bones and /bones/ — all GET, all read-only, none of them sinks. An
    // instrument that cannot tell a sink from a status page would be noise.
    const postBlock = source.slice(source.indexOf("if (req.method === 'POST') {"));
    const declared = [...postBlock.matchAll(/pathOnly === '([^']+)'/g)].map((m) => m[1]);

    expect(new Set(declared)).toEqual(new Set(['/chat', '/twin', '/agents/import']));
  });
});
