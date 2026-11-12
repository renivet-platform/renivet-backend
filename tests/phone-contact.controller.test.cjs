const test = require('node:test');
const assert = require('node:assert/strict');
const { PhoneContactController } = require('../dist/modules/identity/phone-contact.controller');
const { CsrfRejectedError } = require('../dist/modules/identity/session.service');

function fixture(overrides = {}) {
  const calls = [];
  const sessions = {
    authenticate: async (token) => {
      calls.push(['authenticate', token]);
      if (!token || overrides.unauthorized) throw new Error('session denied');
      return { userId: 'user-1', csrfToken: 'synthetic-session-csrf-proof' };
    },
    expectedCsrf: () => 'synthetic-session-csrf-proof',
  };
  const contacts = { setPhoneForVerification: async (...args) => { calls.push(['set-phone', ...args]); return { status: 'accepted', verificationRequired: true }; } };
  const configuration = { get: (key) => key === 'AUTH_ALLOWED_ORIGINS' ? ['http://127.0.0.1:3000'] : undefined };
  const controller = new PhoneContactController(sessions, contacts, configuration);
  const context = {
    ip: '127.0.0.1',
    headers: {
      cookie: `__Host-renivet_session=${'A'.repeat(43)}`,
      origin: 'http://127.0.0.1:3000',
      'sec-fetch-site': 'same-origin',
      'x-csrf-token': overrides.csrf ?? 'synthetic-session-csrf-proof',
    },
  };
  return { controller, context, calls };
}

test('phone contact change requires a session and valid same-origin CSRF proof before writing', async () => {
  const { controller, context, calls } = fixture();
  const responseHeaders = [];
  const response = await controller.setPhone({ phone: '+919876543210' }, context, { header: (...args) => responseHeaders.push(args) });
  assert.deepEqual(response, { status: 'accepted', verificationRequired: true });
  assert.deepEqual(responseHeaders, [['Cache-Control', 'no-store']]);
  assert.deepEqual(calls.find(([kind]) => kind === 'set-phone'), ['set-phone', 'user-1', '+919876543210', '127.0.0.1']);
});

test('phone contact change rejects an invalid CSRF proof before updating identity', async () => {
  const { controller, context, calls } = fixture({ csrf: 'attacker-proof' });
  await assert.rejects(controller.setPhone({ phone: '+919876543210' }, context), CsrfRejectedError);
  assert.equal(calls.some(([kind]) => kind === 'set-phone'), false);
});

test('phone contact change rejects a missing authenticated session before updating identity', async () => {
  const { controller, context, calls } = fixture({ unauthorized: true });
  await assert.rejects(controller.setPhone({ phone: '+919876543210' }, context));
  assert.equal(calls.some(([kind]) => kind === 'set-phone'), false);
});
