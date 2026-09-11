import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { WebSocket } from 'ws';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GatewayServer } from '../server.js';
import { RPC_ERROR, type ConnectionInfo, type RpcMethodHandler } from '../types.js';
import { buildRappFrame, createRappFrameProfile } from '../../rapp/index.js';
import type { AgentWorkspace, WorkspaceFrameScan } from '../../workspaces/index.js';

const TOKEN = 'rapp-work-workspace-test-token';
const METHODS = ['workspace.list', 'workspace.get', 'workspace.ensure', 'workspace.frames', 'workspace.appendEvidence', 'workspace.appendFrame'];
let fixture: string;
let dataDir: string;
let server: GatewayServer;
let evidenceEpoch: number;
const sockets: WebSocket[] = [];

interface Reply {
  result?: any;
  payload?: any;
  ok?: boolean;
  error?: { code: number; message: string; data?: Record<string, unknown> };
}

beforeEach(async () => {
  evidenceEpoch = Date.now() + 60_000;
  fixture = path.join(process.cwd(), '.test-scratch', `workspace-rpc-${randomUUID()}`);
  dataDir = path.join(fixture, 'data');
  await fs.mkdir(fixture, { recursive: true, mode: 0o700 });
  server = new GatewayServer({
    port: 0, bind: 'loopback', dataDir,
    auth: { mode: 'token', tokens: [TOKEN] },
    heartbeatInterval: 60_000,
  });
  await server.start();
});

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  await server?.stop();
  vi.restoreAllMocks();
  await fs.rm(fixture, { recursive: true, force: true });
});

function evidence(index = 0): Record<string, unknown> {
  return {
    agentId: 'alice', eventKind: 'task.completed', subject: `task:${index}`,
    dataHash: String(index).repeat(64), utc: new Date(evidenceEpoch + index * 1000).toISOString(),
  };
}

async function rpc(method: string, params: unknown = {}, token: string | null = TOKEN): Promise<Reply & { status: number }> {
  const response = await fetch(`http://127.0.0.1:${server.port}/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token === null ? {} : { Authorization: `Bearer ${token}` }) },
    body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params }),
  });
  return { ...(await response.json()) as Reply, status: response.status };
}

async function connect(): Promise<WebSocket> {
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}`);
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  return socket;
}

function wsRpc(socket: WebSocket, method: string, params: unknown = {}): Promise<Reply> {
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off('message', onMessage);
      reject(new Error(`workspace RPC timed out: ${method}`));
    }, 4000);
    const onMessage = (bytes: Buffer) => {
      const reply = JSON.parse(bytes.toString());
      if (reply.id !== id) return;
      clearTimeout(timeout);
      socket.off('message', onMessage);
      resolve(reply);
    };
    socket.on('message', onMessage);
    socket.send(JSON.stringify({ type: 'req', id, method, params }));
  });
}

describe('workspace RPCs on the production GatewayServer', () => {
  it('registers all workspace built-ins automatically, and no read creates a workspace', async () => {
    expect((await rpc('methods')).result).toEqual(expect.arrayContaining(METHODS));
    expect((await rpc('workspace.list')).result).toEqual({ workspaces: [] });
    expect((await rpc('workspace.get', { agentId: 'alice' })).result).toEqual({ workspace: null });
    await expect(fs.stat(path.join(dataDir, 'workspaces'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects missing and invalid HTTP credentials for every workspace operation without side effects', async () => {
    for (const method of METHODS) {
      for (const token of [null, 'incorrect-token']) {
        const response = await rpc(method, method === 'workspace.appendEvidence' ? evidence() : { agentId: 'alice' }, token);
        expect(response.status, method).toBe(401);
        expect(response.error?.code, method).toBe(RPC_ERROR.UNAUTHORIZED);
        expect(response.result).toBeUndefined();
      }
    }
    await expect(fs.stat(path.join(dataDir, 'workspaces'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('marks every built-in requiresAuth and independently enforces that flag in WS dispatch', async () => {
    const internal = server as unknown as {
      methods: Map<string, { handler: RpcMethodHandler; requiresAuth: boolean }>;
      dispatchMethod: (id: string, socket: WebSocket, info: ConnectionInfo, frame: Record<string, unknown>) => Promise<void>;
    };
    const info: ConnectionInfo = {
      id: 'untrusted', connectedAt: new Date().toISOString(), authenticated: false,
      subscriptions: new Set(), lastActivity: Date.now(),
    };
    const send = vi.fn();
    const socket = { readyState: WebSocket.OPEN, bufferedAmount: 0, send } as unknown as WebSocket;
    for (const method of METHODS) {
      const registered = internal.methods.get(method)!;
      expect(registered.requiresAuth, method).toBe(true);
      const handler = vi.spyOn(registered, 'handler');
      await internal.dispatchMethod(info.id, socket, info, { id: method, method, params: evidence() });
      expect(handler).not.toHaveBeenCalled();
      expect(JSON.parse(send.mock.calls.at(-1)![0]).error.code).toBe(RPC_ERROR.UNAUTHORIZED);
    }
  });

  it('serves durable, idempotent isolated workspaces and genuinely scanned evidence over HTTP', async () => {
    const created = await rpc('workspace.ensure', { agentId: 'alice' });
    expect(created.error).toBeUndefined();
    const workspace = created.result.workspace as AgentWorkspace;
    expect(workspace.rootDir).toBe(path.join(dataDir, 'workspaces', 'alice'));
    expect(workspace.verification).toMatchObject({ protocol: 'rapp/1', status: 'not-scanned', scannedFrames: 0 });
    const initial = (await rpc('workspace.frames', { agentId: 'alice' })).result;
    expect(initial.frames).toHaveLength(1);
    expect(initial.frames[0].payload.event_kind).toBe('workspace.created');
    expect((await rpc('workspace.ensure', { agentId: 'alice' })).result.workspace).toEqual(workspace);
    await rpc('workspace.ensure', { agentId: 'bob' });
    expect((await rpc('workspace.list')).result.workspaces.map((entry: AgentWorkspace) => entry.agentId)).toEqual(['alice', 'bob']);
    const appended = await rpc('workspace.appendEvidence', evidence());
    expect(appended.error).toBeUndefined();
    expect(appended.result.frame).toMatchObject({ spec: 'rapp/1', kind: 'body.pulse', seq: 1 });
    const scanned = (await rpc('workspace.frames', { agentId: 'alice' })).result as WorkspaceFrameScan;
    expect(scanned.total).toBe(2);
    expect(scanned.frames).toEqual([...initial.frames, appended.result.frame]);
    expect(scanned.verification).toMatchObject({ protocol: 'rapp/1', status: 'verified', scannedFrames: 2 });
    expect(scanned.trust).toMatchObject({ promotionGrade: false, persistedHead: 'matched' });
    expect((await rpc('workspace.frames', { agentId: 'bob' })).result.total).toBe(1);
    expect((await rpc('workspace.frames', { agentId: 'alice', stream: 'memory' })).result.total).toBe(0);
    expect((await rpc('workspace.frames', { agentId: 'alice', stream: 'swarm' })).result.trust).toBeNull();
    expect(JSON.stringify((await rpc('workspace.get', { agentId: 'alice' })).result)).not.toContain('"tail"');
  });

  it('enforces WS handshake and serves the same registered workspace implementation after authentication', async () => {
    const socket = await connect();
    for (const method of METHODS) {
      expect((await wsRpc(socket, method, evidence())).error?.code).toBe(RPC_ERROR.UNAUTHORIZED);
    }
    const hello = await wsRpc(socket, 'connect', {
      minProtocol: 3, maxProtocol: 3, auth: { token: TOKEN },
      client: { id: 'workspace-test', version: '1', platform: 'test', mode: 'test' },
    });
    expect(hello.ok).toBe(true);
    expect(hello.payload.features.methods).toEqual(expect.arrayContaining(METHODS));
    expect((await wsRpc(socket, 'workspace.ensure', { agentId: 'alice' })).ok).toBe(true);
    const appended = await wsRpc(socket, 'workspace.appendEvidence', evidence());
    expect(appended.ok).toBe(true);
    const scan = (await wsRpc(socket, 'workspace.frames', { agentId: 'alice' })).payload;
    expect(scan.frames).toHaveLength(2);
    expect(scan.frames[1]).toEqual(appended.payload.frame);
    expect(scan.verification.status).toBe('verified');
    expect((await wsRpc(socket, 'workspace.ensure', { agentId: '../bob' })).error?.code)
      .toBe(RPC_ERROR.INVALID_PARAMS);
  });

  it('rejects invalid inputs, traversal, and caller overrides of roots or authority', async () => {
    for (const [method, params] of [
      ['workspace.ensure', { agentId: '../bob' }],
      ['workspace.ensure', { agentId: 'Alice' }],
      ['workspace.ensure', { agentId: ['alice'] }],
      ['workspace.get', { agentId: 'alice', rootDir: fixture }],
      ['workspace.list', { path: fixture }],
      ['workspace.frames', { agentId: 'alice', stream: '../bob' }],
      ['workspace.frames', { agentId: 'alice', offset: -1 }],
      ['workspace.frames', { agentId: 'alice', limit: 1001 }],
      ['workspace.frames', { agentId: 'alice', limit: 1.5 }],
      ['workspace.appendEvidence', { ...evidence(), authority: { revision: 'made-up' } }],
      ['workspace.appendEvidence', { ...evidence(), head: null }],
      ['workspace.appendEvidence', { ...evidence(), dataHash: 'bad' }],
      ['workspace.appendEvidence', { ...evidence(), eventKind: 'workspace.created' }],
      ['workspace.appendFrame', { agentId: 'alice', stream: '../bob', frame: {} }],
      ['workspace.appendFrame', { agentId: 'alice', stream: 'memory', frame: {}, authority: 'custom' }],
    ] as Array<[string, unknown]>) {
      const reply = await rpc(method, params);
      expect(reply.error?.code, `${method} ${JSON.stringify(params)}`).toBe(RPC_ERROR.INVALID_PARAMS);
      expect(reply.result).toBeUndefined();
    }
    await expect(fs.stat(path.join(dataDir, 'workspaces'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('paginates only after verifying the whole committed stream and rejects tampering on both read and append', async () => {
    const workspace = (await rpc('workspace.ensure', { agentId: 'alice' })).result.workspace as AgentWorkspace;
    for (const index of [0, 1, 2]) expect((await rpc('workspace.appendEvidence', evidence(index))).error).toBeUndefined();
    const page = (await rpc('workspace.frames', { agentId: 'alice', offset: 1, limit: 1 })).result;
    expect(page).toMatchObject({ offset: 1, limit: 1, total: 4, nextOffset: 2 });
    expect(page.verification).toMatchObject({ status: 'verified', scannedFrames: 4 });
    expect(page.frames.map((frame: { seq: number }) => frame.seq)).toEqual([1]);
    const directory = path.join(workspace.rootDir, 'streams', 'body');
    const file = path.join(directory, (await fs.readdir(directory)).sort()[0]);
    const frame = JSON.parse(await fs.readFile(file, 'utf8'));
    frame.payload.subject = 'tampered';
    await fs.writeFile(file, JSON.stringify(frame));
    for (const [method, params] of [
      ['workspace.frames', { agentId: 'alice', offset: 1000, limit: 1 }],
      ['workspace.appendEvidence', evidence(3)],
    ] as const) {
      const rejected = await rpc(method, params);
      expect(rejected.result).toBeUndefined();
      expect(rejected.error).toMatchObject({
        code: RPC_ERROR.INTERNAL_ERROR, data: { workspaceCode: 'integrity', frameCode: 'payload-hash' },
      });
    }
    const metadata = (await rpc('workspace.get', { agentId: 'alice' })).result.workspace;
    expect(metadata.manifest.streams.body.head.seq).toBe(3);
    expect(metadata.verification.status).toBe('not-scanned');
  });

  it('persists external tool-call frames in the correct family instead of a parallel event format', async () => {
    const workspace = (await rpc('workspace.ensure', { agentId: 'alice' })).result.workspace as AgentWorkspace;
    const frame = buildRappFrame({
      kind: 'memory.tool-call', streamId: workspace.manifest.streams.memory.streamId,
      utc: new Date(evidenceEpoch).toISOString(), payload: { tool: 'search', result_ref: 'a'.repeat(64) }, head: null,
    }, createRappFrameProfile({ name: 'rpc-tool-call-test', kind: 'memory.tool-call' }));
    const appended = await rpc('workspace.appendFrame', { agentId: 'alice', stream: 'memory', frame });
    expect(appended.error).toBeUndefined();
    expect(appended.result.frame).toEqual(frame);
    const scan = (await rpc('workspace.frames', { agentId: 'alice', stream: 'memory' })).result;
    expect(scan.frames).toEqual([frame]);
    expect(scan.verification).toMatchObject({ protocol: 'rapp/1', status: 'verified', scannedFrames: 1 });
    expect((await rpc('workspace.frames', { agentId: 'alice' })).result.total).toBe(1);
    for (const [stream, candidate] of [
      ['body', frame],
      ['memory', { event: 'tool.called', result: 'unframed' }],
      ['swarm', {}],
    ] as const) {
      const rejected = await rpc('workspace.appendFrame', { agentId: 'alice', stream, frame: candidate });
      expect(rejected.result).toBeUndefined();
      expect(rejected.error).toBeDefined();
    }
  });
});
