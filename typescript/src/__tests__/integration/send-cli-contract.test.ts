/**
 * The `send` CLI got every field name wrong.
 *
 * `channels.send` takes a `SendMessageRequest` (`gateway/types.ts:246`) --
 * `{ channelId, conversationId, content, attachments }` -- and the command
 * sent `{ channel, message, target, attachment }`, so all four arrived
 * `undefined` at the registry (#206). `metadata` is not in that request at
 * all, so it was accepted and discarded.
 *
 * `--all` is a separate problem and is **not** fixed here: it called
 * `channels.broadcast`, which no gateway registers. Implementing it, dropping
 * it, or fanning out client-side is a decision about blast radius for a
 * command that messages real people, so the flag now refuses instead of
 * producing a method-not-found stack trace that reads like a transport fault.
 *
 * These tests drive a real `GatewayServer` with a recording registry, because
 * the thing that was broken is what the registry receives.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { GatewayServer } from '../../gateway/server.js';

let server: GatewayServer | undefined;
let dataDir: string | undefined;

afterEach(async () => {
  await server?.stop();
  server = undefined;
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  dataDir = undefined;
});

type Handler = (params: unknown, ctx: unknown) => Promise<unknown>;

async function startGateway(): Promise<{
  call: (m: string, p?: unknown) => Promise<unknown>;
  sent: unknown[];
  has: (m: string) => boolean;
}> {
  dataDir = mkdtempSync(join(tmpdir(), 'openrappter-send-test-'));
  server = new GatewayServer({ port: 0, bind: 'loopback', auth: { mode: 'none' }, dataDir });
  await server.start();

  const sent: unknown[] = [];
  (server as unknown as { channelRegistry: unknown }).channelRegistry = {
    getStatusList: () => [],
    sendMessage: async (request: unknown) => { sent.push(request); },
  };

  const methods = (server as unknown as { methods: Map<string, { handler: Handler }> }).methods;
  return {
    sent,
    has: (m: string) => methods.has(m),
    call: async (method: string, params: unknown = {}) => {
      const entry = methods.get(method);
      if (!entry) throw new Error(`Method '${method}' not found`);
      return entry.handler(params, { authenticated: true });
    },
  };
}

const SOURCE = readFileSync(resolve(__dirname, '../../cli/send.ts'), 'utf-8');

describe('send CLI contract', () => {
  it('the gateway reads the fields the CLI now sends', async () => {
    const { call, sent } = await startGateway();

    await call('channels.send', {
      channelId: 'telegram',
      conversationId: '12345',
      content: 'hello',
    });

    expect(sent).toEqual([
      { channelId: 'telegram', conversationId: '12345', content: 'hello' },
    ]);
  });

  it('the old field names arrive as undefined', async () => {
    // Why this failed silently: the handler accepts any object and forwards
    // it, so the registry received a request with no channel, no conversation
    // and no content -- and nothing threw.
    const { call, sent } = await startGateway();

    await call('channels.send', { channel: 'telegram', message: 'hello', target: '12345' });

    const request = sent[0] as Record<string, unknown>;
    expect(request.channelId).toBeUndefined();
    expect(request.conversationId).toBeUndefined();
    expect(request.content).toBeUndefined();
  });

  it('channels.broadcast still does not exist', async () => {
    // The premise of refusing `--all`. If this ever fails, the flag can be
    // implemented and this test is the thing that says so.
    const { has } = await startGateway();
    expect(has('channels.send')).toBe(true);
    expect(has('channels.broadcast')).toBe(false);
  });

  it('the CLI sends the schema field names, and none of the old ones', () => {
    const payloads = [...SOURCE.matchAll(/client\.call\(\s*'[^']+'\s*,\s*(\w+)\s*\)/g)];
    expect(payloads.length).toBeGreaterThanOrEqual(1);

    for (const name of ['channelId', 'conversationId', 'content']) {
      expect(SOURCE).toContain(`${name}:`);
    }
    // The old spellings must not come back as request keys.
    expect(SOURCE).not.toMatch(/params\.(target|message)\s*=/);
    expect(SOURCE).not.toMatch(/\{\s*channel,\s*message\s*\}/);
  });

  it('does not offer a flag it cannot honour', () => {
    // `--metadata` was accepted and discarded: SendMessageRequest has no such
    // field. Removed rather than left as a silent no-op.
    //
    // Checked as an option *declaration*, not as any mention: the header
    // comment explains why the flag is gone, and a bare /--metadata/ matched
    // that explanation. Exactly the mistake #304's env-var guard made, where
    // a doc-comment made dead variables look alive.
    expect(SOURCE).not.toMatch(/\.option\([^)]*--metadata/);
    expect(SOURCE).toMatch(/--all is not supported/);
  });

  it('reads the delivery confirmation instead of assuming it', () => {
    // `channels.send` answers `{ sent: true }`. Printing "Message sent"
    // without reading that is how an undelivered message gets recorded as
    // delivered (#134).
    expect(SOURCE).toMatch(/result\?\.sent/);
    expect(SOURCE).toMatch(/did not confirm delivery/);
  });
});
