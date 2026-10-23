'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');

// W0 foundation-only integration test. No approved W1 identity/outbox models exist yet.
// This is never called by npm test; CI must explicitly provision a disposable local PG16.
test('disposable PostgreSQL 16 transaction, uniqueness and row-claim semantics', { timeout: 30000 }, async () => {
  const connection = process.env.RENIVET_TEST_DATABASE_URL;
  assert.ok(connection, 'RENIVET_TEST_DATABASE_URL required for explicit disposable integration job');

  const address = new URL(connection);
  // Never execute schema-changing test SQL on a production, staging, or arbitrary remote DB.
  assert.equal(address.protocol, 'postgresql:', 'Expected PostgreSQL URL');
  assert.equal(address.hostname, '127.0.0.1', 'Integration DB must be loopback only');
  assert.equal(address.pathname, '/renivet_ci', 'Integration DB must be named renivet_ci');
  assert.equal(address.username, 'renivet_ci', 'Only the disposable CI role is permitted');

  const pool = new Pool({
    connectionString: connection,
    max: 3,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 3000,
  });
  const tableName = `ci_transaction_probe_${randomUUID().replace(/-/g, '')}`;

  try {
    const version = await pool.query('SHOW server_version_num');
    const v = Number(version.rows[0].server_version_num);
    assert.ok(v >= 160000 && v < 170000, 'This readiness test expects PostgreSQL 16');

    // An isolated synthetic table; never invoke Drizzle migration or app domain schemas.
    await pool.query(`CREATE TABLE "${tableName}" (event_key text PRIMARY KEY, marker text NOT NULL)`);

    // Rollback is atomic; a failed business transaction would leave no committed record.
    const a = await pool.connect();
    try {
      await a.query('BEGIN');
      await a.query(`INSERT INTO "${tableName}" (event_key, marker) VALUES ($1, $2)`, ['rolled-back', 'test']);
      await a.query('ROLLBACK');
    } finally {
      a.release();
    }
    const rolledBack = await pool.query(`SELECT count(*)::int AS count FROM "${tableName}" WHERE event_key=$1`, ['rolled-back']);
    assert.equal(rolledBack.rows[0].count, 0);

    // A stable unique key rejects duplicate synthetic events at the database boundary.
    await pool.query(`INSERT INTO "${tableName}" (event_key, marker) VALUES ($1, $2)`, ['one-event', 'fixture']);
    await assert.rejects(
      pool.query(`INSERT INTO "${tableName}" (event_key, marker) VALUES ($1, $2)`, ['one-event', 'replay']),
      (error) => error.code === '23505',
      'PostgreSQL must reject duplicate keys',
    );

    // Two concurrent clients: only the first claimant sees a row locked by the first.
    const first = await pool.connect();
    const second = await pool.connect();
    try {
      await first.query('BEGIN');
      const claimed = await first.query(`SELECT event_key FROM "${tableName}" FOR UPDATE SKIP LOCKED`);
      assert.equal(claimed.rowCount, 1);
      await second.query('BEGIN');
      const skipped = await second.query(`SELECT event_key FROM "${tableName}" FOR UPDATE SKIP LOCKED`);
      assert.equal(skipped.rowCount, 0, 'Concurrent worker must skip already-locked rows');
    } finally {
      await Promise.allSettled([first.query('ROLLBACK'), second.query('ROLLBACK')]);
      first.release();
      second.release();
    }

    const persisted = await pool.query(`SELECT marker FROM "${tableName}" WHERE event_key=$1`, ['one-event']);
    assert.equal(persisted.rows[0].marker, 'fixture');
  } finally {
    // CI owns this whole disposable DB; never drop any application or shared tables.
    await pool.query(`DROP TABLE IF EXISTS "${tableName}"`).catch(() => {});
    await pool.end();
  }
});
