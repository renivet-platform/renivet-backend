'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const spec = require('../openapi/renivet.openapi.json');

test('REN2-21 OpenAPI documents implemented registration and login routes', () => {
  const registration = spec.paths['/api/v1/auth/register']?.post;
  const session = spec.paths['/api/v1/auth/sessions']?.post;
  assert.ok(registration);
  assert.ok(session);
  assert.equal(registration.operationId, 'registerWithEmailAndPassword');
  assert.equal(session.operationId, 'createPasswordSession');
  assert.deepEqual(Object.keys(registration.responses).sort(), ['202', '400', '429', '500', '503']);
  assert.deepEqual(Object.keys(session.responses).sort(), ['200', '400', '401', '429', '500', '503']);
  assert.equal(registration.responses['429'].headers['Retry-After'].schema.example, 900);
  assert.equal(registration.requestBody.content['application/json'].schema.$ref, '#/components/schemas/RegisterRequestDto');
  assert.equal(session.requestBody.content['application/json'].schema.$ref, '#/components/schemas/PasswordSessionRequestDto');
  assert.equal(session.responses['200'].headers['Set-Cookie'].schema.type, 'string');
  assert.equal(session.responses['429'].headers['Retry-After'].schema.example, 900);
  assert.ok(spec.components.securitySchemes.renivetSession);
});
