import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { GatewayServer } from '../../gateway/server.js';
import {
  gatewayEndpointFileFor,
  readGatewayEndpoint,
  writeGatewayEndpoint,
} from '../../infra/gateway-lock.js';
import {
  __resetCurrentLiveIdentityForTest,
  declareCurrentLiveIdentity,
} from '../../infra/process-identity.js';
import {
  __resetCurrentInstanceForTest,
  declareCurrentInstance,
} from '../../infra/current-instance.js';

const RAPPID = `rappid:@openrappter/identity-test:${'e'.repeat(64)}`;
const originalHome = process.env.OPENRAPPTER_HOME;
let server: GatewayServer | undefined;
let scratch: string | undefined;

afterEach(async () => {
  await server?.stop();
  server = undefined;
  __resetCurrentLiveIdentityForTest();
  __resetCurrentInstanceForTest();
  if (originalHome === undefined) delete process.env.OPENRAPPTER_HOME;
  else process.env.OPENRAPPTER_HOME = originalHome;
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  scratch = undefined;
});

describe('live process identity metadata', () => {
  it('publishes one identical binding in endpoint, health, status, liveness, and readiness', async () => {
    scratch = join(
      process.cwd(),
      '.test-scratch',
      `live-identity-${process.pid}-${Math.random().toString(36).slice(2, 8)}`,
    );
    mkdirSync(scratch, { recursive: true });
    process.env.OPENRAPPTER_HOME = scratch;

    declareCurrentInstance('identity-test');
    const identity = declareCurrentLiveIdentity(RAPPID, {
      incarnation: 'integration-start',
      setProcessTitle: vi.fn(),
    });
    const expected = {
      rappid: identity.rappid,
      live_id: identity.liveId,
      pid: identity.pid,
      incarnation: identity.incarnation,
    };

    server = new GatewayServer({
      port: 0,
      bind: 'loopback',
      auth: { mode: 'none' },
      dataDir: scratch,
    });
    await server.start();
    writeGatewayEndpoint({
      instance: 'identity-test',
      port: server.port,
      pid: process.pid,
      startedAt: '2026-08-30T19:46:41.000Z',
    });

    const endpoint = readGatewayEndpoint(
      gatewayEndpointFileFor({ instance: 'identity-test' }),
    );
    const health = await fetch(`http://127.0.0.1:${server.port}/health`)
      .then((response) => response.json()) as Record<string, unknown>;
    const status = await fetch(`http://127.0.0.1:${server.port}/status`)
      .then((response) => response.json()) as Record<string, unknown>;
    const liveness = await fetch(`http://127.0.0.1:${server.port}/livez`)
      .then((response) => response.json()) as Record<string, unknown>;
    const readiness = await fetch(`http://127.0.0.1:${server.port}/readyz`)
      .then((response) => response.json()) as Record<string, unknown>;

    expect(endpoint).toMatchObject(expected);
    expect(health).toMatchObject(expected);
    expect(status).toMatchObject(expected);
    expect(liveness).toMatchObject(expected);
    expect(readiness).toMatchObject(expected);
    expect(health.instance).toBe('identity-test');
  });

  it('does not relabel an endpoint owned by another PID as this process', () => {
    scratch = join(
      process.cwd(),
      '.test-scratch',
      `live-identity-history-${process.pid}-${Math.random().toString(36).slice(2, 8)}`,
    );
    mkdirSync(scratch, { recursive: true });
    process.env.OPENRAPPTER_HOME = scratch;

    declareCurrentLiveIdentity(RAPPID, {
      incarnation: 'integration-start',
      setProcessTitle: vi.fn(),
    });
    writeGatewayEndpoint({
      instance: 'historical',
      port: 19_501,
      pid: process.pid + 1,
      startedAt: '2026-08-29T19:46:41.000Z',
    });

    expect(readGatewayEndpoint(
      gatewayEndpointFileFor({ instance: 'historical' }),
    )).toBeNull();
  });
});
