/**
 * The `sessions` CLI called four methods; three of them did not exist.
 *
 * `sessions.list`, `sessions.get` and `sessions.delete` are not registered by
 * the gateway at all -- the chat-session methods are named `chat.*`. The
 * fourth, `sessions.reset`, *is* registered but reads `sessionId`/`sessionKey`
 * while the CLI sent `{ id }`, so it threw `sessionKey required` every time.
 * All four subcommands failed, and the module was left unregistered rather
 * than fixed (#206).
 *
 * These tests drive a real `GatewayServer` with the exact parameter names the
 * CLI now sends. Asserting against the source of `cli/sessions.ts` would only
 * prove the file says what I think it says; asserting against a live gateway
 * proves the contract holds -- which is the thing that was broken.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { GatewayServer } from '../../gateway/server.js';

let server: GatewayServer | undefined;
let dataDir: string | undefined;

afterEach(async () => {
  await server?.stop();
  server = undefined;
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  dataDir = undefined;
});

type Handler = (params: unknown, ctx: unknown) => Promise<unknown>;

/** Start a gateway and return a direct caller for its registered methods. */
async function startGateway(): Promise<(m: string, p?: unknown) => Promise<unknown>> {
  // A dataDir is mandatory here, not tidiness. GatewayServer defaults to
  // ~/.openrappter and loads sessions.json from it, so a test without one
  // reads the developer's real sessions -- and `chat.session` + saveSessions()
  // write test fixtures back into them. The first run of this file left two
  // sessions named s1 and s2 in a real store holding 27 of them.
  dataDir = mkdtempSync(join(tmpdir(), 'openrappter-sessions-test-'));
  server = new GatewayServer({ port: 0, bind: 'loopback', auth: { mode: 'none' }, dataDir });
  await server.start();
  const methods = (server as unknown as { methods: Map<string, { handler: Handler }> }).methods;

  return async (method: string, params: unknown = {}) => {
    const entry = methods.get(method);
    if (!entry) throw new Error(`Method '${method}' not found`);
    return entry.handler(params, { authenticated: true });
  };
}

/** The exact method names and parameter shapes `cli/sessions.ts` sends. */
const CLI_CONTRACT = {
  list: { method: 'chat.list', params: undefined },
  show: { method: 'chat.messages', params: { sessionId: 'x' } },
  delete: { method: 'chat.delete', params: { sessionId: 'x' } },
  reset: { method: 'sessions.reset', params: { sessionId: 'x' } },
};

describe('sessions CLI contract', () => {
  it('every method the CLI calls is registered', async () => {
    const call = await startGateway();
    const missing: string[] = [];

    for (const { method } of Object.values(CLI_CONTRACT)) {
      const methods = (server as unknown as { methods: Map<string, unknown> }).methods;
      if (!methods.has(method)) missing.push(method);
    }

    // Before the fix this list was ['sessions.list','sessions.get','sessions.delete'].
    expect(missing).toEqual([]);
    expect(await call('chat.list')).toEqual([]);
  });

  it('creates, lists, reads, resets and deletes a session end to end', async () => {
    const call = await startGateway();

    const created = (await call('chat.session', { sessionId: 's1' })) as { id: string };
    expect(created.id).toBe('s1');

    const listed = (await call('chat.list')) as Array<{ id: string; messageCount: number }>;
    expect(listed.map((s) => s.id)).toContain('s1');

    // `show` reads messages, and must not resurrect a missing session.
    expect(await call('chat.messages', { sessionId: 's1' })).toEqual([]);

    const reset = (await call('sessions.reset', { sessionId: 's1' })) as {
      reset: boolean;
      clearedMessages: number;
    };
    expect(reset.reset).toBe(true);
    expect(reset.clearedMessages).toBe(0);

    const deleted = (await call('chat.delete', { sessionId: 's1' })) as { deleted: boolean };
    expect(deleted.deleted).toBe(true);

    // And the delete really happened.
    expect((await call('chat.list')) as unknown[]).toEqual([]);
  });

  it('reports a delete that removed nothing, instead of claiming success', async () => {
    const call = await startGateway();

    // The old CLI printed "Deleted session: <id>" unconditionally. The gateway
    // has always said otherwise, and the CLI now reads the answer.
    const result = (await call('chat.delete', { sessionId: 'never-existed' })) as {
      deleted: boolean;
    };
    expect(result.deleted).toBe(false);
  });

  it('rejects the parameter name the old CLI sent', async () => {
    const call = await startGateway();
    await call('chat.session', { sessionId: 's2' });

    // `{ id }` was the bug: resolveSessionId reads sessionId ?? sessionKey, so
    // `id` resolves to undefined and reset throws. Pinning this keeps the CLI
    // from drifting back to a name the gateway does not read.
    await expect(call('sessions.reset', { id: 's2' })).rejects.toThrow(/sessionKey required/);

    // ...and the correct name works on the very same session.
    const ok = (await call('sessions.reset', { sessionId: 's2' })) as { reset: boolean };
    expect(ok.reset).toBe(true);
  });

  it('show does not create the session it was asked to display', async () => {
    const call = await startGateway();

    // chat.session is getOrCreateSession; using it for `show` would report an
    // empty session into existence for a typo'd id. chat.messages throws.
    await expect(call('chat.messages', { sessionId: 'typo' })).rejects.toThrow(/not found/i);
    expect((await call('chat.list')) as unknown[]).toEqual([]);
  });

  it('the CLI actually sends these names', () => {
    // The tests above drive the gateway directly, so they would still pass if
    // cli/sessions.ts drifted back to `sessions.list` or `{ id }`. Read what
    // the CLI sends and hold it to the same contract.
    const source = readFileSync(resolve(__dirname, '../../cli/sessions.ts'), 'utf-8');
    const called = [...source.matchAll(/client\.call\(\s*'([^']+)'/g)].map((m) => m[1]).sort();

    expect(called).toEqual(['chat.delete', 'chat.list', 'chat.messages', 'sessions.reset']);

    // Every id it passes must use the name resolveSessionId reads.
    expect(source).not.toMatch(/client\.call\([^)]*\{\s*id\s*[,}]/);
    expect(source.match(/sessionId:/g)?.length).toBeGreaterThanOrEqual(3);
  });
});
