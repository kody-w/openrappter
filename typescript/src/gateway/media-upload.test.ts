import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import { GatewayServer } from './server.js';
import type { AgentRequest } from './types.js';

const TOKEN = 'media-test-token';
let root: string;
let server: GatewayServer;
let port: number;
let capturedRequest: AgentRequest | undefined;
let capturedResolve: (() => void) | undefined;
let previousFfprobePath: string | undefined;

function request(
  ws: WebSocket,
  method: string,
  params: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const id = `${method}-${Math.random()}`;
  return new Promise((resolve, reject) => {
    const onMessage = (raw: WebSocket.RawData) => {
      const frame = JSON.parse(raw.toString()) as {
        type?: string;
        id?: string;
        ok?: boolean;
        payload?: Record<string, unknown>;
        error?: { message?: string };
      };
      if (frame.type !== 'res' || frame.id !== id) return;
      ws.off('message', onMessage);
      if (frame.ok) resolve(frame.payload ?? {});
      else reject(new Error(frame.error?.message ?? 'RPC failed'));
    };
    ws.on('message', onMessage);
    ws.send(JSON.stringify({ type: 'req', id, method, params }));
  });
}

async function connect(
  token = TOKEN,
  clientId = 'media-browser',
  origin?: string,
): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
    origin: origin ?? `http://127.0.0.1:${port}`,
  });
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  await request(ws, 'connect', {
    minProtocol: 3,
    maxProtocol: 3,
    client: {
      id: clientId,
      version: '1.0.0',
      platform: 'test',
      mode: 'webchat',
    },
    auth: { token },
  });
  return ws;
}

function chunkParams(uploadId: string, offset: number, bytes: Buffer) {
  return {
    uploadId,
    offset,
    data: bytes.toString('base64'),
    chunkDigest: createHash('sha256').update(bytes).digest('hex'),
  };
}

beforeAll(async () => {
  const parent = path.join(process.cwd(), '.gateway-media-tests');
  mkdirSync(parent, { recursive: true });
  root = mkdtempSync(path.join(parent, 'case-'));
  previousFfprobePath = process.env.OPENRAPPTER_FFPROBE_PATH;
  process.env.OPENRAPPTER_FFPROBE_PATH = path.join(root, 'missing-ffprobe');
  server = new GatewayServer({
    port: 0,
    bind: 'loopback',
    auth: { mode: 'token', tokens: [TOKEN] },
    heartbeatInterval: 60_000,
    dataDir: root,
  });
  server.setAgentHandler(async (requestValue) => {
    capturedRequest = requestValue;
    capturedResolve?.();
    return {
      sessionId: requestValue.sessionId ?? 'session',
      content: 'consumed verified media',
      finishReason: 'stop',
    };
  });
  await server.start();
  port = server.port;
});

afterAll(async () => {
  await server.stop();
  if (previousFfprobePath === undefined) delete process.env.OPENRAPPTER_FFPROBE_PATH;
  else process.env.OPENRAPPTER_FFPROBE_PATH = previousFfprobePath;
  rmSync(root, { recursive: true, force: true });
  rmSync(path.join(process.cwd(), '.gateway-media-tests'), {
    recursive: true,
    force: true,
  });
});

describe('authenticated resumable media RPC', () => {
  it('rejects cross-origin and unauthorized WebSocket clients', async () => {
    const crossOrigin = new WebSocket(`ws://127.0.0.1:${port}`, {
      origin: 'https://attacker.example',
    });
    await expect(new Promise<void>((resolve, reject) => {
      crossOrigin.once('open', () => reject(new Error('cross-origin socket opened')));
      crossOrigin.once('error', () => resolve());
      crossOrigin.once('unexpected-response', () => resolve());
    })).resolves.toBeUndefined();

    const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
      origin: `http://127.0.0.1:${port}`,
    });
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    await expect(request(ws, 'connect', {
      minProtocol: 3,
      maxProtocol: 3,
      client: {
        id: 'unauthorized',
        version: '1',
        platform: 'test',
        mode: 'webchat',
      },
      auth: { token: 'wrong' },
    })).rejects.toThrow(/auth token|Unauthorized/);
    ws.close();
  });

  it('enforces ordering, replay identity, restart-style reconnect, digest, and verified chat handoff', async () => {
    let ws = await connect();
    const first = Buffer.alloc(256 * 1024);
    first.writeUInt32BE(24, 0);
    first.write('ftyp', 4, 'ascii');
    first.write('isom', 8, 'ascii');
    const tail = Buffer.from('verified-tail');
    const started = await request(ws, 'media.upload.start', {
      sessionId: 'media-session',
      filename: '../../RappFactory_Showcase_v5rough edit_backup.mp4\u0000',
      mimeType: 'application/octet-stream',
      expectedSize: first.length + tail.length,
    });
    const uploadId = String(started.uploadId);

    await expect(request(
      ws,
      'media.upload.chunk',
      chunkParams(uploadId, 1, first),
    )).rejects.toThrow(/Out-of-order/);
    await request(ws, 'media.upload.chunk', chunkParams(uploadId, 0, first));
    const replay = await request(
      ws,
      'media.upload.chunk',
      chunkParams(uploadId, 0, first),
    );
    expect(replay.receivedBytes).toBe(first.length);

    ws.close();
    const outsider = await connect(TOKEN, 'different-media-browser');
    await expect(request(outsider, 'media.upload.status', { uploadId }))
      .rejects.toThrow(/not owned/);
    outsider.close();
    ws = await connect(TOKEN, 'media-browser');
    const resumed = await request(ws, 'media.upload.status', { uploadId });
    expect(resumed).toMatchObject({
      receivedBytes: first.length,
      resumable: true,
      displayName: 'RappFactory_Showcase_v5rough edit_backup.mp4',
    });
    await request(
      ws,
      'media.upload.chunk',
      chunkParams(uploadId, first.length, tail),
    );
    const digest = createHash('sha256').update(first).update(tail).digest('hex');
    const asset = await request(ws, 'media.upload.complete', {
      uploadId,
      expectedDigest: digest,
    });
    expect(asset).toMatchObject({
      id: `sha256:${digest}`,
      size: first.length + tail.length,
      verified: true,
      storage: 'local-private',
    });
    expect(asset).not.toHaveProperty('privatePath');

    capturedRequest = undefined;
    await expect(request(ws, 'chat.send', {
      sessionKey: 'media-session',
      message: 'Inspect this video',
      attachments: [{
        type: 'file',
        path: '/renderer/chosen/path',
        mimeType: 'video/mp4',
      }],
    })).rejects.toThrow(/Renderer-provided media paths/);
    expect(capturedRequest).toBeUndefined();

    const captured = new Promise<void>((resolve) => { capturedResolve = resolve; });
    const accepted = await request(ws, 'chat.send', {
      sessionKey: 'media-session',
      message: 'Inspect this verified video',
      attachments: [{
        type: 'file',
        assetId: asset.id,
        digest,
        mimeType: 'video/mp4',
        filename: 'showcase.mp4',
      }],
    });
    expect(accepted.status).toBe('accepted');
    await captured;
    const delivered = capturedRequest as unknown as AgentRequest | undefined;
    const attachment = delivered?.attachments?.[0];
    expect(attachment).toMatchObject({
      assetId: `sha256:${digest}`,
      digest,
      size: first.length + tail.length,
    });
    expect(path.isAbsolute(attachment?.path ?? '')).toBe(true);
    expect(readFileSync(attachment!.path!)).toEqual(Buffer.concat([first, tail]));
    ws.close();
  });

  it('bounds declared size, base64 overhead, direct data, and upload cost storms', async () => {
    const ws = await connect();
    const policy = await request(ws, 'media.upload.policy');
    expect(policy).toMatchObject({
      chunkBytes: 256 * 1024,
      directThresholdBytes: 1024 * 1024,
      transport: 'websocket-base64',
      localOnly: true,
    });
    expect(Number(policy.encodedChunkMaximumBytes)).toBeLessThan(400_000);
    await expect(request(ws, 'media.upload.start', {
      sessionId: 'huge',
      filename: 'huge.mp4',
      expectedSize: 9 * 1024 * 1024 * 1024,
    })).rejects.toThrow(/between 1/);
    await expect(request(ws, 'chat.send', {
      sessionKey: 'direct',
      message: 'No amplification',
      attachments: [{
        type: 'file',
        mimeType: 'video/mp4',
        data: Buffer.alloc(1024 * 1024 + 1).toString('base64'),
      }],
    })).rejects.toThrow(/Direct attachments are limited/);
    await expect(request(ws, 'media.upload.chunk', {
      uploadId: '00000000-0000-4000-8000-000000000999',
      offset: 0,
      data: 'A===',
      chunkDigest: '0'.repeat(64),
    })).rejects.toThrow(/bounded transport policy/);
    await expect(request(ws, 'chat.send', {
      sessionKey: 'asset-traversal',
      message: 'Do not resolve this',
      attachments: [{
        type: 'file',
        mimeType: 'video/mp4',
        assetId: 'sha256:../../etc/passwd',
      }],
    })).rejects.toThrow(/digest/);

    const ids: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const started = await request(ws, 'media.upload.start', {
        sessionId: 'storm-session',
        filename: `${index}.mp4`,
        expectedSize: 12,
      });
      ids.push(String(started.uploadId));
    }
    await expect(request(ws, 'media.upload.start', {
      sessionId: 'storm-session',
      filename: 'fourth.mp4',
      expectedSize: 12,
    })).rejects.toThrow(/Session concurrent/);
    for (const uploadId of ids) {
      await request(ws, 'media.upload.cancel', { uploadId });
    }
    ws.close();
  });
});
