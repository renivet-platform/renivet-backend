'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { Reflector } = require('@nestjs/core');
const { REQUIRE_MFA_ACTION } = require('../../dist/common/guards/require-mfa.js');
const { REQUIRE_BRAND_PERMISSION } = require('../../dist/modules/access/brand-access.guard.js');
const { MediaController } = require('../../dist/modules/media/media.controller.js');
const { setup } = require('./media-controller-fixture.cjs');

test('beginMediaUpload uses a server session, same-origin CSRF, MFA, and scoped media.write permission', async () => {
  const fixture = setup();
  const controller = new MediaController(...fixture.controllerArgs);
  const body = { fileName: 'front.png', mimeType: 'image/png', byteLength: 100, rightsAttested: true };
  const result = await controller.begin(body, fixture.request, 'begin-key');
  assert.equal(result.mediaAssetId, fixture.mediaId);
  assert.equal(fixture.calls[0][2].brandId, fixture.brandId);
  assert.equal(fixture.calls[0][2].userId, fixture.userId);
  assert.equal(fixture.calls[0][2].permission, 'media.write');
  assert.equal(fixture.calls[0][2].idempotencyKey, 'begin-key');
  assert.equal(Reflect.getMetadata(REQUIRE_BRAND_PERMISSION, MediaController.prototype.begin), 'media.write');
  assert.equal(Reflect.getMetadata(REQUIRE_MFA_ACTION, MediaController.prototype.begin), 'media.write');
  assert.equal(Reflect.getMetadata('path', MediaController.prototype.begin), 'uploads');
});

test('beginMediaUpload refuses a missing or invalid session-bound CSRF token before issuing an upload intent', async () => {
  const fixture = setup();
  const controller = new MediaController(...fixture.controllerArgs);
  const request = { ...fixture.request, headers: { ...fixture.request.headers, 'x-csrf-token': 'wrong' } };
  await assert.rejects(controller.begin({ fileName: 'front.png', mimeType: 'image/png', byteLength: 100, rightsAttested: true }, request, 'begin-key'),
    (error) => error.getStatus() === 403);
  assert.equal(fixture.calls.length, 0);
});
