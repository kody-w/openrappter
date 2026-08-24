import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  ELEVENLABS_ORIGIN,
  ElevenLabsClient,
  ElevenLabsError,
  type ElevenLabsCatalog,
} from './elevenlabs.js';

const KEY = `sk_${'a'.repeat(40)}`;
const VOICE_ID = 'voice_Abc123456789';
const MODEL_ID = 'eleven_flash_v2_5';

function jsonResponse(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function audioResponse(bytes = new Uint8Array(16_000)): Response {
  return new Response(bytes, {
    status: 200,
    headers: { 'content-type': 'audio/mpeg' },
  });
}

function mockCatalog(): ElevenLabsCatalog {
  return {
    voices: [{ id: VOICE_ID, name: 'Verified Voice', language: 'en' }],
    models: [{ id: MODEL_ID, name: 'Flash', languages: ['en'] }],
    verifiedAt: '2026-08-23T12:00:00.000Z',
  };
}

function createClient(
  fetchImpl: typeof fetch,
  overrides: Partial<ConstructorParameters<typeof ElevenLabsClient>[0]> = {},
) {
  return new ElevenLabsClient({
    getApiKey: async () => KEY,
    fetchImpl,
    now: () => new Date('2026-08-23T12:00:00.000Z'),
    sleep: async () => undefined,
    ...overrides,
  });
}

describe('ElevenLabsClient transport boundary', () => {
  it('uses only exact allowlisted HTTPS ElevenLabs endpoints and never puts the key in a URL', async () => {
    const seen: URL[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      seen.push(url);
      if (url.pathname === '/v1/voices') return jsonResponse({ voices: [] });
      if (url.pathname === '/v1/models') return jsonResponse([]);
      return jsonResponse({ character_count: 0, character_limit: 10_000 });
    }) as unknown as typeof fetch;
    await createClient(fetchImpl).verify();

    expect(seen.map((url) => `${url.origin}${url.pathname}`)).toEqual([
      `${ELEVENLABS_ORIGIN}/v1/user/subscription`,
      `${ELEVENLABS_ORIGIN}/v1/voices`,
      `${ELEVENLABS_ORIGIN}/v1/models`,
    ]);
    for (const url of seen) {
      expect(url.protocol).toBe('https:');
      expect(url.hostname).toBe('api.elevenlabs.io');
      expect(url.href).not.toContain(KEY);
    }
  });

  it('rejects SSRF-shaped voice and model ids before fetch', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const client = createClient(fetchImpl);
    client.primeCatalog(mockCatalog());
    await expect(client.synthesize('hello', {
      voice: 'https://evil.example/steal',
      model: MODEL_ID,
    })).rejects.toMatchObject({ code: 'voice_unavailable' });
    await expect(client.synthesize('hello', {
      voice: VOICE_ID,
      model: '../../user',
    })).rejects.toMatchObject({ code: 'model_unavailable' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('sends only bounded final speech text and fixed fields', async () => {
    const userPrompt = 'private user prompt that must not leave the desktop';
    const bodies: Record<string, unknown>[] = [];
    const fetchImpl = vi.fn(async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return audioResponse();
    }) as unknown as typeof fetch;
    const client = createClient(fetchImpl);
    client.primeCatalog(mockCatalog());
    await client.synthesize('Exact final assistant sentence.', {
      voice: VOICE_ID,
      model: MODEL_ID,
    });
    expect(bodies).toEqual([{
      text: 'Exact final assistant sentence.',
      model_id: MODEL_ID,
      voice_settings: {
        stability: 0.5,
        similarity_boost: 0.75,
      },
    }]);
    expect(JSON.stringify(bodies)).not.toContain(userPrompt);
  });

  it('never retries synthesis POSTs', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, 503)) as unknown as typeof fetch;
    const client = createClient(fetchImpl);
    client.primeCatalog(mockCatalog());
    await expect(client.synthesize('once', {
      voice: VOICE_ID,
      model: MODEL_ID,
    })).rejects.toMatchObject({ code: 'server_error' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('retries bounded safe catalog GETs on transient server failures', async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      return calls === 1 ? jsonResponse({}, 503) : jsonResponse({ voices: [] });
    }) as unknown as typeof fetch;
    await expect(createClient(fetchImpl).listVoices()).resolves.toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe('ElevenLabsClient safe failure taxonomy', () => {
  const cases: Array<[number, string, Record<string, string> | undefined]> = [
    [401, 'invalid_key', undefined],
    [402, 'insufficient_quota', undefined],
    [403, 'no_entitlement', undefined],
    [404, 'voice_unavailable', undefined],
    [429, 'rate_limit', undefined],
    [429, 'insufficient_quota', { 'x-elevenlabs-error-code': 'quota_exceeded' }],
    [503, 'server_error', undefined],
  ];

  it.each(cases)('maps HTTP %s to %s without leaking the response', async (status, code, headers) => {
    const secretBody = `provider detail ${KEY}`;
    const fetchImpl = vi.fn(async () => jsonResponse(
      { detail: { message: secretBody } },
      status,
      headers,
    )) as unknown as typeof fetch;
    const client = createClient(fetchImpl);
    client.primeCatalog(mockCatalog());
    const error = await client.synthesize('hello', {
      voice: VOICE_ID,
      model: MODEL_ID,
    }).catch((caught: unknown) => caught) as ElevenLabsError;
    expect(error.code).toBe(code);
    expect(error.message).not.toContain(KEY);
    expect(error.message).not.toContain(secretBody);
  });

  it('distinguishes offline, timeout, and caller cancellation', async () => {
    const offline = createClient(vi.fn(async () => {
      throw new TypeError('network failed with secret response');
    }) as unknown as typeof fetch);
    await expect(offline.listVoices()).rejects.toMatchObject({ code: 'offline' });

    const hangingFetch = vi.fn((_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(
        Object.assign(new Error('aborted'), { name: 'AbortError' }),
      ));
    })) as unknown as typeof fetch;
    const timeout = createClient(hangingFetch, { timeoutMs: 5 });
    await expect(timeout.listVoices()).rejects.toMatchObject({ code: 'timeout' });

    const controller = new AbortController();
    const cancelled = createClient(hangingFetch, { timeoutMs: 5_000 });
    const pending = cancelled.listVoices(controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
  });
});

describe('ElevenLabsClient catalog, response, and cost bounds', () => {
  it('accepts only voices and TTS-capable models fetched from the verified catalog', async () => {
    const fetchImpl = vi.fn(async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === '/v1/user/subscription') {
        return jsonResponse({ character_count: 25, character_limit: 1_000 });
      }
      if (path === '/v1/voices') {
        return jsonResponse({ voices: [{
          voice_id: VOICE_ID,
          name: 'Voice',
          labels: { language: 'en' },
          preview_url: 'https://evil.example/audio.mp3',
        }] });
      }
      return jsonResponse([
        { model_id: MODEL_ID, name: 'Flash', can_do_text_to_speech: true, languages: [{ language_id: 'en' }] },
        { model_id: 'speech_to_text', name: 'STT', can_do_text_to_speech: false },
      ]);
    }) as unknown as typeof fetch;
    const result = await createClient(fetchImpl).verify();
    expect(result.catalog.voices).toEqual([{ id: VOICE_ID, name: 'Voice', language: 'en' }]);
    expect(result.catalog.models).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain('evil.example');
  });

  it('rejects malformed MIME and oversized response streams', async () => {
    const badMime = createClient(vi.fn(async () => new Response('not audio', {
      headers: { 'content-type': 'text/html' },
    })) as unknown as typeof fetch);
    badMime.primeCatalog(mockCatalog());
    await expect(badMime.synthesize('hello', {
      voice: VOICE_ID,
      model: MODEL_ID,
    })).rejects.toMatchObject({ code: 'malformed_audio' });

    const oversized = createClient(
      vi.fn(async () => audioResponse(new Uint8Array(1_001))) as unknown as typeof fetch,
      { maxAudioBytes: 1_000 },
    );
    oversized.primeCatalog(mockCatalog());
    await expect(oversized.synthesize('hello', {
      voice: VOICE_ID,
      model: MODEL_ID,
    })).rejects.toMatchObject({ code: 'audio_too_large' });
  });

  it('times out a stalled audio stream after response headers arrive', async () => {
    const stalled = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
      },
    });
    const client = createClient(
      vi.fn(async () => new Response(stalled, {
        headers: { 'content-type': 'audio/mpeg' },
      })) as unknown as typeof fetch,
      { timeoutMs: 5 },
    );
    client.primeCatalog(mockCatalog());
    await expect(client.synthesize('hello', {
      voice: VOICE_ID,
      model: MODEL_ID,
    })).rejects.toMatchObject({ code: 'timeout' });
  });

  it('bounds text, estimated duration, concurrency, rate, and daily characters', async () => {
    let release!: () => void;
    const firstResponse = new Promise<Response>((resolve) => {
      release = () => resolve(audioResponse());
    });
    const fetchImpl = vi.fn()
      .mockImplementationOnce(async () => firstResponse)
      .mockImplementation(async () => audioResponse()) as unknown as typeof fetch;
    const client = createClient(fetchImpl, {
      maxTextCharacters: 20,
      maxEstimatedDurationSeconds: 2,
      maxConcurrent: 1,
      maxRequestsPerMinute: 2,
      maxCharactersPerDay: 20,
    });
    client.primeCatalog(mockCatalog());
    const pending = client.synthesize('first', { voice: VOICE_ID, model: MODEL_ID });
    await Promise.resolve();
    await expect(client.synthesize('second', {
      voice: VOICE_ID,
      model: MODEL_ID,
    })).rejects.toMatchObject({ code: 'busy' });
    release();
    await pending;
    await client.synthesize('third', { voice: VOICE_ID, model: MODEL_ID });
    await expect(client.synthesize('fourth', {
      voice: VOICE_ID,
      model: MODEL_ID,
    })).rejects.toMatchObject({ code: 'rate_limit' });

    const textBound = createClient(fetchImpl, {
      maxTextCharacters: 5,
      maxEstimatedDurationSeconds: 1,
    });
    textBound.primeCatalog(mockCatalog());
    await expect(textBound.synthesize('too long', {
      voice: VOICE_ID,
      model: MODEL_ID,
    })).rejects.toMatchObject({ code: 'text_too_long' });
  });

  it('returns only safe synthesis metadata with a deterministic hash', async () => {
    const bytes = new Uint8Array(16_000);
    const client = createClient(vi.fn(async () => audioResponse(bytes)) as unknown as typeof fetch);
    client.primeCatalog(mockCatalog());
    const result = await client.synthesize('hello', { voice: VOICE_ID, model: MODEL_ID });
    expect(result.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(result.durationSeconds).toBe(1);
    expect(result.mimeType).toBe('audio/mpeg');
  });
});
