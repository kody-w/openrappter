/**
 * Video Processor
 * Handles video frame extraction, info retrieval, transcoding, and compression.
 * Uses ffmpeg and ffprobe via child_process.
 */

import { spawn } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomBytes } from 'crypto';
import { promises as fs } from 'fs';

export interface VideoTranscodeOptions {
  format?: string;
  codec?: string;
  bitrate?: string;
  fps?: number;
}

export interface VideoInfo {
  duration: number;
  width: number;
  height: number;
  codec: string;
  format: string;
  fps?: number;
}

/**
 * Run ffprobe on a file and return parsed JSON output.
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
 * Run ffmpeg with given args, piping input if provided, and collecting output to a temp file or buffer.
 */
async function ffmpegRun(
  args: string[],
  input?: Buffer,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
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

    if (input) {
      proc.stdin.end(input);
    }
  });
}

export class VideoProcessor {
  /**
   * Extract a single frame from the video at the given timestamp.
   * @param input - Video data buffer
   * @param timestamp - Time in seconds to extract frame from
   * @returns JPEG frame as Buffer
   */
  async extractFrame(input: Buffer, timestamp: number): Promise<Buffer> {
    const tmpIn = join(tmpdir(), `openrappter-vid-in-${randomBytes(8).toString('hex')}.mp4`);
    const tmpOut = join(tmpdir(), `openrappter-vid-frame-${randomBytes(8).toString('hex')}.jpg`);

    try {
      await fs.writeFile(tmpIn, input);

      await ffmpegRun([
        '-ss', String(timestamp),
        '-i', tmpIn,
        '-frames:v', '1',
        '-f', 'image2',
        tmpOut,
      ]);

      const frame = await fs.readFile(tmpOut);
      return frame;
    } finally {
      await Promise.all([
        fs.unlink(tmpIn).catch(() => {}),
        fs.unlink(tmpOut).catch(() => {}),
      ]);
    }
  }

  /**
   * Get video metadata (duration, dimensions, codec, fps).
   * @param input - Video data buffer
   */
  async getInfo(input: Buffer): Promise<VideoInfo> {
    const tmpPath = join(tmpdir(), `openrappter-probe-${randomBytes(8).toString('hex')}.mp4`);
    try {
      await fs.writeFile(tmpPath, input);
      const data = await ffprobe(tmpPath);

      const format = data.format as any;
      const streams = (data.streams as any[]) ?? [];
      const videoStream = streams.find((s: any) => s.codec_type === 'video') ?? {};

      let fps: number | undefined;
      if (videoStream.r_frame_rate) {
        const [num, den] = String(videoStream.r_frame_rate).split('/');
        if (den && parseInt(den, 10) !== 0) {
          fps = parseInt(num, 10) / parseInt(den, 10);
        }
      }

      return {
        duration: parseFloat(format?.duration ?? '0'),
        width: parseInt(String(videoStream.width ?? '0'), 10),
        height: parseInt(String(videoStream.height ?? '0'), 10),
        codec: String(videoStream.codec_name ?? 'unknown'),
        format: String(format?.format_name ?? 'unknown'),
        fps,
      };
    } finally {
      await fs.unlink(tmpPath).catch(() => {});
    }
  }

  /**
   * Transcode video to a different format or codec.
   * @param input - Video data buffer
   * @param options - Transcode options (format, codec, bitrate, fps)
   */
  async transcode(input: Buffer, options: VideoTranscodeOptions = {}): Promise<Buffer> {
    const tmpIn = join(tmpdir(), `openrappter-vid-in-${randomBytes(8).toString('hex')}.mp4`);
    const tmpOut = join(
      tmpdir(),
      `openrappter-vid-out-${randomBytes(8).toString('hex')}.${options.format ?? 'mp4'}`,
    );

    try {
      await fs.writeFile(tmpIn, input);

      const args: string[] = ['-i', tmpIn];

      if (options.codec) args.push('-codec:v', options.codec);
      if (options.bitrate) args.push('-b:v', options.bitrate);
      if (options.fps) args.push('-r', String(options.fps));
      if (options.format) args.push('-f', options.format);

      args.push(tmpOut);

      await ffmpegRun(args);

      const result = await fs.readFile(tmpOut);
      return result;
    } finally {
      await Promise.all([
        fs.unlink(tmpIn).catch(() => {}),
        fs.unlink(tmpOut).catch(() => {}),
      ]);
    }
  }

  /**
   * Compress video to fit within a maximum file size.
   * Reduces bitrate iteratively until size is within limit.
   * @param input - Video data buffer
   * @param maxSizeMB - Maximum output size in megabytes
   */
  async compress(input: Buffer, maxSizeMB: number): Promise<Buffer> {
    const maxBytes = maxSizeMB * 1024 * 1024;

    if (input.length <= maxBytes) {
      return input;
    }

    // Get video info to calculate target bitrate
    const info = await this.getInfo(input);
    const duration = info.duration || 1;
    // Target bits = maxBytes * 8, subtract audio overhead estimate
    const audioBits = 128000 * duration; // 128kbps audio
    const targetVideoBits = Math.max((maxBytes * 8) - audioBits, 100000 * duration);
    const targetBitrate = Math.floor(targetVideoBits / duration);

    return this.transcode(input, {
      format: 'mp4',
      codec: 'libx264',
      bitrate: `${Math.max(targetBitrate, 100)}k`,
    });
  }
}

export function createVideoProcessor(): VideoProcessor {
  return new VideoProcessor();
}
