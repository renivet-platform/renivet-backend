'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
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
  const registerPassword = 'synthetic registration passphrase';
  const verifiedPassword = 'synthetic verified passphrase';
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
    const sessionToken = cookie.split(';', 1)[0].split('=', 2)[1];
    const persistedSession = await pool.query('SELECT token_hash, ip_hash FROM identity.user_sessions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1', [userId]);
    assert.equal(persistedSession.rowCount, 1);
    assert.match(persistedSession.rows[0].token_hash, /^[a-f0-9]{64}$/);
    assert.notEqual(persistedSession.rows[0].token_hash, sessionToken);
    assert.match(persistedSession.rows[0].ip_hash, /^[a-f0-9]{64}$/);

    const postmanEnvironment = { ...process.env };
    delete postmanEnvironment.POSTMAN_API_KEY;
    for (const key of Object.keys(postmanEnvironment)) {
      if (/^(https?_proxy|all_proxy)$/i.test(key)) delete postmanEnvironment[key];
    }
    postmanEnvironment.NO_PROXY = 'localhost,127.0.0.1,::1';
    postmanEnvironment.no_proxy = postmanEnvironment.NO_PROXY;
    const postmanArguments = [
      'collection', 'run', 'postman/collections/renivet-backend-auth.postman_collection.json',
      '--env-var', `apiBaseUrl=${base}`,
      '--env-var', `syntheticEmail=${postmanEmail}`,
      '--env-var', 'syntheticPassword=synthetic Postman registration passphrase',
      '--env-var', `verifiedEmail=${verifiedEmail}`,
      '--env-var', `verifiedPassword=${verifiedPassword}`,
      '--env-var', `wrongPassword=${registerPassword}`,
      '--env-var', `unknownEmail=unknown-${namespace}@example.test`,
      '--reporters', 'cli',
      '--report-events=false',
      '--timeout-request', '10000',
      '--timeout', '45000',
    ];
    const postmanRun = await new Promise((resolve, reject) => {
      const cli = spawn('postman', postmanArguments, {
        env: postmanEnvironment,
        windowsHide: true,
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
    assert.equal(postmanRun.code, 0, `Postman CLI collection failed:\n${postmanRun.stdout}\n${postmanRun.stderr}`);
    assert.match(postmanRun.stdout, /assertions/i);

    for (let attempt = 0; attempt < 1; attempt += 1) {
      const denied = await fetch(`${base}/auth/sessions`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: verifiedEmail, password: registerPassword }),
      });
      assert.equal(denied.status, 401);
    }
    const limited = await fetch(`${base}/auth/sessions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: verifiedEmail, password: registerPassword }),
    });
    assert.equal(limited.status, 429);
    assert.equal((await limited.json()).code, 'AUTH_RATE_LIMITED');
    assert.ok(limited.headers.get('retry-after'));
  } finally {
    await app?.close();
    await pool.query('DELETE FROM identity.user_sessions WHERE user_id IN (SELECT id FROM identity.users WHERE email = ANY($1::text[]))', [[registrationEmail, postmanEmail, verifiedEmail]]).catch(() => {});
    await pool.query('DELETE FROM identity.user_credentials WHERE user_id IN (SELECT id FROM identity.users WHERE email = ANY($1::text[]))', [[registrationEmail, postmanEmail, verifiedEmail]]).catch(() => {});
    await pool.query('DELETE FROM identity.users WHERE email = ANY($1::text[])', [[registrationEmail, postmanEmail, verifiedEmail]]).catch(() => {});
    await pool.end();
    await redis.quit().catch(() => redis.disconnect());
  }
});
