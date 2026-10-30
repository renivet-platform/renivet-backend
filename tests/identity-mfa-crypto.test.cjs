'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  base32Encode,
  decryptTotpSecret,
  encryptTotpSecret,
  generateRecoveryCodes,
  generateTotpSecret,
  hashRecoveryCode,
  totpCode,
  verifyTotp,
} = require('../dist/modules/identity/mfa-crypto');

test('RFC 6238 SHA-1 vector produces the six-digit authentication code', () => {
  const secret = Buffer.from('12345678901234567890', 'ascii');
  assert.equal(totpCode(secret, 59_000), '287082');
});

test('TOTP accepts only its current or adjacent time step and rejects replayed steps', () => {
  const secret = Buffer.from('12345678901234567890', 'ascii');
  const currentStep = Math.floor(60_000 / 30_000);
  const previousCode = totpCode(secret, 30_000);
  assert.equal(verifyTotp(secret, previousCode, 60_000), currentStep - 1);
  assert.equal(verifyTotp(secret, previousCode, 60_000, currentStep - 1), null);
  assert.equal(verifyTotp(secret, '12345x', 60_000), null);
  assert.equal(verifyTotp(secret, '999999', 60_000), null);
});

test('factor encryption authenticates both ciphertext and owning factor context', () => {
  const key = Buffer.alloc(32, 7);
  const secret = generateTotpSecret();
  const encrypted = encryptTotpSecret(secret, key, 'factor-a', 'user-a');
  assert.notDeepEqual(encrypted.ciphertext, secret);
  assert.deepEqual(decryptTotpSecret(encrypted, key, 'factor-a', 'user-a'), secret);
  assert.throws(() => decryptTotpSecret(encrypted, key, 'factor-b', 'user-a'));
  assert.throws(() => decryptTotpSecret({ ...encrypted, ciphertext: Buffer.from(encrypted.ciphertext).fill(0) }, key, 'factor-a', 'user-a'));
  assert.equal(base32Encode(secret).length, 32);
});

test('recovery codes carry 128 random bits and are represented only by SHA-256 digests', () => {
  const first = generateRecoveryCodes(10);
  const second = generateRecoveryCodes(10);
  assert.equal(first.length, 10);
  assert.equal(new Set(first).size, 10);
  assert.notDeepEqual(first, second);
  for (const code of first) {
    assert.match(code, /^[A-Z2-7]{26}$/);
    const digest = hashRecoveryCode(code);
    assert.match(digest, /^[a-f0-9]{64}$/);
    assert.notEqual(digest, code);
    assert.equal(hashRecoveryCode(code.toLowerCase()), digest);
  }
});
