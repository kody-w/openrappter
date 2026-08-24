/**
 * Audio Transcription Providers
 * Supports OpenAI Whisper and local Whisper
 */

import type {
  TranscriptionProvider,
  TranscriptionOptions,
  TranscriptionResult,
} from './types.js';
import { randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { openrappterPath } from '../infra/openrappter-home.js';

const TRANSCRIPTION_TIMEOUT_MS = 10 * 60_000;
const TRANSCRIPTION_MAX_PROCESS_OUTPUT_BYTES = 256 * 1024;
const TRANSCRIPTION_MAX_JSON_BYTES = 8 * 1024 * 1024;

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
    const blob = new Blob([new Uint8Array(audio) as any], { type: this.detectMimeType(audio) });
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
    const work = this.privateWorkDirectory();
    const tempInput = path.join(work, `${randomUUID()}.wav`);
    writeFileSync(tempInput, audio, { mode: 0o600, flag: 'wx' });
    try {
      return await this.transcribeFile(tempInput, options);
    } finally {
      rmSync(tempInput, { force: true });
    }
  }

  async transcribeFile(
    inputPath: string,
    options?: TranscriptionOptions,
  ): Promise<TranscriptionResult> {
    const work = this.privateWorkDirectory();
    const outputPrefix = path.join(work, randomUUID());
    const outputFile = `${outputPrefix}.json`;
    const args = [inputPath, '-o', outputPrefix, '-of', 'json'];
    if (this.modelPath) args.push('-m', this.modelPath);
    if (options?.language) args.push('-l', options.language);
    try {
      await new Promise<void>((resolve, reject) => {
        const proc = spawn(this.execPath, args, {
          shell: false,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let outputBytes = 0;
        let settled = false;
        const finish = (error?: Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (error) reject(error);
          else resolve();
        };
        const count = (chunk: Buffer) => {
          outputBytes += chunk.length;
          if (outputBytes > TRANSCRIPTION_MAX_PROCESS_OUTPUT_BYTES) {
            proc.kill('SIGKILL');
            finish(new Error('Whisper process output exceeded its safety limit.'));
          }
        };
        proc.stdout.on('data', count);
        proc.stderr.on('data', count);
        proc.once('error', (error) => finish(error));
        proc.once('close', (code) => {
          finish(code === 0 ? undefined : new Error(`Whisper exited with code ${code}`));
        });
        const timer = setTimeout(() => {
          proc.kill('SIGKILL');
          finish(new Error(`Whisper exceeded ${TRANSCRIPTION_TIMEOUT_MS} ms.`));
        }, TRANSCRIPTION_TIMEOUT_MS);
      });
      if (!existsSync(outputFile)) throw new Error('Whisper output not found');
      const outputStats = statSync(outputFile);
      if (!outputStats.isFile() || outputStats.size > TRANSCRIPTION_MAX_JSON_BYTES) {
        throw new Error('Whisper output exceeded its JSON safety limit.');
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
      return { text: output.text, segments: output.segments };
    } finally {
      rmSync(outputFile, { force: true });
    }
  }

  async isAvailable(): Promise<boolean> {
    try {
      execFileSync(this.execPath, ['--help'], {
        stdio: 'ignore',
        timeout: 5_000,
        windowsHide: true,
      });
      return true;
    } catch {
      return false;
    }
  }

  private privateWorkDirectory(): string {
    const work = openrappterPath('media', 'transcription-work');
    mkdirSync(work, { recursive: true, mode: 0o700 });
    chmodSync(work, 0o700);
    return work;
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

  async transcribeFile(
    inputPath: string,
    options?: TranscriptionOptions,
  ): Promise<TranscriptionResult> {
    for (const provider of this.providers) {
      const fileProvider = provider as TranscriptionProvider & {
        transcribeFile?: (
          path: string,
          options?: TranscriptionOptions,
        ) => Promise<TranscriptionResult>;
      };
      if (!fileProvider.transcribeFile) continue;
      try {
        if (await provider.isAvailable()) {
          return await fileProvider.transcribeFile(inputPath, options);
        }
      } catch (error) {
        console.warn(`Transcription provider ${provider.name} failed:`, error);
      }
    }
    throw new Error('No local path-capable transcription provider available');
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
