import { afterEach, describe, expect, it, vi } from 'vitest';

import '../components/chat.js';
import { gateway } from '../services/gateway.js';

const REPORTED_FILENAME = 'RappFactory_Showcase_v5rough edit_backup.mp4';
const REPORTED_SIZE = 100 * 1024 * 1024 + 1;

afterEach(() => {
  vi.restoreAllMocks();
  delete window.openrappterDesktop;
});

function uploadStatus(phase: 'uploading' | 'complete') {
  const now = new Date().toISOString();
  const asset = {
    schema: 'openrappter-media-asset/1.0',
    id: `sha256:${'a'.repeat(64)}`,
    digest: 'a'.repeat(64),
    size: REPORTED_SIZE,
    mimeType: 'video/mp4',
    kind: 'video',
    displayName: REPORTED_FILENAME,
    storage: 'local-private',
    verified: true,
    deduplicated: false,
    createdAt: now,
  };
  return {
    schema: 'openrappter-media-upload/1.0',
    uploadId: '00000000-0000-4000-8000-000000000450',
    sessionId: 'reported-session',
    displayName: REPORTED_FILENAME,
    mimeType: 'video/mp4',
    expectedSize: REPORTED_SIZE,
    receivedBytes: phase === 'complete' ? REPORTED_SIZE : 0,
    chunkBytes: 256 * 1024,
    phase,
    resumable: phase !== 'complete',
    localOnly: true,
    createdAt: now,
    updatedAt: now,
    expiresAt: now,
    ...(phase === 'complete' ? { asset } : {}),
  };
}

describe('reported >100 MB Chat attachment regression', () => {
  it('never enters the renderer FileReader/base64 path and sends a verified asset', async () => {
    let mediaListener:
      | ((status: Record<string, unknown>) => void)
      | undefined;
    const complete = uploadStatus('complete');
    Object.defineProperty(window, 'openrappterDesktop', {
      configurable: true,
      value: {
        platform: 'darwin',
        gatewayUrl: 'ws://127.0.0.1:18791',
        gatewayToken: 'test',
        mediaStart: vi.fn(async () => uploadStatus('uploading')),
        mediaStatus: vi.fn(async () => complete),
        mediaCancel: vi.fn(async () => ({ cancelled: true })),
        onMediaStatus: vi.fn((callback: (status: Record<string, unknown>) => void) => {
          mediaListener = callback;
          queueMicrotask(() => mediaListener?.(complete));
          return () => { mediaListener = undefined; };
        }),
      },
    });
    const fileReader = vi.spyOn(FileReader.prototype, 'readAsDataURL')
      .mockImplementation((file: Blob) => {
        const selected = file as Blob & { name?: string; size: number };
        throw new Error(
          `${selected.name ?? REPORTED_FILENAME} exceeds the 100 MB file limit.`,
        );
      });
    let sent: Record<string, unknown> | undefined;
    vi.spyOn(gateway, 'request').mockImplementation(
      async (method: string, params?: Record<string, unknown>) => {
        if (method === 'chat.send') {
          sent = params;
          return {
            runId: 'reported-run',
            sessionKey: 'reported-session',
            status: 'accepted',
          } as never;
        }
        if (method === 'chat.abort') return { aborted: true } as never;
        throw new Error(`Unexpected RPC: ${method}`);
      },
    );

    // The exact reported size is represented as metadata. No 100 MB allocation
    // is needed because the safe Electron handoff must never inspect its bytes.
    const selected = {
      name: REPORTED_FILENAME,
      size: REPORTED_SIZE,
      type: 'video/mp4',
      lastModified: 1,
    } as File;
    const chat = document.createElement('openrappter-chat') as HTMLElement & {
      addFiles(files: File[]): void;
      handleSend(): Promise<void>;
      attachments: Array<{ uploadPromise?: Promise<unknown> }>;
      inputValue: string;
      error: string | null;
    };
    chat.addFiles([selected]);
    await chat.attachments[0]?.uploadPromise;
    chat.inputValue = 'Analyze this exact RappFactory showcase video.';
    await chat.handleSend();

    expect(fileReader).not.toHaveBeenCalled();
    expect(chat.error).toBeNull();
    expect(sent).toMatchObject({
      message: 'Analyze this exact RappFactory showcase video.',
      attachments: [{
        assetId: `sha256:${'a'.repeat(64)}`,
        digest: 'a'.repeat(64),
        size: REPORTED_SIZE,
        filename: REPORTED_FILENAME,
      }],
    });
  });

  it.each([
      ['large image preview', 'poster.png', 'image/png'],
      ['empty MIME fallback', 'capture.bin', ''],
      ['large audio', 'narration.wav', 'audio/wav'],
    ])('keeps the %s adjacent path out of FileReader', async (
      _case,
      filename,
      mimeType,
    ) => {
      let listener: ((status: Record<string, unknown>) => void) | undefined;
      const complete = {
        ...uploadStatus('complete'),
        displayName: filename,
        mimeType: mimeType || 'application/octet-stream',
      };
      const mediaStart = vi.fn(async () => ({
        ...uploadStatus('uploading'),
        displayName: filename,
        mimeType: mimeType || 'application/octet-stream',
      }));
      Object.defineProperty(window, 'openrappterDesktop', {
        configurable: true,
        value: {
          mediaStart,
          mediaStatus: vi.fn(async () => complete),
          mediaCancel: vi.fn(async () => ({ cancelled: true })),
          onMediaStatus: vi.fn((callback: (status: Record<string, unknown>) => void) => {
            listener = callback;
            queueMicrotask(() => listener?.(complete));
            return () => { listener = undefined; };
          }),
        },
      });
      const fileReader = vi.spyOn(FileReader.prototype, 'readAsDataURL')
        .mockImplementation(() => {
          throw new Error('Large adjacent path entered FileReader.');
        });
      const selected = {
        name: filename,
        size: 1024 * 1024 + 1,
        type: mimeType,
        lastModified: 2,
      } as File;
      const chat = document.createElement('openrappter-chat') as unknown as {
        addFiles(files: File[]): void;
        attachments: Array<{ uploadPromise?: Promise<unknown> }>;
      };
      chat.addFiles([selected]);
      await chat.attachments[0]?.uploadPromise;
      expect(fileReader).not.toHaveBeenCalled();
      expect(mediaStart).toHaveBeenCalledWith(
        selected,
        expect.objectContaining({
          filename,
          expectedSize: 1024 * 1024 + 1,
        }),
      );
  });
});
