const test = require('node:test');
const assert = require('node:assert/strict');
const { IdentityRepository } = require('../dist/modules/identity/identity.repository');

function repository(query) {
  return new IdentityRepository({ pool: { query } });
}

test('phone repository stores an unverified number only on an active email-verified account', async () => {
  let captured;
  const identity = repository(async (...args) => {
    captured = args;
    return { rows: [{ verification_required: true }] };
  });
  assert.equal(await identity.setPhoneForVerification('user-1', '+919876543210'), true);
  assert.match(captured[0], /WHERE id = \$1 AND state = 'active' AND email_verified_at IS NOT NULL/);
  assert.match(captured[0], /phone_verified_at = CASE WHEN phone IS DISTINCT FROM \$2 THEN NULL ELSE phone_verified_at END/);
  assert.deepEqual(captured[1], ['user-1', '+919876543210']);
});

test('phone repository preserves verification when the same verified number is submitted again', async () => {
  const identity = repository(async () => ({ rows: [{ verification_required: false }] }));
  assert.equal(await identity.setPhoneForVerification('user-1', '+919876543210'), false);
});

test('phone repository hides phone uniqueness conflicts and lets infrastructure failures fail closed', async () => {
  const conflict = repository(async () => { throw Object.assign(new Error('duplicate phone'), { code: '23505' }); });
  assert.equal(await conflict.setPhoneForVerification('user-1', '+919876543210'), null);
  const outage = repository(async () => { throw new Error('database connection secret'); });
  await assert.rejects(outage.setPhoneForVerification('user-1', '+919876543210'), /database connection secret/);
});
