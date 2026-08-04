/**
 * Tests for the test-port allocator.
 *
 * The property that matters is not "returns a number in a plausible range" —
 * the guessing implementation this replaced did that faithfully and still broke
 * CI with EADDRINUSE. What matters is that a returned port is *actually free*
 * and is never handed out twice.
 */
import { describe, it, expect, afterEach } from 'vitest';
import net from 'net';
import type { AddressInfo } from 'net';
import { reserveTestPort, __resetIssuedPortsForTest } from '../support/test-port.js';

function listenOn(port: number): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen({ port, host: '127.0.0.1' }, () => resolve(server));
  });
}

function close(server: net.Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
}

describe('reserveTestPort', () => {
  const opened: net.Server[] = [];

  afterEach(async () => {
    while (opened.length > 0) await close(opened.pop()!);
    __resetIssuedPortsForTest();
  });

  it('returns a port that can actually be bound', async () => {
    const port = await reserveTestPort();
    const server = await listenOn(port);
    opened.push(server);
    expect((server.address() as AddressInfo).port).toBe(port);
  });

  it('never returns a port that is currently held by a live listener', async () => {
    // Hold 20 ports open, then draw 20 more. Under the old guessing scheme this
    // is a birthday draw; under kernel assignment a held port is not offered.
    for (let i = 0; i < 20; i++) opened.push(await listenOn(await reserveTestPort()));
    const held = new Set(opened.map((s) => (s.address() as AddressInfo).port));

    for (let i = 0; i < 20; i++) {
      expect(held.has(await reserveTestPort())).toBe(false);
    }
  });

  it('never returns the same port twice in a process', async () => {
    const seen = new Set<number>();
    for (let i = 0; i < 100; i++) {
      const port = await reserveTestPort();
      expect(seen.has(port)).toBe(false);
      seen.add(port);
    }
    expect(seen.size).toBe(100);
  });

  it('returns a port outside the reserved range', async () => {
    expect(await reserveTestPort()).toBeGreaterThan(1023);
  });

  it('serves concurrent callers distinct ports', async () => {
    const ports = await Promise.all(Array.from({ length: 40 }, () => reserveTestPort()));
    expect(new Set(ports).size).toBe(ports.length);
  });
});
