'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { ForbiddenException, UnauthorizedException } = require('@nestjs/common');
const { AuthExceptionFilter } = require('../dist/modules/identity/auth-exception.filter');

function capture(exception) {
  const result = { headers: {}, body: undefined, status: undefined };
  const reply = {
    status(value) { result.status = value; return this; },
    header(name, value) { result.headers[name] = value; return this; },
    send(body) { result.body = body; },
  };
  new AuthExceptionFilter().catch(exception, {
    switchToHttp: () => ({ getRequest: () => ({ id: 'synthetic-request-id' }), getResponse: () => reply }),
  });
  return result;
}

test('auth exception filter preserves safe MFA guard authentication and step-up responses', () => {
  const unauthenticated = capture(new UnauthorizedException({ code: 'AUTHENTICATION_FAILED', message: 'internal details must not escape' }));
  assert.equal(unauthenticated.status, 401);
  assert.deepEqual(unauthenticated.body, {
    code: 'AUTHENTICATION_FAILED',
    message: 'The session could not be verified.',
    requestId: 'synthetic-request-id',
  });

  const insufficientMfa = capture(new ForbiddenException({ code: 'AUTH_MFA_STEP_UP_REQUIRED', message: 'untrusted caller text' }));
  assert.equal(insufficientMfa.status, 403);
  assert.deepEqual(insufficientMfa.body, {
    code: 'AUTH_MFA_STEP_UP_REQUIRED',
    message: 'A recent MFA step-up is required.',
    requestId: 'synthetic-request-id',
  });
});

test('auth exception filter keeps unknown Nest exceptions redacted as internal errors', () => {
  const result = capture(new ForbiddenException({ code: 'SECRET_INTERNAL_CODE', message: 'sensitive detail' }));
  assert.equal(result.status, 500);
  assert.deepEqual(result.body, {
    code: 'AUTH_INTERNAL_ERROR',
    message: 'Authentication could not be completed.',
    requestId: 'synthetic-request-id',
  });
});
