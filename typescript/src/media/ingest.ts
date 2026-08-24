import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import {
  chmod,
  link,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  statfs,
  unlink,
} from 'node:fs/promises';
import { createHash, randomUUID, type Hash } from 'node:crypto';
import path from 'node:path';

export const MEDIA_ASSET_SCHEMA = 'openrappter-media-asset/1.0' as const;
export const MEDIA_UPLOAD_SCHEMA = 'openrappter-media-upload/1.0' as const;
export const MEDIA_DIRECT_UPLOAD_BYTES = 1024 * 1024;
export const MEDIA_UPLOAD_CHUNK_BYTES = 256 * 1024;
export const MEDIA_HARD_MAX_BYTES = 8 * 1024 * 1024 * 1024;

export type MediaAssetKind = 'image' | 'audio' | 'video' | 'midi';
export type MediaUploadPhase =
  | 'uploading'
  | 'hashing'
  | 'validating'
  | 'complete'
  | 'cancelled'
  | 'expired'
  | 'error';

export interface MediaAssetDescriptor {
  schema: typeof MEDIA_ASSET_SCHEMA;
  id: string;
  digest: string;
  size: number;
  mimeType: string;
  kind: MediaAssetKind;
  displayName: string;
  storage: 'local-private';
  verified: true;
  deduplicated: boolean;
  createdAt: string;
  probe?: MediaProbeMetadata;
}

export interface VerifiedMediaAsset extends MediaAssetDescriptor {
  /** Main-process/server-only path. Never accept this value back from a renderer. */
  privatePath: string;
}

export interface MediaProbeMetadata {
  format?: string;
  durationSeconds?: number;
  width?: number;
  height?: number;
  audioStreams?: number;
  videoStreams?: number;
  probe: 'magic' | 'magic+ffprobe';
}

export interface MediaIngestPolicy {
  directThresholdBytes: number;
  chunkBytes: number;
  maxFileBytes: number;
  sessionStagingQuotaBytes: number;
  globalStagingQuotaBytes: number;
  minimumFreeBytes: number;
  uploadTtlMs: number;
  maxConcurrentUploads: number;
  maxSessionUploads: number;
  ffprobeTimeoutMs: number;
  maxProbeOutputBytes: number;
  maxDurationSeconds: number;
  maxWidth: number;
  maxHeight: number;
  maxStreams: number;
}

export interface MediaUploadStatus {
  schema: typeof MEDIA_UPLOAD_SCHEMA;
  uploadId: string;
  sessionId: string;
  displayName: string;
  mimeType: string;
  expectedSize: number;
  expectedDigest?: string;
  receivedBytes: number;
  chunkBytes: number;
  phase: MediaUploadPhase;
  resumable: boolean;
  localOnly: true;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  asset?: MediaAssetDescriptor;
  error?: string;
}

interface ChunkRecord {
  offset: number;
  length: number;
  digest: string;
}

interface UploadManifest extends MediaUploadStatus {
  ownerId: string;
  partIdentity?: {
    dev: string;
    ino: string;
  };
  recentChunks: ChunkRecord[];
}

interface DetectedMedia {
  kind: MediaAssetKind;
  mimeType: string;
  format: string;
}

export interface StartMediaUpload {
  ownerId: string;
  sessionId: string;
  filename: string;
  mimeType?: string;
  expectedSize: number;
  expectedDigest?: string;
  uploadId?: string;
}

export interface AppendMediaChunk {
  ownerId: string;
  uploadId: string;
  offset: number;
  bytes: Uint8Array;
  chunkDigest: string;
}

export interface CompleteMediaUpload {
  ownerId: string;
  uploadId: string;
  expectedDigest?: string;
  onProgress?: (status: MediaUploadStatus) => void;
}

export interface LocalMediaIngest {
  sourcePath: string;
  sessionId: string;
  filename: string;
  mimeType?: string;
  expectedSize: number;
  expectedDigest?: string;
  uploadId?: string;
  resumeUploadId?: string;
  signal?: AbortSignal;
  onProgress?: (status: MediaUploadStatus) => void;
}

export interface MediaIngestServiceOptions {
  root: string;
  policy?: Partial<MediaIngestPolicy>;
  now?: () => number;
  ffprobePath?: string;
}

function envBytes(name: string, fallback: number, hardMax = Number.MAX_SAFE_INTEGER): number {
  const value = Number(process.env[name]);
  if (!Number.isSafeInteger(value) || value <= 0) return fallback;
  return Math.min(value, hardMax);
}

export function mediaIngestPolicy(
  overrides: Partial<MediaIngestPolicy> = {},
): MediaIngestPolicy {
  const defaults: MediaIngestPolicy = {
    directThresholdBytes: MEDIA_DIRECT_UPLOAD_BYTES,
    chunkBytes: MEDIA_UPLOAD_CHUNK_BYTES,
    maxFileBytes: envBytes(
      'OPENRAPPTER_MEDIA_MAX_BYTES',
      4 * 1024 * 1024 * 1024,
      MEDIA_HARD_MAX_BYTES,
    ),
    sessionStagingQuotaBytes: envBytes(
      'OPENRAPPTER_MEDIA_SESSION_STAGING_BYTES',
      8 * 1024 * 1024 * 1024,
      MEDIA_HARD_MAX_BYTES * 2,
    ),
    globalStagingQuotaBytes: envBytes(
      'OPENRAPPTER_MEDIA_GLOBAL_STAGING_BYTES',
      16 * 1024 * 1024 * 1024,
      MEDIA_HARD_MAX_BYTES * 8,
    ),
    minimumFreeBytes: envBytes(
      'OPENRAPPTER_MEDIA_MINIMUM_FREE_BYTES',
      1024 * 1024 * 1024,
    ),
    uploadTtlMs: 24 * 60 * 60 * 1000,
    maxConcurrentUploads: 8,
    maxSessionUploads: 3,
    ffprobeTimeoutMs: 15_000,
    maxProbeOutputBytes: 256 * 1024,
    maxDurationSeconds: 12 * 60 * 60,
    maxWidth: 7680,
    maxHeight: 4320,
    maxStreams: 32,
  };
  const policy = { ...defaults, ...overrides };
  policy.directThresholdBytes = Math.max(
    64 * 1024,
    Math.min(policy.directThresholdBytes, MEDIA_DIRECT_UPLOAD_BYTES),
  );
  policy.chunkBytes = Math.max(
    64 * 1024,
    Math.min(policy.chunkBytes, MEDIA_UPLOAD_CHUNK_BYTES),
  );
  policy.maxFileBytes = Math.min(policy.maxFileBytes, MEDIA_HARD_MAX_BYTES);
  return policy;
}

function assertDigest(value: string | undefined, label: string): string | undefined {
  if (value === undefined || value === '') return undefined;
  const digest = value.toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(digest)) {
    throw new Error(`${label} must be a lowercase or uppercase SHA-256 hex digest.`);
  }
  return digest;
}

function displayFilename(value: string): string {
  const leaf = value.replaceAll('\\', '/').split('/').pop() ?? '';
  const cleaned = leaf
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, 240);
  return cleaned || 'media';
}

function assertUploadId(value: string): void {
  if (!/^[a-f0-9-]{36}$/.test(value)) throw new Error('Invalid media upload ID.');
}

function noFollowFlag(): number {
  return typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
}

function identityOf(stats: { dev: number | bigint; ino: number | bigint }): {
  dev: string;
  ino: string;
} {
  return { dev: String(stats.dev), ino: String(stats.ino) };
}

function sameIdentity(
  expected: { dev: string; ino: string },
  actual: { dev: number | bigint; ino: number | bigint },
): boolean {
  return expected.dev === String(actual.dev) && expected.ino === String(actual.ino);
}

function isSparse(stats: { size: number; blocks?: number }): boolean {
  if (!stats.size || !Number.isFinite(stats.blocks)) return false;
  return (stats.blocks ?? 0) * 512 < stats.size;
}

function statusFromManifest(manifest: UploadManifest): MediaUploadStatus {
  const {
    ownerId: _ownerId,
    partIdentity: _partIdentity,
    recentChunks: _recentChunks,
    ...status
  } = manifest;
  return status;
}

function detectMedia(header: Buffer, declaredMime?: string): DetectedMedia {
  if (
    header.length >= 12
    && header.subarray(0, 4).equals(Buffer.from([0x00, 0x00, 0x00, 0x18]))
    && header.subarray(4, 8).toString('ascii') === 'ftyp'
  ) {
    // A 24-byte ftyp atom is common but not mandatory, so fall through to the
    // generic ISO-BMFF check when the atom length differs.
  }
  if (header.length >= 12 && header.subarray(4, 8).toString('ascii') === 'ftyp') {
    const brand = header.subarray(8, 12).toString('ascii');
    const audio = /^M4A|^M4B|^F4A/.test(brand) || declaredMime?.startsWith('audio/');
    return audio
      ? { kind: 'audio', mimeType: 'audio/mp4', format: 'iso-bmff-audio' }
      : {
          kind: 'video',
          mimeType: brand === 'qt  ' ? 'video/quicktime' : 'video/mp4',
          format: brand === 'qt  ' ? 'quicktime' : 'iso-bmff',
        };
  }
  if (header.length >= 12 && header.subarray(0, 4).toString('ascii') === 'RIFF') {
    const form = header.subarray(8, 12).toString('ascii');
    if (form === 'WAVE') return { kind: 'audio', mimeType: 'audio/wav', format: 'wav' };
    if (form === 'WEBP') return { kind: 'image', mimeType: 'image/webp', format: 'webp' };
  }
  if (header.subarray(0, 4).toString('ascii') === 'fLaC') {
    return { kind: 'audio', mimeType: 'audio/flac', format: 'flac' };
  }
  if (header.subarray(0, 4).toString('ascii') === 'OggS') {
    return { kind: 'audio', mimeType: 'audio/ogg', format: 'ogg' };
  }
  if (header.subarray(0, 4).toString('ascii') === 'MThd') {
    return { kind: 'midi', mimeType: 'audio/midi', format: 'midi' };
  }
  if (header.subarray(0, 4).toString('ascii') === 'caff') {
    return { kind: 'audio', mimeType: 'audio/x-caf', format: 'caf' };
  }
  if (
    header.subarray(0, 3).toString('ascii') === 'ID3'
    || (header.length >= 2 && header[0] === 0xff && (header[1] & 0xe0) === 0xe0)
  ) {
    return { kind: 'audio', mimeType: 'audio/mpeg', format: 'mpeg-audio' };
  }
  if (
    header.length >= 4
    && header[0] === 0x1a
    && header[1] === 0x45
    && header[2] === 0xdf
    && header[3] === 0xa3
  ) {
    return declaredMime?.startsWith('audio/')
      ? { kind: 'audio', mimeType: 'audio/webm', format: 'matroska/webm' }
      : { kind: 'video', mimeType: 'video/webm', format: 'matroska/webm' };
  }
  if (
    header.length >= 8
    && header.subarray(0, 8).equals(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    )
  ) {
    return { kind: 'image', mimeType: 'image/png', format: 'png' };
  }
  if (header.length >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) {
    return { kind: 'image', mimeType: 'image/jpeg', format: 'jpeg' };
  }
  if (header.subarray(0, 4).toString('ascii').startsWith('GIF8')) {
    return { kind: 'image', mimeType: 'image/gif', format: 'gif' };
  }
  throw new Error(
    'Unsupported media container. OpenRappter accepts verified MP4/QuickTime/WebM, common audio, MIDI, PNG, JPEG, GIF, and WebP media.',
  );
}

async function fsyncDirectory(directory: string): Promise<void> {
  if (process.platform === 'win32') return;
  const handle = await open(directory, fsConstants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export class MediaIngestService {
  readonly policy: MediaIngestPolicy;
  readonly root: string;
  private readonly stagingRoot: string;
  private readonly blobRoot: string;
  private readonly now: () => number;
  private readonly ffprobePath: string;
  private initialized = false;
  private readonly uploadLocks = new Map<string, Promise<void>>();
  private readonly activeHashes = new Map<string, { hash: Hash; offset: number }>();

  constructor(options: MediaIngestServiceOptions) {
    this.root = path.resolve(options.root);
    this.stagingRoot = path.join(this.root, 'staging');
    this.blobRoot = path.join(this.root, 'blobs', 'sha256');
    this.policy = mediaIngestPolicy(options.policy);
    this.now = options.now ?? Date.now;
    this.ffprobePath = options.ffprobePath ?? process.env.OPENRAPPTER_FFPROBE_PATH ?? 'ffprobe';
  }

  async initialize(): Promise<void> {
    await mkdir(this.stagingRoot, { recursive: true, mode: 0o700 });
    await mkdir(this.blobRoot, { recursive: true, mode: 0o700 });
    await chmod(this.root, 0o700).catch(() => {});
    await chmod(this.stagingRoot, 0o700).catch(() => {});
    await chmod(this.blobRoot, 0o700).catch(() => {});
    this.initialized = true;
    await this.recoverPartials();
    await this.cleanupExpired();
  }

  async startUpload(input: StartMediaUpload): Promise<MediaUploadStatus> {
    return this.withUploadLock('__capacity__', () => this.startUploadUnlocked(input));
  }

  private async startUploadUnlocked(input: StartMediaUpload): Promise<MediaUploadStatus> {
    await this.ensureInitialized();
    this.assertStart(input);
    await this.assertCapacity(input.sessionId, input.expectedSize);

    const uploadId = input.uploadId ?? randomUUID();
    assertUploadId(uploadId);
    const directory = this.uploadDirectory(uploadId);
    await mkdir(directory, { mode: 0o700 });
    let handle;
    try {
      handle = await open(
        this.partPath(uploadId),
        fsConstants.O_CREAT
          | fsConstants.O_EXCL
          | fsConstants.O_WRONLY
          | noFollowFlag(),
        0o600,
      );
      const partStats = await handle.stat();
      if (!partStats.isFile() || partStats.nlink !== 1) {
        throw new Error('Private media staging path is not a single regular file.');
      }
      await handle.sync();
      const createdAt = new Date(this.now()).toISOString();
      const manifest: UploadManifest = {
        schema: MEDIA_UPLOAD_SCHEMA,
        uploadId,
        ownerId: input.ownerId,
        sessionId: input.sessionId,
        displayName: displayFilename(input.filename),
        mimeType: input.mimeType || 'application/octet-stream',
        expectedSize: input.expectedSize,
        expectedDigest: assertDigest(input.expectedDigest, 'Expected digest'),
        receivedBytes: 0,
        chunkBytes: this.policy.chunkBytes,
        phase: 'uploading',
        resumable: true,
        localOnly: true,
        createdAt,
        updatedAt: createdAt,
        expiresAt: new Date(this.now() + this.policy.uploadTtlMs).toISOString(),
        partIdentity: identityOf(partStats),
        recentChunks: [],
      };
      await this.writeManifest(manifest);
      this.activeHashes.set(uploadId, {
        hash: createHash('sha256'),
        offset: 0,
      });
      await fsyncDirectory(directory);
      return statusFromManifest(manifest);
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    } finally {
      await handle?.close();
    }
  }

  async appendChunk(input: AppendMediaChunk): Promise<MediaUploadStatus> {
    return this.withUploadLock(input.uploadId, () => this.appendChunkUnlocked(input));
  }

  private async appendChunkUnlocked(input: AppendMediaChunk): Promise<MediaUploadStatus> {
    await this.ensureInitialized();
    const manifest = await this.readOwnedManifest(input.ownerId, input.uploadId);
    if (manifest.phase !== 'uploading') {
      throw new Error(`Upload ${input.uploadId} is ${manifest.phase}, not writable.`);
    }
    if (!Number.isSafeInteger(input.offset) || input.offset < 0) {
      throw new Error('Chunk offset must be a non-negative safe integer.');
    }
    const bytes = Buffer.from(input.bytes);
    if (bytes.length === 0 || bytes.length > this.policy.chunkBytes) {
      throw new Error(`Chunk must contain 1-${this.policy.chunkBytes} bytes.`);
    }
    if (
      input.offset + bytes.length > manifest.expectedSize
      || (
        input.offset + bytes.length < manifest.expectedSize
        && bytes.length !== this.policy.chunkBytes
      )
    ) {
      throw new Error('Chunk length does not align with the declared media size.');
    }
    const chunkDigest = assertDigest(input.chunkDigest, 'Chunk digest')!;
    const actualChunkDigest = createHash('sha256').update(bytes).digest('hex');
    if (chunkDigest !== actualChunkDigest) throw new Error('Chunk digest mismatch.');

    if (input.offset < manifest.receivedBytes) {
      const replay = manifest.recentChunks.find((chunk) => chunk.offset === input.offset);
      if (
        replay
        && replay.length === bytes.length
        && replay.digest === actualChunkDigest
      ) {
        return statusFromManifest(manifest);
      }
      throw new Error('Chunk overlaps bytes already committed to this upload.');
    }
    if (input.offset > manifest.receivedBytes) {
      throw new Error(
        `Out-of-order chunk: expected offset ${manifest.receivedBytes}, received ${input.offset}.`,
      );
    }

    const hashState = await this.ensureHashState(manifest);
    await this.assertFreeDisk(bytes.length);
    const handle = await this.openVerifiedPart(manifest, fsConstants.O_WRONLY);
    try {
      const result = await handle.write(bytes, 0, bytes.length, input.offset);
      if (result.bytesWritten !== bytes.length) throw new Error('Short media staging write.');
      await handle.sync();
      const after = await handle.stat();
      if (after.size !== input.offset + bytes.length) {
        throw new Error('Staged media size changed during chunk commit.');
      }
    } finally {
      await handle.close();
    }

    manifest.receivedBytes += bytes.length;
    hashState.hash.update(bytes);
    hashState.offset += bytes.length;
    manifest.updatedAt = new Date(this.now()).toISOString();
    manifest.expiresAt = new Date(this.now() + this.policy.uploadTtlMs).toISOString();
    manifest.recentChunks = [
      ...manifest.recentChunks,
      { offset: input.offset, length: bytes.length, digest: actualChunkDigest },
    ].slice(-64);
    try {
      await this.writeManifest(manifest);
    } catch (error) {
      // The bytes are durable but not committed until the durable manifest is.
      // Roll the part back so an immediate retry is as safe as restart recovery.
      const rollback = await this.openVerifiedPart(manifest, fsConstants.O_RDWR);
      try {
        await rollback.truncate(input.offset);
        await rollback.sync();
      } finally {
        await rollback.close();
      }
      this.activeHashes.delete(input.uploadId);
      throw error;
    }
    return statusFromManifest(manifest);
  }

  async status(ownerId: string, uploadId: string): Promise<MediaUploadStatus> {
    await this.ensureInitialized();
    return statusFromManifest(await this.readOwnedManifest(ownerId, uploadId));
  }

  async completeUpload(input: CompleteMediaUpload): Promise<VerifiedMediaAsset> {
    return this.withUploadLock(input.uploadId, () => this.completeUploadUnlocked(input));
  }

  private async completeUploadUnlocked(
    input: CompleteMediaUpload,
  ): Promise<VerifiedMediaAsset> {
    await this.ensureInitialized();
    const manifest = await this.readOwnedManifest(input.ownerId, input.uploadId);
    if (manifest.phase === 'complete' && manifest.asset) {
      return this.resolveAsset(manifest.asset.id);
    }
    if (manifest.phase !== 'uploading') {
      throw new Error(`Upload ${input.uploadId} cannot complete from ${manifest.phase}.`);
    }
    if (manifest.receivedBytes !== manifest.expectedSize) {
      throw new Error(
        `Upload is incomplete: ${manifest.receivedBytes}/${manifest.expectedSize} bytes.`,
      );
    }
    const finalExpected = assertDigest(
      input.expectedDigest ?? manifest.expectedDigest,
      'Expected digest',
    );
    if (!finalExpected) throw new Error('A final expected SHA-256 digest is required.');
    manifest.expectedDigest = finalExpected;

    manifest.phase = 'hashing';
    manifest.updatedAt = new Date(this.now()).toISOString();
    await this.writeManifest(manifest);
    input.onProgress?.(statusFromManifest(manifest));
    try {
      const hashState = await this.ensureHashState(manifest);
      const actualDigest = hashState.hash.digest('hex');
      this.activeHashes.delete(input.uploadId);
      if (actualDigest !== finalExpected) throw new Error('Final media digest mismatch.');

      manifest.phase = 'validating';
      manifest.updatedAt = new Date(this.now()).toISOString();
      await this.writeManifest(manifest);
      input.onProgress?.(statusFromManifest(manifest));
      const validation = await this.validateMedia(
        this.partPath(input.uploadId),
        manifest.mimeType,
      );
      const finalized = await this.finalizeBlob(
        this.partPath(input.uploadId),
        actualDigest,
        manifest.expectedSize,
      );
      const descriptor: MediaAssetDescriptor = {
        schema: MEDIA_ASSET_SCHEMA,
        id: `sha256:${actualDigest}`,
        digest: actualDigest,
        size: manifest.expectedSize,
        mimeType: validation.media.mimeType,
        kind: validation.media.kind,
        displayName: manifest.displayName,
        storage: 'local-private',
        verified: true,
        deduplicated: finalized.deduplicated,
        createdAt: new Date(this.now()).toISOString(),
        probe: validation.probe,
      };
      manifest.phase = 'complete';
      manifest.asset = descriptor;
      manifest.resumable = false;
      manifest.updatedAt = new Date(this.now()).toISOString();
      await this.writeManifest(manifest);
      return { ...descriptor, privatePath: finalized.path };
    } catch (error) {
      manifest.phase = 'error';
      manifest.resumable = false;
      manifest.error = error instanceof Error ? error.message : String(error);
      manifest.updatedAt = new Date(this.now()).toISOString();
      await this.writeManifest(manifest).catch(() => {});
      await rm(this.uploadDirectory(input.uploadId), { recursive: true, force: true });
      throw error;
    }
  }

  async cancelUpload(ownerId: string, uploadId: string): Promise<{ cancelled: true }> {
    return this.withUploadLock(uploadId, () => this.cancelUploadUnlocked(ownerId, uploadId));
  }

  private async cancelUploadUnlocked(
    ownerId: string,
    uploadId: string,
  ): Promise<{ cancelled: true }> {
    await this.ensureInitialized();
    const manifest = await this.readOwnedManifest(ownerId, uploadId);
    if (manifest.phase === 'complete') {
      throw new Error('Completed media cannot be cancelled.');
    }
    manifest.phase = 'cancelled';
    manifest.resumable = false;
    manifest.updatedAt = new Date(this.now()).toISOString();
    await this.writeManifest(manifest).catch(() => {});
    await rm(this.uploadDirectory(uploadId), { recursive: true, force: true });
    this.activeHashes.delete(uploadId);
    return { cancelled: true };
  }

  async ingestLocalFile(input: LocalMediaIngest): Promise<VerifiedMediaAsset> {
    await this.ensureInitialized();
    if (!path.isAbsolute(input.sourcePath)) throw new Error('Local media source must be absolute.');
    const flags = fsConstants.O_RDONLY | noFollowFlag();
    const source = await open(input.sourcePath, flags);
    let uploadId: string | undefined;
    try {
      const before = await source.stat();
      if (!before.isFile()) throw new Error('Selected media is not a regular file.');
      if (before.nlink !== 1) throw new Error('Hard-linked media sources are not accepted.');
      if (isSparse(before)) throw new Error('Sparse media sources are not accepted.');
      if (before.size !== input.expectedSize) {
        throw new Error('Selected media size changed before ingest started.');
      }
      const started = input.resumeUploadId
        ? await this.status('electron-main', input.resumeUploadId)
        : await this.startUpload({
            ownerId: 'electron-main',
            sessionId: input.sessionId,
            filename: input.filename,
            mimeType: input.mimeType,
            expectedSize: input.expectedSize,
            expectedDigest: input.expectedDigest,
            uploadId: input.uploadId,
          });
      if (
        started.expectedSize !== input.expectedSize
        || started.sessionId !== input.sessionId
        || started.phase !== 'uploading'
      ) {
        throw new Error('Selected media does not match the resumable upload.');
      }
      uploadId = started.uploadId;
      input.onProgress?.(started);

      const buffer = Buffer.allocUnsafe(this.policy.chunkBytes);
      const sourceHash = createHash('sha256');
      let offset = started.receivedBytes;
      if (offset > 0) {
        await this.updateHashHandlePrefix(source, offset, sourceHash);
        const sourcePrefix = sourceHash.copy().digest('hex');
        const staged = await this.openVerifiedPart(
          await this.readOwnedManifest('electron-main', uploadId),
          fsConstants.O_RDONLY,
        );
        try {
          const stagedPrefix = await this.hashHandlePrefix(staged, offset);
          if (sourcePrefix !== stagedPrefix) {
            throw new Error('Selected media does not match the staged resumable prefix.');
          }
        } finally {
          await staged.close();
        }
      }
      while (offset < before.size) {
        if (input.signal?.aborted) throw new Error('Media ingest cancelled.');
        const length = Math.min(buffer.length, before.size - offset);
        const result = await source.read(buffer, 0, length, offset);
        if (result.bytesRead !== length) throw new Error('Selected media shrank during ingest.');
        const bytes = buffer.subarray(0, result.bytesRead);
        sourceHash.update(bytes);
        const next = await this.appendChunk({
          ownerId: 'electron-main',
          uploadId,
          offset,
          bytes,
          chunkDigest: createHash('sha256').update(bytes).digest('hex'),
        });
        offset += result.bytesRead;
        input.onProgress?.(next);
      }

      const after = await source.stat();
      if (
        !sameIdentity(identityOf(before), after)
        || after.size !== before.size
        || after.mtimeMs !== before.mtimeMs
        || after.ctimeMs !== before.ctimeMs
      ) {
        throw new Error('Selected media changed while it was being ingested.');
      }
      const digest = sourceHash.digest('hex');
      if (
        input.expectedDigest
        && assertDigest(input.expectedDigest, 'Expected digest') !== digest
      ) {
        throw new Error('Selected media digest does not match the expected SHA-256.');
      }
      const asset = await this.completeUpload({
        ownerId: 'electron-main',
        uploadId,
        expectedDigest: digest,
        onProgress: input.onProgress,
      });
      input.onProgress?.(await this.status('electron-main', uploadId));
      return asset;
    } catch (error) {
      if (uploadId) {
        await this.cancelUpload('electron-main', uploadId).catch(() => {});
      }
      throw error;
    } finally {
      await source.close();
    }
  }

  async resolveAsset(assetId: string): Promise<VerifiedMediaAsset> {
    await this.ensureInitialized();
    const digest = assetId.startsWith('sha256:') ? assetId.slice(7) : assetId;
    assertDigest(digest, 'Asset digest');
    const file = this.blobPath(digest);
    const fileStats = await stat(file);
    if (!fileStats.isFile() || fileStats.nlink !== 1) {
      throw new Error('Verified media asset is not a private regular file.');
    }
    const headerHandle = await open(file, fsConstants.O_RDONLY | noFollowFlag());
    let detected: DetectedMedia;
    try {
      const header = Buffer.alloc(64 * 1024);
      const { bytesRead } = await headerHandle.read(header, 0, header.length, 0);
      detected = detectMedia(header.subarray(0, bytesRead));
    } finally {
      await headerHandle.close();
    }
    return {
      schema: MEDIA_ASSET_SCHEMA,
      id: `sha256:${digest}`,
      digest,
      size: fileStats.size,
      mimeType: detected.mimeType,
      kind: detected.kind,
      displayName: 'media',
      storage: 'local-private',
      verified: true,
      deduplicated: true,
      createdAt: fileStats.birthtime.toISOString(),
      privatePath: file,
    };
  }

  async cleanupExpired(): Promise<number> {
    await this.ensureInitialized(false);
    let removed = 0;
    for (const entry of await readdir(this.stagingRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[a-f0-9-]{36}$/.test(entry.name)) continue;
      await this.withUploadLock(entry.name, async () => {
        try {
          const manifest = await this.readManifest(entry.name);
          if (Date.parse(manifest.expiresAt) <= this.now()) {
            await rm(this.uploadDirectory(entry.name), { recursive: true, force: true });
            this.activeHashes.delete(entry.name);
            removed += 1;
          }
        } catch {
          const directory = this.uploadDirectory(entry.name);
          const directoryStats = await stat(directory).catch(() => undefined);
          if (
            directoryStats
            && this.now() - directoryStats.mtimeMs > this.policy.uploadTtlMs
          ) {
            await rm(directory, { recursive: true, force: true });
            this.activeHashes.delete(entry.name);
            removed += 1;
          }
        }
      });
    }
    return removed;
  }

  private async ensureInitialized(cleanup = true): Promise<void> {
    if (!this.initialized) {
      await mkdir(this.stagingRoot, { recursive: true, mode: 0o700 });
      await mkdir(this.blobRoot, { recursive: true, mode: 0o700 });
      this.initialized = true;
      if (cleanup) await this.cleanupExpired();
    }
  }

  private async withUploadLock<T>(
    uploadId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.uploadLocks.get(uploadId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => gate);
    this.uploadLocks.set(uploadId, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.uploadLocks.get(uploadId) === tail) this.uploadLocks.delete(uploadId);
    }
  }

  private assertStart(input: StartMediaUpload): void {
    if (!input.ownerId || input.ownerId.length > 256) throw new Error('Upload owner is required.');
    if (!input.sessionId || input.sessionId.length > 256) throw new Error('Upload session is required.');
    if (
      !Number.isSafeInteger(input.expectedSize)
      || input.expectedSize <= 0
      || input.expectedSize > this.policy.maxFileBytes
      || input.expectedSize > MEDIA_HARD_MAX_BYTES
    ) {
      throw new Error(
        `Media size must be between 1 and ${this.policy.maxFileBytes} bytes.`,
      );
    }
    assertDigest(input.expectedDigest, 'Expected digest');
  }

  private async assertCapacity(sessionId: string, incomingBytes: number): Promise<void> {
    let sessionBytes = 0;
    let globalBytes = 0;
    let sessionUploads = 0;
    let globalUploads = 0;
    for (const entry of await readdir(this.stagingRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      try {
        const manifest = await this.readManifest(entry.name);
        if (!['uploading', 'hashing', 'validating'].includes(manifest.phase)) continue;
        globalBytes += manifest.expectedSize;
        globalUploads += 1;
        if (manifest.sessionId === sessionId) {
          sessionBytes += manifest.expectedSize;
          sessionUploads += 1;
        }
      } catch {
        // Corrupt/attacker-created entries do not become trusted quota records.
      }
    }
    if (globalUploads >= this.policy.maxConcurrentUploads) {
      throw new Error('Global concurrent media upload quota is exhausted.');
    }
    if (sessionUploads >= this.policy.maxSessionUploads) {
      throw new Error('Session concurrent media upload quota is exhausted.');
    }
    if (globalBytes + incomingBytes > this.policy.globalStagingQuotaBytes) {
      throw new Error('Global media staging byte quota is exhausted.');
    }
    if (sessionBytes + incomingBytes > this.policy.sessionStagingQuotaBytes) {
      throw new Error('Session media staging byte quota is exhausted.');
    }
    await this.assertFreeDisk(incomingBytes);
  }

  private async assertFreeDisk(incomingBytes: number): Promise<void> {
    const disk = await statfs(this.root);
    const available = Number(disk.bavail) * Number(disk.bsize);
    if (
      !Number.isFinite(available)
      || available - incomingBytes < this.policy.minimumFreeBytes
    ) {
      throw new Error('Insufficient free disk space for private media staging.');
    }
  }

  private uploadDirectory(uploadId: string): string {
    assertUploadId(uploadId);
    return path.join(this.stagingRoot, uploadId);
  }

  private partPath(uploadId: string): string {
    return path.join(this.uploadDirectory(uploadId), 'payload.part');
  }

  private manifestPath(uploadId: string): string {
    return path.join(this.uploadDirectory(uploadId), 'manifest.json');
  }

  private blobPath(digest: string): string {
    return path.join(this.blobRoot, digest.slice(0, 2), digest);
  }

  private async readManifest(uploadId: string): Promise<UploadManifest> {
    assertUploadId(uploadId);
    const raw = await readFile(this.manifestPath(uploadId), 'utf8');
    const manifest = JSON.parse(raw) as UploadManifest;
    if (
      manifest.schema !== MEDIA_UPLOAD_SCHEMA
      || manifest.uploadId !== uploadId
      || !Number.isSafeInteger(manifest.expectedSize)
      || !Number.isSafeInteger(manifest.receivedBytes)
      || !Array.isArray(manifest.recentChunks)
    ) {
      throw new Error('Invalid private media upload manifest.');
    }
    return manifest;
  }

  private async readOwnedManifest(ownerId: string, uploadId: string): Promise<UploadManifest> {
    const manifest = await this.readManifest(uploadId);
    if (manifest.ownerId !== ownerId) throw new Error('Media upload is not owned by this client.');
    return manifest;
  }

  private async writeManifest(manifest: UploadManifest): Promise<void> {
    const directory = this.uploadDirectory(manifest.uploadId);
    const temporary = path.join(directory, `.manifest-${randomUUID()}.tmp`);
    const handle = await open(
      temporary,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | noFollowFlag(),
      0o600,
    );
    try {
      await handle.writeFile(`${JSON.stringify(manifest)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, this.manifestPath(manifest.uploadId));
    await fsyncDirectory(directory);
  }

  private async openVerifiedPart(manifest: UploadManifest, access: number) {
    if (!manifest.partIdentity) throw new Error('Upload staging identity is missing.');
    const handle = await open(this.partPath(manifest.uploadId), access | noFollowFlag());
    try {
      const partStats = await handle.stat();
      if (
        !partStats.isFile()
        || partStats.nlink !== 1
        || !sameIdentity(manifest.partIdentity, partStats)
        || partStats.size !== manifest.receivedBytes
      ) {
        throw new Error('Private media staging identity changed.');
      }
      return handle;
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  private async recoverPartials(): Promise<void> {
    for (const entry of await readdir(this.stagingRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[a-f0-9-]{36}$/.test(entry.name)) continue;
      try {
        const manifest = await this.readManifest(entry.name);
        if (!['uploading', 'hashing', 'validating'].includes(manifest.phase)) continue;
        manifest.phase = 'uploading';
        const handle = await open(
          this.partPath(entry.name),
          fsConstants.O_RDWR | noFollowFlag(),
        );
        try {
          const partStats = await handle.stat();
          if (
            !manifest.partIdentity
            || !partStats.isFile()
            || partStats.nlink !== 1
            || !sameIdentity(manifest.partIdentity, partStats)
            || partStats.size < manifest.receivedBytes
          ) {
            throw new Error('Recovered media staging identity is invalid.');
          }
          if (partStats.size > manifest.receivedBytes) {
            await handle.truncate(manifest.receivedBytes);
            await handle.sync();
          }
        } finally {
          await handle.close();
        }
        manifest.updatedAt = new Date(this.now()).toISOString();
        await this.writeManifest(manifest);
      } catch {
        await rm(this.uploadDirectory(entry.name), { recursive: true, force: true });
      }
    }
  }

  private async hashHandlePrefix(
    handle: Awaited<ReturnType<typeof open>>,
    length: number,
  ): Promise<string> {
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(this.policy.chunkBytes);
    let offset = 0;
    while (offset < length) {
      const wanted = Math.min(buffer.length, length - offset);
      const { bytesRead } = await handle.read(buffer, 0, wanted, offset);
      if (bytesRead !== wanted) {
        throw new Error('Media prefix changed during resume validation.');
      }
      hash.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    return hash.digest('hex');
  }

  private async updateHashHandlePrefix(
    handle: Awaited<ReturnType<typeof open>>,
    length: number,
    hash: Hash,
  ): Promise<void> {
    const buffer = Buffer.allocUnsafe(this.policy.chunkBytes);
    let offset = 0;
    while (offset < length) {
      const wanted = Math.min(buffer.length, length - offset);
      const { bytesRead } = await handle.read(buffer, 0, wanted, offset);
      if (bytesRead !== wanted) {
        throw new Error('Media prefix changed during resume validation.');
      }
      hash.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
  }

  private async ensureHashState(
    manifest: UploadManifest,
  ): Promise<{ hash: Hash; offset: number }> {
    const existing = this.activeHashes.get(manifest.uploadId);
    if (existing?.offset === manifest.receivedBytes) return existing;
    const hash = createHash('sha256');
    if (manifest.receivedBytes > 0) {
      const staged = await this.openVerifiedPart(manifest, fsConstants.O_RDONLY);
      try {
        await this.updateHashHandlePrefix(staged, manifest.receivedBytes, hash);
      } finally {
        await staged.close();
      }
    }
    const state = { hash, offset: manifest.receivedBytes };
    this.activeHashes.set(manifest.uploadId, state);
    return state;
  }

  private async validateMedia(
    file: string,
    declaredMime: string,
  ): Promise<{ media: DetectedMedia; probe: MediaProbeMetadata }> {
    const handle = await open(file, fsConstants.O_RDONLY | noFollowFlag());
    let media: DetectedMedia;
    try {
      const header = Buffer.alloc(64 * 1024);
      const { bytesRead } = await handle.read(header, 0, header.length, 0);
      media = detectMedia(header.subarray(0, bytesRead), declaredMime);
    } finally {
      await handle.close();
    }

    if (media.kind === 'image' || media.kind === 'midi') {
      return { media, probe: { format: media.format, probe: 'magic' } };
    }
    const probed = await this.ffprobe(file);
    if (!probed) {
      return { media, probe: { format: media.format, probe: 'magic' } };
    }
    const streams = Array.isArray(probed.streams)
      ? probed.streams as Array<Record<string, unknown>>
      : [];
    if (streams.length > this.policy.maxStreams) {
      throw new Error(`Media contains more than ${this.policy.maxStreams} streams.`);
    }
    const format = probed.format && typeof probed.format === 'object'
      ? probed.format as Record<string, unknown>
      : {};
    const duration = Number(format.duration);
    const videoStreams = streams.filter((stream) => stream.codec_type === 'video');
    const audioStreams = streams.filter((stream) => stream.codec_type === 'audio');
    const width = Math.max(0, ...videoStreams.map((stream) => Number(stream.width) || 0));
    const height = Math.max(0, ...videoStreams.map((stream) => Number(stream.height) || 0));
    if (Number.isFinite(duration) && duration > this.policy.maxDurationSeconds) {
      throw new Error(`Media duration exceeds ${this.policy.maxDurationSeconds} seconds.`);
    }
    if (width > this.policy.maxWidth || height > this.policy.maxHeight) {
      throw new Error(
        `Media resolution exceeds ${this.policy.maxWidth}x${this.policy.maxHeight}.`,
      );
    }
    if (media.kind === 'video' && videoStreams.length === 0) {
      throw new Error('Video container has no video stream.');
    }
    if (media.kind === 'audio' && audioStreams.length === 0) {
      throw new Error('Audio container has no audio stream.');
    }
    return {
      media,
      probe: {
        format: String(format.format_name ?? media.format),
        durationSeconds: Number.isFinite(duration) ? duration : undefined,
        width: width || undefined,
        height: height || undefined,
        audioStreams: audioStreams.length,
        videoStreams: videoStreams.length,
        probe: 'magic+ffprobe',
      },
    };
  }

  private async ffprobe(file: string): Promise<Record<string, unknown> | null> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.ffprobePath, [
        '-v', 'error',
        '-show_entries',
        'format=format_name,duration:stream=codec_type,codec_name,width,height',
        '-of', 'json',
        file,
      ], {
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      let stdout = '';
      let stderr = '';
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let exceeded = false;
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`ffprobe exceeded ${this.policy.ffprobeTimeoutMs} ms.`));
      }, this.policy.ffprobeTimeoutMs);
      const collect = (
        current: string,
        currentBytes: number,
        chunk: Buffer,
      ): { value: string; bytes: number } => {
        if (currentBytes + chunk.length > this.policy.maxProbeOutputBytes) {
          exceeded = true;
          child.kill('SIGKILL');
          return { value: current, bytes: currentBytes };
        }
        return { value: current + chunk.toString('utf8'), bytes: currentBytes + chunk.length };
      };
      child.stdout.on('data', (chunk: Buffer) => {
        const next = collect(stdout, stdoutBytes, chunk);
        stdout = next.value;
        stdoutBytes = next.bytes;
      });
      child.stderr.on('data', (chunk: Buffer) => {
        const next = collect(stderr, stderrBytes, chunk);
        stderr = next.value;
        stderrBytes = next.bytes;
      });
      child.once('error', (error: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        if (error.code === 'ENOENT') resolve(null);
        else reject(error);
      });
      child.once('close', (code) => {
        clearTimeout(timer);
        if (exceeded) {
          reject(new Error('ffprobe output exceeded its safety limit.'));
          return;
        }
        if (code !== 0) {
          reject(new Error(
            `ffprobe rejected the media container: ${stderr.slice(0, 1000)}`,
          ));
          return;
        }
        try {
          resolve(JSON.parse(stdout) as Record<string, unknown>);
        } catch {
          reject(new Error('ffprobe returned invalid bounded JSON.'));
        }
      });
    });
  }

  private async finalizeBlob(
    part: string,
    digest: string,
    expectedSize: number,
  ): Promise<{ path: string; deduplicated: boolean }> {
    const destination = this.blobPath(digest);
    const directory = path.dirname(destination);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    let deduplicated = false;
    try {
      await link(part, destination);
      await chmod(destination, 0o600).catch(() => {});
      const handle = await open(destination, fsConstants.O_RDONLY | noFollowFlag());
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fsyncDirectory(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const existing = await stat(destination);
      if (!existing.isFile() || existing.size !== expectedSize) {
        throw new Error('Content-addressed media destination conflicts with staged bytes.');
      }
      deduplicated = true;
    }
    await unlink(part);
    return { path: destination, deduplicated };
  }
}
