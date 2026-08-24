import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  MEDIA_UPLOAD_CHUNK_BYTES,
  MediaIngestService,
} from './ingest.js';

const roots: string[] = [];

function root(): string {
  const parent = path.join(process.cwd(), '.media-mutation-tests');
  mkdirSync(parent, { recursive: true });
  const value = mkdtempSync(path.join(parent, 'case-'));
  roots.push(value);
  return value;
}

function createService(
  directory = root(),
  policy: ConstructorParameters<typeof MediaIngestService>[0]['policy'] = {},
) {
  return new MediaIngestService({
    root: directory,
    ffprobePath: path.join(directory, 'missing-ffprobe'),
    policy: {
      minimumFreeBytes: 1,
      sessionStagingQuotaBytes: 64 * 1024 * 1024,
      globalStagingQuotaBytes: 64 * 1024 * 1024,
      ...policy,
    },
  });
}

function mp4Header(): Buffer {
  return Buffer.from([
    0x00, 0x00, 0x00, 0x18,
    0x66, 0x74, 0x79, 0x70,
    0x69, 0x73, 0x6f, 0x6d,
  ]);
}

async function append(
  service: MediaIngestService,
  ownerId: string,
  uploadId: string,
  offset: number,
  bytes: Buffer,
  digest = createHash('sha256').update(bytes).digest('hex'),
) {
  return service.appendChunk({
    ownerId,
    uploadId,
    offset,
    bytes,
    chunkDigest: digest,
  });
}

afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
  rmSync(path.join(process.cwd(), '.media-mutation-tests'), {
    recursive: true,
    force: true,
  });
});

describe('media ingest mutation and adjacent-bypass resistance', () => {
  it('rejects every one-bit mutation of the MP4 ftyp magic despite a trusted extension and MIME', async () => {
    const service = createService();
    await service.initialize();
    const original = mp4Header();
    for (let byte = 4; byte < 8; byte += 1) {
      for (let bit = 0; bit < 8; bit += 1) {
        const mutant = Buffer.from(original);
        mutant[byte] ^= 1 << bit;
        const started = await service.startUpload({
          ownerId: 'magic-owner',
          sessionId: `mutant-${byte}-${bit}`,
          filename: 'trusted.mp4',
          mimeType: 'video/mp4',
          expectedSize: mutant.length,
        });
        await append(service, 'magic-owner', started.uploadId, 0, mutant);
        await expect(service.completeUpload({
          ownerId: 'magic-owner',
          uploadId: started.uploadId,
          expectedDigest: createHash('sha256').update(mutant).digest('hex'),
        })).rejects.toThrow(/Unsupported media container/);
      }
    }
  });

  it('rejects digest mutations before writing and rejects non-final short chunks', async () => {
    const service = createService();
    await service.initialize();
    const first = Buffer.alloc(MEDIA_UPLOAD_CHUNK_BYTES);
    mp4Header().copy(first);
    const started = await service.startUpload({
      ownerId: 'chunk-owner',
      sessionId: 'chunk-session',
      filename: 'chunks.mp4',
      expectedSize: MEDIA_UPLOAD_CHUNK_BYTES + 1,
    });
    const badDigest = createHash('sha256').update(first).digest('hex')
      .replace(/^./, (character) => character === '0' ? '1' : '0');
    await expect(append(
      service,
      'chunk-owner',
      started.uploadId,
      0,
      first,
      badDigest,
    )).rejects.toThrow(/Chunk digest mismatch/);
    await expect(append(
      service,
      'chunk-owner',
      started.uploadId,
      0,
      first.subarray(0, first.length - 1),
    )).rejects.toThrow(/does not align/);
    expect((await service.status('chunk-owner', started.uploadId)).receivedBytes).toBe(0);
  });

  it('serializes concurrent starts so quota races cannot exceed the global cap', async () => {
    const service = createService(root(), {
      maxConcurrentUploads: 4,
      maxSessionUploads: 4,
    });
    await service.initialize();
    const attempts = await Promise.allSettled(
      Array.from({ length: 20 }, (_, index) => service.startUpload({
        ownerId: 'storm-owner',
        sessionId: `storm-${index}`,
        filename: `${index}.mp4`,
        expectedSize: 12,
      })),
    );
    const accepted = attempts.filter(
      (result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof service.startUpload>>> =>
        result.status === 'fulfilled',
    );
    const rejected = attempts.filter((result) => result.status === 'rejected');
    expect(accepted).toHaveLength(4);
    expect(rejected).toHaveLength(16);
    expect(rejected.every((result) =>
      String((result as PromiseRejectedResult).reason).includes('concurrent'),
    )).toBe(true);
  });

  it('does not let hardlinks or symlink swaps turn a verified blob into another path', async () => {
    const directory = root();
    const service = createService(directory);
    await service.initialize();
    const bytes = mp4Header();
    const digest = createHash('sha256').update(bytes).digest('hex');
    const started = await service.startUpload({
      ownerId: 'asset-owner',
      sessionId: 'asset-session',
      filename: 'asset.mp4',
      expectedSize: bytes.length,
    });
    await append(service, 'asset-owner', started.uploadId, 0, bytes);
    const asset = await service.completeUpload({
      ownerId: 'asset-owner',
      uploadId: started.uploadId,
      expectedDigest: digest,
    });

    const linked = path.join(directory, 'attacker-hardlink');
    linkSync(asset.privatePath, linked);
    await expect(service.resolveAsset(asset.id)).rejects.toThrow(/identity changed|regular file/);
    rmSync(linked);
    await expect(service.resolveAsset(asset.id)).resolves.toMatchObject({ id: asset.id });

    const moved = path.join(directory, 'attacker-target');
    renameSync(asset.privatePath, moved);
    try {
      symlinkSync(moved, asset.privatePath);
    } catch (error) {
      if (process.platform === 'win32' && (error as NodeJS.ErrnoException).code === 'EPERM') {
        renameSync(moved, asset.privatePath);
        return;
      }
      throw error;
    }
    await expect(service.resolveAsset(asset.id)).rejects.toThrow(/direct private regular file/);
  });

  it('returns exactly one terminal outcome when completion races cancellation', async () => {
    const service = createService();
    await service.initialize();
    const bytes = mp4Header();
    const digest = createHash('sha256').update(bytes).digest('hex');
    const started = await service.startUpload({
      ownerId: 'race-owner',
      sessionId: 'race-session',
      filename: 'race.mp4',
      expectedSize: bytes.length,
    });
    await append(service, 'race-owner', started.uploadId, 0, bytes);
    const outcomes = await Promise.allSettled([
      service.completeUpload({
        ownerId: 'race-owner',
        uploadId: started.uploadId,
        expectedDigest: digest,
      }),
      service.cancelUpload('race-owner', started.uploadId),
    ]);
    expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const asset = outcomes.find(
      (result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof service.completeUpload>>> =>
        result.status === 'fulfilled' && 'id' in result.value,
    );
    expect(asset?.value.id).toBe(`sha256:${digest}`);
  });
});
