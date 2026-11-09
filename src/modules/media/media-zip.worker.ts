import { createHash } from 'node:crypto';
import type { EventHandler } from '../../workers/durable-worker';
import type { WorkerAuthorizationContext } from '../../workers/worker-authorization';
import { MediaService, MediaServiceError } from './media.service';
import { MediaStoragePort } from './media-ports';
import { MediaZipBatchRecord, MediaZipPostgresRepository } from './media-zip.repository';
import { fetchPublicHttpsImage, MediaZipImage, MediaZipIngestionError, ingestImageZip, MAX_MEDIA_ZIP_BYTES, MAX_MEDIA_ZIP_CONCURRENCY } from './media-zip-ingestion';
import { ProductMediaError } from './product-media.service';

export interface MediaZipWorkerDependencies {
  repository: MediaZipPostgresRepository;
  media: MediaService;
  storage: MediaStoragePort;
  fetchRemote?: (url: string) => Promise<{ bytes: Buffer; mimeType: 'image/jpeg' | 'image/png' | 'image/webp' }>;
}

/** Dormant durable consumer. Register only with the approved worker principal and runner. */
export function createMediaZipImportHandler(dependencies: MediaZipWorkerDependencies): EventHandler {
  return {
    consumerId: 'media.zip_import',
    eventTypes: ['media.zip_import.requested'],
    authorization: { scope: 'brand', purpose: 'media.zip_import', effects: ['media.asset.create', 'media.product_media.attach'] },
    async handle(event, transaction, authorization?: WorkerAuthorizationContext): Promise<void> {
      const payload = isRecord(event.eventPayload) ? event.eventPayload : {};
      const batchId = event.aggregateId;
      if (event.aggregateType !== 'media.zip_import' || typeof payload.batchId !== 'string' || payload.batchId !== batchId
        || typeof payload.brandId !== 'string' || !authorization || payload.brandId !== authorization.brandId) {
        throw new MediaZipIngestionError('MEDIA_ZIP_EVENT_INVALID');
      }
      const batch = await dependencies.repository.loadBatch(batchId, transaction);
      if (!batch || batch.brandId !== authorization.brandId) throw new MediaZipIngestionError('MEDIA_ZIP_BATCH_NOT_FOUND');
      if (['PARTIAL','SUCCEEDED','FAILED'].includes(batch.state)) return;
      await dependencies.repository.markProcessing?.(batch.id);
      const processImage = async (image: MediaZipImage) => {
        await authorization.authorizeEffect('media.asset.create', batch.brandId);
        await authorization.authorizeEffect('media.product_media.attach', batch.brandId);
        const key = `zip:${batch.id}:${image.effectKey}`;
        const mutation = { brandId: batch.brandId, userId: batch.rightsAttestedBy, permission: 'media.write', requestId: `media-zip:${batch.id}`, idempotencyKey: key };
        const association = { brandId: batch.brandId, userId: batch.createdBy, permission: 'catalog.write', requestId: `media-zip:${batch.id}`, idempotencyKey: key };
        try {
          const asset = await dependencies.media.ingestZipImage(image, mutation);
          await dependencies.repository.attachEffect(image, asset.mediaAssetId, association);
        } catch (error) {
          const status = error instanceof MediaServiceError || error instanceof ProductMediaError ? error.status : undefined;
          if (status === 404 || status === 409 || status === 422) {
            const code = error instanceof MediaServiceError || error instanceof ProductMediaError ? error.code : 'MEDIA_ZIP_IMAGE_REJECTED';
            await dependencies.repository.recordRejectedEffect(image, code, association);
            return;
          }
          throw error;
        }
      };
      try {
      if (batch.sourceKind === 'MEDIA_ZIP') {
        if (!batch.fileUploadId || !batch.byteLength || !batch.sha256) throw new MediaZipIngestionError('MEDIA_ZIP_UPLOAD_MISMATCH');
        const metadata = await dependencies.storage.headObject(batch.storageKey);
        if (metadata.contentLength !== batch.byteLength || metadata.contentType?.toLowerCase() !== 'application/zip'
          || metadata.metadata['renivet-brand-id'] !== batch.brandId
          || metadata.metadata['renivet-import-upload-id'] !== batch.fileUploadId
          || metadata.metadata['renivet-sha256'] !== batch.sha256) {
          throw new MediaZipIngestionError('MEDIA_ZIP_UPLOAD_MISMATCH');
        }
        const bytes = await dependencies.storage.readObject(batch.storageKey, MAX_MEDIA_ZIP_BYTES);
        if (bytes.length !== batch.byteLength || createHash('sha256').update(bytes).digest('hex') !== batch.sha256) {
          throw new MediaZipIngestionError('MEDIA_ZIP_UPLOAD_MISMATCH');
        }
        await ingestImageZip({ bytes, brandId: batch.brandId, batchId: batch.id, manifest: batch.manifest,
          resolveProducts: (brandId, mappings) => dependencies.repository.resolveProducts(brandId, mappings), processImage });
      } else {
        const remoteImages = batch.remoteImages ?? [];
        if (remoteImages.length === 0 || remoteImages.length > 12_000) throw new MediaZipIngestionError('MEDIA_URL_LIMIT_EXCEEDED');
        const requested: Record<string, { productId: string; variantId: string }> = {};
        for (const item of remoteImages) {
          const mapping = batch.manifest[item.sku.toUpperCase()];
          if (!mapping) throw new MediaZipIngestionError('MEDIA_ZIP_MAPPING_REQUIRED');
          requested[item.sku.toUpperCase()] = mapping;
        }
        const resolved = await dependencies.repository.resolveProducts(batch.brandId, requested);
        for (const [sku, mapping] of Object.entries(requested)) {
          const target = resolved[sku];
          if (!target || target.brandId !== batch.brandId || target.productId !== mapping.productId || target.variantId !== mapping.variantId
            || target.sku.trim().toUpperCase() !== sku) throw new MediaZipIngestionError('MEDIA_ZIP_TARGET_INVALID');
        }
        await processRemoteItems(remoteImages, batch, dependencies.fetchRemote ?? fetchPublicHttpsImage, processImage,
          async (image, code) => {
            await authorization.authorizeEffect('media.asset.create', batch.brandId);
            await authorization.authorizeEffect('media.product_media.attach', batch.brandId);
            await dependencies.repository.recordRejectedEffect(image, code,
              { brandId: batch.brandId, userId: batch.createdBy, permission: 'catalog.write', requestId: `media-zip:${batch.id}`, idempotencyKey: `zip:${batch.id}:${image.effectKey}` });
          });
      }
      await dependencies.repository.finishBatch(batch.id, transaction);
      } catch (error) {
        if (error instanceof MediaZipIngestionError && !error.retryable) {
          await dependencies.repository.markFailed?.(batch.id, error.code);
          return;
        }
        await dependencies.repository.returnToQueue?.(batch.id);
        throw error;
      }
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function processRemoteItems(items: MediaZipBatchRecord['remoteImages'], batch: MediaZipBatchRecord,
  fetchRemote: NonNullable<MediaZipWorkerDependencies['fetchRemote']>, processImage: (image: MediaZipImage) => Promise<void>,
  rejectImage: (image: MediaZipImage, code: string) => Promise<void>): Promise<void> {
  const sorted = [...items].sort((a, b) => a.sku.localeCompare(b.sku, 'en-US') || a.slot - b.slot);
  const groups: typeof sorted[] = [];
  for (const item of sorted) {
    const group = groups.at(-1);
    if (group && group[0].sku.toUpperCase() === item.sku.toUpperCase()) group.push(item);
    else groups.push([item]);
  }
  let cursor = 0;
  let firstFailure: unknown;
  const workers = Array.from({ length: Math.min(MAX_MEDIA_ZIP_CONCURRENCY, groups.length) }, async () => {
    while (firstFailure === undefined) {
      const index = cursor++;
      if (index >= groups.length) return;
      for (const item of groups[index]) {
        if (firstFailure !== undefined) return;
        const mapping = batch.manifest[item.sku.toUpperCase()];
        if (!mapping) { firstFailure = new MediaZipIngestionError('MEDIA_ZIP_MAPPING_REQUIRED'); return; }
        const archivePath = `remote:${item.sourceUrlSha256}`;
        const effectKey = createHash('sha256').update(`${batch.brandId}\n${batch.id}\n${mapping.productId}\n${item.sku.toUpperCase()}\n${item.slot}\n${archivePath}`).digest('hex');
        const placeholder: MediaZipImage = { brandId: batch.brandId, batchId: batch.id, productId: mapping.productId, variantId: mapping.variantId,
          sku: item.sku, slot: item.slot, archivePath, mimeType: 'image/jpeg', bytes: Buffer.alloc(0), sha256: item.sourceUrlSha256,
          sourceSha256: item.sourceUrlSha256, effectKey };
        try {
          const fetched = await fetchRemote(item.url);
          const image: MediaZipImage = { ...placeholder, mimeType: fetched.mimeType, bytes: fetched.bytes,
            sha256: createHash('sha256').update(fetched.bytes).digest('hex') };
          await processImage(image);
        } catch (error) {
          if (error instanceof MediaZipIngestionError) {
            if (error.retryable) { firstFailure = error; return; }
            await rejectImage(placeholder, error.code);
          } else firstFailure = error;
        }
      }
    }
  });
  await Promise.all(workers);
  if (firstFailure !== undefined) throw firstFailure;
}
