/**
 * Text-to-Speech Providers
 * Supports ElevenLabs, OpenAI TTS, and Edge TTS
 */

import type { TTSProvider, TTSOptions, Voice } from './types.js';

/**
 * ElevenLabs TTS Provider
 */
export class ElevenLabsTTS implements TTSProvider {
  name = 'elevenlabs';
  private apiKey: string;
  private baseUrl = 'https://api.elevenlabs.io/v1';

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async synthesize(text: string, options?: TTSOptions): Promise<Buffer> {
    const voiceId = options?.voice ?? 'EXAVITQu4vr4xnSDxMaL'; // Default: Rachel

    const response = await fetch(`${this.baseUrl}/text-to-speech/${voiceId}`, {
      method: 'POST',
      headers: {
        'xi-api-key': this.apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text,
        model_id: 'eleven_monolingual_v1',
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75,
        },
      }),
    });

    if (!response.ok) {
      throw new Error(`ElevenLabs TTS error: ${response.statusText}`);
    }

    return Buffer.from(await response.arrayBuffer());
  }

  async getVoices(): Promise<Voice[]> {
    const response = await fetch(`${this.baseUrl}/voices`, {
      headers: {
        'xi-api-key': this.apiKey,
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch voices: ${response.statusText}`);
    }

    const data = (await response.json()) as {
      voices: Array<{
        voice_id: string;
        name: string;
        labels?: { language?: string; gender?: string };
        preview_url?: string;
      }>;
    };

    return data.voices.map((v) => ({
      id: v.voice_id,
      name: v.name,
      language: v.labels?.language ?? 'en',
      gender: (v.labels?.gender as Voice['gender']) ?? 'neutral',
      preview: v.preview_url,
    }));
  }

  async isAvailable(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/user`, {
        headers: { 'xi-api-key': this.apiKey },
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}

/**
 * OpenAI TTS Provider
 */
export class OpenAITTS implements TTSProvider {
  name = 'openai';
  private apiKey: string;
  private baseUrl = 'https://api.openai.com/v1';

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async synthesize(text: string, options?: TTSOptions): Promise<Buffer> {
    const voice = options?.voice ?? 'alloy';
    const speed = options?.speed ?? 1.0;
    const format = options?.format ?? 'mp3';

    const response = await fetch(`${this.baseUrl}/audio/speech`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'tts-1',
        input: text,
        voice,
        speed,
        response_format: format,
      }),
    });

    if (!response.ok) {
      throw new Error(`OpenAI TTS error: ${response.statusText}`);
    }

    return Buffer.from(await response.arrayBuffer());
  }

  async getVoices(): Promise<Voice[]> {
    // OpenAI has fixed voices
    return [
      { id: 'alloy', name: 'Alloy', language: 'en', gender: 'neutral' },
      { id: 'echo', name: 'Echo', language: 'en', gender: 'male' },
      { id: 'fable', name: 'Fable', language: 'en', gender: 'neutral' },
      { id: 'onyx', name: 'Onyx', language: 'en', gender: 'male' },
      { id: 'nova', name: 'Nova', language: 'en', gender: 'female' },
      { id: 'shimmer', name: 'Shimmer', language: 'en', gender: 'female' },
    ];
  }

  async isAvailable(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/models`, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}

/**
 * Edge TTS Provider (Free, using node-edge-tts library)
 */
export class EdgeTTS implements TTSProvider {
  name = 'edge';

  async synthesize(text: string, options?: TTSOptions): Promise<Buffer> {
    const { EdgeTTS: EdgeTTSLib } = await import('node-edge-tts');
    const voice = options?.voice ?? 'en-US-MichelleNeural';

    const os = await import('os');
    const path = await import('path');
    const fs = await import('fs');
    const tmpFile = path.join(os.tmpdir(), `openrappter-tts-${Date.now()}.mp3`);

    try {
      const tts = new EdgeTTSLib({ voice, timeout: 30000 });
      await tts.ttsPromise(text, tmpFile);
      const buffer = fs.readFileSync(tmpFile);
      return buffer;
    } finally {
      // Clean up temp file
      const fs2 = await import('fs');
      fs2.unlink(tmpFile, () => {});
    }
  }

  async getVoices(): Promise<Voice[]> {
    // node-edge-tts handles token management; return well-known voices
    return [
      { id: 'en-US-MichelleNeural', name: 'Michelle', language: 'en-US', gender: 'female' },
      { id: 'en-US-AriaNeural', name: 'Aria', language: 'en-US', gender: 'female' },
      { id: 'en-US-GuyNeural', name: 'Guy', language: 'en-US', gender: 'male' },
      { id: 'en-US-JennyNeural', name: 'Jenny', language: 'en-US', gender: 'female' },
      { id: 'en-GB-SoniaNeural', name: 'Sonia', language: 'en-GB', gender: 'female' },
      { id: 'en-GB-RyanNeural', name: 'Ryan', language: 'en-GB', gender: 'male' },
      { id: 'en-AU-NatashaNeural', name: 'Natasha', language: 'en-AU', gender: 'female' },
    ];
  }

  async isAvailable(): Promise<boolean> {
    try {
      await import('node-edge-tts');
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * TTS Service with fallback chain
 */
export class TTSService {
  private providers: TTSProvider[] = [];
  private defaultVoice?: string;

  addProvider(provider: TTSProvider): void {
    this.providers.push(provider);
  }

  setDefaultVoice(voice: string): void {
    this.defaultVoice = voice;
  }

  async synthesize(text: string, options?: TTSOptions): Promise<Buffer> {
    const opts = { ...options };
    if (!opts.voice && this.defaultVoice) {
      opts.voice = this.defaultVoice;
    }

    for (const provider of this.providers) {
      try {
        if (await provider.isAvailable()) {
          return await provider.synthesize(text, opts);
        }
      } catch (error) {
        console.warn(`TTS provider ${provider.name} failed:`, error);
      }
    }

    throw new Error('No TTS provider available');
  }

  async getVoices(): Promise<Array<Voice & { provider: string }>> {
    const allVoices: Array<Voice & { provider: string }> = [];

    for (const provider of this.providers) {
      try {
        if (await provider.isAvailable()) {
          const voices = await provider.getVoices();
          allVoices.push(...voices.map((v) => ({ ...v, provider: provider.name })));
        }
      } catch {
        // Skip provider
      }
    }

    return allVoices;
  }
}

export function createTTSService(config?: {
  elevenlabsKey?: string;
  openaiKey?: string;
  useEdge?: boolean;
}): TTSService {
  const service = new TTSService();

  if (config?.elevenlabsKey) {
    service.addProvider(new ElevenLabsTTS(config.elevenlabsKey));
  }

  if (config?.openaiKey) {
    service.addProvider(new OpenAITTS(config.openaiKey));
  }

  if (config?.useEdge !== false) {
    service.addProvider(new EdgeTTS());
  }

  return service;
}
