import { createHash } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import * as https from 'node:https';
import * as unzipper from 'unzipper';
import { detectMediaMime, MAX_MEDIA_UPLOAD_BYTES } from './media-validation';

export const MAX_MEDIA_ZIP_BYTES = 100 * 1024 * 1024;
export const MAX_MEDIA_ZIP_ENTRIES = 12_000;
export const MAX_MEDIA_ZIP_EXPANDED_BYTES = 1024 * 1024 * 1024;
export const MAX_MEDIA_ZIP_RATIO = 100;
export const MAX_MEDIA_ZIP_CONCURRENCY = 4;

export class MediaZipIngestionError extends Error {
  constructor(readonly code: string, readonly retryable = false) { super('The media archive or source URL could not be safely processed.'); this.name = 'MediaZipIngestionError'; }
}

export interface MediaZipImage {
  brandId: string;
  batchId: string;
  productId: string;
  variantId: string;
  sku: string;
  slot: number;
  archivePath: string;
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp';
  bytes: Buffer;
  sha256: string;
  /** Stable source identity; for remote media this is the normalized source URL digest. */
  sourceSha256?: string;
  effectKey: string;
}

export interface MediaZipIngestionInput {
  bytes: Buffer;
  brandId: string;
  batchId: string;
  /** Immutable SKU -> product ID manifest pinned when the batch is accepted. */
  manifest: Readonly<Record<string, { productId: string; variantId: string }>>;
  /** Must resolve all requested variant/product/SKU triples from authoritative rows under brandId. */
  resolveProducts(brandId: string, mappings: Readonly<Record<string, { productId: string; variantId: string }>>):
    Promise<Readonly<Record<string, { brandId: string; productId: string; variantId: string; sku: string }>>>;
  /** Persist image effects and per-image receipt/audit atomically; retries must honor effectKey. */
  processImage(image: MediaZipImage): Promise<void>;
  concurrency?: number;
}

type PlannedEntry = { entry: unzipper.File; path: string; sku: string; slot: number; productId: string; variantId: string };

/**
 * Validate the entire archive and all brand-owned targets before applying any effects.
 * Image payloads are then streamed one at a time and only `concurrency` decoded buffers
 * can be live. The callback owns atomic effect receipt/audit persistence and idempotency.
 */
export async function ingestImageZip(input: MediaZipIngestionInput): Promise<{ processed: number }> {
  const concurrency = input.concurrency ?? MAX_MEDIA_ZIP_CONCURRENCY;
  if (!Buffer.isBuffer(input.bytes) || input.bytes.length < 4 || input.bytes.length > MAX_MEDIA_ZIP_BYTES
      || !isUuid(input.brandId) || !isUuid(input.batchId)
      || !Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > MAX_MEDIA_ZIP_CONCURRENCY) {
    throw new MediaZipIngestionError('MEDIA_ZIP_INVALID');
  }
  let directory: unzipper.CentralDirectory;
  try { directory = await unzipper.Open.buffer(input.bytes); }
  catch { throw new MediaZipIngestionError('MEDIA_ZIP_INVALID'); }
  if (directory.files.length === 0 || directory.files.length > MAX_MEDIA_ZIP_ENTRIES) {
    throw new MediaZipIngestionError('MEDIA_ZIP_LIMIT_EXCEEDED');
  }
  const paths = new Set<string>();
  const planned: PlannedEntry[] = [];
  const requestedMappings: Record<string, { productId: string; variantId: string }> = {};
  let expanded = 0;
  for (const entry of directory.files) {
    const path = entry.path;
    const normalized = path.replaceAll('\\', '/');
    if (!path || path.length > 512 || path.includes('\0') || normalized.startsWith('/') || normalized.startsWith('//')
      || /^[a-z]:/i.test(normalized) || normalized.split('/').some((part: string) => part === '..' || part === '.')
      || isSymbolicLink(entry)) throw new MediaZipIngestionError('MEDIA_ZIP_UNSAFE');
    if (entry.type === 'Directory') continue;
    const folded = normalized.normalize('NFC').toLocaleLowerCase('en-US');
    if (paths.has(folded)) throw new MediaZipIngestionError('MEDIA_ZIP_DUPLICATE_PATH');
    paths.add(folded);
    const size = Number(entry.uncompressedSize ?? 0);
    const compressed = Number(entry.compressedSize ?? 0);
    expanded += size;
    if (!Number.isSafeInteger(size) || size < 1 || size > MAX_MEDIA_UPLOAD_BYTES
      || expanded > MAX_MEDIA_ZIP_EXPANDED_BYTES || (compressed === 0 && size > 0)
      || (compressed > 0 && size / compressed > MAX_MEDIA_ZIP_RATIO)) {
      throw new MediaZipIngestionError('MEDIA_ZIP_LIMIT_EXCEEDED');
    }
    const basename = normalized.split('/').at(-1) ?? '';
    const match = /^([A-Za-z0-9][A-Za-z0-9._-]{0,127})__(\d{2})\.(jpe?g|png|webp)$/i.exec(basename);
    if (!match) throw new MediaZipIngestionError('MEDIA_ZIP_NAME_INVALID');
    const sku = match[1];
    const slot = Number(match[2]);
    if (slot < 1 || slot > 99) throw new MediaZipIngestionError('MEDIA_ZIP_NAME_INVALID');
    const mapping = input.manifest[sku] ?? input.manifest[sku.toLocaleUpperCase('en-US')];
    if (!mapping || !isUuid(mapping.productId) || !isUuid(mapping.variantId)) throw new MediaZipIngestionError('MEDIA_ZIP_MAPPING_REQUIRED');
    requestedMappings[sku.toLocaleUpperCase('en-US')] = mapping;
    planned.push({ entry, path: normalized, sku, slot, productId: mapping.productId, variantId: mapping.variantId });
  }
  if (planned.length === 0) throw new MediaZipIngestionError('MEDIA_ZIP_EMPTY');
  const resolvedMappings = await input.resolveProducts(input.brandId, requestedMappings);
  for (const [sku, mapping] of Object.entries(requestedMappings)) {
    const resolved = resolvedMappings[sku];
    if (!resolved || resolved.brandId !== input.brandId || resolved.productId !== mapping.productId
      || resolved.variantId !== mapping.variantId || resolved.sku.trim().toLocaleUpperCase('en-US') !== sku) {
      throw new MediaZipIngestionError('MEDIA_ZIP_TARGET_INVALID');
    }
  }
  planned.sort((a, b) => a.sku.localeCompare(b.sku, 'en-US') || a.slot - b.slot || a.path.localeCompare(b.path, 'en-US'));
  const slots = new Set<string>();
  for (const item of planned) {
    const slotKey = `${item.sku.toLocaleUpperCase('en-US')}#${item.slot}`;
    if (slots.has(slotKey)) throw new MediaZipIngestionError('MEDIA_ZIP_DUPLICATE_SLOT');
    slots.add(slotKey);
  }

  const groups: PlannedEntry[][] = [];
  for (const item of planned) {
    const lastGroup = groups.at(-1);
    if (lastGroup && lastGroup[0].sku.toLocaleUpperCase('en-US') === item.sku.toLocaleUpperCase('en-US')) lastGroup.push(item);
    else groups.push([item]);
  }
  let cursor = 0;
  let processed = 0;
  let firstFailure: unknown;
  const workers = Array.from({ length: Math.min(concurrency, groups.length) }, async () => {
    while (firstFailure === undefined) {
      const current = cursor++;
      if (current >= groups.length) return;
      for (const item of groups[current]) {
        if (firstFailure !== undefined) return;
        try {
        const chunks: Buffer[] = [];
        let actualLength = 0;
        for await (const chunk of item.entry.stream()) {
          const buffer = Buffer.from(chunk);
          actualLength += buffer.length;
          if (actualLength > MAX_MEDIA_UPLOAD_BYTES) throw new MediaZipIngestionError('MEDIA_ZIP_LIMIT_EXCEEDED');
          chunks.push(buffer);
        }
        const bytes = Buffer.concat(chunks, actualLength);
        const mimeType = detectMediaMime(bytes);
        if (!mimeType || bytes.length !== Number(item.entry.uncompressedSize) || !mimeMatches(item.path, mimeType)) {
          throw new MediaZipIngestionError('MEDIA_ZIP_IMAGE_INVALID');
        }
        const effectKey = createHash('sha256').update(`${input.brandId}\n${input.batchId}\n${item.productId}\n${item.sku.toLocaleUpperCase('en-US')}\n${item.slot}\n${item.path}`).digest('hex');
        const imageSha256 = createHash('sha256').update(bytes).digest('hex');
        await input.processImage({ brandId: input.brandId, batchId: input.batchId, productId: item.productId,
          variantId: item.variantId, sku: item.sku, slot: item.slot, archivePath: item.path, mimeType, bytes, sha256: imageSha256, effectKey });
        processed++;
        } catch (error) { firstFailure ??= error; return; }
      }
    }
  });
  await Promise.all(workers);
  if (firstFailure !== undefined) {
    if (firstFailure instanceof MediaZipIngestionError) throw firstFailure;
    throw new MediaZipIngestionError('MEDIA_ZIP_IMAGE_PROCESSING_FAILED', true);
  }
  return { processed };
}

export interface ResolvedPublicHttpsUrl { url: URL; address: string; }
export type DnsLookup = (hostname: string) => Promise<ReadonlyArray<{ address: string; family: number }>>;

export async function resolvePublicHttpsUrl(value: string, resolver: DnsLookup = async (host) => dnsLookup(host, { all: true, verbatim: true })):
Promise<ResolvedPublicHttpsUrl> {
  let url: URL;
  try { url = new URL(value); } catch { throw new MediaZipIngestionError('MEDIA_URL_UNSAFE'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port && url.port !== '443'
      || !url.hostname || url.hostname.endsWith('.') || url.hostname.includes('%')) {
    throw new MediaZipIngestionError('MEDIA_URL_UNSAFE');
  }
  const answers = await resolver(url.hostname).catch(() => []);
  if (answers.length === 0 || answers.some(({ address, family }) => family !== 4 || !isPublicIpv4(address))) {
    throw new MediaZipIngestionError('MEDIA_URL_UNSAFE');
  }
  return { url, address: answers[0].address };
}

export async function fetchPublicHttpsImage(value: string, options: {
  lookup?: DnsLookup;
  maxBytes?: number;
  request?: (url: URL, pinnedAddress: string, maxBytes: number) => Promise<{ statusCode: number; headers: Record<string, string | undefined>; body: Buffer }>;
} = {}): Promise<{ bytes: Buffer; mimeType: 'image/jpeg' | 'image/png' | 'image/webp' }> {
  const maxBytes = options.maxBytes ?? MAX_MEDIA_UPLOAD_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_MEDIA_UPLOAD_BYTES) throw new MediaZipIngestionError('MEDIA_URL_LIMIT_EXCEEDED');
  const target = await resolvePublicHttpsUrl(value, options.lookup);
  let response: { statusCode: number; headers: Record<string, string | undefined>; body: Buffer };
  try {
    response = await (options.request ?? requestPinnedHttps)(target.url, target.address, maxBytes);
  } catch (error) {
    if (error instanceof MediaZipIngestionError) {
      if (error.code === 'MEDIA_URL_TIMEOUT') throw new MediaZipIngestionError(error.code, true);
      throw error;
    }
    throw new MediaZipIngestionError('MEDIA_URL_RETRYABLE', true);
  }
  if (response.statusCode >= 300 && response.statusCode < 400) throw new MediaZipIngestionError('MEDIA_URL_REDIRECT_REJECTED');
  if (response.statusCode === 429 || response.statusCode >= 500) throw new MediaZipIngestionError('MEDIA_URL_RETRYABLE', true);
  if (response.statusCode !== 200) throw new MediaZipIngestionError('MEDIA_URL_FETCH_FAILED');
  if (response.body.length > maxBytes) throw new MediaZipIngestionError('MEDIA_URL_LIMIT_EXCEEDED');
  const mimeType = detectMediaMime(response.body);
  if (!mimeType || response.headers['content-type']?.split(';', 1)[0].trim().toLowerCase() !== mimeType) {
    throw new MediaZipIngestionError('MEDIA_URL_IMAGE_INVALID');
  }
  return { bytes: response.body, mimeType };
}

function requestPinnedHttps(url: URL, address: string, maxBytes: number): Promise<{ statusCode: number; headers: Record<string, string | undefined>; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const request = https.request({ protocol: 'https:', hostname: url.hostname, port: 443, method: 'GET', path: `${url.pathname}${url.search}`,
      servername: url.hostname, timeout: 10_000,
      lookup: (_hostname, _options, callback) => callback(null, address, 4),
      headers: { Accept: 'image/jpeg,image/png,image/webp', 'User-Agent': 'Renivet-Media-Importer/1' },
    }, (response) => {
      if (response.statusCode !== 200) { response.resume(); resolve({ statusCode: response.statusCode ?? 0, headers: { 'content-type': headerString(response.headers['content-type']) }, body: Buffer.alloc(0) }); return; }
      const declaredLength = Number(response.headers['content-length'] ?? 0);
      if (declaredLength > maxBytes) { request.destroy(new MediaZipIngestionError('MEDIA_URL_LIMIT_EXCEEDED')); return; }
      const chunks: Buffer[] = [];
      let total = 0;
      response.on('data', (chunk: Buffer) => {
        total += chunk.length;
        if (total > maxBytes) request.destroy(new MediaZipIngestionError('MEDIA_URL_LIMIT_EXCEEDED'));
        else chunks.push(Buffer.from(chunk));
      });
      response.on('end', () => resolve({ statusCode: 200, headers: { 'content-type': headerString(response.headers['content-type']) }, body: Buffer.concat(chunks, total) }));
    });
    request.on('timeout', () => request.destroy(new MediaZipIngestionError('MEDIA_URL_TIMEOUT', true)));
    request.on('error', reject);
    request.end();
  });
}

function mimeMatches(path: string, mime: string | null): boolean {
  const extension = path.toLowerCase().split('.').at(-1);
  return mime === 'image/jpeg' ? extension === 'jpg' || extension === 'jpeg'
    : mime === 'image/png' ? extension === 'png' : mime === 'image/webp' ? extension === 'webp' : false;
}

function isPublicIpv4(value: string): boolean {
  const parts = value.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b, c] = parts;
  if (a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
    || (a === 192 && b === 0 && c === 0) || (a === 192 && b === 0 && c === 2) || (a === 192 && b === 88 && c === 99)
    || (a === 198 && (b === 18 || b === 19)) || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113)) return false;
  return true;
}

function isUuid(value: string): boolean { return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }
function isSymbolicLink(entry: unzipper.File): boolean {
  const hostSystem = entry.versionMadeBy >> 8;
  const unixMode = entry.externalFileAttributes >>> 16;
  return hostSystem === 3 && (unixMode & 0o170000) === 0o120000;
}
function headerString(value: string | string[] | undefined): string | undefined { return Array.isArray(value) ? value[0] : value; }
