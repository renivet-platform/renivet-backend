import { Injectable } from '@nestjs/common';
import sharp, { Sharp } from 'sharp';
import { createHash } from 'node:crypto';
import { MediaDerivative, MediaImageProcessorPort } from './media-ports';
import { detectMediaMime } from './media-validation';
import { mediaObjectKey } from './spaces-media-storage';

const MAX_IMAGE_PIXELS = 40_000_000;

@Injectable()
export class SharpMediaImageProcessor implements MediaImageProcessorPort {
  async createDerivatives(input: Buffer, mimeType: string, brandId: string, assetId: string): Promise<MediaDerivative[]> {
    if (detectMediaMime(input) !== mimeType) throw new InvalidMediaImageError();
    try {
      const source = sharp(input, { failOn: 'error', limitInputPixels: MAX_IMAGE_PIXELS, sequentialRead: true });
      const metadata = await source.metadata();
      const formatToMime = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' } as const;
      if (!metadata.width || !metadata.height || metadata.width * metadata.height > MAX_IMAGE_PIXELS
        || formatToMime[metadata.format as keyof typeof formatToMime] !== mimeType) throw new InvalidMediaImageError();

      const outputs = await Promise.all([
        derivative(source, 'PREVIEW', 1600, brandId, assetId),
        derivative(source, 'THUMBNAIL', 320, brandId, assetId),
      ]);
      return outputs;
    } catch (error) {
      if (error instanceof InvalidMediaImageError) throw error;
      throw new InvalidMediaImageError();
    }
  }
}

export class InvalidMediaImageError extends Error {
  constructor() { super('The uploaded image is not valid.'); this.name = 'InvalidMediaImageError'; }
}

async function derivative(source: Sharp, kind: MediaDerivative['kind'], size: number, brandId: string, assetId: string): Promise<MediaDerivative> {
  const result = await source.clone().rotate().resize({ width: size, height: size, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 82, effort: 4 }).toBuffer({ resolveWithObject: true });
  return {
    kind,
    key: mediaObjectKey(brandId, assetId, kind === 'PREVIEW' ? 'preview' : 'thumbnail'),
    bytes: result.data,
    sha256: createHash('sha256').update(result.data).digest('hex'),
    width: result.info.width,
    height: result.info.height,
    mimeType: 'image/webp',
  };
}
