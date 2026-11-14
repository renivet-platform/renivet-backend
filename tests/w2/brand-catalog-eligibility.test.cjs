'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { BrandCatalogEligibilityService } = require('../../dist/modules/identity/brand-catalog-eligibility.js');
const { randomUUID } = require('node:crypto');

test('REN2-55 internal eligibility port rejects maker-checker self approval before persistence', async () => {
  let calls = 0;
  const service = new BrandCatalogEligibilityService({ applyOutcome: async () => { calls += 1; return {}; } });
  const actorId = randomUUID();
  await assert.rejects(service.applyOutcome({
    eventId: randomUUID(), brandId: randomUUID(), applicantUserId: randomUUID(),
    decision: 'approved', approvedByUserId: actorId, checkedByUserId: actorId, requestId: 'req-self-approval',
  }), (error) => error.getResponse?.().code === 'BRAND_APPROVAL_MAKER_CHECKER_REQUIRED');
  assert.equal(calls, 0);
});

test('REN2-55 internal eligibility port rejects an invalid W1 event before persistence', async () => {
  let calls = 0;
  const service = new BrandCatalogEligibilityService({ applyOutcome: async () => { calls += 1; return {}; } });
  await assert.rejects(service.applyOutcome({
    eventId: 'not-a-uuid', brandId: randomUUID(), applicantUserId: randomUUID(),
    decision: 'approved', approvedByUserId: randomUUID(), checkedByUserId: randomUUID(), requestId: 'req-invalid',
  }), (error) => error.getResponse?.().code === 'BRAND_APPROVAL_EVENT_INVALID');
  assert.equal(calls, 0);
});

test('REN2-55 normalizes UUID casing before enforcing independent maker-checker identities', async () => {
  let calls = 0;
  const service = new BrandCatalogEligibilityService({ applyOutcome: async () => { calls += 1; return {}; } });
  const actorId = randomUUID();
  await assert.rejects(service.applyOutcome({
    eventId: randomUUID(), brandId: randomUUID(), applicantUserId: randomUUID(),
    decision: 'approved', approvedByUserId: actorId.toUpperCase(), checkedByUserId: actorId.toLowerCase(), requestId: 'req-case-self-approval',
  }), (error) => error.getResponse?.().code === 'BRAND_APPROVAL_MAKER_CHECKER_REQUIRED');
  assert.equal(calls, 0);
});
