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
 * Edge TTS Provider (Free, using Microsoft Edge's TTS API)
 */
export class EdgeTTS implements TTSProvider {
  name = 'edge';
  private voices: Voice[] = [];

  async synthesize(text: string, options?: TTSOptions): Promise<Buffer> {
    // Edge TTS uses a WebSocket-based API
    // This is a simplified implementation using the edge-tts npm package pattern
    const voice = options?.voice ?? 'en-US-AriaNeural';
    const rate = options?.speed ? `${Math.round((options.speed - 1) * 100)}%` : '+0%';
    const pitch = options?.pitch ? `${Math.round((options.pitch - 1) * 50)}Hz` : '+0Hz';

    const websocketUrl = 'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1';
    const connectionId = this.generateUUID();

    return new Promise((resolve, reject) => {
      import('ws').then(({ default: WebSocket }) => {
        const ws = new WebSocket(
          `${websocketUrl}?TrustedClientToken=6A5AA1D4EAFF4E9FB37E23D68491D6F4&ConnectionId=${connectionId}`,
          {
            headers: {
              'User-Agent':
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
              Origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
            },
          }
        );

        const audioChunks: Buffer[] = [];

        ws.on('open', () => {
          // Send config message
          ws.send(
            `Content-Type:application/json; charset=utf-8\r\n` +
              `Path:speech.config\r\n\r\n` +
              JSON.stringify({
                context: {
                  synthesis: {
                    audio: {
                      metadataoptions: { sentenceBoundaryEnabled: false, wordBoundaryEnabled: false },
                      outputFormat: 'audio-24khz-48kbitrate-mono-mp3',
                    },
                  },
                },
              })
          );

          // Send SSML message
          const ssml =
            `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>` +
            `<voice name='${voice}'><prosody rate='${rate}' pitch='${pitch}'>${this.escapeXml(text)}</prosody></voice>` +
            `</speak>`;

          ws.send(
            `X-RequestId:${connectionId}\r\n` +
              `Content-Type:application/ssml+xml\r\n` +
              `Path:ssml\r\n\r\n` +
              ssml
          );
        });

        ws.on('message', (data: Buffer) => {
          const message = data.toString();
          if (message.includes('Path:audio')) {
            // Extract audio data after the headers
            const audioStart = data.indexOf(Buffer.from('Path:audio')) + 12;
            const headerEnd = data.indexOf(Buffer.from('\r\n\r\n'), audioStart);
            if (headerEnd !== -1) {
              audioChunks.push(data.slice(headerEnd + 4));
            }
          } else if (message.includes('Path:turn.end')) {
            ws.close();
            resolve(Buffer.concat(audioChunks));
          }
        });

        ws.on('error', reject);
        ws.on('close', () => {
          if (audioChunks.length === 0) {
            reject(new Error('No audio data received'));
          }
        });
      });
    });
  }

  async getVoices(): Promise<Voice[]> {
    if (this.voices.length > 0) {
      return this.voices;
    }

    try {
      const response = await fetch(
        'https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list?trustedclienttoken=6A5AA1D4EAFF4E9FB37E23D68491D6F4'
      );

      if (!response.ok) {
        throw new Error('Failed to fetch voices');
      }

      const data = (await response.json()) as Array<{
        ShortName: string;
        FriendlyName: string;
        Locale: string;
        Gender: string;
      }>;

      this.voices = data.map((v) => ({
        id: v.ShortName,
        name: v.FriendlyName,
        language: v.Locale,
        gender: v.Gender.toLowerCase() as Voice['gender'],
      }));

      return this.voices;
    } catch {
      // Return default voices
      return [
        { id: 'en-US-AriaNeural', name: 'Aria', language: 'en-US', gender: 'female' },
        { id: 'en-US-GuyNeural', name: 'Guy', language: 'en-US', gender: 'male' },
        { id: 'en-GB-SoniaNeural', name: 'Sonia', language: 'en-GB', gender: 'female' },
      ];
    }
  }

  async isAvailable(): Promise<boolean> {
    return true; // Edge TTS is always available
  }

  private generateUUID(): string {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  private escapeXml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
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
