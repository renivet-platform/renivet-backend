'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { Pool } = require('pg');
const Redis = require('ioredis');

const databaseUrl = process.env.RENIVET_TEST_DATABASE_URL;
const redisUrl = process.env.RENIVET_TEST_REDIS_URL;
const enabled = Boolean(databaseUrl && redisUrl && process.env.RENIVET_TEST_SERVICES_DISPOSABLE === '1');

function assertLoopback(url, expectedPath, expectedUser) {
  const parsed = new URL(url);
  assert.ok(['localhost', '127.0.0.1', '::1'].includes(parsed.hostname), 'integration tests require loopback services');
  assert.equal(parsed.pathname, expectedPath);
  if (expectedUser) assert.equal(parsed.username, expectedUser);
}

test('REN2-22 purpose-bound OTP challenge HTTP and PostgreSQL acceptance', { skip: enabled ? false : 'requires explicitly declared disposable PostgreSQL 16 and Redis services', timeout: 120000 }, async () => {
  assertLoopback(databaseUrl, '/renivet_ci', 'renivet_ci');
  assertLoopback(redisUrl, '/15');
  process.env.DATABASE_URL = databaseUrl;
  process.env.REDIS_URL = redisUrl;
  process.env.AUTH_RATE_LIMIT_HMAC_KEY = 'synthetic-otp-integration-rate-key-not-a-secret-0000';
  process.env.AUTH_CHALLENGE_HMAC_KEY = 'synthetic-otp-integration-proof-key-not-a-secret-0000';

  const { NestFactory } = require('@nestjs/core');
  const { FastifyAdapter } = require('@nestjs/platform-fastify');
  const { AppModule } = require('../dist/app.module');
    const { OtpChallengeService, makeOtpProof } = require('../dist/modules/identity/otp-challenge.service');
  const pool = new Pool({ connectionString: databaseUrl });
  const redis = new Redis(redisUrl, { maxRetriesPerRequest: 1, connectTimeout: 1_000 });
  const token = randomUUID();
  const emails = ['postman', 'wrong', 'expired', 'changed', 'concurrent', 'provider'].map((label) => `${label}-${token}@example.test`);
  const sent = [];
  let providerFails = false;
  const fakeDelivery = {
    available: true,
    async send(message) {
      if (providerFails) throw new Error('synthetic provider fault');
      sent.push(message);
    },
  };
  const server = require('node:net').createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  let app;
  let userIds = [];

  try {
    const version = await pool.query('SHOW server_version_num');
    assert.ok(Number(version.rows[0].server_version_num) >= 160000 && Number(version.rows[0].server_version_num) < 170000, 'requires disposable PostgreSQL 16');
    await redis.ping();
    const seeded = await pool.query(
      `INSERT INTO identity.users (email, state) SELECT contact.email, 'pending_verification' FROM unnest($1::text[]) AS contact(email) RETURNING id, email`,
      [emails],
    );
    userIds = seeded.rows.map((row) => row.id);
    const phone = `+1415${token.replace(/\D/g, '').padEnd(10, '0').slice(0, 10)}`;
    const phoneSeed = await pool.query("INSERT INTO identity.users (phone,state) VALUES ($1,'pending_verification') RETURNING id", [phone]);
    userIds.push(phoneSeed.rows[0].id);

    app = await NestFactory.create(AppModule, new FastifyAdapter(), { logger: false });
    app.setGlobalPrefix('api/v1');
    await app.listen(port, '127.0.0.1');
    const base = `http://127.0.0.1:${port}/api/v1`;
    const challengeService = app.get(OtpChallengeService);
    challengeService.delivery = fakeDelivery;
    challengeService.options.codeGenerator = () => '123456';

    const identityRepository = app.get(require('../dist/modules/identity/identity.repository').IdentityRepository);
    const replacementIds = [randomUUID(), randomUUID()];
    await Promise.all(replacementIds.map((id) => identityRepository.issue({
      id, userId: userIds[1], kind: 'email:email_verification', codeHash: 'a'.repeat(64),
      expiresAt: new Date(Date.now() + 300_000), destination: emails[1],
    })));
    const activeAfterConcurrentIssue = await pool.query(
      `SELECT id FROM identity.auth_challenges WHERE user_id=$1 AND kind='email:email_verification' AND consumed_at IS NULL AND expires_at > now()`,
      [userIds[1]],
    );
    assert.equal(activeAfterConcurrentIssue.rowCount, 1, 'concurrent issue requests leave only one active challenge');
    const priorActiveId = activeAfterConcurrentIssue.rows[0].id;
    await identityRepository.issue({
      id: randomUUID(), userId: userIds[1], kind: 'email:email_verification', codeHash: 'b'.repeat(64),
      expiresAt: new Date(Date.now() + 300_000), destination: emails[1],
    });
    const replaced = await pool.query('SELECT consumed_at FROM identity.auth_challenges WHERE id=$1', [priorActiveId]);
    assert.ok(replaced.rows[0].consumed_at, 'issuing a replacement consumes the previous active challenge');

    const postmanEnvironment = { ...process.env };
    delete postmanEnvironment.POSTMAN_API_KEY;
    for (const key of Object.keys(postmanEnvironment)) if (/^(https?_proxy|all_proxy)$/i.test(key)) delete postmanEnvironment[key];
    postmanEnvironment.NO_PROXY = 'localhost,127.0.0.1,::1';
    postmanEnvironment.no_proxy = postmanEnvironment.NO_PROXY;
    const cliArgs = [
      'collection', 'run', 'postman/collections/renivet-backend-otp.postman_collection.json',
      '--env-var', `apiBaseUrl=${base}`,
      '--env-var', `otpDestination=${emails[0]}`,
      '--env-var', 'otpCode=123456',
      '--reporters', 'cli', '--report-events=false', '--timeout-request', '10000', '--timeout', '45000',
    ];
    const postmanRun = await new Promise((resolve, reject) => {
      const cli = spawn('postman', cliArgs, { env: postmanEnvironment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      cli.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
      cli.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
      const timer = setTimeout(() => { cli.kill(); reject(new Error(`Postman CLI timed out.\n${stdout}\n${stderr}`)); }, 45_000);
      cli.once('error', (error) => { clearTimeout(timer); reject(new Error(`Postman CLI could not start: ${error.message}`)); });
      cli.once('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    });
    assert.equal(postmanRun.code, 0, `OTP Postman collection failed:\n${postmanRun.stdout}\n${postmanRun.stderr}`);
    assert.match(postmanRun.stdout, /assertions/i);
    const postmanUser = await pool.query('SELECT email_verified_at, state FROM identity.users WHERE id=$1', [userIds[0]]);
    assert.ok(postmanUser.rows[0].email_verified_at);
    assert.equal(postmanUser.rows[0].state, 'active');
    const storedProof = await pool.query('SELECT code_hash FROM identity.auth_challenges WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1', [userIds[0]]);
    assert.match(storedProof.rows[0].code_hash, /^[a-f0-9]{64}$/);
    assert.notEqual(storedProof.rows[0].code_hash, '123456', 'PostgreSQL must not store the raw OTP');

    const phoneIssued = await fetch(`${base}/auth/challenges`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channel: 'phone', purpose: 'phone_verification', destination: phone }),
    });
    assert.equal(phoneIssued.status, 202);
    const phoneChallenge = await phoneIssued.json();
    assert.equal(sent.at(-1).channel, 'phone');
    const phoneVerified = await fetch(`${base}/auth/challenges/${phoneChallenge.challengeId}/verify`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ purpose: 'phone_verification', code: '123456' }),
    });
    assert.equal(phoneVerified.status, 200);
    const phoneState = await pool.query('SELECT phone_verified_at FROM identity.users WHERE id=$1', [phoneSeed.rows[0].id]);
    assert.ok(phoneState.rows[0].phone_verified_at);

    async function issue(email) {
      const response = await fetch(`${base}/auth/challenges`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ channel: 'email', purpose: 'email_verification', destination: email }),
      });
      const body = await response.json();
      assert.equal(response.status, 202, JSON.stringify(body));
      return body.challengeId;
    }
    async function verify(id, code = '123456', purpose = 'email_verification') {
      return fetch(`${base}/auth/challenges/${id}/verify`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ purpose, code }),
      });
    }

    const racingId = randomUUID();
    const racingProof = makeOtpProof(process.env.AUTH_CHALLENGE_HMAC_KEY, {
      challengeId: racingId, userId: userIds[1], channel: 'email', purpose: 'email_verification', destination: emails[1], code: '123456',
    });
    assert.equal(await identityRepository.issue({
      id: racingId, userId: userIds[1], kind: 'email:email_verification', codeHash: racingProof,
      expiresAt: new Date(Date.now() + 300_000), destination: emails[1],
    }), true);
    const [raceVerification, raceReplacement] = await Promise.all([
      verify(racingId),
      identityRepository.issue({
        id: randomUUID(), userId: userIds[1], kind: 'email:email_verification', codeHash: 'c'.repeat(64),
        expiresAt: new Date(Date.now() + 300_000), destination: emails[1],
      }),
    ]);
    assert.equal(raceReplacement, true, 'overlapping issue and verify transactions must not deadlock');
    assert.ok([200, 401].includes(raceVerification.status));
    const remainingActive = await pool.query(
      `SELECT id FROM identity.auth_challenges WHERE user_id=$1 AND kind='email:email_verification' AND consumed_at IS NULL AND expires_at > now()`,
      [userIds[1]],
    );
    assert.equal(remainingActive.rowCount, 1, 'concurrent issue/verify leaves one coherent active state');

    const unknownSentBefore = sent.length;
    const unknownResponse = await fetch(`${base}/auth/challenges`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channel: 'email', purpose: 'email_verification', destination: `unknown-${token}@example.test` }),
    });
    assert.equal(unknownResponse.status, 202);
    assert.deepEqual(Object.keys(await unknownResponse.json()).sort(), ['challengeId', 'status']);
    assert.equal(sent.length, unknownSentBefore, 'unknown identity must not cause provider delivery');

    const wrongPurposeId = await issue(emails[1]);
    assert.equal((await verify(wrongPurposeId, '123456', 'phone_verification')).status, 401);
    assert.equal((await verify(wrongPurposeId)).status, 200, 'wrong purpose must not consume the valid challenge');

    const wrongId = await issue(emails[2]);
    for (let attempt = 0; attempt < 5; attempt += 1) assert.equal((await verify(wrongId, '000000')).status, 401);
    assert.equal((await verify(wrongId)).status, 401, 'fifth failure consumes the challenge');
    const attempts = await pool.query('SELECT attempt_count, consumed_at FROM identity.auth_challenges WHERE id=$1', [wrongId]);
    assert.equal(attempts.rows[0].attempt_count, 5);
    assert.ok(attempts.rows[0].consumed_at);

    const expiredId = await issue(emails[3]);
    await pool.query('UPDATE identity.auth_challenges SET expires_at=now()-interval \'1 second\' WHERE id=$1', [expiredId]);
    assert.equal((await verify(expiredId)).status, 401);

    const changedId = await issue(emails[4]);
    const changedEmail = `changed-${token}@example.test`;
    await pool.query('UPDATE identity.users SET email=$2 WHERE id=$1', [userIds[4], changedEmail]);
    assert.equal((await verify(changedId)).status, 401, 'contact changes invalidate the proof binding');

    const concurrentId = await issue(emails[5]);
    const results = await Promise.all([verify(concurrentId), verify(concurrentId)]);
    assert.equal(results.filter((response) => response.status === 200).length, 1, 'concurrent replay must have at most one success');
    assert.ok(results.every((response) => response.status === 200 || response.status === 401 || response.status === 429));

    providerFails = true;
    // The contact is already verified, so use a fresh disposable identity.
    const providerEmail = emails[6] ?? `provider-extra-${token}@example.test`;
    const providerUser = await pool.query("INSERT INTO identity.users (email,state) VALUES ($1,'pending_verification') RETURNING id", [providerEmail]);
    userIds.push(providerUser.rows[0].id);
    const failedDelivery = await fetch(`${base}/auth/challenges`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channel: 'email', purpose: 'email_verification', destination: providerEmail }),
    });
    assert.equal(failedDelivery.status, 202, 'delivery failure preserves neutral public acceptance');
    assert.deepEqual(Object.keys(await failedDelivery.json()).sort(), ['challengeId', 'status']);
    const persisted = await pool.query("SELECT id, consumed_at FROM identity.auth_challenges WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1", [providerUser.rows[0].id]);
    assert.equal(persisted.rowCount, 1);
    assert.ok(persisted.rows[0].consumed_at, 'failed delivery challenge is invalidated');
    assert.equal((await verify(persisted.rows[0].id)).status, 401);
    providerFails = false;
    const beforeThrottle = sent.length;
    const throttleEmail = `throttle-${token}@example.test`;
    const throttleUser = await pool.query("INSERT INTO identity.users (email,state) VALUES ($1,'pending_verification') RETURNING id", [throttleEmail]);
    userIds.push(throttleUser.rows[0].id);
    assert.equal((await fetch(`${base}/auth/challenges`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channel: 'email', purpose: 'email_verification', destination: throttleEmail }),
    })).status, 202);
    const limited = await fetch(`${base}/auth/challenges`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channel: 'email', purpose: 'email_verification', destination: throttleEmail }),
    });
    assert.equal(limited.status, 429, 'resend cooldown must be enforced');
    assert.ok(limited.headers.get('retry-after'));
    assert.equal(sent.length, beforeThrottle + 1, 'throttled request must not call delivery adapter');
  } finally {
    await app?.close();
    if (userIds.length) {
      await pool.query('DELETE FROM identity.auth_challenges WHERE user_id = ANY($1::uuid[])', [userIds]).catch(() => {});
      await pool.query('DELETE FROM identity.user_credentials WHERE user_id = ANY($1::uuid[])', [userIds]).catch(() => {});
      await pool.query('DELETE FROM identity.users WHERE id = ANY($1::uuid[])', [userIds]).catch(() => {});
    }
    await pool.end();
    await redis.quit().catch(() => redis.disconnect());
  }
});
