export const MAX_MEDIA_UPLOAD_BYTES = 10 * 1024 * 1024;
const ALLOWED_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

export interface MediaUploadInit {
  fileName: string;
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp';
  byteLength: number;
  rightsAttested: boolean;
  sha256: string | null;
}

export class MediaValidationError extends Error {
  readonly code = 'MEDIA_UPLOAD_INVALID';
  constructor() {
    super('The media upload request is invalid.');
    this.name = 'MediaValidationError';
  }
}

export function normalizeMediaUploadInit(value: unknown): MediaUploadInit {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new MediaValidationError();
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !['fileName', 'mimeType', 'byteLength', 'rightsAttested', 'sha256'].includes(key))) {
    throw new MediaValidationError();
  }
  if (typeof input.fileName !== 'string' || typeof input.mimeType !== 'string'
    || !ALLOWED_MIME_TYPES.has(input.mimeType) || !Number.isSafeInteger(input.byteLength)
    || Number(input.byteLength) < 1 || Number(input.byteLength) > MAX_MEDIA_UPLOAD_BYTES
    || typeof input.rightsAttested !== 'boolean'
    || (input.sha256 !== undefined && (typeof input.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(input.sha256)))) {
    throw new MediaValidationError();
  }
  const fileName = safeDisplayFileName(input.fileName);
  if (!fileName) throw new MediaValidationError();
  return {
    fileName,
    mimeType: input.mimeType as MediaUploadInit['mimeType'],
    byteLength: Number(input.byteLength),
    rightsAttested: input.rightsAttested,
    sha256: typeof input.sha256 === 'string' ? input.sha256.toLowerCase() : null,
  };
}

function safeDisplayFileName(fileName: string): string {
  const normalized = fileName.replaceAll('\\', '/').split('/').at(-1) ?? '';
  const safe = normalized.split('').filter((character) => {
    const code = character.charCodeAt(0);
    return code >= 0x20 && code !== 0x7f;
  }).join('').trim().slice(0, 160);
  return safe && safe !== '.' && safe !== '..' ? safe : '';
}

export function detectMediaMime(bytes: Buffer): MediaUploadInit['mimeType'] | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

export function isMediaAttachable(asset: {
  scanState: string;
  rightsState: string;
  derivativeState: string;
}): boolean {
  return asset.scanState === 'CLEAN'
    && ['ATTESTED', 'REVIEWED'].includes(asset.rightsState)
    && asset.derivativeState === 'READY';
}
