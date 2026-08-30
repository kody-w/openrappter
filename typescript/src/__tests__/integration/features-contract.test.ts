import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { GatewayServer } from '../../gateway/server.js';

let server: GatewayServer | undefined;
let dataDir: string | undefined;

afterEach(async () => {
  await server?.stop();
  server = undefined;
  vi.restoreAllMocks();
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  dataDir = undefined;
});

async function startServer(existingDataDir?: string): Promise<number> {
  dataDir = existingDataDir
    ?? mkdtempSync(join(process.cwd(), '.features-contract-'));
  server = new GatewayServer({
    port: 0,
    bind: 'loopback',
    auth: { mode: 'none' },
    dataDir,
  });
  await server.start();
  return server.port;
}

async function rpc(
  port: number,
  method: string,
  params?: Record<string, unknown>,
): Promise<{
  result?: Record<string, unknown>;
  error?: { message: string };
}> {
  const response = await fetch(`http://127.0.0.1:${port}/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'features-test', method, params }),
  });
  return response.json() as Promise<{
    result?: Record<string, unknown>;
    error?: { message: string };
  }>;
}

describe('features.get RPC', () => {
  it('returns a fail-closed boolean-only response when config is absent', async () => {
    const port = await startServer();
    const { result, error } = await rpc(port, 'features.get');

    expect(error).toBeUndefined();
    expect(result).toEqual({
      experimental: false,
      harnessAdapters: false,
      hermes: false,
      pi: false,
      brainSurgeonGroupChat: false,
    });
    expect(Object.values(result ?? {}).every(value => typeof value === 'boolean'))
      .toBe(true);
  });

  it('reports persisted effective gates without exposing config details', async () => {
    const port = await startServer();
    const configPath = join(dataDir!, 'config.yaml');
    const { result: snapshot } = await rpc(port, 'config.get');
    const raw = [
      'experimental:',
      '  enabled: true',
      '  harnessAdapters:',
      '    enabled: true',
      '    hermes: true',
      '    pi: false',
      '    command: never-return-this',
      '  brainSurgeonGroupChat:',
      '    enabled: true',
      '  secret: never-return-this-either',
      '',
    ].join('\n');

    const saved = await rpc(port, 'config.set', {
      raw,
      baseHash: snapshot?.hash,
    });
    expect(saved.error).toBeUndefined();
    expect(readFileSync(configPath, 'utf8')).toBe(raw);

    const first = await rpc(port, 'features.get');
    expect(first.error).toBeUndefined();
    expect(first.result).toEqual({
      experimental: true,
      harnessAdapters: true,
      hermes: true,
      pi: false,
      brainSurgeonGroupChat: true,
    });
    expect(JSON.stringify(first.result)).not.toContain('never-return-this');

    const status = await rpc(port, 'features.status');
    expect(status.error).toBeUndefined();
    expect(status.result).toEqual({
      evidence: {
        configHash: saved.result?.hash,
        configValid: true,
      },
      promotionOrder: [
        'frontier-experimental',
        'frontier',
        'brainstem-experimental',
        'grail-stable',
      ],
      features: [
        {
          id: 'hermes',
          configPath: 'experimental.harnessAdapters.hermes',
          maturity: 'frontier-experimental',
          defaultEnabled: false,
          enabled: true,
        },
        {
          id: 'pi',
          configPath: 'experimental.harnessAdapters.pi',
          maturity: 'frontier-experimental',
          defaultEnabled: false,
          enabled: false,
        },
        {
          id: 'brainSurgeonGroupChat',
          configPath: 'experimental.brainSurgeonGroupChat.enabled',
          maturity: 'frontier-experimental',
          defaultEnabled: false,
          enabled: true,
        },
      ],
    });
    expect(JSON.stringify(status.result)).not.toContain('never-return-this');

    await server?.stop();
    server = undefined;
    const restartedPort = await startServer(dataDir);
    const restarted = await rpc(restartedPort, 'features.get');
    expect(restarted.result).toEqual(first.result);
  });

  it('returns disabled flags instead of leaking parser errors', async () => {
    const port = await startServer();
    writeFileSync(
      join(dataDir!, 'config.yaml'),
      'experimental:\n  enabled: [\n',
      'utf8',
    );

    const { result, error } = await rpc(port, 'features.get');
    expect(error).toBeUndefined();
    expect(result).toEqual({
      experimental: false,
      harnessAdapters: false,
      hermes: false,
      pi: false,
      brainSurgeonGroupChat: false,
    });

    const status = await rpc(port, 'features.status');
    expect(status.error).toBeUndefined();
    expect(status.result?.evidence).toEqual({
      configHash: expect.any(String),
      configValid: false,
    });
    expect(
      (status.result?.features as Array<{ enabled: boolean }> | undefined)
        ?.every(feature => feature.enabled === false),
    ).toBe(true);
  });

  it('fails closed when valid YAML violates the config schema', async () => {
    const port = await startServer();
    writeFileSync(
      join(dataDir!, 'config.yaml'),
      [
        'experimental:',
        '  enabled: true',
        '  harnessAdapters:',
        '    enabled: true',
        '    hermes: true',
        '  voiceMode:',
        '    engine: not-a-real-engine',
        '',
      ].join('\n'),
      'utf8',
    );

    const features = await rpc(port, 'features.get');
    expect(features.result).toEqual({
      experimental: false,
      harnessAdapters: false,
      hermes: false,
      pi: false,
      brainSurgeonGroupChat: false,
    });
    const status = await rpc(port, 'features.status');
    expect(status.result?.evidence).toEqual({
      configHash: expect.any(String),
      configValid: false,
    });
  });

  it('treats a repeated successful save as an idempotent retry', async () => {
    const port = await startServer();
    const { result: snapshot } = await rpc(port, 'config.get');
    const raw = 'experimental:\n  enabled: false\n';

    const first = await rpc(port, 'config.set', {
      raw,
      baseHash: snapshot?.hash,
    });
    const retry = await rpc(port, 'config.set', {
      raw,
      baseHash: snapshot?.hash,
    });

    expect(first.error).toBeUndefined();
    expect(retry.error).toBeUndefined();
    expect(retry.result).toEqual(first.result);
    expect(readFileSync(join(dataDir!, 'config.yaml'), 'utf8')).toBe(raw);
  });

  it('preserves the previous config and recovers after an interrupted rename', async () => {
    const port = await startServer();
    const configPath = join(dataDir!, 'config.yaml');
    const original = 'experimental:\n  enabled: false\n';
    const replacement = 'experimental:\n  enabled: true\n';
    writeFileSync(configPath, original, 'utf8');
    const { result: snapshot } = await rpc(port, 'config.get');

    const rename = vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
      throw new Error('simulated atomic rename interruption');
    });
    const interrupted = await rpc(port, 'config.set', {
      raw: replacement,
      baseHash: snapshot?.hash,
    });

    expect(interrupted.error?.message).toContain('simulated atomic rename interruption');
    expect(readFileSync(configPath, 'utf8')).toBe(original);
    expect(readdirSync(dataDir!).filter(name => name.endsWith('.tmp'))).toEqual([]);

    rename.mockRestore();
    const recovered = await rpc(port, 'config.set', {
      raw: replacement,
      baseHash: snapshot?.hash,
    });
    expect(recovered.error).toBeUndefined();
    expect(readFileSync(configPath, 'utf8')).toBe(replacement);
  });

  it('recovers idempotently when commit durability acknowledgement is interrupted', async () => {
    if (process.platform === 'win32') return;

    const port = await startServer();
    const configPath = join(dataDir!, 'config.yaml');
    const original = 'experimental:\n  enabled: false\n';
    const replacement = 'experimental:\n  enabled: true\n';
    writeFileSync(configPath, original, 'utf8');
    const { result: snapshot } = await rpc(port, 'config.get');

    const realFsync = fs.fsyncSync.bind(fs);
    let syncCount = 0;
    const fsync = vi.spyOn(fs, 'fsyncSync').mockImplementation((descriptor) => {
      syncCount++;
      if (syncCount === 2) {
        throw new Error('simulated directory sync interruption');
      }
      realFsync(descriptor);
    });
    const uncertain = await rpc(port, 'config.set', {
      raw: replacement,
      baseHash: snapshot?.hash,
    });

    expect(uncertain.error?.message).toContain('simulated directory sync interruption');
    expect(readFileSync(configPath, 'utf8')).toBe(replacement);
    expect(readdirSync(dataDir!).filter(name => name.endsWith('.tmp'))).toEqual([]);

    fsync.mockRestore();
    const recovered = await rpc(port, 'config.set', {
      raw: replacement,
      baseHash: snapshot?.hash,
    });
    expect(recovered.error).toBeUndefined();
    expect(readFileSync(configPath, 'utf8')).toBe(replacement);
  });
});
