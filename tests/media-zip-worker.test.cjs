'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const JSZip = require('jszip');
const { createMediaZipImportHandler } = require('../dist/modules/media/media-zip.worker.js');
const { MediaServiceError } = require('../dist/modules/media/media.service.js');

const brandId = 'c6ec20f1-05c6-4f44-bf0d-4c60c6d4b80f';
const batchId = '89166b6c-0310-4268-8e56-8f2fa7892658';
const uploadId = '29166b6c-0310-4268-8e56-8f2fa7892658';
const manifestId = '39166b6c-0310-4268-8e56-8f2fa7892658';
const productId = '6b837a82-8d61-4d5d-9c31-e2222b6f3239';
const variantId = '1b837a82-8d61-4d5d-9c31-e2222b6f3239';
const mediaAssetId = '49166b6c-0310-4268-8e56-8f2fa7892658';
const png = Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,1,2,3,4]);

async function zipBytes() {
  const zip = new JSZip();
  zip.file('SKU1__01.png', png);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' });
}

test('REN2-82 durable consumer pins the batch brand and routes clean images to scan and attach ports', async () => {
  const bytes = await zipBytes();
  const crypto = require('node:crypto');
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  const authorizedEffects = [], attached = [], processed = [];
  const repository = {
    async loadBatch(id) { assert.equal(id, batchId); return { id: batchId, brandId, createdBy: 'owner-user', rightsAttestedBy: 'rights-user',
      sourceKind: 'MEDIA_ZIP', fileUploadId: uploadId, mappingManifestId: manifestId, storageKey: `brands/${brandId}/imports/${uploadId}/source`,
      byteLength: bytes.length, sha256, manifest: { SKU1: { productId, variantId } } }; },
    async resolveProducts(scope, mappings) { assert.equal(scope, brandId); return Object.fromEntries(Object.keys(mappings).map((sku) => [sku,
      { brandId, productId, variantId, sku }])); },
    async attachEffect(image, asset, context) { assert.equal(context.userId, 'owner-user'); attached.push([image.slot, asset]); },
    async recordRejectedEffect() { assert.fail('valid media should not be rejected'); },
    async finishBatch(id) { assert.equal(id, batchId); processed.push('finished'); },
  };
  const storage = {
    async headObject() { return { contentLength: bytes.length, contentType: 'application/zip', metadata: {
      'renivet-brand-id': brandId, 'renivet-import-upload-id': uploadId, 'renivet-sha256': sha256,
    } }; },
    async readObject(_key, max) { assert.ok(bytes.length <= max); return bytes; },
  };
  const media = { async ingestZipImage(image, context) {
    assert.equal(image.brandId, brandId); assert.equal(context.userId, 'rights-user'); processed.push('scanned'); return { mediaAssetId };
  } };
  const handler = createMediaZipImportHandler({ repository, media, storage });
  assert.equal(handler.consumerId, 'media.zip_import');
  assert.deepEqual(handler.authorization.effects, ['media.asset.create','media.product_media.attach']);
  await handler.handle({ id: 'event-id', aggregateType: 'media.zip_import', aggregateId: batchId, eventType: 'media.zip_import.requested',
    eventVersion: 1, eventPayload: { brandId, batchId } }, { async query() { return { rowCount: 1 }; } }, {
    brandId, async authorizeEffect(effect, target) { assert.equal(target, brandId); authorizedEffects.push(effect); },
  });
  assert.deepEqual(authorizedEffects, ['media.asset.create','media.product_media.attach']);
  assert.deepEqual(attached, [[1, mediaAssetId]]);
  assert.deepEqual(processed, ['scanned','finished']);
});

test('REN2-82 records permanent media scan rejection instead of retrying a ZIP image', async () => {
  const bytes = await zipBytes();
  const sha256 = require('node:crypto').createHash('sha256').update(bytes).digest('hex');
  const rejected = [], finished = [];
  const repository = {
    async loadBatch() { return { id: batchId, brandId, createdBy: 'owner-user', rightsAttestedBy: 'rights-user',
      sourceKind: 'MEDIA_ZIP', fileUploadId: uploadId, mappingManifestId: manifestId, storageKey: 'private/source.zip',
      byteLength: bytes.length, sha256, state: 'QUEUED', manifest: { SKU1: { productId, variantId } } }; },
    async resolveProducts() { return { SKU1: { brandId, productId, variantId, sku: 'SKU1' } }; },
    async attachEffect() { assert.fail('infected media must not be attached'); },
    async recordRejectedEffect(image, code) { rejected.push([image.slot, code]); },
    async finishBatch() { finished.push(true); },
  };
  const storage = {
    async headObject() { return { contentLength: bytes.length, contentType: 'application/zip', metadata: {
      'renivet-brand-id': brandId, 'renivet-import-upload-id': uploadId, 'renivet-sha256': sha256,
    } }; },
    async readObject() { return bytes; },
  };
  const media = { async ingestZipImage() { throw new MediaServiceError(422, 'MEDIA_MALWARE_REJECTED', 'unsafe test image'); } };
  const handler = createMediaZipImportHandler({ repository, media, storage });
  await handler.handle({ id: 'event-id', aggregateType: 'media.zip_import', aggregateId: batchId,
    eventType: 'media.zip_import.requested', eventVersion: 1, eventPayload: { brandId, batchId } },
  { async query() { return { rowCount: 1 }; } }, { brandId, async authorizeEffect() {} });
  assert.deepEqual(rejected, [[1, 'MEDIA_MALWARE_REJECTED']]);
  assert.deepEqual(finished, [true]);
});

test('REN2-82 durable consumer rejects a payload brand mismatch before reading the upload', async () => {
  let reads = 0;
  const handler = createMediaZipImportHandler({ repository: {}, media: {}, storage: { async headObject() { reads++; } } });
  await assert.rejects(handler.handle({ id: 'event-id', aggregateType: 'media.zip_import', aggregateId: batchId,
    eventType: 'media.zip_import.requested', eventVersion: 1, eventPayload: { brandId: 'a0f99918-0d15-4d0a-b53f-0d017c5272dd', batchId } },
  { async query() { return { rowCount: 0 }; } }, { brandId, async authorizeEffect() {} }), { code: 'MEDIA_ZIP_EVENT_INVALID' });
  assert.equal(reads, 0);
});

test('REN2-82 durable consumer fetches remote images through the pinned public-HTTPS path and records each effect', async () => {
  const url = 'https://cdn.example.test/SKU1.jpg?signature=secret';
  const authorizedEffects = [], fetched = [], attached = [], processed = [];
  const bytes = png;
  const sha256 = require('node:crypto').createHash('sha256').update(bytes).digest('hex');
  const repository = {
    async loadBatch(id) { assert.equal(id, batchId); return { id: batchId, brandId, createdBy: 'owner-user', rightsAttestedBy: 'rights-user',
      fileUploadId: null, mappingManifestId: manifestId, sourceKind: 'REMOTE_URL', remoteImages: [{ sku: 'SKU1', slot: 1, url,
        sourceUrlSha256: require('node:crypto').createHash('sha256').update(url).digest('hex') }],
      manifest: { SKU1: { productId, variantId } } }; },
    async resolveProducts(scope, mappings) { assert.equal(scope, brandId); assert.deepEqual(Object.keys(mappings), ['SKU1']);
      return { SKU1: { brandId, productId, variantId, sku: 'SKU1' } }; },
    async attachEffect(image, asset, context) { assert.equal(image.archivePath, 'remote:' + require('node:crypto').createHash('sha256').update(url).digest('hex'));
      attached.push([image.slot, asset, context.userId]); },
    async recordRejectedEffect() { assert.fail('valid remote image should not be rejected'); },
    async finishBatch(id) { assert.equal(id, batchId); processed.push('finished'); },
  };
  const media = { async ingestZipImage(image, context) { assert.equal(image.brandId, brandId); assert.equal(image.sha256, sha256);
    assert.equal(context.userId, 'rights-user'); processed.push('scanned'); return { mediaAssetId }; } };
  const handler = createMediaZipImportHandler({ repository, media, storage: {}, async fetchRemote(value) {
    fetched.push(value); return { bytes, mimeType: 'image/png' };
  } });
  await handler.handle({ id: 'event-id', aggregateType: 'media.zip_import', aggregateId: batchId, eventType: 'media.zip_import.requested',
    eventVersion: 1, eventPayload: { brandId, batchId } }, { async query() { return { rowCount: 1 }; } }, {
    brandId, async authorizeEffect(effect, target) { assert.equal(target, brandId); authorizedEffects.push(effect); },
  });
  assert.deepEqual(fetched, [url]);
  assert.deepEqual(authorizedEffects, ['media.asset.create','media.product_media.attach']);
  assert.deepEqual(attached, [[1, mediaAssetId, 'owner-user']]);
  assert.deepEqual(processed, ['scanned','finished']);
});

test('REN2-82 remote worker uses the default SSRF guard and records a private-address URL as a rejected image', async () => {
  const url = 'https://127.0.0.1/private.png';
  const rejected = [], processed = [];
  const sourceUrlSha256 = require('node:crypto').createHash('sha256').update(url).digest('hex');
  const repository = {
    async loadBatch() { return { id: batchId, brandId, createdBy: 'owner-user', rightsAttestedBy: 'rights-user',
      fileUploadId: null, mappingManifestId: manifestId, sourceKind: 'REMOTE_URL', state: 'QUEUED',
      remoteImages: [{ sku: 'SKU1', slot: 1, url, sourceUrlSha256 }], manifest: { SKU1: { productId, variantId } } }; },
    async resolveProducts() { return { SKU1: { brandId, productId, variantId, sku: 'SKU1' } }; },
    async recordRejectedEffect(image, code) { rejected.push([image.sourceSha256, code]); },
    async finishBatch() { processed.push('finished'); },
  };
  const handler = createMediaZipImportHandler({ repository, media: {}, storage: {} });
  await handler.handle({ id: 'event-id', aggregateType: 'media.zip_import', aggregateId: batchId,
    eventType: 'media.zip_import.requested', eventVersion: 1, eventPayload: { brandId, batchId } },
  { async query() { return { rowCount: 1 }; } }, { brandId, async authorizeEffect() {} });
  assert.deepEqual(rejected, [[sourceUrlSha256, 'MEDIA_URL_UNSAFE']]);
  assert.deepEqual(processed, ['finished']);
});
