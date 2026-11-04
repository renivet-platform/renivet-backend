import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { MediaObjectMetadata, MediaStoragePort, MediaUploadIntentResult } from './media-ports';

export class MediaStorageUnavailableError extends Error {
  constructor() { super('Media storage is unavailable.'); this.name = 'MediaStorageUnavailableError'; }
}

export function validateSpacesEndpoint(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const endpoint = new URL(value);
    if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash
      || endpoint.pathname !== '/' || !(endpoint.hostname === 'digitaloceanspaces.com'
        || endpoint.hostname.endsWith('.digitaloceanspaces.com'))) return null;
    return endpoint.origin;
  } catch {
    return null;
  }
}

export function mediaObjectKey(brandId: string, assetId: string, part: 'incoming' | 'original' | 'preview' | 'thumbnail', nonce?: string): string {
  const suffix = part === 'incoming' ? `/incoming/${nonce}`
    : part === 'original' ? '/original'
      : `/derivatives/${part}.webp`;
  return `brands/${brandId}/media/${assetId}${suffix}`;
}

@Injectable()
export class SpacesMediaStorage implements MediaStoragePort {
  private readonly endpoint: string | null;
  private readonly bucket: string | undefined;
  private readonly region: string | undefined;
  private readonly accessKeyId: string | undefined;
  private readonly secretAccessKey: string | undefined;
  private client: S3Client | null = null;

  constructor(private readonly config: ConfigService) {
    this.endpoint = validateSpacesEndpoint(config.get<string>('MEDIA_SPACES_ENDPOINT'));
    this.bucket = config.get<string>('MEDIA_SPACES_BUCKET')?.trim();
    this.region = config.get<string>('MEDIA_SPACES_REGION')?.trim();
    this.accessKeyId = config.get<string>('MEDIA_SPACES_ACCESS_KEY_ID')?.trim();
    this.secretAccessKey = config.get<string>('MEDIA_SPACES_SECRET_ACCESS_KEY')?.trim();
  }

  isConfigured(): boolean {
    return Boolean(this.endpoint && this.validBucket() && this.region && /^[a-z0-9-]{2,32}$/.test(this.region)
      && this.accessKeyId && this.secretAccessKey);
  }

  async createUploadIntent(input: { key: string; mimeType: string; byteLength: number; brandId: string; assetId: string; expiresAt?: string }): Promise<MediaUploadIntentResult> {
    const command = new PutObjectCommand({
      Bucket: this.requireBucket(), Key: input.key, ContentType: input.mimeType, ContentLength: input.byteLength,
      ACL: 'private', Metadata: { 'renivet-brand-id': input.brandId, 'renivet-media-asset-id': input.assetId },
    });
    const expiresAt = input.expiresAt ? new Date(input.expiresAt) : new Date(Date.now() + 300_000);
    const expiresIn = Math.max(1, Math.min(300, Math.floor((expiresAt.getTime() - Date.now()) / 1000)));
    const uploadUrl = await getSignedUrl(this.requireClient(), command, { expiresIn });
    return {
      uploadUrl,
      expiresAt: new Date(Math.min(expiresAt.getTime(), Date.now() + expiresIn * 1000)).toISOString(),
      headers: {
        'content-type': input.mimeType,
        'x-amz-acl': 'private',
        'x-amz-meta-renivet-brand-id': input.brandId,
        'x-amz-meta-renivet-media-asset-id': input.assetId,
      },
    };
  }

  async headObject(key: string): Promise<MediaObjectMetadata> {
    const result = await this.requireClient().send(new HeadObjectCommand({ Bucket: this.requireBucket(), Key: key }));
    if (!Number.isSafeInteger(result.ContentLength) || Number(result.ContentLength) < 0) throw new MediaStorageUnavailableError();
    return {
      contentLength: Number(result.ContentLength),
      contentType: result.ContentType,
      metadata: result.Metadata ?? {},
    };
  }

  async readObject(key: string, maxBytes: number): Promise<Buffer> {
    const result = await this.requireClient().send(new GetObjectCommand({ Bucket: this.requireBucket(), Key: key }));
    if (!result.Body) throw new MediaStorageUnavailableError();
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const value of result.Body as AsyncIterable<Uint8Array>) {
      const chunk = Buffer.from(value);
      total += chunk.length;
      if (total > maxBytes) throw new MediaStorageUnavailableError();
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, total);
  }

  async putPrivateObject(input: { key: string; bytes: Buffer; mimeType: string; brandId: string; assetId: string }): Promise<void> {
    await this.requireClient().send(new PutObjectCommand({
      Bucket: this.requireBucket(), Key: input.key, Body: input.bytes, ContentLength: input.bytes.length,
      ContentType: input.mimeType, CacheControl: 'private, no-store', ACL: 'private',
      Metadata: { 'renivet-brand-id': input.brandId, 'renivet-media-asset-id': input.assetId },
    }));
  }

  async createPreviewUrl(key: string): Promise<string> {
    return getSignedUrl(this.requireClient(), new GetObjectCommand({ Bucket: this.requireBucket(), Key: key }), { expiresIn: 60 });
  }

  async deleteObject(key: string): Promise<void> {
    await this.requireClient().send(new DeleteObjectCommand({ Bucket: this.requireBucket(), Key: key }));
  }

  private validBucket(): boolean {
    return Boolean(this.bucket && /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(this.bucket));
  }

  private requireBucket(): string {
    if (!this.isConfigured() || !this.bucket) throw new MediaStorageUnavailableError();
    return this.bucket;
  }

  private requireClient(): S3Client {
    if (!this.isConfigured() || !this.endpoint || !this.region || !this.accessKeyId || !this.secretAccessKey) {
      throw new MediaStorageUnavailableError();
    }
    this.client ??= new S3Client({
      endpoint: this.endpoint,
      region: this.region,
      forcePathStyle: false,
      credentials: { accessKeyId: this.accessKeyId, secretAccessKey: this.secretAccessKey },
    });
    return this.client;
  }
}
