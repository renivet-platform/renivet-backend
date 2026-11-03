const assert = require('node:assert/strict');
const test = require('node:test');
const { PlatformPermissionGuard, REQUIRE_PLATFORM_PERMISSION, RequirePlatformPermission } = require('../dist/modules/access/platform-permission.guard.js');

const token = 'T'.repeat(43);
const userId = '11111111-1111-4111-8111-111111111111';

function harness({ permission = 'taxonomy.manage', granted = false, repositoryError } = {}) {
  const request = { headers: { cookie: `__Host-renivet_session=${token}` }, body: { userId: 'forged', role: 'renivet_admin', scope: 'global' }, query: { userId: 'forged' } };
  const reflector = { get: (key) => key === REQUIRE_PLATFORM_PERMISSION ? permission : undefined };
  const sessions = { authenticate: async (value) => {
    assert.equal(value, token);
    return { userId, sessionId: '33333333-3333-4333-8333-333333333333' };
  } };
  const access = { hasGlobalPermission: async (...args) => {
    assert.deepEqual(args, [userId, permission]);
    if (repositoryError) throw repositoryError;
    return granted;
  } };
  const context = { getHandler: () => ({}), getClass: () => ({}), switchToHttp: () => ({ getRequest: () => request }) };
  return { guard: new PlatformPermissionGuard(reflector, sessions, access), request, context };
}

test('platform permission decorator declares global permission metadata', () => {
  assert.equal(typeof RequirePlatformPermission('taxonomy.manage'), 'function');
});

test('brand role without a global taxonomy grant is denied and client claims cannot elevate it', async () => {
  const h = harness({ granted: false });
  await assert.rejects(h.guard.canActivate(h.context), (error) => error.getStatus() === 403);
  assert.equal(h.request.platformPermission, undefined);
});

test('explicit global permission is resolved from the authenticated W1 session', async () => {
  const h = harness({ granted: true });
  assert.equal(await h.guard.canActivate(h.context), true);
  assert.deepEqual(h.request.platformPermission, { userId, permission: 'taxonomy.manage' });
});

test('missing policy and repository outage fail closed', async () => {
  const missing = harness({ permission: null, granted: true });
  await assert.rejects(missing.guard.canActivate(missing.context), (error) => error.getStatus() === 500);
  const unavailable = harness({ repositoryError: new Error('database details') });
  await assert.rejects(unavailable.guard.canActivate(unavailable.context), (error) => error.getStatus() === 503 && !String(error.message).includes('database details'));
});
