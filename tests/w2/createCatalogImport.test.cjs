'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { Readable } = require('node:stream');
const test = require('node:test');
const { ImportUploadController } = require('../../dist/modules/imports/import-upload.controller.js');

const sessionToken = 'a'.repeat(43);
const brandId = '11111111-1111-4111-8111-111111111111';
const uploadId = '22222222-2222-4222-8222-222222222222';
const csv = Buffer.from('SKU,Title\n,Invalid row\nSKU-1,Valid shirt\n');

function harness(overrides = {}) {
  const statements = [];
  const row = { id: uploadId, brand_id: brandId, source_kind: 'GENERIC_CSV', file_name: 'items.csv', mime_type: 'text/csv',
    byte_length: csv.length, source_sha256: createHash('sha256').update(csv).digest('hex'), storage_key: `brands/${brandId}/imports/${uploadId}/source`,
    status: 'PENDING', expires_at: new Date(Date.now() + 60_000) };
  const client = {
    async query(sql, params = []) {
      statements.push({ sql, params });
      if (/SELECT \* FROM imports\.import_uploads/.test(sql)) return { rows: [row] };
      if (/INSERT INTO imports\.import_batches/.test(sql)) return { rowCount: 1, rows: [{ id: params[0] }] };
      if (/INSERT INTO imports\.import_rows/.test(sql)) return { rowCount: 1, rows: [] };
      return { rowCount: 1, rows: [] };
    },
    release() {},
  };
  const pool = {
    async query(sql, params = []) { statements.push({ sql, params }); return { rows: [row] }; },
    async connect() { return client; },
  };
  const configValues = {
    AUTH_ALLOWED_ORIGINS: ['https://app.renivet.example'],
    MEDIA_SPACES_ENDPOINT: 'https://nyc3.digitaloceanspaces.com', MEDIA_SPACES_BUCKET: 'renivet-private',
    MEDIA_SPACES_REGION: 'nyc3', MEDIA_SPACES_ACCESS_KEY_ID: 'test-access-key', MEDIA_SPACES_SECRET_ACCESS_KEY: 'test-secret-key',
  };
  const config = { get: (key) => configValues[key] };
  const sessions = { authenticate: async () => ({ userId: '33333333-3333-4333-8333-333333333333' }), expectedCsrf: () => 'csrf-token' };
  const controller = new ImportUploadController({ pool }, sessions, config);
  controller.client = { send: async (command) => command.constructor.name === 'HeadObjectCommand'
    ? { ContentLength: csv.length, ContentType: 'text/csv', Metadata: { 'renivet-brand-id': brandId, 'renivet-import-upload-id': uploadId, 'renivet-sha256': row.source_sha256 } }
    : { Body: Readable.from([csv]) } };
  const request = { headers: { cookie: `__Host-renivet_session=${sessionToken}`, origin: 'https://app.renivet.example',
    'sec-fetch-site': 'same-origin', 'x-csrf-token': 'csrf-token' }, brandAccess: { brandId, userId: sessions.authenticate.userId, permission: 'imports.write' } };
  return { controller, request, statements, row, ...overrides };
}

test('REN2-76 creates one immutable brand-scoped staging batch and isolates row errors', async () => {
  const { controller, request, statements } = harness();
  const result = await controller.create({ sourceKind: 'GENERIC_CSV', sourceAsOf: '2026-11-09T00:00:00.000Z', fileUploadId: uploadId, mode: 'CREATE_ONLY' }, request, 'create-import-1');
  assert.equal(result.status, 'RECEIVED');
  assert.ok(result.batchId);
  const rowWrites = statements.filter(({ sql }) => /INSERT INTO imports\.import_rows/.test(sql));
  assert.equal(rowWrites.length, 2);
  assert.equal(rowWrites[0].params[2], 2);
  assert.equal(rowWrites[0].params[6], 'INVALID');
  assert.equal(rowWrites[1].params[2], 3);
  assert.equal(rowWrites[1].params[6], 'STAGED');
  const batchWrite = statements.find(({ sql }) => /INSERT INTO imports\.import_batches/.test(sql));
  assert.match(batchWrite.params[4], /\/committed\//);
  assert.notEqual(batchWrite.params[4], `brands/${brandId}/imports/${uploadId}/source`);
  assert.equal(statements.some(({ sql }) => /INSERT INTO catalogue\.|INSERT INTO inventory\./.test(sql)), false);
});

test('REN2-76 rejects a source checksum mismatch before opening the batch transaction', async () => {
  const fixture = harness();
  fixture.controller.client.send = async (command) => command.constructor.name === 'HeadObjectCommand'
    ? { ContentLength: csv.length, ContentType: 'text/csv', Metadata: { 'renivet-brand-id': brandId, 'renivet-import-upload-id': uploadId, 'renivet-sha256': 'f'.repeat(64) } }
    : { Body: Readable.from([csv]) };
  await assert.rejects(fixture.controller.create({ sourceKind: 'GENERIC_CSV', sourceAsOf: '2026-11-09T00:00:00.000Z', fileUploadId: uploadId, mode: 'CREATE_ONLY' }, fixture.request, 'create-import-2'),
    { status: 422 });
  assert.equal(fixture.statements.some(({ sql }) => sql === 'BEGIN'), false);
});
