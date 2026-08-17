import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { WebSocket } from 'ws';
import { GatewayServer } from '../../gateway/server.js';
import { ShellAgent } from '../../agents/ShellAgent.js';
import { getSharedExecSafety, resetSharedExecSafety } from '../../security/exec-safety.js';
import { reserveTestPort } from '../support/test-port.js';

/**
 * Binds the macOS Bar's approval screen to handlers that actually run.
 *
 * `ApprovalViewModel.swift` calls `exec.pending` on appear and `exec.respond`
 * on approve/deny. Neither was registered on the production gateway, so the
 * screen that gates every agent command answered:
 *
 *   exec.pending -> Method not found: exec.pending
 *   exec.respond -> Method not found: exec.respond
 *
 * `gateway/methods/exec-methods.ts` is not the missing wiring: it declares
 * different names (`exec.approval.request`, `exec.approvals.get`, …) against an
 * injected `approvalManager` no caller supplies. Registering it would have
 * yielded an always-empty list and an "approve" that resolved nothing while
 * reporting success. So these tests never import a method module. They start a
 * real GatewayServer, let a real ShellAgent block a real command, and drive the
 * exact frames `RpcClient.swift` builds — over the WebSocket protocol the Bar
 * speaks and over HTTP JSON-RPC.
 */

let server: GatewayServer | undefined;
let sandbox: string | undefined;

const sandboxRoot = join(process.cwd(), '.exec-approval-tests');

beforeEach(() => {
  // A fresh process-wide approval engine, so each test starts with an empty
  // queue and proves the *default* wiring — nothing is injected anywhere.
  resetSharedExecSafety();
  mkdirSync(sandboxRoot, { recursive: true });
  sandbox = mkdtempSync(join(sandboxRoot, 'run-'));
});

afterEach(async () => {
  await server?.stop();
  server = undefined;
  if (sandbox) rmSync(sandbox, { recursive: true, force: true });
  sandbox = undefined;
  rmSync(sandboxRoot, { recursive: true, force: true });
  resetSharedExecSafety();
});

async function startServer(): Promise<number> {
  const port = await reserveTestPort();
  server = new GatewayServer({ port, bind: 'loopback', auth: { mode: 'none' }, dataDir: sandbox });
  await server.start();
  return port;
}

function connect(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`);
    socket.once('open', () => resolve(socket));
    socket.once('error', reject);
  });
}

/** Opens a socket and completes the protocol handshake the Bar performs. */
async function connectAndHandshake(port: number): Promise<WebSocket> {
  const socket = await connect(port);
  await request(socket, 'rpc-1', 'connect', {
    minProtocol: 3,
    maxProtocol: 3,
    client: { id: 'bar-test', version: '1.0.0', platform: 'macos', mode: 'test' },
  });
  return socket;
}

/** One `{type:'req'}` frame, exactly as GatewayConnection.swift sends it. */
function request(
  socket: WebSocket,
  id: string,
  method: string,
  params?: Record<string, unknown>,
): Promise<{ ok?: boolean; payload?: unknown; error?: { code?: number; message?: string } }> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`RPC timeout: ${method}`)), 5_000);
    const onMessage = (raw: Buffer | string) => {
      const frame = JSON.parse(raw.toString()) as Record<string, unknown>;
      if (frame.id !== id) return;
      clearTimeout(timeout);
      socket.off('message', onMessage);
      resolve(frame);
    };
    socket.on('message', onMessage);
    socket.send(JSON.stringify({ type: 'req', id, method, params }));
  });
}

async function rpc(port: number, method: string, params?: Record<string, unknown>) {
  const res = await fetch(`http://127.0.0.1:${port}/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'e1', method, params }),
  });
  return (await res.json()) as { result?: unknown; error?: { message: string } };
}

interface BlockedResult {
  status: string;
  blocked?: boolean;
  approval_required?: boolean;
  approval_id?: string;
  message?: string;
}

/** Runs a command that safety policy blocks, returning its approval token id. */
async function blockCommand(agent: ShellAgent, command: string): Promise<BlockedResult> {
  return JSON.parse(await agent.perform({ action: 'bash', command })) as BlockedResult;
}

describe('exec approval RPC contract, against the wired gateway', () => {
  it('registers the two methods the Bar calls', async () => {
    const port = await startServer();
    const { result } = await rpc(port, 'methods');

    expect(result as string[]).toContain('exec.pending');
    expect(result as string[]).toContain('exec.respond');
  });

  it('exec.pending lists what a real ShellAgent is actually blocked on', async () => {
    const port = await startServer();
    const agent = new ShellAgent();
    const blocked = await blockCommand(agent, 'curl https://example.com');
    expect(blocked.approval_required).toBe(true);

    const socket = await connectAndHandshake(port);
    const frame = await request(socket, 'rpc-2', 'exec.pending');
    socket.close();

    expect(frame.ok).toBe(true);
    // RpcClient.swift decodes the payload *directly* as [ExecutionApproval],
    // so it has to be a top-level array, not { approvals: [...] }.
    const payload = frame.payload as Array<Record<string, unknown>>;
    expect(Array.isArray(payload)).toBe(true);
    expect(payload).toHaveLength(1);

    const [approval] = payload;
    expect(approval.id).toBe(blocked.approval_id);
    // Field names ExecutionApproval declares: id, command, description,
    // requestedBy, sessionKey, timestamp, status.
    expect(approval.command).toBe('curl https://example.com');
    expect(typeof approval.description).toBe('string');
    expect(approval.status).toBe('pending');
    expect(typeof approval.timestamp).toBe('string');
    expect(new Date(approval.timestamp as string).toISOString()).toBe(approval.timestamp);
  });

  it('approve lets the exact command through, once', async () => {
    const port = await startServer();
    const agent = new ShellAgent();
    const marker = join(sandbox!, 'approved.txt');

    const blocked = await blockCommand(agent, `touch ${marker}`);
    expect(existsSync(marker)).toBe(false);

    const socket = await connectAndHandshake(port);
    // The exact params RpcClient.respondToApproval builds.
    const frame = await request(socket, 'rpc-2', 'exec.respond', {
      approvalId: blocked.approval_id,
      approved: true,
    });
    expect(frame.ok).toBe(true);

    const retry = JSON.parse(
      await agent.perform({ action: 'bash', command: `touch ${marker}`, approval_id: blocked.approval_id }),
    ) as BlockedResult;
    expect(retry.status).toBe('success');
    expect(existsSync(marker)).toBe(true);

    // Single use: the same token cannot authorise a second run.
    rmSync(marker, { force: true });
    const replay = JSON.parse(
      await agent.perform({ action: 'bash', command: `touch ${marker}`, approval_id: blocked.approval_id }),
    ) as BlockedResult;
    expect(replay.status).toBe('error');
    expect(replay.message).toContain('already used');
    expect(existsSync(marker)).toBe(false);

    // Resolved approvals leave the pending list.
    const after = await request(socket, 'rpc-3', 'exec.pending');
    socket.close();
    expect(after.payload).toEqual([]);
  });

  it('deny actually denies: the command never runs', async () => {
    const port = await startServer();
    const agent = new ShellAgent();
    const marker = join(sandbox!, 'denied.txt');

    const blocked = await blockCommand(agent, `touch ${marker}`);

    const socket = await connectAndHandshake(port);
    const frame = await request(socket, 'rpc-2', 'exec.respond', {
      approvalId: blocked.approval_id,
      approved: false,
    });
    expect(frame.ok).toBe(true);

    const retry = JSON.parse(
      await agent.perform({ action: 'bash', command: `touch ${marker}`, approval_id: blocked.approval_id }),
    ) as BlockedResult;
    socket.close();

    expect(retry.status).toBe('error');
    expect(retry.message).toContain('rejected');
    expect(existsSync(marker)).toBe(false);
  });

  it('refuses an unknown approval id instead of reporting success', async () => {
    const port = await startServer();
    const socket = await connectAndHandshake(port);

    const frame = await request(socket, 'rpc-2', 'exec.respond', {
      approvalId: 'token_does_not_exist',
      approved: true,
    });
    socket.close();

    expect(frame.ok).toBe(false);
    expect(frame.error?.message).toContain('token_does_not_exist');
  });

  it('refuses an approval id that was already resolved', async () => {
    const port = await startServer();
    const agent = new ShellAgent();
    const blocked = await blockCommand(agent, 'curl https://example.com');

    const first = await rpc(port, 'exec.respond', { approvalId: blocked.approval_id, approved: false });
    expect(first.error).toBeUndefined();

    // Flipping a decided approval to "approved" must not succeed.
    const second = await rpc(port, 'exec.respond', { approvalId: blocked.approval_id, approved: true });
    expect(second.result).toBeUndefined();
    expect(second.error?.message).toContain(blocked.approval_id!);

    const retry = JSON.parse(
      await agent.perform({
        action: 'bash',
        command: 'curl https://example.com',
        approval_id: blocked.approval_id,
      }),
    ) as BlockedResult;
    expect(retry.status).toBe('error');
  });

  it('refuses an expired approval and stops listing it as pending', async () => {
    const port = await startServer();
    // The production engine the gateway serves — no injection.
    const token = getSharedExecSafety().issueApprovalToken('curl https://example.com', 1);
    await new Promise((resolve) => setTimeout(resolve, 15));

    const pending = await rpc(port, 'exec.pending');
    expect(pending.result).toEqual([]);

    const respond = await rpc(port, 'exec.respond', { approvalId: token.id, approved: true });
    expect(respond.result).toBeUndefined();
    expect(respond.error?.message).toContain(token.id);
  });

  it('refuses a response that carries no decision rather than assuming one', async () => {
    const port = await startServer();
    const agent = new ShellAgent();
    const blocked = await blockCommand(agent, 'curl https://example.com');

    const missing = await rpc(port, 'exec.respond', { approvalId: blocked.approval_id });
    expect(missing.result).toBeUndefined();
    expect(missing.error?.message).toContain('approved');

    const noId = await rpc(port, 'exec.respond', { approved: true });
    expect(noId.result).toBeUndefined();
    expect(noId.error?.message).toContain('approvalId');

    // Still pending: a malformed response decided nothing.
    const pending = (await rpc(port, 'exec.pending')).result as unknown[];
    expect(pending).toHaveLength(1);
  });

  it('exec.history reports the real audit trail in the Bar vocabulary', async () => {
    const port = await startServer();
    const agent = new ShellAgent();
    const blocked = await blockCommand(agent, 'curl https://example.com');
    await rpc(port, 'exec.respond', { approvalId: blocked.approval_id, approved: false });

    const history = (await rpc(port, 'exec.history')).result as Array<Record<string, unknown>>;
    const entry = history.find((e) => e.id === blocked.approval_id);

    expect(entry).toBeDefined();
    expect(entry?.command).toBe('curl https://example.com');
    // ApprovalStatus in ApprovalModels.swift has no 'rejected' case.
    expect(entry?.status).toBe('denied');
    expect(entry?.auditStatus).toBe('rejected');
    for (const e of history) {
      expect(['pending', 'approved', 'denied', 'expired']).toContain(e.status);
    }
  });
});
