/**
 * The fourth endpoint with one root cause: `JSON.stringify` evaluated after
 * `res.writeHead` has already committed the reply.
 *
 * `/agents/import` answers with whatever `setAgentImporter` returned. That is a
 * public injection point, so the value is caller-supplied, and a value
 * `JSON.stringify` refuses threw with the response already begun. The outer
 * catch around the body handler then wrote a *second* status line, which is
 * `ERR_HTTP_HEADERS_SENT` inside an async handler -- an unhandled rejection,
 * which node 20 exits on. Verified against a running gateway before the fix:
 * the client received no response at all and the daemon left with code 1.
 *
 * #359 fixed `/readyz` (`setReadinessProvider`), #361 `/rpc` (`registerMethod`),
 * #362 the WebSocket frame writer. Each was found by looking for the previous
 * one's shape somewhere else, and this site was explicitly left alone in #361 as
 * "not proven reachable" -- so the value here is as much in the second half of
 * the file as the first: the catches can no longer double-write at all.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { ServerResponse } from 'http';
import { GatewayServer, writeJsonResponse } from '../../gateway/server.js';
import { reserveTestPort } from '../support/test-port.js';

let server: GatewayServer | undefined;

afterEach(async () => {
  await server?.stop();
  server = undefined;
});

/** A value `JSON.stringify` refuses: it contains itself. */
function cyclic(): Record<string, unknown> {
  const value: Record<string, unknown> = { status: 'ok' };
  value.self = value;
  return value;
}

async function startWithImporter(result: () => unknown): Promise<number> {
  const port = await reserveTestPort();
  server = new GatewayServer({
    port,
    bind: 'loopback',
    auth: { mode: 'none' },
    dataDir: mkdtempSync(join(tmpdir(), 'import-safety-')),
  });
  server.setAgentImporter(async () => result() as never);
  await server.start();
  return port;
}

async function postImport(port: number): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`http://127.0.0.1:${port}/agents/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filename: 'a.py', contents: 'print(1)' }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe('an import result that cannot be serialised', () => {
  it('answers an error envelope rather than killing the daemon', async () => {
    const port = await startWithImporter(cyclic);

    const { status, body } = await postImport(port);

    // 503, matching this route's own "this daemon cannot install agents": the
    // importer did not produce a usable answer. Not 400 -- the request was
    // fine, and 400 is what the outer catch used to report for this.
    expect(status).toBe(503);
    expect(body.status).toBe('error');
    expect(body.error).toBe('Import result could not be serialised');
  });

  it('leaves the server answering afterwards', async () => {
    const port = await startWithImporter(cyclic);

    await postImport(port);
    const health = await fetch(`http://127.0.0.1:${port}/health`);

    // The pre-fix failure was not a bad reply, it was no reply and no process.
    expect(health.status).toBe(200);
  });

  it('survives it repeatedly', async () => {
    const port = await startWithImporter(cyclic);

    for (let i = 0; i < 3; i++) {
      const { status } = await postImport(port);
      expect(status, `call ${i + 1}`).toBe(503);
    }
  });

  it('refuses a BigInt the same way as a cycle', async () => {
    const port = await startWithImporter(() => ({ status: 'ok', big: BigInt(1) }));

    const { status, body } = await postImport(port);

    expect(status).toBe(503);
    expect(body.error).toBe('Import result could not be serialised');
  });

  it('still returns a serialisable result unchanged', async () => {
    const port = await startWithImporter(() => ({ status: 'ok', agent: 'a.py' }));

    const { status, body } = await postImport(port);

    // The guard must not have swallowed the normal path.
    expect(status).toBe(200);
    expect(body).toEqual({ status: 'ok', agent: 'a.py' });
  });

  it('reports an importer error with the route status, not the fallback', async () => {
    const port = await startWithImporter(() => ({ status: 'error', error: 'name taken' }));

    const { status, body } = await postImport(port);

    // A serialisable failure is the importer's own answer and keeps its 400.
    expect(status).toBe(400);
    expect(body.error).toBe('name taken');
  });
});

describe('writeJsonResponse on an already-committed response', () => {
  /**
   * The property the three catches around the body handler now depend on.
   * Before this, the file contained zero `res.headersSent` checks, so a catch
   * reached after its route had already answered wrote a second status line --
   * which is the actual mechanism that ended the process, rather than the
   * serialisation failure that led there.
   */
  function fakeResponse(headersSent: boolean): {
    calls: string[];
    res: ServerResponse;
  } {
    const calls: string[] = [];
    const res = {
      headersSent,
      writeHead(): unknown { calls.push('writeHead'); return res; },
      end(payload?: unknown): unknown {
        calls.push(payload === undefined ? 'end()' : 'end(body)');
        return res;
      },
    };
    return { calls, res: res as unknown as ServerResponse };
  }

  it('writes head and body when nothing has been sent', () => {
    const { calls, res } = fakeResponse(false);

    writeJsonResponse(res, 200, { ok: true });

    expect(calls).toEqual(['writeHead', 'end(body)']);
  });

  it('closes the response without a second head once headers are sent', () => {
    const { calls, res } = fakeResponse(true);

    writeJsonResponse(res, 500, { error: 'too late' });

    // No second status line: that is ERR_HTTP_HEADERS_SENT, and in an async
    // handler node 20 exits on it. The response is ended so the socket is not
    // left open instead.
    expect(calls).toEqual(['end()']);
  });
});
