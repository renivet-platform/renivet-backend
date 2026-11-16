import { createHmac, timingSafeEqual } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function localImportStorageRoot(config: Record<string, unknown>): string | null {
  if (config.NODE_ENV !== 'development' || config.RENIVET_LOCAL_IMPORT_STORAGE_ENABLED !== true) return null;
  const configured = typeof config.RENIVET_LOCAL_IMPORT_STORAGE_DIR === 'string' && config.RENIVET_LOCAL_IMPORT_STORAGE_DIR.trim()
    ? config.RENIVET_LOCAL_IMPORT_STORAGE_DIR.trim()
    : path.join(os.tmpdir(), 'renivet-imports');
  return path.resolve(configured);
}

export function localImportObjectPath(root: string | null, brandId: string, uploadId: string): string {
  if (!root || !UUID.test(brandId) || !UUID.test(uploadId)) throw new Error('Invalid local import storage identity.');
  const resolvedRoot = path.resolve(root);
  const objectPath = path.resolve(resolvedRoot, 'brands', brandId, 'imports', uploadId, 'source');
  const relative = path.relative(resolvedRoot, objectPath);
  if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('Invalid local import storage path.');
  return objectPath;
}

function tokenPayload(brandId: string, uploadId: string, sha256: string, expiresAtMs: number): string {
  return `${brandId}:${uploadId}:${sha256}:${expiresAtMs}`;
}

export function createLocalUploadToken(secret: string, brandId: string, uploadId: string, sha256: string, expiresAtMs: number): string {
  const payload = tokenPayload(brandId, uploadId, sha256, expiresAtMs);
  const signature = createHmac('sha256', secret).update(payload).digest('base64url');
  return `${expiresAtMs}.${signature}`;
}

export function verifyLocalUploadToken(secret: string, token: string, brandId: string, uploadId: string, sha256: string, nowMs = Date.now()): boolean {
  const [expiry, signature] = token.split('.', 2);
  const expiresAtMs = Number(expiry);
  if (!Number.isSafeInteger(expiresAtMs) || expiresAtMs <= nowMs || !/^[A-Za-z0-9_-]{43}$/.test(signature ?? '')) return false;
  const expected = createHmac('sha256', secret).update(tokenPayload(brandId, uploadId, sha256, expiresAtMs)).digest('base64url');
  return timingSafeEqual(Buffer.from(signature!, 'utf8'), Buffer.from(expected, 'utf8'));
}
