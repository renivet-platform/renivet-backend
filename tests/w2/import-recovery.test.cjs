'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { ForbiddenException, UnprocessableEntityException } = require('@nestjs/common');
const { ImportRecoveryController } = require('../../dist/modules/imports/import-recovery.controller.js');
const { REQUIRE_BRAND_PERMISSION } = require('../../dist/modules/access/brand-access.guard.js');
const { Reflector } = require('@nestjs/core');

const brandId = '11111111-1111-4111-8111-111111111111';
const batchId = '22222222-2222-4222-8222-222222222222';
const userId = '33333333-3333-4333-8333-333333333333';
const token = 'a'.repeat(43);

function fixture() {
  const calls = [];
  const service = {
    async getResults(input) { calls.push(['results', input]); return { page: { batchId, items: [], nextCursor: null }, csv: 'row_number,status,error_codes,effect_receipt_ids\r\n' }; },
    async retryFailures(input) { calls.push(['retry', input]); return { batchId, state: 'QUEUED', retryRequestId: '44444444-4444-4444-8444-444444444444' }; },
  };
  const sessions = { async authenticate(value) { assert.equal(value, token); return { userId }; }, expectedCsrf() { return 'csrf'; } };
  const config = { get(name) { return name === 'AUTH_ALLOWED_ORIGINS' ? ['https://brand.example'] : undefined; } };
  const controller = new ImportRecoveryController(service, sessions, config);
  const request = { id: 'recovery-request-79', headers: { cookie: `__Host-renivet_session=${token}`, origin: 'https://brand.example',
    'sec-fetch-site': 'same-origin', 'x-csrf-token': 'csrf' }, brandAccess: { brandId, userId } };
  return { controller, request, calls };
}

test('REN2-79 result retrieval uses guard-resolved brand, session actor, bounded page and redacted output', async () => {
  const f = fixture();
  const result = await f.controller.results(batchId, f.request, '20', '10', 'json');
  assert.deepEqual(result, { batchId, items: [], nextCursor: null });
  assert.deepEqual(f.calls[0], ['results', { brandId, batchId, actorUserId: userId, cursor: '20', limit: 10, format: 'json' }]);
});

test('REN2-79 retry requires session CSRF, matching If-Match revision and idempotency key', async () => {
  const f = fixture();
  const body = { mode: 'FAILED_ONLY', errorCodes: ['MEDIA_ASSET_NOT_READY'] };
  await assert.rejects(f.controller.retry(batchId, body, { ...f.request, headers: { ...f.request.headers, 'x-csrf-token': 'bad' } }, 'retry-key', '4'), ForbiddenException);
  await assert.rejects(f.controller.retry(batchId, body, f.request, 'retry-key', 'not-a-revision'), UnprocessableEntityException);
  await assert.rejects(f.controller.retry(batchId, body, f.request, undefined, '4'), UnprocessableEntityException);
  assert.equal(f.calls.length, 0);
});

test('REN2-79 retry schedules only failed rows in the authorized batch', async () => {
  const f = fixture();
  const body = { mode: 'FAILED_ONLY', errorCodes: ['MEDIA_ASSET_NOT_READY'] };
  const response = await f.controller.retry(batchId, body, f.request, 'retry-key', 'W/"4"');
  assert.equal(response.state, 'QUEUED');
  assert.deepEqual(f.calls[0], ['retry', { brandId, batchId, actorUserId: userId, requestId: 'recovery-request-79',
    idempotencyKey: 'retry-key', previewRevision: 4, errorCodes: ['MEDIA_ASSET_NOT_READY'] }]);
});

test('REN2-79 routes retain W1 brand-scoped permissions', () => {
  const reflector = new Reflector();
  assert.equal(reflector.get(REQUIRE_BRAND_PERMISSION, ImportRecoveryController.prototype.results), 'imports.read');
  assert.equal(reflector.get(REQUIRE_BRAND_PERMISSION, ImportRecoveryController.prototype.retry), 'imports.write');
});
