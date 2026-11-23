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

test('import maps differently cased enum values to the unique category value', () => {
  const input = { batch: { id: 'batch-case', brandId: 'brand-1', sourceSha256: 'a'.repeat(64), sourceAsOf: '2026-11-09T00:00:00.000Z' },
    mapping, taxonomy: taxonomy(), sourceRows: [{ ...sourceRows[0], rawRecord: { ...sourceRows[0].rawRecord, color: 'BLUE' } }], targets: [] };
  const preview = buildImportPreview(input);
  assert.equal(preview.rows[0].action, 'CREATE');
  assert.equal(preview.rows[0].proposed.options.color, 'Blue');
  assert.equal(input.sourceRows[0].rawRecord.color, 'BLUE');
});

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
  assert.equal(preview.rows[0].action, 'CREATE');
  assert.equal(preview.rows[0].proposed.sourceMrp, 2500);
  assert.equal(preview.rows[0].proposed.imageUrl, 'https://merchant.example/image.jpg');
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
  assert.equal(row.action, 'CREATE', 'supported source fields may create a private draft even when other columns require review');
  assert.ok(row.proposed.importDraftSafe, 'the review payload retains a sanitized private-draft projection');
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
  assert.equal(invalidValue.rows[0].action, 'CREATE', 'invalid attribute values must not block saving the private draft');
  assert.equal(invalidValue.rows[0].proposed.options.color, 'Green', 'original invalid value retained in source');
  assert.deepEqual(invalidValue.rows[0].proposed.importDraftSafe.variants, [], 'invalid empty-option variant is not inserted into the canonical draft');
  assert.ok(invalidValue.rows[0].conflicts.some(({ code }) => code === 'ATTRIBUTE_VALUE_INVALID'));
  const unknownAttribute = buildImportPreview({ ...base,
    mapping: { ...mapping, fields: { ...mapping.fields, Unknown: 'attributes.unknown' } },
    sourceRows: [{ ...sourceRows[0], rawRecord: { ...sourceRows[0].rawRecord, Unknown: 'value' } }],
  });
  assert.equal(unknownAttribute.rows[0].action, 'CREATE', 'unknown source attributes are retained but not applied to canonical draft');
  assert.equal(unknownAttribute.rows[0].proposed.attributes.unknown, 'value');
  assert.ok(!Object.hasOwn(unknownAttribute.rows[0].proposed.importDraftSafe.attributes, 'unknown'));
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

test('Renivet template resolves already-active category codes without explicit category mappings', () => {
  const input = {
    batch: { id: 'batch-direct-category', brandId: 'brand-direct', sourceSha256: 'a'.repeat(64), sourceAsOf: '2026-11-20T00:00:00.000Z' },
    mapping: { version: 1, fields: { styleCode: 'styleCode', title: 'title', sku: 'sku', categoryCode: 'categoryCode' }, categories: {} },
    taxonomy: { version: 2, snapshotSha256: 'b'.repeat(64), categories: [{
      code: 'test', active: true, categoryId: '11111111-1111-4111-8111-111111111111',
      schemaVersionId: '22222222-2222-4222-8222-222222222222', schemaVersion: 2,
      validatorVersion: 'w2-attribute-validator-v1', attributes: [],
    }] },
    sourceRows: [{ rowNumber: 2, rawRecord: { styleCode: '123434', title: 'TESTR', sku: '1234R', categoryCode: 'test' } }],
    targets: [],
  };
  const preview = buildImportPreview(input);
  assert.equal(preview.rows[0].action, 'CREATE');
  assert.equal(preview.rows[0].proposed.categoryCode, 'test');
  assert.deepEqual(preview.rows[0].conflicts, []);
  assert.equal(preview.counts.create, 1);

  const unknown = buildImportPreview({ ...input, sourceRows: [{ rowNumber: 2, rawRecord: { ...input.sourceRows[0].rawRecord, categoryCode: 'does-not-exist' } }] });
  assert.equal(unknown.rows[0].action, 'NEEDS_REVIEW');
  assert.ok(unknown.rows[0].conflicts.some(({ code }) => code === 'CATEGORY_UNMAPPED'));

  const inactive = buildImportPreview({ ...input, taxonomy: { ...input.taxonomy, categories: [{ ...input.taxonomy.categories[0], active: false }] } });
  assert.equal(inactive.rows[0].action, 'NEEDS_REVIEW');
  assert.ok(inactive.rows[0].conflicts.some(({ code }) => code === 'CATEGORY_INACTIVE'));
});

test('explicit source category mapping takes precedence over direct matching', () => {
  const preview = buildImportPreview({
    batch: { id: 'batch-mapped', brandId: 'brand-mapped', sourceSha256: 'a'.repeat(64), sourceAsOf: '2026-11-20T00:00:00.000Z' },
    mapping: { version: 1, fields: { styleCode:'styleCode', title:'title', sku:'sku', categoryCode:'categoryCode' }, categories: { 'external-tops': 'test' } },
    taxonomy: { version: 2, snapshotSha256: 'b'.repeat(64), categories: [{
      code: 'test', active: true, categoryId: '11111111-1111-4111-8111-111111111111',
      schemaVersionId: '22222222-2222-4222-8222-222222222222', schemaVersion: 2,
      validatorVersion: 'w2-attribute-validator-v1', attributes: [],
    }] },
    sourceRows: [{ rowNumber: 2, rawRecord: { styleCode: '123434', title:'TESTR', sku:'1234R', categoryCode:'external-tops' } }],
    targets: [],
  });
  assert.equal(preview.rows[0].action, 'CREATE');
  assert.equal(preview.rows[0].proposed.categoryCode, 'test');
});

test('price-only Renivet import creates a private draft with price provenance pending review', () => {
  const preview = buildImportPreview({
    batch: { id: 'batch-price', brandId: 'brand-price', sourceSha256: 'a'.repeat(64), sourceAsOf: '2026-11-20T00:00:00.000Z' },
    mapping: { version: 1, fields: { 'product name': 'title', 'style code': 'styleCode', sku: 'sku', category: 'categoryCode', MRP: 'sourceMrp' }, categories: { tops: 'apparel-tops' } },
    taxonomy: taxonomy(),
    sourceRows: [{ rowNumber: 2, rawRecord: { 'product name': 'Priced shirt', 'style code': 'SHIRT-PRICE', sku: 'SHIRT-PRICE-M', category: 'tops', MRP: '1233' } }],
    targets: [],
  });
  assert.equal(preview.counts.create, 1);
  assert.equal(preview.counts.review, 0);
  assert.deepEqual(preview.rows[0].conflicts.map(c => c.code), ['PRICE_REVIEW_REQUIRED']);
  assert.equal(preview.rows[0].proposed.sourceMrp, 1233);
});

test('price review does not bypass invalid category validation', () => {
  const preview = buildImportPreview({
    batch: { id: 'batch-badcategory', brandId: 'brand-price', sourceSha256: 'a'.repeat(64), sourceAsOf: '2026-11-20T00:00:00.000Z' },
    mapping: { version: 1, fields: { 'product name': 'title', 'style code': 'styleCode', sku: 'sku', category: 'categoryCode', MRP: 'sourceMrp' }, categories: {} },
    taxonomy: taxonomy(),
    sourceRows: [{ rowNumber: 2, rawRecord: { 'product name': 'Priced shirt', 'style code': 'SHIRT-PRICE', sku: 'SHIRT-PRICE-M', category: 'missing', MRP: '1233' } }],
    targets: [],
  });
  assert.equal(preview.rows[0].action, 'NEEDS_REVIEW');
  assert.ok(preview.rows[0].conflicts.some(c => c.code === 'CATEGORY_UNMAPPED'));
  assert.ok(preview.rows[0].conflicts.some(c => c.code === 'PRICE_REVIEW_REQUIRED'));
});

test('invalid colour in an existing category still permits a private product draft with original values retained', () => {
  const input = {
    batch: { id: 'brand-import-options', brandId: 'brand-test', sourceSha256: 'a'.repeat(64), sourceAsOf: '2026-11-20T00:00:00.000Z' },
    mapping, taxonomy: taxonomy(), targets: [],
    sourceRows: [{ rowNumber: 2, rawRecord: {
      'product name': 'Imported shirt', 'style code': 'IMPORT-TEE', sku: 'IMPORT-TEE-M',
      category: 'Tops', color: 'BLACK', fabric: 'Linen',
    } }],
  };
  const preview = buildImportPreview(input);
  assert.equal(preview.rows[0].action, 'CREATE');
  assert.equal(preview.counts.create, 1);
  assert.ok(preview.rows[0].conflicts.some((issue) => issue.code === 'ATTRIBUTE_VALUE_INVALID'));
  assert.equal(preview.rows[0].proposed.options.color, 'BLACK', 'original option remains in the frozen preview');
  assert.deepEqual({ ...preview.rows[0].proposed.importDraftSafe.attributes }, { fabric: 'Linen' });
  assert.deepEqual(preview.rows[0].proposed.importDraftSafe.variants, [], 'empty-option variant is not written to canonical draft');
  assert.equal(preview.rows[0].proposed.sku, 'IMPORT-TEE-M', 'original SKU remains in frozen source preview');
  assert.ok(preview.rows[0].conflicts.some((issue) => issue.code === 'IMPORT_VARIANTS_NEED_EDITING'));
  assert.equal(preview.rows[0].proposed.categoryCode, 'apparel-tops');
});

test('unknown category still stages the source for an automatic category request', () => {
  const input = {
    batch: { id: 'unknown-category', brandId: 'brand-test', sourceSha256: 'a'.repeat(64), sourceAsOf: '2026-11-20T00:00:00.000Z' },
    mapping: { ...mapping, categories: {} }, taxonomy: taxonomy(), targets: [],
    sourceRows: [{ rowNumber: 2, rawRecord: {
      'product name': 'Novel item', 'style code': 'NOVEL-001', sku: 'NOVEL-001-M', category: 'never-created', color: 'Blue',
    } }],
  };
  const preview = buildImportPreview(input);
  assert.equal(preview.rows[0].action, 'NEEDS_REVIEW');
  assert.equal(preview.rows[0].proposed.categoryCode, 'never-created');
  assert.ok(preview.rows[0].conflicts.some((issue) => issue.code === 'CATEGORY_UNMAPPED'));
  assert.equal(preview.rows[0].proposed.importDraftSafe, undefined, 'unknown taxonomy can never be used to make a canonical draft');
});


test('Unicommerce sample CSV fields create four private drafts without a styleCode column', () => {
  const { parseCatalogCsv } = require('../../dist/modules/imports/import-csv-parser.js');
  const csv = [
    'categoryCode,skuCode,name,type,color,size,maxRetailPrice,basePrice,imageUrl,externalItemId',
    'TSHIRTS,BAND-TEE-GRN-S,The Band Graphic T-Shirt - Green - Small,SIMPLE,Green,S,2499,1999,https://example.com/band.jpg,BAND-TEE',
    'TSHIRTS,BASIC-TEE-BLK-M,Essential Cotton T-Shirt - Black - Medium,SIMPLE,Black,M,1299,899,https://example.com/basic.jpg,BASIC-TEE',
    'TSHIRTS,OVERSIZED-TEE-BLU-L,Oversized Everyday T-Shirt - Blue - Large,SIMPLE,Blue,L,1899,1399,https://example.com/oversized.jpg,OVERSIZED-TEE',
    'TSHIRTS,GRAPHIC-TEE-WHT-XL,Abstract Graphic T-Shirt - White - Extra Large,SIMPLE,White,XL,1799,1199,https://example.com/graphic.jpg,GRAPHIC-TEE',
  ].join('\n') + '\n';
  const parsed = parseCatalogCsv({ bytes: Buffer.from(csv), sourceKind: 'UNIWARE_CSV', sourceAsOf: '2026-11-20T00:00:00.000Z' });
  assert.equal(parsed.catalogRows.length, 4);
  assert.deepEqual(parsed.rowErrors, []);
  const preview = buildImportPreview({
    batch: { id: 'uniware-template-four', brandId: 'brand-1', sourceSha256: 'f'.repeat(64), sourceAsOf: '2026-11-20T00:00:00.000Z' },
    mapping: { version: 1, fields: {
      skuCode: 'sku', name: 'title', categoryCode: 'categoryCode', color: 'options.color',
      size: 'options.size', maxRetailPrice: 'sourceMrp', imageUrl: 'imageUrl',
    }, categories: { TSHIRTS: 'apparel-tops' } },
    taxonomy: taxonomy(), targets: [],
    sourceRows: parsed.rawRows.map((r) => ({
      rowNumber: r.sourceRowNumber, rawRecord: r.rawRecord,
      canonicalRecord: parsed.catalogRows[parsed.catalogRowNumbers.indexOf(r.sourceRowNumber)],
    })),
  });
  assert.equal(preview.counts.create, 4);
  assert.equal(preview.counts.invalid, 0);
  assert.deepEqual(preview.rows.map((row) => row.proposed.styleCode), [
    'BAND-TEE', 'BASIC-TEE', 'OVERSIZED-TEE', 'GRAPHIC-TEE',
  ]);
  assert.ok(preview.rows.every((row) => row.proposed.sourceMrp > 0));
  assert.ok(preview.rows.every((row) => row.proposed.importDraftSafe));
});

test('Uniware can fall back to SKU when externalItemId is empty, but generic CSV still needs a mapped style', () => {
  const batch = { id: 'missing-style', brandId: 'brand-1', sourceSha256: 'a'.repeat(64), sourceAsOf: '2026-11-20T00:00:00.000Z' };
  const common = { batch, taxonomy: taxonomy(), targets: [],
    mapping: { version: 1, fields: { skuCode: 'sku', name: 'title', categoryCode: 'categoryCode' }, categories: { TSHIRTS: 'apparel-tops' } } };
  const uniware = buildImportPreview({ ...common, sourceRows: [{
    rowNumber: 2, rawRecord: { skucode: 'SKU-ONLY', name: 'SKU only', categorycode: 'TSHIRTS', externalitemid: '' },
  }] });
  assert.equal(uniware.rows[0].action, 'CREATE');
  assert.equal(uniware.rows[0].proposed.styleCode, 'SKU-ONLY');

  const generic = buildImportPreview({ ...common,
    mapping: { ...common.mapping, fields: { sku: 'sku', title: 'title', category: 'categoryCode' } },
    sourceRows: [{ rowNumber: 2, rawRecord: { sku: 'GENERIC-1', title: 'Generic item', category: 'TSHIRTS' } }],
  });
  assert.equal(generic.rows[0].action, 'INVALID');
  assert.ok(generic.rows[0].conflicts.some((issue) => issue.code === 'IMPORT_REQUIRED_FIELD'));
});

test('Uniware active category code and missing option columns do not require manual category/style remapping', () => {
  const preview = buildImportPreview({
    batch: { id:'uniware-direct-category', brandId:'brand-direct', sourceSha256:'b'.repeat(64), sourceAsOf:'2026-11-20T00:00:00.000Z' },
    mapping: { version:1, fields: { skuCode:'sku', name:'title', categoryCode:'categoryCode' }, categories:{} },
    taxonomy: taxonomy(), targets: [],
    sourceRows: [{ rowNumber:2,
      rawRecord: { skucode:'DIRECT-SKU', name:'Direct category test', categorycode:'apparel-tops',
        externalitemid:'DIRECT-STYLE' },
      canonicalRecord: { sourceProductKey:'DIRECT-STYLE',
        reviewCodes:['UNIWARE_CATEGORY_MAPPING_REQUIRED','UNIWARE_STYLE_CODE_MAPPING_REQUIRED'] },
    }],
  });
  assert.equal(preview.rows[0].action, 'CREATE');
  assert.equal(preview.rows[0].proposed.styleCode, 'DIRECT-STYLE');
  assert.deepEqual(preview.rows[0].proposed.importDraftSafe.variants, []);
  assert.ok(!preview.rows[0].conflicts.some((issue) =>
    ['UNIWARE_CATEGORY_MAPPING_REQUIRED','UNIWARE_STYLE_CODE_MAPPING_REQUIRED'].includes(issue.code)));
});
