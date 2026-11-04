export const MEDIA_STORAGE = Symbol('MEDIA_STORAGE');
export const MEDIA_SCANNER = Symbol('MEDIA_SCANNER');
export const MEDIA_IMAGE_PROCESSOR = Symbol('MEDIA_IMAGE_PROCESSOR');

export interface MediaUploadIntentResult {
  uploadUrl: string;
  expiresAt: string;
  headers: Record<string, string>;
}

export interface MediaObjectMetadata {
  contentLength: number;
  contentType: string | undefined;
  metadata: Record<string, string | undefined>;
}

export interface MediaDerivative {
  kind: 'PREVIEW' | 'THUMBNAIL';
  key: string;
  bytes: Buffer;
  sha256: string;
  width: number;
  height: number;
  mimeType: 'image/webp';
}

export interface MediaStoragePort {
  isConfigured(): boolean;
  createUploadIntent(input: { key: string; mimeType: string; byteLength: number; brandId: string; assetId: string; expiresAt?: string }): Promise<MediaUploadIntentResult>;
  headObject(key: string): Promise<MediaObjectMetadata>;
  readObject(key: string, maxBytes: number): Promise<Buffer>;
  putPrivateObject(input: { key: string; bytes: Buffer; mimeType: string; brandId: string; assetId: string }): Promise<void>;
  createPreviewUrl(key: string): Promise<string>;
  deleteObject(key: string): Promise<void>;
}

export interface MediaScannerPort {
  isConfigured(): boolean;
  scan(bytes: Buffer): Promise<'CLEAN' | 'INFECTED'>;
}

export interface MediaImageProcessorPort {
  createDerivatives(input: Buffer, mimeType: string, brandId: string, assetId: string): Promise<MediaDerivative[]>;
}
