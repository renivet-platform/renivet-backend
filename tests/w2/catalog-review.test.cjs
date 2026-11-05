'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const reviewModulePath = '../../dist/modules/catalog/catalog-review.js';
const reviewModule = fs.existsSync(path.join(__dirname, reviewModulePath)) ? require(reviewModulePath) : {};
const { validateReviewDecision, CatalogReviewService } = reviewModule;

const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';

test('REN2-72 requires a valid terminal decision, explicit reason, revision, and CAS version', () => {
  assert.equal(typeof validateReviewDecision, 'function', 'review decision validator must be implemented');
  assert.throws(() => validateReviewDecision({ decision: 'APPROVED', reasonCode: 'OK' }), { code: 'CATALOG_REVIEW_REQUEST_INVALID' });
  assert.throws(() => validateReviewDecision({ decision: 'APPROVED', reasonCode: '   ', expectedRevisionId: UUID_A, expectedRowVersion: 1 }),
    { code: 'CATALOG_REVIEW_REQUEST_INVALID' });
  assert.deepEqual(validateReviewDecision({ decision: 'REJECTED', reasonCode: 'CONTENT_UNSAFE', expectedRevisionId: UUID_A,
    expectedRowVersion: 3, comment: 'Unsafe material claim.' }), {
    decision: 'REJECTED', reasonCode: 'CONTENT_UNSAFE', expectedRevisionId: UUID_A,
    expectedRowVersion: 3, comment: 'Unsafe material claim.',
  });
});

test('REN2-72 decision service validates identities before repository effects', async () => {
  assert.equal(typeof CatalogReviewService, 'function', 'review service must be implemented');
  let calls = 0;
  const service = new CatalogReviewService({ decide: async () => { calls += 1; return { decisionId: UUID_B }; } });
  const context = { userId: UUID_A, brandId: UUID_B, idempotencyKey: 'review-1' };
  await assert.rejects(service.decide(UUID_B, { decision: 'APPROVED', reasonCode: 'PASS', expectedRevisionId: UUID_A,
    expectedRowVersion: 0 }, context), { code: 'CATALOG_REVIEW_REQUEST_INVALID' });
  assert.equal(calls, 0);
  assert.deepEqual(await service.decide(UUID_A, { decision: 'APPROVED', reasonCode: 'PASS', expectedRevisionId: UUID_B,
    expectedRowVersion: 1 }, context), { decisionId: UUID_B });
  assert.equal(calls, 1);
});

test('REN2-72 additive migration has unique terminal decisions, immutable audit and idempotency records', () => {
  const migration = fs.readFileSync(path.join(__dirname, '../../drizzle/0022_ren2_72_product_qc_review.sql'), 'utf8');
  assert.match(migration, /UNIQUE INDEX[\s\S]*product_qc_reviews\(revision_id\)/i);
  assert.match(migration, /CREATE TABLE catalogue\.product_qc_review_events/i);
  assert.match(migration, /CREATE TABLE catalogue\.product_review_decision_receipts/i);
  assert.match(migration, /BEFORE UPDATE OR DELETE/i);
  assert.match(migration, /SUBMITTED.*APPROVED.*REJECTED.*CORRECTION_REQUIRED/i);
  assert.match(migration, /FOREIGN KEY\s*\(reviewer_user_id\) REFERENCES identity\.users/i);
  assert.doesNotMatch(migration, /INSERT INTO access\.role_permissions/i, 'review permission assignments remain owner-controlled');
});
