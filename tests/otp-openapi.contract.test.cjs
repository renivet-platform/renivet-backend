'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const contract = require('../openapi/renivet.openapi.json');

test('REN2-22/23 OpenAPI documents challenge verification and purpose-bound password recovery', () => {
  const issuePath = contract.paths['/api/v1/auth/challenges']?.post;
  const verifyPath = contract.paths['/api/v1/auth/challenges/{challengeId}/verify']?.post;
  assert.ok(issuePath);
  assert.ok(verifyPath);
  assert.equal(issuePath.operationId, 'createOtpChallenge');
  assert.equal(verifyPath.operationId, 'verifyOtpChallenge');
  assert.match(issuePath.description, /REN2-22/);
  assert.match(verifyPath.description, /REN2-22/);
  assert.match(issuePath.description, /no authentication or permission/);
  assert.match(verifyPath.description, /issues no session/);
  assert.match(verifyPath.description, /password_recovery/);
  assert.match(verifyPath.requestBody.content['application/json'].schema.$ref, /OtpVerifyRequestDto/);
  for (const status of ['202', '400', '429', '500', '503']) assert.ok(issuePath.responses[status], `issue response ${status} is documented`);
  for (const status of ['200', '400', '401', '429', '500', '503']) assert.ok(verifyPath.responses[status], `verify response ${status} is documented`);
  assert.deepEqual(verifyPath.parameters.find((parameter) => parameter.name === 'challengeId')?.schema, {
    type: 'string', format: 'uuid', example: '37a7d0bf-8414-4f75-bd11-311c7a442d84',
  });
});

test('REN2-39 phone attachment is authenticated, CSRF protected, and separate from OTP verification', () => {
  const operation = contract.paths['/api/v1/auth/phone']?.post;
  assert.ok(operation);
  assert.equal(operation.operationId, 'setPhoneForVerification');
  assert.match(operation.description, /active first-party session cookie/);
  assert.match(operation.description, /session-bound X-CSRF-Token/);
  assert.match(operation.description, /Phone-number login is not provided/);
  assert.deepEqual(operation.requestBody.content['application/json'].schema.$ref, '#/components/schemas/SetPhoneForVerificationDto');
  assert.ok(operation.security?.some((scheme) => Object.hasOwn(scheme, 'renivetSession')));
  for (const status of ['202', '400', '401', '403', '429', '500', '503']) {
    assert.ok(operation.responses[status], `phone attachment ${status} response is documented`);
  }
});
