import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TelegramChannel } from './telegram.js';
import type { IncomingMessage } from './types.js';

/**
 * Inbound voice notes.
 *
 * Telegram hands over a `file_id`, not a URL — a voice note is unreadable until
 * it is resolved, downloaded and transcribed. These tests cover that path and,
 * just as importantly, what happens when any step of it fails: a message the
 * owner recorded must never be silently dropped.
 */

const TOKEN = '123456:test-token';
const OGG = Buffer.from('OggS-fake-audio');

function voiceUpdate(overrides: Record<string, unknown> = {}) {
  return {
    message: {
      message_id: 42,
      date: 1_754_000_000,
      chat: { id: 555, type: 'private' },
      from: { id: 777, first_name: 'Kody', username: 'kody' },
      voice: { file_id: 'voice-file-1', duration: 6, mime_type: 'audio/ogg' },
      ...overrides,
    },
  };
}

function collect(channel: TelegramChannel): IncomingMessage[] {
  const received: IncomingMessage[] = [];
  channel.onMessage(async (message) => {
    received.push(message);
  });
  return received;
}

/** Wait for the channel's async update processing to settle. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

describe('Telegram voice notes', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function mockTelegram(options: { filePath?: string | null; audio?: Buffer | null; contentLength?: number } = {}) {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/getFile')) {
        return {
          ok: true,
          json: async () =>
            options.filePath === null
              ? { ok: false }
              : { ok: true, result: { file_path: options.filePath ?? 'voice/file_1.oga' } },
        };
      }
      if (url.includes('/file/bot')) {
        if (options.audio === null) return { ok: false, headers: new Headers() };
        const body = options.audio ?? OGG;
        return {
          ok: true,
          headers: new Headers({ 'content-length': String(options.contentLength ?? body.byteLength) }),
          arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
        };
      }
      return { ok: true, json: async () => ({ ok: true, result: {} }) };
    });
  }

  it('resolves a file_id into a download URL', async () => {
    mockTelegram();
    const channel = new TelegramChannel({ token: TOKEN });

    const url = await channel.getFileUrl('voice-file-1');

    expect(url).toBe(`https://api.telegram.org/file/bot${TOKEN}/voice/file_1.oga`);
    expect(fetchMock.mock.calls[0][0]).toContain('/getFile');
  });

  it('returns null when Telegram will not resolve the file', async () => {
    mockTelegram({ filePath: null });
    const channel = new TelegramChannel({ token: TOKEN });
    expect(await channel.getFileUrl('gone')).toBeNull();
  });

  it('downloads the audio', async () => {
    mockTelegram();
    const channel = new TelegramChannel({ token: TOKEN });

    const audio = await channel.downloadFile('voice-file-1');

    expect(audio).toBeInstanceOf(Buffer);
    expect(audio!.toString()).toBe(OGG.toString());
  });

  it('refuses a file larger than the cap', async () => {
    mockTelegram({ contentLength: 50 * 1024 * 1024 });
    const channel = new TelegramChannel({ token: TOKEN, maxVoiceBytes: 1024 });
    expect(await channel.downloadFile('huge')).toBeNull();
  });

  it('refuses a file that lies about its size', async () => {
    // A wrong content-length must not be enough to get past the cap.
    mockTelegram({ audio: Buffer.alloc(4096), contentLength: 10 });
    const channel = new TelegramChannel({ token: TOKEN, maxVoiceBytes: 1024 });
    expect(await channel.downloadFile('sneaky')).toBeNull();
  });

  it('turns a voice note into the message content', async () => {
    mockTelegram();
    const transcriber = {
      transcribe: vi.fn(async (_audio: Buffer) => ({ text: '  Quote Riverside Cafe for a weekly deep clean  ' })),
    };
    const channel = new TelegramChannel({ token: TOKEN, transcriber });
    const received = collect(channel);

    channel.handleWebhookUpdate(voiceUpdate());
    await settle();

    expect(received).toHaveLength(1);
    expect(received[0].content).toBe('Quote Riverside Cafe for a weekly deep clean');
    expect(received[0].metadata?.transcribed).toBe(true);
    expect(received[0].metadata?.voiceDurationSeconds).toBe(6);
    expect(transcriber.transcribe).toHaveBeenCalledOnce();
    expect(transcriber.transcribe.mock.calls[0]?.[0].toString()).toBe(OGG.toString());
  });

  it('still delivers the message when transcription fails', async () => {
    mockTelegram();
    const transcriber = {
      transcribe: vi.fn(async () => {
        throw new Error('whisper is not installed');
      }),
    };
    const channel = new TelegramChannel({ token: TOKEN, transcriber });
    const received = collect(channel);

    channel.handleWebhookUpdate(voiceUpdate());
    await settle();

    // Losing what someone said is worse than saying "a voice note arrived".
    expect(received).toHaveLength(1);
    expect(received[0].content).toBe('[voice note]');
    expect(received[0].metadata?.transcribed).toBe(false);
    expect(received[0].attachments?.[0].type).toBe('audio');
  });

  it('still delivers the message when the transcript is empty', async () => {
    mockTelegram();
    const channel = new TelegramChannel({ token: TOKEN, transcriber: { transcribe: async () => ({ text: '   ' }) } });
    const received = collect(channel);

    channel.handleWebhookUpdate(voiceUpdate());
    await settle();

    expect(received[0].content).toBe('[voice note]');
  });

  it('still delivers the message when no transcriber is configured', async () => {
    mockTelegram();
    const channel = new TelegramChannel({ token: TOKEN });
    const received = collect(channel);

    channel.handleWebhookUpdate(voiceUpdate());
    await settle();

    expect(received[0].content).toBe('[voice note]');
    expect(received[0].attachments?.[0].url).toBe('voice-file-1');
  });

  it('transcribes a video note the same way', async () => {
    mockTelegram();
    const channel = new TelegramChannel({
      token: TOKEN,
      transcriber: { transcribe: async () => ({ text: 'on my way' }) },
    });
    const received = collect(channel);

    channel.handleWebhookUpdate(
      voiceUpdate({ voice: undefined, video_note: { file_id: 'vn-1', duration: 3 } }),
    );
    await settle();

    expect(received[0].content).toBe('on my way');
    expect(received[0].attachments?.[0].filename).toBe('video_note.mp4');
  });

  it('leaves a typed message alone', async () => {
    mockTelegram();
    const transcriber = { transcribe: vi.fn(async () => ({ text: 'should not run' })) };
    const channel = new TelegramChannel({ token: TOKEN, transcriber });
    const received = collect(channel);

    channel.handleWebhookUpdate(voiceUpdate({ voice: undefined, text: 'just typing' }));
    await settle();

    expect(received[0].content).toBe('just typing');
    expect(received[0].metadata?.transcribed).toBe(false);
    expect(transcriber.transcribe).not.toHaveBeenCalled();
  });

  it('prefers a caption over transcribing', async () => {
    mockTelegram();
    const transcriber = { transcribe: vi.fn(async () => ({ text: 'should not run' })) };
    const channel = new TelegramChannel({ token: TOKEN, transcriber });
    const received = collect(channel);

    channel.handleWebhookUpdate(voiceUpdate({ caption: 'invoice them' }));
    await settle();

    expect(received[0].content).toBe('invoice them');
    expect(transcriber.transcribe).not.toHaveBeenCalled();
  });

  it('honours the chat allowlist before downloading anything', async () => {
    mockTelegram();
    const transcriber = { transcribe: vi.fn(async () => ({ text: 'secret' })) };
    const channel = new TelegramChannel({ token: TOKEN, allowedChatIds: ['999'], transcriber });
    const received = collect(channel);

    channel.handleWebhookUpdate(voiceUpdate());
    await settle();

    expect(received).toHaveLength(0);
    expect(transcriber.transcribe).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('marks a transcribed command as a command', async () => {
    mockTelegram();
    const channel = new TelegramChannel({
      token: TOKEN,
      transcriber: { transcribe: async () => ({ text: '/brief' }) },
    });
    const received = collect(channel);

    channel.handleWebhookUpdate(voiceUpdate());
    await settle();

    expect(received[0].metadata?.isCommand).toBe(true);
  });

  it('delivers a batch in order even when transcription is slow', async () => {
    // Transcription made update handling async. A slow first voice note must
    // not let a later typed message overtake it.
    mockTelegram();
    let call = 0;
    const channel = new TelegramChannel({
      token: TOKEN,
      transcriber: {
        transcribe: async () => {
          const delay = call++ === 0 ? 30 : 0;
          await new Promise((resolve) => setTimeout(resolve, delay));
          return { text: `voice ${call}` };
        },
      },
    });
    const received = collect(channel);

    const updates = [
      { update_id: 1, ...voiceUpdate({ voice: { file_id: 'a', duration: 1 } }) },
      { update_id: 2, ...voiceUpdate({ voice: { file_id: 'b', duration: 1 } }) },
      { update_id: 3, ...voiceUpdate({ voice: undefined, text: 'typed last' }) },
    ];

    // Drive the same path polling uses.
    for (const update of updates) {
      await (channel as unknown as { processUpdate(u: unknown): Promise<void> }).processUpdate(update);
    }

    expect(received.map((m) => m.content)).toEqual(['voice 1', 'voice 2', 'typed last']);
  });
});
