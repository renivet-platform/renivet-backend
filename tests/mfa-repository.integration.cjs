'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createHash, randomUUID } = require('node:crypto');
const { Pool } = require('pg');

test('MFA repository atomically prevents replay, consumes recovery once, preserves session expiry and wipes revoked factors', {
  timeout: 30_000,
  skip: !process.env.RENIVET_TEST_DATABASE_URL || process.env.RENIVET_TEST_SERVICES_DISPOSABLE !== '1',
}, async () => {
  const { MfaRepository } = require('../dist/modules/identity/mfa.repository');
  const pool = new Pool({ connectionString: process.env.RENIVET_TEST_DATABASE_URL, max: 4, connectionTimeoutMillis: 5_000 });
  const userId = randomUUID();
  const factorId = randomUUID();
  const firstTokenHash = createHash('sha256').update(randomUUID()).digest('hex');
  const activatedTokenHash = createHash('sha256').update(randomUUID()).digest('hex');
  const newTokenHash = createHash('sha256').update(randomUUID()).digest('hex');
  const recoveryTokenHash = createHash('sha256').update(randomUUID()).digest('hex');
  const exhaustedRecoveryTokenHash = createHash('sha256').update(randomUUID()).digest('hex');
  const consumedRecoveryHash = 'a'.repeat(64);
  const remainingRecoveryHash = 'b'.repeat(64);
  const encryptedSecret = Buffer.alloc(20, 0x51).toString('base64');
  const secretIv = Buffer.alloc(12, 0x12).toString('base64');
  const secretTag = Buffer.alloc(16, 0x21).toString('base64');
  const ipHash = 'c'.repeat(64);
  const repository = new MfaRepository({ pool });

  try {
    await pool.query(
      `INSERT INTO identity.users (id, email, state, email_verified_at)
       VALUES ($1, $2, 'active', clock_timestamp())`,
      [userId, `${userId}@example.test`],
    );
    await pool.query(
      `INSERT INTO identity.user_sessions
        (user_id, token_hash, expires_at, absolute_expires_at, ip_hash)
       VALUES ($1, $2, clock_timestamp() + interval '30 minutes', clock_timestamp() + interval '7 days', $3)`,
      [userId, firstTokenHash, ipHash],
    );

    assert.equal(await repository.beginEnrollment({
      factorId, userId, encryptedSecret, secretIv, secretTag,
      pendingExpiresAt: new Date(Date.now() + 600_000), ipHash, sessionId: (await pool.query('SELECT id FROM identity.user_sessions WHERE token_hash=$1', [firstTokenHash])).rows[0].id,
    }), true);
    assert.equal(await repository.beginEnrollment({
      factorId: randomUUID(), userId, encryptedSecret, secretIv, secretTag,
      pendingExpiresAt: new Date(Date.now() + 600_000), ipHash, sessionId: (await pool.query('SELECT id FROM identity.user_sessions WHERE token_hash=$1', [firstTokenHash])).rows[0].id,
    }), false);
    const storedSecret = await pool.query('SELECT encrypted_secret FROM identity.mfa_factors WHERE id=$1', [factorId]);
    assert.equal(storedSecret.rows[0].encrypted_secret, encryptedSecret);
    assert.notEqual(storedSecret.rows[0].encrypted_secret, 'plain-totp-secret');
    const activatedSession = await repository.activateFactor({
      userId, factorId, lastTotpStep: 123_456,
      recoveryCodeHashes: [consumedRecoveryHash, remainingRecoveryHash], ipHash,
      sessionId: (await pool.query('SELECT id FROM identity.user_sessions WHERE token_hash=$1', [firstTokenHash])).rows[0].id,
      currentTokenHash: firstTokenHash, newTokenHash: activatedTokenHash, idleTtlSeconds: 1_800,
    });
    assert.ok(activatedSession);
    assert.deepEqual(await repository.getStatus(userId), { state: 'enabled', recoveryCodesRemaining: 2 });

    const originalAbsoluteExpiry = (await pool.query('SELECT absolute_expires_at FROM identity.user_sessions WHERE token_hash=$1', [activatedTokenHash])).rows[0].absolute_expires_at;
    assert.ok((await pool.query('SELECT revoked_at FROM identity.user_sessions WHERE token_hash=$1', [firstTokenHash])).rows[0].revoked_at);
    assert.ok((await pool.query('SELECT mfa_verified_at FROM identity.user_sessions WHERE token_hash=$1', [activatedTokenHash])).rows[0].mfa_verified_at);
    const elevated = await repository.elevateSession({
      userId, currentTokenHash: activatedTokenHash, newTokenHash, factorId, ipHash,
      method: 'totp', totpStep: 123_457, idleTtlSeconds: 1_800,
    });
    assert.ok(elevated);
    const rotated = await pool.query('SELECT revoked_at FROM identity.user_sessions WHERE token_hash=$1', [activatedTokenHash]);
    assert.ok(rotated.rows[0].revoked_at);
    const elevatedRow = await pool.query('SELECT mfa_verified_at, absolute_expires_at FROM identity.user_sessions WHERE token_hash=$1', [newTokenHash]);
    assert.ok(elevatedRow.rows[0].mfa_verified_at);
    assert.equal(elevatedRow.rows[0].absolute_expires_at.getTime(), originalAbsoluteExpiry.getTime());
    assert.equal(await repository.elevateSession({
      userId, currentTokenHash: newTokenHash, newTokenHash: recoveryTokenHash, factorId, ipHash,
      method: 'totp', totpStep: 123_457, idleTtlSeconds: 1_800,
    }), null, 'a previously accepted TOTP time step cannot elevate another session');

    const recoveryElevated = await repository.elevateSession({
      userId, currentTokenHash: newTokenHash, newTokenHash: recoveryTokenHash, factorId, ipHash,
      method: 'recovery_code', recoveryCodeHash: consumedRecoveryHash, idleTtlSeconds: 1_800,
    });
    assert.ok(recoveryElevated);
    assert.equal(await repository.elevateSession({
      userId, currentTokenHash: recoveryTokenHash, newTokenHash: createHash('sha256').update(randomUUID()).digest('hex'), factorId, ipHash,
      method: 'recovery_code', recoveryCodeHash: consumedRecoveryHash, idleTtlSeconds: 1_800,
    }), null, 'a consumed recovery code cannot be replayed');

    assert.ok(await repository.elevateSession({
      userId, currentTokenHash: recoveryTokenHash, newTokenHash: exhaustedRecoveryTokenHash, factorId, ipHash,
      method: 'recovery_code', recoveryCodeHash: remainingRecoveryHash, idleTtlSeconds: 1_800,
    }));
    assert.deepEqual(await repository.getStatus(userId), { state: 'enabled', recoveryCodesRemaining: 0 });
    assert.equal(await repository.elevateSession({
      userId, currentTokenHash: exhaustedRecoveryTokenHash, newTokenHash: createHash('sha256').update(randomUUID()).digest('hex'), factorId, ipHash,
      method: 'recovery_code', recoveryCodeHash: consumedRecoveryHash, idleTtlSeconds: 1_800,
    }), null, 'an enabled factor with all recovery codes exhausted must deny step-up');

    await pool.query('UPDATE identity.user_sessions SET mfa_verified_at = clock_timestamp() - interval \'10 minutes\' WHERE token_hash=$1', [exhaustedRecoveryTokenHash]);
    assert.equal(await repository.revokeFactor({ userId, currentTokenHash: exhaustedRecoveryTokenHash, ipHash, maxMfaAgeSeconds: 300 }), false);
    await pool.query('UPDATE identity.user_sessions SET mfa_verified_at = clock_timestamp() WHERE token_hash=$1', [exhaustedRecoveryTokenHash]);
    assert.equal(await repository.revokeFactor({ userId, currentTokenHash: exhaustedRecoveryTokenHash, ipHash, maxMfaAgeSeconds: 300 }), true);
    const revokedFactor = await pool.query('SELECT state, encrypted_secret, secret_iv, secret_tag FROM identity.mfa_factors WHERE id=$1', [factorId]);
    assert.deepEqual(revokedFactor.rows[0], { state: 'revoked', encrypted_secret: '', secret_iv: '', secret_tag: '' });
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM identity.mfa_recovery_codes WHERE factor_id=$1 AND consumed_at IS NULL', [factorId])).rows[0].count, 0);
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM identity.user_sessions WHERE user_id=$1 AND revoked_at IS NULL', [userId])).rows[0].count, 0);
    const audits = await pool.query('SELECT event_name, outcome, metadata::text AS metadata FROM identity.security_audit_events WHERE actor_user_id=$1', [userId]);
    assert.deepEqual(audits.rows.map((row) => row.event_name), ['enrollment_started', 'enrollment_activated', 'step_up_succeeded', 'step_up_succeeded', 'step_up_succeeded', 'factor_revoked']);
    const sensitiveValues = [encryptedSecret, consumedRecoveryHash, remainingRecoveryHash, firstTokenHash, newTokenHash, recoveryTokenHash, exhaustedRecoveryTokenHash];
    assert.equal(audits.rows.some((row) => sensitiveValues.some((value) => row.metadata.includes(value))), false);
  } finally {
    await pool.query('DELETE FROM identity.security_audit_events WHERE actor_user_id=$1', [userId]).catch(() => undefined);
    await pool.query('DELETE FROM identity.mfa_recovery_codes WHERE factor_id=$1', [factorId]).catch(() => undefined);
    await pool.query('DELETE FROM identity.user_sessions WHERE user_id=$1', [userId]).catch(() => undefined);
    await pool.query('DELETE FROM identity.mfa_factors WHERE id=$1', [factorId]).catch(() => undefined);
    await pool.query('DELETE FROM identity.users WHERE id=$1', [userId]).catch(() => undefined);
    await pool.end();
  }
});
