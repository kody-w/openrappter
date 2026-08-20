import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { GatewayServer } from '../../gateway/server.js';

/**
 * Binds the config clients to the handler that actually runs.
 *
 * Three clients each spoke a different dialect and none of them matched this
 * server. `typescript/src/gateway/methods/config-methods.ts` does speak the
 * dashboard's dialect, and the dashboard's own unit tests assert against it —
 * but that module is deliberately never registered (see the doc comment on
 * `registerBuiltinMethods`), so those tests passed while every real save
 * failed.
 *
 *   dashboard  ui/src/services/config.ts   sends { raw, baseHash }
 *   macOS Bar  RpcClient.swift             sends { config }
 *   this server                            read  { content }
 *
 * These tests therefore go over real HTTP to a real GatewayServer. A test that
 * imported the method module would reproduce the original bug exactly.
 */

let server: GatewayServer | undefined;
let dataDir: string | undefined;

afterEach(async () => {
  await server?.stop();
  server = undefined;
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  dataDir = undefined;
});

async function startServer(): Promise<{ port: number; configPath: string }> {
  dataDir = mkdtempSync(join(tmpdir(), 'cfg-contract-'));
  server = new GatewayServer({ port: 0, bind: 'loopback', auth: { mode: 'none' }, dataDir });
  await server.start();
  const port = server.port;
  return { port, configPath: join(dataDir, 'config.yaml') };
}

async function rpc(port: number, method: string, params?: Record<string, unknown>) {
  const res = await fetch(`http://127.0.0.1:${port}/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'c1', method, params }),
  });
  return (await res.json()) as { result?: Record<string, unknown>; error?: { message: string } };
}

describe('config RPC contract, against the wired gateway', () => {
  it('config.get returns the fields the dashboard reads', async () => {
    const { port, configPath } = await startServer();
    writeFileSync(configPath, 'gateway:\n  port: 18790\n', 'utf-8');

    const { result } = await rpc(port, 'config.get');

    // ui/src/services/config.ts reads snap.raw, snap.hash, snap.format.
    expect(result?.raw).toBe('gateway:\n  port: 18790\n');
    expect(typeof result?.hash).toBe('string');
    expect(result?.hash).not.toBe('');
    expect(result?.format).toBe('yaml');
  });

  it('config.set accepts the dashboard payload and writes it', async () => {
    const { port, configPath } = await startServer();
    writeFileSync(configPath, 'old: true\n', 'utf-8');
    const { result: snap } = await rpc(port, 'config.get');

    const { result, error } = await rpc(port, 'config.set', {
      raw: 'new: true\n',
      baseHash: snap?.hash,
    });

    expect(error).toBeUndefined();
    expect(result?.saved).toBe(true);
    expect(readFileSync(configPath, 'utf-8')).toBe('new: true\n');
  });

  it('config.apply is registered, because the dashboard calls it', async () => {
    const { port, configPath } = await startServer();
    writeFileSync(configPath, 'old: true\n', 'utf-8');
    const { result: snap } = await rpc(port, 'config.get');

    const { error } = await rpc(port, 'config.apply', {
      raw: 'applied: true\n',
      baseHash: snap?.hash,
    });

    expect(error).toBeUndefined();
    expect(readFileSync(configPath, 'utf-8')).toBe('applied: true\n');
  });

  it('accepts the macOS Bar payload, which names the field `config`', async () => {
    const { port, configPath } = await startServer();

    const { error } = await rpc(port, 'config.set', { config: 'from: bar\n' });

    expect(error).toBeUndefined();
    expect(readFileSync(configPath, 'utf-8')).toBe('from: bar\n');
  });

  it('still accepts the legacy `content` field', async () => {
    const { port, configPath } = await startServer();

    const { error } = await rpc(port, 'config.set', { content: 'from: legacy\n' });

    expect(error).toBeUndefined();
    expect(readFileSync(configPath, 'utf-8')).toBe('from: legacy\n');
  });

  it('refuses a payload with no config in any accepted field', async () => {
    const { port, configPath } = await startServer();
    writeFileSync(configPath, 'untouched: true\n', 'utf-8');

    const { error } = await rpc(port, 'config.set', { nonsense: 1 });

    expect(error?.message).toMatch(/requires a string/i);
    // The point of failing loudly: the previous handler wrote `undefined` and
    // threw a type error from deep inside fs.
    expect(readFileSync(configPath, 'utf-8')).toBe('untouched: true\n');
  });

  it('refuses to overwrite an edit the client never saw', async () => {
    const { port, configPath } = await startServer();
    writeFileSync(configPath, 'v: 1\n', 'utf-8');
    const { result: snap } = await rpc(port, 'config.get');

    // Someone else saves in between.
    writeFileSync(configPath, 'v: 2 from someone else\n', 'utf-8');

    const { error } = await rpc(port, 'config.set', {
      raw: 'v: 3 stale client\n',
      baseHash: snap?.hash,
    });

    expect(error?.message).toMatch(/changed since it was loaded/i);
    expect(readFileSync(configPath, 'utf-8')).toBe('v: 2 from someone else\n');
  });

  it('allows a save with no baseHash, so older clients are not locked out', async () => {
    const { port, configPath } = await startServer();
    writeFileSync(configPath, 'v: 1\n', 'utf-8');

    const { error } = await rpc(port, 'config.set', { raw: 'v: 2\n' });

    expect(error).toBeUndefined();
    expect(readFileSync(configPath, 'utf-8')).toBe('v: 2\n');
  });
});
