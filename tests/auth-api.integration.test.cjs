'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomInt, randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const argon2 = require('argon2');
const Redis = require('ioredis');
const { Pool } = require('pg');

const databaseUrl = process.env.RENIVET_TEST_DATABASE_URL;
const redisUrl = process.env.RENIVET_TEST_REDIS_URL;
const enabled = Boolean(databaseUrl && redisUrl && process.env.RENIVET_TEST_SERVICES_DISPOSABLE === '1');

function assertDisposableDatabase(value) {
  const url = new URL(value);
  assert.equal(['127.0.0.1', 'localhost', '::1'].includes(url.hostname), true, 'auth tests must use loopback PostgreSQL');
  assert.equal(url.pathname, '/renivet_ci', 'auth tests must use renivet_ci');
  assert.equal(url.username, 'renivet_ci', 'auth tests must use the disposable CI role');
  assert.equal(url.protocol, 'postgresql:');
}

function assertDisposableRedis(value) {
  const url = new URL(value);
  assert.equal(['127.0.0.1', 'localhost', '::1'].includes(url.hostname), true, 'auth tests must use loopback Redis');
  assert.equal(url.protocol, 'redis:');
  assert.equal(url.pathname, '/15', 'auth tests must use the isolated disposable Redis database');
}

test('REN2-21 registration and password HTTP acceptance', { skip: enabled ? false : 'requires explicitly declared disposable PostgreSQL and Redis services', timeout: 120000 }, async () => {
  assertDisposableDatabase(databaseUrl);
  assertDisposableRedis(redisUrl);
  assert.equal(process.env.RENIVET_TEST_SERVICES_DISPOSABLE, '1', 'auth tests require explicitly declared disposable services');
  process.env.DATABASE_URL = databaseUrl;
  process.env.REDIS_URL = redisUrl;
  process.env.AUTH_RATE_LIMIT_HMAC_KEY = 'synthetic-integration-rate-key-not-a-secret-00000000';
  process.env.AUTH_CHALLENGE_HMAC_KEY = 'synthetic-integration-challenge-proof-key-not-a-secret-00000000';
  process.env.AUTH_CSRF_HMAC_KEY = 'synthetic-integration-csrf-key-not-a-secret-00000000';
  process.env.AUTH_MFA_ENCRYPTION_KEY = Buffer.alloc(32, 0x44).toString('base64');
  process.env.AUTH_ALLOWED_ORIGINS = 'http://127.0.0.1:3000';
  const fast2smsKeys = ['FAST2SMS_API_KEY', 'FAST2SMS_MESSAGE_ID', 'FAST2SMS_SENDER_ID', 'FAST2SMS_DLT_ENTITY_ID'];
  const priorFast2smsValues = Object.fromEntries(fast2smsKeys.map((key) => [key, process.env[key]]));
  process.env.FAST2SMS_API_KEY = 'synthetic-fast2sms-api-key-never-use-in-production';
  process.env.FAST2SMS_MESSAGE_ID = '1077206490123456789';
  process.env.FAST2SMS_SENDER_ID = 'RENIVT';
  process.env.FAST2SMS_DLT_ENTITY_ID = '1234567890123456789';
  const originalFetch = global.fetch;
  const providerRequests = [];
  global.fetch = async (input, init) => {
    if (String(input) === 'https://www.fast2sms.com/dev/bulkV2') {
      providerRequests.push({ url: String(input), ...init, payload: JSON.parse(init.body) });
      return new Response(JSON.stringify({ return: true, status_code: 200 }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return originalFetch(input, init);
  };

  const { NestFactory } = require('@nestjs/core');
  const { FastifyAdapter } = require('@nestjs/platform-fastify');
  const { PasswordHashService } = require('../dist/modules/identity/passwords');
  const { AppModule } = require('../dist/app.module');
  const pool = new Pool({ connectionString: databaseUrl });
  const redis = new Redis(redisUrl, { maxRetriesPerRequest: 1, connectTimeout: 1_000 });
  const namespace = `ren2-21-${randomUUID()}`;
  const registrationEmail = `${namespace}@example.test`;
  const postmanEmail = `postman-${namespace}@example.test`;
  const verifiedEmail = `verified-${namespace}@example.test`;
  const registrationPhone = `+91${randomInt(6_000_000_000, 10_000_000_000)}`;
  const registerPassword = 'pass1234';
  const verifiedPassword = 'verified-password-1234';
  const portServer = require('node:net').createServer();
  portServer.listen(0, '127.0.0.1');
  await once(portServer, 'listening');
  const port = portServer.address().port;
  await new Promise((resolve, reject) => portServer.close((error) => error ? reject(error) : resolve()));
  let app;
  let userId;
  try {
    const version = await pool.query('SHOW server_version_num');
    assert.ok(Number(version.rows[0].server_version_num) >= 160000 && Number(version.rows[0].server_version_num) < 170000, 'auth tests require disposable PostgreSQL 16');
    await redis.ping();

    const hash = await new PasswordHashService().hash(verifiedPassword);
    const seeded = await pool.query(
      `INSERT INTO identity.users (email, state, email_verified_at)
       VALUES ($1, 'active', now()) RETURNING id`,
      [verifiedEmail],
    );
    userId = seeded.rows[0].id;
    await pool.query(
      `INSERT INTO identity.user_credentials (user_id, password_hash, credential_version)
       VALUES ($1, $2, 1)`,
      [userId, hash],
    );

    app = await NestFactory.create(AppModule, new FastifyAdapter(), { logger: false });
    app.setGlobalPrefix('api/v1');
    await app.listen(port, '127.0.0.1');
    const base = `http://127.0.0.1:${port}/api/v1`;

    const expiredToken = 'E'.repeat(43);
    const absoluteExpiredToken = 'A'.repeat(43);
    await pool.query(
      `INSERT INTO identity.user_sessions (user_id, token_hash, created_at, expires_at, absolute_expires_at)
       VALUES ($1, $2, now() - interval '10 days', now() - interval '9 days', now() - interval '3 days'),
              ($1, $3, now() - interval '8 days', now() - interval '2 days', now() - interval '1 day')`,
      [userId, require('node:crypto').createHash('sha256').update(expiredToken).digest('hex'), require('node:crypto').createHash('sha256').update(absoluteExpiredToken).digest('hex')],
    );
    const idleExpired = await fetch(`${base}/auth/session`, { headers: { cookie: `__Host-renivet_session=${expiredToken}` } });
    const absoluteExpired = await fetch(`${base}/auth/session`, { headers: { cookie: `__Host-renivet_session=${absoluteExpiredToken}` } });
    assert.equal(idleExpired.status, 401, 'idle-expired session must not authenticate');
    assert.equal(absoluteExpired.status, 401, 'absolute-expired session must not authenticate');

    const registerPayload = { email: ` ${registrationEmail.toUpperCase()} `, password: registerPassword };
    const [firstRegistration, concurrentRegistration] = await Promise.all([
      fetch(`${base}/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(registerPayload) }),
      fetch(`${base}/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(registerPayload) }),
    ]);
    assert.equal(firstRegistration.status, 202, await firstRegistration.clone().text());
    assert.equal(concurrentRegistration.status, 202, await concurrentRegistration.clone().text());
    assert.deepEqual(await firstRegistration.json(), { status: 'accepted' });
    assert.deepEqual(await concurrentRegistration.json(), { status: 'accepted' });
    const registered = await pool.query('SELECT id, state, email_verified_at FROM identity.users WHERE email = $1', [registrationEmail]);
    assert.equal(registered.rowCount, 1, 'concurrent duplicate registration created more than one account');
    assert.equal(registered.rows[0].state, 'pending_verification');
    assert.equal(registered.rows[0].email_verified_at, null);
    const storedCredential = await pool.query('SELECT password_hash FROM identity.user_credentials WHERE user_id = $1 AND disabled_at IS NULL', [registered.rows[0].id]);
    assert.equal(storedCredential.rowCount, 1);
    assert.notEqual(storedCredential.rows[0].password_hash, registerPassword);

    const verifiedIdentityConflict = await fetch(`${base}/auth/register`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: verifiedEmail, password: registerPassword }),
    });
    assert.equal(verifiedIdentityConflict.status, 202);
    assert.deepEqual(await verifiedIdentityConflict.json(), { status: 'accepted' });
    const verifiedAfterConflict = await pool.query(
      `SELECT u.state, u.email_verified_at, c.password_hash
         FROM identity.users AS u
         JOIN identity.user_credentials AS c ON c.user_id = u.id AND c.disabled_at IS NULL
        WHERE u.id = $1`,
      [userId],
    );
    assert.equal(verifiedAfterConflict.rows[0].state, 'active');
    assert.ok(verifiedAfterConflict.rows[0].email_verified_at);
    assert.equal(await new PasswordHashService().verify(verifiedAfterConflict.rows[0].password_hash, verifiedPassword), true);
    assert.equal(await new PasswordHashService().verify(verifiedAfterConflict.rows[0].password_hash, registerPassword), false);

    const tooShort = await fetch(`${base}/auth/register`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: `invalid-${namespace}@example.test`, password: 'short' }),
    });
    assert.equal(tooShort.status, 400);
    assert.equal((await tooShort.json()).code, 'AUTH_INPUT_INVALID');

    const unknownLogin = await fetch(`${base}/auth/sessions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: `unknown-${namespace}@example.test`, password: verifiedPassword }),
    });
    const wrongPasswordLogin = await fetch(`${base}/auth/sessions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: verifiedEmail, password: registerPassword }),
    });
    const unverifiedLogin = await fetch(`${base}/auth/sessions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: registrationEmail, password: registerPassword }),
    });
    assert.equal(unknownLogin.status, 401);
    assert.equal(wrongPasswordLogin.status, 401);
    assert.equal(unverifiedLogin.status, 401);
    const unknownBody = await unknownLogin.json();
    const wrongBody = await wrongPasswordLogin.json();
    const unverifiedBody = await unverifiedLogin.json();
    assert.deepEqual({ code: unknownBody.code, message: unknownBody.message }, { code: wrongBody.code, message: wrongBody.message });
    assert.deepEqual({ code: unknownBody.code, message: unknownBody.message }, { code: unverifiedBody.code, message: unverifiedBody.message });
    assert.equal(JSON.stringify([unknownBody, wrongBody, unverifiedBody]).includes(verifiedEmail), false);

    const validLogin = await fetch(`${base}/auth/sessions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: verifiedEmail, password: verifiedPassword }),
    });
    assert.equal(validLogin.status, 200);
    assert.deepEqual(await validLogin.json(), { authenticationState: 'authenticated', user: { id: userId } });
    const cookie = validLogin.headers.get('set-cookie');
    assert.match(cookie, /^__Host-renivet_session=[A-Za-z0-9_-]{43}; Path=\/; Max-Age=1800; HttpOnly; Secure; SameSite=Lax$/);
    let sessionToken = cookie.split(';', 1)[0].split('=', 2)[1];
    const persistedSession = await pool.query('SELECT token_hash, ip_hash FROM identity.user_sessions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1', [userId]);
    assert.equal(persistedSession.rowCount, 1);
    assert.match(persistedSession.rows[0].token_hash, /^[a-f0-9]{64}$/);
    assert.notEqual(persistedSession.rows[0].token_hash, sessionToken);
    assert.match(persistedSession.rows[0].ip_hash, /^[a-f0-9]{64}$/);

    const priorToken = sessionToken;
    const rotatedLogin = await fetch(`${base}/auth/sessions`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: `__Host-renivet_session=${priorToken}` },
      body: JSON.stringify({ email: verifiedEmail, password: verifiedPassword }),
    });
    assert.equal(rotatedLogin.status, 200);
    sessionToken = rotatedLogin.headers.get('set-cookie').split(';', 1)[0].split('=', 2)[1];
    assert.notEqual(sessionToken, priorToken, 'login must rotate rather than reuse a presented session token');
    const staleSession = await fetch(`${base}/auth/session`, { headers: { cookie: `__Host-renivet_session=${priorToken}` } });
    assert.equal(staleSession.status, 401, 'rotated session secret must no longer authenticate');
    const activeSession = await fetch(`${base}/auth/session`, { headers: { cookie: `__Host-renivet_session=${sessionToken}` } });
    assert.equal(activeSession.status, 200);
    const refreshedCookie = activeSession.headers.get('set-cookie');
    assert.match(refreshedCookie, /^__Host-renivet_session=[A-Za-z0-9_-]{43}; Path=\/; Max-Age=(?:[1-9]\d{0,2}|1[0-7]\d{2}|1800); HttpOnly; Secure; SameSite=Lax$/);
    const csrfToken = (await activeSession.json()).csrfToken;

    const phoneNumber = '+919876543210';
    const phoneCookie = `__Host-renivet_session=${sessionToken}`;
    const unsafePhoneChange = await fetch(`${base}/auth/phone`, {
      method: 'POST', headers: { cookie: phoneCookie, 'content-type': 'application/json', origin: 'https://attacker.example.test', 'sec-fetch-site': 'cross-site', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ phone: phoneNumber }),
    });
    assert.equal(unsafePhoneChange.status, 403, 'cross-site phone changes must be rejected');
    assert.equal((await pool.query('SELECT phone FROM identity.users WHERE id=$1', [userId])).rows[0].phone, null);

    const phoneChange = await fetch(`${base}/auth/phone`, {
      method: 'POST', headers: { cookie: phoneCookie, 'content-type': 'application/json', origin: 'http://127.0.0.1:3000', 'sec-fetch-site': 'same-origin', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ phone: phoneNumber }),
    });
    assert.equal(phoneChange.status, 202, await phoneChange.clone().text());
    assert.deepEqual(await phoneChange.json(), { status: 'accepted', verificationRequired: true });
    const savedPhone = await pool.query('SELECT phone, phone_verified_at FROM identity.users WHERE id=$1', [userId]);
    assert.equal(savedPhone.rows[0].phone, phoneNumber);
    assert.equal(savedPhone.rows[0].phone_verified_at, null, 'attached contact remains unverified until OTP succeeds');

    const phoneChallenge = await fetch(`${base}/auth/challenges`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channel: 'phone', purpose: 'phone_verification', destination: phoneNumber }),
    });
    assert.equal(phoneChallenge.status, 202, await phoneChallenge.clone().text());
    const phoneChallengeBody = await phoneChallenge.json();
    assert.equal(providerRequests.length, 1, 'eligible phone challenge invokes only the fake Fast2SMS transport');
    assert.equal(providerRequests[0].url, 'https://www.fast2sms.com/dev/bulkV2');
    assert.deepEqual(providerRequests[0].payload, {
      sender_id: 'RENIVT', message: '1077206490123456789', variables_values: `${providerRequests[0].payload.variables_values.split('|')[0]}|5`, route: 'dlt', numbers: '9876543210',
    });
    const issuedCode = providerRequests[0].payload.variables_values.split('|')[0];
    assert.match(issuedCode, /^[0-9]{6}$/);
    const phoneVerification = await fetch(`${base}/auth/challenges/${phoneChallengeBody.challengeId}/verify`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ purpose: 'phone_verification', code: issuedCode }),
    });
    assert.equal(phoneVerification.status, 200, await phoneVerification.clone().text());
    assert.deepEqual(await phoneVerification.json(), { status: 'verified' });
    assert.ok((await pool.query('SELECT phone_verified_at FROM identity.users WHERE id=$1', [userId])).rows[0].phone_verified_at);

    const phoneRegistrationChallenge = await fetch(`${base}/auth/challenges`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channel: 'phone', purpose: 'phone_registration', destination: registrationPhone }),
    });
    assert.equal(phoneRegistrationChallenge.status, 202, await phoneRegistrationChallenge.clone().text());
    const phoneRegistrationChallengeBody = await phoneRegistrationChallenge.json();
    assert.equal(providerRequests.length, 2, 'phone-only registration sends one SMS through the fake provider');
    assert.equal(providerRequests[1].payload.numbers, registrationPhone.slice(3));
    const pendingPhoneAccount = await pool.query('SELECT id, state, email, phone_verified_at FROM identity.users WHERE phone = $1', [registrationPhone]);
    assert.equal(pendingPhoneAccount.rowCount, 1);
    assert.equal(pendingPhoneAccount.rows[0].state, 'pending_verification');
    assert.equal(pendingPhoneAccount.rows[0].email, null);
    assert.equal(pendingPhoneAccount.rows[0].phone_verified_at, null);
    assert.equal((await pool.query('SELECT 1 FROM identity.user_credentials WHERE user_id = $1', [pendingPhoneAccount.rows[0].id])).rowCount, 0, 'phone-only registration creates no password credential');
    const registrationCode = providerRequests[1].payload.variables_values.split('|')[0];
    const wrongRegistrationCode = await fetch(`${base}/auth/challenges/${phoneRegistrationChallengeBody.challengeId}/verify`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ purpose: 'phone_registration', code: registrationCode === '000000' ? '000001' : '000000' }),
    });
    assert.equal(wrongRegistrationCode.status, 401);
    assert.equal((await pool.query('SELECT state, phone_verified_at FROM identity.users WHERE id = $1', [pendingPhoneAccount.rows[0].id])).rows[0].state, 'pending_verification', 'wrong code does not activate account');
    const [registrationVerifyOne, registrationVerifyTwo] = await Promise.all([1, 2].map(() => fetch(`${base}/auth/challenges/${phoneRegistrationChallengeBody.challengeId}/verify`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ purpose: 'phone_registration', code: registrationCode }),
    })));
    assert.equal([registrationVerifyOne.status, registrationVerifyTwo.status].filter((status) => status === 200).length, 1, 'concurrent registration challenge authenticates exactly once');
    assert.ok([registrationVerifyOne.status, registrationVerifyTwo.status].every((status) => status === 200 || status === 401 || status === 429), 'the losing concurrent registration receives only a denial or rate limit');
    const successfulRegistration = registrationVerifyOne.status === 200 ? registrationVerifyOne : registrationVerifyTwo;
    assert.deepEqual(await successfulRegistration.json(), { authenticationState: 'authenticated', user: { id: pendingPhoneAccount.rows[0].id } });
    const registrationCookie = successfulRegistration.headers.get('set-cookie');
    assert.match(registrationCookie, /^__Host-renivet_session=[A-Za-z0-9_-]{43}; Path=\/; Max-Age=1800; HttpOnly; Secure; SameSite=Lax$/);
    const phoneAccountAfterRegistration = await pool.query('SELECT state, phone_verified_at FROM identity.users WHERE id=$1', [pendingPhoneAccount.rows[0].id]);
    assert.equal(phoneAccountAfterRegistration.rows[0].state, 'active');
    assert.ok(phoneAccountAfterRegistration.rows[0].phone_verified_at);
    const registrationSessionToken = registrationCookie.split(';', 1)[0].split('=', 2)[1];
    assert.equal((await fetch(`${base}/auth/session`, { headers: { cookie: `__Host-renivet_session=${registrationSessionToken}` } })).status, 200, 'new phone account session is valid immediately');
    const replayRegistration = await fetch(`${base}/auth/challenges/${phoneRegistrationChallengeBody.challengeId}/verify`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ purpose: 'phone_registration', code: registrationCode }),
    });
    assert.equal(replayRegistration.status, 401, 'a consumed registration code cannot be replayed');

    const existingPhoneRegistration = await fetch(`${base}/auth/challenges`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channel: 'phone', purpose: 'phone_registration', destination: phoneNumber }),
    });
    assert.equal(existingPhoneRegistration.status, 202, 'existing phone receives the same accepted response');
    const existingPhoneChallenge = await existingPhoneRegistration.json();
    assert.equal(providerRequests.length, 2, 'existing account phone receives no registration SMS');
    const deniedExistingPhone = await fetch(`${base}/auth/challenges/${existingPhoneChallenge.challengeId}/verify`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ purpose: 'phone_registration', code: registrationCode }),
    });
    assert.equal(deniedExistingPhone.status, 401, 'existing account phone cannot be taken over through registration');

    const crossSiteLogout = await fetch(`${base}/auth/session`, {
      method: 'DELETE', headers: {
        cookie: `__Host-renivet_session=${sessionToken}`, origin: 'https://attacker.example.test',
        'sec-fetch-site': 'cross-site', 'x-csrf-token': csrfToken,
      },
    });
    assert.equal(crossSiteLogout.status, 403);
    assert.equal((await crossSiteLogout.json()).code, 'CSRF_VALIDATION_FAILED');
    const stillActive = await fetch(`${base}/auth/session`, { headers: { cookie: `__Host-renivet_session=${sessionToken}` } });
    assert.equal(stillActive.status, 200, 'CSRF denial must not revoke a valid session');
    const logout = await fetch(`${base}/auth/session`, {
      method: 'DELETE', headers: {
        cookie: `__Host-renivet_session=${sessionToken}`, origin: 'http://127.0.0.1:3000',
        'sec-fetch-site': 'same-origin', 'x-csrf-token': csrfToken,
      },
    });
    assert.equal(logout.status, 200, await logout.clone().text());
    assert.match(logout.headers.get('set-cookie'), /^__Host-renivet_session=; Path=\/; Max-Age=0; HttpOnly; Secure; SameSite=Lax$/);
    const loggedOutSession = await fetch(`${base}/auth/session`, { headers: { cookie: `__Host-renivet_session=${sessionToken}` } });
    assert.equal(loggedOutSession.status, 401, 'server-revoked logout cookie must no longer authenticate');
    const revoked = await pool.query('SELECT revoked_at FROM identity.user_sessions WHERE token_hash = $1', [require('node:crypto').createHash('sha256').update(sessionToken).digest('hex')]);
    assert.ok(revoked.rows[0].revoked_at);

    const postmanEnvironment = { ...process.env };
    delete postmanEnvironment.POSTMAN_API_KEY;
    for (const key of Object.keys(postmanEnvironment)) {
      if (/^(https?_proxy|all_proxy)$/i.test(key)) delete postmanEnvironment[key];
    }
    postmanEnvironment.NO_PROXY = 'localhost,127.0.0.1,::1';
    postmanEnvironment.no_proxy = postmanEnvironment.NO_PROXY;
    const postmanArguments = [
      'run', 'postman/collections/renivet-backend-auth.postman_collection.json',
      '--env-var', `apiBaseUrl=${base}`,
      '--env-var', `syntheticEmail=${postmanEmail}`,
      '--env-var', 'syntheticPassword=synthetic-postman-passphrase',
      '--env-var', `verifiedEmail=${verifiedEmail}`,
      '--env-var', `verifiedPassword=${verifiedPassword}`,
      '--env-var', `wrongPassword=${registerPassword}`,
      '--env-var', `unknownEmail=unknown-${namespace}@example.test`,
      '--env-var', 'allowedOrigin=http://127.0.0.1:3000',
      '--reporters', 'cli',
      '--timeout-request', '10000',
      '--timeout', '45000',
    ];
    const postmanRun = await new Promise((resolve, reject) => {
      const cli = spawn('newman', postmanArguments, {
        env: postmanEnvironment,
        windowsHide: true,
        shell: process.platform === 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      cli.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
      cli.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
      const timer = setTimeout(() => {
        cli.kill();
        reject(new Error(`Postman CLI timed out.\n${stdout}\n${stderr}`));
      }, 45_000);
      cli.once('error', (error) => {
        clearTimeout(timer);
        reject(new Error(`Postman CLI could not start: ${error.message}`));
      });
      cli.once('close', (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr });
      });
    });
    assert.equal(postmanRun.code, 0, `Newman collection failed:\n${postmanRun.stdout}\n${postmanRun.stderr}`);
    assert.match(postmanRun.stdout, /assertions/i);

    const rateLimitEmail = `rate-limit-${namespace}@example.test`;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const denied = await fetch(`${base}/auth/sessions`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: rateLimitEmail, password: registerPassword }),
      });
      assert.equal(denied.status, 401);
    }
    const limited = await fetch(`${base}/auth/sessions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: rateLimitEmail, password: registerPassword }),
    });
    assert.equal(limited.status, 429);
    assert.equal((await limited.json()).code, 'AUTH_RATE_LIMITED');
    assert.ok(limited.headers.get('retry-after'));

    const { IdentityRepository } = require('../dist/modules/identity/identity.repository');
    const raceCredential = await pool.query('SELECT id, password_hash FROM identity.user_credentials WHERE user_id = $1 AND disabled_at IS NULL', [userId]);
    const recoveryLock = await pool.connect();
    await recoveryLock.query('BEGIN');
    const lockPid = (await recoveryLock.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    await recoveryLock.query('SELECT id FROM identity.users WHERE id = $1 FOR UPDATE', [userId]);
    const raceTokenHash = require('node:crypto').createHash('sha256').update(`synthetic-login-race-${namespace}`).digest('hex');
    const racingLogin = new IdentityRepository({ pool }).createSession({
      userId,
      credentialId: raceCredential.rows[0].id,
      expectedPasswordHash: raceCredential.rows[0].password_hash,
      tokenHash: raceTokenHash,
      expiresAt: new Date(Date.now() + 1_800_000),
      ipHash: '0'.repeat(64),
    });
    let recoveryBlockedLogin = false;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const waiting = await pool.query('SELECT count(*)::integer AS count FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))', [lockPid]);
      if (waiting.rows[0].count > 0) { recoveryBlockedLogin = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(recoveryBlockedLogin, true, 'login session creation must wait behind a recovery user-row lock');
    const replacementHash = await new PasswordHashService().hash('synthetic password after recovery');
    await recoveryLock.query(
      `UPDATE identity.user_credentials SET password_hash = $2, credential_version = credential_version + 1, updated_at = now()
        WHERE user_id = $1 AND disabled_at IS NULL`,
      [userId, replacementHash],
    );
    await recoveryLock.query('UPDATE identity.user_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [userId]);
    await recoveryLock.query('COMMIT');
    recoveryLock.release();
    assert.equal(await racingLogin, false, 'login verified before recovery must not create a session after recovery commits');
    assert.equal((await pool.query('SELECT 1 FROM identity.user_sessions WHERE token_hash = $1', [raceTokenHash])).rowCount, 0);
  } finally {
    global.fetch = originalFetch;
    for (const key of fast2smsKeys) {
      if (priorFast2smsValues[key] === undefined) delete process.env[key];
      else process.env[key] = priorFast2smsValues[key];
    }
    await app?.close();
    await pool.query('DELETE FROM identity.security_audit_events WHERE actor_user_id IN (SELECT id FROM identity.users WHERE email = ANY($1::text[]))', [[registrationEmail, postmanEmail, verifiedEmail]]).catch(() => {});
    await pool.query('DELETE FROM identity.mfa_recovery_codes WHERE factor_id IN (SELECT factor.id FROM identity.mfa_factors AS factor JOIN identity.users AS account ON account.id = factor.user_id WHERE account.email = ANY($1::text[]))', [[registrationEmail, postmanEmail, verifiedEmail]]).catch(() => {});
    await pool.query('DELETE FROM identity.mfa_factors WHERE user_id IN (SELECT id FROM identity.users WHERE email = ANY($1::text[]))', [[registrationEmail, postmanEmail, verifiedEmail]]).catch(() => {});
    await pool.query('DELETE FROM identity.user_sessions WHERE user_id IN (SELECT id FROM identity.users WHERE email = ANY($1::text[]))', [[registrationEmail, postmanEmail, verifiedEmail]]).catch(() => {});
    await pool.query('DELETE FROM identity.user_credentials WHERE user_id IN (SELECT id FROM identity.users WHERE email = ANY($1::text[]))', [[registrationEmail, postmanEmail, verifiedEmail]]).catch(() => {});
    await pool.query('DELETE FROM identity.users WHERE email = ANY($1::text[])', [[registrationEmail, postmanEmail, verifiedEmail]]).catch(() => {});
    await pool.query(`DELETE FROM identity.auth_challenges WHERE user_id IN (SELECT id FROM identity.users WHERE phone = $1)`, [registrationPhone]).catch(() => {});
    await pool.query(`DELETE FROM identity.user_sessions WHERE user_id IN (SELECT id FROM identity.users WHERE phone = $1)`, [registrationPhone]).catch(() => {});
    await pool.query('DELETE FROM identity.users WHERE phone = $1', [registrationPhone]).catch(() => {});
    await pool.end();
    await redis.quit().catch(() => redis.disconnect());
  }
});
