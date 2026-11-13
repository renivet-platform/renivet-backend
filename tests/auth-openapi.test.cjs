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

test('REN2-23 OpenAPI documents authenticated session inspection and CSRF-protected logout', () => {
  const session = spec.paths['/api/v1/auth/session'];
  assert.ok(session?.get);
  assert.ok(session?.delete);
  assert.equal(session.get.operationId, 'getCurrentSession');
  assert.deepEqual(session.get.responses['200'].content['application/json'].schema.example.account, { signInMethod: 'phone', phoneVerified: true });
  assert.equal(session.delete.operationId, 'logoutCurrentSession');
  assert.ok(session.get.security?.some((entry) => entry.renivetSession));
  assert.ok(session.delete.security?.some((entry) => entry.renivetSession));
  assert.ok(session.delete.responses['403']);
  assert.match(session.delete.description, /X-CSRF-Token/);
  assert.match(session.delete.description, /same-origin/);
});

test('REN2-24 OpenAPI describes the implemented MFA lifecycle, security requirements and safe session rotation', () => {
  const paths = spec.paths;
  const status = paths['/api/v1/auth/mfa']?.get;
  const enrollment = paths['/api/v1/auth/mfa/enrollments']?.post;
  const confirmation = paths['/api/v1/auth/mfa/enrollments/verify']?.post;
  const stepUp = paths['/api/v1/auth/mfa/step-up']?.post;
  const revocation = paths['/api/v1/auth/mfa/factor']?.delete;
  assert.ok(status && enrollment && confirmation && stepUp && revocation);
  assert.equal(status.operationId, 'getMfaStatus');
  assert.equal(enrollment.operationId, 'beginMfaEnrollment');
  assert.equal(confirmation.operationId, 'confirmMfaEnrollment');
  assert.equal(stepUp.operationId, 'stepUpWithMfa');
  assert.equal(revocation.operationId, 'revokeMfaFactor');
  for (const operation of [status, enrollment, confirmation, stepUp, revocation]) {
    assert.ok(operation.security?.some((entry) => entry.renivetSession));
    assert.match(operation.description, /REN2-24/);
  }
  for (const operation of [enrollment, confirmation, stepUp, revocation]) {
    const headers = (operation.parameters ?? []).filter((parameter) => parameter.in === 'header').map((parameter) => parameter.name.toLowerCase());
    assert.ok(headers.includes('origin'));
    assert.ok(headers.includes('sec-fetch-site'));
    assert.ok(headers.includes('x-csrf-token'));
    assert.ok(operation.responses['403']);
  }
  assert.equal(confirmation.requestBody.content['application/json'].schema.$ref, '#/components/schemas/MfaEnrollmentCodeRequestDto');
  assert.equal(stepUp.requestBody.content['application/json'].schema.$ref, '#/components/schemas/MfaStepUpRequestDto');
  assert.equal(enrollment.responses['200'].headers['Cache-Control'].schema.example, 'no-store');
  assert.equal(confirmation.responses['200'].headers['Set-Cookie'].schema.type, 'string');
  assert.equal(stepUp.responses['200'].headers['Set-Cookie'].schema.type, 'string');
  assert.match(enrollment.description, /once/);
  assert.match(confirmation.description, /rotates the session/);
  assert.match(stepUp.description, /unused recovery code/);
  assert.match(revocation.description, /300 seconds/);
  assert.deepEqual(Object.keys(status.responses).sort(), ['200', '401', '500', '503']);
  assert.ok(confirmation.responses['401']);
  assert.ok(stepUp.responses['401']);
});

test('phone login is documented as a distinct OTP purpose that sets the first-party session cookie', () => {
  const issue = spec.paths['/api/v1/auth/challenges']?.post;
  const verify = spec.paths['/api/v1/auth/challenges/{challengeId}/verify']?.post;
  assert.ok(issue && verify);
  const issueSchema = spec.components.schemas[issue.requestBody.content['application/json'].schema.$ref.split('/').at(-1)];
  const verifySchema = spec.components.schemas[verify.requestBody.content['application/json'].schema.$ref.split('/').at(-1)];
  assert.ok(issueSchema.properties.purpose.enum.includes('phone_login'));
  assert.ok(verifySchema.properties.purpose.enum.includes('phone_login'));
  assert.equal(verify.responses['200'].headers['Set-Cookie'].schema.type, 'string');
  assert.match(issue.description, /already verified phone/i);
  assert.match(verify.description, /atomically consumes the challenge and creates a first-party session/i);
});
