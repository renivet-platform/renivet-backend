'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { Reflector } = require('@nestjs/core');
const { REQUIRE_MFA_ACTION } = require('../../dist/common/guards/require-mfa.js');
const { REQUIRE_BRAND_PERMISSION } = require('../../dist/modules/access/brand-access.guard.js');
const { MediaController } = require('../../dist/modules/media/media.controller.js');
const { setup } = require('./media-controller-fixture.cjs');

test('completeMediaUpload forwards only path asset, hash, size, authorized brand context and idempotency key', async () => {
  const fixture = setup();
  const controller = new MediaController(...fixture.controllerArgs);
  const result = await controller.complete(fixture.mediaId, { sha256: 'a'.repeat(64), sizeBytes: 100 }, fixture.request, 'complete-key');
  assert.equal(result.status, 'CLEAN');
  assert.equal(fixture.calls[0][1], fixture.mediaId);
  assert.equal(fixture.calls[0][2].sizeBytes, 100);
  assert.equal(fixture.calls[0][3].permission, 'media.write');
  assert.equal(fixture.calls[0][3].idempotencyKey, 'complete-key');
  assert.equal(Reflect.getMetadata(REQUIRE_BRAND_PERMISSION, MediaController.prototype.complete), 'catalog.write');
  assert.equal(Reflect.getMetadata(REQUIRE_MFA_ACTION, MediaController.prototype.complete), 'media.write');
  assert.equal(Reflect.getMetadata('path', MediaController.prototype.complete), ':mediaId/complete');
});
