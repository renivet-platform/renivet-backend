'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { AuthController } = require('../dist/modules/identity/auth.controller');

function controller(mode) {
  return new AuthController({}, {
    authenticate: async () => ({
      userId: '8a2f4b18-7544-4f09-a79b-9aa2f70f8b39',
      sessionId: '417bfe84-600b-4be5-a894-019f1a0b1c47',
      expiresInSeconds: 1_800,
      csrfToken: 'synthetic-session-csrf-token-12345678901234567890',
      account: { signInMethod: 'phone', phoneVerified: true },
      destination: { kind: 'storefront' },
    }),
  }, { get: (key) => key === 'MFA_ENFORCEMENT_MODE' ? mode : undefined });
}

test('current session exposes server-owned MFA policy and retains no-store response', async () => {
  const headers = [];
  const response = await controller('deferred').getSession(
    { headers: { cookie: '__Host-renivet_session=' + 'Q'.repeat(43) } },
    { header: (name, value) => headers.push([name, value]) },
  );
  assert.equal(response.mfaEnforcementMode, 'deferred');
  assert.ok(headers.some(([name, value]) => name === 'Cache-Control' && value === 'no-store'));
});

test('current session reports enforced when policy is absent', async () => {
  const response = await controller(undefined).getSession(
    { headers: { cookie: '__Host-renivet_session=' + 'R'.repeat(43) } },
    { header: () => undefined },
  );
  assert.equal(response.mfaEnforcementMode, 'enforced');
});
