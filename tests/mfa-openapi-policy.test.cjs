'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const openapi = require('../openapi/renivet.openapi.json');

test('every OpenAPI operation marked MFA-required documents the server-owned conditional policy', () => {
  let count = 0;
  for (const pathItem of Object.values(openapi.paths)) {
    for (const operation of Object.values(pathItem)) {
      if (!operation || typeof operation !== 'object' || operation['x-renivet-mfa-required'] !== true) continue;
      count += 1;
      assert.deepEqual(operation['x-renivet-mfa-enforcement'], {
        default: 'enforced',
        deferral: 'Only when MFA_ENFORCEMENT_MODE=deferred and NODE_ENV is development or test; session and business authorization remain required.',
      });
    }
  }
  assert.ok(count > 0, 'expected actual protected API operations in OpenAPI');
});
