'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const { parseCatalogCsv } = require('../../dist/modules/imports/import-csv-parser.js');
const { buildImportPreview } = require('../../dist/modules/imports/import-preview-engine.js');

const officialTemplate = readFileSync(join(__dirname, '../fixtures/shopify-product-template.current.csv'));
const columns = ['Title', 'URL handle', 'Product category', 'SKU', 'Variant Barcodes', 'Option1 name', 'Option1 value',
  'Option2 name', 'Option2 value', 'Price', 'Compare-at price', 'Product image URL', 'Variant image URL', 'Fabric (product.metafields.custom.fabric)'];
function csvRow(data) {
  return columns.map((column) => {
    const value = data[column] ?? '';
    return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
  }).join(',');
}
function csvFixture(rows) { return Buffer.from([columns.join(','), ...rows.map(csvRow)].join('\n')); }

test('REN2-80 recognizes the pinned official Shopify current product template', () => {
  const result = parseCatalogCsv({ sourceKind: 'SHOPIFY_CSV', bytes: officialTemplate });
  assert.equal(result.profileId, 'shopify-product-csv');
  assert.equal(result.profileVersion, '2026-11-09');
  assert.ok(result.catalogRows.some((product) => product.sourceProductKey === 'physical-product-the-band-t-shirt'
    && product.variants.some((variant) => variant.sku === 'TheBandTShirt-SG')));
  assert.deepEqual(result.stockObservations, [], 'Shopify product exports do not make Renivet stock writes');
  assert.ok(result.catalogRows.some((product) => product.reviewCodes.includes('SHOPIFY_UNMAPPED_FIELDS')),
    'non-empty unsupported fields are explicitly surfaced as lossy');
});

test('REN2-80 groups Shopify product, continuation, and image rows into one canonical product', () => {
  const result = parseCatalogCsv({ sourceKind: 'SHOPIFY_CSV', bytes: csvFixture([
    { Title: 'Organic Shirt', 'URL handle': 'organic-shirt', 'Product category': 'Apparel > Shirts', SKU: 'SHIRT-BLUE-S',
      'Variant Barcodes': 'gtin:8900000000012', 'Option1 name': 'Color', 'Option1 value': 'Blue', 'Option2 name': 'Size',
      'Option2 value': 'S', Price: '29.99', 'Compare-at price': '39.99', 'Product image URL': 'https://cdn.shopify.example/front.webp',
      'Fabric (product.metafields.custom.fabric)': 'Cotton' },
    { 'URL handle': 'organic-shirt', SKU: 'SHIRT-BLUE-M', 'Variant Barcodes': 'gtin:8900000000029', 'Option1 value': 'Blue',
      'Option2 value': 'M', Price: '29.99', 'Compare-at price': '39.99' },
    { 'URL handle': 'organic-shirt', 'Variant image URL': 'https://cdn.shopify.example/back.webp' },
  ]) });

  assert.equal(result.catalogRows.length, 1);
  const product = result.catalogRows[0];
  assert.equal(product.sourceRecordKey, 'organic-shirt');
  assert.equal(product.sourceProductKey, 'organic-shirt');
  assert.equal(product.title, 'Organic Shirt');
  assert.deepEqual(product.variants, [
    { sku: 'SHIRT-BLUE-S', options: { color: 'Blue', size: 'S' } },
    { sku: 'SHIRT-BLUE-M', options: { color: 'Blue', size: 'M' } },
  ]);
  assert.deepEqual(product.sourceVariantDetails, [
    { sku: 'SHIRT-BLUE-S', barcode: 'gtin:8900000000012', price: 29.99, compareAtPrice: 39.99 },
    { sku: 'SHIRT-BLUE-M', barcode: 'gtin:8900000000029', price: 29.99, compareAtPrice: 39.99 },
  ]);
  assert.deepEqual(product.sourceImageUrls, [
    { url: 'https://cdn.shopify.example/front.webp', sourceRowNumber: 2, sourceColumn: 'product image url' },
    { url: 'https://cdn.shopify.example/back.webp', sourceRowNumber: 4, sourceColumn: 'variant image url' },
  ]);
  assert.deepEqual(product.sourceRowNumbers, [2, 3, 4]);
  assert.deepEqual(result.catalogRowNumbers, [2]);
  assert.deepEqual(result.rowErrors, []);
  assert.deepEqual(result.stockObservations, []);

  const preview = buildImportPreview({
    batch: { id: 'shopify-fixture', brandId: 'brand-shopify', sourceSha256: 'a'.repeat(64), sourceAsOf: '2026-11-09T00:00:00.000Z' },
    mapping: { version: 1, fields: { Title: 'title', 'URL handle': 'styleCode', SKU: 'sku', 'Product category': 'categoryCode',
      'Fabric (product.metafields.custom.fabric)': 'attributes.material' }, categories: {} },
    taxonomy: { version: 1, snapshotSha256: 'b'.repeat(64), categories: [] },
    sourceRows: [{ rowNumber: result.catalogRowNumbers[0], rawRecord: result.rawRows[0].rawRecord, canonicalRecord: product }],
    targets: [],
  });
  assert.equal(preview.rows[0].action, 'NEEDS_REVIEW');
  assert.deepEqual(preview.rows[0].proposed.variants, product.variants);
  assert.deepEqual(preview.rows[0].proposed.sourceIdentity, { productKey: product.sourceProductKey,
    recordKey: product.sourceRecordKey, variantKeys: product.variants.map(({ sku }) => sku) });
  assert.deepEqual(preview.rows[0].proposed.sourceImageUrls, product.sourceImageUrls);
  assert.ok(preview.rows[0].conflicts.some(({ code }) => code === 'PRICE_REVIEW_REQUIRED'));
  assert.ok(preview.rows[0].conflicts.some(({ code }) => code === 'MEDIA_REVIEW_REQUIRED'));
  assert.ok(!preview.rows[0].proposed.mediaAssets, 'source image URLs are not approved media assets');
});

test('REN2-80 flags absent material, size, and product category as required review items', () => {
  const result = parseCatalogCsv({ sourceKind: 'SHOPIFY_CSV', bytes: csvFixture([
    { Title: 'Plain Tee', 'URL handle': 'plain-tee', SKU: 'PLAIN-TEE', 'Option1 name': 'Color', 'Option1 value': 'Black' },
  ]) });
  assert.deepEqual(result.catalogRows[0].reviewCodes.sort(), [
    'SHOPIFY_CATEGORY_MISSING', 'SHOPIFY_MATERIAL_MISSING', 'SHOPIFY_SIZE_MISSING',
  ]);
  const preview = buildImportPreview({
    batch: { id: 'shopify-missing', brandId: 'brand-shopify', sourceSha256: 'c'.repeat(64), sourceAsOf: '2026-11-09T00:00:00.000Z' },
    mapping: { version: 1, fields: { Title: 'title', 'URL handle': 'styleCode', SKU: 'sku' }, categories: {} },
    taxonomy: { version: 1, snapshotSha256: 'd'.repeat(64), categories: [] },
    sourceRows: [{ rowNumber: result.catalogRowNumbers[0], rawRecord: result.rawRows[0].rawRecord, canonicalRecord: result.catalogRows[0] }],
    targets: [],
  });
  assert.equal(preview.rows[0].action, 'NEEDS_REVIEW');
  assert.ok(preview.rows[0].conflicts.some(({ code }) => code === 'SHOPIFY_MATERIAL_MISSING'));
  assert.ok(preview.rows[0].conflicts.some(({ code }) => code === 'SHOPIFY_SIZE_MISSING'));
  assert.ok(preview.rows[0].conflicts.some(({ code }) => code === 'SHOPIFY_CATEGORY_MISSING'));
});

test('REN2-80 retains source lines without a product handle as row-level invalid input', () => {
  const result = parseCatalogCsv({ sourceKind: 'SHOPIFY_CSV', bytes: csvFixture([
    { Title: 'Unkeyed Product', SKU: 'UNKEYED-1', 'Option1 name': 'Size', 'Option1 value': 'S' },
  ]) });
  assert.deepEqual(result.rowErrors, [{ sourceRowNumber: 2, code: 'SHOPIFY_HANDLE_MISSING' }]);
  assert.deepEqual(result.rawRows, [{ sourceRowNumber: 2, rawRecord: Object.fromEntries(columns.map((column) => [column.toLowerCase(),
    column === 'Title' ? 'Unkeyed Product' : column === 'SKU' ? 'UNKEYED-1' : column === 'Option1 name' ? 'Size' : column === 'Option1 value' ? 'S' : ''])) }]);
});

test('REN2-80 flags additional populated material metafields it cannot map', () => {
  const csv = [
    'Title,URL handle,Option1 value,SKU,Material,Fabric',
    'Multi Fabric Tee,multi-fabric-tee,S,MULTI-TEE,Cotton,Recycled Cotton',
  ].join('\n');
  const result = parseCatalogCsv({ sourceKind: 'SHOPIFY_CSV', bytes: Buffer.from(csv) });
  const product = result.catalogRows[0];
  assert.deepEqual(product.attributes, { material: 'Cotton' });
  assert.deepEqual(product.sourceLossyFields, ['fabric']);
  assert.ok(product.reviewCodes.includes('SHOPIFY_UNMAPPED_FIELDS'));
});
