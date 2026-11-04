'use strict';

require('reflect-metadata');
const assert = require('node:assert/strict');
const test = require('node:test');
const { PriceController } = require('../../dist/modules/catalog/price.controller.js');
const { BrandAccessGuard, REQUIRE_BRAND_PERMISSION } = require('../../dist/modules/access/brand-access.guard.js');

test('REN2-64 price routes require the fail-closed W1 brand permissions', () => {
  assert.deepEqual(Reflect.getMetadata('__guards__', PriceController), [BrandAccessGuard]);
  assert.equal(Reflect.getMetadata(REQUIRE_BRAND_PERMISSION, PriceController.prototype.propose), 'pricing.write');
  assert.equal(Reflect.getMetadata(REQUIRE_BRAND_PERMISSION, PriceController.prototype.list), 'pricing.read');
});

test('REN2-64 price proposal requires session-bound CSRF, idempotency, and If-Match', async () => {
  const calls = [];
  const sessions = { authenticate: async () => ({ userId: 'user-1' }), expectedCsrf: () => 'csrf-1' };
  const config = { get: () => ['https://brand.example'] };
  const prices = { propose: async (...args) => { calls.push(args); return { id: 'price-1', status: 'PENDING' }; } };
  const controller = new PriceController(prices, sessions, config);
  const request = { id: 'request-1', headers: { cookie: '__Host-renivet_session=Abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG',
    origin: 'https://brand.example', 'sec-fetch-site': 'same-origin', 'x-csrf-token': 'csrf-1' },
    brandAccess: { userId: 'user-1', brandId: 'brand-1', permission: 'pricing.write' } };
  const body = { currency: 'INR', sellingPriceMinor: 100, mrpMinor: 200, validFrom: '2026-11-04T12:00:00Z', ruleVersion: 1 };
  await controller.propose('brand-1', 'variant-1', body, request, 'stable-key', '"3"');
  assert.equal(calls.length, 1);
  assert.equal(calls[0][3].idempotencyKey, 'stable-key');
  assert.equal(calls[0][3].brandId, 'brand-1');
  await assert.rejects(controller.propose('brand-1', 'variant-1', body,
    { ...request, headers: { ...request.headers, origin: 'https://attacker.example' } }, 'stable-key', '"3"'),
  (error) => error.getStatus?.() === 403);
  await assert.rejects(controller.propose('brand-1', 'variant-1', body, request, 'bad key', '"3"'),
    (error) => error.getStatus?.() === 422);
});
