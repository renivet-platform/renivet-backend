'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createHash } = require('node:crypto');
const { MfaService } = require('../dist/modules/identity/mfa.service');
const { base32Encode, decryptTotpSecret, generateRecoveryCodes, hashRecoveryCode, totpCode, encryptTotpSecret } = require('../dist/modules/identity/mfa-crypto');

function harness(overrides = {}) {
  const key = Buffer.alloc(32, 0x31);
  const calls = { begin: [], activate: [], elevate: [], denied: [], revoke: [], audit: [] };
  const repository = {
    beginEnrollment: async (input) => { calls.begin.push(input); return overrides.beginResult ?? true; },
    getStatus: async () => ({ state: 'not_enrolled', recoveryCodesRemaining: 0 }),
    getPendingFactor: async () => overrides.pendingFactor ?? null,
    getActiveFactor: async () => overrides.activeFactor ?? null,
    activateFactor: async (input) => { calls.activate.push(input); return overrides.activateResult ?? { sessionId: 'activated-session', expiresAt: new Date(1_860_000) }; },
    recordDenied: async (input) => { calls.denied.push(input); },
    elevateSession: async (input) => { calls.elevate.push(input); return overrides.elevatedSession ?? { sessionId: 'rotated-session', expiresAt: new Date(1_860_000) }; },
    revokeFactor: async (input) => { calls.revoke.push(input); return overrides.revokeResult ?? true; },
    recordPrivilegedDecision: async (input) => { calls.audit.push(input); },
  };
  const limiter = { consume: async () => undefined };
  const service = new MfaService(repository, limiter, {
    encryptionKey: key,
    rateLimitHmacKey: 'synthetic-rate-limit-key-with-at-least-32-bytes',
    idleTtlSeconds: 1_800,
    now: () => 60_000,
  });
  return { service, calls, repository, key };
}

test('enrollment returns a provisioning secret once while persisting only authenticated ciphertext', async () => {
  const { service, calls, key } = harness();
  const result = await service.beginEnrollment({ userId: 'user-a', sessionId: 'session-a', ipAddress: '127.0.0.1' });
  const uri = new URL(result.provisioningUri);
  const stored = calls.begin[0];
  const secret = decryptTotpSecret({
    ciphertext: Buffer.from(stored.encryptedSecret, 'base64'),
    iv: Buffer.from(stored.secretIv, 'base64'),
    tag: Buffer.from(stored.secretTag, 'base64'),
  }, key, stored.factorId, 'user-a');
  assert.equal(uri.protocol, 'otpauth:');
  assert.equal(uri.searchParams.get('issuer'), 'Renivet');
  assert.equal(uri.searchParams.get('secret'), base32Encode(secret));
  assert.equal(result.expiresInSeconds, 600);
  assert.notEqual(stored.encryptedSecret, secret.toString('base64'));
  assert.match(stored.ipHash, /^[a-f0-9]{64}$/);
});

test('invalid enrollment proof is denied and audited without persisting or returning factor material', async () => {
  const key = Buffer.alloc(32, 0x31);
  const encrypted = encryptTotpSecret(Buffer.from('12345678901234567890', 'ascii'), key, 'factor-a', 'user-a');
  const { service, calls } = harness({ pendingFactor: {
    id: 'factor-a', encryptedSecret: encrypted.ciphertext.toString('base64'),
    secretIv: encrypted.iv.toString('base64'), secretTag: encrypted.tag.toString('base64'), lastTotpStep: null,
  } });
  await assert.rejects(
    service.confirmEnrollment({ userId: 'user-a', sessionId: 'session-a', code: '000000', ipAddress: '127.0.0.1' }),
    (error) => error.publicResponse.code === 'AUTH_MFA_PROOF_INVALID',
  );
  assert.equal(calls.activate.length, 0);
  assert.equal(calls.denied[0].eventName, 'enrollment_denied');
  assert.equal(JSON.stringify(calls.denied).includes('000000'), false);
});

test('valid enrollment stores only recovery-code digests, rotates session and returns the codes once', async () => {
  const key = Buffer.alloc(32, 0x31);
  const secret = Buffer.from('12345678901234567890', 'ascii');
  const encrypted = encryptTotpSecret(secret, key, 'factor-a', 'user-a');
  const { service, calls } = harness({ pendingFactor: {
    id: 'factor-a',
    encryptedSecret: encrypted.ciphertext.toString('base64'),
    secretIv: encrypted.iv.toString('base64'),
    secretTag: encrypted.tag.toString('base64'),
    lastTotpStep: null,
  } });
  const result = await service.confirmEnrollment({ userId: 'user-a', sessionId: 'session-a', sessionToken: 'E'.repeat(43), code: totpCode(secret, 60_000), ipAddress: '127.0.0.1' });
  assert.equal(result.recoveryCodes.length, 10);
  assert.ok(calls.activate[0].recoveryCodeHashes.every((hash) => /^[a-f0-9]{64}$/.test(hash)));
  assert.equal(calls.activate[0].recoveryCodeHashes.includes(result.recoveryCodes[0]), false);
  assert.equal(calls.activate[0].lastTotpStep, 2);
  assert.equal(calls.activate[0].currentTokenHash, createHash('sha256').update('E'.repeat(43)).digest('hex'));
  assert.match(result.sessionToken, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(calls.activate[0].newTokenHash, createHash('sha256').update(result.sessionToken).digest('hex'));
});

test('successful step-up rotates the opaque session and records the accepted TOTP counter only', async () => {
  const key = Buffer.alloc(32, 0x31);
  const secret = Buffer.from('12345678901234567890', 'ascii');
  const encrypted = encryptTotpSecret(secret, key, 'factor-a', 'user-a');
  const { service, calls } = harness({ activeFactor: {
    id: 'factor-a', encryptedSecret: encrypted.ciphertext.toString('base64'),
    secretIv: encrypted.iv.toString('base64'), secretTag: encrypted.tag.toString('base64'), lastTotpStep: 1,
  } });
  const previousToken = 'A'.repeat(43);
  const result = await service.stepUp({
    userId: 'user-a', sessionId: 'session-a', sessionToken: previousToken,
    code: totpCode(secret, 60_000), ipAddress: '127.0.0.1',
  });
  assert.match(result.sessionToken, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(result.sessionToken, previousToken);
  assert.equal(calls.elevate[0].currentTokenHash, createHash('sha256').update(previousToken).digest('hex'));
  assert.equal(calls.elevate[0].totpStep, 2);
  assert.equal(calls.elevate[0].method, 'totp');
  assert.equal(JSON.stringify(calls.elevate).includes(totpCode(secret, 60_000)), false);
});

test('recovery-code step-up passes only a digest for atomic one-time consumption', async () => {
  const key = Buffer.alloc(32, 0x31);
  const secret = Buffer.from('12345678901234567890', 'ascii');
  const encrypted = encryptTotpSecret(secret, key, 'factor-a', 'user-a');
  const { service, calls } = harness({ activeFactor: {
    id: 'factor-a', encryptedSecret: encrypted.ciphertext.toString('base64'),
    secretIv: encrypted.iv.toString('base64'), secretTag: encrypted.tag.toString('base64'), lastTotpStep: 1,
  } });
  const code = generateRecoveryCodes(1)[0];
  await service.stepUp({ userId: 'user-a', sessionId: 'session-a', sessionToken: 'B'.repeat(43), code, ipAddress: '127.0.0.1' });
  assert.equal(calls.elevate[0].method, 'recovery_code');
  assert.equal(calls.elevate[0].recoveryCodeHash, hashRecoveryCode(code));
  assert.notEqual(calls.elevate[0].recoveryCodeHash, code);
});
