'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { MfaGuard, hasRecentMfa } = require('../dist/common/guards/require-mfa');

function contextFor(request) {
  const handler = function protectedOperation() {};
  return {
    getHandler: () => handler,
    getClass: () => class TestController {},
    switchToHttp: () => ({ getRequest: () => request }),
  };
}

test('MFA freshness accepts only non-future timestamps no older than the configured window', () => {
  const now = 1_000_000;
  assert.equal(hasRecentMfa(new Date(now), 300, now), true);
  assert.equal(hasRecentMfa(new Date(now - 300_000), 300, now), true);
  assert.equal(hasRecentMfa(new Date(now - 300_001), 300, now), false);
  assert.equal(hasRecentMfa(new Date(now + 1), 300, now), false);
  assert.equal(hasRecentMfa(null, 300, now), false);
});

test('guard denies absent elevation even when client submits admin and MFA claims, and audits denial', async () => {
  const audited = [];
  const request = {
    headers: { cookie: '__Host-renivet_session=' + 'A'.repeat(43) },
    body: { role: 'admin', mfaVerifiedAt: new Date().toISOString() },
    ip: '127.0.0.1',
  };
  const guard = new MfaGuard(
    { get: () => 'finance.evidence.manage' },
    { authenticate: async () => ({ userId: 'user-a', sessionId: 'session-a', mfaVerifiedAt: null }) },
    { auditPrivilegedDecision: async (input) => audited.push(input) },
    () => 1_000_000,
  );
  await assert.rejects(guard.canActivate(contextFor(request)), (error) => error.getStatus() === 403);
  assert.equal(audited.length, 1);
  assert.equal(audited[0].action, 'finance.evidence.manage');
  assert.equal(audited[0].allowed, false);
  assert.equal(audited[0].userId, 'user-a');
});

test('guard admits only the server-authenticated session with fresh persisted elevation', async () => {
  const audited = [];
  const request = { headers: { cookie: '__Host-renivet_session=' + 'B'.repeat(43) }, body: { role: 'customer' }, ip: '127.0.0.1' };
  const guard = new MfaGuard(
    { get: () => 'brand.manage' },
    { authenticate: async () => ({ userId: 'user-b', sessionId: 'session-b', mfaVerifiedAt: new Date(950_000) }) },
    { auditPrivilegedDecision: async (input) => audited.push(input) },
    () => 1_000_000,
  );
  assert.equal(await guard.canActivate(contextFor(request)), true);
  assert.deepEqual(request.authSession, { userId: 'user-b', sessionId: 'session-b' });
  assert.equal(audited[0].allowed, true);
});

for (const action of ['taxonomy.manage', 'taxonomy.approve', 'pricing.approve']) {
  test(`guard accepts a fresh persisted MFA step-up for ${action}`, async () => {
    const audited = [];
    const request = { headers: { cookie: '__Host-renivet_session=' + 'D'.repeat(43) }, ip: '127.0.0.1' };
    const guard = new MfaGuard(
      { get: () => action },
      { authenticate: async () => ({ userId: 'platform-admin', sessionId: 'session-admin', mfaVerifiedAt: new Date(950_000) }) },
      { auditPrivilegedDecision: async (input) => audited.push(input) },
      () => 1_000_000,
    );
    assert.equal(await guard.canActivate(contextFor(request)), true);
    assert.deepEqual(request.authSession, { userId: 'platform-admin', sessionId: 'session-admin' });
    assert.deepEqual(audited, [{
      action,
      userId: 'platform-admin',
      sessionId: 'session-admin',
      allowed: true,
      ipAddress: '127.0.0.1',
    }]);
  });
}

test('guard audits and rejects invalid session cookies without trusting request identity', async () => {
  const audited = [];
  const request = { headers: { cookie: '__Host-renivet_session=' + 'C'.repeat(43) }, ip: '127.0.0.1' };
  const guard = new MfaGuard(
    { get: () => 'staff.manage' },
    { authenticate: async () => { throw Object.assign(new Error('private detail'), { status: 401, publicResponse: { code: 'AUTHENTICATION_FAILED', message: 'The session could not be verified.' } }); } },
    { auditPrivilegedDecision: async (input) => audited.push(input) },
    () => 1_000_000,
  );
  await assert.rejects(guard.canActivate(contextFor(request)), (error) => error.getStatus() === 401);
  assert.equal(audited[0].allowed, false);
  assert.equal(audited[0].userId, null);
});

test('guard reports missing authentication separately from missing MFA elevation', async () => {
  const audited = [];
  const guard = new MfaGuard(
    { get: () => 'staff.manage' },
    { authenticate: async () => { throw new Error('must not authenticate without a cookie'); } },
    { auditPrivilegedDecision: async (input) => audited.push(input) },
    () => 1_000_000,
  );
  await assert.rejects(
    guard.canActivate(contextFor({ headers: {}, ip: '127.0.0.1' })),
    (error) => error.getStatus() === 401,
  );
  assert.equal(audited[0].allowed, false);
  assert.equal(audited[0].userId, null);
});
