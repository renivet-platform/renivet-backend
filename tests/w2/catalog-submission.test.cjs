'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { canonicalizeSnapshot, snapshotSha256, validateSubmissionReadiness, ProductSubmissionService } = require('../../dist/modules/catalog/catalog-submission.js');

test('REN2-71 canonical snapshot hash ignores object key order and preserves array order', () => {
  const left = { title: 'Dress', attributes: { size: 'M', color: 'Blue' }, media: ['front', 'back'] };
  const right = { media: ['front', 'back'], attributes: { color: 'Blue', size: 'M' }, title: 'Dress' };
  assert.equal(canonicalizeSnapshot(left), canonicalizeSnapshot(right));
  assert.equal(snapshotSha256(left), snapshotSha256(right));
  assert.notEqual(snapshotSha256(left), snapshotSha256({ ...right, media: ['back', 'front'] }));
});

test('REN2-71 snapshot canonicalization rejects unsupported and non-finite values', () => {
  assert.throws(() => canonicalizeSnapshot({ value: undefined }), { code: 'SUBMISSION_SNAPSHOT_INVALID' });
  assert.throws(() => canonicalizeSnapshot({ value: Number.NaN }), { code: 'SUBMISSION_SNAPSHOT_INVALID' });
});

test('REN2-71 readiness reports field-level category, media, price and claim issues', () => {
  const issues = validateSubmissionReadiness({
    category: { active: true, isLeaf: true, published: true, schemaVersion: 3, currentSchemaVersion: 3 },
    attributesValid: true,
    variants: [{ id: 'v1', active: true, currentApprovedPrice: false }],
    media: [{ id: 'm1', clean: true, rightsApproved: false, derivativeReady: true }],
    claims: [{ id: 'c1', verified: false, evidenceEligible: true }],
  });
  assert.deepEqual(issues.map((issue) => issue.code), ['APPROVED_PRICE_REQUIRED', 'MEDIA_RIGHTS_REQUIRED', 'CLAIM_NOT_VERIFIED']);
  assert.ok(issues.every((issue) => typeof issue.path === 'string' && issue.path.length > 0));
});

test('REN2-71 incomplete or invalid submission remains a field-level failure', () => {
  const issues = validateSubmissionReadiness({
    category: { active: true, isLeaf: false, published: false, schemaVersion: 2, currentSchemaVersion: 3 },
    attributesValid: false,
    variants: [], media: [], claims: [],
  });
  assert.deepEqual(issues.map((issue) => issue.code), [
    'CATEGORY_NOT_LEAF', 'CATEGORY_SCHEMA_NOT_CURRENT', 'PRODUCT_ATTRIBUTES_INVALID',
    'ACTIVE_VARIANT_REQUIRED', 'PRODUCT_MEDIA_REQUIRED',
  ]);
});

test('REN2-71 submission service validates CAS and idempotency input before repository effects', async () => {
  let writes = 0;
  const service = new ProductSubmissionService({ submit: async () => { writes += 1; return { revisionId: 'revision' }; } });
  const context = { userId: '11111111-1111-4111-8111-111111111111', brandId: '22222222-2222-4222-8222-222222222222',
    expectedRowVersion: 2, idempotencyKey: 'submit-key', sourceKind: 'MANUAL', sourceReference: null };
  await assert.rejects(service.submit('not-a-uuid', context), { code: 'SUBMISSION_REQUEST_INVALID' });
  await assert.rejects(service.submit('11111111-1111-4111-8111-111111111111', { ...context, expectedRowVersion: 0 }), { code: 'SUBMISSION_REQUEST_INVALID' });
  assert.equal(writes, 0);
  assert.deepEqual(await service.submit('11111111-1111-4111-8111-111111111111', context), { revisionId: 'revision' });
  assert.equal(writes, 1);
});

test('REN2-71 additive migration binds immutable submission receipts to same-brand revisions', () => {
  const migration = fs.readFileSync(path.join(__dirname, '../../drizzle/0021_ren2_71_product_submission.sql'), 'utf8');
  assert.match(migration, /FOREIGN KEY\s*\(revision_id,product_id,brand_id\)\s*REFERENCES catalogue\.product_revisions\(id,product_id,brand_id\)/i);
  assert.match(migration, /UNIQUE\s*\(brand_id,actor_user_id,idempotency_key\)/i);
  assert.match(migration, /BEFORE UPDATE OR DELETE ON catalogue\.product_submission_receipts/i);
  assert.doesNotMatch(migration, /INSERT INTO access\.role_permissions/i, 'migration must not grant the still-unmapped catalog.submit permission');
});
