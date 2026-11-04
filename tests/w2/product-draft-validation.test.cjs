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

test('REN2-62 canonicalizes SKU variant options and rejects invalid variant input', () => {
  const variant = service.normalizeVariantCreate({ sku: '  blue-m  ', options: { Size: 'M', Color: 'Blue' }, weightG: 12 });
  assert.deepEqual(variant, { sku: 'blue-m', options: { Color: 'Blue', Size: 'M' }, weightG: 12 });
  assert.throws(() => service.normalizeVariantCreate({ sku: 'bad sku', options: { Size: 'M' } }), { code: 'PRODUCT_DRAFT_INVALID' });
  assert.throws(() => service.normalizeVariantCreate({ sku: 'sku', options: { Size: '' } }), { code: 'PRODUCT_DRAFT_INVALID' });
  assert.throws(() => service.normalizeVariantCreate({ sku: 'sku', options: { Size: 'M', ' Size ': 'L' } }), { code: 'PRODUCT_DRAFT_INVALID' });
  const prototypeKey = service.normalizeVariantCreate(JSON.parse('{"sku":"sku","options":{"__proto__":"value"}}'));
  assert.equal(Object.hasOwn(prototypeKey.options, '__proto__'), true, 'untrusted option keys cannot mutate object prototypes or disappear');
});

test('REN2-62 requires a safe row-version for variant updates and deactivation', () => {
  assert.equal(service.parseVariantIfMatch('"9"'), 9);
  for (const value of [undefined, '9', '"0"', 'W/"9"', '"1", "9"']) {
    assert.throws(() => service.parseVariantIfMatch(value), { code: 'PRODUCT_IF_MATCH_INVALID' });
  }
});

test('REN2-62 exposes stale variant If-Match as HTTP 412', async () => {
  const repository = { updateVariant: async () => { throw Object.assign(new Error('stale'), { code: 'VARIANT_ROW_VERSION_CONFLICT' }); } };
  const variants = new service.ProductDraftService(repository);
  await assert.rejects(variants.updateVariant('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222',
    { weightG: 10 }, '"1"', { userId: 'user', brandId: 'brand', permission: 'catalog.write', requestId: 'r', idempotencyKey: 'k' }),
  (error) => error.getStatus?.() === 412 && error.getResponse?.().code === 'VARIANT_ROW_VERSION_CONFLICT');
});

test('REN2-63 reports stable field paths for submission-time missing typed attributes', () => {
  const rule = { id: '33333333-3333-4333-8333-333333333333', attributeId: '44444444-4444-4444-8444-444444444444', code: 'material', displayLabel: 'Material',
    scope: 'product', valueType: 'enum', allowedValues: ['cotton'], requiredByDefault: true };
  assert.throws(() => service.validateProductAttributes('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', 1,
    'w2-attribute-validator-v1', [rule], {}, 'submission'), (error) => {
    assert.equal(error.code, 'PRODUCT_ATTRIBUTE_INVALID');
    assert.equal(error.details.issues[0].path, 'attributes.product.material');
    return true;
  });
});

test('REN2-63 rejects missing and noncanonical measurement units at submission with field paths', () => {
  const rule = { id: '33333333-3333-4333-8333-333333333333', attributeId: '44444444-4444-4444-8444-444444444444',
    code: 'length', displayLabel: 'Length', scope: 'product', valueType: 'measurement', unitCode: 'cm', requiredByDefault: true };
  for (const values of [{}, { length: { value: 2, unitCode: 'in' } }]) {
    assert.throws(() => service.validateProductAttributes('11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222', 1, 'w2-attribute-validator-v1', [rule], values, 'submission'),
    (error) => error.code === 'PRODUCT_ATTRIBUTE_INVALID' && error.details.issues[0].path === 'attributes.product.length');
  }
});

test('REN2-63 returns field-level validator diagnostics through safe HTTP errors', async () => {
  const repository = { update: async () => { throw Object.assign(new Error('invalid'), {
    code: 'PRODUCT_ATTRIBUTE_INVALID', details: { issues: [{ code: 'ATTRIBUTE_REQUIRED', path: 'attributes.product.material', message: 'A value is required.' }] },
  }); } };
  const products = new service.ProductDraftService(repository);
  await assert.rejects(products.update('11111111-1111-4111-8111-111111111111', { title: 'Draft' }, '"1"',
    { userId: 'user', brandId: 'brand', permission: 'catalog.write', requestId: 'r', idempotencyKey: 'k' }), (error) => {
    const body = error.getResponse?.();
    assert.equal(body?.details?.issues?.[0]?.path, 'attributes.product.material');
    return true;
  });
});
