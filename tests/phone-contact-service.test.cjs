const test = require('node:test');
const assert = require('node:assert/strict');
const { PhoneContactService } = require('../dist/modules/identity/phone-contact.service');
const { AuthHttpError } = require('../dist/modules/identity/auth.service');

function fixture(overrides = {}) {
  const calls = [];
  const repository = {
    setPhoneForVerification: async (...args) => { calls.push(['save', ...args]); return true; },
    ...overrides.repository,
  };
  const limiter = {
    consume: async (...args) => calls.push(['limit', ...args]),
    ...overrides.limiter,
  };
  return { service: new PhoneContactService(repository, limiter), calls };
}

test('setPhoneForVerification stores only an Indian mobile number and resets any prior verification', async () => {
  const { service, calls } = fixture();
  assert.deepEqual(await service.setPhoneForVerification('user-1', '+919876543210', '127.0.0.1'), { status: 'accepted', verificationRequired: true });
  assert.equal(calls.filter(([kind]) => kind === 'limit').length, 2);
  assert.deepEqual(calls.find(([kind]) => kind === 'save'), ['save', 'user-1', '+919876543210']);
});

test('phone update rejects unsupported or malformed destinations before writing', async () => {
  const { service, calls } = fixture();
  for (const phone of ['9876543210', '+14155550100', '+91987654321', '+919876543210x']) {
    await assert.rejects(service.setPhoneForVerification('user-1', phone, '127.0.0.1'), (error) => error instanceof AuthHttpError && error.status === 400);
  }
  assert.equal(calls.some(([kind]) => kind === 'save'), false);
});

test('phone update applies per-user and per-IP rate limits before changing the number', async () => {
  const { service, calls } = fixture();
  await service.setPhoneForVerification('user-1', '+919876543210', '127.0.0.1');
  assert.deepEqual(calls.filter(([kind]) => kind === 'limit').map(([, scope, identity, rule]) => [scope, identity, rule]), [
    ['phone-change-user', 'user-1', { limit: 3, windowSeconds: 900 }],
    ['phone-change-ip', '127.0.0.1', { limit: 15, windowSeconds: 900 }],
  ]);
});

test('a phone already attached to another account is returned as a generic invalid request', async () => {
  const { service } = fixture({ repository: { setPhoneForVerification: async () => null } });
  await assert.rejects(service.setPhoneForVerification('user-1', '+919876543210', '127.0.0.1'), (error) => {
    assert.ok(error instanceof AuthHttpError);
    assert.equal(error.status, 400);
    assert.doesNotMatch(error.message, /already|owner|account/i);
    return true;
  });
});

test('a number already verified on this account does not need another challenge', async () => {
  const { service } = fixture({ repository: { setPhoneForVerification: async () => false } });
  assert.deepEqual(await service.setPhoneForVerification('user-1', '+919876543210', '127.0.0.1'), {
    status: 'accepted', verificationRequired: false,
  });
});
