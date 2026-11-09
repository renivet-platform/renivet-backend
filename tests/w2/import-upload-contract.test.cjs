'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const yaml = require('js-yaml');
const { ImportUploadController } = require('../../dist/modules/imports/import-upload.controller.js');

const root = join(__dirname, '..', '..');
const candidate = yaml.load(readFileSync(join(root, 'openapi/W2_v1_5_CANDIDATE.yaml'), 'utf8'));

test('REN2-76 defines a protected W2 source-file upload intent operation', () => {
  const operations = Object.entries(candidate.paths ?? {}).flatMap(([path, item]) =>
    Object.entries(item).filter(([method]) => ['get', 'post', 'put', 'patch', 'delete'].includes(method))
      .map(([method, operation]) => ({ path, method, operation })));
  assert.equal(operations.length, 47);
  const upload = operations.find(({ operation }) => operation.operationId === 'beginCatalogImportUpload');
  assert.ok(upload, 'upload operation is in the candidate contract');
  assert.equal(upload.path, '/brands/{brandId}/product-imports/uploads');
  assert.equal(upload.method, 'post');
  assert.equal(upload.operation['x-renivet-permission'], 'imports.write');
  assert.match(upload.operation['x-renivet-csrf-policy'], /session-bound/i);
  assert.ok(upload.operation.requestBody?.content?.['application/json']);
});

test('REN2-76 generated runtime OpenAPI exposes the implemented upload operation', () => {
  const active = JSON.parse(readFileSync(join(root, 'openapi/renivet.openapi.json'), 'utf8'));
  const operation = active.paths?.['/api/v1/brands/{brandId}/product-imports/uploads']?.post;
  assert.equal(operation?.operationId, 'beginCatalogImportUpload');
});

test('REN2-76 issues a short-lived brand-bound private upload URL and records its idempotent intent', async () => {
  const calls = [];
  const configValues = {
    AUTH_ALLOWED_ORIGINS: ['https://app.renivet.example'],
    MEDIA_SPACES_ENDPOINT: 'https://nyc3.digitaloceanspaces.com', MEDIA_SPACES_BUCKET: 'renivet-private',
    MEDIA_SPACES_REGION: 'nyc3', MEDIA_SPACES_ACCESS_KEY_ID: 'test-access-key', MEDIA_SPACES_SECRET_ACCESS_KEY: 'test-secret-key',
  };
  const pool = { async query(sql, params) {
    calls.push({ sql, params });
    return /WITH created AS/.test(sql) ? { rowCount: 1, rows: [{ id: params[0] }] } : { rowCount: 0, rows: [] };
  } };
  const sessions = { authenticate: async () => ({ userId: '33333333-3333-4333-8333-333333333333' }), expectedCsrf: () => 'csrf-token' };
  const config = { get: (key) => configValues[key] };
  const controller = new ImportUploadController({ pool }, sessions, config);
  const request = { id: 'request-1', headers: { cookie: '__Host-renivet_session=' + 'a'.repeat(43), origin: 'https://app.renivet.example',
    'sec-fetch-site': 'same-origin', 'x-csrf-token': 'csrf-token' }, brandAccess: { brandId: '11111111-1111-4111-8111-111111111111', userId: '33333333-3333-4333-8333-333333333333', permission: 'imports.write' } };
  const intent = await controller.begin({ sourceKind: 'GENERIC_CSV', fileName: 'items.csv', mimeType: 'text/csv', byteLength: 12, sha256: 'a'.repeat(64) }, request, 'upload-1');
  assert.match(intent.fileUploadId, /^[0-9a-f-]{36}$/i);
  assert.equal(intent.uploadMethod, 'PUT');
  assert.match(intent.uploadUrl, /^https:\/\//);
  assert.equal(intent.headers['x-amz-meta-renivet-brand-id'], request.brandAccess.brandId);
  assert.equal(calls.length, 2);
  assert.match(calls[1].sql, /access\.security_audit_events/);
});

test('REN2-82 refuses MEDIA_ZIP upload URLs until the runtime activation gates authorize imports', async () => {
  const config = { get: (key) => key === 'AUTH_ALLOWED_ORIGINS' ? ['https://app.renivet.example'] : undefined };
  const controller = new ImportUploadController({ pool: { async query() { throw new Error('ZIP upload must be stopped before persistence'); } } },
    { authenticate: async () => ({ userId: '33333333-3333-4333-8333-333333333333' }), expectedCsrf: () => 'csrf-token' }, config);
  const request = { id: 'request-82-upload', headers: { cookie: '__Host-renivet_session=' + 'a'.repeat(43),
    origin: 'https://app.renivet.example', 'sec-fetch-site': 'same-origin', 'x-csrf-token': 'csrf-token' },
  brandAccess: { brandId: '11111111-1111-4111-8111-111111111111', userId: '33333333-3333-4333-8333-333333333333', permission: 'imports.write' } };
  await assert.rejects(controller.begin({ sourceKind: 'MEDIA_ZIP', fileName: 'media.zip', mimeType: 'application/zip',
    byteLength: 1024, sha256: 'a'.repeat(64) }, request, 'zip-upload-82'),
  (error) => error.getStatus?.() === 503 && error.getResponse?.().code === 'MEDIA_ZIP_IMPORT_INACTIVE');
});

test('REN2-80 returns the original batch when the same Shopify file import is retried', async () => {
  const batchId = '44444444-4444-4444-8444-444444444444';
  const uploadId = '55555555-5555-4555-8555-555555555555';
  const pool = { async query(sql) {
    if (/SELECT \* FROM imports\.import_uploads/.test(sql)) return { rows: [{ id: uploadId,
      brand_id: '11111111-1111-4111-8111-111111111111', source_kind: 'SHOPIFY_CSV', status: 'CONSUMED',
      expires_at: new Date(Date.now() + 60_000).toISOString() }] };
    if (/SELECT id,source_kind,source_as_of,requested_policy FROM imports\.import_batches/.test(sql)) return { rows: [{ id: batchId,
      source_kind: 'SHOPIFY_CSV', source_as_of: '2026-11-09T00:00:00.000Z', requested_policy: { mode: 'CREATE_ONLY', idempotencyKey: 'shopify-replay-80' } }] };
    throw new Error('unexpected query');
  } };
  const sessions = { authenticate: async () => ({ userId: '33333333-3333-4333-8333-333333333333' }), expectedCsrf: () => 'csrf-token' };
  const config = { get: (key) => key === 'AUTH_ALLOWED_ORIGINS' ? ['https://app.renivet.example'] : undefined };
  const controller = new ImportUploadController({ pool }, sessions, config);
  const request = { id: 'request-80-replay', headers: { cookie: '__Host-renivet_session=' + 'a'.repeat(43), origin: 'https://app.renivet.example',
    'sec-fetch-site': 'same-origin', 'x-csrf-token': 'csrf-token' }, brandAccess: { brandId: '11111111-1111-4111-8111-111111111111',
      userId: '33333333-3333-4333-8333-333333333333', permission: 'imports.write' } };
  const result = await controller.create({ sourceKind: 'SHOPIFY_CSV', sourceAsOf: '2026-11-09T00:00:00.000Z',
    fileUploadId: uploadId, mode: 'CREATE_ONLY' }, request, 'shopify-replay-80');
  assert.deepEqual(result, { batchId, status: 'RECEIVED' });
});
