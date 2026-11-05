'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  ClaimsService,
  normalizeClaimDecision,
  parseClaimDecisionIfMatch,
} = require('../../dist/modules/catalog/claims.service.js');
const { ClaimReviewController } = require('../../dist/modules/catalog/claim-review.controller.js');
const { REQUIRE_BRAND_PERMISSION } = require('../../dist/modules/access/brand-access.guard.js');
const { REQUIRE_MFA_ACTION } = require('../../dist/common/guards/require-mfa.js');

test('REN2-69 accepts only explicit claim review actions and a bounded reason', () => {
  assert.deepEqual(normalizeClaimDecision({ decision: 'VERIFY', reasonCode: 'EVIDENCE_VALID', comment: 'Issuer and dates checked.' }), {
    decision: 'VERIFY', reasonCode: 'EVIDENCE_VALID', comment: 'Issuer and dates checked.',
  });
  for (const body of [
    { decision: 'APPROVE', reasonCode: 'OK' },
    { decision: 'VERIFY', reasonCode: '' },
    { decision: 'REJECT', reasonCode: 'x'.repeat(101) },
    { decision: 'REVOKE', reasonCode: 'RECALLED', role: 'admin' },
    { decision: 'VERIFY', reasonCode: 'OK', evidenceReviews: [] },
  ]) assert.throws(() => normalizeClaimDecision(body), { code: 'CLAIM_DECISION_INVALID' });
});

test('REN2-69 requires a strong claim row-version validator', () => {
  assert.equal(parseClaimDecisionIfMatch('"7"'), 7);
  for (const value of [undefined, '7', 'W/"7"', '"0"', ['"7"']]) {
    assert.throws(() => parseClaimDecisionIfMatch(value), { code: 'CLAIM_IF_MATCH_INVALID' });
  }
});

test('REN2-69 service binds the normalized decision, expected row version, and global reviewer context', async () => {
  const calls = [];
  const service = new ClaimsService({
    async propose() {}, async list() {},
    async decide(...args) { calls.push(args); return { claimState: 'VERIFIED' }; },
  });
  const claimId = 'b2bd23df-60fc-44f1-9a9e-7d5c67bc4a01';
  const context = { userId: claimId, brandId: claimId, permission: 'catalog.review', requestId: 'req', idempotencyKey: 'review-1' };
  const result = await service.decide(claimId, { decision: 'VERIFY', reasonCode: 'EVIDENCE_VALID' }, '"7"', context);
  assert.equal(result.claimState, 'VERIFIED');
  assert.deepEqual(calls[0].slice(0, 3), [claimId, { decision: 'VERIFY', reasonCode: 'EVIDENCE_VALID', comment: undefined }, 7]);
  assert.equal(calls[0][3], context);
});

test('REN2-69 moderator route requires global catalog review, MFA, and session-bound CSRF', async () => {
  assert.equal(Reflect.getMetadata(REQUIRE_BRAND_PERMISSION, ClaimReviewController.prototype.decide), 'catalog.review');
  assert.equal(Reflect.getMetadata(REQUIRE_MFA_ACTION, ClaimReviewController.prototype.decide), 'catalog.review');
  const calls = [];
  const claims = { async decide(...args) { calls.push(args); return { id: args[0], claimState: 'VERIFIED', rowVersion: 2, requestId: args[3].requestId }; } };
  const sessions = { authenticate: async () => ({ userId: 'global-reviewer' }), expectedCsrf: () => 'csrf-token' };
  const controller = new ClaimReviewController(claims, sessions, { get: () => ['https://app.example.invalid'] });
  const id = 'b2bd23df-60fc-44f1-9a9e-7d5c67bc4a01';
  const request = { id: 'request-1', brandAccess: { brandId: id, userId: 'guard-user', permission: 'catalog.review' }, headers: { cookie: `__Host-renivet_session=${'A'.repeat(43)}`,
    origin: 'https://app.example.invalid', 'sec-fetch-site': 'same-origin', 'x-csrf-token': 'csrf-token' } };
  const result = await controller.decide(id, id, { decision: 'VERIFY', reasonCode: 'EVIDENCE_VALID' }, request, 'key-1', '"1"');
  assert.deepEqual(result, { id, status: 'VERIFIED', rowVersion: 2, requestId: 'request-1' });
  assert.equal(calls[0][3].userId, 'global-reviewer');
  assert.equal(calls[0][3].permission, 'catalog.review');
  await assert.rejects(controller.decide(id, id, { decision: 'VERIFY', reasonCode: 'EVIDENCE_VALID' },
    { ...request, headers: { ...request.headers, 'sec-fetch-site': 'cross-site' } }, 'key-2', '"1"'), (error) => error.getStatus?.() === 403);
});
