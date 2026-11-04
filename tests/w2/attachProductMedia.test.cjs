'use strict';
require('reflect-metadata');
const assert = require('node:assert/strict');
const test = require('node:test');
const { ProductMediaController } = require('../../dist/modules/media/product-media.controller.js');
const { BrandAccessGuard, REQUIRE_BRAND_PERMISSION } = require('../../dist/modules/access/brand-access.guard.js');
const { setup } = require('./product-media-controller-fixture.cjs');

test('REN2-67 attach endpoint uses W1 brand scope, session CSRF and idempotency context', async () => {
  const f = setup(); const controller = new ProductMediaController(...f.controllerArgs);
  const body = { mediaAssetId: f.mediaAssetId, variantId: null, displayRole: 'gallery', displayOrder: 0, altText: 'Front' };
  await controller.attach(f.productId, body, f.request, 'attach-key');
  assert.deepEqual(Reflect.getMetadata('__guards__', ProductMediaController), [BrandAccessGuard]);
  assert.equal(Reflect.getMetadata(REQUIRE_BRAND_PERMISSION, ProductMediaController.prototype.attach), 'catalog.write');
  assert.equal(f.calls[0][0], 'attach'); assert.equal(f.calls[0][1], f.productId);
  assert.deepEqual(f.calls[0][3], { brandId: f.brandId, userId: f.userId, permission: 'catalog.write', requestId: 'request-67', idempotencyKey: 'attach-key' });
  await assert.rejects(controller.attach(f.productId, body, f.request, 'bad key'), (error) => error.getStatus?.() === 422);
  await assert.rejects(controller.attach(f.productId, body, { ...f.request, headers: { ...f.request.headers, origin: 'https://attacker.invalid' } }, 'key'),
    (error) => error.getStatus?.() === 403);
});
