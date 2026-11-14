'use strict';
require('reflect-metadata');
const assert = require('node:assert/strict');
const test = require('node:test');
const { METHOD_METADATA, PATH_METADATA } = require('@nestjs/common/constants');
const { ProductDraftController } = require('../../dist/modules/catalog/product-draft.controller.js');
const { REQUIRE_BRAND_PERMISSION } = require('../../dist/modules/access/brand-access.guard.js');

test('REN2-71 exposes seller submission only through the permission-guarded W1 session route', async () => {
  const handler = ProductDraftController.prototype.submitForReview;
  assert.equal(Reflect.getMetadata(PATH_METADATA, handler), ':productId/submit');
  assert.equal(Reflect.getMetadata(METHOD_METADATA, handler), 1); // POST
  assert.equal(Reflect.getMetadata(REQUIRE_BRAND_PERMISSION, handler), 'catalog.submit');

  let submitted;
  const controller = new ProductDraftController({}, { submit: async (...args) => { submitted = args; return { ok: true }; } },
    { authenticate: async () => ({ userId: '11111111-1111-4111-8111-111111111111' }), expectedCsrf: () => 'token' },
    { get: () => ['https://app.renivet.test'] });
  const request = { headers: { cookie: `__Host-renivet_session=${'a'.repeat(43)}`, origin: 'https://app.renivet.test',
    'sec-fetch-site': 'same-origin', 'x-csrf-token': 'token' }, brandAccess: {
    userId: '11111111-1111-4111-8111-111111111111', brandId: '22222222-2222-4222-8222-222222222222', permission: 'catalog.submit' } };
  await controller.submitForReview('33333333-3333-4333-8333-333333333333', {
    draftContentVersion: 2, categorySchemaVersion: 4, contentSha256: 'b'.repeat(64),
  }, request, 'submit-1', '"7"');
  assert.equal(submitted[0], '33333333-3333-4333-8333-333333333333');
  assert.deepEqual(submitted[1], {
    userId: request.brandAccess.userId, brandId: request.brandAccess.brandId, permission: 'catalog.submit',
    requestId: 'submit:submit-1', idempotencyKey: 'submit-1', sourceKind: 'MANUAL', sourceReference: null,
    expectedRowVersion: 7, expectedContentVersion: 2, expectedCategorySchemaVersion: 4, expectedContentSha256: 'b'.repeat(64),
  });
  await assert.rejects(controller.submitForReview('33333333-3333-4333-8333-333333333333', {
    draftContentVersion: 2, categorySchemaVersion: 4, contentSha256: 'b'.repeat(64),
  }, request, 'submit-2', '7'), { status: 422 });
});
