'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { REQUIRE_BRAND_PERMISSION } = require('../../dist/modules/access/brand-access.guard.js');
const { MediaController } = require('../../dist/modules/media/media.controller.js');
const { setup } = require('./media-controller-fixture.cjs');

test('getMediaAssetStatus returns only media state scoped to the authenticated brand permission', async () => {
  const fixture = setup();
  const controller = new MediaController(...fixture.controllerArgs);
  const result = await controller.status(fixture.mediaId, fixture.request);
  assert.equal(result.scanState, 'CLEAN');
  assert.equal(fixture.calls[0][1], fixture.mediaId);
  assert.deepEqual(fixture.calls[0][2], {
    brandId: fixture.brandId, userId: fixture.userId, permission: 'media.write', requestId: 'request-66',
  });
  assert.equal(Reflect.getMetadata(REQUIRE_BRAND_PERMISSION, MediaController.prototype.status), 'catalog.read');
  assert.equal(Reflect.getMetadata('path', MediaController.prototype.status), ':mediaId');
});
