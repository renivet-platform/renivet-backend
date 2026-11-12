const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

test('CI runs local Postman collections with Newman without Postman account authentication', () => {
  const workflow = readFileSync(join(__dirname, '..', '.github', 'workflows', 'ci.yml'), 'utf8');
  const authIntegration = readFileSync(join(__dirname, 'auth-api.integration.test.cjs'), 'utf8');
  const otpIntegration = readFileSync(join(__dirname, 'otp-challenges.integration.test.cjs'), 'utf8');

  assert.match(workflow, /npm install --global newman@6\.2\.1/);
  assert.match(authIntegration, /spawn\('newman'/);
  assert.match(otpIntegration, /spawn\('newman'/);
  assert.doesNotMatch(authIntegration, /spawn\('postman'/);
  assert.doesNotMatch(otpIntegration, /spawn\('postman'/);
});
