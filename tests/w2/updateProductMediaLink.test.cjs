'use strict';
require('reflect-metadata');
const assert = require('node:assert/strict');
const test = require('node:test');
const { ProductMediaController } = require('../../dist/modules/media/product-media.controller.js');
const { REQUIRE_BRAND_PERMISSION } = require('../../dist/modules/access/brand-access.guard.js');
const { setup } = require('./product-media-controller-fixture.cjs');

test('REN2-67 update endpoint passes the product CAS version and permits order zero for primary', async () => {
  const f = setup(); const controller = new ProductMediaController(...f.controllerArgs);
  await controller.update(f.productId, f.linkId, { displayOrder: 0 }, f.request, 'update-key', '"4"');
  assert.equal(Reflect.getMetadata(REQUIRE_BRAND_PERMISSION, ProductMediaController.prototype.update), 'catalog.write');
  assert.deepEqual(f.calls[0], ['update', f.productId, f.linkId, { displayOrder: 0 }, '"4"', {
    brandId: f.brandId, userId: f.userId, permission: 'catalog.write', requestId: 'request-67', idempotencyKey: 'update-key',
  }]);
});
