import { beforeEach, describe, expect, it, vi } from 'vitest';

const { fetchGuardedMock } = vi.hoisted(() => ({
  fetchGuardedMock: vi.fn(),
}));

vi.mock('../net/url-guard.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../net/url-guard.js')>();
  return {
    ...actual,
    fetchGuarded: fetchGuardedMock,
  };
});

import { MediaProcessor } from './processor.js';

function chunkedResponse(
  contentType: string,
  chunks: number[][],
  onCancel?: () => void,
): Response {
  let index = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index === chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(Uint8Array.from(chunks[index++]));
    },
    cancel() {
      onCancel?.();
    },
  });

  return new Response(body, {
    status: 200,
    headers: { 'content-type': contentType },
  });
}

function processorWithLimit(maxSize: number): MediaProcessor {
  const processor = new MediaProcessor();
  // Keep the fixture tiny while exercising the same policy used in production.
  Object.defineProperty(processor, 'getMaxSize', { value: () => maxSize });
  return processor;
}

beforeEach(() => {
  fetchGuardedMock.mockReset();
});

describe('MediaProcessor streamed download limit', () => {
  it.each(['audio/wav', 'video/mp4'])(
    'rejects chunked %s once the body crosses its limit',
    async (contentType) => {
      let cancelled = false;
      fetchGuardedMock.mockResolvedValue(
        chunkedResponse(
          contentType,
          [[1, 2, 3, 4], [5, 6, 7, 8], [9, 10, 11, 12]],
          () => { cancelled = true; },
        ),
      );

      await expect(
        processorWithLimit(5).processUrl('https://example.com/media'),
      ).rejects.toThrow(/too large/i);
      expect(cancelled).toBe(true);
    },
  );

  it('still accepts a chunked body within the limit', async () => {
    fetchGuardedMock.mockResolvedValue(
      chunkedResponse('audio/wav', [[1, 2], [3, 4]]),
    );

    const result = await processorWithLimit(5).processUrl(
      'https://example.com/audio',
    );

    expect(result.type).toBe('audio');
    expect(result.size).toBe(4);
  });
});
