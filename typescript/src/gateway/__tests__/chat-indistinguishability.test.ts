/**
 * Can a peer tell which runtime answered? — asked of the real server.
 *
 * THIS FILE REPLACES ONE THAT PROVED NOTHING.
 *
 * A previous version asserted against `parseChatRequest` and a local
 * `asFlaskWouldSee()` helper written inside the test file. Both defects it
 * claimed to cover lived in `server.ts` — in how a rejection is WRITTEN and how
 * a request target is MATCHED — so the tests exercised a pure function and a
 * re-implementation of the correct behaviour. Checked out at the parent commit,
 * all fourteen passed against the broken code.
 *
 * That is the same failure as the bug they were written for, one level up: a
 * check that is its own witness. So these boot an actual GatewayServer and read
 * the actual bytes off an actual socket, and the negative control is part of the
 * job — a test that cannot fail on the old code is decoration.
 *
 * Ground truth WAS STATED HERE INCORRECTLY, and the correction is the reason
 * this header is long.
 *
 * It read: "Ground truth is `brainstem.py`, whose rejection is
 * `return jsonify({"error": ...}), 400` — one key, nothing else."
 *
 * No such brainstem is in this repository. `python/openrappter/brainstem.py`
 * imports no Flask, contains no `jsonify`, and answers through `_send`; its
 * rejections carry `schema`, `status` and `error`. That was checked by posting
 * every body below to the running brainstem and reading the keys back, which is
 * the check the sentence above replaced.
 *
 * So this file asserted a one-key body to avoid a fingerprint and thereby
 * created one: four of five malformed requests separated the runtimes.
 *
 * Ground truth is now `contracts/rapp-chat-v1.json`, which both runtimes are
 * tested against -- here and in `python/tests/test_openrappter_brainstem.py` --
 * so neither can be adjusted toward a belief about the other again.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GatewayServer } from '../server.js';
import type { AgentRequest } from '../types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = 19811;
const BASE = `http://127.0.0.1:${PORT}`;

let server: GatewayServer;
let dataDir: string;

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'gw-indist-'));
  server = new GatewayServer({
    port: PORT,
    bind: 'loopback',
    // Open, as the brainstem is to a loopback caller. Otherwise every request
    // under test is answered by the auth gate instead of the contract, and the
    // contract is what is on trial.
    auth: { mode: 'none' },
    heartbeatInterval: 60000,
    dataDir,
  });
  server.setAgentHandler(async (req: AgentRequest) => ({
    sessionId: req.sessionId ?? 'generated',
    content: `Echo: ${req.message}`,
    finishReason: 'stop',
  }));
  await server.start();
});

afterAll(async () => {
  await server.stop();
  rmSync(dataDir, { recursive: true, force: true });
});

/** Send a raw string body, exactly as a foreign client would. */
async function post(target: string, raw: string): Promise<{ status: number; body: unknown; text: string }> {
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

interface ErrorContract {
  response: { error: { required: string[]; properties: Record<string, string> } };
}
const CONTRACT: ErrorContract = JSON.parse(
  readFileSync(resolve(__dirname, '../../../../contracts/rapp-chat-v1.json'), 'utf-8'),
);

/** The rejection body the contract fixes, with `error` filled in. */
function contractRejects(error: string): { status: number; body: Record<string, unknown> } {
  const body: Record<string, unknown> = {};
  for (const key of CONTRACT.response.error.required) {
    const spec = CONTRACT.response.error.properties[key];
    body[key] = key === 'error' ? error : spec;
  }
  return { status: 400, body };
}

const REJECTIONS: Array<[label: string, raw: string, error: string]> = [
  ['a non-object body', '[]', 'Request body must be a JSON object'],
  ['a bare string body', '"hello"', 'Request body must be a JSON object'],
  ['unparseable JSON', 'not json at all', 'Request body must be a JSON object'],
  ['a non-string user_input', '{"user_input":123}', 'user_input must be a string'],
  ['a null user_input', '{"user_input":null}', 'user_input must be a string'],
  ['whitespace-only input', '{"user_input":"   "}', 'user_input is required'],
  ['no input at all', '{}', 'user_input is required'],
  ['a non-array history', '{"user_input":"hi","conversation_history":"nope"}', 'conversation_history must be an array'],
  ['a non-object history entry', '{"user_input":"hi","conversation_history":["x"]}', 'conversation_history[0] must be an object'],
  ['an unknown history role', '{"user_input":"hi","conversation_history":[{"role":"bogus","content":"x"}]}', 'conversation_history[0].role is invalid'],
  ['non-string history content', '{"user_input":"hi","conversation_history":[{"role":"tool","content":123}]}', 'conversation_history[0].content must be a string'],
];

describe('a rejection carries nothing that names the runtime', () => {
  for (const [label, raw, error] of REJECTIONS) {
    it(`rejects ${label} with the brainstem's whole body`, async () => {
      const got = await post('/chat', raw);
      // The assertion the old instrument could not make: the WHOLE body.
      // Comparing only `.error` passed while `schema` and `status` sat beside it.
      expect({ status: got.status, body: got.body }).toEqual(contractRejects(error));
      expect(Object.keys(got.body as object).sort())
        .toEqual([...CONTRACT.response.error.required].sort());
    });
  }

  it('leaks no fingerprint key on any rejection', async () => {
    for (const [, raw] of REJECTIONS) {
      const got = await post('/chat', raw);
      // Anything the contract does not declare is a tell: it is a key one
      // runtime emits and the other has no reason to.
      const declared = new Set(Object.keys(CONTRACT.response.error.properties));
      for (const key of Object.keys(got.body as object)) {
        expect(declared.has(key), `undeclared key ${key} for body ${raw}`).toBe(true);
      }
      for (const tell of ['content', 'response', 'model', 'agent_logs']) {
        expect(got.body, `${tell} present for body ${raw}`).not.toHaveProperty(tell);
      }
    }
  });
});

describe('a query string does not change which endpoint this is', () => {
  // The target the old instrument never sent. Before the fix this fell past the
  // /chat handler entirely and was answered 200 `Received: …`, so a caller could
  // skip every rule in the contract by appending ?x=1 and be told it worked.
  for (const target of ['/chat?x=1', '/chat?debug=true&x=2', '/chat?']) {
    it(`validates ${target} exactly as /chat`, async () => {
      const got = await post(target, '{"user_input":"hi","conversation_history":"nope"}');
      expect({ status: got.status, body: got.body })
        .toEqual(contractRejects('conversation_history must be an array'));
      // The old fallthrough is unmistakable in the bytes.
      expect(got.text).not.toContain('Received:');
    });
  }

  it('still answers a well-formed request sent through a query string', async () => {
    const got = await post('/chat?x=1', '{"user_input":"hello","session_id":"qs-1"}');
    expect(got.status).toBe(200);
    const body = got.body as Record<string, unknown>;
    expect(body.response).toBe('Echo: hello');
    expect(body.session_id).toBe('qs-1');
  });

  it('does not treat a neighbouring path as /chat', async () => {
    const got = await post('/chatter', '{"user_input":123}');
    expect(got.body).not.toEqual({ error: 'user_input must be a string' });
  });
});

describe('the success envelope still carries what its own callers read', () => {
  // The extra axes are legitimate on success (PARITY §3). This is here so that
  // tightening the ERROR body cannot quietly strip the success body too.
  it('keeps schema, status and the six frozen keys', async () => {
    const got = await post('/chat', '{"user_input":"hello","session_id":"s-1"}');
    expect(got.status).toBe(200);
    const body = got.body as Record<string, unknown>;
    for (const k of ['response', 'session_id', 'agent_logs', 'voice_mode', 'model', 'requested_model']) {
      expect(body, `missing ${k}`).toHaveProperty(k);
    }
    expect(body.schema).toBe('rapp-chat/1.0');
    expect(body.status).toBe('success');
    expect(body).not.toHaveProperty('assistant_response');
  });
});
