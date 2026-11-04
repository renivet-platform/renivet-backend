const test = require('node:test');
const assert = require('node:assert/strict');

const service = require('../../dist/modules/catalog/product-draft.service.js');

test('REN2-61 normalizes product draft text without requiring variants or submission fields', () => {
  const normalized = service.normalizeProductCreate({
    styleCode: '  Dress-01  ', categoryCode: '  CLOTHING  ', categorySchemaVersion: 2,
    title: '  Cafe\u0301 dress  ', description: '  Draft only  ',
  });
  assert.equal(normalized.styleCode, 'Dress-01');
  assert.equal(normalized.categoryCode, 'CLOTHING');
  assert.equal(normalized.title, 'Café dress');
  assert.equal(normalized.description, 'Draft only');
  assert.deepEqual(normalized.variants, []);
});

test('REN2-61 enforces contract keys, title/style requirements and safe If-Match values', () => {
  assert.throws(() => service.normalizeProductCreate({ styleCode: 'S', categoryCode: 'C', categorySchemaVersion: 1 }), { code: 'PRODUCT_DRAFT_INVALID' });
  assert.throws(() => service.normalizeProductCreate({ styleCode: 'S', categoryCode: 'C', categorySchemaVersion: 1, title: '  ', injected: true }), { code: 'PRODUCT_DRAFT_INVALID' });
  assert.throws(() => service.normalizeProductCreate({ styleCode: 'S', categoryCode: 'C', categorySchemaVersion: 1, title: 'Title', description: 'bad\u0000text' }), { code: 'PRODUCT_DRAFT_INVALID' });
  assert.equal(service.parseProductIfMatch('"12"'), 12);
  for (const value of ['12', 'W/"12"', '*', '"0"', '"1", "2"']) {
    assert.throws(() => service.parseProductIfMatch(value), { code: 'PRODUCT_IF_MATCH_INVALID' });
  }
});
