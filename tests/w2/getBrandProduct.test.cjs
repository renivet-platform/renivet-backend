'use strict';
require('reflect-metadata');
const assert = require('node:assert/strict');
const test = require('node:test');
const { randomUUID } = require('node:crypto');
const { ProductReadController } = require('../../dist/modules/catalog/product-read.controller.js');
const { ProductReadService } = require('../../dist/modules/catalog/product-read.service.js');
const { BrandAccessGuard, REQUIRE_BRAND_PERMISSION } = require('../../dist/modules/access/brand-access.guard.js');

test('REN2-70 detail controller requires W1 catalog.read brand access and returns the complete versioned projection', async () => {
  assert.equal(Reflect.getMetadata(REQUIRE_BRAND_PERMISSION, ProductReadController), 'catalog.read');
  assert.deepEqual(Reflect.getMetadata('__guards__', ProductReadController), [BrandAccessGuard]);
  const captured = [];
  const productId = randomUUID();
  const detail = { id: 'product-1', brandId: 'brand-1', rowVersion: 3, variants: [], mediaLinks: [], attributes: {}, qcState: 'NOT_SUBMITTED' };
  const service = { get: async (...args) => { captured.push(args); return detail; } };
  const controller = new ProductReadController(service);
  const response = makeResponse();
  const access = { userId: 'session-user', brandId: 'brand-1', permission: 'catalog.read' };
  assert.equal(await controller.getProduct('brand-1', productId,
    { headers: {}, brandAccess: access }, undefined, response), detail);
  assert.deepEqual(captured, [[access, productId]]);
  assert.equal(response.headers['cache-control'], 'private, no-cache');
  assert.match(response.headers.etag, /^"[a-f0-9]{64}"$/);
});

test('REN2-70 detail service rejects malformed product IDs before querying storage', async () => {
  let reads = 0;
  const service = new ProductReadService({ list: async () => ({}), get: async () => { reads += 1; return {}; } });
  await assert.rejects(service.get({}, 'not-a-uuid'), (error) => error.getStatus?.() === 400);
  assert.equal(reads, 0);
});

function makeResponse() {
  return { headers: {}, statusCode: 200,
    header(name, value) { this.headers[name.toLowerCase()] = value; return this; },
    code(value) { this.statusCode = value; return this; },
    send() { return this; },
  };
}
