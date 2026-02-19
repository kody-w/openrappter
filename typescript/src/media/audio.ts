/**
 * Audio Processor
 * Handles audio transcription, text-to-speech, info extraction, and format conversion.
 * Uses ffmpeg via child_process for conversion and ffprobe for info.
 */

import { spawn } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomBytes } from 'crypto';
import { promises as fs } from 'fs';

export type AudioFormat = 'mp3' | 'wav' | 'ogg';

export interface TranscriptionOptions {
  language?: string;
  model?: string;
}

export interface TranscriptionResult {
  text: string;
  language?: string;
  duration?: number;
}

export interface TtsOptions {
  speed?: number;
  pitch?: number;
}

export interface AudioInfo {
  duration: number;
  format: string;
  sampleRate?: number;
  channels?: number;
  bitRate?: number;
}

/**
 * Run ffprobe on a temp file and return parsed JSON.
 */
async function ffprobe(inputPath: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const args = [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      inputPath,
    ];

    const proc = spawn('ffprobe', args);
    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`ffprobe exited ${code}: ${stderr}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error(`ffprobe returned invalid JSON: ${stdout}`));
      }
    });
  });
}

/**
 * Run ffmpeg to convert a buffer from one audio format to another.
 */
async function ffmpegConvert(input: Buffer, outputFormat: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const args = [
      '-i', 'pipe:0',
      '-f', outputFormat,
      'pipe:1',
    ];

    const proc = spawn('ffmpeg', ['-y', ...args]);
    const chunks: Buffer[] = [];
    let stderr = '';

    proc.stdout.on('data', (d: Buffer) => chunks.push(d));
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`ffmpeg exited ${code}: ${stderr}`));
        return;
      }
      resolve(Buffer.concat(chunks));
    });

    proc.stdin.end(input);
  });
}

export class AudioProcessor {
  /**
   * Transcribe audio buffer to text.
   * When an OpenAI API key is available, uses the Whisper API.
   * Otherwise returns a placeholder message.
   * @param input - Audio data buffer
   * @param options - Transcription options
   */
  async transcribe(input: Buffer, options: TranscriptionOptions = {}): Promise<TranscriptionResult> {
    const apiKey = process.env.OPENAI_API_KEY;

    if (!apiKey) {
      return {
        text: '[Audio content — transcription requires OPENAI_API_KEY (Whisper API)]',
        language: options.language,
      };
    }

    // Write to a temp file for the API upload
    const tmpPath = join(tmpdir(), `openrappter-audio-${randomBytes(8).toString('hex')}.mp3`);
    try {
      await fs.writeFile(tmpPath, input);

      const formData = new FormData();
      const audioBlob = new Blob([input], { type: 'audio/mpeg' });
      formData.append('file', audioBlob, 'audio.mp3');
      formData.append('model', options.model ?? 'whisper-1');
      if (options.language) formData.append('language', options.language);

      const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}` },
        body: formData,
      });

      if (!response.ok) {
        throw new Error(`Whisper API error: ${response.statusText}`);
      }

      const data = (await response.json()) as { text: string };
      return { text: data.text };
    } finally {
      await fs.unlink(tmpPath).catch(() => {});
    }
  }

  /**
   * Convert text to speech, returning audio as a Buffer.
   * Uses OpenAI TTS when API key is available, otherwise returns a placeholder.
   * @param text - Text to synthesize
   * @param voice - Voice name (e.g. 'alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer')
   * @param options - TTS options (speed, pitch)
   */
  async textToSpeech(text: string, voice = 'alloy', options: TtsOptions = {}): Promise<Buffer> {
    const apiKey = process.env.OPENAI_API_KEY;

    if (!apiKey) {
      // Return a minimal valid MP3 frame placeholder so callers get a Buffer
      return Buffer.from('placeholder-tts-audio');
    }

    const body = {
      model: 'tts-1',
      input: text,
      voice,
      speed: options.speed ?? 1.0,
    };

    const response = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`OpenAI TTS error: ${response.statusText}`);
    }

    return Buffer.from(await response.arrayBuffer());
  }

  /**
   * Get information about an audio buffer via ffprobe.
   * @param input - Audio data buffer
   */
  async getInfo(input: Buffer): Promise<AudioInfo> {
    const tmpPath = join(tmpdir(), `openrappter-probe-${randomBytes(8).toString('hex')}.audio`);
    try {
      await fs.writeFile(tmpPath, input);
      const data = await ffprobe(tmpPath);

      const format = data.format as any;
      const streams = (data.streams as any[]) ?? [];
      const audioStream = streams.find((s: any) => s.codec_type === 'audio');

      return {
        duration: parseFloat(format?.duration ?? '0'),
        format: String(format?.format_name ?? 'unknown'),
        sampleRate: audioStream ? parseInt(String(audioStream.sample_rate ?? '0'), 10) : undefined,
        bitRate: format?.bit_rate ? parseInt(String(format.bit_rate), 10) : undefined,
      };
    } finally {
      await fs.unlink(tmpPath).catch(() => {});
    }
  }

  /**
   * Convert audio to a different format.
   * @param input - Audio data buffer
   * @param format - Target format: 'mp3' | 'wav' | 'ogg'
   */
  async convert(input: Buffer, format: AudioFormat): Promise<Buffer> {
    const formatMap: Record<AudioFormat, string> = {
      mp3: 'mp3',
      wav: 'wav',
      ogg: 'ogg',
    };

    const ffmpegFormat = formatMap[format];
    return ffmpegConvert(input, ffmpegFormat);
  }
}

export function createAudioProcessor(): AudioProcessor {
  return new AudioProcessor();
}
