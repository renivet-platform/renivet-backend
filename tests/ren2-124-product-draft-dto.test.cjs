'use strict';
require('reflect-metadata');
const assert = require('node:assert/strict');
const test = require('node:test');
const { ProductDraftService } = require('../dist/modules/catalog/product-draft.service.js');
const { CreateProductDraftDto, UpdateProductDraftDto, CreateProductVariantDto,
  UpdateProductVariantDto, DeactivateProductVariantDto } =
  require('../dist/modules/catalog/product-draft.dto.js');

const productId = '11111111-2222-4333-8444-555555555555';
const context = { userId: 'seller', brandId: 'brand', permission: 'catalog.write',
  requestId: 'e2e-product', idempotencyKey: 'product-e2e-1' };

test('REN2-124: Nest transformed CreateProductDraftDto makes a real normalized create call', async () => {
  let saved;
  const service = new ProductDraftService({
    create: async (input, ctx) => { saved = { input, ctx }; return {
      productId, publicationState: 'DRAFT', categorySchemaVersion: 1
    }; },
  });
  const dto = Object.assign(new CreateProductDraftDto(), {
    title: 'Test Product', styleCode: 'test', categoryCode: 'activewear', categorySchemaVersion: 1,
  });
  const receipt = await service.create(dto, context);
  assert.equal(receipt.productId, productId);
  assert.equal(saved.input.title, 'Test Product');
  assert.equal(saved.input.categoryCode, 'activewear');
  assert.equal(saved.input.categorySchemaVersion, 1);
  assert.deepEqual(saved.input.attributes, {});
  assert.deepEqual(saved.input.variants, []);
  assert.equal(Object.getPrototypeOf(saved.input), Object.prototype);
  assert.equal(saved.ctx.permission, 'catalog.write');
});

test('REN2-124: unknown create keys are still rejected by the strict normalizer', async () => {
  let writes = 0;
  const service = new ProductDraftService({ create: async () => { writes++; } });
  const dto = Object.assign(new CreateProductDraftDto(), {
    title: 'Product', styleCode: 'test', categoryCode: 'activewear',
    categorySchemaVersion: 1, unapprovedField: 'must fail'
  });
  await assert.rejects(service.create(dto, context), err => err.getStatus?.() === 422);
  assert.equal(writes, 0);
});

test('REN2-124: transformed update and variant DTOs pass strict normalization', async () => {
  const seen = [];
  const repository = {
    update: async (...args) => { seen.push(['update', ...args]); return { status:'updated' }; },
    createVariant: async (...args) => { seen.push(['variant', ...args]); return { status:'created' }; },
    updateVariant: async (...args) => { seen.push(['variant-update', ...args]); return { status:'updated' }; },
    deactivateVariant: async (...args) => { seen.push(['variant-deactivate', ...args]); return { status:'deactivated' }; }
  };
  const service = new ProductDraftService(repository);
  await service.update(productId, Object.assign(new UpdateProductDraftDto(), { title:'Changed' }), '"1"', context);
  await service.createVariant(productId, Object.assign(new CreateProductVariantDto(), {
    sku:'test-m', options: { size:'M' }
  }), '"1"', context);
  await service.updateVariant(productId, productId,
    Object.assign(new UpdateProductVariantDto(), { options: { size:'L' } }), '"1"', context);
  await service.deactivateVariant(productId, productId,
    Object.assign(new DeactivateProductVariantDto(), { reasonCode:'SOLD_OUT' }), '"1"', context);
  assert.deepEqual(seen.map(row=>row[0]), ['update','variant','variant-update','variant-deactivate']);
});

test('REN2-124: invalid transformed create remains rejected, no product persisted', async () => {
  const service = new ProductDraftService({ create: async () => { throw new Error('unexpected write'); } });
  const dto = Object.assign(new CreateProductDraftDto(), {
    title: 'Test Product', styleCode: '', categoryCode: 'activewear', categorySchemaVersion: 1
  });
  await assert.rejects(service.create(dto, context), err => err.getStatus?.() === 422);
});
