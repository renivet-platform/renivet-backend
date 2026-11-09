'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { buildImportPreview } = require('../../dist/modules/imports/import-preview-engine.js');

const mapping = {
  version: 1,
  fields: {
    'product name': 'title',
    'style code': 'styleCode',
    sku: 'sku',
    category: 'categoryCode',
    color: 'options.color',
    fabric: 'attributes.fabric',
  },
  categories: { 'tops': 'apparel-tops' },
};

const sourceRows = [
  { rowNumber: 2, rawRecord: { 'product name': ' Linen Shirt ', 'style code': 'LINEN-01', sku: 'LINEN-01-M', category: 'Tops', color: 'Blue', fabric: 'Linen' } },
  { rowNumber: 3, rawRecord: { 'product name': 'Unknown item', 'style code': 'UNKNOWN-01', sku: 'UNKNOWN-01', category: 'Unmapped' } },
];

function taxonomy() {
  return { version: 4, snapshotSha256: 'b'.repeat(64), categories: [{ code: 'apparel-tops', active: true,
    categoryId: '11111111-1111-4111-8111-111111111111', schemaVersionId: '22222222-2222-4222-8222-222222222222', schemaVersion: 4,
    validatorVersion: 'w2-attribute-validator-v1', attributes: [
      { id: '33333333-3333-4333-8333-333333333333', attributeId: '44444444-4444-4444-8444-444444444444', code: 'fabric', scope: 'product', valueType: 'text', requiredByDefault: false },
      { id: '55555555-5555-4555-8555-555555555555', attributeId: '66666666-6666-4666-8666-666666666666', code: 'color', scope: 'variant', valueType: 'enum', allowedValues: ['Blue','Red'], requiredByDefault: false },
    ] }] };
}

test('REN2-77 maps source fields, classifies rows, and sends unknown categories to review', () => {
  const preview = buildImportPreview({
    batch: { id: 'batch-1', brandId: 'brand-1', sourceSha256: 'a'.repeat(64), sourceAsOf: '2026-11-09T00:00:00.000Z' },
    mapping,
    taxonomy: taxonomy(),
    sourceRows,
    targets: [],
  });

  assert.equal(preview.counts.create, 1);
  assert.equal(preview.counts.review, 1);
  assert.equal(preview.rows[0].action, 'CREATE');
  assert.deepEqual(preview.rows[0].proposed.title, 'Linen Shirt');
  assert.deepEqual(preview.rows[0].proposed.styleCode, 'LINEN-01');
  assert.deepEqual({ ...preview.rows[0].proposed.options }, { color: 'Blue' });
  assert.deepEqual({ ...preview.rows[0].proposed.attributes }, { fabric: 'Linen' });
  assert.equal(preview.rows[1].action, 'NEEDS_REVIEW');
  assert.equal(preview.rows[1].conflicts[0].code, 'CATEGORY_UNMAPPED');
});

test('REN2-78 freezes canonical variant and already-approved media targets into the preview payload', () => {
  const variants = ['S','M','L','XL'].map((size) => ({ sku: `TEE-${size}`, options: { color: 'Blue', size } }));
  const mediaAssets = ['a','b','c'].map((key) => ({ mediaAssetId: `11111111-1111-4111-8111-11111111111${key}`, displayOrder: 0 }));
  const preview = buildImportPreview({
    batch: { id: 'batch-multi', brandId: 'brand-multi', sourceSha256: 'a'.repeat(64), sourceAsOf: '2026-11-09T00:00:00.000Z' },
    mapping, taxonomy: taxonomy(),
    sourceRows: [{ rowNumber: 2, rawRecord: { 'product name': 'Tee', 'style code': 'TEE', sku: 'TEE-S', category: 'Tops', color: 'Blue', fabric: 'Cotton' },
      canonicalRecord: { variants, mediaAssets } }], targets: [],
  });
  assert.deepEqual(preview.rows[0].proposed.variants, variants);
  assert.deepEqual(preview.rows[0].proposed.mediaAssets, mediaAssets);
  assert.equal(preview.rows[0].proposed.categorySchemaVersion, 4);
  assert.ok(!preview.fieldMasks.some((field) => field.startsWith('variants.') || field.startsWith('mediaAssets.')),
    'per-target effects are frozen inputs, not user-selected product field masks');
});

test('REN2-77 freezes stable preview fingerprints and includes versions and field masks', () => {
  const input = {
    batch: { id: 'batch-1', brandId: 'brand-1', sourceSha256: 'a'.repeat(64), sourceAsOf: '2026-11-09T00:00:00.000Z' },
    mapping,
    taxonomy: taxonomy(),
    sourceRows: [sourceRows[0]],
    targets: [{ rowNumber: 2, productId: 'product-1', variantId: 'variant-1', rowVersion: 8, productRowVersion: 5, variantRowVersion: 8, contentVersion: 3, sku: 'LINEN-01-M', styleCode: 'LINEN-01', options: { color: 'Blue' } }],
    fieldMasks: ['title', 'styleCode', 'sku', 'options.color', 'attributes.fabric'],
  };
  const first = buildImportPreview(input);
  const replay = buildImportPreview(input);
  const nextRevision = buildImportPreview({ ...input, previewRevision: 2 });
  const changedTaxonomy = buildImportPreview({ ...input, taxonomy: { ...input.taxonomy, snapshotSha256: 'c'.repeat(64) } });

  assert.equal(first.previewHash, replay.previewHash);
  assert.notEqual(first.previewHash, changedTaxonomy.previewHash);
  assert.notEqual(first.previewHash, nextRevision.previewHash);
  assert.equal(first.previewRevision, 1);
  assert.equal(nextRevision.previewRevision, 2);
  assert.equal(first.mappingVersion, 1);
  assert.equal(first.taxonomySnapshotSha256, 'b'.repeat(64));
  assert.deepEqual(first.fieldMasks, [...input.fieldMasks].sort());
  assert.equal(first.rows[0].action, 'UPDATE');
  assert.equal(first.rows[0].targetVersion.productRowVersion, 5);
  assert.equal(first.rows[0].targetVersion.variantRowVersion, 8);
  assert.equal(first.counts.update, 1);
});

test('REN2-77 classifies a matching existing target as a no-op', () => {
  const preview = buildImportPreview({
    batch: { id: 'batch-1', brandId: 'brand-1', sourceSha256: 'a'.repeat(64), sourceAsOf: '2026-11-09T00:00:00.000Z' },
    mapping,
    taxonomy: taxonomy(),
    sourceRows: [sourceRows[0]],
    targets: [{ productId: 'product-1', variantId: 'variant-1', rowVersion: 1, productRowVersion: 1, variantRowVersion: 1,
      contentVersion: 1, sku: 'LINEN-01-M', styleCode: 'LINEN-01', title: 'Linen Shirt', categoryCode: 'apparel-tops',
      attributes: { fabric: 'Linen' }, options: { color: 'Blue' } }],
  });

  assert.equal(preview.rows[0].action, 'NOOP');
  assert.equal(preview.counts.noop, 1);
});

test('REN2-78 limits update field masks to fields present on that source row', () => {
  const preview = buildImportPreview({
    batch: { id: 'batch-optional', brandId: 'brand-optional', sourceSha256: 'a'.repeat(64), sourceAsOf: '2026-11-09T00:00:00.000Z', mode: 'UPDATE_MATCHED' },
    mapping, taxonomy: taxonomy(),
    sourceRows: [{ rowNumber: 7, rawRecord: { 'product name': 'Linen Shirt', 'style code': 'LINEN-01', sku: 'LINEN-01-M',
      category: 'Tops', fabric: 'Linen' } }],
    targets: [{ productId: 'product-7', variantId: 'variant-7', rowVersion: 3, productRowVersion: 2, variantRowVersion: 3,
      contentVersion: 2, sku: 'LINEN-01-M', styleCode: 'LINEN-01', title: 'Linen Shirt', categoryCode: 'apparel-tops',
      attributes: { fabric: 'Linen' }, options: { color: 'Blue' } }],
  });
  assert.equal(preview.rows[0].action, 'NOOP');
  assert.ok(!preview.rows[0].fieldMask.includes('options.color'));
});

test('REN2-78 keeps source price and image URL out of confirmation until their reviewed domain workflows are available', () => {
  const fields = { ...mapping.fields, MRP: 'sourceMrp', Image: 'imageUrl' };
  const preview = buildImportPreview({
    batch: { id: 'batch-safety', brandId: 'brand-safety', sourceSha256: 'a'.repeat(64), sourceAsOf: '2026-11-09T00:00:00.000Z' },
    mapping: { ...mapping, fields }, taxonomy: taxonomy(),
    sourceRows: [{ rowNumber: 8, rawRecord: { 'product name': 'Safe shirt', 'style code': 'SAFE-01', sku: 'SAFE-01-M',
      category: 'Tops', color: 'Blue', fabric: 'Linen', MRP: '2500', Image: 'https://merchant.example/image.jpg' } }],
    targets: [],
  });
  assert.equal(preview.rows[0].action, 'NEEDS_REVIEW');
  assert.deepEqual(preview.rows[0].conflicts.map((conflict) => conflict.code).sort(), ['MEDIA_REVIEW_REQUIRED', 'PRICE_REVIEW_REQUIRED']);
});

test('REN2-80 keeps Shopify price and image provenance visible while requiring material mapping and review', () => {
  const preview = buildImportPreview({
    batch: { id: 'shopify-provenance', brandId: 'brand-shopify', sourceSha256: 'a'.repeat(64), sourceAsOf: '2026-11-09T00:00:00.000Z' },
    mapping: { ...mapping, fields: { ...mapping.fields, 'URL handle': 'sourceProductKey' } },
    taxonomy: taxonomy(),
    sourceRows: [{ rowNumber: 2, rawRecord: { 'product name': 'Organic Shirt', 'style code': 'organic-shirt', sku: 'SHIRT-BLUE-S', category: 'Tops' },
      canonicalRecord: {
        variants: [{ sku: 'SHIRT-BLUE-S', options: { color: 'Blue', size: 'S' } }],
        attributes: { material: 'Cotton' },
        sourceVariantDetails: [{ sku: 'SHIRT-BLUE-S', price: 29.99, compareAtPrice: 39.99 }],
        sourceImageUrls: [{ url: 'https://cdn.shopify.example/front.webp', sourceRowNumber: 2 }],
        sourceRowNumbers: [2, 3], reviewCodes: [],
      } }],
    targets: [],
  });
  const row = preview.rows[0];
  assert.equal(row.action, 'NEEDS_REVIEW');
  assert.deepEqual(row.proposed.variants, [{ sku: 'SHIRT-BLUE-S', options: { color: 'Blue', size: 'S' } }]);
  assert.deepEqual(row.proposed.sourceImageUrls, [{ url: 'https://cdn.shopify.example/front.webp', sourceRowNumber: 2 }]);
  assert.deepEqual(row.proposed.sourceRowNumbers, [2, 3]);
  assert.ok(!row.proposed.mediaAssets, 'a source URL is never treated as an approved media asset');
  assert.ok(row.conflicts.some(({ code }) => code === 'PRICE_REVIEW_REQUIRED'));
  assert.ok(row.conflicts.some(({ code }) => code === 'MEDIA_REVIEW_REQUIRED'));
  assert.ok(row.conflicts.some(({ code }) => code === 'SHOPIFY_MATERIAL_MAPPING_REQUIRED'));
  assert.ok(!row.fieldMask.some((field) => field.startsWith('source')));
});

test('REN2-77 detects duplicate SKU/attribute identities and stale source dates', () => {
  const input = {
    batch: { id: 'batch-1', brandId: 'brand-1', sourceSha256: 'a'.repeat(64), sourceAsOf: '2025-01-01T00:00:00.000Z' },
    mapping,
    taxonomy: taxonomy(),
    sourceRows: [sourceRows[0], { ...sourceRows[0], rowNumber: 4 }],
    targets: [{ rowNumber: 2, productId: 'product-1', variantId: 'variant-1', rowVersion: 8, productRowVersion: 5, variantRowVersion: 8, contentVersion: 3, sku: 'LINEN-01-M', styleCode: 'LINEN-01', updatedAt: '2026-01-01T00:00:00.000Z' }],
  };
  const preview = buildImportPreview(input);

  assert.ok(preview.rows.every((row) => row.action === 'CONFLICT'));
  assert.ok(preview.rows.every((row) => row.conflicts.some((conflict) => conflict.code === 'SOURCE_STALE')));
  assert.equal(preview.counts.conflict, 2);
});

test('REN2-77 rejects changed variant attributes under an existing SKU', () => {
  const preview = buildImportPreview({
    batch: { id: 'batch-1', brandId: 'brand-1', sourceSha256: 'a'.repeat(64), sourceAsOf: '2026-11-09T00:00:00.000Z' },
    mapping,
    taxonomy: taxonomy(),
    sourceRows: [sourceRows[0]],
    targets: [{ productId: 'product-1', variantId: 'variant-1', rowVersion: 1, productRowVersion: 1, variantRowVersion: 1,
      contentVersion: 1, sku: 'LINEN-01-M', styleCode: 'LINEN-01', categoryCode: 'apparel-tops', options: { color: 'Red' } }],
  });

  assert.equal(preview.rows[0].action, 'CONFLICT');
  assert.ok(preview.rows[0].conflicts.some(({ code }) => code === 'SKU_ATTR_CONFLICT'));
});

test('REN2-77 refuses to preview updates to non-editable published products or non-draft variants', () => {
  const base = {
    batch: { id: 'batch-1', brandId: 'brand-1', sourceSha256: 'a'.repeat(64), sourceAsOf: '2026-11-09T00:00:00.000Z' },
    mapping,
    taxonomy: taxonomy(),
    sourceRows: [sourceRows[0]],
    targets: [{ productId: 'product-1', variantId: 'variant-1', rowVersion: 8, productRowVersion: 5, variantRowVersion: 8,
      contentVersion: 3, sku: 'LINEN-01-M', styleCode: 'LINEN-01', title: 'Linen Shirt', categoryCode: 'apparel-tops' }],
  };
  const archived = buildImportPreview({ ...base, targets: [{ ...base.targets[0], productState: 'ARCHIVED' }] });
  assert.equal(archived.rows[0].action, 'CONFLICT');
  assert.ok(archived.rows[0].conflicts.some(({ code }) => code === 'PRODUCT_STATE_RESTRICTED'));
  const activeVariant = buildImportPreview({ ...base, targets: [{ ...base.targets[0], productState: 'DRAFT', variantState: 'ACTIVE' }] });
  assert.equal(activeVariant.rows[0].action, 'CONFLICT');
  assert.ok(activeVariant.rows[0].conflicts.some(({ code }) => code === 'VARIANT_STATE_RESTRICTED'));
});

test('REN2-77 respects explicit import mode and refuses rows missing canonical identity fields', () => {
  const base = {
    batch: { id: 'batch-1', brandId: 'brand-1', sourceSha256: 'a'.repeat(64), sourceAsOf: '2026-11-09T00:00:00.000Z' },
    mapping,
    taxonomy: taxonomy(),
    sourceRows: [sourceRows[0]],
    targets: [{ productId: 'product-1', variantId: 'variant-1', rowVersion: 8, sku: 'LINEN-01-M', styleCode: 'LINEN-01', title: 'Linen Shirt', categoryCode: 'apparel-tops', options: { color: 'Blue' }, attributes: { fabric: 'Linen' } }],
  };
  assert.equal(buildImportPreview({ ...base, batch: { ...base.batch, mode: 'CREATE_ONLY' } }).rows[0].action, 'CONFLICT');
  assert.equal(buildImportPreview({ ...base, batch: { ...base.batch, mode: 'REVIEW_CONFLICT' } }).rows[0].action, 'CONFLICT');

  const missingSku = buildImportPreview({ ...base, sourceRows: [{ rowNumber: 5, rawRecord: { 'product name': 'No SKU', 'style code': 'NO-SKU' } }], targets: [] });
  assert.equal(missingSku.rows[0].action, 'INVALID');
  assert.equal(missingSku.rows[0].conflicts[0].code, 'IMPORT_REQUIRED_FIELD');
});

test('REN2-77 rejects field masks that are not present in the mapped source rows', () => {
  assert.throws(() => buildImportPreview({
    batch: { id: 'batch-1', brandId: 'brand-1', sourceSha256: 'a'.repeat(64), sourceAsOf: '2026-11-09T00:00:00.000Z' },
    mapping,
    taxonomy: taxonomy(),
    sourceRows: [sourceRows[0]],
    targets: [],
    previewRevision: 1,
    fieldMasks: ['title', 'imageUrl'],
  }), { name: 'ImportPreviewError', code: 'IMPORT_MAPPING_INVALID' });
});

test('REN2-77 validates mapped attributes against the pinned category schema and value rules', () => {
  const schemaTaxonomy = {
    version: 4,
    snapshotSha256: 'b'.repeat(64),
    categories: [{ code: 'apparel-tops', active: true, categoryId: '11111111-1111-4111-8111-111111111111',
      schemaVersionId: '22222222-2222-4222-8222-222222222222', schemaVersion: 4, validatorVersion: 'w2-attribute-validator-v1',
      attributes: [
        { id: '33333333-3333-4333-8333-333333333333', attributeId: '44444444-4444-4444-8444-444444444444', code: 'fabric', scope: 'product', valueType: 'text', requiredByDefault: false },
        { id: '55555555-5555-4555-8555-555555555555', attributeId: '66666666-6666-4666-8666-666666666666', code: 'color', scope: 'variant', valueType: 'enum', allowedValues: ['Blue','Red'], requiredByDefault: false },
      ] }],
  };
  const base = { batch: { id: 'batch-1', brandId: 'brand-1', sourceSha256: 'a'.repeat(64), sourceAsOf: '2026-11-09T00:00:00.000Z' },
    mapping, taxonomy: schemaTaxonomy, sourceRows: [sourceRows[0]], targets: [] };
  const invalidValue = buildImportPreview({ ...base, sourceRows: [{ ...sourceRows[0], rawRecord: { ...sourceRows[0].rawRecord, color: 'Green' } }] });
  assert.equal(invalidValue.rows[0].action, 'INVALID');
  assert.ok(invalidValue.rows[0].conflicts.some(({ code }) => code === 'ATTRIBUTE_VALUE_INVALID'));
  const unknownAttribute = buildImportPreview({ ...base,
    mapping: { ...mapping, fields: { ...mapping.fields, Unknown: 'attributes.unknown' } },
    sourceRows: [{ ...sourceRows[0], rawRecord: { ...sourceRows[0].rawRecord, Unknown: 'value' } }],
  });
  assert.equal(unknownAttribute.rows[0].action, 'NEEDS_REVIEW');
  assert.ok(unknownAttribute.rows[0].conflicts.some(({ code }) => code === 'ATTRIBUTE_NOT_IN_SCHEMA'));
});

test('REN2-77 sends mapped attributes to review when the pinned category schema is incomplete', () => {
  const preview = buildImportPreview({
    batch: { id: 'batch-1', brandId: 'brand-1', sourceSha256: 'a'.repeat(64), sourceAsOf: '2026-11-09T00:00:00.000Z' },
    mapping,
    taxonomy: { version: 4, snapshotSha256: 'b'.repeat(64), categories: [{ code: 'apparel-tops', active: true }] },
    sourceRows: [sourceRows[0]],
    targets: [],
  });

  assert.equal(preview.rows[0].action, 'NEEDS_REVIEW');
  assert.ok(preview.rows[0].conflicts.some(({ code }) => code === 'CATEGORY_SCHEMA_UNAVAILABLE'));
});
