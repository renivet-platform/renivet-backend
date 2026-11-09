'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { ForbiddenException, UnprocessableEntityException } = require('@nestjs/common');
const { ImportPreviewController } = require('../../dist/modules/imports/import-preview.controller.js');

const brandId = '11111111-1111-4111-8111-111111111111';
const batchId = '22222222-2222-4222-8222-222222222222';
const sessionUserId = '33333333-3333-4333-8333-333333333333';
const token = 'a'.repeat(43);
const body = { fieldMappings: { Title: 'title', SKU: 'sku' }, categoryMappings: {} };

function controller() {
  const calls = [];
  const service = {
    async saveMapping(input) { calls.push(['saveMapping', input]); return { mappingVersion: 3, previewRevision: 4, previewHash: 'f'.repeat(64) }; },
    async getPreview(input) { calls.push(['getPreview', input]); return { batchId }; },
  };
  const sessions = {
    async authenticate(sessionToken) { assert.equal(sessionToken, token); return { userId: sessionUserId }; },
    expectedCsrf(sessionToken) { assert.equal(sessionToken, token); return 'session-csrf-proof'; },
  };
  const config = { get(name) { return name === 'AUTH_ALLOWED_ORIGINS' ? ['https://brand.example'] : undefined; } };
  const instance = new ImportPreviewController(service, sessions, config);
  const request = { id: 'request-77', headers: { cookie: `__Host-renivet_session=${token}`, origin: 'https://brand.example',
    'sec-fetch-site': 'same-origin', 'x-csrf-token': 'session-csrf-proof' }, brandAccess: { brandId, userId: sessionUserId } };
  return { instance, request, calls };
}

test('REN2-77 requires session-bound CSRF and a mapping version precondition before saving', async () => {
  const fixture = controller();
  await assert.rejects(fixture.instance.saveMapping(batchId, body,
    { ...fixture.request, headers: { ...fixture.request.headers, 'x-csrf-token': 'wrong' } }, 'key-1', '0'), ForbiddenException);
  await assert.rejects(fixture.instance.saveMapping(batchId, body, fixture.request, 'key-1'), UnprocessableEntityException);
  assert.equal(fixture.calls.length, 0);
});

test('REN2-77 binds mapping writes to the authenticated actor and returns a stable receipt', async () => {
  const fixture = controller();
  const receipt = await fixture.instance.saveMapping(batchId, body, fixture.request, 'mapping-77', 'W/"2"');
  assert.deepEqual(receipt, { mappingVersion: 3, previewRevision: 4, previewHash: 'f'.repeat(64) });
  assert.deepEqual(fixture.calls[0], ['saveMapping', { brandId, batchId, actorUserId: sessionUserId,
    idempotencyKey: 'mapping-77', expectedVersion: 2, mapping: body, requestId: 'request-77' }]);
});

test('REN2-77 scopes preview reads to the guard-resolved brand and actor', async () => {
  const fixture = controller();
  assert.deepEqual(await fixture.instance.getPreview(batchId, fixture.request), { batchId });
  assert.deepEqual(fixture.calls[0], ['getPreview', { brandId, batchId, userId: sessionUserId, requestId: 'request-77' }]);
});
