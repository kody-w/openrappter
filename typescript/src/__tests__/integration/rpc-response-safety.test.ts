/**
 * A response body that cannot be serialised must not end the process.
 *
 * `res.end(JSON.stringify(x))` evaluates `JSON.stringify` *after*
 * `res.writeHead` has committed a status line. A value it refuses -- a cycle, a
 * BigInt -- therefore throws with the reply already begun, and every such site
 * sits in a `try` whose `catch` writes a second status line onto the same
 * response. That is `ERR_HTTP_HEADERS_SENT` in an async handler, which node 20
 * turns into an unhandled rejection and exits on.
 *
 * #359 fixed `/readyz`, where the bad value came from `setReadinessProvider`.
 * This covers `/rpc`, where it comes from `registerMethod` -- the extension
 * point plugins use, so the input is not contrived. Verified against a running
 * gateway before the fix: the probe never reached the line after the request.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { GatewayServer } from '../../gateway/server.js';
import { RPC_ERROR } from '../../gateway/types.js';

let server: GatewayServer | undefined;

afterEach(async () => {
  await server?.stop();
  server = undefined;
});

/** A value `JSON.stringify` refuses: it contains itself. */
function cyclic(): Record<string, unknown> {
  const value: Record<string, unknown> = { ok: true };
  value.self = value;
  return value;
}

async function startWithMethod(result: () => unknown): Promise<number> {
  server = new GatewayServer({ port: 0, bind: 'loopback', auth: { mode: 'none' } });
  server.registerMethod('plugin.result', async () => result());
  await server.start();
  const port = server.port;
  return port;
}

async function callRpc(port: number, method: string): Promise<{
  status: number;
  body: Record<string, unknown>;
}> {
  const res = await fetch(`http://127.0.0.1:${port}/rpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 7, method, params: {} }),
    signal: AbortSignal.timeout(5000),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe('an RPC method returning a value that cannot be serialised', () => {
  it('answers a JSON-RPC error rather than writing a second status line', async () => {
    const port = await startWithMethod(cyclic);

    const { status, body } = await callRpc(port, 'plugin.result');
    // HTTP 200, like every other JSON-RPC-level failure on this endpoint. A
    // client that checks the status before parsing must see this the same way
    // it sees a timeout, not as a transport error.
    expect(status).toBe(200);
    const error = body.error as { code?: number; message?: string } | undefined;
    expect(error?.code).toBe(RPC_ERROR.INTERNAL_ERROR);
    // The id is echoed so a caller can still correlate the failure.
    expect(body.id).toBe(7);
  });

  it('leaves the gateway serving afterwards', async () => {
    const port = await startWithMethod(cyclic);
    await callRpc(port, 'plugin.result').catch(() => undefined);

    // THE POINT: before the fix the process was gone, so this had nothing to
    // talk to.
    const live = await fetch(`http://127.0.0.1:${port}/livez`, {
      signal: AbortSignal.timeout(5000),
    });
    expect(live.status).toBe(200);
  });

  it('survives it repeatedly', async () => {
    const port = await startWithMethod(cyclic);
    for (let i = 0; i < 3; i += 1) {
      const { status } = await callRpc(port, 'plugin.result');
      expect(status, `call ${i + 1}`).toBe(200);
    }
  });

  it('a BigInt is refused the same way as a cycle', async () => {
    // A different reason for the same failure, so the fix is not tied to
    // cycles specifically.
    const port = await startWithMethod(() => ({ big: BigInt(1) }));
    const { status, body } = await callRpc(port, 'plugin.result');
    expect(status).toBe(200);
    expect((body.error as { code?: number })?.code).toBe(RPC_ERROR.INTERNAL_ERROR);

    const live = await fetch(`http://127.0.0.1:${port}/livez`, {
      signal: AbortSignal.timeout(5000),
    });
    expect(live.status).toBe(200);
  });
});

describe('an RPC method returning an ordinary value', () => {
  it('still answers 200 with the result', async () => {
    // Anti-vacuity: serialising before the write must not change the answer.
    const port = await startWithMethod(() => ({ hello: 'world' }));

    const { status, body } = await callRpc(port, 'plugin.result');
    expect(status).toBe(200);
    expect(body.result).toEqual({ hello: 'world' });
    expect(body.id).toBe(7);
  });
});

describe('every JSON-RPC-level failure answers with the same HTTP status', () => {
  /**
   * The endpoint carries RPC faults in the `error` member and keeps HTTP 200
   * for all of them; 401 is the single exception and it is a transport refusal
   * rather than an RPC result.
   *
   * Tested as a rule over several failures rather than asserted once, because
   * #361 added a fourth failure mode and gave it a 500 without noticing the
   * three beside it. A client that checks the status before parsing would have
   * read that one as a transport error and the rest as RPC errors.
   */
  it.each([
    ['a method that does not exist', 'no.such.method', () => ({ fine: true })],
    ['a method that throws', 'plugin.result', () => { throw new Error('boom'); }],
    ['a result that cannot be serialised', 'plugin.result', cyclic],
  ])('%s answers 200 with an error member', async (_label, method, result) => {
    const port = await startWithMethod(result);

    const { status, body } = await callRpc(port, method);
    expect(status).toBe(200);
    expect(body.error, 'the fault belongs in the error member').toBeTruthy();
    expect(body.id).toBe(7);
  });
});
