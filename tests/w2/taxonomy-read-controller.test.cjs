'use strict';

require('reflect-metadata');
const assert = require('node:assert/strict');
const test = require('node:test');
const { CatalogReadController } = require('../../dist/modules/catalog/catalog-read.controller.js');
const { REQUIRE_BRAND_PERMISSION } = require('../../dist/modules/access/brand-access.guard.js');
const { BrandAccessGuard } = require('../../dist/modules/access/brand-access.guard.js');
const { CatalogReadService } = require('../../dist/modules/catalog/catalog-read.service.js');

test('taxonomy read routes use the W1 brand-scoped catalog.read guard', () => {
  assert.equal(Reflect.getMetadata(REQUIRE_BRAND_PERMISSION, CatalogReadController), 'catalog.read');
  assert.deepEqual(Reflect.getMetadata('__guards__', CatalogReadController), [BrandAccessGuard]);
  for (const method of ['listCategories', 'getCategoryAttributes', 'getCategorySchemaVersion']) {
    const handler = CatalogReadController.prototype[method];
    assert.equal(typeof handler, 'function');
  }
});

test('category list applies private revalidation and returns 304 for a matching ETag', async () => {
  let reads = 0;
  const service = {
    listCategories: async () => { reads += 1; return { items: [{ id: 'cat-1' }], nextCursor: null }; },
    getCategoryAttributes: async () => ({ items: [], nextCursor: null }),
    getCategorySchemaVersion: async () => ({}),
  };
  const controller = new CatalogReadController(service);
  const response = { headers: {}, statusCode: 200, body: undefined,
    header(name, value) { this.headers[name.toLowerCase()] = value; return this; },
    code(value) { this.statusCode = value; return this; },
    send(value) { this.body = value; return this; },
  };
  const request = { headers: {}, brandAccess: { userId: 'user-1', brandId: 'brand-1', permission: 'catalog.read' } };
  const first = await controller.listCategories('brand-1', {}, request, undefined, response);
  assert.deepEqual(first, { items: [{ id: 'cat-1' }], nextCursor: null });
  assert.equal(response.headers['cache-control'], 'private, no-cache');
  assert.match(response.headers.etag, /^"[a-f0-9]{64}"$/);

  const cached = { ...response, headers: {}, statusCode: 200, body: undefined };
  const unchanged = await controller.listCategories('brand-1', {}, { ...request, headers: { 'if-none-match': response.headers.etag } }, response.headers.etag, cached);
  assert.equal(unchanged, undefined);
  assert.equal(cached.statusCode, 304);
  assert.equal(cached.body, undefined);
  assert.equal(reads, 2, 'revalidation reads the current representation so taxonomy changes invalidate the ETag');
});

test('category reads reject invalid cursor and limit before accessing the repository', async () => {
  let reads = 0;
  const service = new CatalogReadService({
    listCategories: async () => { reads += 1; return { items: [], nextCursor: null }; },
    getCategoryAttributes: async () => ({ items: [], nextCursor: null }),
    getCategorySchemaVersion: async () => ({}),
  });
  await assert.rejects(service.listCategories({}, { cursor: 'x'.repeat(513) }), (error) => error.getStatus?.() === 400);
  await assert.rejects(service.listCategories({}, { limit: 101 }), (error) => error.getStatus?.() === 400);
  assert.equal(reads, 0);
});
