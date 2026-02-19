/**
 * Media module exports
 */

export * from './processor.js';
export * from './image.js';
export * from './audio.js';
export * from './video.js';
export * from './files.js';

/**
 * Unified Media Manager
 * Provides a single entry point for all media operations.
 */

import { ImageProcessor } from './image.js';
import { AudioProcessor } from './audio.js';
import { VideoProcessor } from './video.js';
import { FileManager } from './files.js';

export interface ImageProcessOptions {
  format?: 'jpeg' | 'webp' | 'png';
  quality?: number;
  maxSizeKB?: number;
  width?: number;
  height?: number;
  fit?: 'cover' | 'contain' | 'fill' | 'inside' | 'outside';
  stripExif?: boolean;
}

export interface AudioProcessOptions {
  format?: 'mp3' | 'wav' | 'ogg';
  transcribe?: boolean;
  language?: string;
}

export interface VideoProcessOptions {
  format?: string;
  codec?: string;
  maxSizeMB?: number;
  extractFrameAt?: number;
}

export type MediaType = 'image' | 'audio' | 'video' | 'document' | 'unknown';

const IMAGE_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.tiff', '.tif', '.avif',
]);
const AUDIO_EXTENSIONS = new Set([
  '.mp3', '.wav', '.ogg', '.flac', '.aac', '.m4a', '.opus', '.wma',
]);
const VIDEO_EXTENSIONS = new Set([
  '.mp4', '.avi', '.mov', '.mkv', '.webm', '.flv', '.wmv', '.m4v', '.mpeg', '.mpg',
]);
const DOCUMENT_EXTENSIONS = new Set([
  '.pdf', '.doc', '.docx', '.txt', '.md', '.csv', '.json', '.xml', '.html',
]);

export class MediaManager {
  private imageProcessor: ImageProcessor;
  private audioProcessor: AudioProcessor;
  private videoProcessor: VideoProcessor;
  private fileManager: FileManager;
  private cleanupRegistered = false;

  constructor() {
    this.imageProcessor = new ImageProcessor();
    this.audioProcessor = new AudioProcessor();
    this.videoProcessor = new VideoProcessor();
    this.fileManager = new FileManager();
  }

  /**
   * Detect the media type from a buffer (by magic bytes) or a file path (by extension).
   * @param input - Buffer or file path string
   */
  detectType(input: Buffer | string): MediaType {
    if (typeof input === 'string') {
      const lower = input.toLowerCase();
      const lastDot = lower.lastIndexOf('.');
      if (lastDot === -1) return 'unknown';
      const ext = lower.slice(lastDot);
      if (IMAGE_EXTENSIONS.has(ext)) return 'image';
      if (AUDIO_EXTENSIONS.has(ext)) return 'audio';
      if (VIDEO_EXTENSIONS.has(ext)) return 'video';
      if (DOCUMENT_EXTENSIONS.has(ext)) return 'document';
      return 'unknown';
    }

    // Detect by magic bytes
    if (input.length >= 4) {
      // JPEG: FF D8 FF
      if (input[0] === 0xff && input[1] === 0xd8 && input[2] === 0xff) return 'image';
      // PNG: 89 50 4E 47
      if (input[0] === 0x89 && input[1] === 0x50 && input[2] === 0x4e && input[3] === 0x47) return 'image';
      // GIF: 47 49 46 38
      if (input[0] === 0x47 && input[1] === 0x49 && input[2] === 0x46 && input[3] === 0x38) return 'image';
      // WebP: RIFF????WEBP
      if (
        input.length >= 12 &&
        input[0] === 0x52 && input[1] === 0x49 && input[2] === 0x46 && input[3] === 0x46 &&
        input[8] === 0x57 && input[9] === 0x45 && input[10] === 0x42 && input[11] === 0x50
      ) return 'image';
      // MP3: ID3 or FF FB
      if (input[0] === 0x49 && input[1] === 0x44 && input[2] === 0x33) return 'audio';
      if (input[0] === 0xff && (input[1] & 0xe0) === 0xe0) return 'audio';
      // OGG: OggS
      if (input[0] === 0x4f && input[1] === 0x67 && input[2] === 0x67 && input[3] === 0x53) return 'audio';
      // WAV: RIFF????WAVE
      if (
        input.length >= 12 &&
        input[0] === 0x52 && input[1] === 0x49 && input[2] === 0x46 && input[3] === 0x46 &&
        input[8] === 0x57 && input[9] === 0x41 && input[10] === 0x56 && input[11] === 0x45
      ) return 'audio';
      // MP4: ftyp at offset 4
      if (
        input.length >= 8 &&
        input[4] === 0x66 && input[5] === 0x74 && input[6] === 0x79 && input[7] === 0x70
      ) return 'video';
      // PDF: %PDF
      if (input[0] === 0x25 && input[1] === 0x50 && input[2] === 0x44 && input[3] === 0x46) return 'document';
    }

    return 'unknown';
  }

  /**
   * Smart image processing — applies options in a logical pipeline order.
   * @param input - Source image buffer
   * @param options - Processing options
   */
  async processImage(input: Buffer, options: ImageProcessOptions = {}): Promise<Buffer> {
    let buf = input;

    if (options.stripExif) {
      buf = await this.imageProcessor.stripExif(buf);
    }

    if (options.width && options.height) {
      buf = await this.imageProcessor.resize(buf, options.width, options.height, options.fit);
    }

    if (options.format) {
      buf = await this.imageProcessor.transcode(buf, options.format, options.quality);
    }

    if (options.maxSizeKB) {
      buf = await this.imageProcessor.compress(buf, options.maxSizeKB);
    }

    return buf;
  }

  /**
   * Smart audio processing — converts format and optionally transcribes.
   * @param input - Source audio buffer
   * @param options - Processing options
   */
  async processAudio(input: Buffer, options: AudioProcessOptions = {}): Promise<Buffer> {
    if (options.format) {
      return this.audioProcessor.convert(input, options.format);
    }
    return input;
  }

  /**
   * Smart video processing — transcodes and/or compresses.
   * @param input - Source video buffer
   * @param options - Processing options
   */
  async processVideo(input: Buffer, options: VideoProcessOptions = {}): Promise<Buffer> {
    if (options.maxSizeMB) {
      return this.videoProcessor.compress(input, options.maxSizeMB);
    }

    if (options.format || options.codec) {
      return this.videoProcessor.transcode(input, {
        format: options.format,
        codec: options.codec,
      });
    }

    return input;
  }

  /**
   * Register cleanup of all temp files on process exit.
   * Safe to call multiple times.
   */
  registerExitCleanup(): void {
    if (this.cleanupRegistered) return;
    this.cleanupRegistered = true;

    const cleanup = async () => {
      await this.fileManager.cleanupAll();
    };

    process.once('exit', () => {
      // Synchronous best-effort on 'exit'
      for (const path of this.fileManager.getTrackedFiles()) {
        try {
          const { unlinkSync } = require('fs');
          unlinkSync(path);
        } catch {
          // ignore
        }
      }
    });
  }

  /** Expose underlying processors for direct use */
  get image(): ImageProcessor { return this.imageProcessor; }
  get audio(): AudioProcessor { return this.audioProcessor; }
  get video(): VideoProcessor { return this.videoProcessor; }
  get files(): FileManager { return this.fileManager; }
}

export function createMediaManager(): MediaManager {
  return new MediaManager();
}
