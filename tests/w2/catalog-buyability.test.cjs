'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { CatalogBuyabilityPostgresPort, validateBuyabilityRequest } = require('../../dist/modules/catalog/catalog-buyability.js');

const valid = Object.freeze({
  brandId: '8d44ec62-9760-4df1-839d-042c6fd03839',
  productId: '9d44ec62-9760-4df1-839d-042c6fd03839',
  variantId: 'ad44ec62-9760-4df1-839d-042c6fd03839',
  sku: 'SKU-TEE-1',
  expectedPublicationVersion: 4,
  expectedPriceId: 'bd44ec62-9760-4df1-839d-042c6fd03839',
  expectedPriceRowVersion: 2,
});

test('REN2-75 validates a versioned brand, product, SKU, publication and price recheck request', () => {
  assert.deepEqual(validateBuyabilityRequest(valid), valid);
});

test('REN2-75 rejects malformed identifiers, stale-version hints, and unknown request fields', () => {
  for (const input of [
    { ...valid, brandId: 'not-a-uuid' },
    { ...valid, expectedPublicationVersion: 0 },
    { ...valid, expectedPriceRowVersion: -1 },
    { ...valid, extra: 'ignored fields are unsafe' },
    { ...valid, sku: '  ' },
  ]) assert.throws(() => validateBuyabilityRequest(input), (error) => error.code === 'CATALOG_BUYABILITY_REQUEST_INVALID');
});

test('REN2-75 request pins both the indexed publication and observed price versions', () => {
  const result = validateBuyabilityRequest(valid);
  assert.equal(result.expectedPublicationVersion, 4);
  assert.equal(result.expectedPriceRowVersion, 2);
});

test('REN2-75 port configuration accepts synthetic consumers only and copies its allowlist', async () => {
  const consumers = ['w3.checkout.synthetic'];
  const port = new CatalogBuyabilityPostgresPort(consumers);
  consumers.push('w3.checkout.production');
  assert.throws(() => new CatalogBuyabilityPostgresPort(['w3.checkout.production']), /synthetic buyability consumer/);
  await assert.rejects(port.validate({}, valid, 'w3.checkout.production'), (error) => error.code === 'CATALOG_BUYABILITY_CALLER_DENIED');
});
