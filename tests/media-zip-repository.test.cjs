'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { MediaZipPostgresRepository } = require('../dist/modules/media/media-zip.repository.js');

const brandId = 'c6ec20f1-05c6-4f44-bf0d-4c60c6d4b80f';
const batchId = '89166b6c-0310-4268-8e56-8f2fa7892658';
const productId = '6b837a82-8d61-4d5d-9c31-e2222b6f3239';
const variantId = '1b837a82-8d61-4d5d-9c31-e2222b6f3239';
const mediaAssetId = '49166b6c-0310-4268-8e56-8f2fa7892658';
const image = { brandId, batchId, productId, variantId, sku: 'SKU1', slot: 1, archivePath: 'SKU1__01.png', mimeType: 'image/png',
  bytes: Buffer.from([1]), sha256: 'a'.repeat(64), effectKey: 'b'.repeat(64) };

test('REN2-82 worker replay reuses an existing successful effect without adding a second association', async () => {
  const statements = [];
  const client = {
    async query(sql) {
      statements.push(sql);
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rowCount: 0, rows: [] };
      if (sql.includes('FROM media.zip_import_batches WHERE id=$1')) return { rowCount: 1, rows: [{ created_by: 'owner-user', brand_id: brandId, mapping_manifest_id: '39166b6c-0310-4268-8e56-8f2fa7892658' }] };
      if (sql.includes('FROM media.zip_mapping_manifest_items')) return { rowCount: 1, rows: [{}] };
      if (sql.includes('FROM media.zip_import_effects')) return { rowCount: 1, rows: [{ id: '59166b6c-0310-4268-8e56-8f2fa7892658',
        state: 'SUCCEEDED', media_asset_id: mediaAssetId, effect_key: image.effectKey, source_sha256: image.sha256, source_path: image.archivePath }] };
      assert.fail(`Unexpected SQL: ${sql}`);
    },
    release() {},
  };
  const pool = { async connect() { return client; } };
  let galleryWrites = 0;
  const repository = new MediaZipPostgresRepository({ pool }, { async attachImportedInTransaction() { galleryWrites++; } });
  await repository.attachEffect(image, mediaAssetId, { brandId, userId: 'owner-user', permission: 'catalog.write', requestId: 'test', idempotencyKey: 'zip-replay' });
  assert.equal(galleryWrites, 0);
  assert.equal(statements.at(-1), 'COMMIT');
});
