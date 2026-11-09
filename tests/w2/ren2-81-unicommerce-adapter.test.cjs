'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { parseCatalogCsv } = require('../../dist/modules/imports/import-csv-parser.js');
const { buildImportPreview } = require('../../dist/modules/imports/import-preview-engine.js');

test('REN2-81 maps a Uniware item CSV to review-only catalog data without applying price or image URLs', () => {
  const csv = [
    'categoryCode,skuCode,name,type,color,size,maxRetailPrice,basePrice,imageUrl,externalItemId,sourceAsOf',
    'APPAREL,RN-TEE-BLU-M,Blue Tee,SIMPLE,Blue,M,1299,799,https://example.test/tee.jpg,ITEM-91,2026-11-09T10:00:00Z',
  ].join('\r\n');
  const mapped = parseCatalogCsv({ bytes: Buffer.from(csv), sourceKind: 'UNIWARE_CSV' });

  assert.equal(mapped.profileId, 'unicommerce-item-csv-illustrative');
  assert.equal(mapped.profileVersion, '2026-11-09');
  assert.equal(mapped.catalogRows.length, 1);
  assert.equal(mapped.catalogRows[0].sourceRecordKey, 'RN-TEE-BLU-M');
  assert.equal(mapped.catalogRows[0].sourceProductKey, 'ITEM-91');
  assert.deepEqual(mapped.catalogRows[0].options, { color: 'Blue', size: 'M' });
  assert.equal(mapped.catalogRows[0].attributes.sourceCategoryCode, 'APPAREL');
  assert.deepEqual(mapped.catalogRows[0].sourceImageUrls, [{
    url: 'https://example.test/tee.jpg', sourceRowNumber: 2, sourceColumn: 'imageurl',
  }]);
  assert.ok(mapped.catalogRows[0].reviewCodes.includes('UNIWARE_CATEGORY_MAPPING_REQUIRED'));
  assert.ok(mapped.catalogRows[0].reviewCodes.includes('UNIWARE_UNMAPPED_FIELDS'));
  assert.deepEqual(mapped.stockObservations, []);
  assert.equal(mapped.catalogRows[0].sourceMrp, 1299);
  assert.deepEqual(mapped.catalogRows[0].sourceExternalKeys, { skuCode: 'RN-TEE-BLU-M', itemId: 'ITEM-91' });
  assert.deepEqual(mapped.catalogRows[0].sourceVariantDetails, [{ sku: 'RN-TEE-BLU-M', price: 799, compareAtPrice: 1299 }]);
  assert.ok(mapped.catalogRows[0].reviewCodes.includes('UNIWARE_PRICE_REVIEW_REQUIRED'));
});

test('REN2-81 maps the supplied illustrative Unicommerce item and stock fixtures without creating media or stock effects', () => {
  const { readFileSync } = require('node:fs');
  const { join } = require('node:path');
  const fixtures = join(__dirname, '..', 'fixtures');
  const items = parseCatalogCsv({ bytes: readFileSync(join(fixtures, 'unicommerce-items.sample.csv')), sourceKind: 'UNIWARE_CSV' });
  const stock = parseCatalogCsv({ bytes: readFileSync(join(fixtures, 'unicommerce-inventory.sample.csv')),
    sourceKind: 'UNIWARE_CSV', sourceAsOf: '2026-11-09T10:00:00.000Z' });

  assert.equal(items.catalogRows.length, 5);
  assert.equal(items.catalogRows[0].sku, 'RN-TSH-BLU-M');
  assert.equal(items.catalogRows[0].sourceMrp, 1299);
  assert.ok(items.catalogRows[0].reviewCodes.includes('UNIWARE_CATEGORY_MAPPING_REQUIRED'));
  assert.ok(items.catalogRows[0].reviewCodes.includes('UNIWARE_MEDIA_REVIEW_REQUIRED'));
  assert.deepEqual(items.stockObservations, []);
  assert.equal(stock.catalogRows.length, 0);
  assert.equal(stock.stockObservations.length, 6);
  assert.equal(stock.stockObservations[0].externalSourceKey, 'BLR-01:RN-TSH-BLU-M');
  assert.equal(stock.stockObservations[0].sourceAsOf, '2026-11-09T10:00:00.000Z');
});

test('REN2-81 keeps facility stock rows as dated, source-keyed observations with no catalog or stock mutation', () => {
  const csv = [
    'facilityCode,itemTypeSKU,inventory,externalItemId',
    'BLR-01,RN-TEE-BLU-M,80,ITEM-91',
    'MUM-01,RN-TEE-BLU-M,25,ITEM-91',
  ].join('\r\n');
  const mapped = parseCatalogCsv({ bytes: Buffer.from(csv), sourceKind: 'UNIWARE_CSV', sourceAsOf: '2026-11-09T10:00:00Z' });

  assert.equal(mapped.catalogRows.length, 0);
  assert.equal(mapped.stockObservations.length, 2);
  assert.deepEqual(mapped.stockObservations, [
    { sourceRecordKey: 'RN-TEE-BLU-M', locationKey: 'BLR-01', quantity: 80,
      externalSourceKey: 'BLR-01:RN-TEE-BLU-M', sourceAsOf: '2026-11-09T10:00:00Z', sourceRowNumber: 2 },
    { sourceRecordKey: 'RN-TEE-BLU-M', locationKey: 'MUM-01', quantity: 25,
      externalSourceKey: 'MUM-01:RN-TEE-BLU-M', sourceAsOf: '2026-11-09T10:00:00Z', sourceRowNumber: 3 },
  ]);
  assert.deepEqual(mapped.rowErrors, [
    { sourceRowNumber: 2, code: 'UNIWARE_STOCK_OBSERVATION_ONLY' },
    { sourceRowNumber: 3, code: 'UNIWARE_STOCK_OBSERVATION_ONLY' },
  ]);
});

test('REN2-81 reports missing item identifiers and invalid facility quantities by row', () => {
  const csv = [
    'facilityCode,itemTypeSKU,inventory',
    'BLR-01,,4',
    'MUM-01,RN-TEE-BLU-M,-2',
  ].join('\n');
  const mapped = parseCatalogCsv({ bytes: Buffer.from(csv), sourceKind: 'UNIWARE_CSV' });

  assert.deepEqual(mapped.stockObservations, []);
  assert.deepEqual(mapped.rowErrors, [
    { sourceRowNumber: 2, code: 'UNIWARE_STOCK_IDENTITY_MISSING' },
    { sourceRowNumber: 3, code: 'UNIWARE_STOCK_QUANTITY_INVALID' },
  ]);
});

test('REN2-81 carries source lossiness into preview and clears category review only after explicit mapping', () => {
  const csv = [
    'categoryCode,skuCode,name,styleCode,type,color,size,maxRetailPrice,basePrice,imageUrl,externalItemId,scanType',
    'APPAREL,RN-TEE-BLU-M,Blue Tee,TEE-STYLE-1,SIMPLE,Blue,M,1299,799,https://example.test/tee.jpg,ITEM-91,SIMPLE',
  ].join('\n');
  const mapped = parseCatalogCsv({ bytes: Buffer.from(csv), sourceKind: 'UNIWARE_CSV' });
  const preview = buildImportPreview({
    batch: { id: 'batch-81', brandId: 'brand-1', sourceSha256: 'a'.repeat(64), sourceAsOf: '2026-11-09T10:00:00.000Z' },
    mapping: { version: 1, fields: { categoryCode: 'categoryCode', skuCode: 'sku', name: 'title', styleCode: 'styleCode', color: 'options.color', size: 'options.size' },
      categories: { APPAREL: 'apparel-tops' } },
    taxonomy: { version: 1, snapshotSha256: 'b'.repeat(64), categories: [{ code: 'apparel-tops', active: true,
      categoryId: '11111111-1111-4111-8111-111111111111', schemaVersionId: '22222222-2222-4222-8222-222222222222',
      schemaVersion: 1, validatorVersion: 'w2-attribute-validator-v1', attributes: [] }] },
    sourceRows: [{ rowNumber: 2, rawRecord: mapped.rawRows[0].rawRecord, canonicalRecord: mapped.catalogRows[0] }], targets: [],
  });

  assert.equal(preview.rows[0].action, 'CONFLICT');
  assert.ok(preview.rows[0].conflicts.some(({ code }) => code === 'UNIWARE_UNMAPPED_FIELDS'));
  assert.ok(preview.rows[0].conflicts.some(({ code }) => code === 'MEDIA_REVIEW_REQUIRED'));
  assert.ok(preview.rows[0].conflicts.some(({ code }) => code === 'PRICE_REVIEW_REQUIRED'));
  assert.ok(!preview.rows[0].conflicts.some(({ code }) => code === 'CATEGORY_UNMAPPED'));
  assert.ok(!preview.rows[0].conflicts.some(({ code }) => code === 'UNIWARE_CATEGORY_MAPPING_REQUIRED'));
});
