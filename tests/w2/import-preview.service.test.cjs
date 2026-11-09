'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { ImportPreviewService } = require('../../dist/modules/imports/import-preview.service.js');

const brandId = '11111111-1111-4111-8111-111111111111';
const batchId = '22222222-2222-4222-8222-222222222222';
const userId = '33333333-3333-4333-8333-333333333333';
const mapping = { fieldMappings: { Title: 'title', Style: 'styleCode', SKU: 'sku', Category: 'categoryCode' }, categoryMappings: { Tops: 'tops' } };

function harness({ mappingVersion = 0, prior = [], batch = true } = {}) {
  const statements = [];
  const savedProfiles = [...prior];
  let batchPreviewRevision = 0;
  const client = {
    async query(sql, params = []) {
      statements.push({ sql, params });
      if (/FROM imports\.import_mapping_profiles WHERE brand_id/.test(sql)) return { rows: savedProfiles.filter((row) => row.key === params[1]) };
      if (/FROM imports\.import_batches b/.test(sql)) return { rows: batch ? [{ id: batchId, brand_id: brandId, source_kind: 'GENERIC_CSV', source_sha256: 'a'.repeat(64),
        source_as_of: new Date('2026-11-09T00:00:00.000Z'), job_state: 'RECEIVED', requested_policy: { mode: 'CREATE_ONLY' }, preview_revision: batchPreviewRevision }] : [] };
      if (/COALESCE\(max\(version\),0\)/.test(sql)) return { rows: [{ version: Math.max(mappingVersion, ...savedProfiles.map((row) => Number(row.version))) }] };
      if (/FROM imports\.import_rows/.test(sql)) return { rows: [{ source_row_number: 2, raw_record: { Title: 'Sample shirt', Style: 'SAMPLE-1', SKU: 'SAMPLE-1-M', Category: 'Tops' },
        canonical_record: null, validation_errors: [] }] };
      if (/FROM catalogue\.categories/.test(sql)) return { rows: [{ category_id: '44444444-4444-4444-8444-444444444444', code: 'tops', active: true, schema_version: 3,
        schema_version_id: '55555555-5555-4555-8555-555555555555', validator_version: 'w2-attribute-validator-v1', ruleset_sha256: 'b'.repeat(64), attribute_rules: [] }] };
      if (/FROM catalogue\.product_variants/.test(sql)) return { rows: [] };
      if (/FROM imports\.import_previews p/.test(sql)) return { rows: [{ preview_snapshot: { batchId, previewHash: 'c'.repeat(64) } }] };
      if (/INSERT INTO imports\.import_mapping_profiles/.test(sql)) {
        savedProfiles.push({ key: params[6], version: Number(params[3]), request_hash: params[7], preview_revision: null, preview_hash: null });
        return { rowCount: 1, rows: [] };
      }
      if (/INSERT INTO imports\.import_previews/.test(sql)) {
        const profile = savedProfiles.at(-1);
        profile.preview_revision = Number(params[2]); profile.preview_hash = params[3];
        return { rowCount: 1, rows: [] };
      }
      if (/UPDATE imports\.import_batches/.test(sql)) { batchPreviewRevision = Number(params[2]); return { rowCount: 1, rows: [] }; }
      if (/INSERT INTO access\.security_audit_events/.test(sql)) return { rowCount: 1, rows: [] };
      return { rows: [], rowCount: 1 };
    },
    release() {},
  };
  const pool = {
    async connect() { return client; },
    async query(sql, params = []) { statements.push({ sql, params }); return { rows: [{ preview_snapshot: { batchId, previewHash: 'c'.repeat(64) } }] }; },
  };
  return { service: new ImportPreviewService({ pool }), statements };
}

test('REN2-77 saves a brand-scoped immutable mapping and preview in one database transaction', async () => {
  const fixture = harness();
  const result = await fixture.service.saveMapping({ brandId, batchId, actorUserId: userId, idempotencyKey: 'mapping-1', expectedVersion: 0,
    mapping, requestId: 'request-mapping-1' });
  assert.equal(result.mappingVersion, 1);
  assert.equal(result.previewRevision, 1);
  assert.match(result.previewHash, /^[a-f0-9]{64}$/);
  assert.equal(fixture.statements[0].sql, 'BEGIN');
  assert.equal(fixture.statements.at(-1).sql, 'COMMIT');
  const saved = fixture.statements.find(({ sql }) => /INSERT INTO imports\.import_mapping_profiles/.test(sql));
  assert.equal(saved.params[1], brandId);
  assert.equal(saved.params[2], batchId);
  assert.equal(saved.params[9], result.previewRevision);
  assert.equal(saved.params[10], result.previewHash);
  const preview = fixture.statements.find(({ sql }) => /INSERT INTO imports\.import_previews/.test(sql));
  assert.equal(preview.params[0], brandId);
  assert.equal(JSON.parse(preview.params[9]).counts.create, 1);
  assert.equal(fixture.statements.some(({ sql }) => /INSERT INTO catalogue\.|INSERT INTO inventory\./.test(sql)), false);
});

test('REN2-77 rejects a stale If-Match version without storing a profile', async () => {
  const fixture = harness({ mappingVersion: 1 });
  await assert.rejects(fixture.service.saveMapping({ brandId, batchId, actorUserId: userId, idempotencyKey: 'mapping-stale', expectedVersion: 0,
    mapping, requestId: 'request-mapping-stale' }), { status: 409 });
  assert.equal(fixture.statements.some(({ sql }) => /INSERT INTO imports\.import_mapping_profiles/.test(sql)), false);
  assert.equal(fixture.statements.at(-1).sql, 'ROLLBACK');
});

test('REN2-77 rejects case-insensitive duplicate source-category mappings before opening a transaction', async () => {
  const fixture = harness();
  await assert.rejects(fixture.service.saveMapping({ brandId, batchId, actorUserId: userId, idempotencyKey: 'mapping-duplicate-category', expectedVersion: 0,
    mapping: { ...mapping, categoryMappings: { Tops: 'tops-a', tops: 'tops-b' } }, requestId: 'mapping-duplicate-category' }),
  (error) => error?.status === 422 && error?.response?.code === 'IMPORT_MAPPING_INVALID');
  assert.equal(fixture.statements.length, 0, 'invalid mapping is rejected before any database transaction');
});

test('REN2-77 returns the prior mapping revision for exact idempotent replay', async () => {
  const fixture = harness();
  const input = { brandId, batchId, actorUserId: userId, idempotencyKey: 'mapping-1', expectedVersion: 0, mapping, requestId: 'request-1' };
  const first = await fixture.service.saveMapping(input);
  const replay = await fixture.service.saveMapping(input);
  assert.deepEqual(replay, first);
  assert.equal(fixture.statements.filter(({ sql }) => /INSERT INTO imports\.import_mapping_profiles/.test(sql)).length, 1);
  const changed = { ...mapping, categoryMappings: { Tops: 'different-tops' } };
  await assert.rejects(fixture.service.saveMapping({ ...input, mapping: changed }), { status: 409 });
});

test('REN2-77 creates a new immutable mapping and preview revision when mapping content changes', async () => {
  const fixture = harness();
  const first = await fixture.service.saveMapping({ brandId, batchId, actorUserId: userId, idempotencyKey: 'mapping-revision-1', expectedVersion: 0,
    mapping, requestId: 'request-revision-1' });
  const updatedMapping = { ...mapping, categoryMappings: { Tops: 'apparel-tops-v2' } };
  const second = await fixture.service.saveMapping({ brandId, batchId, actorUserId: userId, idempotencyKey: 'mapping-revision-2', expectedVersion: 1,
    mapping: updatedMapping, requestId: 'request-revision-2' });

  assert.equal(second.mappingVersion, 2);
  assert.equal(second.previewRevision, 2);
  assert.notEqual(second.previewHash, first.previewHash);
  assert.equal(fixture.statements.filter(({ sql }) => /INSERT INTO imports\.import_mapping_profiles/.test(sql)).length, 2);
  assert.equal(fixture.statements.filter(({ sql }) => /INSERT INTO imports\.import_previews/.test(sql)).length, 2);
});

test('REN2-77 returns only the preview belonging to the requested brand and batch', async () => {
  const fixture = harness();
  const result = await fixture.service.getPreview({ brandId, batchId, userId, requestId: 'preview-read-1' });
  assert.equal(result.batchId, batchId);
  const query = fixture.statements.find(({ sql }) => /FROM imports\.import_previews p/.test(sql));
  assert.match(query.sql, /p\.brand_id=\$2/);
  assert.match(query.sql, /ep\.user_id=\$3/);
  assert.deepEqual(query.params, [batchId, brandId, userId]);
  assert.ok(fixture.statements.some(({ sql }) => /imports\.preview\.read/.test(sql)), 'reading the preview creates an immutable audit event');
});
