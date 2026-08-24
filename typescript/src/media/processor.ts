/**
 * Media Processing Pipeline
 * Handles image vision, audio transcription, and document processing
 */

import type { TranscriptionService } from '../voice/transcription.js';
import { assertFetchableUrl, fetchGuarded } from '../net/url-guard.js';
import type { VerifiedMediaAsset } from './ingest.js';

export interface MediaConfig {
  maxImageSize?: number;
  maxAudioDuration?: number;
  maxDocumentSize?: number;
  allowedDomains?: string[];
  blockedDomains?: string[];
}

export interface ProcessedMedia {
  type: 'image' | 'audio' | 'document' | 'video';
  mimeType: string;
  size: number;
  content: string;
  metadata: Record<string, unknown>;
}

export interface ImageDescription {
  description: string;
  labels?: string[];
  text?: string;
  faces?: number;
  objects?: string[];
}

const DEFAULT_CONFIG: MediaConfig = {
  maxImageSize: 20 * 1024 * 1024, // 20MB
  maxAudioDuration: 300, // 5 minutes
  maxDocumentSize: 10 * 1024 * 1024, // 10MB
};

function hostnameMatchesDomain(hostname: string, configuredDomain: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  const domain = configuredDomain.trim().toLowerCase().replace(/^\./, '').replace(/\.$/, '');
  return domain.length > 0 && (host === domain || host.endsWith(`.${domain}`));
}

export class MediaProcessor {
  private config: MediaConfig;
  private transcriptionService?: TranscriptionService;

  constructor(config?: Partial<MediaConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Set transcription service for audio processing
   */
  setTranscriptionService(service: TranscriptionService): void {
    this.transcriptionService = service;
  }

  /**
   * Process media from URL
   */
  /**
   * Domain allow/block policy configured on this processor.
   *
   * Separate from the address checks in url-guard: those decide whether a URL
   * may be fetched at all, this decides whether *this* processor is permitted
   * to fetch it. It is passed to `fetchGuarded` as the per-hop assertion, so
   * unlike the code it replaces it now also applies after a redirect — a host
   * outside the allowlist can no longer be reached by being redirected to.
   */
  private assertDomainPolicy(url: string): void {
    const hostname = new URL(url).hostname.toLowerCase();

    const { allowedDomains, blockedDomains } = this.config;
    if (allowedDomains && allowedDomains.length > 0) {
      if (!allowedDomains.some(domain => hostnameMatchesDomain(hostname, domain))) {
        throw new Error(`Domain ${hostname} is not in allowed list`);
      }
    }
    if (blockedDomains && blockedDomains.some(domain => hostnameMatchesDomain(hostname, domain))) {
      throw new Error(`Domain ${hostname} is blocked`);
    }
  }

  async processUrl(url: string): Promise<ProcessedMedia> {
    // SSRF protection
    // Guarded fetch: scheme and address checked, host resolved, and every
    // redirect hop re-checked. The local `validateUrl` this replaced ran once
    // on the caller's URL and then let `fetch` follow redirects on its own, so
    // a public host could point here at anything.
    const response = await fetchGuarded(url, {
      headers: {
        'User-Agent': 'OpenRappter/1.0',
      },
    }, undefined, target => {
      assertFetchableUrl(target);
      this.assertDomainPolicy(target);
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch media: ${response.statusText}`);
    }

    const contentType = response.headers.get('content-type') ?? 'application/octet-stream';
    const contentLength = parseInt(response.headers.get('content-length') ?? '0', 10);

    // Check size
    const maxSize = this.getMaxSize(contentType);
    if (contentLength > maxSize) {
      throw new Error(`Media too large: ${contentLength} bytes (max: ${maxSize})`);
    }

    const buffer = await this.readResponseBuffer(response, maxSize);
    return this.processBuffer(buffer, contentType);
  }

  /**
   * Read a response without letting a missing or dishonest Content-Length
   * bypass the media limit.
   */
  private async readResponseBuffer(response: Response, maxSize: number): Promise<Buffer> {
    const reader = response.body?.getReader();
    if (!reader) return Buffer.alloc(0);

    const chunks: Buffer[] = [];
    let total = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value || value.byteLength === 0) continue;

        if (value.byteLength > maxSize - total) {
          const received = total + value.byteLength;
          await reader.cancel(`Media too large: ${received} bytes (max: ${maxSize})`);
          throw new Error(`Media too large: at least ${received} bytes (max: ${maxSize})`);
        }

        total += value.byteLength;
        chunks.push(Buffer.from(value));
      }
    } finally {
      reader.releaseLock();
    }

    return Buffer.concat(chunks, total);
  }

  /**
   * Process media from buffer
   */
  async processBuffer(buffer: Buffer, mimeType: string): Promise<ProcessedMedia> {
    const type = this.getMediaType(mimeType);

    switch (type) {
      case 'image':
        return this.processImage(buffer, mimeType);
      case 'audio':
        return this.processAudio(buffer, mimeType);
      case 'document':
        return this.processDocument(buffer, mimeType);
      case 'video':
        return this.processVideo(buffer, mimeType);
      default:
        throw new Error(`Unsupported media type: ${mimeType}`);
    }
  }

  /**
   * Process a content-addressed private asset without materializing it as one
   * renderer/Node buffer. This is the large-media seam used by Chat,
   * Show-and-Tell, XPedition adapters, and organism eggs.
   */
  async processVerifiedAsset(asset: VerifiedMediaAsset): Promise<ProcessedMedia> {
    if (!asset.verified || !asset.privatePath || !asset.id.startsWith('sha256:')) {
      throw new Error('Media processor requires a verified private asset descriptor.');
    }
    const result: ProcessedMedia = {
      type: asset.kind === 'midi' ? 'audio' : asset.kind,
      mimeType: asset.mimeType,
      size: asset.size,
      content: `[Verified local ${asset.kind}: ${asset.displayName}]`,
      metadata: {
        assetId: asset.id,
        digest: asset.digest,
        privatePath: asset.privatePath,
        localOnly: true,
        probe: asset.probe,
      },
    };
    if (
      this.transcriptionService
      && (asset.kind === 'audio' || asset.kind === 'video')
    ) {
      try {
        const transcription = await this.transcriptionService.transcribeFile(
          asset.privatePath,
          { timestamps: true },
        );
        result.content = transcription.text;
        result.metadata = {
          ...result.metadata,
          duration: transcription.duration,
          language: transcription.language,
          segments: transcription.segments?.length,
        };
      } catch (error) {
        result.metadata.transcription = 'local-path-provider-unavailable';
        result.metadata.transcriptionError =
          error instanceof Error ? error.message : String(error);
      }
    }
    return result;
  }

  /**
   * Process image
   */
  private async processImage(buffer: Buffer, mimeType: string): Promise<ProcessedMedia> {
    // Check size
    if (buffer.length > (this.config.maxImageSize ?? DEFAULT_CONFIG.maxImageSize!)) {
      throw new Error('Image too large');
    }

    // Convert to base64 for vision APIs
    const base64 = buffer.toString('base64');
    const dataUrl = `data:${mimeType};base64,${base64}`;

    // Get image dimensions (basic check)
    const dimensions = this.getImageDimensions(buffer);

    return {
      type: 'image',
      mimeType,
      size: buffer.length,
      content: dataUrl,
      metadata: {
        width: dimensions?.width,
        height: dimensions?.height,
      },
    };
  }

  /**
   * Process audio
   */
  private async processAudio(buffer: Buffer, mimeType: string): Promise<ProcessedMedia> {
    const result: ProcessedMedia = {
      type: 'audio',
      mimeType,
      size: buffer.length,
      content: '',
      metadata: {},
    };

    // Transcribe if service available
    if (this.transcriptionService) {
      try {
        const transcription = await this.transcriptionService.transcribe(buffer, {
          timestamps: true,
        });
        result.content = transcription.text;
        result.metadata = {
          duration: transcription.duration,
          language: transcription.language,
          segments: transcription.segments?.length,
        };
      } catch (error) {
        console.warn('Audio transcription failed:', error);
        result.content = '[Audio content - transcription unavailable]';
      }
    } else {
      result.content = '[Audio content - transcription service not configured]';
    }

    return result;
  }

  /**
   * Process document
   */
  private async processDocument(buffer: Buffer, mimeType: string): Promise<ProcessedMedia> {
    // Check size
    if (buffer.length > (this.config.maxDocumentSize ?? DEFAULT_CONFIG.maxDocumentSize!)) {
      throw new Error('Document too large');
    }

    let content = '';

    // Extract text based on type
    if (mimeType === 'application/pdf') {
      content = await this.extractPdfText(buffer);
    } else if (
      mimeType === 'text/plain' ||
      mimeType === 'text/markdown' ||
      mimeType === 'text/csv'
    ) {
      content = buffer.toString('utf8');
    } else if (mimeType === 'application/json') {
      content = buffer.toString('utf8');
    } else if (
      mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    ) {
      content = await this.extractDocxText(buffer);
    } else {
      // Try as text
      try {
        content = buffer.toString('utf8');
      } catch {
        content = '[Binary document - text extraction not supported]';
      }
    }

    return {
      type: 'document',
      mimeType,
      size: buffer.length,
      content,
      metadata: {
        encoding: 'utf8',
        lines: content.split('\n').length,
      },
    };
  }

  /**
   * Process video
   */
  private async processVideo(buffer: Buffer, mimeType: string): Promise<ProcessedMedia> {
    // For video, we typically extract audio for transcription
    // and optionally extract keyframes for vision

    const result: ProcessedMedia = {
      type: 'video',
      mimeType,
      size: buffer.length,
      content: '[Video content]',
      metadata: {},
    };

    // If transcription service available, try to extract and transcribe audio
    if (this.transcriptionService) {
      try {
        // Note: In production, would use ffmpeg to extract audio
        // For now, just mark as video
        result.metadata.note = 'Audio extraction requires ffmpeg';
      } catch {
        // Ignore
      }
    }

    return result;
  }

  /**
   * Extract text from PDF
   */
  private async extractPdfText(buffer: Buffer): Promise<string> {
    // Simplified PDF text extraction
    // In production, use pdf-parse or similar library
    try {
      const text = buffer.toString('utf8');
      // Look for text streams in PDF
      const textMatches = text.match(/\(([^)]+)\)/g);
      if (textMatches) {
        return textMatches.map((m) => m.slice(1, -1)).join(' ');
      }
      return '[PDF - text extraction requires pdf-parse library]';
    } catch {
      return '[PDF - could not extract text]';
    }
  }

  /**
   * Extract text from DOCX
   */
  private async extractDocxText(buffer: Buffer): Promise<string> {
    // Simplified DOCX text extraction
    // In production, use mammoth or similar library
    try {
      // DOCX is a ZIP file, look for document.xml
      const text = buffer.toString('utf8');
      const matches = text.match(/<w:t[^>]*>([^<]+)<\/w:t>/g);
      if (matches) {
        return matches.map((m) => m.replace(/<[^>]+>/g, '')).join(' ');
      }
      return '[DOCX - text extraction requires mammoth library]';
    } catch {
      return '[DOCX - could not extract text]';
    }
  }

  /**
   * Get image dimensions from buffer
   */
  private getImageDimensions(buffer: Buffer): { width: number; height: number } | null {
    try {
      // PNG
      if (buffer[0] === 0x89 && buffer.toString('utf8', 1, 4) === 'PNG') {
        return {
          width: buffer.readUInt32BE(16),
          height: buffer.readUInt32BE(20),
        };
      }

      // JPEG
      if (buffer[0] === 0xff && buffer[1] === 0xd8) {
        let offset = 2;
        while (offset < buffer.length) {
          if (buffer[offset] !== 0xff) break;
          const marker = buffer[offset + 1];
          if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8) {
            return {
              height: buffer.readUInt16BE(offset + 5),
              width: buffer.readUInt16BE(offset + 7),
            };
          }
          offset += 2 + buffer.readUInt16BE(offset + 2);
        }
      }

      // GIF
      if (buffer.toString('utf8', 0, 3) === 'GIF') {
        return {
          width: buffer.readUInt16LE(6),
          height: buffer.readUInt16LE(8),
        };
      }

      return null;
    } catch {
      return null;
    }
  }

  /**
   * Get media type from MIME type
   */
  private getMediaType(mimeType: string): 'image' | 'audio' | 'document' | 'video' {
    if (mimeType.startsWith('image/')) return 'image';
    if (mimeType.startsWith('audio/')) return 'audio';
    if (mimeType.startsWith('video/')) return 'video';
    return 'document';
  }

  /**
   * Get max size for media type
   */
  private getMaxSize(mimeType: string): number {
    const type = this.getMediaType(mimeType);
    switch (type) {
      case 'image':
        return this.config.maxImageSize ?? DEFAULT_CONFIG.maxImageSize!;
      case 'audio':
      case 'video':
        return 100 * 1024 * 1024; // 100MB for audio/video
      default:
        return this.config.maxDocumentSize ?? DEFAULT_CONFIG.maxDocumentSize!;
    }
  }

  /**
   * Validate URL for SSRF protection
   */
}

export function createMediaProcessor(config?: Partial<MediaConfig>): MediaProcessor {
  return new MediaProcessor(config);
}
