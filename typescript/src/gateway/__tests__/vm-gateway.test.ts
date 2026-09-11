import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { WebSocket } from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import { GatewayServer } from '../server.js';
import { RPC_ERROR, type GatewayConfig } from '../types.js';
import { TartVmSupervisor } from '../../vm/tart-vm-supervisor.js';
import { FakeRappPersistence, testEvidence } from '../../vm/__tests__/fake-rapp-persistence.js';
import type { VmRappPersistence } from '../../vm/rapp-evidence.js';
import {
  deferred, FakeVmCommandRunner, result, testConfig, testHost, testWorkspaces,
} from '../../vm/__tests__/fake-runner.js';

const servers: GatewayServer[] = [];
const roots: string[] = [];
const sockets: WebSocket[] = [];
const methods = ['vm.status', 'vm.start', 'vm.stop', 'vm.restart', 'vm.exec'];
const execParams = { agentId: 'agent-a', workspaceId: 'project-1', argv: ['/usr/bin/pwd'] };

interface RpcReply {
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: { vmCode: string } };
}

async function boot(authMode: 'token' | 'password' | 'none' = 'token', production = false, persistence?: VmRappPersistence) {
  const root = path.join(process.cwd(), '.test-scratch');
  await fs.mkdir(root, { recursive: true });
  const dataDir = await fs.mkdtemp(path.join(root, 'omarchy-gateway-'));
  roots.push(dataDir);
  const secret = randomBytes(32).toString('hex');
  const auth: GatewayConfig['auth'] = authMode === 'token'
    ? { mode: 'token', tokens: [secret] }
    : authMode === 'password' ? { mode: 'password', password: secret } : { mode: 'none' };
  const runner = new FakeVmCommandRunner();
  const supervisors: TartVmSupervisor[] = [];
  const server = new GatewayServer({
    port: 0, bind: 'loopback', auth, dataDir, heartbeatInterval: 60_000,
  }, production ? { vmRappPersistence: persistence } : {
    vmSupervisorFactory: () => {
      const vm = new TartVmSupervisor({ config: testConfig, runner, host: testHost, workspaces: testWorkspaces, evidence: testEvidence() });
      supervisors.push(vm);
      return vm;
    },
  });
  servers.push(server);
  await server.start();
  const rpc = async (method: string, params: unknown = {}, credential: string | undefined = secret) => {
    const response = await fetch(`http://127.0.0.1:${server.port}/rpc`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(credential ? { Authorization: `Bearer ${credential}` } : {}),
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: method, method, params }),
    });
    return { status: response.status, body: await response.json() as RpcReply };
  };
  return { server, runner, supervisors, secret, rpc, dataDir };
}

async function wsClient(port: number) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  sockets.push(ws);
  const replies = new Map<string, (value: Record<string, unknown>) => void>();
  ws.on('message', (message) => {
    const parsed = JSON.parse(message.toString()) as Record<string, unknown>;
    const resolve = replies.get(parsed.id as string);
    if (resolve) { replies.delete(parsed.id as string); resolve(parsed); }
  });
  await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  let sequence = 0;
  return {
    call: (method: string, params: Record<string, unknown> = {}) => {
      const id = String(++sequence);
      return new Promise<Record<string, unknown>>((resolve) => {
        replies.set(id, resolve);
        ws.send(JSON.stringify({ type: 'req', id, method, params }));
      });
    },
  };
}
const clientIdentity = { id: 'vm-contract', version: '1.0', platform: 'test', mode: 'cli' };

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  await Promise.all(servers.splice(0).map((server) => server.stop()));
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('production VM RPC registration', () => {
  it('wires all five methods to one real supervisor rather than a standalone registry', async () => {
    const { rpc, runner, supervisors } = await boot();
    expect((await rpc('vm.status')).body.result).toMatchObject({
      state: 'stopped', frames: expect.any(Array), verification: { protocol: 'rapp/1', status: 'verified' },
    });
    expect((await rpc('vm.start')).body.result).toMatchObject({ state: 'running', ready: true, owned: true });
    expect((await rpc('vm.exec', execParams)).body.result).toMatchObject({
      agentId: 'agent-a', workspaceId: 'project-1', cwd: '/workspaces/agent-a/project-1', exitCode: 0,
    });
    expect((await rpc('vm.restart')).body.result).toMatchObject({ state: 'running', ready: true });
    expect((await rpc('vm.stop')).body.result).toMatchObject({ state: 'stopped', owned: false });
    expect(supervisors).toHaveLength(1);
    expect(runner.children).toHaveLength(2);
    expect((await rpc('vm.shell')).body.error?.code).toBe(RPC_ERROR.METHOD_NOT_FOUND);
  });

  it.each(['token', 'password'] as const)('requires actual %s credentials for every VM method', async (mode) => {
    const { rpc, supervisors, runner } = await boot(mode);
    for (const method of methods) {
      const denied = await rpc(method, execParams, '');
      expect(denied.status).toBe(401);
      expect(denied.body.error?.code).toBe(RPC_ERROR.UNAUTHORIZED);
      expect((await rpc(method, {}, 'wrong')).body.error?.code).toBe(RPC_ERROR.UNAUTHORIZED);
    }
    expect(supervisors).toHaveLength(0);
    expect(runner.calls).toHaveLength(0);
    expect((await rpc('vm.status')).body.result?.state).toBe('stopped');
  });

  it('does not treat the legacy loopback auth:none mode as VM authentication', async () => {
    const { rpc, runner, supervisors } = await boot('none');
    for (const method of methods) {
      expect((await rpc(method, execParams)).body.error).toMatchObject({
        code: RPC_ERROR.UNAUTHORIZED, data: { vmCode: 'authentication_required' },
      });
    }
    expect(runner.calls).toEqual([]);
    expect(supervisors).toHaveLength(0);
  });

  it('validates RPC input and cannot accept a renderer binary, host shell, cwd, or mount override', async () => {
    const { rpc, runner } = await boot();
    for (const method of methods.slice(0, 4)) {
      expect((await rpc(method, { command: 'echo host', name: 'another-vm' })).body.error?.code).toBe(RPC_ERROR.INVALID_PARAMS);
    }
    expect((await rpc('vm.exec', { ...execParams, cwd: '/Users/private' })).body.error?.code).toBe(RPC_ERROR.INVALID_PARAMS);
    expect((await rpc('vm.exec', { ...execParams, argv: '/usr/bin/pwd; id' })).body.error?.code).toBe(RPC_ERROR.INVALID_PARAMS);
    expect((await rpc('vm.exec', { ...execParams, agentId: '../other' })).body.error?.code).toBe(RPC_ERROR.INVALID_PARAMS);
    expect(runner.calls).toHaveLength(0);
    expect((await rpc('vm.exec', { ...execParams, workspaceId: 'unregistered' })).body.error).toMatchObject({
      code: RPC_ERROR.UNAUTHORIZED, data: { vmCode: 'workspace_denied' },
    });
  });

  it('reports unconfigured production setup without requiring Tart in tests', async () => {
    const { rpc } = await boot('token', true);
    const status = (await rpc('vm.status')).body.result;
    expect(status?.state).toBe('unavailable');
    expect(['not_configured', 'unsupported_platform', 'unsupported_architecture']).toContain(
      (status?.error as { code: string }).code,
    );
    expect((await rpc('vm.start')).body.error?.data?.vmCode).toBe((status?.error as { code: string }).code);
  });

  it.skipIf(process.platform !== 'darwin' || process.arch !== 'arm64')(
    'wires the canonical persistence port through the default production factory without installing Tart', async () => {
      const port = new FakeRappPersistence();
      const { rpc, dataDir } = await boot('token', true, port);
      await fs.mkdir(path.join(dataDir, 'vm'));
      await fs.writeFile(path.join(dataDir, 'vm', 'omarchy.json'), JSON.stringify({
        ...testConfig, tartBinary: path.join(dataDir, 'not-installed', 'tart'),
      }), { mode: 0o600 });
      const status = (await rpc('vm.status')).body.result;
      expect(status).toMatchObject({
        state: 'unavailable', error: { code: 'tart_missing' },
        verification: { status: 'verified', protocol: 'rapp/1', trust: { promotionGrade: false } },
      });
      expect(port.appended.length).toBeGreaterThan(0);
      expect(status?.frames).toEqual(port.appended);
    },
  );

  it.skipIf(process.platform !== 'darwin' || process.arch !== 'arm64')(
    'labels a configured production VM as unwired instead of running without frame persistence', async () => {
      const { rpc, dataDir } = await boot('token', true);
      await fs.mkdir(path.join(dataDir, 'vm'));
      await fs.writeFile(path.join(dataDir, 'vm', 'omarchy.json'), JSON.stringify(testConfig), { mode: 0o600 });
      expect((await rpc('vm.status')).body.result).toMatchObject({
        state: 'unavailable', error: { code: 'rapp_not_wired' },
        verification: { status: 'not-wired', scannedFrames: 0 },
      });
      expect((await rpc('vm.start')).body.error?.data?.vmCode).toBe('rapp_not_wired');
    },
  );
  it('uses the same authenticated, constrained methods on WebSocket', async () => {
    const { server, secret, runner } = await boot();
    const ws = await wsClient(server.port);
    expect((await ws.call('vm.status')).ok).toBe(false);
    expect((await ws.call('connect', { client: clientIdentity, auth: { token: 'wrong' } })).ok).toBe(false);
    expect(runner.calls).toHaveLength(0);
    expect((await ws.call('connect', { client: clientIdentity, auth: { token: secret } })).ok).toBe(true);
    expect(await ws.call('vm.start')).toMatchObject({ ok: true, payload: { state: 'running', ready: true } });
    expect(await ws.call('vm.exec', { ...execParams, cwd: '../escape' })).toMatchObject({
      ok: false, error: { code: RPC_ERROR.INVALID_PARAMS, data: { vmCode: 'invalid_request' } },
    });
    expect(await ws.call('vm.exec', execParams)).toMatchObject({ ok: true, payload: { exitCode: 0 } });
    expect(await ws.call('vm.stop')).toMatchObject({ ok: true, payload: { state: 'stopped' } });
  });

  it('also refuses an auth:none WebSocket handshake as VM authorization', async () => {
    const { server, runner } = await boot('none');
    const ws = await wsClient(server.port);
    expect((await ws.call('connect', { client: clientIdentity })).ok).toBe(true);
    for (const method of methods) {
      expect(await ws.call(method, execParams)).toMatchObject({ ok: false, error: { code: RPC_ERROR.UNAUTHORIZED } });
    }
    expect(runner.calls).toEqual([]);
  });
});

describe('production shutdown ownership', () => {
  it('gateway shutdown awaits only its owned Tart child and allows a fresh lifetime', async () => {
    const { rpc, server, runner, supervisors } = await boot();
    await rpc('vm.start');
    await Promise.all([server.stop(), server.stop()]);
    expect(runner.children[0].signals).toEqual(['SIGINT']);
    expect(runner.calls.some((call) => call.argv[0] === 'stop')).toBe(false);
    await server.start();
    expect((await rpc('vm.start')).body.result).toMatchObject({ state: 'running', ready: true });
    expect(supervisors).toHaveLength(2);
  });

  it('gateway shutdown leaves an externally started shared VM running', async () => {
    const { rpc, server, runner } = await boot();
    runner.running = true;
    expect((await rpc('vm.start')).body.result?.owned).toBe(false);
    await server.stop();
    expect(runner.running).toBe(true);
    expect(runner.calls.some((call) => call.argv[0] === 'stop' || call.kind === 'spawn')).toBe(false);
  });

  it('cancels a VM start accepted over the live gateway when shutdown races SSH readiness', async () => {
    const { rpc, server, runner } = await boot();
    const entered = deferred<void>();
    runner.intercept = async (call) => {
      if (call.file === '/usr/bin/ssh') {
        entered.resolve();
        return new Promise((resolve) => call.options!.signal!.addEventListener('abort', () => resolve(result({ aborted: true })), { once: true }));
      }
    };
    const response = rpc('vm.start').catch(() => undefined);
    await entered.promise;
    await server.stop();
    await response;
    expect(runner.children[0].finished).toBe(true);
    expect(runner.children[0].signals).toEqual(['SIGINT']);
  });
});
