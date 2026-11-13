'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');

test('SKU mutation If-Match is documented as the parent product version', () => {
  const openapi = JSON.parse(fs.readFileSync('openapi/renivet.openapi.json', 'utf8'));
  const operations = openapi.paths['/api/v1/brands/{brandId}/products/{productId}/variants/{variantId}'];
  for (const method of ['patch', 'delete']) {
    const header = operations[method].parameters.find((parameter) => parameter.name === 'If-Match');
    assert.equal(header.description, 'Quoted parent product rowVersion.');
  }
  const repository = fs.readFileSync('src/modules/catalog/product-draft.repository.ts', 'utf8');
  assert.match(repository, /Number\(found\.product_row_version\) !== expectedRowVersion/);
  assert.match(repository, /found\.row_version/);
});
