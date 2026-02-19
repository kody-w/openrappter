/**
 * Media Pipeline Tests
 * Tests image, audio, video processing and file management.
 * External tools (sharp, ffmpeg) are mocked.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'os';
import { join } from 'path';
import { writeFileSync, mkdirSync, existsSync } from 'fs';

// ---------------------------------------------------------------------------
// Mock sharp
// ---------------------------------------------------------------------------
vi.mock('sharp', () => {
  const sharpInstance = {
    jpeg: vi.fn().mockReturnThis(),
    webp: vi.fn().mockReturnThis(),
    png: vi.fn().mockReturnThis(),
    resize: vi.fn().mockReturnThis(),
    withMetadata: vi.fn().mockReturnThis(),
    toBuffer: vi.fn().mockResolvedValue(Buffer.from('mock-image-data')),
    metadata: vi.fn().mockResolvedValue({ width: 800, height: 600, format: 'jpeg', size: 51200 }),
    flatten: vi.fn().mockReturnThis(),
    toFormat: vi.fn().mockReturnThis(),
  };
  const sharp = vi.fn().mockReturnValue(sharpInstance);
  (sharp as any).cache = vi.fn();
  return { default: sharp };
});

// ---------------------------------------------------------------------------
// Mock child_process for ffmpeg
// ---------------------------------------------------------------------------
vi.mock('child_process', () => {
  const EventEmitter = require('events');
  const { writeFileSync } = require('fs');

  const makeProcess = (stdout = '', stderr = '', code = 0, outputPath?: string) => {
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.stdin = { end: vi.fn() };
    // Emit events asynchronously so tests can set up listeners
    setTimeout(() => {
      // Write a placeholder output file for file-based ffmpeg operations
      if (outputPath) {
        try {
          writeFileSync(outputPath, Buffer.from('mock-ffmpeg-output'));
        } catch {
          // ignore
        }
      }
      if (stdout) proc.stdout.emit('data', Buffer.from(stdout));
      if (stderr) proc.stderr.emit('data', Buffer.from(stderr));
      proc.emit('close', code);
    }, 0);
    return proc;
  };

  return {
    spawn: vi.fn().mockImplementation((_cmd: string, args: string[]) => {
      // ffprobe JSON output for getInfo calls
      if (_cmd === 'ffprobe' || args.includes('-print_format')) {
        const json = JSON.stringify({
          format: { duration: '120.5', format_name: 'mp4', size: '10485760', bit_rate: '800000' },
          streams: [
            { codec_type: 'video', width: 1920, height: 1080, codec_name: 'h264', r_frame_rate: '30/1' },
            { codec_type: 'audio', sample_rate: '44100', codec_name: 'aac' },
          ],
        });
        return makeProcess(json, '', 0);
      }

      // For ffmpeg file-based operations, find the output path (last arg that's a temp file)
      const outputArg = args.filter(
        (a) => !a.startsWith('-') && (a.includes('/tmp/') || a.includes('/var/folders/') || a.includes('openrappter-'))
      ).pop();

      return makeProcess('', '', 0, outputArg);
    }),
  };
});

// ---------------------------------------------------------------------------
// Image Processor Tests
// ---------------------------------------------------------------------------
describe('ImageProcessor', () => {
  let ImageProcessor: any;

  beforeEach(async () => {
    const mod = await import('../image.js');
    ImageProcessor = mod.ImageProcessor;
  });

  it('should export ImageProcessor class', async () => {
    const mod = await import('../image.js');
    expect(mod.ImageProcessor).toBeDefined();
  });

  it('should transcode to jpeg', async () => {
    const processor = new ImageProcessor();
    const input = Buffer.from('fake-image');
    const result = await processor.transcode(input, 'jpeg', 80);
    expect(result).toBeInstanceOf(Buffer);
  });

  it('should transcode to webp', async () => {
    const processor = new ImageProcessor();
    const input = Buffer.from('fake-image');
    const result = await processor.transcode(input, 'webp');
    expect(result).toBeInstanceOf(Buffer);
  });

  it('should transcode to png', async () => {
    const processor = new ImageProcessor();
    const input = Buffer.from('fake-image');
    const result = await processor.transcode(input, 'png');
    expect(result).toBeInstanceOf(Buffer);
  });

  it('should compress image', async () => {
    const processor = new ImageProcessor();
    const input = Buffer.from('fake-image');
    const result = await processor.compress(input, 100);
    expect(result).toBeInstanceOf(Buffer);
  });

  it('should resize image with width and height', async () => {
    const processor = new ImageProcessor();
    const input = Buffer.from('fake-image');
    const result = await processor.resize(input, 640, 480);
    expect(result).toBeInstanceOf(Buffer);
  });

  it('should resize image with fit option', async () => {
    const processor = new ImageProcessor();
    const input = Buffer.from('fake-image');
    const result = await processor.resize(input, 640, 480, 'cover');
    expect(result).toBeInstanceOf(Buffer);
  });

  it('should strip EXIF data', async () => {
    const processor = new ImageProcessor();
    const input = Buffer.from('fake-image-with-exif');
    const result = await processor.stripExif(input);
    expect(result).toBeInstanceOf(Buffer);
  });

  it('should get image info', async () => {
    const processor = new ImageProcessor();
    const input = Buffer.from('fake-image');
    const info = await processor.getInfo(input);
    expect(info).toHaveProperty('width');
    expect(info).toHaveProperty('height');
    expect(info).toHaveProperty('format');
    expect(info).toHaveProperty('size');
  });

  it('should reject invalid format', async () => {
    const processor = new ImageProcessor();
    const input = Buffer.from('fake-image');
    await expect(processor.transcode(input, 'bmp' as any)).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Audio Processor Tests
// ---------------------------------------------------------------------------
describe('AudioProcessor', () => {
  let AudioProcessor: any;

  beforeEach(async () => {
    const mod = await import('../audio.js');
    AudioProcessor = mod.AudioProcessor;
  });

  it('should export AudioProcessor class', async () => {
    const mod = await import('../audio.js');
    expect(mod.AudioProcessor).toBeDefined();
  });

  it('should get audio info via ffprobe', async () => {
    const processor = new AudioProcessor();
    const input = Buffer.from('fake-audio');
    const info = await processor.getInfo(input);
    expect(info).toHaveProperty('duration');
    expect(info).toHaveProperty('format');
  });

  it('should convert audio to mp3', async () => {
    const processor = new AudioProcessor();
    const input = Buffer.from('fake-audio');
    const result = await processor.convert(input, 'mp3');
    expect(result).toBeInstanceOf(Buffer);
  });

  it('should convert audio to wav', async () => {
    const processor = new AudioProcessor();
    const input = Buffer.from('fake-audio');
    const result = await processor.convert(input, 'wav');
    expect(result).toBeInstanceOf(Buffer);
  });

  it('should convert audio to ogg', async () => {
    const processor = new AudioProcessor();
    const input = Buffer.from('fake-audio');
    const result = await processor.convert(input, 'ogg');
    expect(result).toBeInstanceOf(Buffer);
  });

  it('should return transcription placeholder when no API configured', async () => {
    const processor = new AudioProcessor();
    const input = Buffer.from('fake-audio');
    const result = await processor.transcribe(input);
    expect(result).toHaveProperty('text');
    expect(typeof result.text).toBe('string');
  });

  it('should accept transcription options', async () => {
    const processor = new AudioProcessor();
    const input = Buffer.from('fake-audio');
    const result = await processor.transcribe(input, { language: 'en' });
    expect(result).toHaveProperty('text');
  });

  it('should perform text-to-speech and return buffer', async () => {
    const processor = new AudioProcessor();
    const result = await processor.textToSpeech('Hello world');
    expect(result).toBeInstanceOf(Buffer);
  });

  it('should accept voice and options for TTS', async () => {
    const processor = new AudioProcessor();
    const result = await processor.textToSpeech('Hello world', 'alloy', { speed: 1.0 });
    expect(result).toBeInstanceOf(Buffer);
  });
});

// ---------------------------------------------------------------------------
// Video Processor Tests
// ---------------------------------------------------------------------------
describe('VideoProcessor', () => {
  let VideoProcessor: any;

  beforeEach(async () => {
    const mod = await import('../video.js');
    VideoProcessor = mod.VideoProcessor;
  });

  it('should export VideoProcessor class', async () => {
    const mod = await import('../video.js');
    expect(mod.VideoProcessor).toBeDefined();
  });

  it('should get video info via ffprobe', async () => {
    const processor = new VideoProcessor();
    const input = Buffer.from('fake-video');
    const info = await processor.getInfo(input);
    expect(info).toHaveProperty('duration');
    expect(info).toHaveProperty('width');
    expect(info).toHaveProperty('height');
    expect(info).toHaveProperty('codec');
  });

  it('should extract a frame at a timestamp', async () => {
    const processor = new VideoProcessor();
    const input = Buffer.from('fake-video');
    const frame = await processor.extractFrame(input, 5);
    expect(frame).toBeInstanceOf(Buffer);
  });

  it('should transcode video', async () => {
    const processor = new VideoProcessor();
    const input = Buffer.from('fake-video');
    const result = await processor.transcode(input, { format: 'mp4' });
    expect(result).toBeInstanceOf(Buffer);
  });

  it('should compress video', async () => {
    const processor = new VideoProcessor();
    const input = Buffer.from('fake-video');
    const result = await processor.compress(input, 10);
    expect(result).toBeInstanceOf(Buffer);
  });
});

// ---------------------------------------------------------------------------
// File Manager Tests
// ---------------------------------------------------------------------------
describe('FileManager', () => {
  let FileManager: any;
  let manager: any;

  beforeEach(async () => {
    const mod = await import('../files.js');
    FileManager = mod.FileManager;
    manager = new FileManager();
  });

  afterEach(async () => {
    await manager.cleanupAll();
  });

  it('should export FileManager class', async () => {
    const mod = await import('../files.js');
    expect(mod.FileManager).toBeDefined();
  });

  it('should create a temp file path', async () => {
    const path = await manager.createTemp('test', '.txt');
    expect(typeof path).toBe('string');
    expect(path).toContain('test');
    expect(path).toMatch(/\.txt$/);
  });

  it('should track created temp files', async () => {
    const path1 = await manager.createTemp('a', '.tmp');
    const path2 = await manager.createTemp('b', '.tmp');
    const tracked = manager.getTrackedFiles();
    expect(tracked).toContain(path1);
    expect(tracked).toContain(path2);
  });

  it('should atomically write data to a path', async () => {
    const path = await manager.createTemp('write-test', '.txt');
    await manager.atomicWrite(path, Buffer.from('hello world'));
    const size = await manager.getSize(path);
    expect(size).toBe(11);
  });

  it('should cleanup a specific temp file', async () => {
    const path = await manager.createTemp('cleanup-test', '.txt');
    await manager.atomicWrite(path, Buffer.from('data'));
    await manager.cleanup(path);
    expect(existsSync(path)).toBe(false);
  });

  it('should cleanupAll tracked files', async () => {
    const path1 = await manager.createTemp('x', '.tmp');
    const path2 = await manager.createTemp('y', '.tmp');
    await manager.atomicWrite(path1, Buffer.from('1'));
    await manager.atomicWrite(path2, Buffer.from('2'));
    await manager.cleanupAll();
    expect(existsSync(path1)).toBe(false);
    expect(existsSync(path2)).toBe(false);
  });

  it('should get file size', async () => {
    const path = await manager.createTemp('size-test', '.bin');
    const data = Buffer.alloc(1024, 0xff);
    await manager.atomicWrite(path, data);
    const size = await manager.getSize(path);
    expect(size).toBe(1024);
  });

  it('should not throw if cleanup target does not exist', async () => {
    await expect(manager.cleanup('/tmp/nonexistent-openrappter-test-12345.tmp')).resolves.not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Media Manager (Unified Interface) Tests
// ---------------------------------------------------------------------------
describe('MediaManager', () => {
  let MediaManager: any;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import('../index.js');
    MediaManager = mod.MediaManager;
  });

  it('should export MediaManager class', async () => {
    const mod = await import('../index.js');
    expect(mod.MediaManager).toBeDefined();
  });

  it('should detect image type from buffer with JPEG magic bytes', async () => {
    const manager = new MediaManager();
    // JPEG magic bytes: FF D8 FF
    const jpegBuffer = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    const type = manager.detectType(jpegBuffer);
    expect(type).toBe('image');
  });

  it('should detect image type from buffer with PNG magic bytes', async () => {
    const manager = new MediaManager();
    // PNG magic bytes: 89 50 4E 47
    const pngBuffer = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const type = manager.detectType(pngBuffer);
    expect(type).toBe('image');
  });

  it('should detect type from file path extension', async () => {
    const manager = new MediaManager();
    expect(manager.detectType('/path/to/photo.jpg')).toBe('image');
    expect(manager.detectType('/path/to/audio.mp3')).toBe('audio');
    expect(manager.detectType('/path/to/video.mp4')).toBe('video');
    expect(manager.detectType('/path/to/doc.pdf')).toBe('document');
  });

  it('should process image', async () => {
    const manager = new MediaManager();
    const input = Buffer.from('fake-image');
    const result = await manager.processImage(input, { format: 'jpeg' });
    expect(result).toBeInstanceOf(Buffer);
  });

  it('should process audio', async () => {
    const manager = new MediaManager();
    const input = Buffer.from('fake-audio');
    const result = await manager.processAudio(input, { format: 'mp3' });
    expect(result).toBeInstanceOf(Buffer);
  });

  it('should process video', async () => {
    const manager = new MediaManager();
    const input = Buffer.from('fake-video');
    const result = await manager.processVideo(input, {});
    expect(result).toBeInstanceOf(Buffer);
  });

  it('should auto-cleanup on process exit', async () => {
    const manager = new MediaManager();
    // Ensure no error is thrown when setting up cleanup listener
    expect(() => manager.registerExitCleanup()).not.toThrow();
  });
});
