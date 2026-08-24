import {
  appendFileSync,
  closeSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  MEDIA_ASSET_SCHEMA,
  MEDIA_UPLOAD_CHUNK_BYTES,
  MediaIngestService,
} from './ingest.js';
import { MediaProcessor } from './processor.js';

const roots: string[] = [];

function testRoot(): string {
  const parent = path.join(process.cwd(), '.media-ingest-tests');
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(path.join(parent, 'case-'));
  roots.push(root);
  return root;
}

function service(
  root = testRoot(),
  options: ConstructorParameters<typeof MediaIngestService>[0] = { root },
): MediaIngestService {
  return new MediaIngestService({
    root,
    ffprobePath: path.join(root, 'missing-ffprobe'),
    policy: {
      minimumFreeBytes: 1,
      sessionStagingQuotaBytes: 512 * 1024 * 1024,
      globalStagingQuotaBytes: 1024 * 1024 * 1024,
      ...options.policy,
    },
    now: options.now,
  });
}

function mp4Chunk(length: number, seed = 0): Buffer {
  const chunk = Buffer.alloc(length, seed & 0xff);
  if (seed === 0 && length >= 12) {
    chunk.writeUInt32BE(24, 0);
    chunk.write('ftyp', 4, 'ascii');
    chunk.write('isom', 8, 'ascii');
  }
  return chunk;
}

async function append(
  ingest: MediaIngestService,
  ownerId: string,
  uploadId: string,
  offset: number,
  bytes: Uint8Array,
) {
  return ingest.appendChunk({
    ownerId,
    uploadId,
    offset,
    bytes,
    chunkDigest: createHash('sha256').update(bytes).digest('hex'),
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  rmSync(path.join(process.cwd(), '.media-ingest-tests'), { recursive: true, force: true });
});

describe('secure media ingest', () => {
  it('streams, verifies, atomically finalizes, and deduplicates media', async () => {
    const ingest = service();
    await ingest.initialize();
    const bytes = mp4Chunk(MEDIA_UPLOAD_CHUNK_BYTES);
    const digest = createHash('sha256').update(bytes).digest('hex');

    const first = await ingest.startUpload({
      ownerId: 'owner',
      sessionId: 'session',
      filename: 'C:\\Users\\me\\..\\evil\u0000name.mp4',
      mimeType: 'text/plain',
      expectedSize: bytes.length,
      expectedDigest: digest,
    });
    await append(ingest, 'owner', first.uploadId, 0, bytes);
    const second = await ingest.startUpload({
      ownerId: 'owner',
      sessionId: 'session',
      filename: 'same.mov',
      expectedSize: bytes.length,
    });
    await append(ingest, 'owner', second.uploadId, 0, bytes);
    const [asset, duplicate] = await Promise.all([
      ingest.completeUpload({
        ownerId: 'owner',
        uploadId: first.uploadId,
        expectedDigest: digest,
      }),
      ingest.completeUpload({
        ownerId: 'owner',
        uploadId: second.uploadId,
        expectedDigest: digest,
      }),
    ]);
    expect(asset).toMatchObject({
      schema: MEDIA_ASSET_SCHEMA,
      digest,
      size: bytes.length,
      mimeType: 'video/mp4',
      kind: 'video',
      displayName: 'evilname.mp4',
      verified: true,
    });
    expect([asset.deduplicated, duplicate.deduplicated].sort())
      .toEqual([false, true]);
    expect(readFileSync(asset.privatePath)).toEqual(bytes);
    expect(statSync(asset.privatePath).mode & 0o777).toBe(0o600);
    const processed = await new MediaProcessor().processVerifiedAsset(asset);
    expect(processed).toMatchObject({
      type: 'video',
      size: bytes.length,
      metadata: {
        assetId: asset.id,
        privatePath: asset.privatePath,
        localOnly: true,
      },
    });

    expect(duplicate.privatePath).toBe(asset.privatePath);
  });

  it('resumes after service restart and accepts an exact idempotent retry', async () => {
    const root = testRoot();
    const firstService = service(root);
    await firstService.initialize();
    const firstChunk = mp4Chunk(MEDIA_UPLOAD_CHUNK_BYTES);
    const lastChunk = Buffer.from('tail');
    const digest = createHash('sha256').update(firstChunk).update(lastChunk).digest('hex');
    const started = await firstService.startUpload({
      ownerId: 'stable-owner',
      sessionId: 'resume-session',
      filename: 'resume.mp4',
      expectedSize: firstChunk.length + lastChunk.length,
    });

    await append(firstService, 'stable-owner', started.uploadId, 0, firstChunk);

    const restarted = service(root);
    await restarted.initialize();
    expect(await restarted.status('stable-owner', started.uploadId)).toMatchObject({
      receivedBytes: firstChunk.length,
      phase: 'uploading',
      resumable: true,
    });
    const replay = await append(restarted, 'stable-owner', started.uploadId, 0, firstChunk);
    expect(replay.receivedBytes).toBe(firstChunk.length);
    await append(
      restarted,
      'stable-owner',
      started.uploadId,
      firstChunk.length,
      lastChunk,
    );
    const asset = await restarted.completeUpload({
      ownerId: 'stable-owner',
      uploadId: started.uploadId,
      expectedDigest: digest,
    });
    expect(createHash('sha256').update(readFileSync(asset.privatePath)).digest('hex'))
      .toBe(digest);
  });

  it('streams a local file through upload, hashing, validation, and completion phases', async () => {
    const root = testRoot();
    const ingest = service(path.join(root, 'media'));
    await ingest.initialize();
    const source = path.join(root, 'local.mp4');
    const bytes = mp4Chunk(MEDIA_UPLOAD_CHUNK_BYTES * 2);
    writeFileSync(source, bytes);
    const phases: string[] = [];
    const asset = await ingest.ingestLocalFile({
      sourcePath: source,
      sessionId: 'local-session',
      filename: 'local.mp4',
      expectedSize: bytes.length,
      onProgress: (progress) => phases.push(progress.phase),
    });
    expect(readFileSync(asset.privatePath)).toEqual(bytes);
    expect(phases).toContain('uploading');
    expect(phases).toContain('hashing');
    expect(phases).toContain('validating');
    expect(phases.at(-1)).toBe('complete');
  });

  it('resumes Electron local ingest only after revalidating the reselected prefix', async () => {
    const root = testRoot();
    const mediaRoot = path.join(root, 'media');
    const source = path.join(root, 'resume-local.mp4');
    const first = mp4Chunk(MEDIA_UPLOAD_CHUNK_BYTES);
    const tail = Buffer.alloc(17, 9);
    writeFileSync(source, Buffer.concat([first, tail]));
    const before = service(mediaRoot);
    await before.initialize();
    const started = await before.startUpload({
      ownerId: 'electron-main',
      sessionId: 'electron-session',
      filename: 'resume-local.mp4',
      expectedSize: first.length + tail.length,
    });
    await append(before, 'electron-main', started.uploadId, 0, first);

    const restarted = service(mediaRoot);
    await restarted.initialize();
    const asset = await restarted.ingestLocalFile({
      sourcePath: source,
      sessionId: 'electron-session',
      filename: 'resume-local.mp4',
      expectedSize: first.length + tail.length,
      resumeUploadId: started.uploadId,
    });
    expect(readFileSync(asset.privatePath)).toEqual(Buffer.concat([first, tail]));
  });

  it('rejects gaps, overlaps, altered replays, digest mismatch, and incomplete size', async () => {
    const ingest = service();
    await ingest.initialize();
    const first = mp4Chunk(MEDIA_UPLOAD_CHUNK_BYTES);
    const tail = Buffer.from('tail');
    const started = await ingest.startUpload({
      ownerId: 'owner',
      sessionId: 'session',
      filename: 'ordered.mp4',
      expectedSize: first.length + tail.length,
    });
    await expect(append(ingest, 'owner', started.uploadId, 1, first))
      .rejects.toThrow(/Out-of-order/);
    await append(ingest, 'owner', started.uploadId, 0, first);
    await expect(append(ingest, 'owner', started.uploadId, 0, Buffer.alloc(first.length, 2)))
      .rejects.toThrow(/overlaps/);
    await expect(ingest.completeUpload({
      ownerId: 'owner',
      uploadId: started.uploadId,
      expectedDigest: '0'.repeat(64),
    })).rejects.toThrow(/incomplete/);
    await append(ingest, 'owner', started.uploadId, first.length, tail);
    await expect(ingest.completeUpload({
      ownerId: 'owner',
      uploadId: started.uploadId,
      expectedDigest: '0'.repeat(64),
    })).rejects.toThrow(/digest mismatch/);
    await expect(ingest.status('owner', started.uploadId)).rejects.toThrow();
  });

  it('rejects unknown containers before exposing a verified asset', async () => {
    const ingest = service();
    await ingest.initialize();
    const bytes = Buffer.alloc(512, 7);
    const started = await ingest.startUpload({
      ownerId: 'owner',
      sessionId: 'session',
      filename: 'pretend.mp4',
      mimeType: 'video/mp4',
      expectedSize: bytes.length,
    });

    await append(ingest, 'owner', started.uploadId, 0, bytes);
    await expect(ingest.completeUpload({
      ownerId: 'owner',
      uploadId: started.uploadId,
      expectedDigest: createHash('sha256').update(bytes).digest('hex'),
    })).rejects.toThrow(/Unsupported media container/);
  });

  it.each([
    ['QuickTime', Buffer.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x71, 0x74, 0x20, 0x20]), 'video', 'video/quicktime'],
    ['WAV', Buffer.from('RIFF0000WAVEfmt '), 'audio', 'audio/wav'],
    ['FLAC', Buffer.from('fLaC00000000'), 'audio', 'audio/flac'],
    ['Ogg', Buffer.from('OggS00000000'), 'audio', 'audio/ogg'],
    ['MP3', Buffer.from('ID300000000'), 'audio', 'audio/mpeg'],
    ['MIDI', Buffer.from('MThd00000000'), 'midi', 'audio/midi'],
    ['WebM', Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0, 0, 0, 0, 0]), 'video', 'video/webm'],
  ])('detects %s from container magic rather than the extension', async (
    _label,
    bytes,
    kind,
    mimeType,
  ) => {
    const ingest = service();
    await ingest.initialize();
    const started = await ingest.startUpload({
      ownerId: 'owner',
      sessionId: 'magic',
      filename: 'misleading.bin',
      mimeType: mimeType === 'video/webm' ? 'video/webm' : 'application/octet-stream',
      expectedSize: bytes.length,
    });
    await append(ingest, 'owner', started.uploadId, 0, bytes);
    const asset = await ingest.completeUpload({
      ownerId: 'owner',
      uploadId: started.uploadId,
      expectedDigest: createHash('sha256').update(bytes).digest('hex'),
    });
    expect(asset).toMatchObject({ kind, mimeType });
  });

  it('rejects symlinks, hardlinks, sparse files, and files that change during read', async () => {
    const ingest = service();
    await ingest.initialize();
    const root = testRoot();
    const original = path.join(root, 'original.mp4');
    writeFileSync(original, mp4Chunk(MEDIA_UPLOAD_CHUNK_BYTES * 2));
    await expect(ingest.ingestLocalFile({
      sourcePath: root,
      sessionId: 'local',
      filename: 'directory.mp4',
      expectedSize: 1,
    })).rejects.toThrow(/regular file/);
    if (process.platform !== 'win32') {
      await expect(ingest.ingestLocalFile({
        sourcePath: '/dev/null',
        sessionId: 'local',
        filename: 'device.mp4',
        expectedSize: 1,
      })).rejects.toThrow(/regular file/);
    }
    const symbolic = path.join(root, 'symbolic.mp4');
    try {
      symlinkSync(original, symbolic);
      await expect(ingest.ingestLocalFile({
        sourcePath: symbolic,
        sessionId: 'local',
        filename: 'symbolic.mp4',
        expectedSize: statSync(original).size,
      })).rejects.toThrow();
    } catch (error) {
      if (!(process.platform === 'win32' && (error as NodeJS.ErrnoException).code === 'EPERM')) {
        throw error;
      }
    }

    const hard = path.join(root, 'hard.mp4');
    linkSync(original, hard);
    await expect(ingest.ingestLocalFile({
      sourcePath: hard,
      sessionId: 'local',
      filename: 'hard.mp4',
      expectedSize: statSync(hard).size,
    })).rejects.toThrow(/Hard-linked/);
    rmSync(hard);

    const sparse = path.join(root, 'sparse.mp4');
    const sparseFd = openSync(sparse, 'w');
    writeSync(sparseFd, mp4Chunk(12), 0, 12, 0);
    writeSync(sparseFd, Buffer.from([1]), 0, 1, 2 * 1024 * 1024);
    closeSync(sparseFd);
    if ((statSync(sparse).blocks ?? 0) * 512 < statSync(sparse).size) {
      await expect(ingest.ingestLocalFile({
        sourcePath: sparse,
        sessionId: 'local',
        filename: 'sparse.mp4',
        expectedSize: statSync(sparse).size,
      })).rejects.toThrow(/Sparse/);
    }

    const changing = path.join(root, 'changing.mp4');
    writeFileSync(changing, mp4Chunk(MEDIA_UPLOAD_CHUNK_BYTES * 2));
    let changed = false;
    await expect(ingest.ingestLocalFile({
      sourcePath: changing,
      sessionId: 'local',
      filename: 'changing.mp4',
      expectedSize: statSync(changing).size,
      onProgress: (status) => {
        if (!changed && status.receivedBytes > 0) {
          changed = true;
          appendFileSync(changing, Buffer.from('growth'));
        }
      },
    })).rejects.toThrow(/changed/);

    const shrinking = path.join(root, 'shrinking.mp4');
    writeFileSync(shrinking, mp4Chunk(MEDIA_UPLOAD_CHUNK_BYTES * 2));
    let shrank = false;
    await expect(ingest.ingestLocalFile({
      sourcePath: shrinking,
      sessionId: 'local',
      filename: 'shrinking.mp4',
      expectedSize: statSync(shrinking).size,
      onProgress: (status) => {
        if (!shrank && status.receivedBytes > 0) {
          shrank = true;
          truncateSync(shrinking, MEDIA_UPLOAD_CHUNK_BYTES);
        }
      },
    })).rejects.toThrow(/shrank|changed/);
  });

  it('rejects staging hardlinks and symlink path swaps', async () => {
    const root = testRoot();
    const ingest = service(root);
    await ingest.initialize();
    const linked = await ingest.startUpload({
      ownerId: 'owner',
      sessionId: 'staging',
      filename: 'linked.mp4',
      expectedSize: 12,
    });
    const linkedPart = path.join(root, 'staging', linked.uploadId, 'payload.part');
    const secondLink = path.join(root, 'linked-part');
    linkSync(linkedPart, secondLink);
    await expect(append(
      ingest,
      'owner',
      linked.uploadId,
      0,
      Buffer.from([0, 0, 0, 12, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]),
    )).rejects.toThrow(/identity changed/);
    rmSync(secondLink);
    await ingest.cancelUpload('owner', linked.uploadId);

    const swapped = await ingest.startUpload({
      ownerId: 'owner',
      sessionId: 'staging',
      filename: 'swapped.mp4',
      expectedSize: 12,
    });
    const swappedPart = path.join(root, 'staging', swapped.uploadId, 'payload.part');
    const target = path.join(root, 'attacker-target');
    writeFileSync(target, Buffer.alloc(12));
    rmSync(swappedPart);
    try {
      symlinkSync(target, swappedPart);
    } catch (error) {
      if (process.platform === 'win32' && (error as NodeJS.ErrnoException).code === 'EPERM') {
        return;
      }
      throw error;
    }
    await expect(append(
      ingest,
      'owner',
      swapped.uploadId,
      0,
      Buffer.from([0, 0, 0, 12, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]),
    )).rejects.toThrow();
    expect(readFileSync(target)).toEqual(Buffer.alloc(12));
  });

  it('enforces declared-size, per-session, global concurrency, and free-disk bounds', async () => {
    const root = testRoot();
    const ingest = service(root, {
      root,
      policy: {
        maxFileBytes: 1024,
        maxConcurrentUploads: 1,
        maxSessionUploads: 1,
        sessionStagingQuotaBytes: 1024,
        globalStagingQuotaBytes: 1024,
      },
    });
    await ingest.initialize();
    await expect(ingest.startUpload({
      ownerId: 'owner',
      sessionId: 'session',
      filename: 'huge.mp4',
      expectedSize: Number.MAX_SAFE_INTEGER,
    })).rejects.toThrow(/between 1/);
    await ingest.startUpload({
      ownerId: 'owner',
      sessionId: 'session',
      filename: 'one.mp4',
      expectedSize: 512,
    });
    await expect(ingest.startUpload({
      ownerId: 'owner',
      sessionId: 'other',
      filename: 'storm.mp4',
      expectedSize: 1,
    })).rejects.toThrow(/concurrent/);

    const diskBound = service(testRoot(), {
      root: testRoot(),
      policy: { minimumFreeBytes: Number.MAX_SAFE_INTEGER },
    });
    await diskBound.initialize();
    await expect(diskBound.startUpload({
      ownerId: 'owner',
      sessionId: 'session',
      filename: 'disk.mp4',
      expectedSize: 1,
    })).rejects.toThrow(/free disk/);
  });

  it('cancels and expires partial staging without deleting completed blobs', async () => {
    let now = Date.now();
    const root = testRoot();
    const ingest = service(root, {
      root,
      now: () => now,
      policy: { uploadTtlMs: 100 },
    });
    await ingest.initialize();
    const cancelled = await ingest.startUpload({
      ownerId: 'owner',
      sessionId: 'session',
      filename: 'cancel.mp4',
      expectedSize: 12,
    });
    await ingest.cancelUpload('owner', cancelled.uploadId);
    await expect(ingest.status('owner', cancelled.uploadId)).rejects.toThrow();

    const expired = await ingest.startUpload({
      ownerId: 'owner',
      sessionId: 'session',
      filename: 'expire.mp4',
      expectedSize: 12,
    });
    now += 101;
    expect(await ingest.cleanupExpired()).toBe(1);
    await expect(ingest.status('owner', expired.uploadId)).rejects.toThrow();

    const racing = await ingest.startUpload({
      ownerId: 'owner',
      sessionId: 'session',
      filename: 'race.mp4',
      expectedSize: 12,
    });
    now += 101;
    const bytes = Buffer.from([0, 0, 0, 12, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
    const committing = append(ingest, 'owner', racing.uploadId, 0, bytes);
    const cleaning = ingest.cleanupExpired();
    await expect(committing).resolves.toMatchObject({ receivedBytes: 12 });
    await cleaning;
    await expect(ingest.status('owner', racing.uploadId)).resolves.toMatchObject({
      receivedBytes: 12,
    });
    const digest = createHash('sha256').update(bytes).digest('hex');
    const asset = await ingest.completeUpload({
      ownerId: 'owner',
      uploadId: racing.uploadId,
      expectedDigest: digest,
    });
    now += 101;
    expect(await ingest.cleanupExpired()).toBe(1);
    await expect(ingest.status('owner', racing.uploadId)).rejects.toThrow();
    await expect(ingest.resolveAsset(asset.id)).resolves.toMatchObject({
      id: asset.id,
      digest,
    });
  });

  it.runIf(process.env.OPENRAPPTER_LARGE_MEDIA_TEST === '1')(
    'ingests an exact >100 MB streamed fixture without a 100 MB allocation',
    async () => {
      const root = testRoot();
      const ingest = service(root, {
        root,
        policy: {
          maxFileBytes: 256 * 1024 * 1024,
          sessionStagingQuotaBytes: 256 * 1024 * 1024,
          globalStagingQuotaBytes: 512 * 1024 * 1024,
        },
      });
      await ingest.initialize();
      const totalSize = 100 * 1024 * 1024 + 1;
      const started = await ingest.startUpload({
        ownerId: 'large-owner',
        sessionId: 'large-session',
        filename: 'RappFactory_Showcase_v5rough edit_backup.mp4',
        mimeType: 'video/mp4',
        expectedSize: totalSize,
      });
      const hash = createHash('sha256');
      let offset = 0;
      let index = 0;
      while (offset < totalSize) {
        const length = Math.min(MEDIA_UPLOAD_CHUNK_BYTES, totalSize - offset);
        const bytes = mp4Chunk(length, index);
        hash.update(bytes);
        const status = await append(
          ingest,
          'large-owner',
          started.uploadId,
          offset,
          bytes,
        );
        offset += length;
        index += 1;
        expect(status.receivedBytes).toBe(offset);
      }
      const digest = hash.digest('hex');
      const asset = await ingest.completeUpload({
        ownerId: 'large-owner',
        uploadId: started.uploadId,
        expectedDigest: digest,
      });
      expect(statSync(asset.privatePath).size).toBe(totalSize);
      expect(asset.digest).toBe(digest);
      expect(lstatSync(asset.privatePath).isFile()).toBe(true);
    },
    120_000,
  );
});
