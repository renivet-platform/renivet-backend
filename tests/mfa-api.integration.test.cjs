'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createHash, createHmac, randomBytes, randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const { totpCode } = require('../dist/modules/identity/mfa-crypto');
const { MfaGuard } = require('../dist/common/guards/require-mfa');
const { SessionService } = require('../dist/modules/identity/session.service');
const { MfaService } = require('../dist/modules/identity/mfa.service');

function base32Decode(value) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let accumulator = 0;
  const output = [];
  for (const character of value) {
    accumulator = (accumulator << 5) | alphabet.indexOf(character);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      output.push((accumulator >>> bits) & 0xff);
    }
  }
  return Buffer.from(output);
}

function cookieToken(response) {
  const cookie = response.headers.get('set-cookie');
  assert.ok(cookie, 'response must set or expire the opaque session cookie');
  return cookie.split(';', 1)[0].split('=', 2)[1];
}

function csrfFor(token) {
  return createHmac('sha256', process.env.AUTH_CSRF_HMAC_KEY).update(`renivet-csrf-v1\0${token}`).digest('base64url');
}

test('REN2-24 MFA API enrolls, rejects invalid/replayed factors, rotates sessions, consumes recovery once and revokes safely', { timeout: 60_000, skip: process.env.RENIVET_TEST_SERVICES_DISPOSABLE !== '1' }, async () => {
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL = process.env.RENIVET_TEST_DATABASE_URL;
  process.env.REDIS_URL = process.env.RENIVET_TEST_REDIS_URL;
  process.env.AUTH_RATE_LIMIT_HMAC_KEY = 'synthetic-ren2-24-rate-key-not-a-secret-000000000000';
  process.env.AUTH_CHALLENGE_HMAC_KEY = 'synthetic-ren2-24-challenge-key-not-a-secret-00000000';
  process.env.AUTH_CSRF_HMAC_KEY = 'synthetic-ren2-24-csrf-key-not-a-secret-00000000000000';
  process.env.AUTH_MFA_ENCRYPTION_KEY = Buffer.alloc(32, 0x44).toString('base64');
  process.env.AUTH_ALLOWED_ORIGINS = 'http://127.0.0.1:3000';

  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3, connectionTimeoutMillis: 5_000 });
  const { NestFactory } = require('@nestjs/core');
  const { FastifyAdapter } = require('@nestjs/platform-fastify');
  const { AppModule } = require('../dist/app.module');
  const app = await NestFactory.create(AppModule, new FastifyAdapter(), { logger: false });
  app.setGlobalPrefix('api/v1');
  await app.listen(0, '127.0.0.1');
  const userId = randomUUID();
  const initialToken = randomBytes(32).toString('base64url');
  const initialTokenHash = createHash('sha256').update(initialToken).digest('hex');
  let enrollmentToken;
  let stepUpToken;
  let recoveryStepUpToken;
  let revokedFixtureUserId;
  let revokedFixtureFactorId;
  try {
    await pool.query(
      `INSERT INTO identity.users (id, email, state, email_verified_at)
       VALUES ($1, $2, 'active', clock_timestamp())`,
      [userId, `${userId}@example.test`],
    );
    await pool.query(
      `INSERT INTO identity.user_sessions
        (user_id, token_hash, expires_at, absolute_expires_at)
       VALUES ($1, $2, clock_timestamp() + interval '30 minutes', clock_timestamp() + interval '7 days')`,
      [userId, initialTokenHash],
    );
    const base = await app.getUrl();
    const noSession = await fetch(`${base}/api/v1/auth/mfa`);
    assert.equal(noSession.status, 401);
    assert.equal((await noSession.json()).code, 'AUTHENTICATION_FAILED');

    const cookie = `__Host-renivet_session=${initialToken}`;
    const statusResponse = await fetch(`${base}/api/v1/auth/mfa`, { headers: { cookie } });
    assert.equal(statusResponse.status, 200);
    assert.deepEqual(await statusResponse.json(), { state: 'not_enrolled', recoveryCodesRemaining: 0 });
    assert.equal(statusResponse.headers.get('cache-control'), 'no-store');

    const missingCsrf = await fetch(`${base}/api/v1/auth/mfa/enrollments`, { method: 'POST', headers: { cookie } });
    assert.equal(missingCsrf.status, 403);
    assert.equal((await missingCsrf.json()).code, 'CSRF_VALIDATION_FAILED');

    const origin = 'http://127.0.0.1:3000';
    const mutationHeaders = (token, json = true) => ({
      cookie: `__Host-renivet_session=${token}`,
      origin,
      'sec-fetch-site': 'same-origin',
      'x-csrf-token': csrfFor(token),
      ...(json ? { 'content-type': 'application/json' } : {}),
    });
    const begin = await fetch(`${base}/api/v1/auth/mfa/enrollments`, {
      method: 'POST', headers: mutationHeaders(initialToken, false),
    });
    const beginBodyText = await begin.text();
    assert.equal(begin.status, 200, beginBodyText);
    assert.equal(begin.headers.get('cache-control'), 'no-store');
    const enrollment = JSON.parse(beginBodyText);
    assert.equal(enrollment.state, 'enrollment_pending');
    assert.equal(enrollment.expiresInSeconds, 600);
    const setup = new URL(enrollment.provisioningUri);
    assert.equal(setup.protocol, 'otpauth:');
    assert.equal(setup.searchParams.get('issuer'), 'Renivet');
    const secret = base32Decode(setup.searchParams.get('secret'));

    const pendingStatus = await fetch(`${base}/api/v1/auth/mfa`, { headers: { cookie } });
    const pendingBody = await pendingStatus.json();
    assert.deepEqual(pendingBody, { state: 'enrollment_pending', recoveryCodesRemaining: 0 });
    assert.equal(JSON.stringify(pendingBody).includes(setup.searchParams.get('secret')), false);

    const now = Date.now();
    const currentStep = Math.floor(now / 30_000);
    const validEnrollCode = totpCode(secret, now);
    const acceptedCodes = new Set([currentStep - 1, currentStep, currentStep + 1].map((step) => totpCode(secret, step * 30_000)));
    let invalidCode = '000000';
    while (acceptedCodes.has(invalidCode)) invalidCode = String((Number(invalidCode) + 1) % 1_000_000).padStart(6, '0');
    const invalidEnrollment = await fetch(`${base}/api/v1/auth/mfa/enrollments/verify`, {
      method: 'POST', headers: mutationHeaders(initialToken), body: JSON.stringify({ code: invalidCode }),
    });
    assert.equal(invalidEnrollment.status, 401);
    assert.equal((await invalidEnrollment.json()).code, 'AUTH_MFA_PROOF_INVALID');

    const activated = await fetch(`${base}/api/v1/auth/mfa/enrollments/verify`, {
      method: 'POST', headers: mutationHeaders(initialToken), body: JSON.stringify({ code: validEnrollCode }),
    });
    assert.equal(activated.status, 200);
    assert.equal(activated.headers.get('cache-control'), 'no-store');
    const activatedBody = await activated.json();
    assert.equal(activatedBody.state, 'enabled');
    assert.equal(activatedBody.recoveryCodes.length, 10);
    assert.ok(activatedBody.recoveryCodes.every((code) => /^[A-Z2-7]{26}$/.test(code)));
    enrollmentToken = cookieToken(activated);
    assert.notEqual(enrollmentToken, initialToken);
    assert.equal(activatedBody.csrfToken, csrfFor(enrollmentToken));
    const staleEnrollmentSession = await fetch(`${base}/api/v1/auth/mfa`, { headers: { cookie } });
    assert.equal(staleEnrollmentSession.status, 401);

    const enabledStatus = await fetch(`${base}/api/v1/auth/mfa`, { headers: { cookie: `__Host-renivet_session=${enrollmentToken}` } });
    const enabledBody = await enabledStatus.json();
    assert.deepEqual(enabledBody, { state: 'enabled', recoveryCodesRemaining: 10 });
    assert.equal(JSON.stringify(enabledBody).includes(setup.searchParams.get('secret')), false);

    const factorRow = await pool.query('SELECT id, encrypted_secret, secret_iv, secret_tag, last_totp_step FROM identity.mfa_factors WHERE user_id=$1 AND state=\'active\'', [userId]);
    assert.equal(factorRow.rowCount, 1);
    assert.notEqual(factorRow.rows[0].encrypted_secret, setup.searchParams.get('secret'));
    assert.equal(factorRow.rows[0].last_totp_step, BigInt(currentStep).toString());
    const codeRows = await pool.query('SELECT code_hash FROM identity.mfa_recovery_codes WHERE factor_id=$1', [factorRow.rows[0].id]);
    assert.equal(codeRows.rowCount, 10);
    assert.equal(codeRows.rows.some((row) => activatedBody.recoveryCodes.includes(row.code_hash)), false);

    const invalidStepUp = await fetch(`${base}/api/v1/auth/mfa/step-up`, {
      method: 'POST', headers: mutationHeaders(enrollmentToken), body: JSON.stringify({ code: invalidCode }),
    });
    assert.equal(invalidStepUp.status, 401);
    assert.equal((await invalidStepUp.json()).code, 'AUTH_MFA_PROOF_INVALID');
    const replayedEnrollmentCode = await fetch(`${base}/api/v1/auth/mfa/step-up`, {
      method: 'POST', headers: mutationHeaders(enrollmentToken), body: JSON.stringify({ code: validEnrollCode }),
    });
    assert.equal(replayedEnrollmentCode.status, 401);

    const nextStepCode = totpCode(secret, (Math.floor(Date.now() / 30_000) + 1) * 30_000);
    const stepUp = await fetch(`${base}/api/v1/auth/mfa/step-up`, {
      method: 'POST', headers: mutationHeaders(enrollmentToken), body: JSON.stringify({ code: nextStepCode }),
    });
    assert.equal(stepUp.status, 200);
    const stepUpBody = await stepUp.json();
    stepUpToken = cookieToken(stepUp);
    assert.notEqual(stepUpToken, enrollmentToken);
    assert.equal(stepUpBody.authenticationState, 'elevated');
    assert.equal(stepUpBody.csrfToken, csrfFor(stepUpToken));

    // There are no business/admin handlers in this foundation. Exercise the real
    // reusable guard against a test-only action context and its real PostgreSQL audit sink.
    const guard = new MfaGuard({ get: () => 'staff.manage' }, app.get(SessionService), app.get(MfaService));
    const actionContext = (token) => {
      const request = {
        headers: { cookie: `__Host-renivet_session=${token}` },
        body: { role: 'renivet_admin', mfaVerifiedAt: new Date().toISOString() },
        ip: '127.0.0.1',
      };
      return {
        request,
        context: {
          getHandler: () => ({}), getClass: () => ({}),
          switchToHttp: () => ({ getRequest: () => request }),
        },
      };
    };
    // Step-up rotates and revokes its input session, so create a separate,
    // active ordinary session with no persisted MFA timestamp for the denial case.
    const unElevatedToken = randomBytes(32).toString('base64url');
    await pool.query(
      `INSERT INTO identity.user_sessions
        (user_id, token_hash, expires_at, absolute_expires_at)
       VALUES ($1, $2, clock_timestamp() + interval '30 minutes', clock_timestamp() + interval '7 days')`,
      [userId, createHash('sha256').update(unElevatedToken).digest('hex')],
    );
    const unElevatedAction = actionContext(unElevatedToken);
    await assert.rejects(
      guard.canActivate(unElevatedAction.context),
      (error) => error.getStatus() === 403,
      'T-AZ-09/T-ID-09: client-supplied admin and MFA claims cannot bypass persisted step-up',
    );
    assert.equal(unElevatedAction.request.authSession, undefined, 'Denied privileged action receives no authenticated elevated context');
    const elevatedAction = actionContext(stepUpToken);
    assert.equal(await guard.canActivate(elevatedAction.context), true, 'A fresh server-side MFA step-up permits the guarded test action');
    assert.equal(elevatedAction.request.authSession.userId, userId);
    assert.match(elevatedAction.request.authSession.sessionId, /^[0-9a-f-]{36}$/i);

    const recoveryCode = activatedBody.recoveryCodes[0];
    const recoveryStepUp = await fetch(`${base}/api/v1/auth/mfa/step-up`, {
      method: 'POST', headers: mutationHeaders(stepUpToken), body: JSON.stringify({ code: recoveryCode }),
    });
    assert.equal(recoveryStepUp.status, 200);
    recoveryStepUpToken = cookieToken(recoveryStepUp);
    assert.notEqual(recoveryStepUpToken, stepUpToken);
    const replayedRecovery = await fetch(`${base}/api/v1/auth/mfa/step-up`, {
      method: 'POST', headers: mutationHeaders(recoveryStepUpToken), body: JSON.stringify({ code: recoveryCode }),
    });
    assert.equal(replayedRecovery.status, 401);

    const revoked = await fetch(`${base}/api/v1/auth/mfa/factor`, {
      method: 'DELETE', headers: mutationHeaders(recoveryStepUpToken, false),
    });
    assert.equal(revoked.status, 200);
    assert.equal((await revoked.json()).status, 'revoked');
    assert.match(revoked.headers.get('set-cookie'), /Max-Age=0/);
    const revokedFactor = await pool.query('SELECT state, encrypted_secret, secret_iv, secret_tag FROM identity.mfa_factors WHERE id=$1', [factorRow.rows[0].id]);
    assert.deepEqual(revokedFactor.rows[0], { state: 'revoked', encrypted_secret: '', secret_iv: '', secret_tag: '' });
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM identity.mfa_recovery_codes WHERE factor_id=$1 AND consumed_at IS NULL', [factorRow.rows[0].id])).rows[0].count, 0);
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM identity.user_sessions WHERE user_id=$1 AND revoked_at IS NULL', [userId])).rows[0].count, 0);
    const audit = await pool.query('SELECT event_name, outcome, metadata::text AS metadata FROM identity.security_audit_events WHERE actor_user_id=$1 ORDER BY created_at, id', [userId]);
    assert.ok(audit.rows.some((row) => row.event_name === 'step_up_denied' && row.outcome === 'denied'));
    assert.ok(audit.rows.some((row) => row.event_name === 'factor_revoked' && row.outcome === 'allowed'));
    assert.ok(audit.rows.some((row) => row.event_name === 'privileged_access_denied' && row.outcome === 'denied' && row.metadata.includes('staff.manage')));
    assert.ok(audit.rows.some((row) => row.event_name === 'privileged_access_allowed' && row.outcome === 'allowed' && row.metadata.includes('staff.manage')));
    const factorMaterial = [setup.searchParams.get('secret'), validEnrollCode, nextStepCode, ...activatedBody.recoveryCodes];
    for (const material of factorMaterial) {
      assert.equal(audit.rows.some((row) => row.metadata.includes(material)), false);
    }
    for (const token of [initialToken, enrollmentToken, stepUpToken, recoveryStepUpToken, unElevatedToken]) {
      assert.equal(audit.rows.some((row) => row.metadata.includes(token)), false, 'Privileged decision audit excludes raw session secrets');
    }

    revokedFixtureUserId = randomUUID();
    revokedFixtureFactorId = randomUUID();
    const revokedFixtureToken = randomBytes(32).toString('base64url');
    await pool.query(
      `INSERT INTO identity.users (id, email, state, email_verified_at)
       VALUES ($1, $2, 'active', clock_timestamp())`,
      [revokedFixtureUserId, `${revokedFixtureUserId}@example.test`],
    );
    await pool.query(
      `INSERT INTO identity.user_sessions (user_id, token_hash, expires_at, absolute_expires_at)
       VALUES ($1, $2, clock_timestamp() + interval '30 minutes', clock_timestamp() + interval '7 days')`,
      [revokedFixtureUserId, createHash('sha256').update(revokedFixtureToken).digest('hex')],
    );
    await pool.query(
      `INSERT INTO identity.mfa_factors (id, user_id, encrypted_secret, secret_iv, secret_tag, state, revoked_at)
       VALUES ($1, $2, '', '', '', 'revoked', clock_timestamp())`,
      [revokedFixtureFactorId, revokedFixtureUserId],
    );
    const revokedFactorStepUp = await fetch(`${base}/api/v1/auth/mfa/step-up`, {
      method: 'POST', headers: mutationHeaders(revokedFixtureToken), body: JSON.stringify({ code: validEnrollCode }),
    });
    assert.equal(revokedFactorStepUp.status, 401);
    const revokedFactorBody = await revokedFactorStepUp.json();
    assert.equal(revokedFactorBody.code, 'AUTH_MFA_PROOF_INVALID');
    assert.equal(JSON.stringify(revokedFactorBody).includes(validEnrollCode), false);
    assert.ok((await pool.query(
      `SELECT 1 FROM identity.security_audit_events
        WHERE actor_user_id=$1 AND event_name='step_up_denied' AND outcome='denied'`,
      [revokedFixtureUserId],
    )).rowCount);
  } finally {
    if (revokedFixtureUserId) {
      await pool.query('DELETE FROM identity.security_audit_events WHERE actor_user_id=$1', [revokedFixtureUserId]).catch(() => undefined);
      await pool.query('DELETE FROM identity.user_sessions WHERE user_id=$1', [revokedFixtureUserId]).catch(() => undefined);
      await pool.query('DELETE FROM identity.mfa_factors WHERE id=$1', [revokedFixtureFactorId]).catch(() => undefined);
      await pool.query('DELETE FROM identity.users WHERE id=$1', [revokedFixtureUserId]).catch(() => undefined);
    }
    await pool.query('DELETE FROM identity.security_audit_events WHERE actor_user_id=$1', [userId]).catch(() => undefined);
    await pool.query('DELETE FROM identity.mfa_recovery_codes WHERE factor_id IN (SELECT id FROM identity.mfa_factors WHERE user_id=$1)', [userId]).catch(() => undefined);
    await pool.query('DELETE FROM identity.user_sessions WHERE user_id=$1', [userId]).catch(() => undefined);
    await pool.query('DELETE FROM identity.mfa_factors WHERE user_id=$1', [userId]).catch(() => undefined);
    await pool.query('DELETE FROM identity.users WHERE id=$1', [userId]).catch(() => undefined);
    await app.close();
    await pool.end();
  }
});
