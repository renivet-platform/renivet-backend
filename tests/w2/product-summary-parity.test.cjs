const assert = require('node:assert/strict');
const test = require('node:test');
const { readFileSync } = require('node:fs');

test('SE-08 updated/category metadata uses the existing ordered persisted product read', () => {
  const source = readFileSync('src/modules/catalog/product-read.repository.ts','utf8');
  assert.match(source,/p\.updated_at/);
  assert.match(source,/row\.cursor_updated_at/);
  assert.match(source,/categoryId: row\.category_id/);
  assert.match(source,/updatedAt: row\.cursor_updated_at/);
  assert.match(source,/buildBrandScopePredicate\('p', context, 1\)/);
});

test('SE-08 OpenAPI documents optional fields from the same product list DTO', () => {
  const spec = JSON.parse(readFileSync('openapi/renivet.openapi.json','utf8'));
  const schema = spec.components.schemas.ProductSummaryModel;
  assert.deepEqual(schema.properties.categoryId,{type:'string',format:'uuid',nullable:true});
  assert.deepEqual(schema.properties.updatedAt,{type:'string',format:'date-time'});
  assert.ok(!schema.required.includes('categoryId') && !schema.required.includes('updatedAt'));
});
