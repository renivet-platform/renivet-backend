'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash, createHmac } = require('node:crypto');
const { SessionService, SessionDeniedError, validateCsrfRequest } = require('../dist/modules/identity/session.service');

test('active opaque session returns identity and deterministic per-session CSRF proof', async () => {
  const token = 'A'.repeat(43);
  const calls = [];
  const sessions = new SessionService({
    findAndTouchSession: async (digest) => { calls.push(digest); return { userId: 'user-1', expiresAt: new Date(Date.now() + 1_800_000) }; },
    revokeSession: async (digest) => { calls.push(digest); return true; },
  }, 'synthetic-csrf-key-with-at-least-thirty-two-bytes');
  const result = await sessions.authenticate(token);
  assert.equal(result.userId, 'user-1');
  assert.ok(result.expiresInSeconds > 0 && result.expiresInSeconds <= 1_800);
  assert.equal(result.csrfToken, createHmac('sha256', 'synthetic-csrf-key-with-at-least-thirty-two-bytes').update(`renivet-csrf-v1\0${token}`).digest('base64url'));
  assert.deepEqual(calls, [createHash('sha256').update(token).digest('hex')]);
});

test('session cookie lifetime rounds down so it never exceeds the server expiry', async () => {
  const originalNow = Date.now;
  Date.now = () => 1_000_000;
  try {
    const sessions = new SessionService({
      findAndTouchSession: async () => ({ userId: 'user-1', expiresAt: new Date(2_800_100) }),
    }, 'synthetic-csrf-key-with-at-least-thirty-two-bytes');
    const result = await sessions.authenticate('C'.repeat(43));
    assert.equal(result.expiresInSeconds, 1_800);
  } finally {
    Date.now = originalNow;
  }
});

test('expired, revoked, unknown, and rotated token cannot authenticate', async () => {
  const sessions = new SessionService({ findAndTouchSession: async () => null }, 'synthetic-csrf-key-with-at-least-thirty-two-bytes');
  await assert.rejects(sessions.authenticate('A'.repeat(43)), SessionDeniedError);
});

test('logout revokes the stored digest and rejects missing or malformed session secrets', async () => {
  let revoked;
  const sessions = new SessionService({ findAndTouchSession: async () => null, revokeSession: async (digest) => { revoked = digest; return true; } }, 'synthetic-csrf-key-with-at-least-thirty-two-bytes');
  const token = 'B'.repeat(43);
  await sessions.logout(token);
  assert.equal(revoked, createHash('sha256').update(token).digest('hex'));
  await assert.rejects(sessions.authenticate(''), SessionDeniedError);
});

test('cookie-authenticated mutations require an allowlisted same origin, same-origin fetch metadata and valid CSRF token', () => {
  const good = { origin: 'https://app.example.test', 'sec-fetch-site': 'same-origin', 'x-csrf-token': 'proof' };
  assert.equal(validateCsrfRequest(good, ['https://app.example.test'], 'proof'), true);
  assert.equal(validateCsrfRequest({ ...good, origin: 'https://evil.example' }, ['https://app.example.test'], 'proof'), false);
  assert.equal(validateCsrfRequest({ ...good, 'sec-fetch-site': 'cross-site' }, ['https://app.example.test'], 'proof'), false);
  assert.equal(validateCsrfRequest({ ...good, 'x-csrf-token': 'wrong' }, ['https://app.example.test'], 'proof'), false);
  assert.equal(validateCsrfRequest({ ...good, origin: ['https://app.example.test', 'https://attacker.example'] }, ['https://app.example.test'], 'proof'), false);
  assert.equal(validateCsrfRequest({ 'x-csrf-token': 'proof' }, ['https://app.example.test'], 'proof'), false);
});
