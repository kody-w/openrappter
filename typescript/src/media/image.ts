/**
 * Image Processor
 * Handles image transcoding, compression, resizing, EXIF stripping, and info extraction.
 * Uses the `sharp` library for all operations.
 */

import sharp from 'sharp';

export type ImageFormat = 'jpeg' | 'webp' | 'png';
export type ResizeFit = 'cover' | 'contain' | 'fill' | 'inside' | 'outside';

export interface ImageInfo {
  width: number;
  height: number;
  format: string;
  size: number;
}

export class ImageProcessor {
  /**
   * Transcode an image buffer to the specified format.
   * @param input - Source image buffer
   * @param format - Target format: 'jpeg' | 'webp' | 'png'
   * @param quality - Quality 1-100 (only applies to jpeg/webp)
   * @returns Converted image as Buffer
   */
  async transcode(input: Buffer, format: ImageFormat, quality?: number): Promise<Buffer> {
    if (!['jpeg', 'webp', 'png'].includes(format)) {
      throw new Error(`Unsupported image format: ${format}. Must be jpeg, webp, or png.`);
    }

    let pipeline = sharp(input);

    switch (format) {
      case 'jpeg':
        pipeline = pipeline.jpeg({ quality: quality ?? 85 });
        break;
      case 'webp':
        pipeline = pipeline.webp({ quality: quality ?? 80 });
        break;
      case 'png':
        pipeline = pipeline.png({ quality: quality ?? 9 });
        break;
    }

    return pipeline.toBuffer();
  }

  /**
   * Compress an image to fit within the given size limit.
   * Progressively lowers quality until the output is small enough.
   * @param input - Source image buffer
   * @param maxSizeKB - Maximum output size in kilobytes
   * @returns Compressed image as Buffer
   */
  async compress(input: Buffer, maxSizeKB: number): Promise<Buffer> {
    const maxBytes = maxSizeKB * 1024;
    const meta = await sharp(input).metadata();
    const format = (meta.format ?? 'jpeg') as ImageFormat;

    // Try progressively lower qualities for lossy formats
    if (format === 'jpeg' || format === 'webp') {
      for (let quality = 85; quality >= 10; quality -= 10) {
        const result = await this.transcode(input, format, quality);
        if (result.length <= maxBytes) {
          return result;
        }
      }
      // Return at minimum quality
      return this.transcode(input, format, 10);
    }

    // For PNG, use compression level
    let result = await sharp(input).png({ compressionLevel: 9 }).toBuffer();
    if (result.length <= maxBytes) {
      return result;
    }

    // If still too large, convert to webp as fallback
    result = await sharp(input).webp({ quality: 70 }).toBuffer();
    return result;
  }

  /**
   * Resize an image to the specified dimensions.
   * @param input - Source image buffer
   * @param width - Target width in pixels
   * @param height - Target height in pixels
   * @param fit - How to fit the image: 'cover' | 'contain' | 'fill' | 'inside' | 'outside'
   * @returns Resized image as Buffer
   */
  async resize(input: Buffer, width: number, height: number, fit: ResizeFit = 'cover'): Promise<Buffer> {
    return sharp(input)
      .resize(width, height, { fit })
      .toBuffer();
  }

  /**
   * Remove EXIF and other metadata from an image.
   * @param input - Source image buffer
   * @returns Image buffer without metadata
   */
  async stripExif(input: Buffer): Promise<Buffer> {
    const meta = await sharp(input).metadata();
    const format = (meta.format ?? 'jpeg') as ImageFormat;

    // Re-encode without metadata (sharp strips EXIF by default on re-encode)
    return this.transcode(input, format);
  }

  /**
   * Get image information (dimensions, format, size).
   * @param input - Source image buffer
   * @returns ImageInfo object
   */
  async getInfo(input: Buffer): Promise<ImageInfo> {
    const meta = await sharp(input).metadata();
    return {
      width: meta.width ?? 0,
      height: meta.height ?? 0,
      format: meta.format ?? 'unknown',
      size: input.length,
    };
  }
}

export function createImageProcessor(): ImageProcessor {
  return new ImageProcessor();
}
