'use strict';
require('reflect-metadata');
const assert = require('node:assert/strict');
const test = require('node:test');
const { randomUUID } = require('node:crypto');
const { ProductReadController } = require('../../dist/modules/catalog/product-read.controller.js');
const { ProductReadService, parseProductListQuery } = require('../../dist/modules/catalog/product-read.service.js');
const { BrandAccessGuard, REQUIRE_BRAND_PERMISSION } = require('../../dist/modules/access/brand-access.guard.js');

test('REN2-70 parses brand product filters, bounded page size and a filter-bound cursor', () => {
  const categoryId = randomUUID();
  const page = parseProductListQuery({
    categoryId,
    reviewState: 'NOT_SUBMITTED',
    visibility: 'PRIVATE',
    limit: '6',
  });
  assert.deepEqual(page, {
    cursor: null, limit: 6, categoryId,
    reviewState: 'NOT_SUBMITTED', visibility: 'PRIVATE',
  });
  assert.equal(parseProductListQuery({}).limit, 25);
  for (const query of [
    { limit: '0' }, { limit: '101' }, { limit: ['1', '2'] },
    { categoryId: 'foreign-input' }, { reviewState: 'bad state' },
    { visibility: 'ALL' }, { unknownFilter: 'x' }, { cursor: 'x'.repeat(513) },
  ]) {
    assert.throws(() => parseProductListQuery(query), (error) => error.getStatus?.() === 400);
  }
});

test('REN2-70 listing controller uses the W1 catalog.read brand guard and private ETag revalidation', async () => {
  assert.equal(Reflect.getMetadata(REQUIRE_BRAND_PERMISSION, ProductReadController), 'catalog.read');
  assert.deepEqual(Reflect.getMetadata('__guards__', ProductReadController), [BrandAccessGuard]);
  const calls = [];
  const service = { list: async (context, query) => {
    calls.push({ context, query });
    return { items: [{ id: 'p-1' }], totalCount: 1, nextCursor: null };
  } };
  const controller = new ProductReadController(service);
  const response = makeResponse();
  const access = { userId: 'u-1', brandId: 'b-1', permission: 'catalog.read' };
  const first = await controller.listProducts('b-1', { visibility: 'PUBLIC' }, { headers: {}, brandAccess: access }, undefined, response);
  assert.deepEqual(first, { items: [{ id: 'p-1' }], totalCount: 1, nextCursor: null });
  assert.deepEqual(calls[0], { context: access, query: { visibility: 'PUBLIC' } });
  assert.equal(response.headers['cache-control'], 'private, no-cache');
  assert.match(response.headers.etag, /^"[a-f0-9]{64}"$/);

  const cached = makeResponse();
  assert.equal(await controller.listProducts('b-1', {}, { headers: {}, brandAccess: access }, response.headers.etag, cached), undefined);
  assert.equal(cached.statusCode, 304);
  assert.equal(calls.length, 2, 'ETag revalidation rereads the current scoped product page');
});

test('REN2-70 listing service passes only parsed filters with the server-authorized brand context', async () => {
  const categoryId = randomUUID();
  let captured;
  const service = new ProductReadService({ list: async (...args) => { captured = args; return { items: [], totalCount: 0, nextCursor: null }; } });
  const context = { userId: 'server-user', brandId: 'brand-1', permission: 'catalog.read' };
  await service.list(context, { categoryId, visibility: 'RESTRICTED' });
  assert.deepEqual(captured, [context, {
    cursor: null, limit: 25, categoryId, reviewState: null, visibility: 'RESTRICTED',
  }]);
});

function makeResponse() {
  return { headers: {}, statusCode: 200, body: undefined,
    header(name, value) { this.headers[name.toLowerCase()] = value; return this; },
    code(value) { this.statusCode = value; return this; },
    send(body) { this.body = body; return this; },
  };
}
