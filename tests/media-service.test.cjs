'use strict';

const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const test = require('node:test');
const { MediaService } = require('../dist/modules/media/media.service.js');

const brandId = randomUUID();
const actorId = randomUUID();
const assetId = randomUUID();
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWP4////fwAJ+wP9CNHoHgAAAABJRU5ErkJggg==', 'base64');
const sha256 = createHash('sha256').update(png).digest('hex');
const context = { brandId, userId: actorId, permission: 'catalog.write', requestId: 'request-media-1', idempotencyKey: 'complete-media-1' };

function fixture(overrides = {}) {
  const row = {
    id: assetId, brandId, storageKey: `brands/${brandId}/media/${assetId}/original`, uploadKey: `brands/${brandId}/media/${assetId}/incoming/n1`,
    mimeType: 'image/png', fileName: 'front.png', byteLength: png.length, expectedSha256: sha256,
    scanState: 'PENDING', rightsState: 'ATTESTED', derivativeState: 'PENDING', uploadExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    sha256: null, width: null, height: null, rejectionCode: null, ...overrides,
  };
  const state = { row, created: 0, rejected: [], cleaned: [], stored: new Map(), scanCalls: 0 };
  const repository = {
    async createIntent(input) { state.created++; state.row = { ...row, ...input, id: assetId }; return state.row; },
    async getForComplete() { if (overrides.notFound) throw Object.assign(new Error(), { code: 'MEDIA_NOT_FOUND', status: 404 }); return state.row; },
    async markRejected(input) { state.rejected.push(input); state.row = { ...state.row, scanState: 'REJECTED', derivativeState: 'FAILED', rejectionCode: input.reasonCode, sha256: input.sha256 ?? null }; return state.row; },
    async markClean(input) { state.cleaned.push(input); state.row = { ...state.row, scanState: 'CLEAN', derivativeState: 'READY', sha256: input.sha256, width: input.width, height: input.height }; return state.row; },
    async getStatus() { return state.row; },
  };
  const storage = {
    isConfigured: () => overrides.storageConfigured !== false,
    async createUploadIntent() { return { uploadUrl: 'https://private.example/signed', expiresAt: row.uploadExpiresAt, headers: { 'content-type': 'image/png' } }; },
    async headObject() { return { contentLength: overrides.headLength ?? png.length, contentType: overrides.headType ?? 'image/png', metadata: { 'renivet-brand-id': brandId, 'renivet-media-asset-id': assetId } }; },
    async readObject() { return overrides.content ?? png; },
    async putPrivateObject(input) { state.stored.set(input.key, input.bytes); },
    async createPreviewUrl() { return 'https://private.example/preview-signed'; },
    async deleteObject() {},
  };
  const scanner = { isConfigured: () => overrides.scannerConfigured !== false, async scan() { state.scanCalls++; if (overrides.scanError) throw overrides.scanError; return overrides.scanResult ?? 'CLEAN'; } };
  const processor = { async createDerivatives() { if (overrides.derivativeError) throw overrides.derivativeError; return [
    { kind: 'PREVIEW', key: `brands/${brandId}/media/${assetId}/derivatives/preview.webp`, bytes: Buffer.from('preview'), sha256: 'a'.repeat(64), width: 1, height: 1, mimeType: 'image/webp' },
    { kind: 'THUMBNAIL', key: `brands/${brandId}/media/${assetId}/derivatives/thumbnail.webp`, bytes: Buffer.from('thumb'), sha256: 'b'.repeat(64), width: 1, height: 1, mimeType: 'image/webp' },
  ]; } };
  return { service: new MediaService(repository, storage, scanner, processor), state };
}

test('REN2-66 issues a five-minute brand-keyed upload intent after persisting the rights attestation', async () => {
  const { service, state } = fixture();
  const intent = await service.begin({ fileName: 'front.png', mimeType: 'image/png', byteLength: png.length, rightsAttested: true },
    { ...context, permission: 'media.write', idempotencyKey: 'begin-media-1' });
  assert.equal(intent.mediaAssetId, assetId);
  assert.match(intent.uploadUrl, /^https:\/\//);
  assert.equal(state.created, 1);
  assert.equal(state.row.rightsState, 'ATTESTED');
});

test('REN2-66 marks clean only after size, signed metadata, magic, hash, malware scan, and derivatives pass', async () => {
  const { service, state } = fixture();
  const result = await service.complete(assetId, { sha256, sizeBytes: png.length }, context);
  assert.equal(result.status, 'CLEAN');
  assert.equal(state.row.derivativeState, 'READY');
  assert.equal(state.scanCalls, 1);
  assert.equal(state.cleaned.length, 1);
  assert.equal(state.cleaned[0].derivatives.length, 2);
  assert.equal(state.stored.size, 3, 'only the server copies the verified original and derivatives to final private keys');
});

test('REN2-66 rejects infected media and records no clean transition', async () => {
  const { service, state } = fixture({ scanResult: 'INFECTED' });
  await assert.rejects(service.complete(assetId, { sha256, sizeBytes: png.length }, context), { code: 'MEDIA_MALWARE_REJECTED', status: 422 });
  assert.equal(state.row.scanState, 'REJECTED');
  assert.equal(state.cleaned.length, 0);
  assert.equal(state.rejected[0].reasonCode, 'MALWARE_DETECTED');
});

test('REN2-66 keeps pending state when the scanner is unavailable so completion can be retried', async () => {
  const { service, state } = fixture({ scanError: Object.assign(new Error('offline'), { name: 'MediaScannerUnavailableError' }) });
  await assert.rejects(service.complete(assetId, { sha256, sizeBytes: png.length }, context), { code: 'MEDIA_SCANNER_UNAVAILABLE', status: 503 });
  assert.equal(state.row.scanState, 'PENDING');
  assert.equal(state.rejected.length, 0);
  assert.equal(state.cleaned.length, 0);
});

test('REN2-66 rejects a declared length that differs from the stored object before scanning', async () => {
  const { service, state } = fixture({ headLength: png.length + 1 });
  await assert.rejects(service.complete(assetId, { sha256, sizeBytes: png.length }, context), { code: 'MEDIA_OBJECT_MISMATCH', status: 422 });
  assert.equal(state.scanCalls, 0);
  assert.equal(state.row.scanState, 'REJECTED');
});

test('REN2-66 does not create a database intent if required security services are unavailable', async () => {
  const { service, state } = fixture({ scannerConfigured: false });
  await assert.rejects(service.begin({ fileName: 'front.png', mimeType: 'image/png', byteLength: png.length, rightsAttested: true },
    { ...context, permission: 'media.write', idempotencyKey: 'begin-media-1' }), { code: 'MEDIA_SCANNER_UNAVAILABLE', status: 503 });
  assert.equal(state.created, 0);
});
