/**
 * A twin says who it is. — #129
 *
 * `NeighborAgent` built its envelope with a literal `deviceRappid('kody-w',
 * 'alpha')`, so every hatched twin told its neighbours it was the alpha.
 * Measured on a real twin before the fix, read off the wire at the receiver
 * rather than from the sender's own report:
 *
 *   $ openrappter hatch pebble          -> pebble is up on :19057 (pid 24359)
 *   POST /twin  {"from_rappid":"rappid:@kody-w/alpha:f245acdb...",
 *                "to_rappid":"rappid:@kody-w/capture:f6886e04...", ...}
 *
 * and on the /chat fallback, where the same value is the conversation key:
 *
 *   POST /chat  {"session_id":"rappid:@kody-w/alpha:f245acdb...", ...}
 *
 * — so two twins talking to one peer were writing into a single thread that
 * belonged to neither of them.
 *
 * These tests drive the agent against a real listener and read what arrives,
 * for the reason #127 exists: a test that asserts on what the sender believes
 * it sent can pass while the wire says something else.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { vi } from 'vitest';
import { NeighborAgent } from '../../agents/NeighborAgent.js';
import {
  declareCurrentInstance,
  __resetCurrentInstanceForTest,
} from '../../infra/current-instance.js';
import { gatewayEndpointFileFor } from '../../infra/gateway-lock.js';
import { deviceRappid } from '../../twin/send.js';

const servers: Server[] = [];
const homes: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => { s.close(() => r()); })));
  for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true });
  __resetCurrentInstanceForTest();
  vi.unstubAllEnvs();
});

/** A neighbour that records the envelope it was handed. */
async function neighbourNamed(name: string): Promise<{ received: Record<string, unknown>[] }> {
  const received: Record<string, unknown>[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.url === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', version: 'peer', checks: { gateway: true } }));
        return;
      }
      try { received.push({ url: req.url, ...JSON.parse(body) }); } catch { /* ignore */ }
      res.writeHead(200, { 'content-type': 'application/json' });
      // A /twin reply nests: send.ts reads `body.response.response`. A fixture
      // that answers any other shape reports `said: ''` and the agent calls a
      // delivered message an error — which is exactly what a hand-rolled stub
      // did while this was being investigated.
      res.end(JSON.stringify({ response: { response: 'heard' } }));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });

  const port = (server.address() as AddressInfo).port;
  // The roster resolves neighbours by name from a record, so give it one that
  // points at this listener and names the pid actually holding it.
  const file = gatewayEndpointFileFor({ instance: name });
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({
    instance: name, port, pid: process.pid, startedAt: new Date().toISOString(),
  }));
  return { received };
}

function isolatedHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'neighbor-id-'));
  homes.push(home);
  vi.stubEnv('HOME', home);
  return home;
}

describe('a rappter names itself to a neighbour', () => {
  it('speaks as the twin it is, not as the alpha', async () => {
    isolatedHome();
    const peer = await neighbourNamed('peerling');
    declareCurrentInstance('pebble');

    const out = JSON.parse(await new NeighborAgent().perform({
      action: 'say', to: 'peerling', text: 'hello',
    }));
    expect(out.status).toBe('success');

    const envelope = peer.received.at(-1)!;
    expect(envelope.from_rappid).toBe(deviceRappid('kody-w', 'pebble'));
    // The precise failure: it must not be the alpha's.
    expect(envelope.from_rappid).not.toBe(deviceRappid('kody-w', 'alpha'));
    expect(envelope.to_rappid).toBe(deviceRappid('kody-w', 'peerling'));
  });

  it('speaks as the alpha when it is the alpha', async () => {
    // The negative control for the case above. `undefined` is a real answer —
    // the alpha declares it — and must not be confused with never declaring.
    isolatedHome();
    const peer = await neighbourNamed('peerling');
    declareCurrentInstance(undefined);

    const out = JSON.parse(await new NeighborAgent().perform({
      action: 'say', to: 'peerling', text: 'hello',
    }));
    expect(out.status).toBe('success');
    expect(peer.received.at(-1)!.from_rappid).toBe(deviceRappid('kody-w', 'alpha'));
  });

  it('refuses to name itself at all when nothing declared', async () => {
    // A process that never went through gateway startup does not know which
    // rappter it is. Defaulting to the alpha there is how the original defect
    // read: a confident answer nobody had checked.
    isolatedHome();
    const peer = await neighbourNamed('peerling');

    const out = JSON.parse(await new NeighborAgent().perform({
      action: 'say', to: 'peerling', text: 'hello',
    }));
    expect(out.status).toBe('error');
    expect(out.message).toMatch(/has not declared which rappter it is/);
    // And it must not have sent anything while unable to say who it was.
    expect(peer.received).toHaveLength(0);
  });

  it('carries the speaker into the /chat fallback, where it is the session key', async () => {
    // sendTwin uses from_rappid as `session_id` when a peer has no /twin, so
    // this is the path on which twins shared one thread. A peer that 404s
    // /twin forces it.
    isolatedHome();
    const received: Record<string, unknown>[] = [];
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        if (req.url === '/health') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ status: 'ok', checks: { gateway: true } }));
          return;
        }
        if (req.url === '/twin') {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'no /twin here' }));
          return;
        }
        try { received.push(JSON.parse(body)); } catch { /* ignore */ }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ response: 'heard' }));
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
    const port = (server.address() as AddressInfo).port;
    const file = gatewayEndpointFileFor({ instance: 'chatonly' });
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({
      instance: 'chatonly', port, pid: process.pid, startedAt: 'x',
    }));

    declareCurrentInstance('pebble');
    await new NeighborAgent().perform({ action: 'say', to: 'chatonly', text: 'hello' });

    expect(received.at(-1)!.session_id).toBe(deviceRappid('kody-w', 'pebble'));
    expect(received.at(-1)!.session_id).not.toBe(deviceRappid('kody-w', 'alpha'));
  });
});

describe('a neighbour is somebody else', () => {
  it('leaves itself out of the list of who it can reach', async () => {
    // Measured on a live twin before this: `ember` listed alpha, ember and
    // brainstem, and a model that took the list at face value spent a full
    // model turn answering itself "Nope, I'm not you." #140
    isolatedHome();
    await neighbourNamed('peerling');
    await neighbourNamed('ember');
    declareCurrentInstance('ember');

    const out = JSON.parse(await new NeighborAgent().perform({ action: 'list' }));
    const names = (out.reachable as Array<{ name: string }>).map((r) => r.name);

    expect(names).toContain('peerling');
    expect(names).not.toContain('ember');
  });

  it('still lists the others when it is the alpha', async () => {
    // The negative control: excluding yourself must not empty the list.
    isolatedHome();
    await neighbourNamed('peerling');
    declareCurrentInstance(undefined);

    const out = JSON.parse(await new NeighborAgent().perform({ action: 'list' }));
    const names = (out.reachable as Array<{ name: string }>).map((r) => r.name);

    expect(names).toContain('peerling');
    expect(names).not.toContain('alpha');
  });

  it('refuses to say something to itself', async () => {
    isolatedHome();
    const peer = await neighbourNamed('ember');
    declareCurrentInstance('ember');

    const out = JSON.parse(await new NeighborAgent().perform({
      action: 'say', to: 'ember', text: 'are you me',
    }));

    expect(out.status).toBe('error');
    expect(String(out.message)).toMatch(/is this rappter/);
    expect(peer.received).toHaveLength(0);
  });

  it('does not exclude anything when it does not know which rappter it is', async () => {
    // An undeclared process must not start dropping names on a guess — the
    // same collapse #129 and #131 were both about.
    isolatedHome();
    await neighbourNamed('peerling');

    const out = JSON.parse(await new NeighborAgent().perform({ action: 'list' }));
    const names = (out.reachable as Array<{ name: string }>).map((r) => r.name);

    expect(names).toContain('peerling');
  });
});
