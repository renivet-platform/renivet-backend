'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { deriveImportEffectKey } = require('../../dist/modules/imports/import-effect-keys.js');

test('REN2-78 derives a stable brand, batch, row, kind, target, and payload scoped effect key', () => {
  const base = { brandId: 'brand-1', batchId: 'batch-1', sourceRowNumber: 4,
    effectKind: 'VARIANT_UPSERT', logicalTargetKey: 'sku:TEE-BLUE-S', payload: { sku: 'TEE-BLUE-S', options: { size: 'S', color: 'Blue' } } };
  assert.deepEqual(deriveImportEffectKey(base), deriveImportEffectKey({ ...base, payload: { options: { color: 'Blue', size: 'S' }, sku: 'TEE-BLUE-S' } }));
  for (const changed of [
    { ...base, brandId: 'brand-2' }, { ...base, batchId: 'batch-2' }, { ...base, sourceRowNumber: 5 },
    { ...base, effectKind: 'PRODUCT_UPDATE' }, { ...base, logicalTargetKey: 'sku:TEE-BLUE-M' },
    { ...base, payload: { ...base.payload, sku: 'TEE-BLUE-M' } },
  ]) assert.notEqual(deriveImportEffectKey(base).effectKey, deriveImportEffectKey(changed).effectKey);
});

test('REN2-78 identifies four variant and three media effects as seven distinct logical receipts', () => {
  const specs = [
    ...['S','M','L','XL'].map((size) => ({ effectKind: 'VARIANT_UPSERT', logicalTargetKey: `sku:TEE-${size}`, payload: { sku: `TEE-${size}`, size } })),
    ...['a','b','c'].map((asset) => ({ effectKind: 'MEDIA_LINK', logicalTargetKey: `media:${asset}`, payload: { mediaAssetId: asset } })),
  ];
  const keys = specs.map((spec) => deriveImportEffectKey({ brandId: 'brand', batchId: 'batch', sourceRowNumber: 2, ...spec }).effectKey);
  assert.equal(new Set(keys).size, 7);
});

