/**
 * Audio Transcription Providers
 * Supports OpenAI Whisper and local Whisper
 */

import type {
  TranscriptionProvider,
  TranscriptionOptions,
  TranscriptionResult,
  TranscriptionSegment,
} from './types.js';

/**
 * OpenAI Whisper Transcription Provider
 */
export class OpenAIWhisper implements TranscriptionProvider {
  name = 'openai-whisper';
  private apiKey: string;
  private baseUrl = 'https://api.openai.com/v1';

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async transcribe(audio: Buffer, options?: TranscriptionOptions): Promise<TranscriptionResult> {
    const formData = new FormData();

    // Create blob from buffer
    const blob = new Blob([audio], { type: this.detectMimeType(audio) });
    formData.append('file', blob, 'audio.mp3');
    formData.append('model', 'whisper-1');

    if (options?.language) {
      formData.append('language', options.language);
    }

    if (options?.prompt) {
      formData.append('prompt', options.prompt);
    }

    const responseFormat = options?.timestamps ? 'verbose_json' : (options?.format ?? 'json');
    formData.append('response_format', responseFormat);

    const response = await fetch(`${this.baseUrl}/audio/transcriptions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: formData,
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenAI Whisper error: ${error}`);
    }

    if (responseFormat === 'verbose_json') {
      const data = (await response.json()) as {
        text: string;
        language: string;
        duration: number;
        segments: Array<{
          id: number;
          start: number;
          end: number;
          text: string;
        }>;
      };

      return {
        text: data.text,
        language: data.language,
        duration: data.duration,
        segments: data.segments.map((s) => ({
          id: s.id,
          start: s.start,
          end: s.end,
          text: s.text,
        })),
      };
    }

    if (options?.format === 'text' || options?.format === 'srt' || options?.format === 'vtt') {
      return { text: await response.text() };
    }

    const data = (await response.json()) as { text: string };
    return { text: data.text };
  }

  async isAvailable(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/models/whisper-1`, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  private detectMimeType(buffer: Buffer): string {
    // Check magic bytes
    if (buffer[0] === 0xff && buffer[1] === 0xfb) return 'audio/mpeg';
    if (buffer[0] === 0x49 && buffer[1] === 0x44 && buffer[2] === 0x33) return 'audio/mpeg'; // ID3
    if (buffer.toString('utf8', 0, 4) === 'RIFF') return 'audio/wav';
    if (buffer.toString('utf8', 0, 4) === 'OggS') return 'audio/ogg';
    if (buffer.toString('utf8', 0, 4) === 'fLaC') return 'audio/flac';
    return 'audio/mpeg'; // Default
  }
}

/**
 * Local Whisper Transcription Provider
 * Uses whisper.cpp or similar local implementation
 */
export class LocalWhisper implements TranscriptionProvider {
  name = 'local-whisper';
  private modelPath?: string;
  private execPath: string;

  constructor(config?: { modelPath?: string; execPath?: string }) {
    this.modelPath = config?.modelPath;
    this.execPath = config?.execPath ?? 'whisper';
  }

  async transcribe(audio: Buffer, options?: TranscriptionOptions): Promise<TranscriptionResult> {
    const { spawn } = await import('child_process');
    const { writeFileSync, unlinkSync, readFileSync, existsSync } = await import('fs');
    const { tmpdir } = await import('os');
    const { join } = await import('path');

    // Write audio to temp file
    const tempInput = join(tmpdir(), `whisper_input_${Date.now()}.wav`);
    const tempOutput = join(tmpdir(), `whisper_output_${Date.now()}`);

    writeFileSync(tempInput, audio);

    try {
      const args = [tempInput, '-o', tempOutput, '-of', 'json'];

      if (this.modelPath) {
        args.push('-m', this.modelPath);
      }

      if (options?.language) {
        args.push('-l', options.language);
      }

      await new Promise<void>((resolve, reject) => {
        const proc = spawn(this.execPath, args);

        proc.on('close', (code) => {
          if (code === 0) resolve();
          else reject(new Error(`Whisper exited with code ${code}`));
        });

        proc.on('error', reject);
      });

      // Read output
      const outputFile = `${tempOutput}.json`;
      if (!existsSync(outputFile)) {
        throw new Error('Whisper output not found');
      }

      const output = JSON.parse(readFileSync(outputFile, 'utf8')) as {
        text: string;
        segments: Array<{
          id: number;
          start: number;
          end: number;
          text: string;
        }>;
      };

      // Cleanup
      unlinkSync(outputFile);

      return {
        text: output.text,
        segments: output.segments,
      };
    } finally {
      // Cleanup input file
      if (existsSync(tempInput)) {
        unlinkSync(tempInput);
      }
    }
  }

  async isAvailable(): Promise<boolean> {
    try {
      const { execSync } = await import('child_process');
      execSync(`${this.execPath} --help`, { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Transcription Service with fallback chain
 */
export class TranscriptionService {
  private providers: TranscriptionProvider[] = [];

  addProvider(provider: TranscriptionProvider): void {
    this.providers.push(provider);
  }

  async transcribe(audio: Buffer, options?: TranscriptionOptions): Promise<TranscriptionResult> {
    for (const provider of this.providers) {
      try {
        if (await provider.isAvailable()) {
          return await provider.transcribe(audio, options);
        }
      } catch (error) {
        console.warn(`Transcription provider ${provider.name} failed:`, error);
      }
    }

    throw new Error('No transcription provider available');
  }

  async isAvailable(): Promise<boolean> {
    for (const provider of this.providers) {
      if (await provider.isAvailable()) {
        return true;
      }
    }
    return false;
  }
}

export function createTranscriptionService(config?: {
  openaiKey?: string;
  localWhisperPath?: string;
}): TranscriptionService {
  const service = new TranscriptionService();

  if (config?.openaiKey) {
    service.addProvider(new OpenAIWhisper(config.openaiKey));
  }

  if (config?.localWhisperPath) {
    service.addProvider(new LocalWhisper({ execPath: config.localWhisperPath }));
  } else {
    // Try local whisper as fallback
    service.addProvider(new LocalWhisper());
  }

  return service;
}
