'use strict';
require('reflect-metadata');
const assert = require('node:assert/strict');
const test = require('node:test');
const { ProductDraftController } = require('../../dist/modules/catalog/product-draft.controller.js');
const { BrandAccessGuard, REQUIRE_BRAND_PERMISSION } = require('../../dist/modules/access/brand-access.guard.js');

test('REN2-61 product mutations require the W1 brand-scoped catalog.write guard', () => {
  assert.deepEqual(Reflect.getMetadata('__guards__', ProductDraftController), [BrandAccessGuard]);
  for (const method of ['create', 'update']) {
    assert.equal(Reflect.getMetadata(REQUIRE_BRAND_PERMISSION, ProductDraftController.prototype[method]), 'catalog.write');
  }
});

test('REN2-61 mutation context requires a session-bound same-origin CSRF proof and stable idempotency key', async () => {
  let captured;
  const service = { create: async (_body, context) => { captured = context; return { ok: true }; }, update: async () => ({ ok: true }) };
  const token = 'T'.repeat(43);
  const sessions = { authenticate: async () => ({ userId: 'session-user' }), expectedCsrf: () => 'bound-csrf' };
  const config = { get: () => ['https://brand.example'] };
  const controller = new ProductDraftController(service, sessions, config);
  const request = { id: 'req-61', headers: { cookie: `__Host-renivet_session=${token}`, origin: 'https://brand.example',
    'sec-fetch-site': 'same-origin', 'x-csrf-token': 'bound-csrf' },
  brandAccess: { userId: 'guard-user', brandId: 'brand-61', permission: 'catalog.write' } };
  await controller.create({}, request, 'create-key');
  assert.equal(captured.userId, 'session-user');
  assert.equal(captured.brandId, 'brand-61');
  assert.equal(captured.permission, 'catalog.write');
  assert.equal(captured.requestId, 'req-61');
  assert.equal(captured.idempotencyKey, 'create-key');
  assert.equal(captured.sourceKind, 'MANUAL');
  await assert.rejects(controller.create({}, { ...request, headers: { ...request.headers, origin: 'https://attacker.example' } }, 'denied'),
    (error) => error.getStatus?.() === 403);
  await assert.rejects(controller.create({}, request, 'bad key'), (error) => error.getStatus?.() === 422);
});
