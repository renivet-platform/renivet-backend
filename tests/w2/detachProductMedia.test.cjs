'use strict';
require('reflect-metadata');
const assert = require('node:assert/strict');
const test = require('node:test');
const { ProductMediaController } = require('../../dist/modules/media/product-media.controller.js');
const { REQUIRE_BRAND_PERMISSION } = require('../../dist/modules/access/brand-access.guard.js');
const { setup } = require('./product-media-controller-fixture.cjs');

test('REN2-67 detach endpoint requires the current link version and uses idempotent soft-detach command', async () => {
  const f = setup(); const controller = new ProductMediaController(...f.controllerArgs);
  await controller.detach(f.productId, f.linkId, f.request, 'detach-key', '"9"');
  assert.equal(Reflect.getMetadata(REQUIRE_BRAND_PERMISSION, ProductMediaController.prototype.detach), 'catalog.write');
  assert.deepEqual(f.calls[0], ['detach', f.productId, f.linkId, '"9"', {
    brandId: f.brandId, userId: f.userId, permission: 'catalog.write', requestId: 'request-67', idempotencyKey: 'detach-key',
  }]);
});
