'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { normalizeClaimProposal } = require('../../dist/modules/catalog/claims.service.js');
const { parseClaimIfMatch, ClaimsService } = require('../../dist/modules/catalog/claims.service.js');
const { ClaimsController } = require('../../dist/modules/catalog/claims.controller.js');

test('REN2-68 accepts a bounded claim with evidence IDs and an optional expiry', () => {
  const evidenceAssetId = 'b2bd23df-60fc-44f1-9a9e-7d5c67bc4a01';
  assert.deepEqual(normalizeClaimProposal({ claimCode: 'RECYCLED_CONTENT', claimText: 'Contains recycled material', evidenceAssetIds: [evidenceAssetId], expiresAt: '2030-01-01T00:00:00Z' }), {
    claimCode: 'RECYCLED_CONTENT', claimText: 'Contains recycled material', evidenceAssetIds: [evidenceAssetId], expiresAt: '2030-01-01T00:00:00.000Z',
  });
});

test('REN2-68 rejects unknown fields, missing evidence, duplicate IDs and malformed expiry', () => {
  const id = 'b2bd23df-60fc-44f1-9a9e-7d5c67bc4a01';
  for (const body of [
    { claimCode: 'X', claimText: 'text', evidenceAssetIds: [] },
    { claimCode: 'X', claimText: 'text', evidenceAssetIds: [id, id] },
    { claimCode: 'X', claimText: 'text', evidenceAssetIds: [id], expiresAt: 'tomorrow' },
    { claimCode: 'X', claimText: 'text', evidenceAssetIds: [id], claimState: 'VERIFIED' },
  ]) assert.throws(() => normalizeClaimProposal(body), { code: 'CLAIM_PROPOSAL_INVALID' });
});

test('REN2-68 preserves null expiry and rejects dates in the past', () => {
  const id = 'b2bd23df-60fc-44f1-9a9e-7d5c67bc4a01';
  assert.equal(normalizeClaimProposal({ claimCode: 'X', claimText: 'text', evidenceAssetIds: [id], expiresAt: null }).expiresAt, null);
  assert.throws(() => normalizeClaimProposal({ claimCode: 'X', claimText: 'text', evidenceAssetIds: [id], expiresAt: '2020-01-01T00:00:00Z' }), { code: 'CLAIM_PROPOSAL_INVALID' });
});

test('REN2-68 parses strong product row versions and rejects missing or weak validators', () => {
  assert.equal(parseClaimIfMatch('"42"'), 42);
  for (const value of [undefined, '42', 'W/"42"', '"0"', ['"2"']]) {
    assert.throws(() => parseClaimIfMatch(value), { code: 'CLAIM_IF_MATCH_INVALID' });
  }
});

test('REN2-68 service validates scope IDs and forwards normalized requests only', async () => {
  const calls = [];
  const service = new ClaimsService({
    async propose(...args) { calls.push(args); return { claimState: 'PENDING' }; },
    async list(...args) { calls.push(args); return { items: [] }; },
  });
  const productId = 'b2bd23df-60fc-44f1-9a9e-7d5c67bc4a01';
  const context = { userId: productId, brandId: productId, permission: 'catalog.write', requestId: 'req', idempotencyKey: 'claim-1' };
  const result = await service.propose(productId, { claimCode: 'X', claimText: 'Claim', evidenceAssetIds: ['b2bd23df-60fc-44f1-9a9e-7d5c67bc4a02'] }, '"4"', context);
  assert.equal(result.claimState, 'PENDING');
  assert.equal(calls[0][2], 4);
  assert.equal(calls[0][1].claimCode, 'X');
  await assert.rejects(service.propose('not-a-uuid', {}, '"1"', context), { code: 'CLAIM_REQUEST_INVALID' });
});

test('REN2-68 controller binds mutation identity to the W1 session, enforces session-bound CSRF, and scopes reads to guard context', async () => {
  const brandId = 'b2bd23df-60fc-44f1-9a9e-7d5c67bc4a01'; const productId = 'b2bd23df-60fc-44f1-9a9e-7d5c67bc4a02';
  const token = 'A'.repeat(43); const calls = [];
  const claims = {
    async propose(...args) { calls.push(['propose', ...args]); return { claimState: 'PENDING' }; },
    async list(...args) { calls.push(['list', ...args]); return { items: [] }; },
  };
  const sessions = { authenticate: async () => ({ userId: 'trusted-session-user' }), expectedCsrf: () => 'session-csrf' };
  const config = { get: () => ['https://app.example.invalid'] };
  const controller = new ClaimsController(claims, sessions, config);
  const request = { id: 'trusted-request', headers: { cookie: `__Host-renivet_session=${token}`,
    origin: 'https://app.example.invalid', 'sec-fetch-site': 'same-origin', 'x-csrf-token': 'session-csrf' },
  brandAccess: { brandId, userId: 'guard-user', permission: 'catalog.write' } };
  await controller.propose(productId, { claimCode: 'X', claimText: 'text', evidenceAssetIds: ['b2bd23df-60fc-44f1-9a9e-7d5c67bc4a03'] }, request, 'key-1', '"1"');
  assert.equal(calls[0][4].userId, 'trusted-session-user', 'body/request claims cannot select the mutation actor');
  assert.equal(calls[0][4].brandId, brandId, 'brand scope comes from BrandAccessGuard');
  await assert.rejects(controller.propose(productId, {}, { ...request, headers: { ...request.headers, 'sec-fetch-site': 'cross-site' } }, 'key-2', '"1"'),
    (error) => error.getStatus?.() === 403);
  await controller.list(productId, request);
  assert.equal(calls[1][2].userId, 'guard-user', 'read authorization uses the live guard context');
  assert.equal(calls[1][2].permission, 'catalog.read');
});

