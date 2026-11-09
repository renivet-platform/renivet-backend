import { createHash, randomUUID } from 'node:crypto';
import { MediaDerivative, MediaImageProcessorPort, MediaScannerPort, MediaStoragePort } from './media-ports';
import { Injectable } from '@nestjs/common';
import { InvalidMediaImageError } from './sharp-media-image-processor';
import { MediaStorageUnavailableError, mediaObjectKey } from './spaces-media-storage';
import { MAX_MEDIA_UPLOAD_BYTES, MediaUploadInit, MediaValidationError, detectMediaMime, normalizeMediaUploadInit } from './media-validation';
import type { MediaZipImage } from './media-zip-ingestion';

export interface MediaAccessContext {
  brandId: string;
  userId: string;
  permission: string;
  requestId: string;
}

export interface MediaMutationContext extends MediaAccessContext {
  idempotencyKey: string;
}

export interface MediaAssetRecord {
  id: string;
  brandId: string;
  storageKey: string;
  uploadKey: string;
  mimeType: string;
  fileName: string;
  byteLength: number;
  expectedSha256: string | null;
  scanState: 'PENDING' | 'CLEAN' | 'REJECTED';
  rightsState: 'UNVERIFIED' | 'ATTESTED' | 'REVIEWED' | 'REVOKED';
  derivativeState: 'PENDING' | 'READY' | 'FAILED';
  uploadExpiresAt: string;
  sha256: string | null;
  width: number | null;
  height: number | null;
  rejectionCode: string | null;
  completionIdempotencyKey?: string | null;
  completionRequestSha256?: string | null;
  rowVersion?: number;
}

export interface MediaRepositoryPort {
  createIntent(input: {
    assetId: string;
    storageKey: string;
    uploadKey: string;
    request: MediaUploadInit;
    requestSha256: string;
    context: MediaMutationContext;
  }): Promise<MediaAssetRecord>;
  getForComplete(mediaId: string, context: MediaMutationContext): Promise<MediaAssetRecord>;
  markRejected(input: {
    asset: MediaAssetRecord;
    context: MediaMutationContext;
    reasonCode: string;
    sha256: string | null;
    completionRequestSha256: string;
  }): Promise<MediaAssetRecord>;
  markClean(input: {
    asset: MediaAssetRecord;
    context: MediaMutationContext;
    sha256: string;
    width: number;
    height: number;
    derivatives: MediaDerivative[];
    completionRequestSha256: string;
  }): Promise<MediaAssetRecord>;
  getStatus(mediaId: string, context: MediaAccessContext): Promise<MediaAssetRecord>;
}

export class MediaServiceError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = 'MediaServiceError';
  }
}

@Injectable()
export class MediaService {
  constructor(
    private readonly repository: MediaRepositoryPort,
    private readonly storage: MediaStoragePort,
    private readonly scanner: MediaScannerPort,
    private readonly processor: MediaImageProcessorPort,
    private readonly now: () => number = Date.now,
    private readonly newId: () => string = randomUUID,
  ) {}

  async begin(value: unknown, context: MediaMutationContext): Promise<Record<string, unknown>> {
    const request = this.normalizeUpload(value);
    this.validateIdempotencyKey(context.idempotencyKey);
    if (!this.storage.isConfigured()) throw this.unavailable('MEDIA_STORAGE_UNAVAILABLE', 'Media storage is not configured.');
    if (!this.scanner.isConfigured()) throw this.unavailable('MEDIA_SCANNER_UNAVAILABLE', 'Media malware scanning is not configured.');
    const assetId = this.newId();
    const nonce = this.newId();
    const storageKey = mediaObjectKey(context.brandId, assetId, 'original');
    const uploadKey = mediaObjectKey(context.brandId, assetId, 'incoming', nonce);
    const requestSha256 = digest(request);
    const asset = await this.repository.createIntent({ assetId, storageKey, uploadKey, request, requestSha256, context });
    if (asset.scanState !== 'PENDING' || new Date(asset.uploadExpiresAt).getTime() <= this.now()) {
      throw new MediaServiceError(409, 'MEDIA_UPLOAD_INTENT_EXPIRED', 'The media upload intent must be renewed.');
    }
    try {
      const intent = await this.storage.createUploadIntent({
        key: asset.uploadKey, mimeType: asset.mimeType, byteLength: asset.byteLength, brandId: asset.brandId,
        assetId: asset.id, expiresAt: asset.uploadExpiresAt,
      });
      return { mediaAssetId: asset.id, uploadMethod: 'PUT', ...intent };
    } catch (error) {
      if (error instanceof MediaStorageUnavailableError) throw this.unavailable('MEDIA_STORAGE_UNAVAILABLE', error.message);
      throw this.unavailable('MEDIA_STORAGE_UNAVAILABLE', 'Media storage could not issue an upload URL.');
    }
  }

  /** Internal, idempotent path used only by an authorized media ZIP worker. */
  async ingestZipImage(image: MediaZipImage, context: MediaMutationContext): Promise<{ mediaAssetId: string }> {
    this.validateIdempotencyKey(context.idempotencyKey);
    if (image.brandId !== context.brandId || !image.bytes.length || image.bytes.length > MAX_MEDIA_UPLOAD_BYTES
      || detectMediaMime(image.bytes) !== image.mimeType || !/^[a-f0-9]{64}$/.test(image.effectKey)) {
      throw new MediaServiceError(422, 'MEDIA_ZIP_IMAGE_INVALID', 'The media image failed validation.');
    }
    if (!this.storage.isConfigured()) throw this.unavailable('MEDIA_STORAGE_UNAVAILABLE', 'Media storage is not configured.');
    if (!this.scanner.isConfigured()) throw this.unavailable('MEDIA_SCANNER_UNAVAILABLE', 'Media malware scanning is not configured.');
    const assetId = effectKeyToUuid(image.effectKey);
    const sha256 = digest(image.bytes);
    const request: MediaUploadInit = { fileName: image.archivePath.split('/').at(-1) ?? 'image', mimeType: image.mimeType,
      byteLength: image.bytes.length, rightsAttested: true, sha256 };
    const requestSha256 = digest(request);
    const asset = await this.repository.createIntent({ assetId,
      storageKey: mediaObjectKey(context.brandId, assetId, 'original'),
      uploadKey: mediaObjectKey(context.brandId, assetId, 'incoming', assetId), request, requestSha256, context });
    if (asset.scanState === 'CLEAN' && asset.derivativeState === 'READY' && asset.rightsState === 'ATTESTED') return { mediaAssetId: asset.id };
    if (asset.scanState === 'REJECTED') throw this.rejected(asset.rejectionCode ?? 'MEDIA_REJECTED');
    if (asset.expectedSha256 && asset.expectedSha256 !== sha256) throw new MediaServiceError(409, 'MEDIA_IDEMPOTENCY_CONFLICT', 'The media image conflicts with its saved upload.');
    let scan: 'CLEAN' | 'INFECTED';
    try { scan = await this.scanner.scan(image.bytes); }
    catch { throw this.unavailable('MEDIA_SCANNER_UNAVAILABLE', 'Media malware scanning is temporarily unavailable.'); }
    const completionRequestSha256 = digest({ sha256, sizeBytes: image.bytes.length });
    if (scan !== 'CLEAN') return this.reject(asset, context, 'MEDIA_MALWARE_REJECTED', 'MALWARE_DETECTED', sha256, completionRequestSha256);
    let derivatives: MediaDerivative[];
    try { derivatives = await this.processor.createDerivatives(image.bytes, image.mimeType, asset.brandId, asset.id); }
    catch (error) {
      if (error instanceof InvalidMediaImageError) return this.reject(asset, context, 'MEDIA_IMAGE_INVALID', 'INVALID_IMAGE', sha256, completionRequestSha256);
      throw this.unavailable('MEDIA_DERIVATIVE_UNAVAILABLE', 'Media derivatives could not be created.');
    }
    try {
      await this.storage.putPrivateObject({ key: asset.storageKey, bytes: image.bytes, mimeType: image.mimeType, brandId: asset.brandId, assetId: asset.id });
      for (const derivative of derivatives) await this.storage.putPrivateObject({ key: derivative.key, bytes: derivative.bytes,
        mimeType: derivative.mimeType, brandId: asset.brandId, assetId: asset.id });
    } catch { throw this.unavailable('MEDIA_STORAGE_UNAVAILABLE', 'Verified media could not be stored privately.'); }
    const clean = await this.repository.markClean({ asset, context, sha256, width: derivatives[0]?.width ?? 1,
      height: derivatives[0]?.height ?? 1, derivatives, completionRequestSha256 });
    await this.storage.deleteObject(asset.uploadKey).catch(() => undefined);
    return { mediaAssetId: clean.id };
  }

  async complete(mediaId: string, value: unknown, context: MediaMutationContext): Promise<Record<string, unknown>> {
    this.validateIdempotencyKey(context.idempotencyKey);
    const request = this.normalizeComplete(value);
    const requestSha256 = digest(request);
    const asset = await this.repository.getForComplete(mediaId, context);
    if (asset.scanState !== 'PENDING') {
      this.assertTerminalReplay(asset, context, requestSha256, request);
      if (asset.scanState === 'REJECTED') throw this.rejected(asset.rejectionCode ?? 'MEDIA_REJECTED');
      return this.receipt(asset, context);
    }
    if (new Date(asset.uploadExpiresAt).getTime() <= this.now()) {
      throw new MediaServiceError(409, 'MEDIA_UPLOAD_EXPIRED', 'The signed upload window has expired.');
    }
    if (!this.storage.isConfigured()) throw this.unavailable('MEDIA_STORAGE_UNAVAILABLE', 'Media storage is not configured.');
    if (!this.scanner.isConfigured()) throw this.unavailable('MEDIA_SCANNER_UNAVAILABLE', 'Media malware scanning is not configured.');
    if (request.sizeBytes !== asset.byteLength) return this.reject(asset, context, 'MEDIA_OBJECT_MISMATCH', 'SIZE_MISMATCH', null, requestSha256);

    let object: Buffer;
    try {
      const metadata = await this.storage.headObject(asset.uploadKey);
      if (metadata.contentLength !== asset.byteLength || metadata.contentType?.toLowerCase() !== asset.mimeType
        || metadata.metadata['renivet-brand-id'] !== asset.brandId
        || metadata.metadata['renivet-media-asset-id'] !== asset.id) {
        return this.reject(asset, context, 'MEDIA_OBJECT_MISMATCH', 'OBJECT_METADATA_MISMATCH', null, requestSha256);
      }
      object = await this.storage.readObject(asset.uploadKey, MAX_MEDIA_UPLOAD_BYTES);
    } catch (error) {
      if (isMissingObject(error)) throw new MediaServiceError(409, 'MEDIA_UPLOAD_OBJECT_NOT_FOUND', 'The uploaded media object is not available yet.');
      throw this.unavailable('MEDIA_STORAGE_UNAVAILABLE', 'The uploaded media object could not be read.');
    }
    if (object.length !== asset.byteLength || object.length !== request.sizeBytes) {
      return this.reject(asset, context, 'MEDIA_OBJECT_MISMATCH', 'SIZE_MISMATCH', null, requestSha256);
    }
    const actualSha256 = digest(object);
    const detectedMime = detectMediaMime(object);
    if (detectedMime !== asset.mimeType || actualSha256 !== request.sha256
      || (asset.expectedSha256 !== null && asset.expectedSha256 !== actualSha256)) {
      return this.reject(asset, context, 'MEDIA_OBJECT_MISMATCH', 'CONTENT_MISMATCH', actualSha256, requestSha256);
    }

    let scan: 'CLEAN' | 'INFECTED';
    try { scan = await this.scanner.scan(object); }
    catch { throw this.unavailable('MEDIA_SCANNER_UNAVAILABLE', 'Media malware scanning is temporarily unavailable.'); }
    if (scan === 'INFECTED') return this.reject(asset, context, 'MEDIA_MALWARE_REJECTED', 'MALWARE_DETECTED', actualSha256, requestSha256);

    let derivatives: MediaDerivative[];
    try { derivatives = await this.processor.createDerivatives(object, asset.mimeType, asset.brandId, asset.id); }
    catch (error) {
      if (error instanceof InvalidMediaImageError) return this.reject(asset, context, 'MEDIA_IMAGE_INVALID', 'INVALID_IMAGE', actualSha256, requestSha256);
      throw this.unavailable('MEDIA_DERIVATIVE_UNAVAILABLE', 'Media derivatives could not be created.');
    }
    try {
      await this.storage.putPrivateObject({ key: asset.storageKey, bytes: object, mimeType: asset.mimeType, brandId: asset.brandId, assetId: asset.id });
      for (const derivative of derivatives) {
        await this.storage.putPrivateObject({ key: derivative.key, bytes: derivative.bytes, mimeType: derivative.mimeType, brandId: asset.brandId, assetId: asset.id });
      }
    } catch {
      throw this.unavailable('MEDIA_STORAGE_UNAVAILABLE', 'Verified media could not be stored privately.');
    }

    let clean: MediaAssetRecord;
    try {
      clean = await this.repository.markClean({ asset, context, sha256: actualSha256,
        width: derivatives[0]?.width ?? 1, height: derivatives[0]?.height ?? 1, derivatives, completionRequestSha256: requestSha256 });
    } catch (error) {
      if (error instanceof MediaServiceError) throw error;
      const candidate = error as { status?: unknown; code?: unknown; message?: unknown };
      if (typeof candidate?.status === 'number' && typeof candidate.code === 'string') {
        throw new MediaServiceError(candidate.status, candidate.code,
          typeof candidate.message === 'string' ? candidate.message : 'The media request could not be completed.');
      }
      throw this.unavailable('MEDIA_DATABASE_UNAVAILABLE', 'Media status could not be saved; completion can be retried safely.');
    }
    await this.storage.deleteObject(asset.uploadKey).catch(() => undefined);
    return this.receipt(clean, context);
  }

  async status(mediaId: string, context: MediaAccessContext): Promise<Record<string, unknown>> {
    const asset = await this.repository.getStatus(mediaId, context);
    let safePreviewUrl: string | null = null;
    if (asset.scanState === 'CLEAN' && asset.derivativeState === 'READY' && this.storage.isConfigured()) {
      try { safePreviewUrl = await this.storage.createPreviewUrl(mediaObjectKey(asset.brandId, asset.id, 'preview')); }
      catch { safePreviewUrl = null; }
    }
    return { id: asset.id, scanState: asset.scanState, rightsState: asset.rightsState,
      derivativeState: asset.derivativeState, safePreviewUrl };
  }

  private async reject(asset: MediaAssetRecord, context: MediaMutationContext, code: string, reasonCode: string,
    sha256: string | null, completionRequestSha256: string): Promise<never> {
    try { await this.repository.markRejected({ asset, context, reasonCode, sha256, completionRequestSha256 }); }
    catch (error) {
      const candidate = error as { status?: unknown; code?: unknown; message?: unknown };
      if (typeof candidate?.status === 'number' && typeof candidate.code === 'string') {
        throw new MediaServiceError(candidate.status, candidate.code,
          typeof candidate.message === 'string' ? candidate.message : 'The media request could not be completed.');
      }
      throw this.unavailable('MEDIA_DATABASE_UNAVAILABLE', 'Rejected media status could not be saved.');
    }
    await this.storage.deleteObject(asset.uploadKey).catch(() => undefined);
    throw this.rejected(code);
  }

  private receipt(asset: MediaAssetRecord, context: MediaMutationContext): Record<string, unknown> {
    return { id: asset.id, status: asset.scanState, requestId: context.requestId, rowVersion: asset.rowVersion ?? 1 };
  }

  private assertTerminalReplay(asset: MediaAssetRecord, context: MediaMutationContext, requestSha256: string,
    request: { sha256: string; sizeBytes: number }): void {
    const sameKey = asset.completionIdempotencyKey === context.idempotencyKey;
    if ((sameKey && asset.completionRequestSha256 !== requestSha256)
      || asset.byteLength !== request.sizeBytes
      || (!sameKey && asset.sha256 !== null && asset.sha256 !== request.sha256)) {
      throw new MediaServiceError(409, 'MEDIA_IDEMPOTENCY_CONFLICT', 'The media completion request conflicts with its original result.');
    }
  }

  private normalizeUpload(value: unknown): MediaUploadInit {
    try { return normalizeMediaUploadInit(value); }
    catch (error) {
      if (error instanceof MediaValidationError) throw new MediaServiceError(422, error.code, error.message);
      throw error;
    }
  }

  private normalizeComplete(value: unknown): { sha256: string; sizeBytes: number } {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new MediaServiceError(422, 'MEDIA_UPLOAD_INVALID', 'The media completion request is invalid.');
    const input = value as Record<string, unknown>;
    if (Object.keys(input).some((key) => !['sha256', 'sizeBytes'].includes(key)) || typeof input.sha256 !== 'string'
      || !/^[a-f0-9]{64}$/i.test(input.sha256) || !Number.isSafeInteger(input.sizeBytes)
      || Number(input.sizeBytes) < 1 || Number(input.sizeBytes) > MAX_MEDIA_UPLOAD_BYTES) {
      throw new MediaServiceError(422, 'MEDIA_UPLOAD_INVALID', 'The media completion request is invalid.');
    }
    return { sha256: input.sha256.toLowerCase(), sizeBytes: Number(input.sizeBytes) };
  }

  private validateIdempotencyKey(value: string): void {
    if (!value || !/^[A-Za-z0-9._:-]{1,120}$/.test(value)) throw new MediaServiceError(422, 'MEDIA_UPLOAD_INVALID', 'A valid idempotency key is required.');
  }

  private unavailable(code: string, message: string): MediaServiceError { return new MediaServiceError(503, code, message); }
  private rejected(code: string): MediaServiceError { return new MediaServiceError(422, code, 'The uploaded media failed validation and cannot be used.'); }
}

function digest(value: unknown): string {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
  return createHash('sha256').update(bytes).digest('hex');
}

function effectKeyToUuid(value: string): string {
  const bytes = Buffer.from(value.slice(0, 32), 'hex');
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}

function isMissingObject(error: unknown): boolean {
  const value = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return value?.name === 'NoSuchKey' || value?.$metadata?.httpStatusCode === 404;
}
