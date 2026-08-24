import { gateway } from './gateway.js';
import { desktopBridge } from './desktop.js';
import type {
  MediaAssetDescriptor,
  MediaUploadStatus,
} from '../types.js';

export const SMALL_DIRECT_UPLOAD_BYTES = 1024 * 1024;
const DEFAULT_CHUNK_BYTES = 256 * 1024;
const RESUME_PREFIX = 'openrappter.media-upload.v1:';

export interface MediaUploadProgress {
  status: MediaUploadStatus;
  percent: number;
  message: string;
}

export interface MediaUploadOptions {
  sessionId: string;
  signal?: AbortSignal;
  onProgress?: (progress: MediaUploadProgress) => void;
}

interface MediaUploadPolicy {
  directThresholdBytes: number;
  chunkBytes: number;
  maxFileBytes: number;
  transport: 'websocket-base64';
  encodedChunkMaximumBytes: number;
  localOnly: true;
}

interface ResumeRecord {
  uploadId: string;
  size: number;
  lastModified: number;
}

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotateRight(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}

export class IncrementalSha256 {
  private state = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  private pending = new Uint8Array(64);
  private pendingLength = 0;
  private byteLength = 0;
  private finalized = false;

  update(input: Uint8Array): this {
    if (this.finalized) throw new Error('SHA-256 digest is already finalized.');
    this.byteLength += input.byteLength;
    let offset = 0;
    if (this.pendingLength > 0) {
      const take = Math.min(64 - this.pendingLength, input.byteLength);
      this.pending.set(input.subarray(0, take), this.pendingLength);
      this.pendingLength += take;
      offset += take;
      if (this.pendingLength === 64) {
        this.compress(this.pending);
        this.pendingLength = 0;
      }
    }
    while (offset + 64 <= input.byteLength) {
      this.compress(input.subarray(offset, offset + 64));
      offset += 64;
    }
    if (offset < input.byteLength) {
      const tail = input.subarray(offset);
      this.pending.set(tail, 0);
      this.pendingLength = tail.byteLength;
    }
    return this;
  }

  digestHex(): string {
    if (this.finalized) throw new Error('SHA-256 digest is already finalized.');
    this.finalized = true;
    const bitLength = this.byteLength * 8;
    const finalLength = this.pendingLength < 56 ? 64 : 128;
    const final = new Uint8Array(finalLength);
    final.set(this.pending.subarray(0, this.pendingLength));
    final[this.pendingLength] = 0x80;
    const view = new DataView(final.buffer);
    view.setUint32(finalLength - 8, Math.floor(bitLength / 0x1_0000_0000), false);
    view.setUint32(finalLength - 4, bitLength >>> 0, false);
    this.compress(final.subarray(0, 64));
    if (finalLength === 128) this.compress(final.subarray(64));
    return Array.from(this.state)
      .map((value) => value.toString(16).padStart(8, '0'))
      .join('');
  }

  private compress(block: Uint8Array): void {
    const words = new Uint32Array(64);
    const view = new DataView(block.buffer, block.byteOffset, block.byteLength);
    for (let index = 0; index < 16; index += 1) {
      words[index] = view.getUint32(index * 4, false);
    }
    for (let index = 16; index < 64; index += 1) {
      const s0 = rotateRight(words[index - 15], 7)
        ^ rotateRight(words[index - 15], 18)
        ^ (words[index - 15] >>> 3);
      const s1 = rotateRight(words[index - 2], 17)
        ^ rotateRight(words[index - 2], 19)
        ^ (words[index - 2] >>> 10);
      words[index] = (
        words[index - 16] + s0 + words[index - 7] + s1
      ) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = this.state;
    for (let index = 0; index < 64; index += 1) {
      const sigma1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choice = (e & f) ^ (~e & g);
      const temp1 = (h + sigma1 + choice + SHA256_K[index] + words[index]) >>> 0;
      const sigma0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (sigma0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    this.state[0] = (this.state[0] + a) >>> 0;
    this.state[1] = (this.state[1] + b) >>> 0;
    this.state[2] = (this.state[2] + c) >>> 0;
    this.state[3] = (this.state[3] + d) >>> 0;
    this.state[4] = (this.state[4] + e) >>> 0;
    this.state[5] = (this.state[5] + f) >>> 0;
    this.state[6] = (this.state[6] + g) >>> 0;
    this.state[7] = (this.state[7] + h) >>> 0;
  }
}

function progressMessage(status: MediaUploadStatus): string {
  if (status.phase === 'hashing') return 'Verifying SHA-256 locally…';
  if (status.phase === 'validating') return 'Validating media container locally…';
  if (status.phase === 'complete') return status.asset?.deduplicated
    ? 'Verified locally · existing private media reused'
    : 'Verified and staged locally';
  if (status.phase === 'error') return status.error ?? 'Media ingest failed.';
  return status.receivedBytes > 0
    ? `Staging locally · resumable at ${status.receivedBytes} bytes`
    : 'Preparing private local staging…';
}

function report(
  callback: MediaUploadOptions['onProgress'],
  status: MediaUploadStatus,
): void {
  callback?.({
    status,
    percent: status.expectedSize > 0
      ? Math.min(100, status.receivedBytes / status.expectedSize * 100)
      : 0,
    message: progressMessage(status),
  });
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

async function digestChunk(bytes: Uint8Array): Promise<string> {
  const owned = Uint8Array.from(bytes);
  const digest = await crypto.subtle.digest(
    'SHA-256',
    owned.buffer,
  );
  return Array.from(new Uint8Array(digest))
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
}

function resumeKey(file: File, sessionId: string): string {
  const identity = `${sessionId}\u0000${file.name}\u0000${file.size}\u0000${file.lastModified}`;
  const hash = new IncrementalSha256().update(new TextEncoder().encode(identity)).digestHex();
  return `${RESUME_PREFIX}${hash}`;
}

function readResume(file: File, sessionId: string): ResumeRecord | undefined {
  try {
    const raw = localStorage.getItem(resumeKey(file, sessionId));
    if (!raw) return undefined;
    const record = JSON.parse(raw) as ResumeRecord;
    return record.size === file.size && record.lastModified === file.lastModified
      ? record
      : undefined;
  } catch {
    return undefined;
  }
}

function writeResume(file: File, sessionId: string, uploadId: string): void {
  try {
    localStorage.setItem(
      resumeKey(file, sessionId),
      JSON.stringify({ uploadId, size: file.size, lastModified: file.lastModified }),
    );
  } catch {
    // Resume persistence is best-effort; the current upload remains correct.
  }
}

function clearResume(file: File, sessionId: string): void {
  try {
    localStorage.removeItem(resumeKey(file, sessionId));
  } catch {
    // Storage may be disabled.
  }
}

export class MediaUploadClient {
  async upload(file: File, options: MediaUploadOptions): Promise<MediaAssetDescriptor> {
    return desktopBridge()
      ? this.uploadDesktop(file, options)
      : this.uploadBrowser(file, options);
  }

  async cancel(uploadId: string): Promise<void> {
    const desktop = desktopBridge();
    if (desktop) {
      await desktop.mediaCancel(uploadId);
      return;
    }
    await gateway.request('media.upload.cancel', { uploadId });
  }

  private async uploadDesktop(
    file: File,
    options: MediaUploadOptions,
  ): Promise<MediaAssetDescriptor> {
    const desktop = desktopBridge()!;
    const resume = readResume(file, options.sessionId);
    const started = await desktop.mediaStart(file, {
      sessionId: options.sessionId,
      filename: file.name,
      mimeType: file.type || 'application/octet-stream',
      expectedSize: file.size,
      resumeUploadId: resume?.uploadId,
    }) as unknown as MediaUploadStatus;
    writeResume(file, options.sessionId, started.uploadId);
    report(options.onProgress, started);

    return new Promise<MediaAssetDescriptor>((resolve, reject) => {
      let settled = false;
      const finish = (
        action: () => void,
      ) => {
        if (settled) return;
        settled = true;
        cleanup();
        action();
      };
      const onStatus = (status: MediaUploadStatus) => {
        if (status.uploadId !== started.uploadId) return;
        report(options.onProgress, status);
        if (status.phase === 'complete' && status.asset) {
          clearResume(file, options.sessionId);
          finish(() => resolve(status.asset!));
        } else if (
          status.phase === 'error'
          || status.phase === 'cancelled'
          || status.phase === 'expired'
        ) {
          clearResume(file, options.sessionId);
          finish(() => reject(new Error(status.error ?? `Media ingest ${status.phase}.`)));
        }
      };
      const removeListener = desktop.onMediaStatus((status) => {
        onStatus(status as unknown as MediaUploadStatus);
      });
      const poll = setInterval(() => {
        void desktop.mediaStatus(started.uploadId)
          .then((status) => onStatus(status as unknown as MediaUploadStatus))
          .catch((error: unknown) => finish(() => reject(error)));
      }, 500);
      const abort = () => {
        void desktop.mediaCancel(started.uploadId).finally(() => {
          clearResume(file, options.sessionId);
          finish(() => reject(new DOMException('Media ingest cancelled.', 'AbortError')));
        });
      };
      const cleanup = () => {
        clearInterval(poll);
        removeListener();
        options.signal?.removeEventListener('abort', abort);
      };
      options.signal?.addEventListener('abort', abort, { once: true });
      if (options.signal?.aborted) abort();
    });
  }

  private async uploadBrowser(
    file: File,
    options: MediaUploadOptions,
  ): Promise<MediaAssetDescriptor> {
    const policy = await gateway.request<MediaUploadPolicy>('media.upload.policy');
    if (file.size > policy.maxFileBytes) {
      throw new Error(
        `${file.name} is ${file.size} bytes; this installation's verified local media maximum is ${policy.maxFileBytes} bytes.`,
      );
    }
    const stored = readResume(file, options.sessionId);
    let status: MediaUploadStatus | undefined;
    if (stored) {
      status = await gateway.request<MediaUploadStatus>('media.upload.status', {
        uploadId: stored.uploadId,
      }).catch(() => undefined);
      if (
        status?.expectedSize !== file.size
        || status.sessionId !== options.sessionId
        || status.phase !== 'uploading'
      ) {
        status = undefined;
      }
    }
    status ??= await gateway.request<MediaUploadStatus>('media.upload.start', {
      sessionId: options.sessionId,
      filename: file.name,
      mimeType: file.type || 'application/octet-stream',
      expectedSize: file.size,
    });
    writeResume(file, options.sessionId, status.uploadId);
    report(options.onProgress, status);

    const hasher = new IncrementalSha256();
    try {
      for (let offset = 0; offset < file.size; offset += policy.chunkBytes) {
        if (options.signal?.aborted) throw new DOMException('Media ingest cancelled.', 'AbortError');
        const end = Math.min(file.size, offset + policy.chunkBytes);
        const bytes = new Uint8Array(await file.slice(offset, end).arrayBuffer());
        hasher.update(bytes);
        if (offset < status.receivedBytes) continue;
        status = await gateway.request<MediaUploadStatus>('media.upload.chunk', {
          uploadId: status.uploadId,
          offset,
          data: bytesToBase64(bytes),
          chunkDigest: await digestChunk(bytes),
        });
        report(options.onProgress, status);
      }
      const digest = hasher.digestHex();
      const validating: MediaUploadStatus = { ...status, phase: 'hashing' };
      report(options.onProgress, validating);
      const completionUploadId = status.uploadId;
      const completion = gateway.request<MediaAssetDescriptor>('media.upload.complete', {
        uploadId: completionUploadId,
        expectedDigest: digest,
      });
      let polling = false;
      const phasePoll = setInterval(() => {
        if (polling) return;
        polling = true;
        void gateway.request<MediaUploadStatus>('media.upload.status', {
          uploadId: completionUploadId,
        }).then((phase) => report(options.onProgress, phase))
          .catch(() => {})
          .finally(() => { polling = false; });
      }, 500);
      let asset: MediaAssetDescriptor;
      try {
        asset = await completion;
      } finally {
        clearInterval(phasePoll);
      }
      report(options.onProgress, {
        ...status,
        phase: 'complete',
        receivedBytes: file.size,
        resumable: false,
        asset,
      });
      clearResume(file, options.sessionId);
      return asset;
    } catch (error) {
      if (options.signal?.aborted) {
        await gateway.request('media.upload.cancel', {
          uploadId: status.uploadId,
        }).catch(() => {});
        clearResume(file, options.sessionId);
      }
      throw error;
    }
  }
}

export const mediaUploads = new MediaUploadClient();
