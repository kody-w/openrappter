/**
 * The gateway must be able to say which port it is actually on.
 *
 * listen(0) asks the kernel to pick a free port. Nothing read that choice back,
 * so config.port stayed 0 and every reader of it -- the startup log, getStatus(),
 * /status, the UI's live signals -- reported a port the server was not on.
 *
 * The practical consequence was in the test suite. Because a server started on
 * port 0 could not tell you where it was, no test could talk HTTP or WebSocket
 * to one, so 33 test files instead pre-reserved a port by binding it, closing
 * it, and handing the bare number to the server to bind again. That leaves a
 * window in which anything can take the port, and on 2026-08-19 it did:
 *
 *     gateway-observability.test.ts > ... : Gateway server started on 127.0.0.1:36297
 *     gateway.test.ts > should respond to GET /health
 *       Gateway server error: listen EADDRINUSE: address already in use 127.0.0.1:36297
 *
 * Two vitest worker processes were handed the same port, and the reservation
 * helper's de-duplication set is per-process, so it could not have helped.
 * Reading the bound port back removes the need to guess at all.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { GatewayServer } from '../server.js';

let server: GatewayServer | null = null;

afterEach(async () => {
  if (server) {
    await server.stop();
    server = null;
  }
});

function startOnEphemeralPort(): GatewayServer {
  return new GatewayServer({ port: 0, bind: 'loopback', auth: { mode: 'none' } });
}

describe('the port a gateway reports', () => {
  it('is the one the kernel chose, not the zero it was asked for', async () => {
    server = startOnEphemeralPort();
    await server.start();

    expect(server.port).toBeGreaterThan(0);
    expect(server.port).toBeLessThanOrEqual(65535);
  });

  it('is a port the server can actually be reached on', async () => {
    server = startOnEphemeralPort();
    await server.start();

    const res = await fetch(`http://127.0.0.1:${server.port}/health`);
    expect(res.status).toBe(200);
  });

  it('is what /status reports, so callers are not told 0', async () => {
    server = startOnEphemeralPort();
    await server.start();

    const res = await fetch(`http://127.0.0.1:${server.port}/status`);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.port).toBe(server.port);
    expect(body.port).not.toBe(0);
  });

  it('is what getStatus() reports', async () => {
    server = startOnEphemeralPort();
    await server.start();

    expect(server.getStatus().port).toBe(server.port);
  });

  it('is what the anatomy view shows, which renders the number directly', async () => {
    // anatomy.ts renders `port ${live.port ?? 18790}`. Zero is not nullish, so
    // a server that reported its configured port here would display "port 0".
    server = startOnEphemeralPort();
    await server.start();

    const res = await fetch(`http://127.0.0.1:${server.port}/anatomy.json`);
    const body = await res.text();
    expect(body).toContain(`port ${server.port}`);
    expect(body).not.toContain('port 0');
  });

  it('is left alone when a real port was configured', async () => {
    const probe = startOnEphemeralPort();
    await probe.start();
    const free = probe.port;
    await probe.stop();

    server = new GatewayServer({ port: free, bind: 'loopback', auth: { mode: 'none' } });
    await server.start();
    expect(server.port).toBe(free);
  });

  it('does not keep claiming a port after the server has stopped', async () => {
    const stopped = startOnEphemeralPort();
    await stopped.start();
    expect(stopped.port).toBeGreaterThan(0);

    await stopped.stop();
    expect(stopped.port).toBe(0);
  });

  it('releases the port on stop, so the same one can be bound again', async () => {
    // Several restart tests used to imply this by rebinding a fixed port after
    // stop(). Those now take a fresh kernel-assigned port on restart, so the
    // property they were incidentally covering is asserted here on purpose.
    const first = startOnEphemeralPort();
    await first.start();
    const released = first.port;
    await first.stop();

    server = new GatewayServer({ port: released, bind: 'loopback', auth: { mode: 'none' } });
    await server.start();
    expect(server.port).toBe(released);

    const res = await fetch(`http://127.0.0.1:${released}/health`);
    expect(res.status).toBe(200);
  });

  it('reports two concurrently running servers as being on different ports', async () => {
    const first = startOnEphemeralPort();
    const second = startOnEphemeralPort();
    await first.start();
    await second.start();
    try {
      expect(first.port).not.toBe(second.port);
    } finally {
      await first.stop();
      await second.stop();
    }
  });
});
