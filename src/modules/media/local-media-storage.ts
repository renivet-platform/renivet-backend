import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MediaObjectMetadata, MediaStoragePort, MediaUploadIntentResult } from './media-ports';
import { MAX_MEDIA_UPLOAD_BYTES } from './media-validation';
import { MediaStorageUnavailableError } from './spaces-media-storage';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OBJECT_KEY = /^brands\/([0-9a-f-]{36})\/media\/([0-9a-f-]{36})\/(incoming\/[0-9a-f-]{36}|original|derivatives\/(?:preview|thumbnail)\.webp)$/i;
const DERIVATIVE_KEY = /^brands\/([0-9a-f-]{36})\/media\/([0-9a-f-]{36})\/derivatives\/(preview|thumbnail)\.webp$/i;
const UPLOAD_TTL_MS = 5 * 60_000;
const PREVIEW_TTL_MS = 60_000;

export interface LocalMediaUploadInput {
  key: string;
  brandId: string;
  assetId: string;
  nonce: string;
  contentType: string;
  contentLength: number;
  bytes: Buffer;
  capability: string;
}

export function localMediaStorageRoot(config: Record<string, unknown>): string | null {
  if (config.NODE_ENV !== 'development' || config.RENIVET_LOCAL_MEDIA_STORAGE_ENABLED !== true) return null;
  const configured = typeof config.RENIVET_LOCAL_MEDIA_STORAGE_DIR === 'string' && config.RENIVET_LOCAL_MEDIA_STORAGE_DIR.trim()
    ? config.RENIVET_LOCAL_MEDIA_STORAGE_DIR.trim()
    : path.join(process.cwd(), '.tmp', 'media');
  const root = path.resolve(configured);
  assertOutsidePublic(root);
  return root;
}

export function localMediaObjectPath(root: string, key: string): string {
  if (!OBJECT_KEY.test(key)) throw new Error('Invalid local media object key.');
  const resolvedRoot = path.resolve(root);
  const objectPath = path.resolve(resolvedRoot, ...key.split('/'));
  if (!isWithin(resolvedRoot, objectPath) || objectPath === resolvedRoot) throw new Error('Invalid local media object path.');
  return objectPath;
}

@Injectable()
export class LocalMediaStorage implements MediaStoragePort {
  private readonly root: string | null;
  private readonly origin: string;
  private readonly secret = randomBytes(32);
  private readonly now: () => number = Date.now;

  constructor(config: ConfigService) {
    this.root = localMediaStorageRoot({
      NODE_ENV: config.get<string>('NODE_ENV'),
      RENIVET_LOCAL_MEDIA_STORAGE_ENABLED: config.get<boolean>('RENIVET_LOCAL_MEDIA_STORAGE_ENABLED'),
      RENIVET_LOCAL_MEDIA_STORAGE_DIR: config.get<string>('RENIVET_LOCAL_MEDIA_STORAGE_DIR'),
    });
    const configuredHost = config.get<string>('HOST')?.trim() || '127.0.0.1';
    const host = configuredHost === '0.0.0.0' ? '127.0.0.1'
      : configuredHost.includes(':') && !configuredHost.startsWith('[') ? `[${configuredHost}]` : configuredHost;
    const port = config.get<number>('PORT') ?? 4000;
    this.origin = new URL(`http://${host}:${port}`).origin;
  }

  isConfigured(): boolean { return this.root !== null; }

  async createUploadIntent(input: { key: string; mimeType: string; byteLength: number; brandId: string; assetId: string; expiresAt?: string }): Promise<MediaUploadIntentResult> {
    this.requireRoot();
    const parsed = parseObjectKey(input.key);
    if (parsed.brandId !== input.brandId || parsed.assetId !== input.assetId || !parsed.nonce
      || !isAllowedImage(input.mimeType) || !Number.isSafeInteger(input.byteLength)
      || input.byteLength < 1 || input.byteLength > MAX_MEDIA_UPLOAD_BYTES) throw new MediaStorageUnavailableError();
    const requestedExpiry = input.expiresAt ? new Date(input.expiresAt).getTime() : this.now() + UPLOAD_TTL_MS;
    const expiresAtMs = Math.min(requestedExpiry, this.now() + UPLOAD_TTL_MS);
    if (!Number.isSafeInteger(expiresAtMs) || expiresAtMs <= this.now()) throw new MediaStorageUnavailableError();
    const capability = this.createCapability('upload', input.key, input.mimeType, input.byteLength, expiresAtMs);
    return {
      uploadUrl: `${this.origin}/api/v1/brands/${input.brandId}/media/local-uploads/${input.assetId}/${parsed.nonce}`,
      expiresAt: new Date(expiresAtMs).toISOString(),
      headers: { 'content-type': input.mimeType, 'x-renivet-local-upload-token': capability },
    };
  }

  async storeLocalUpload(input: LocalMediaUploadInput): Promise<void> {
    this.requireRoot();
    const parsed = parseObjectKey(input.key);
    if (parsed.brandId !== input.brandId || parsed.assetId !== input.assetId || parsed.nonce !== input.nonce
      || !isAllowedImage(input.contentType) || !Number.isSafeInteger(input.contentLength)
      || input.contentLength < 1 || input.contentLength > MAX_MEDIA_UPLOAD_BYTES || input.bytes.length !== input.contentLength
      || !this.verifyCapability('upload', input.key, input.contentType, input.contentLength, input.capability)) {
      throw new Error('Local media upload capability or metadata is invalid or expired.');
    }
    await this.putPrivateObject({ key: input.key, bytes: input.bytes, mimeType: input.contentType,
      brandId: input.brandId, assetId: input.assetId });
  }

  async headObject(key: string): Promise<MediaObjectMetadata> {
    const filePath = await this.safePath(key, true);
    const [info, metadata] = await Promise.all([fs.lstat(filePath), this.readMetadata(filePath)]);
    if (!info.isFile() || info.isSymbolicLink()) throw new MediaStorageUnavailableError();
    return { contentLength: info.size, contentType: metadata.contentType, metadata: metadata.metadata };
  }

  async readObject(key: string, maxBytes: number): Promise<Buffer> {
    const filePath = await this.safePath(key, true);
    const info = await fs.lstat(filePath);
    if (!info.isFile() || info.isSymbolicLink() || info.size > maxBytes) throw new MediaStorageUnavailableError();
    return fs.readFile(filePath);
  }

  async putPrivateObject(input: { key: string; bytes: Buffer; mimeType: string; brandId: string; assetId: string }): Promise<void> {
    this.requireRoot();
    const parsed = parseObjectKey(input.key);
    if (parsed.brandId !== input.brandId || parsed.assetId !== input.assetId || !isAllowedImage(input.mimeType)
      || input.bytes.length < 1 || input.bytes.length > MAX_MEDIA_UPLOAD_BYTES) throw new MediaStorageUnavailableError();
    const filePath = await this.safePath(input.key, true);
    await atomicWrite(filePath, input.bytes);
    await atomicWrite(`${filePath}.meta.json`, Buffer.from(JSON.stringify({
      contentType: input.mimeType,
      metadata: { 'renivet-brand-id': input.brandId, 'renivet-media-asset-id': input.assetId },
    })));
  }

  async createPreviewUrl(key: string): Promise<string> {
    this.requireRoot();
    const parsed = DERIVATIVE_KEY.exec(key);
    if (!parsed) throw new MediaStorageUnavailableError();
    const expiresAtMs = this.now() + PREVIEW_TTL_MS;
    const token = this.createCapability('preview', key, 'image/webp', 0, expiresAtMs);
    return `${this.origin}/api/v1/brands/${parsed[1]}/media/local-previews/${parsed[2]}/${parsed[3]}?token=${encodeURIComponent(token)}`;
  }

  async readLocalPreview(input: { key: string; capability: string }): Promise<Buffer> {
    this.requireRoot();
    if (!DERIVATIVE_KEY.test(input.key) || !this.verifyCapability('preview', input.key, 'image/webp', 0, input.capability)) {
      throw new Error('Local media preview capability is invalid or expired.');
    }
    return this.readObject(input.key, MAX_MEDIA_UPLOAD_BYTES);
  }

  async deleteObject(key: string): Promise<void> {
    const filePath = await this.safePath(key, true);
    await Promise.all([fs.rm(filePath, { force: true }), fs.rm(`${filePath}.meta.json`, { force: true })]);
  }

  private async readMetadata(filePath: string): Promise<{ contentType: string; metadata: Record<string, string> }> {
    try {
      const metadataInfo = await fs.lstat(`${filePath}.meta.json`);
      if (!metadataInfo.isFile() || metadataInfo.isSymbolicLink() || metadataInfo.size > 4096) throw new Error('Invalid local media metadata.');
      const value = JSON.parse(await fs.readFile(`${filePath}.meta.json`, 'utf8')) as { contentType?: unknown; metadata?: unknown };
      if (typeof value.contentType !== 'string' || !isAllowedImage(value.contentType)
        || !value.metadata || typeof value.metadata !== 'object' || Array.isArray(value.metadata)) throw new Error('Invalid local media metadata.');
      return { contentType: value.contentType, metadata: value.metadata as Record<string, string> };
    } catch { throw new MediaStorageUnavailableError(); }
  }

  private async safePath(key: string, createParent: boolean): Promise<string> {
    const configuredRoot = this.requireRoot();
    await fs.mkdir(configuredRoot, { recursive: true, mode: 0o700 });
    const root = await fs.realpath(configuredRoot);
    assertOutsidePublic(root);
    const objectPath = localMediaObjectPath(root, key);
    const parent = path.dirname(objectPath);
    if (createParent) await fs.mkdir(parent, { recursive: true, mode: 0o700 });
    const realParent = await fs.realpath(parent).catch(() => null);
    if (!realParent || !isWithin(root, realParent)) throw new MediaStorageUnavailableError();
    return objectPath;
  }

  private requireRoot(): string {
    if (!this.root) throw new MediaStorageUnavailableError();
    return this.root;
  }

  private createCapability(kind: 'upload' | 'preview', key: string, contentType: string, byteLength: number, expiresAtMs: number): string {
    const payload = `${kind}:${key}:${contentType}:${byteLength}:${expiresAtMs}`;
    const signature = createHmac('sha256', this.secret).update(payload).digest('base64url');
    return `${expiresAtMs}.${signature}`;
  }

  private verifyCapability(kind: 'upload' | 'preview', key: string, contentType: string, byteLength: number, capability: string): boolean {
    if (typeof capability !== 'string' || capability.length > 128) return false;
    const [expiry, signature, ...extra] = capability.split('.');
    const expiresAtMs = Number(expiry);
    if (extra.length || !Number.isSafeInteger(expiresAtMs) || expiresAtMs <= this.now()
      || !/^[A-Za-z0-9_-]{43}$/.test(signature ?? '')) return false;
    const expected = createHmac('sha256', this.secret).update(`${kind}:${key}:${contentType}:${byteLength}:${expiresAtMs}`).digest();
    const supplied = Buffer.from(signature!, 'base64url');
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
  }
}

async function atomicWrite(filePath: string, bytes: Buffer): Promise<void> {
  const tempPath = `${filePath}.${randomUUID()}.tmp`;
  await fs.writeFile(tempPath, bytes, { flag: 'wx', mode: 0o600 });
  try {
    await fs.rename(tempPath, filePath);
  } catch (error) {
    await fs.rm(tempPath, { force: true });
    throw error;
  }
}

function parseObjectKey(key: string): { brandId: string; assetId: string; nonce: string | null } {
  const match = OBJECT_KEY.exec(key);
  if (!match || !UUID.test(match[1]) || !UUID.test(match[2])) throw new Error('Invalid local media object key.');
  const nonce = match[3]?.startsWith('incoming/') ? match[3].slice('incoming/'.length) : null;
  return { brandId: match[1], assetId: match[2], nonce };
}

function isAllowedImage(value: string): boolean {
  return value === 'image/jpeg' || value === 'image/png' || value === 'image/webp';
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function assertOutsidePublic(root: string): void {
  const publicRoot = path.resolve(process.cwd(), 'public');
  if (isWithin(publicRoot, root)) throw new Error('Local media storage must be outside public.');
}
