import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { gateway } from '../services/gateway.js';
import {
  IncrementalSha256,
  MediaUploadClient,
} from '../services/media-ingest.js';
import type {
  MediaAssetDescriptor,
  MediaUploadStatus,
} from '../types.js';

function status(
  uploadId: string,
  expectedSize: number,
  receivedBytes = 0,
): MediaUploadStatus {
  const timestamp = new Date().toISOString();
  return {
    schema: 'openrappter-media-upload/1.0',
    uploadId,
    sessionId: 'session',
    displayName: 'large.mp4',
    mimeType: 'video/mp4',
    expectedSize,
    receivedBytes,
    chunkBytes: 256 * 1024,
    phase: 'uploading',
    resumable: true,
    localOnly: true,
    createdAt: timestamp,
    updatedAt: timestamp,
    expiresAt: timestamp,
  };
}

function largeFile(): File {
  const bytes = new Uint8Array(1024 * 1024 + 17);
  bytes[3] = 24;
  bytes.set(new TextEncoder().encode('ftypisom'), 4);
  for (let index = 12; index < bytes.length; index += 1) bytes[index] = index & 0xff;
  return new File([bytes], 'large.mp4', {
    type: 'video/mp4',
    lastModified: 123,
  });
}

beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key: string) => values.get(key) ?? null,
    key: (index: number) => [...values.keys()][index] ?? null,
    removeItem: (key: string) => values.delete(key),
    setItem: (key: string, value: string) => values.set(key, String(value)),
  } satisfies Storage);
  delete window.openrappterDesktop;
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('browser media upload client', () => {
  it('computes incremental SHA-256 across arbitrary chunk boundaries', () => {
    const hash = new IncrementalSha256();
    hash.update(new TextEncoder().encode('a'));
    hash.update(new TextEncoder().encode('bc'));
    expect(hash.digestHex()).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('uploads only bounded chunks, reports progress, and completes with the exact digest', async () => {
    const file = largeFile();
    const received: Uint8Array[] = [];
    const progresses: number[] = [];
    const uploadId = '00000000-0000-4000-8000-000000000001';
    const asset: MediaAssetDescriptor = {
      schema: 'openrappter-media-asset/1.0',
      id: 'sha256:placeholder',
      digest: 'placeholder',
      size: file.size,
      mimeType: 'video/mp4',
      kind: 'video',
      displayName: file.name,
      storage: 'local-private',
      verified: true,
      deduplicated: false,
      createdAt: new Date().toISOString(),
    };
    const request = vi.spyOn(gateway, 'request').mockImplementation(
      async (method: string, params?: Record<string, unknown>) => {
        if (method === 'media.upload.policy') {
          return {
            directThresholdBytes: 1024 * 1024,
            chunkBytes: 256 * 1024,
            maxFileBytes: 4 * 1024 * 1024,
            transport: 'websocket-base64',
            encodedChunkMaximumBytes: 349_528,
            localOnly: true,
          } as never;
        }
        if (method === 'media.upload.start') return status(uploadId, file.size) as never;
        if (method === 'media.upload.chunk') {
          const bytes = Uint8Array.from(atob(String(params?.data)), (char) => char.charCodeAt(0));
          expect(bytes.length).toBeLessThanOrEqual(256 * 1024);
          expect(params?.chunkDigest).toBe(
            createHash('sha256').update(bytes).digest('hex'),
          );
          received.push(bytes);
          const committed = received.reduce((sum, chunk) => sum + chunk.length, 0);
          return status(uploadId, file.size, committed) as never;
        }
        if (method === 'media.upload.complete') {
          const all = Buffer.concat(received.map((chunk) => Buffer.from(chunk)));
          expect(params?.expectedDigest).toBe(
            createHash('sha256').update(all).digest('hex'),
          );
          return {
            ...asset,
            id: `sha256:${String(params?.expectedDigest)}`,
            digest: String(params?.expectedDigest),
          } as never;
        }
        throw new Error(`unexpected ${method}`);
      },
    );

    const result = await new MediaUploadClient().upload(file, {
      sessionId: 'session',
      onProgress: (progress) => progresses.push(progress.percent),
    });
    expect(result.size).toBe(file.size);
    expect(Buffer.concat(received.map((chunk) => Buffer.from(chunk))).length).toBe(file.size);
    expect(progresses.at(-1)).toBe(100);
    expect(request).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ path: expect.anything() }),
    );
  });

  it('keeps a failed upload resumable and continues from the server offset on retry', async () => {
    const file = largeFile();
    const uploadId = '00000000-0000-4000-8000-000000000002';
    let completeCalls = 0;
    let committed = 0;
    const offsets: number[] = [];
    vi.spyOn(gateway, 'request').mockImplementation(
      async (method: string, params?: Record<string, unknown>) => {
        if (method === 'media.upload.policy') {
          return {
            directThresholdBytes: 1024 * 1024,
            chunkBytes: 256 * 1024,
            maxFileBytes: 4 * 1024 * 1024,
            transport: 'websocket-base64',
            encodedChunkMaximumBytes: 349_528,
            localOnly: true,
          } as never;
        }
        if (method === 'media.upload.start') return status(uploadId, file.size) as never;
        if (method === 'media.upload.status') return status(uploadId, file.size, committed) as never;
        if (method === 'media.upload.chunk') {
          offsets.push(Number(params?.offset));
          committed = Number(params?.offset) + Buffer.from(String(params?.data), 'base64').length;
          return status(uploadId, file.size, committed) as never;
        }
        if (method === 'media.upload.complete') {
          completeCalls += 1;
          if (completeCalls === 1) throw new Error('connection lost after final chunk');
          return {
            schema: 'openrappter-media-asset/1.0',
            id: `sha256:${String(params?.expectedDigest)}`,
            digest: String(params?.expectedDigest),
            size: file.size,
            mimeType: 'video/mp4',
            kind: 'video',
            displayName: file.name,
            storage: 'local-private',
            verified: true,
            deduplicated: false,
            createdAt: new Date().toISOString(),
          } as never;
        }
        throw new Error(`unexpected ${method}`);
      },
    );

    await expect(new MediaUploadClient().upload(file, { sessionId: 'session' }))
      .rejects.toThrow(/connection lost/);
    offsets.length = 0;
    await expect(new MediaUploadClient().upload(file, { sessionId: 'session' }))
      .resolves.toMatchObject({ verified: true });
    expect(offsets).toEqual([]);
  });

  it('cancels server staging when the caller aborts', async () => {
    const file = largeFile();
    const controller = new AbortController();
    const calls: string[] = [];
    const uploadId = '00000000-0000-4000-8000-000000000003';
    vi.spyOn(gateway, 'request').mockImplementation(
      async (method: string, params?: Record<string, unknown>) => {
        calls.push(method);
        if (method === 'media.upload.policy') {
          return {
            directThresholdBytes: 1024 * 1024,
            chunkBytes: 256 * 1024,
            maxFileBytes: 4 * 1024 * 1024,
            transport: 'websocket-base64',
            encodedChunkMaximumBytes: 349_528,
            localOnly: true,
          } as never;
        }
        if (method === 'media.upload.start') return status(uploadId, file.size) as never;
        if (method === 'media.upload.chunk') {
          controller.abort();
          return status(
            uploadId,
            file.size,
            Number(params?.offset) + Buffer.from(String(params?.data), 'base64').length,
          ) as never;
        }
        if (method === 'media.upload.cancel') return { cancelled: true } as never;
        throw new Error(`unexpected ${method}`);
      },
    );

    await expect(new MediaUploadClient().upload(file, {
      sessionId: 'session',
      signal: controller.signal,
    })).rejects.toMatchObject({ name: 'AbortError' });
    expect(calls).toContain('media.upload.cancel');
  });
});
