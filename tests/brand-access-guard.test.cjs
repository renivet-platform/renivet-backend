const assert = require('node:assert/strict');
const test = require('node:test');
const accessModule = require('../dist/modules/access/brand-access.guard.js');
const { BrandAccessGuard, REQUIRE_BRAND_PERMISSION, RequireBrandPermission } = accessModule;

const token = 'T'.repeat(43);
const userId = '11111111-1111-4111-8111-111111111111';
const brandId = '22222222-2222-4222-8222-222222222222';
function harness({ metadata = 'catalog.product.read', cookie = `__Host-renivet_session=${token}`, sessionError, allowed = true, repositoryError } = {}) {
  const request = { headers: { cookie }, params: { brandId }, body: { userId: 'forged', role: 'renivet_admin' }, query: { userId: 'forged' }, user: { id: 'forged' } };
  const reflector = { get: (key) => key === REQUIRE_BRAND_PERMISSION ? metadata : undefined };
  const sessions = { authenticate: async (value) => {
    assert.equal(value, token);
    if (sessionError) throw sessionError;
    return { userId, sessionId: '33333333-3333-4333-8333-333333333333' };
  } };
  const access = { hasPermission: async (...args) => {
    assert.deepEqual(args, [userId, brandId, metadata]);
    if (repositoryError) throw repositoryError;
    return allowed;
  } };
  const context = { getHandler: () => ({}), getClass: () => ({}), switchToHttp: () => ({ getRequest: () => request }) };
  return { guard: new BrandAccessGuard(reflector, sessions, access), request, context };
}

test('brand permission decorator sets the permission metadata', () => {
  assert.equal(typeof RequireBrandPermission('catalog.product.read'), 'function');
  assert.equal(accessModule.issueBrandAccessContext, undefined, 'only the guard module can create an authorized context');
});

test('authorized scope actor comes from authenticated session, not request claims', async () => {
  const h = harness();
  assert.equal(await h.guard.canActivate(h.context), true);
  assert.equal(h.request.brandAccess.userId, userId);
  assert.equal(h.request.brandAccess.brandId, brandId);
  assert.equal(h.request.brandAccess.permission, 'catalog.product.read');
  assert.equal(Object.hasOwn(h.request.brandAccess, 'sessionId'), false);
});

test('missing or invalid permission metadata fails closed', async () => {
  for (const metadata of [null, '', 'bad permission']) {
    const h = harness({ metadata });
    await assert.rejects(h.guard.canActivate(h.context), (error) => error.getStatus() === 500);
  }
});

test('missing/duplicate session cookie and malformed brand ID are denied', async () => {
  for (const cookie of [null, `__Host-renivet_session=${token}; __Host-renivet_session=${token}`]) {
    const h = harness({ cookie });
    await assert.rejects(h.guard.canActivate(h.context), (error) => error.getStatus() === 401);
  }
  const h = harness();
  h.request.params.brandId = 'not-a-uuid';
  await assert.rejects(h.guard.canActivate(h.context), (error) => error.getStatus() === 403);
});

test('denied brand permission is generic and repository failure fails closed', async () => {
  const denied = harness({ allowed: false });
  await assert.rejects(denied.guard.canActivate(denied.context), (error) => error.getStatus() === 403 && !String(error.message).includes(brandId));
  const unavailable = harness({ repositoryError: new Error('database details') });
  await assert.rejects(unavailable.guard.canActivate(unavailable.context), (error) => error.getStatus() === 503 && !String(error.message).includes('database details'));
});

test('session infrastructure outage is reported as unavailable, not permission denied', async () => {
  const h = harness({ sessionError: Object.assign(new Error('private'), { status: 503 }) });
  await assert.rejects(h.guard.canActivate(h.context), (error) => error.getStatus() === 503);
});
