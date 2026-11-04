'use strict';

require('reflect-metadata');
const assert = require('node:assert/strict');
const test = require('node:test');
const { PriceReviewController } = require('../../dist/modules/catalog/price-review.controller.js');
const { BrandAccessGuard, REQUIRE_BRAND_PERMISSION } = require('../../dist/modules/access/brand-access.guard.js');
const { MfaGuard, REQUIRE_MFA_ACTION } = require('../../dist/common/guards/require-mfa.js');
const { normalizePriceDecision } = require('../../dist/modules/catalog/price.service.js');

test('REN2-65 decision route requires brand pricing.approve and fresh MFA', () => {
  assert.deepEqual(Reflect.getMetadata('__guards__', PriceReviewController), [BrandAccessGuard, MfaGuard]);
  assert.equal(Reflect.getMetadata(REQUIRE_BRAND_PERMISSION, PriceReviewController.prototype.decide), 'pricing.approve');
  assert.equal(Reflect.getMetadata(REQUIRE_MFA_ACTION, PriceReviewController.prototype.decide), 'pricing.approve');
  assert.equal(Reflect.getMetadata('swagger/apiOperation', PriceReviewController.prototype.decide).operationId, 'decideVariantPrice');
});

test('REN2-65 decision validates CSRF and idempotency and supplies server brand context', async () => {
  const calls = [];
  const sessions = { authenticate: async () => ({ userId: 'reviewer-1' }), expectedCsrf: () => 'csrf-1' };
  const config = { get: () => ['https://brand.example'] };
  const prices = { decide: async (...args) => { calls.push(args); return { id: 'price-1', status: 'APPROVED' }; } };
  const controller = new PriceReviewController(prices, sessions, config);
  const request = { id: 'request-1', headers: { cookie: '__Host-renivet_session=Abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG',
    origin: 'https://brand.example', 'sec-fetch-site': 'same-origin', 'x-csrf-token': 'csrf-1' },
    brandAccess: { userId: 'reviewer-1', brandId: 'brand-1', permission: 'pricing.approve' } };
  await controller.decide('brand-1', 'price-1', { decision: 'APPROVE', reasonCode: 'REVIEWED', expectedState: 'PENDING' }, request, 'review-key');
  assert.equal(calls.length, 1);
  assert.equal(calls[0][2].brandId, 'brand-1');
  assert.equal(calls[0][2].userId, 'reviewer-1');
  assert.equal(calls[0][2].permission, 'pricing.approve');
  assert.equal(calls[0][2].idempotencyKey, 'review-key');
  await assert.rejects(controller.decide('brand-1', 'price-1', { decision: 'APPROVE', reasonCode: 'REVIEWED' },
    { ...request, headers: { ...request.headers, origin: 'https://attacker.example' } }, 'review-key'), (error) => error.getStatus?.() === 403);
  await assert.rejects(controller.decide('brand-1', 'price-1', { decision: 'APPROVE', reasonCode: 'REVIEWED' }, request, 'bad key'),
    (error) => error.getStatus?.() === 422);
});

test('REN2-65 decision accepts only the candidate DTO and requires a meaningful reason', () => {
  assert.deepEqual(normalizePriceDecision({ decision: 'REJECT', reasonCode: '  MRP_MISMATCH  ', expectedState: 'PENDING' }),
    { decision: 'REJECT', reasonCode: 'MRP_MISMATCH', expectedState: 'PENDING' });
  assert.throws(() => normalizePriceDecision({ decision: 'APPROVE', reasonCode: ' ' }), (error) => error.code === 'PRICE_DECISION_INVALID');
  assert.throws(() => normalizePriceDecision({ decision: 'APPROVE', reasonCode: 'OK', extra: true }), (error) => error.code === 'PRICE_DECISION_INVALID');
  assert.throws(() => normalizePriceDecision({ decision: 'APPROVE', reasonCode: 'OK', expectedState: 'APPROVED' }),
    (error) => error.code === 'PRICE_DECISION_INVALID');
});
