/**
 * Two live Bar features answered "Method not found".
 *
 *   LogsViewModel.swift:45   rpc.getLogs(limit:)   -> logs.get
 *   SessionsViewModel.swift  rpc.resetSession(...) -> sessions.reset
 *
 * Probed against a started GatewayServer before the fix:
 *
 *   logs.get       -> {"code":-32601,"message":"Method not found: logs.get"}
 *   sessions.reset -> {"code":-32601,"message":"Method not found: sessions.reset"}
 *
 * `methods/logs-methods.ts` and `methods/session-methods.ts` declare those
 * names, and registering them would not have fixed anything — the same probe
 * with both register functions called by hand:
 *
 *   logs.get                    -> still -32601 (the module registers `logs.tail`)
 *   logs.tail                   -> {"entries":[]} from a buffer whose only
 *                                  writer, `pushLog`, has no callers in the repo
 *   sessions.reset {sessionKey} -> "Session not found: undefined" (it reads
 *                                  `sessionId`, the Bar sends `sessionKey`)
 *   sessions.reset {sessionId}  -> "Session not found: s1" for a session the
 *                                  live gateway had just created and listed
 *
 * So both names are wired here, in `registerBuiltInMethods`, against the state
 * that actually exists: the daemon's launchd log files under the data dir, and
 * the real `sessionStore`.
 *
 * Everything below goes over real HTTP to a real started server. Importing the
 * method modules and calling their handlers is what let these two ship broken
 * in the first place: those tests pass whether or not production registers
 * anything.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import { WebSocket } from 'ws';
import path from 'node:path';
import { GatewayServer } from '../server.js';
import { MAX_MESSAGE_LENGTH } from '../log-store.js';
import { reserveTestPort } from '../../__tests__/support/test-port.js';
import type { AgentRequest, AgentResponse, ChatSession } from '../types.js';

/**
 * Temp state lives under the repo, never in the real `~/.openrappter`: these
 * tests write log files and sessions, and the gateway defaults its data dir to
 * the user's home.
 */
const TMP_ROOT = path.join(process.cwd(), '.vitest-tmp');

let server: GatewayServer;
let dataDir: string;
let base: string;

/** Resolved per test so a slow agent can be held open and released on demand. */
let agentReply: (request: AgentRequest) => Promise<AgentResponse>;

beforeAll(async () => {
  fs.mkdirSync(TMP_ROOT, { recursive: true });
  dataDir = fs.mkdtempSync(path.join(TMP_ROOT, 'bar-logs-'));
  const port = await reserveTestPort();
  base = `http://127.0.0.1:${port}`;
  server = new GatewayServer({
    port,
    bind: 'loopback',
    auth: { mode: 'none' },
    heartbeatInterval: 60_000,
    dataDir,
  });
  server.setAgentHandler((request) => agentReply(request));
  await server.start();
});

afterAll(async () => {
  await server.stop().catch(() => {});
  fs.rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(() => {
  agentReply = async (request) => ({ content: 'ok', finishReason: 'stop', sessionId: request.sessionId ?? '' });
  fs.rmSync(path.join(dataDir, 'daemon.log'), { force: true });
  fs.rmSync(path.join(dataDir, 'logs'), { recursive: true, force: true });
});

interface RpcOutcome {
  status: number;
  raw: string;
  result?: unknown;
  error?: { code: number; message: string };
}

async function rpc(method: string, params?: Record<string, unknown>): Promise<RpcOutcome> {
  const response = await fetch(`${base}/rpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: `t-${method}-${Math.random()}`, method, params: params ?? {} }),
  });
  const raw = await response.text();
  const parsed = JSON.parse(raw) as { result?: unknown; error?: { code: number; message: string } };
  return { status: response.status, raw, result: parsed.result, error: parsed.error };
}

/** A secret is built at runtime so a scanner cannot rewrite it into a literal that trivially passes. */
function freshSecret(label: string): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const body = Array.from({ length: 24 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
  return `${String.fromCharCode(103, 104, 112, 95)}${label}${body}`;
}

function writeDaemonLog(lines: string[]): void {
  fs.writeFileSync(path.join(dataDir, 'daemon.log'), `${lines.join('\n')}\n`, 'utf-8');
}

/** The shape `RpcClient.getLogs` decodes: a bare array of dictionaries. */
type LogPayload = Array<Record<string, unknown>>;

function sessionsOnDisk(): ChatSession[] {
  const file = path.join(dataDir, 'sessions.json');
  if (!fs.existsSync(file)) return [];
  return JSON.parse(fs.readFileSync(file, 'utf-8')) as ChatSession[];
}

describe('the harness itself', () => {
  it('never points the gateway at the real ~/.openrappter', () => {
    expect(dataDir.startsWith(TMP_ROOT)).toBe(true);
  });
});

describe('logs.get — the method the Bar calls', () => {
  it('is registered on a started gateway', async () => {
    const listed = await rpc('methods');
    expect(listed.result as string[]).toContain('logs.get');

    const answered = await rpc('logs.get', { limit: 10 });
    expect(answered.error).toBeUndefined();
  });

  it('returns the daemon log the launchd job actually writes', async () => {
    writeDaemonLog([
      '[2026-08-16T10:00:00.000Z] [INFO] Gateway server started on 127.0.0.1:1234',
      '[2026-08-16T10:00:05.000Z] [WARN] channel telegram disconnected',
    ]);

    const entries = (await rpc('logs.get', { limit: 100 })).result as LogPayload;
    expect(Array.isArray(entries)).toBe(true);
    expect(entries.map((e) => e.message)).toEqual([
      'Gateway server started on 127.0.0.1:1234',
      'channel telegram disconnected',
    ]);
    expect(entries.map((e) => e.level)).toEqual(['info', 'warn']);
    expect(entries.every((e) => typeof e.timestamp === 'number')).toBe(true);
    expect(entries.every((e) => e.source === 'daemon.log')).toBe(true);
  });

  it('reads the GUI LaunchAgent stdout/stderr files too', async () => {
    fs.mkdirSync(path.join(dataDir, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'logs', 'gateway.stdout.log'), 'user gateway listening\n');
    fs.writeFileSync(path.join(dataDir, 'logs', 'gateway.stderr.log'), 'Error: EADDRINUSE 127.0.0.1:18384\n');

    const entries = (await rpc('logs.get', { limit: 100 })).result as LogPayload;
    const bySource = new Map(entries.map((e) => [e.source, e]));
    expect(bySource.get('logs/gateway.stdout.log')?.message).toBe('user gateway listening');
    // A stack trace's leading `Error:` survives — it is the message, not a level.
    expect(bySource.get('logs/gateway.stderr.log')?.message).toBe('Error: EADDRINUSE 127.0.0.1:18384');
    // Anything the daemon wrote to stderr is an error even when the line says nothing.
    expect(bySource.get('logs/gateway.stderr.log')?.level).toBe('error');
  });

  it('honours the limit the Swift client sends — a smaller limit returns fewer entries', async () => {
    writeDaemonLog(
      Array.from({ length: 40 }, (_, i) =>
        `[2026-08-16T10:00:${String(i).padStart(2, '0')}.000Z] [INFO] line ${i}`)
    );

    const all = (await rpc('logs.get', { limit: 100 })).result as LogPayload;
    const few = (await rpc('logs.get', { limit: 5 })).result as LogPayload;

    expect(all).toHaveLength(40);
    expect(few).toHaveLength(5);
    expect(few.length).toBeLessThan(all.length);
    // The newest lines, not the oldest — a log pane that shows the first five
    // lines of a rotating file is showing nothing anyone needs.
    expect(few.map((e) => e.message)).toEqual([
      'line 35', 'line 36', 'line 37', 'line 38', 'line 39',
    ]);
  });

  it('caps an absurd limit instead of reading the whole file', async () => {
    writeDaemonLog(Array.from({ length: 30 }, (_, i) => `line ${i}`));
    const entries = (await rpc('logs.get', { limit: 10_000_000 })).result as LogPayload;
    expect(entries).toHaveLength(30);
  });

  it('is empty, not broken, when no daemon log exists yet', async () => {
    const entries = (await rpc('logs.get', { limit: 100 })).result as LogPayload;
    expect(entries).toEqual([]);
  });

  it('never returns raw file bytes — every line arrives as a structured entry', async () => {
    const long = 'x'.repeat(MAX_MESSAGE_LENGTH + 500);
    writeDaemonLog([long]);

    const entries = (await rpc('logs.get', { limit: 10 })).result as LogPayload;
    expect(entries).toHaveLength(1);
    const message = entries[0].message as string;
    expect(typeof message).toBe('string');
    expect(message.length).toBeLessThan(long.length);
    expect(message.endsWith('[truncated]')).toBe(true);
  });
});

describe('logs.get — redaction', () => {
  it('does not hand a secret-looking JSON field to an RPC caller', async () => {
    const secret = freshSecret('json');
    writeDaemonLog([
      JSON.stringify({
        timestamp: '2026-08-16T10:00:00.000Z',
        level: 'info',
        message: 'copilot provider ready',
        apiKey: secret,
      }),
    ]);

    const answered = await rpc('logs.get', { limit: 100 });
    expect(answered.raw).not.toContain(secret);
    expect((answered.result as LogPayload)[0].message).toBe('copilot provider ready');
  });

  it('does not hand a secret pasted into a plain log line to an RPC caller', async () => {
    const secret = freshSecret('plain');
    writeDaemonLog([
      `[2026-08-16T10:00:00.000Z] [ERROR] auth failed apiKey=${secret} status=401`,
      `[2026-08-16T10:00:01.000Z] [INFO] Authorization: Bearer ${secret}`,
    ]);

    const answered = await rpc('logs.get', { limit: 100 });
    expect(answered.raw).not.toContain(secret);
    expect(answered.raw).toContain('REDACTED');
    // The surrounding line is still useful — redaction is not deletion.
    expect((answered.result as LogPayload)[0].message).toContain('status=401');
  });

  it('leaves non-secret fields readable', async () => {
    writeDaemonLog(['[2026-08-16T10:00:00.000Z] [INFO] keyCount=3 monkey=curious']);
    const entries = (await rpc('logs.get', { limit: 10 })).result as LogPayload;
    expect(entries[0].message).toBe('keyCount=3 monkey=curious');
  });

  it('does not leak a structured record that carries no message of its own', async () => {
    const secret = freshSecret('nomessage');
    writeDaemonLog([
      JSON.stringify({ timestamp: '2026-08-16T10:00:00.000Z', level: 'info', apiKey: secret }),
    ]);

    const answered = await rpc('logs.get', { limit: 10 });
    expect(answered.raw).not.toContain(secret);
    expect((answered.result as LogPayload)[0].message).toContain('REDACTED');
  });

  it('does not leak a secret under a field name only the key pass recognises', async () => {
    // `2fa_token` starts with a digit, so the text scan finds no key/value pair
    // to judge; `redactSecrets` walking the parsed record is what catches it.
    const secret = freshSecret('twofactor');
    writeDaemonLog([
      JSON.stringify({ timestamp: '2026-08-16T10:00:00.000Z', level: 'info', '2fa_token': secret }),
    ]);

    const answered = await rpc('logs.get', { limit: 10 });
    expect(answered.raw).not.toContain(secret);
    expect((answered.result as LogPayload)[0].message).toContain('REDACTED');
  });

  it('does not leak a secret field dumped alongside a component/event record', async () => {
    const secret = freshSecret('fields');
    writeDaemonLog([
      JSON.stringify({
        timestamp: '2026-08-16T10:00:00.000Z',
        level: 'warn',
        component: 'gateway',
        event: 'auth.refresh',
        sessionToken: secret,
        durationMs: 12,
      }),
    ]);

    const answered = await rpc('logs.get', { limit: 10 });
    expect(answered.raw).not.toContain(secret);
    const message = (answered.result as LogPayload)[0].message as string;
    expect(message).toContain('gateway auth.refresh');
    expect(message).toContain('durationMs=12');
  });
});

describe('sessions.reset — the method the Bar calls', () => {
  async function sendMessage(sessionKey: string, message: string): Promise<void> {
    const accepted = await rpc('chat.send', { sessionKey, message });
    expect(accepted.error).toBeUndefined();
  }

  async function messagesOf(sessionKey: string): Promise<unknown[]> {
    const answered = await rpc('chat.messages', { sessionKey });
    return (answered.result ?? []) as unknown[];
  }

  it('is registered on a started gateway', async () => {
    const listed = await rpc('methods');
    expect(listed.result as string[]).toContain('sessions.reset');
  });

  it('accepts the sessionKey field name the Swift client sends', async () => {
    await rpc('chat.session', { sessionKey: 'reset-field-name' });
    const answered = await rpc('sessions.reset', { sessionKey: 'reset-field-name' });
    expect(answered.error).toBeUndefined();
    expect(answered.result).toMatchObject({ reset: true, sessionId: 'reset-field-name' });
  });

  it('actually empties the session — read back afterwards, the messages are gone', async () => {
    const sessionKey = 'reset-really';
    await sendMessage(sessionKey, 'first');
    await sendMessage(sessionKey, 'second');
    expect((await messagesOf(sessionKey)).length).toBeGreaterThan(0);

    const answered = await rpc('sessions.reset', { sessionKey });
    expect(answered.result).toMatchObject({ reset: true });

    // The reply is not the evidence. Ask the gateway again.
    expect(await messagesOf(sessionKey)).toEqual([]);
    const listed = (await rpc('chat.list')).result as Array<{ id: string; messageCount: number }>;
    const entry = listed.find((s) => s.id === sessionKey);
    expect(entry, 'reset clears the session, it does not delete it').toBeDefined();
    expect(entry!.messageCount).toBe(0);
  });

  it('persists the reset, so a gateway restart does not resurrect the messages', async () => {
    const sessionKey = 'reset-persisted';
    await sendMessage(sessionKey, 'remember this');
    expect(sessionsOnDisk().find((s) => s.id === sessionKey)!.messages.length).toBeGreaterThan(0);

    await rpc('sessions.reset', { sessionKey });

    const persisted = sessionsOnDisk().find((s) => s.id === sessionKey);
    expect(persisted, 'the session survives on disk').toBeDefined();
    expect(persisted!.messages).toEqual([]);
  });

  it('cancels the run in flight, so the answer cannot repopulate the session', async () => {
    const sessionKey = 'reset-midflight';
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let markStarted!: () => void;
    const handlerStarted = new Promise<void>((resolve) => { markStarted = resolve; });
    const handlerFinished = new Promise<void>((resolveFinished) => {
      agentReply = async (request) => {
        markStarted();
        await gate;
        resolveFinished();
        return { content: 'late answer', finishReason: 'stop', sessionId: request.sessionId ?? '' };
      };
    });

    await sendMessage(sessionKey, 'ask something slow');
    await handlerStarted;
    await rpc('sessions.reset', { sessionKey });

    release();
    await handlerFinished;
    // Give the completion path every chance to write the reply back.
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(await messagesOf(sessionKey)).toEqual([]);
  });

  it('refuses an unknown session instead of reporting a success it did not perform', async () => {
    const answered = await rpc('sessions.reset', { sessionKey: 'never-existed' });
    expect(answered.result).toBeUndefined();
    expect(answered.error?.message).toContain('Session not found');
  });

  it('refuses a request with no session at all', async () => {
    const answered = await rpc('sessions.reset', {});
    expect(answered.result).toBeUndefined();
    expect(answered.error?.message).toContain('sessionKey required');
  });
});

describe('the Bar transport — WebSocket frames, exactly as RpcClient sends them', () => {
  /** Connect handshake, then one request, then close. Returns the `res` frame. */
  async function wsCall(method: string, params: Record<string, unknown>): Promise<{
    ok: boolean;
    payload?: unknown;
    error?: { code: number; message: string };
  }> {
    const socket = new WebSocket(base.replace('http://', 'ws://'));
    try {
      const frames: Array<Record<string, unknown>> = [];
      const waitFor = (id: string) => new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out waiting for ${id}`)), 4000);
        const onMessage = (data: unknown) => {
          const frame = JSON.parse(String(data)) as Record<string, unknown>;
          frames.push(frame);
          if (frame.type === 'res' && frame.id === id) {
            clearTimeout(timer);
            socket.off('message', onMessage);
            resolve(frame);
          }
        };
        socket.on('message', onMessage);
      });

      await new Promise<void>((resolve, reject) => {
        socket.once('open', () => resolve());
        socket.once('error', reject);
      });

      const hello = waitFor('c1');
      socket.send(JSON.stringify({
        type: 'req',
        id: 'c1',
        method: 'connect',
        params: { client: { id: 'bar-test', version: '1.0.0', platform: 'macos', mode: 'bar' } },
      }));
      const helloFrame = await hello;
      expect(helloFrame.ok, 'handshake').toBe(true);

      const answered = waitFor('r1');
      socket.send(JSON.stringify({ type: 'req', id: 'r1', method, params }));
      return await answered as { ok: boolean; payload?: unknown; error?: { code: number; message: string } };
    } finally {
      socket.close();
    }
  }

  it('returns logs.get as a bare array payload, which is what getLogs decodes', async () => {
    writeDaemonLog(['[2026-08-16T10:00:00.000Z] [INFO] over the websocket']);
    const frame = await wsCall('logs.get', { limit: 100 });
    expect(frame.ok).toBe(true);
    expect(Array.isArray(frame.payload)).toBe(true);
    const entries = frame.payload as LogPayload;
    expect(entries[0].message).toBe('over the websocket');
    // getLogs reads exactly these keys off each dictionary.
    expect(typeof entries[0].timestamp).toBe('number');
    expect(typeof entries[0].level).toBe('string');
    expect(typeof entries[0].source).toBe('string');
  });

  it('answers sessions.reset with ok:true, which is all resetSession checks', async () => {
    await rpc('chat.session', { sessionKey: 'ws-reset' });
    const frame = await wsCall('sessions.reset', { sessionKey: 'ws-reset' });
    expect(frame.error).toBeUndefined();
    expect(frame.ok).toBe(true);
  });
});

describe('both methods are fail-closed when the gateway has credentials', () => {
  it('rejects an unauthenticated HTTP caller', async () => {
    const port = await reserveTestPort();
    const secured = new GatewayServer({
      port,
      bind: 'loopback',
      auth: { mode: 'token', tokens: [freshSecret('gateway')] },
      heartbeatInterval: 60_000,
      dataDir,
    });
    await secured.start();
    try {
      for (const method of ['logs.get', 'sessions.reset']) {
        const response = await fetch(`http://127.0.0.1:${port}/rpc`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: '1', method, params: {} }),
        });
        expect(response.status, method).toBe(401);
      }
    } finally {
      await secured.stop().catch(() => {});
    }
  });

  /**
   * The Bar talks WebSocket, and on that path `requiresAuth` is the check that
   * runs per method (`dispatchMethod`) rather than per transport. It is not
   * observable from outside — the handshake gate rejects everything first — so
   * this asserts the registration itself, on the live server's method table.
   */
  it('registers both methods as requiring authentication', () => {
    const methods = (server as unknown as {
      methods: Map<string, { requiresAuth: boolean }>;
    }).methods;
    expect(methods.get('logs.get')?.requiresAuth).toBe(true);
    expect(methods.get('sessions.reset')?.requiresAuth).toBe(true);
  });
});
