const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

test('CI runs local Postman collections with Newman without Postman account authentication', () => {
  const workflow = readFileSync(join(__dirname, '..', '.github', 'workflows', 'ci.yml'), 'utf8');
  const authIntegration = readFileSync(join(__dirname, 'auth-api.integration.test.cjs'), 'utf8');
  const otpIntegration = readFileSync(join(__dirname, 'otp-challenges.integration.test.cjs'), 'utf8');
  const authCollection = JSON.parse(readFileSync(join(__dirname, '..', 'postman', 'collections', 'renivet-backend-auth.postman_collection.json'), 'utf8'));
  const otpCollection = JSON.parse(readFileSync(join(__dirname, '..', 'postman', 'collections', 'renivet-backend-otp.postman_collection.json'), 'utf8'));

  assert.match(workflow, /npm install --global newman@6\.2\.1/);
  assert.match(authIntegration, /spawn\('newman'/);
  assert.match(otpIntegration, /spawn\('newman'/);
  assert.match(authIntegration, /shell: process\.platform === 'win32'/);
  assert.match(otpIntegration, /shell: process\.platform === 'win32'/);
  assert.doesNotMatch(authIntegration, /spawn\('postman'/);
  assert.doesNotMatch(otpIntegration, /spawn\('postman'/);

  const queue = [...authCollection.item];
  let invalidLengthRequest;
  while (queue.length) {
    const item = queue.shift();
    if (item.name === 'Reject invalid passphrase length') invalidLengthRequest = item;
    if (Array.isArray(item.item)) queue.push(...item.item);
  }
  assert.ok(invalidLengthRequest, 'the auth collection retains its invalid-length request');
  const invalidPassword = JSON.parse(invalidLengthRequest.request.body.raw).password;
  assert.ok(invalidPassword.length < 8, 'the invalid password remains below the 8-character minimum');

  const otpQueue = [...otpCollection.item];
  let invalidRecoveryRequest;
  while (otpQueue.length) {
    const item = otpQueue.shift();
    if (item.name === 'Reject invalid replacement passphrase (REN2-23)') invalidRecoveryRequest = item;
    if (Array.isArray(item.item)) otpQueue.push(...item.item);
  }
  assert.ok(invalidRecoveryRequest, 'the OTP collection retains its invalid recovery-length request');
  const invalidRecoveryPassword = JSON.parse(invalidRecoveryRequest.request.body.raw).newPassword;
  assert.ok(invalidRecoveryPassword.length < 8, 'the recovery negative case stays below the 8-character minimum');
  assert.match(JSON.stringify(authCollection), /password \(8–128 characters\)/);
  assert.doesNotMatch(JSON.stringify(authCollection), /password \(15–128 characters\)/);
});
