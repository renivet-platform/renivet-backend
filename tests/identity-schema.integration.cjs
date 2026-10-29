'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createHash, createHmac, randomUUID } = require('node:crypto');
const { Pool } = require('pg');

function requireDisposablePostgresUrl() {
  const connection = process.env.RENIVET_TEST_DATABASE_URL;
  assert.ok(connection, 'RENIVET_TEST_DATABASE_URL is required for explicit disposable integration tests');

  const address = new URL(connection);
  assert.equal(address.protocol, 'postgresql:', 'Expected a PostgreSQL URL');
  assert.equal(address.hostname, '127.0.0.1', 'Identity integration DB must be loopback only');
  assert.equal(address.pathname, '/renivet_ci', 'Identity integration DB must be named renivet_ci');
  assert.equal(address.username, 'renivet_ci', 'Only the disposable CI role is permitted');
  return connection;
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function challengeDigest(value) {
  return createHmac('sha256', 'ren2-20-integration-only-key').update(value).digest('hex');
}

test('REN2-20 identity schema enforces canonical ownership, foreign keys and hashed secrets', { timeout: 30000 }, async () => {
  const pool = new Pool({
    connectionString: requireDisposablePostgresUrl(),
    max: 4,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 3000,
  });
  const fixturePrefix = `ren2-20-${randomUUID()}`;
  const userIds = [];

  try {
    const version = await pool.query('SHOW server_version_num');
    const versionNumber = Number(version.rows[0].server_version_num);
    assert.ok(versionNumber >= 160000 && versionNumber < 170000, 'REN2-20 integration requires disposable PostgreSQL 16');

    const tables = await pool.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'identity' AND table_type = 'BASE TABLE'
      ORDER BY table_name
    `);
    const identityTableNames = tables.rows.map((row) => row.table_name);
    for (const tableName of ['auth_challenges', 'user_credentials', 'user_sessions', 'users']) {
      assert.ok(identityTableNames.includes(tableName), `REN2-20 table identity.${tableName} must remain present`);
    }
    const columns = await pool.query(`
      SELECT table_name, column_name
      FROM information_schema.columns
      WHERE table_schema = 'identity'
      ORDER BY table_name, ordinal_position
    `);
    const canonicalColumns = {
      auth_challenges: ['id', 'created_at', 'updated_at', 'row_version', 'user_id', 'kind', 'code_hash', 'expires_at', 'attempt_count', 'consumed_at'],
      user_credentials: ['id', 'created_at', 'updated_at', 'row_version', 'user_id', 'password_hash', 'credential_version', 'rotated_at', 'disabled_at'],
      user_sessions: ['id', 'created_at', 'updated_at', 'row_version', 'user_id', 'token_hash', 'device_hash', 'expires_at', 'revoked_at', 'ip_hash', 'absolute_expires_at', 'mfa_verified_at'],
      users: ['id', 'created_at', 'updated_at', 'row_version', 'email', 'phone', 'display_name', 'state', 'email_verified_at', 'phone_verified_at', 'last_login_at'],
    };
    for (const [tableName, expectedColumns] of Object.entries(canonicalColumns)) {
      assert.deepEqual(
        columns.rows.filter((row) => row.table_name === tableName).map((row) => row.column_name),
        expectedColumns,
        `identity.${tableName} must match the canonical D02 column set`,
      );
    }

    const indexes = await pool.query(`
      SELECT indexname, indexdef
      FROM pg_indexes
      WHERE schemaname = 'identity' AND indexname LIKE 'identity_%'
      ORDER BY indexname
    `);
    const expectedIndexDefinitions = {
      identity_auth_challenges_expires_idx: /USING btree \(expires_at\)$/i,
      identity_auth_challenges_user_created_idx: /USING btree \(user_id, created_at\)$/i,
      identity_user_credentials_one_active_per_user_uq: /CREATE UNIQUE INDEX .*USING btree \(user_id\) WHERE \(disabled_at IS NULL\)$/i,
      identity_user_credentials_user_version_uq: /CREATE UNIQUE INDEX .*USING btree \(user_id, credential_version\)$/i,
      identity_user_sessions_expires_idx: /USING btree \(expires_at\)$/i,
      identity_user_sessions_token_hash_uq: /CREATE UNIQUE INDEX .*USING btree \(token_hash\)$/i,
      identity_user_sessions_user_created_idx: /USING btree \(user_id, created_at\)$/i,
      identity_users_email_normalized_uq: /CREATE UNIQUE INDEX .*USING btree \(lower\(btrim\(email\)\)\)$/i,
      identity_users_phone_e164_uq: /CREATE UNIQUE INDEX .*USING btree \(phone\)$/i,
    };
    const canonicalIndexes = indexes.rows.filter((row) => Object.hasOwn(expectedIndexDefinitions, row.indexname));
    assert.deepEqual(
      canonicalIndexes.map((row) => row.indexname),
      Object.keys(expectedIndexDefinitions).sort(),
      'REN2-20 must create exactly the reviewed identity indexes',
    );
    const indexDefinitions = new Map(indexes.rows.map((row) => [row.indexname, row.indexdef]));
    for (const [indexName, expectedDefinition] of Object.entries(expectedIndexDefinitions)) {
      assert.match(
        indexDefinitions.get(indexName),
        expectedDefinition,
        `${indexName} must keep its reviewed uniqueness and indexed columns`,
      );
    }

    const createUser = async ({ email, phone, state = 'pending_verification', emailVerifiedAt, phoneVerifiedAt }) => {
      const result = await pool.query(
        `INSERT INTO identity.users (email, phone, state, email_verified_at, phone_verified_at)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [email ?? null, phone ?? null, state, emailVerifiedAt ?? null, phoneVerifiedAt ?? null],
      );
      userIds.push(result.rows[0].id);
      return result.rows[0].id;
    };

    // Distinct account states do not release a verified contact for takeover.
    const email = `${fixturePrefix}@example.test`;
    const phone = '+14155550123';
    const emailVerification = await Promise.allSettled([
      createUser({ email, phone: '+14155550124', state: 'active', emailVerifiedAt: new Date() }),
      createUser({ email, phone: '+14155550125', state: 'suspended', emailVerifiedAt: new Date() }),
    ]);
    assert.equal(emailVerification.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(emailVerification.filter((result) => result.status === 'rejected' && result.reason.code === '23505').length, 1);

    const phoneVerification = await Promise.allSettled([
      createUser({ email: `${fixturePrefix}-phone-a@example.test`, phone, state: 'active', phoneVerifiedAt: new Date() }),
      createUser({ email: `${fixturePrefix}-phone-b@example.test`, phone, state: 'deactivated', phoneVerifiedAt: new Date() }),
    ]);
    assert.equal(phoneVerification.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(phoneVerification.filter((result) => result.status === 'rejected' && result.reason.code === '23505').length, 1);

    await assert.rejects(
      createUser({ email: ` ${fixturePrefix.toUpperCase()}@example.test `, phone: '+14155550127' }),
      (error) => error.code === '23514',
      'Email addresses must be stored trimmed and lowercase',
    );

    const userId = await createUser({ email: `${fixturePrefix}-credentials@example.test`, phone: '+14155550126', state: 'active' });
    const argon2idHash = '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHQ$Ynl0ZXNoYXNo';
    await pool.query(
      `INSERT INTO identity.user_credentials (user_id, password_hash, credential_version)
       VALUES ($1, $2, 1)`,
      [userId, argon2idHash],
    );
    await assert.rejects(
      pool.query(
        `INSERT INTO identity.user_credentials (user_id, password_hash, credential_version)
         VALUES ($1, $2, 2)`,
        [userId, argon2idHash],
      ),
      (error) => error.code === '23505',
      'A user cannot have two active password credentials',
    );
    await pool.query(
      `UPDATE identity.user_credentials SET disabled_at = now(), updated_at = now()
       WHERE user_id = $1`,
      [userId],
    );
    await assert.rejects(
      pool.query(
        `INSERT INTO identity.user_credentials (user_id, password_hash, credential_version, disabled_at)
         VALUES ($1, $2, 1, now())`,
        [userId, argon2idHash],
      ),
      (error) => error.code === '23505',
      'Credential versions cannot be reused for one user',
    );
    await pool.query(
      `INSERT INTO identity.user_credentials (user_id, password_hash, credential_version)
       VALUES ($1, $2, 2)`,
      [userId, argon2idHash],
    );
    await assert.rejects(
      pool.query(
        `INSERT INTO identity.user_credentials (user_id, password_hash, credential_version)
         VALUES ($1, $2, 3)`,
        [userId, argon2idHash],
      ),
      (error) => error.code === '23505',
      'Credential rotation cannot create a second active password',
    );
    const invalidHashUserId = await createUser({
      email: `${fixturePrefix}-invalid-hash@example.test`,
      phone: '+14155550128',
      state: 'active',
    });
    await assert.rejects(
      pool.query(
        `INSERT INTO identity.user_credentials (user_id, password_hash, credential_version)
         VALUES ($1, $2, 1)`,
        [invalidHashUserId, 'plaintext-password-must-never-be-persisted'],
      ),
      (error) => error.code === '23514',
      'Only Argon2id PHC password hashes may be stored',
    );
    await assert.rejects(
      pool.query(
        `INSERT INTO identity.user_credentials (user_id, password_hash, credential_version)
         VALUES ($1, $2, 1)`,
        [randomUUID(), argon2idHash],
      ),
      (error) => error.code === '23503',
      'Credential ownership must reference a canonical user',
    );
    const invalidVersionUserId = await createUser({
      email: `${fixturePrefix}-invalid-version@example.test`,
      phone: '+14155550129',
      state: 'active',
    });
    await assert.rejects(
      pool.query(
        `INSERT INTO identity.user_credentials (user_id, password_hash, credential_version)
         VALUES ($1, $2, 0)`,
        [invalidVersionUserId, argon2idHash],
      ),
      (error) => error.code === '23514',
      'Credential version must be positive',
    );

    const rawSessionToken = `${fixturePrefix}-session-secret`;
    const sessionTokenHash = digest(rawSessionToken);
    const session = await pool.query(
      `INSERT INTO identity.user_sessions (user_id, token_hash, expires_at)
       VALUES ($1, $2, now() + interval '1 hour') RETURNING id, token_hash`,
      [userId, sessionTokenHash],
    );
    assert.equal(session.rows[0].token_hash, sessionTokenHash);
    assert.notEqual(session.rows[0].token_hash, rawSessionToken);
    await assert.rejects(
      pool.query(
        `INSERT INTO identity.user_sessions (user_id, token_hash, expires_at)
         VALUES ($1, $2, now() + interval '1 hour')`,
        [userId, sessionTokenHash],
      ),
      (error) => error.code === '23505',
      'A session digest cannot be reused',
    );
    await assert.rejects(
      pool.query(
        `INSERT INTO identity.user_sessions (user_id, token_hash, expires_at)
         VALUES ($1, $2, now() + interval '1 hour')`,
        [userId, rawSessionToken],
      ),
      (error) => error.code === '23514',
      'Session storage must reject a raw bearer token',
    );
    await assert.rejects(
      pool.query(
        `INSERT INTO identity.user_sessions (user_id, token_hash, expires_at)
         VALUES ($1, $2, now() + interval '1 hour')`,
        [randomUUID(), digest(`${fixturePrefix}-missing-session-user`)],
      ),
      (error) => error.code === '23503',
      'A session must reference a canonical user',
    );

    const rawChallengeCode = '482915';
    const challengeCodeHash = challengeDigest(`${userId}:${rawChallengeCode}`);
    const challenge = await pool.query(
      `INSERT INTO identity.auth_challenges (user_id, kind, code_hash, expires_at, attempt_count)
       VALUES ($1, 'email_verification', $2, now() + interval '5 minutes', 0)
       RETURNING id, code_hash`,
      [userId, challengeCodeHash],
    );
    assert.equal(challenge.rows[0].code_hash, challengeCodeHash);
    assert.notEqual(challenge.rows[0].code_hash, rawChallengeCode);
    await assert.rejects(
      pool.query(
        `INSERT INTO identity.auth_challenges (user_id, kind, code_hash, expires_at, attempt_count)
         VALUES ($1, 'email_verification', $2, now() + interval '5 minutes', 0)`,
        [userId, rawChallengeCode],
      ),
      (error) => error.code === '23514',
      'Challenge storage must reject a raw one-time code',
    );
    await assert.rejects(
      pool.query(
        `INSERT INTO identity.auth_challenges (user_id, kind, code_hash, expires_at, attempt_count)
         VALUES ($1, 'email_verification', $2, now() + interval '5 minutes', -1)`,
        [userId, challengeDigest(`${userId}:invalid-attempt-count`)],
      ),
      (error) => error.code === '23514',
      'Challenge attempts cannot be negative',
    );
    await assert.rejects(
      pool.query(
        `INSERT INTO identity.auth_challenges (user_id, kind, code_hash, expires_at, attempt_count)
         VALUES ($1, 'email_verification', $2, now() + interval '5 minutes', 0)`,
        [randomUUID(), challengeDigest(`${fixturePrefix}-missing-challenge-user`)],
      ),
      (error) => error.code === '23503',
      'An account-bound challenge must reference a canonical user',
    );

    await assert.rejects(
      pool.query(
        `INSERT INTO identity.users (email, phone, state, email_verified_at)
         VALUES (NULL, NULL, 'active', now())`,
      ),
      (error) => error.code === '23514',
      'A verified contact timestamp cannot exist without its contact',
    );
    await assert.rejects(
      pool.query(
        `INSERT INTO identity.users (email, phone, state)
         VALUES ($1, NULL, '  ')`,
        [`${fixturePrefix}-empty-state@example.test`],
      ),
      (error) => error.code === '23514',
      'Account state cannot be blank',
    );
    await assert.rejects(
      pool.query(
        `INSERT INTO identity.users (email, phone, state)
         VALUES (NULL, $1, 'active')`,
        ['+14155550123x'],
      ),
      (error) => error.code === '23514',
      'Phone numbers must use canonical E.164 form',
    );
  } finally {
    if (userIds.length > 0) {
      await pool.query('DELETE FROM identity.auth_challenges WHERE user_id = ANY($1::uuid[])', [userIds]).catch(() => {});
      await pool.query('DELETE FROM identity.user_sessions WHERE user_id = ANY($1::uuid[])', [userIds]).catch(() => {});
      await pool.query('DELETE FROM identity.user_credentials WHERE user_id = ANY($1::uuid[])', [userIds]).catch(() => {});
      await pool.query('DELETE FROM identity.users WHERE id = ANY($1::uuid[])', [userIds]).catch(() => {});
    }
    await pool.end();
  }
});
