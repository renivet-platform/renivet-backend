'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createHash } = require('node:crypto');
const { MediaService } = require('../dist/modules/media/media.service.js');

const brandId = 'c6ec20f1-05c6-4f44-bf0d-4c60c6d4b80f';
const bytes = Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,1,2,3,4]);
const context = { brandId, userId: '89166b6c-0310-4268-8e56-8f2fa7892658', permission: 'media.write',
  requestId: 'media-zip:test', idempotencyKey: `zip:${'89166b6c-0310-4268-8e56-8f2fa7892658'}:${'a'.repeat(64)}` };
const image = { brandId, batchId: '89166b6c-0310-4268-8e56-8f2fa7892658', productId: '6b837a82-8d61-4d5d-9c31-e2222b6f3239',
  variantId: '1b837a82-8d61-4d5d-9c31-e2222b6f3239', sku: 'SKU1', slot: 1, archivePath: 'SKU1__01.png', mimeType: 'image/png',
  bytes, sha256: createHash('sha256').update(bytes).digest('hex'), effectKey: 'a'.repeat(64) };

function makeService(overrides = {}) {
  const calls = [];
  const asset = { id: '49166b6c-0310-4268-8e56-8f2fa7892658', brandId, storageKey: `brands/${brandId}/x/original`,
    uploadKey: `brands/${brandId}/x/incoming/x`, mimeType: 'image/png', fileName: image.archivePath, byteLength: bytes.length,
    expectedSha256: image.sha256, scanState: 'PENDING', rightsState: 'ATTESTED', derivativeState: 'PENDING',
    uploadExpiresAt: new Date(Date.now() + 60000).toISOString(), sha256: null, width: null, height: null, rejectionCode: null };
  const repository = {
    async createIntent(input) { calls.push(['createIntent', input]); return overrides.existingAsset ?? asset; },
    async markRejected(input) { calls.push(['markRejected', input]); return { ...asset, scanState: 'REJECTED', rejectionCode: input.reasonCode }; },
    async markClean(input) { calls.push(['markClean', input]); return { ...asset, scanState: 'CLEAN', rightsState: 'ATTESTED', derivativeState: 'READY', id: asset.id }; },
  };
  const storage = { isConfigured: () => true, async putPrivateObject(input) { calls.push(['putPrivateObject', input]); },
    async deleteObject(key) { calls.push(['deleteObject', key]); } };
  const scanner = { isConfigured: () => true, async scan() { calls.push(['scan']); return overrides.scan ?? 'CLEAN'; } };
  const processor = { async createDerivatives() { calls.push(['derivatives']); return [{ kind: 'PREVIEW', key: `brands/${brandId}/x/derivatives/preview.webp`,
    bytes: Buffer.from([1]), sha256: 'b'.repeat(64), width: 1, height: 1, mimeType: 'image/webp' }]; } };
  return { service: new MediaService(repository, storage, scanner, processor), calls };
}

test('REN2-82 scans before private object writes and only marks clean after derivatives persist', async () => {
  const { service, calls } = makeService();
  const result = await service.ingestZipImage(image, context);
  assert.equal(result.mediaAssetId, '49166b6c-0310-4268-8e56-8f2fa7892658');
  assert.ok(calls.findIndex(([name]) => name === 'scan') < calls.findIndex(([name]) => name === 'putPrivateObject'));
  assert.ok(calls.findIndex(([name]) => name === 'derivatives') < calls.findIndex(([name]) => name === 'markClean'));
  assert.equal(calls.filter(([name]) => name === 'putPrivateObject').length, 2);
});

test('REN2-82 marks infected images rejected and never writes the original or derivatives', async () => {
  const { service, calls } = makeService({ scan: 'INFECTED' });
  await assert.rejects(service.ingestZipImage(image, context), { code: 'MEDIA_MALWARE_REJECTED', status: 422 });
  assert.equal(calls.filter(([name]) => name === 'putPrivateObject').length, 0);
  assert.equal(calls.filter(([name]) => name === 'markRejected').length, 1);
});

test('REN2-82 retries reuse the existing clean, rights-attested deterministic media asset', async () => {
  const { service, calls } = makeService({ existingAsset: { id: '49166b6c-0310-4268-8e56-8f2fa7892658', scanState: 'CLEAN',
    derivativeState: 'READY', rightsState: 'ATTESTED' } });
  const result = await service.ingestZipImage(image, context);
  assert.equal(result.mediaAssetId, '49166b6c-0310-4268-8e56-8f2fa7892658');
  assert.equal(calls.filter(([name]) => name === 'scan').length, 0);
  assert.equal(calls.filter(([name]) => name === 'putPrivateObject').length, 0);
});
