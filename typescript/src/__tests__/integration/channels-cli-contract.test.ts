/**
 * The `channels` CLI sent `{ channel }` where every gateway handler reads
 * `params.type`, so `connect` and `disconnect` passed `undefined` to the
 * registry (#206).
 *
 * The subtler defect was `connect --config`. `channels.connect` accepts only
 * `{ type }` and ignores everything else, while configuration is a separate
 * `channels.configure` call. So a user could pass a channel's credentials on
 * the command line, read `Connected channel: slack`, and have configured
 * nothing -- a flag that looked like it worked and did not.
 *
 * These tests drive a real `GatewayServer` with a stub registry, because the
 * thing that was broken is the contract, not the source text.
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

/** Records what the registry was actually asked to do. */
interface Seen {
  connected: unknown[];
  disconnected: unknown[];
  configured: Array<{ type: unknown; config: unknown }>;
}

async function startGateway(): Promise<{
  call: (m: string, p?: unknown) => Promise<unknown>;
  seen: Seen;
}> {
  dataDir = mkdtempSync(join(tmpdir(), 'openrappter-channels-test-'));
  server = new GatewayServer({ port: 0, bind: 'loopback', auth: { mode: 'none' }, dataDir });
  await server.start();

  const seen: Seen = { connected: [], disconnected: [], configured: [] };
  (server as unknown as { channelRegistry: unknown }).channelRegistry = {
    getStatusList: () => [
      { id: 'telegram', type: 'telegram', connected: false, configured: true, running: false, messageCount: 0 },
    ],
    connectChannel: async (type: unknown) => { seen.connected.push(type); },
    disconnectChannel: async (type: unknown) => { seen.disconnected.push(type); },
    configureChannel: (type: unknown, config: unknown) => { seen.configured.push({ type, config }); },
    probeChannel: (type: unknown) => ({ ok: true, type }),
    getChannelConfig: () => ({ token: 'super-secret-value' }),
  };
  // `channels.configure` persists; keep it off the real filesystem.
  (server as unknown as { persistChannelConfig: () => Promise<void> }).persistChannelConfig =
    async () => undefined;

  const methods = (server as unknown as { methods: Map<string, { handler: Handler }> }).methods;
  const call = async (method: string, params: unknown = {}) => {
    const entry = methods.get(method);
    if (!entry) throw new Error(`Method '${method}' not found`);
    return entry.handler(params, { authenticated: true });
  };
  return { call, seen };
}

describe('channels CLI contract', () => {
  it('reaches the registry with `type`, and not with `channel`', async () => {
    const { call, seen } = await startGateway();

    await call('channels.connect', { type: 'telegram' });
    expect(seen.connected).toEqual(['telegram']);

    // The bug: `{ channel }` is accepted by the handler and forwards undefined,
    // so it fails silently rather than erroring. Pinning it keeps the CLI from
    // drifting back to a name nothing reads.
    await call('channels.connect', { channel: 'telegram' });
    expect(seen.connected).toEqual(['telegram', undefined]);
  });

  it('disconnect has the same contract', async () => {
    const { call, seen } = await startGateway();
    await call('channels.disconnect', { type: 'telegram' });
    expect(seen.disconnected).toEqual(['telegram']);
  });

  it('connect ignores config, so configuring needs its own call', async () => {
    const { call, seen } = await startGateway();

    await call('channels.connect', { type: 'telegram', config: { token: 'abc' } });
    expect(seen.connected).toEqual(['telegram']);

    // Nothing was configured -- which is exactly what `connect --config` used
    // to do while reporting success.
    expect(seen.configured).toEqual([]);

    await call('channels.configure', { type: 'telegram', config: { token: 'abc' } });
    expect(seen.configured).toEqual([{ type: 'telegram', config: { token: 'abc' } }]);
  });

  it('every method the CLI calls is registered', async () => {
    const { call } = await startGateway();
    const source = readFileSync(resolve(__dirname, '../../cli/channels.ts'), 'utf-8');
    const called = [...source.matchAll(/client\.call\(\s*'([^']+)'/g)].map((m) => m[1]);

    // Guard the guard: an extractor matching nothing would prove nothing.
    expect(called.length).toBeGreaterThanOrEqual(5);

    for (const method of new Set(called)) {
      await expect(call(method, { type: 'telegram', config: {} })).resolves.toBeDefined();
    }
  });

  it('the CLI sends `type`, never `channel`', async () => {
    // The gateway-driven tests above would still pass if cli/channels.ts
    // drifted back, so read what it actually sends.
    const source = readFileSync(resolve(__dirname, '../../cli/channels.ts'), 'utf-8');

    // Every object literal passed to client.call, checked for a `channel`
    // property in any form. An earlier version of this test only matched
    // `{ channel }` shorthand and let `{ channel: type }` through -- it passed
    // against a deliberately reintroduced bug, which is how it was found.
    const payloads = [...source.matchAll(/client\.call\(\s*'[^']+'\s*,\s*(\{[^}]*\})/g)]
      .map((m) => m[1]);
    expect(payloads.length).toBeGreaterThanOrEqual(4);

    for (const payload of payloads) {
      expect(payload).not.toMatch(/\bchannel\b/);
    }
    expect(payloads.filter((p) => /\btype\b/.test(p)).length).toBeGreaterThanOrEqual(4);
  });

  it('a channel config is redacted before printing', async () => {
    // A channel config holds the channel's token. #178 removed even a token
    // prefix from `login` output; printing the whole value here would undo it.
    const source = readFileSync(resolve(__dirname, '../../cli/channels.ts'), 'utf-8');
    expect(source).toMatch(/redactSecrets\(/);
    expect(source).not.toMatch(/JSON\.stringify\(result, null, 2\)\);[\s\S]{0,80}getConfig/);
  });
});
