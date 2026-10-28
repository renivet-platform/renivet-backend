'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('REN2-22 HTTP routes use generic responses, validation, and consume successful challenges once', { timeout: 30000 }, async () => {
  process.env.NODE_ENV = 'test';
  process.env.AUTH_RATE_LIMIT_HMAC_KEY = 'synthetic-otp-http-rate-key-not-a-secret-000000000';
  process.env.AUTH_CHALLENGE_HMAC_KEY = 'synthetic-otp-http-proof-key-not-a-secret-000000000';
  const { NestFactory } = require('@nestjs/core');
  const { FastifyAdapter } = require('@nestjs/platform-fastify');
  const { AppModule } = require('../dist/app.module');
  const { IdentityRepository } = require('../dist/modules/identity/identity.repository');
  const { AuthRateLimiter } = require('../dist/modules/identity/rate-limiter');
  const { OtpChallengeService, makeOtpProof } = require('../dist/modules/identity/otp-challenge.service');
  const app = await NestFactory.create(AppModule, new FastifyAdapter(), { logger: false });
  app.setGlobalPrefix('api/v1');
  const records = new Map();
  const delivered = [];
  const repository = app.get(IdentityRepository);
  repository.findUnverified = async (channel, destination) => destination.startsWith('known-') || destination === 'known@example.test' ? { userId: 'e1c64e79-8b2e-4e49-8f4b-1e72a7c639f1', destination } : null;
  repository.issue = async (challenge) => { records.set(challenge.id, { ...challenge, consumed: false }); return true; };
  repository.invalidate = async (id) => { const record = records.get(id); if (record) record.consumed = true; };
  repository.verify = async ({ id, purpose, code, hmacKey, maxAttempts }) => {
    const record = records.get(id);
    if (!record || record.consumed || record.expiresAt.getTime() <= Date.now()) return 'denied';
    const [channel, expectedPurpose] = record.kind.split(':');
    if (purpose !== expectedPurpose || record.attemptCount >= maxAttempts) return 'denied';
    const proof = makeOtpProof(hmacKey, { challengeId: id, userId: record.userId, channel, purpose, destination: record.destination, code });
    if (proof !== record.codeHash) { record.attemptCount += 1; return 'denied'; }
    record.consumed = true;
    return 'verified';
  };
  const limiter = app.get(AuthRateLimiter);
  limiter.consume = async () => undefined;
  limiter.withLock = async (_scope, _identity, _ttl, callback) => callback();
  const service = app.get(OtpChallengeService);
  service.delivery = { available: true, send: async (message) => delivered.push(message) };
  service.options.codeGenerator = () => '123456';
  const portServer = require('node:net').createServer();
  portServer.listen(0, '127.0.0.1');
  await new Promise((resolve) => portServer.once('listening', resolve));
  const port = portServer.address().port;
  await new Promise((resolve) => portServer.close(resolve));
  try {
    await app.listen(port, '127.0.0.1');
    const base = `http://127.0.0.1:${port}/api/v1/auth/challenges`;
    const unknown = await fetch(base, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ channel: 'email', purpose: 'email_verification', destination: 'unknown@example.test' }) });
    assert.equal(unknown.status, 202);
    const unknownBody = await unknown.json();
    assert.equal(unknownBody.status, 'accepted');
    assert.equal(delivered.length, 0);

    const invalid = await fetch(base, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ channel: 'email', purpose: 'phone_verification', destination: 'known@example.test' }) });
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).code, 'AUTH_INPUT_INVALID');

    const issued = await fetch(base, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ channel: 'email', purpose: 'email_verification', destination: ' Known@Example.Test ' }) });
    assert.equal(issued.status, 202);
    const body = await issued.json();
    assert.equal(delivered[0].destination, 'known@example.test');
    assert.equal(JSON.stringify(body).includes('123456'), false);
    const verify = () => fetch(`${base}/${body.challengeId}/verify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ purpose: 'email_verification', code: '123456' }) });
    assert.equal((await verify()).status, 200);
    const replay = await verify();
    assert.equal(replay.status, 401);
    assert.equal((await replay.json()).code, 'AUTHENTICATION_FAILED');
  } finally {
    await app.close();
  }
});
