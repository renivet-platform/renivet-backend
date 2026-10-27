'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createHash, randomUUID } = require('node:crypto');
const { Pool } = require('pg');

function requireDisposablePostgresUrl() {
  const connection = process.env.RENIVET_TEST_DATABASE_URL;
  assert.ok(connection, 'RENIVET_TEST_DATABASE_URL is required for explicit disposable integration tests');

  const address = new URL(connection);
  assert.equal(address.protocol, 'postgresql:', 'Expected a PostgreSQL URL');
  assert.equal(address.hostname, '127.0.0.1', 'Outbox integration DB must be loopback only');
  assert.equal(address.pathname, '/renivet_ci', 'Outbox integration DB must be named renivet_ci');
  assert.equal(address.username, 'renivet_ci', 'Only the disposable CI role is permitted');
  return connection;
}

function hashPayload(payload) {
  return createHash('sha256').update(payload).digest('hex');
}

test('REN2-29 platform event schema enforces atomicity, inbox dedupe and bounded job metadata', { timeout: 30000 }, async () => {
  const pool = new Pool({
    connectionString: requireDisposablePostgresUrl(),
    max: 4,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 3000,
  });
  const fixturePrefix = `ren2-29-${randomUUID()}`;
  const outboxIds = [];
  const systemEventIds = [];
  const webhookEventIds = [];

  try {
    const version = await pool.query('SHOW server_version_num');
    const versionNumber = Number(version.rows[0].server_version_num);
    assert.ok(versionNumber >= 160000 && versionNumber < 170000, 'REN2-29 integration requires disposable PostgreSQL 16');

    const tables = await pool.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'platform' AND table_type = 'BASE TABLE'
      ORDER BY table_name
    `);
    assert.deepEqual(
      tables.rows.map((row) => row.table_name),
      ['dead_letter_cases', 'durable_jobs', 'inbox_receipts', 'outbox_events', 'webhook_inbox'],
      'REN2-29 must add only the reviewed event, webhook, consumer receipt and worker state tables',
    );

    const columns = await pool.query(`
      SELECT table_name, column_name
      FROM information_schema.columns
      WHERE table_schema = 'platform'
      ORDER BY table_name, ordinal_position
    `);
    const expectedColumns = {
      dead_letter_cases: ['id', 'created_at', 'updated_at', 'row_version', 'job_id', 'event_id', 'reason_code', 'state', 'assigned_to_id', 'resolved_at'],
      durable_jobs: ['id', 'created_at', 'updated_at', 'row_version', 'job_kind', 'business_key', 'state', 'scheduled_for', 'lease_until', 'attempt_count', 'max_attempts', 'lease_owner', 'lease_started_at', 'last_error_code'],
      inbox_receipts: ['id', 'created_at', 'consumer_id', 'message_id', 'event_version', 'processed_at'],
      outbox_events: ['id', 'created_at', 'updated_at', 'row_version', 'aggregate_type', 'aggregate_id', 'event_type', 'event_version', 'event_payload', 'event_key', 'occurred_at', 'delivered_at'],
      webhook_inbox: ['id', 'created_at', 'updated_at', 'row_version', 'provider', 'provider_event_id', 'signature_verified', 'payload_hash', 'payload_key', 'state', 'processed_at'],
    };
    for (const [tableName, tableColumns] of Object.entries(expectedColumns)) {
      assert.deepEqual(
        columns.rows.filter((row) => row.table_name === tableName).map((row) => row.column_name),
        tableColumns,
        `platform.${tableName} must match the reviewed D02/event contract`,
      );
    }

    const indexRows = await pool.query(`
      SELECT indexname, indexdef
      FROM pg_indexes
      WHERE schemaname = 'platform'
      ORDER BY indexname
    `);
    const expectedIndexes = {
      platform_dead_letter_cases_open_idx: /USING btree \(created_at, id\) WHERE \(state = 'open'::text\)$/i,
      platform_durable_jobs_business_key_uq: /CREATE UNIQUE INDEX .*USING btree \(job_kind, business_key\)$/i,
      platform_durable_jobs_expired_lease_idx: /USING btree \(lease_until, id\) WHERE \(state = 'leased'::text\)$/i,
      platform_durable_jobs_pending_claim_idx: /USING btree \(scheduled_for, id\) WHERE \(state = 'pending'::text\)$/i,
      platform_inbox_receipts_consumer_message_uq: /CREATE UNIQUE INDEX .*USING btree \(consumer_id, message_id\)$/i,
      platform_outbox_events_pending_idx: /USING btree \(occurred_at, id\) WHERE \(delivered_at IS NULL\)$/i,
      platform_outbox_events_scoped_key_uq: /CREATE UNIQUE INDEX .*USING btree \(aggregate_type, aggregate_id, event_key\)$/i,
      platform_webhook_inbox_provider_event_uq: /CREATE UNIQUE INDEX .*USING btree \(provider, provider_event_id\)$/i,
      platform_webhook_inbox_state_idx: /USING btree \(state, created_at\)$/i,
    };
    assert.deepEqual(
      indexRows.rows.map((row) => row.indexname).filter((name) => name.startsWith('platform_')),
      Object.keys(expectedIndexes).sort(),
      'REN2-29 must create exactly the reviewed event claim and dedupe indexes',
    );
    const definitions = new Map(indexRows.rows.map((row) => [row.indexname, row.indexdef]));
    for (const [indexName, definition] of Object.entries(expectedIndexes)) {
      assert.match(definitions.get(indexName), definition, `${indexName} must retain its reviewed definition`);
    }

    const aggregateId = randomUUID();
    const eventKey = `${fixturePrefix}:order-created`;
    await pool.query('BEGIN');
    const event = await pool.query(
      'INSERT INTO system_events (event_name) VALUES ($1) RETURNING id',
      [`${fixturePrefix}:committed-domain-effect`],
    );
    systemEventIds.push(event.rows[0].id);
    const createdOutboxEvent = await pool.query(
      `INSERT INTO platform.outbox_events
         (aggregate_type, aggregate_id, event_type, event_version, event_payload, event_key, occurred_at)
       VALUES ('test_order', $1, 'test.order.created', 1, $2::jsonb, $3, now())
       RETURNING id`,
      [aggregateId, JSON.stringify({ fixture: fixturePrefix, testOnly: true }), eventKey],
    );
    outboxIds.push(createdOutboxEvent.rows[0].id);
    await pool.query('COMMIT');

    const committed = await pool.query(
      `SELECT count(*)::integer AS count
       FROM platform.outbox_events AS outbox
       JOIN system_events AS domain ON domain.event_name = $1
       WHERE outbox.event_key = $2`,
      [`${fixturePrefix}:committed-domain-effect`, eventKey],
    );
    assert.equal(committed.rows[0].count, 1, 'Domain mutation and outbox event must commit together');

    const rollbackClient = await pool.connect();
    try {
      await rollbackClient.query('BEGIN');
      const rolledBackEffect = await rollbackClient.query(
        'INSERT INTO system_events (event_name) VALUES ($1) RETURNING id',
        [`${fixturePrefix}:rolled-back-domain-effect`],
      );
      systemEventIds.push(rolledBackEffect.rows[0].id);
      await assert.rejects(
        rollbackClient.query(
          `INSERT INTO platform.outbox_events
             (aggregate_type, aggregate_id, event_type, event_version, event_payload, event_key, occurred_at)
           VALUES ('test_order', $1, 'test.order.invalid', 0, '{}'::jsonb, $2, now())`,
          [randomUUID(), `${fixturePrefix}:invalid-version`],
        ),
        (error) => error.code === '23514',
        'An invalid event must fail before it can be committed with a domain change',
      );
      await rollbackClient.query('ROLLBACK');
    } finally {
      rollbackClient.release();
    }
    const rolledBack = await pool.query(
      `SELECT count(*)::integer AS count FROM system_events WHERE event_name = $1`,
      [`${fixturePrefix}:rolled-back-domain-effect`],
    );
    assert.equal(rolledBack.rows[0].count, 0, 'A rejected outbox insert must leave no domain mutation');

    await assert.rejects(
      pool.query(
        `INSERT INTO platform.outbox_events
           (aggregate_type, aggregate_id, event_type, event_version, event_payload, event_key, occurred_at)
         VALUES ('test_order', $1, 'test.order.duplicate', 1, '{}'::jsonb, $2, now())`,
        [aggregateId, eventKey],
      ),
      (error) => error.code === '23505',
      'The aggregate-scoped event key must prevent duplicate event creation',
    );

    const providerEventId = `${fixturePrefix}:provider-event`;
    webhookEventIds.push(providerEventId);
    const payloadHash = hashPayload(`${fixturePrefix}:synthetic-provider-payload`);
    await pool.query(
      `INSERT INTO platform.webhook_inbox
         (provider, provider_event_id, signature_verified, payload_hash, state)
       VALUES ('synthetic-provider', $1, true, $2, 'received')`,
      [providerEventId, payloadHash],
    );
    await assert.rejects(
      pool.query(
        `INSERT INTO platform.webhook_inbox
           (provider, provider_event_id, signature_verified, payload_hash, state)
         VALUES ('synthetic-provider', $1, true, $2, 'received')`,
        [providerEventId, payloadHash],
      ),
      (error) => error.code === '23505',
      'Repeated external provider event IDs must be deduplicated',
    );
    await assert.rejects(
      pool.query(
        `INSERT INTO platform.webhook_inbox
           (provider, provider_event_id, signature_verified, payload_hash, state, processed_at)
         VALUES ('synthetic-provider', $1, false, $2, 'processed', now())`,
        [`${providerEventId}:unsigned`, payloadHash],
      ),
      (error) => error.code === '23514',
      'An unverified provider payload cannot be recorded as processed',
    );

    const first = await pool.connect();
    const second = await pool.connect();
    let firstReceipt;
    let secondReceipt;
    try {
      await first.query('BEGIN');
      await second.query('BEGIN');
      firstReceipt = await first.query(
        `INSERT INTO platform.inbox_receipts (consumer_id, message_id, event_version)
         VALUES ('test-consumer', $1, 1) RETURNING id`,
        [outboxIds[0]],
      );
      const duplicateReceipt = second.query(
        `INSERT INTO platform.inbox_receipts (consumer_id, message_id, event_version)
         VALUES ('test-consumer', $1, 1)
         ON CONFLICT (consumer_id, message_id) DO NOTHING RETURNING id`,
        [outboxIds[0]],
      );
      const effect = await first.query(
        'INSERT INTO system_events (event_name) VALUES ($1) RETURNING id',
        [`${fixturePrefix}:consumer-effect`],
      );
      systemEventIds.push(effect.rows[0].id);
      await first.query('COMMIT');
      secondReceipt = await duplicateReceipt;
      if (secondReceipt.rowCount === 1) {
        await second.query(
          'INSERT INTO system_events (event_name) VALUES ($1)',
          [`${fixturePrefix}:consumer-effect`],
        );
      }
      await second.query('COMMIT');
    } finally {
      if (!firstReceipt) await first.query('ROLLBACK').catch(() => {});
      if (!secondReceipt) await second.query('ROLLBACK').catch(() => {});
      first.release();
      second.release();
    }
    assert.equal(firstReceipt.rowCount, 1);
    assert.equal(secondReceipt.rowCount, 0, 'A concurrent duplicate consumer receipt must be a no-op');
    const effects = await pool.query(
      'SELECT count(*)::integer AS count FROM system_events WHERE event_name = $1',
      [`${fixturePrefix}:consumer-effect`],
    );
    assert.equal(effects.rows[0].count, 1, 'Duplicate delivery must not repeat the synthetic consumer effect');
    await assert.rejects(
      pool.query(
        `INSERT INTO platform.inbox_receipts (consumer_id, message_id, event_version)
         VALUES ('test-consumer', $1, 1)`,
        [outboxIds[0]],
      ),
      (error) => error.code === '23505',
      'One internal consumer may record a given event only once',
    );

    const job = await pool.query(
      `INSERT INTO platform.durable_jobs (job_kind, business_key, scheduled_for)
       VALUES ('test_projection', $1, now()) RETURNING id, state, attempt_count, max_attempts`,
      [`${fixturePrefix}:projection`],
    );
    await pool.query(
      `UPDATE platform.durable_jobs
       SET state = 'leased', lease_until = now() + interval '1 minute',
           lease_started_at = now(), lease_owner = 'test-worker'
       WHERE id = $1`,
      [job.rows[0].id],
    );
    await assert.rejects(
      pool.query(
        `UPDATE platform.durable_jobs SET attempt_count = max_attempts + 1 WHERE id = $1`,
        [job.rows[0].id],
      ),
      (error) => error.code === '23514',
      'Job attempts must remain bounded by max_attempts',
    );
    await assert.rejects(
      pool.query(
        `INSERT INTO platform.durable_jobs
           (job_kind, business_key, scheduled_for, max_attempts)
         VALUES ('test_projection', $1, now(), 0)`,
        [`${fixturePrefix}:invalid-attempt-limit`],
      ),
      (error) => error.code === '23514',
      'Job max_attempts must be positive and bounded',
    );
    await assert.rejects(
      pool.query(
        `UPDATE platform.durable_jobs SET state = 'pending', lease_owner = 'stale-worker' WHERE id = $1`,
        [job.rows[0].id],
      ),
      (error) => error.code === '23514',
      'Only leased jobs may retain lease ownership metadata',
    );
    const deadLetter = await pool.query(
      `INSERT INTO platform.dead_letter_cases (job_id, reason_code, state)
       VALUES ($1, 'TEST_FAILURE', 'open') RETURNING id`,
      [job.rows[0].id],
    );
    await assert.rejects(
      pool.query(
        `INSERT INTO platform.dead_letter_cases (reason_code, state)
         VALUES ('TEST_FAILURE', 'open')`,
      ),
      (error) => error.code === '23514',
      'A dead-letter case must identify a failed job or event',
    );
    await assert.rejects(
      pool.query(
        `INSERT INTO platform.dead_letter_cases (job_id, reason_code, state)
         VALUES ($1, $2, 'open')`,
        [job.rows[0].id, 'raw provider payload must not be stored here'],
      ),
      (error) => error.code === '23514',
      'Failure metadata must be a bounded safe code, not a raw error payload',
    );

    await pool.query('DELETE FROM platform.dead_letter_cases WHERE id = $1', [deadLetter.rows[0].id]);
    await pool.query('DELETE FROM platform.durable_jobs WHERE id = $1', [job.rows[0].id]);
  } finally {
    if (outboxIds.length > 0) {
      await pool.query('DELETE FROM platform.inbox_receipts WHERE message_id = ANY($1::uuid[])', [outboxIds]).catch(() => {});
      await pool.query('DELETE FROM platform.dead_letter_cases WHERE event_id = ANY($1::uuid[])', [outboxIds]).catch(() => {});
      await pool.query('DELETE FROM platform.outbox_events WHERE id = ANY($1::uuid[])', [outboxIds]).catch(() => {});
    }
    if (webhookEventIds.length > 0) {
      await pool.query('DELETE FROM platform.webhook_inbox WHERE provider_event_id = ANY($1::text[])', [webhookEventIds]).catch(() => {});
    }
    if (systemEventIds.length > 0) {
      await pool.query('DELETE FROM system_events WHERE id = ANY($1::uuid[])', [systemEventIds]).catch(() => {});
    }
    await pool.end();
  }
});
