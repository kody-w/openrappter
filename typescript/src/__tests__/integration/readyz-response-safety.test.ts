/**
 * `GET /readyz` must not be able to kill the gateway.
 *
 * The handler stringified its report as the argument to `res.end()`, which runs
 * *after* `res.writeHead()` has already committed a status line. A readiness
 * report that cannot be serialised therefore threw with the reply half sent,
 * and the `.catch()` attached to that promise then called `res.writeHead()` a
 * second time on the same response.
 *
 * That is `ERR_HTTP_HEADERS_SENT` raised inside a `void`-discarded promise. The
 * TypeScript source installs no `unhandledRejection` handler, and node 20
 * terminates on an unhandled rejection, so a single request to `/readyz` took
 * the whole daemon down. Verified before the fix: the process died without
 * reaching the next line of the probe.
 *
 * This is the same defect as the Python dispatch guard in #358 -- an error path
 * writing a second response over a reply already in flight -- except that here
 * the consequence is the process exiting rather than one corrupted reply.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { GatewayServer } from '../../gateway/server.js';
import type { GatewayReadiness } from '../../gateway/server.js';

let server: GatewayServer | undefined;

afterEach(async () => {
  await server?.stop();
  server = undefined;
});

/** A report that `JSON.stringify` refuses: it contains itself. */
function unserialisableReport(): GatewayReadiness {
  const report: Record<string, unknown> = { ready: true, status: 'ready' };
  report.self = report;
  return report as unknown as GatewayReadiness;
}

async function startGateway(
  provider?: () => Promise<GatewayReadiness>,
): Promise<number> {
  server = new GatewayServer({ port: 0, bind: 'loopback', auth: { mode: 'none' } });
  if (provider) server.setReadinessProvider(provider);
  await server.start();
  const port = server.port;
  return port;
}

describe('/readyz with a report that cannot be serialised', () => {
  it('answers rather than writing a second set of headers', async () => {
    const port = await startGateway(async () => unserialisableReport());

    const res = await fetch(`http://127.0.0.1:${port}/readyz`, {
      signal: AbortSignal.timeout(5000),
    });
    expect(res.status).toBe(503);
    const body = await res.json() as { reason?: string };
    expect(body.reason).toBe('readiness_check_failed');
  });

  it('leaves the gateway serving afterwards', async () => {
    const port = await startGateway(async () => unserialisableReport());

    await fetch(`http://127.0.0.1:${port}/readyz`, { signal: AbortSignal.timeout(5000) })
      .catch(() => undefined);

    // THE POINT: before the fix the process was gone by now, so this request
    // had nothing to talk to.
    const live = await fetch(`http://127.0.0.1:${port}/livez`, {
      signal: AbortSignal.timeout(5000),
    });
    expect(live.status).toBe(200);
  });

  it('survives the failure repeatedly, not just once', async () => {
    const port = await startGateway(async () => unserialisableReport());

    for (let i = 0; i < 3; i += 1) {
      const res = await fetch(`http://127.0.0.1:${port}/readyz`, {
        signal: AbortSignal.timeout(5000),
      });
      expect(res.status, `request ${i + 1}`).toBe(503);
    }
  });
});

describe('/readyz on a healthy gateway', () => {
  it('still reports ready', async () => {
    // Anti-vacuity: serialising before the write must not change the answer.
    const port = await startGateway(async () => ({ ready: true, status: 'ready' }));

    const res = await fetch(`http://127.0.0.1:${port}/readyz`, {
      signal: AbortSignal.timeout(5000),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { ready: boolean; timestamp?: string };
    expect(body.ready).toBe(true);
    expect(body.timestamp, 'the timestamp is added by the handler').toBeTruthy();
  });

  it('reports 503 for a genuinely degraded report', async () => {
    const port = await startGateway(async () => ({
      ready: false,
      status: 'degraded',
      reason: 'something_specific',
    }));

    const res = await fetch(`http://127.0.0.1:${port}/readyz`, {
      signal: AbortSignal.timeout(5000),
    });
    expect(res.status).toBe(503);
    const body = await res.json() as { reason?: string };
    // The real reason survives; it is not replaced by the catch-all.
    expect(body.reason).toBe('something_specific');
  });
});
