import { describe, it, expect, afterEach, vi } from 'vitest';
import WebSocket from 'ws';

import { GatewayServer } from '../../gateway/server.js';

/**
 * Stop has to stop the brainstem, not just stop the gateway listening.
 *
 * `chat.abort` marks the run aborted and broadcasts `state: 'aborted'`, so the
 * UI goes quiet immediately. That was the whole of it: the HTTP request to the
 * brainstem carried on, produced a full reply, and the result was discarded
 * after the fact. From every angle a person can see, Stop worked — while a
 * hosted model kept generating billed output nobody would read.
 *
 * The client-side tests prove `askBrainstem` honours a signal. They cannot
 * prove the gateway ever fires one, and when I removed `run.controller.abort()`
 * from `abortActiveRun` all of them still passed. This test is the half that
 * was missing: it drives the real server over a real socket and asserts the
 * in-flight request was actually cancelled.
 */

let server: GatewayServer | null = null;
let sockets: WebSocket[] = [];

async function connect(port: number): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  sockets.push(ws);
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  return ws;
}

/** Send a request and wait for the matching response frame. */
function rpc(ws: WebSocket, id: string, method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 5000);
    const onMessage = (raw: WebSocket.RawData) => {
      const frame = JSON.parse(String(raw)) as Record<string, unknown>;
      if (frame.id !== id) return;
      clearTimeout(timer);
      ws.off('message', onMessage);
      resolve(frame);
    };
    ws.on('message', onMessage);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

afterEach(async () => {
  vi.unstubAllGlobals();
  for (const ws of sockets) {
    try { ws.close(); } catch { /* already closed */ }
  }
  sockets = [];
  if (server) {
    await server.stop();
    server = null;
  }
});

describe('aborting a brainstem turn', () => {
  it('cancels the in-flight request rather than discarding its answer', async () => {
    let requestSignal: AbortSignal | null = null;
    let resolvedNormally = false;

    // A brainstem that never answers on its own. The only way this request
    // finishes is if somebody cancels it — which is exactly the claim.
    vi.stubGlobal('fetch', (async (url: string | URL, init?: RequestInit) => {
      if (String(url).endsWith('/health')) {
        return new Response('{"status":"ok"}', { status: 200 });
      }
      requestSignal = init?.signal ?? null;
      await new Promise<void>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const error = new Error('This operation was aborted');
          error.name = 'AbortError';
          reject(error);
        });
      });
      resolvedNormally = true;
      return new Response('{}');
    }) as unknown as typeof fetch);

    server = new GatewayServer({ port: 0, bind: 'loopback', auth: { mode: 'none' } });
    await server.start();
    const port = server.port;

    const ws = await connect(port);
    await rpc(ws, 'c-1', 'connect', {
      client: { id: 'abort-test', version: '1.0.0', platform: 'node', mode: 'control' },
    });

    const sent = await rpc(ws, 's-1', 'chat.send', {
      message: 'take your time',
      sessionKey: 'abort-session',
      target: 'brainstem',
    });
    const accepted = sent.payload as { runId: string };
    expect(accepted.runId, 'chat.send should accept the brainstem run').toBeTruthy();

    // Give the deferred dispatch a moment to actually issue the request.
    await vi.waitFor(() => expect(requestSignal).not.toBeNull(), { timeout: 3000 });
    expect(requestSignal!.aborted, 'not cancelled before Stop').toBe(false);

    const aborted = await rpc(ws, 'a-1', 'chat.abort', { runId: accepted.runId });
    expect((aborted.payload as { aborted: boolean }).aborted).toBe(true);

    // The point of the whole change: the request itself is cancelled, so the
    // brainstem stops generating instead of finishing an unread reply.
    await vi.waitFor(() => expect(requestSignal!.aborted).toBe(true), { timeout: 3000 });
    expect(resolvedNormally, 'the request must not have run to completion').toBe(false);
  }, 30_000);
});
