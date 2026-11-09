'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { ForbiddenException, UnprocessableEntityException } = require('@nestjs/common');
const { ImportConfirmationController } = require('../../dist/modules/imports/import-confirmation.controller.js');

const brandId = '11111111-1111-4111-8111-111111111111';
const batchId = '22222222-2222-4222-8222-222222222222';
const userId = '33333333-3333-4333-8333-333333333333';
const token = 'a'.repeat(43);
const body = { previewHash: 'a'.repeat(64), previewRevision: 4, allowPartial: false };

function fixture() {
  const calls = [];
  const service = { async confirm(input) { calls.push(input); return { confirmationId: '44444444-4444-4444-8444-444444444444', state: 'COMPLETED' }; } };
  const sessions = { async authenticate(value) { assert.equal(value, token); return { userId }; }, expectedCsrf() { return 'csrf'; } };
  const config = { get(name) { return name === 'AUTH_ALLOWED_ORIGINS' ? ['https://brand.example'] : undefined; } };
  const controller = new ImportConfirmationController(service, sessions, config);
  const request = { id: 'confirm-request-78', headers: { cookie: `__Host-renivet_session=${token}`, origin: 'https://brand.example',
    'sec-fetch-site': 'same-origin', 'x-csrf-token': 'csrf' }, brandAccess: { brandId, userId } };
  return { controller, request, calls };
}

test('REN2-78 requires session CSRF, matching revision precondition, and an idempotency key', async () => {
  const f = fixture();
  await assert.rejects(f.controller.confirm(batchId, body, { ...f.request, headers: { ...f.request.headers, 'x-csrf-token': 'bad' } }, 'key', '4'), ForbiddenException);
  await assert.rejects(f.controller.confirm(batchId, body, f.request, 'key', '3'), UnprocessableEntityException);
  await assert.rejects(f.controller.confirm(batchId, body, f.request, undefined, '4'), UnprocessableEntityException);
  assert.equal(f.calls.length, 0);
});

test('REN2-78 binds confirmation to authenticated actor, guard-resolved brand, frozen preview, and stable request ID', async () => {
  const f = fixture();
  const receipt = await f.controller.confirm(batchId, body, f.request, 'confirm-key', 'W/"4"');
  assert.deepEqual(receipt, { confirmationId: '44444444-4444-4444-8444-444444444444', state: 'COMPLETED' });
  assert.deepEqual(f.calls[0], { brandId, batchId, actorUserId: userId, idempotencyKey: 'confirm-key', previewRevision: 4,
    previewHash: 'a'.repeat(64), allowPartial: false, requestId: 'confirm-request-78' });
});
