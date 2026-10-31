'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');

const databaseName = 'renivet_ci';
const snapshotName = 'renivet_ci_recovery_snapshot';

function requireDisposablePostgresUrl() {
  assert.equal(
    process.env.RENIVET_ALLOW_DISPOSABLE_DATABASE_REBUILD,
    '1',
    'Set RENIVET_ALLOW_DISPOSABLE_DATABASE_REBUILD=1 only for the isolated recovery integration test',
  );
  const connection = process.env.RENIVET_TEST_DATABASE_URL;
  assert.ok(connection, 'RENIVET_TEST_DATABASE_URL is required for explicit disposable recovery tests');

  const address = new URL(connection);
  assert.equal(address.protocol, 'postgresql:', 'Expected a PostgreSQL URL');
  assert.equal(address.hostname, '127.0.0.1', 'Recovery test must use loopback PostgreSQL only');
  assert.equal(address.pathname, `/${databaseName}`, `Recovery test may rebuild only ${databaseName}`);
  assert.equal(address.username, 'renivet_ci', 'Only the disposable CI role is permitted');
  address.pathname = '/postgres';
  return { connection, adminConnection: address.toString() };
}

test('W1 disposable PostgreSQL snapshot recovery preserves the migrated schema and data', { timeout: 30000 }, async () => {
  const { connection, adminConnection } = requireDisposablePostgresUrl();
  const admin = new Pool({ connectionString: adminConnection, max: 1, connectionTimeoutMillis: 5000 });
  let snapshotCreated = false;
  let targetDropped = false;
  let targetRestored = false;
  let fixtureEmail;
  let fixtureOutboxId;

  try {
    const server = await admin.query(`
      SELECT current_setting('server_version_num')::integer AS version_number,
             role.rolsuper AS is_superuser,
             (SELECT count(*) FROM pg_stat_activity WHERE datname = $1) AS target_connections
      FROM pg_roles AS role
      WHERE role.rolname = current_user
    `, [databaseName]);
    assert.equal(server.rows.length, 1, 'The recovery role must exist');
    assert.ok(
      server.rows[0].version_number >= 160000 && server.rows[0].version_number < 170000,
      'REN2-20 recovery requires disposable PostgreSQL 16',
    );
    assert.equal(server.rows[0].is_superuser, true, 'Only the disposable PostgreSQL superuser may rebuild the test database');
    assert.equal(Number(server.rows[0].target_connections), 0, 'No client may be connected to the disposable database during recovery');

    const existingSnapshot = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [snapshotName]);
    assert.equal(existingSnapshot.rowCount, 0, 'Recovery snapshot database must not already exist');

    const fixture = new Pool({ connectionString: connection, max: 1, connectionTimeoutMillis: 5000 });
    try {
      fixtureEmail = `recovery-${randomUUID()}@example.test`;
      await fixture.query(
        `INSERT INTO identity.users (email, state) VALUES ($1, 'recovery_probe')`,
        [fixtureEmail],
      );
      const event = await fixture.query(
        `INSERT INTO platform.outbox_events
           (aggregate_type, aggregate_id, event_type, event_version, event_payload, event_key)
         VALUES ('recovery_probe', gen_random_uuid(), 'recovery.probe', 1, '{"synthetic":true}'::jsonb, $1)
         RETURNING id`,
        [`recovery-${randomUUID()}`],
      );
      fixtureOutboxId = event.rows[0].id;
    } finally {
      await fixture.end();
    }

    await admin.query(`CREATE DATABASE ${snapshotName} TEMPLATE ${databaseName}`);
    snapshotCreated = true;
    await admin.query(`DROP DATABASE ${databaseName} WITH (FORCE)`);
    targetDropped = true;
    await admin.query(`CREATE DATABASE ${databaseName} TEMPLATE ${snapshotName}`);
    targetRestored = true;

    const restored = new Pool({ connectionString: connection, max: 1, connectionTimeoutMillis: 5000 });
    try {
      const user = await restored.query('SELECT email, state FROM identity.users WHERE email = $1', [fixtureEmail]);
      assert.deepEqual(user.rows, [{ email: fixtureEmail, state: 'recovery_probe' }]);
      const outbox = await restored.query(
        `SELECT event_type, event_version, event_payload
         FROM platform.outbox_events WHERE id = $1`,
        [fixtureOutboxId],
      );
      assert.deepEqual(outbox.rows, [{ event_type: 'recovery.probe', event_version: 1, event_payload: { synthetic: true } }]);
      const objects = await restored.query(`
        SELECT table_schema, table_name
        FROM information_schema.tables
        WHERE (table_schema = 'identity' AND table_type = 'BASE TABLE')
           OR (table_schema = 'brands' AND table_type = 'BASE TABLE')
           OR (table_schema = 'access' AND table_type = 'BASE TABLE')
           OR (table_schema = 'platform' AND table_type = 'BASE TABLE')
           OR (table_schema = 'public' AND table_name = 'system_events')
        ORDER BY table_schema, table_name
      `);
      assert.deepEqual(objects.rows, [
        { table_schema: 'access', table_name: 'permissions' },
        { table_schema: 'access', table_name: 'role_assignments' },
        { table_schema: 'access', table_name: 'role_permissions' },
        { table_schema: 'access', table_name: 'roles' },
        { table_schema: 'access', table_name: 'security_audit_events' },
        { table_schema: 'brands', table_name: 'brand_memberships' },
        { table_schema: 'brands', table_name: 'brands' },
        { table_schema: 'identity', table_name: 'auth_challenges' },
        { table_schema: 'identity', table_name: 'mfa_factors' },
        { table_schema: 'identity', table_name: 'mfa_recovery_codes' },
        { table_schema: 'identity', table_name: 'security_audit_events' },
        { table_schema: 'identity', table_name: 'user_credentials' },
        { table_schema: 'identity', table_name: 'user_sessions' },
        { table_schema: 'identity', table_name: 'users' },
        { table_schema: 'platform', table_name: 'dead_letter_cases' },
        { table_schema: 'platform', table_name: 'dead_letter_recovery_audit' },
        { table_schema: 'platform', table_name: 'durable_jobs' },
        { table_schema: 'platform', table_name: 'inbox_receipts' },
        { table_schema: 'platform', table_name: 'outbox_events' },
        { table_schema: 'platform', table_name: 'webhook_inbox' },
        { table_schema: 'public', table_name: 'system_events' },
      ]);
    } finally {
      await restored.end();
    }
  } finally {
    if (targetDropped && !targetRestored && snapshotCreated) {
      try {
        await admin.query(`CREATE DATABASE ${databaseName} TEMPLATE ${snapshotName}`);
        targetRestored = true;
      } catch { /* Preserve the recovery snapshot if rebuilding the target fails. */ }
    }
    if (targetRestored && snapshotCreated) {
      await admin.query(`DROP DATABASE ${snapshotName} WITH (FORCE)`).catch(() => {});
    }
    if ((!targetDropped || targetRestored) && fixtureEmail) {
      const cleanup = new Pool({ connectionString: connection, max: 1, connectionTimeoutMillis: 5000 });
      if (fixtureOutboxId) await cleanup.query('DELETE FROM platform.outbox_events WHERE id = $1', [fixtureOutboxId]).catch(() => {});
      await cleanup.query('DELETE FROM identity.users WHERE email = $1', [fixtureEmail]).catch(() => {});
      await cleanup.end();
    }
    await admin.end();
  }
});
