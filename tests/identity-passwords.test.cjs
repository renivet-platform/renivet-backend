const test = require('node:test');
const assert = require('node:assert/strict');
const { isPasswordAllowed, PasswordHashService } = require('../dist/modules/identity/passwords');

test('password policy accepts 15 to 128 characters without composition requirements', () => {
  assert.equal(isPasswordAllowed('a'.repeat(15)), true);
  assert.equal(isPasswordAllowed('a'.repeat(128)), true);
  assert.equal(isPasswordAllowed('a'.repeat(14)), false);
  assert.equal(isPasswordAllowed('a'.repeat(129)), false);
  assert.equal(isPasswordAllowed('                '), true);
  assert.equal(isPasswordAllowed(''), false);
});

test('password hashing uses Argon2id at the approved minimum and verifies safely', async () => {
  const service = new PasswordHashService();
  const hash = await service.hash('synthetic test passphrase only');
  assert.match(hash, /^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
  assert.equal(await service.verify(hash, 'synthetic test passphrase only'), true);
  assert.equal(await service.verify(hash, 'a different synthetic passphrase'), false);
  assert.equal(await service.verify('not-a-valid-phc-hash', 'synthetic test passphrase only'), false);
});
