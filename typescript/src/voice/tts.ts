/**
 * One provider abstraction for local and optional remote speech.
 *
 * Credentials are deliberately not accepted as strings by the ElevenLabs
 * provider. Its callback is implemented by the privileged desktop process and
 * resolves from OS-backed encrypted storage for each request.
 */

import type {
  TTSOptions,
  TTSProvider,
  Voice,
  VoiceModel,
} from './types.js';
import {
  ElevenLabsClient,
  type ElevenLabsClientOptions,
  type ElevenLabsVerification,
} from './elevenlabs.js';

export class ElevenLabsTTS implements TTSProvider {
  readonly name = 'elevenlabs';
  readonly client: ElevenLabsClient;
  private verification: ElevenLabsVerification | null = null;

  constructor(options: ElevenLabsClientOptions) {
    this.client = new ElevenLabsClient(options);
  }

  async verify(signal?: AbortSignal): Promise<ElevenLabsVerification> {
    this.verification = await this.client.verify(signal);
    return this.verification;
  }

  async synthesize(text: string, options: TTSOptions = {}): Promise<Buffer> {
    if (!this.verification) await this.verify(options.signal);
    const voice = options.voice ?? this.verification!.catalog.voices[0]?.id;
    const model = options.model ?? this.verification!.catalog.models[0]?.id;
    if (!voice || !model) throw new Error('No verified ElevenLabs voice and model are available.');
    const result = await this.client.synthesize(text, {
      voice,
      model,
      signal: options.signal,
    });
    return result.audio;
  }

  async getVoices(): Promise<Voice[]> {
    if (!this.verification) await this.verify();
    return this.verification!.catalog.voices.map((voice) => ({
      id: voice.id,
      name: voice.name,
      language: voice.language,
    }));
  }

  async getModels(): Promise<VoiceModel[]> {
    if (!this.verification) await this.verify();
    return this.verification!.catalog.models.map((model) => ({
      id: model.id,
      name: model.name,
      languages: [...model.languages],
    }));
  }

  async isAvailable(): Promise<boolean> {
    try {
      await this.verify();
      return true;
    } catch {
      return false;
    }
  }
}

export class OpenAITTS implements TTSProvider {
  readonly name = 'openai';
  private readonly apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async synthesize(text: string, options: TTSOptions = {}): Promise<Buffer> {
    const response = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      signal: options.signal,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'tts-1',
        input: text,
        voice: options.voice ?? 'alloy',
        speed: options.speed ?? 1,
        response_format: options.format ?? 'mp3',
      }),
    });
    if (!response.ok) throw new Error('OpenAI speech synthesis failed.');
    return Buffer.from(await response.arrayBuffer());
  }

  async getVoices(): Promise<Voice[]> {
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
    return this.apiKey.length >= 20;
  }
}

/**
 * Existing free fallback. Desktop Voice mode uses VibeVoice for its `local`
 * provider; this provider remains for the agent/CLI service.
 */
export class EdgeTTS implements TTSProvider {
  readonly name = 'edge';

  async synthesize(text: string, options: TTSOptions = {}): Promise<Buffer> {
    const { EdgeTTS: EdgeTTSLib } = await import('node-edge-tts');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { readFileSync, unlink } = await import('node:fs');
    const file = join(tmpdir(), `openrappter-tts-${Date.now()}.mp3`);
    try {
      const tts = new EdgeTTSLib({
        voice: options.voice ?? 'en-US-MichelleNeural',
        timeout: 30_000,
      });
      await tts.ttsPromise(text, file);
      return readFileSync(file);
    } finally {
      unlink(file, () => {});
    }
  }

  async getVoices(): Promise<Voice[]> {
    return [
      { id: 'en-US-MichelleNeural', name: 'Michelle', language: 'en-US', gender: 'female' },
      { id: 'en-US-AriaNeural', name: 'Aria', language: 'en-US', gender: 'female' },
      { id: 'en-US-GuyNeural', name: 'Guy', language: 'en-US', gender: 'male' },
      { id: 'en-US-JennyNeural', name: 'Jenny', language: 'en-US', gender: 'female' },
      { id: 'en-GB-SoniaNeural', name: 'Sonia', language: 'en-GB', gender: 'female' },
      { id: 'en-GB-RyanNeural', name: 'Ryan', language: 'en-GB', gender: 'male' },
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

export class TTSService {
  private readonly providers = new Map<string, TTSProvider>();
  private defaultProvider?: string;
  private defaultVoice?: string;
  private defaultModel?: string;

  addProvider(provider: TTSProvider): void {
    this.providers.set(provider.name, provider);
  }

  removeProvider(name: string): boolean {
    return this.providers.delete(name);
  }

  selectProvider(name: string): void {
    if (!this.providers.has(name)) throw new Error(`Unknown TTS provider: ${name}`);
    this.defaultProvider = name;
  }

  setDefaultVoice(voice: string, model?: string): void {
    this.defaultVoice = voice;
    this.defaultModel = model;
  }

  async synthesize(text: string, options: TTSOptions = {}): Promise<Buffer> {
    const ordered = [...this.providers.values()];
    const requested = options.provider ?? this.defaultProvider;
    if (requested) {
      ordered.sort((left, right) =>
        Number(right.name === requested) - Number(left.name === requested));
    }
    const failures: Error[] = [];
    for (const provider of ordered) {
      if (requested && options.fallback === false && provider.name !== requested) continue;
      try {
        if (!await provider.isAvailable()) continue;
        return await provider.synthesize(text, {
          ...options,
          voice: options.voice ?? this.defaultVoice,
          model: options.model ?? this.defaultModel,
        });
      } catch (error) {
        failures.push(error as Error);
      }
    }
    throw failures[0] ?? new Error('No TTS provider is available.');
  }

  async getVoices(): Promise<Array<Voice & { provider: string }>> {
    const result: Array<Voice & { provider: string }> = [];
    for (const provider of this.providers.values()) {
      try {
        if (!await provider.isAvailable()) continue;
        const voices = await provider.getVoices();
        result.push(...voices.map((voice) => ({ ...voice, provider: provider.name })));
      } catch {
        // An optional provider cannot make local voice discovery fail.
      }
    }
    return result;
  }
}

export function createTTSService(config: {
  elevenlabs?: ElevenLabsClientOptions;
  openaiKey?: string;
  useEdge?: boolean;
} = {}): TTSService {
  const service = new TTSService();
  if (config.elevenlabs) service.addProvider(new ElevenLabsTTS(config.elevenlabs));
  if (config.openaiKey) service.addProvider(new OpenAITTS(config.openaiKey));
  if (config.useEdge !== false) service.addProvider(new EdgeTTS());
  return service;
}
