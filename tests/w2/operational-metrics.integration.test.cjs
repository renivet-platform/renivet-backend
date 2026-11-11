'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const { DurableWorker } = require('../../dist/workers/durable-worker.js');
const { W2OperationalMetricsReader } = require('../../dist/workers/w2-operational-metrics.js');

const databaseUrl = process.env.RENIVET_TEST_DATABASE_URL;

function assertDisposable(value) {
  assert.ok(value, 'RENIVET_TEST_DATABASE_URL is required');
  const parsed = new URL(value);
  assert.equal(parsed.protocol, 'postgresql:');
  assert.equal(parsed.hostname, '127.0.0.1');
  assert.equal(parsed.pathname, '/renivet_ci');
  assert.equal(parsed.username, 'renivet_ci');
}

test('W2 operational metrics read aggregate database state without returning identifiers', {
  skip: !databaseUrl && 'requires disposable PostgreSQL 16', timeout: 30_000,
}, async () => {
  assertDisposable(databaseUrl);
  const pool = new Pool({ connectionString: databaseUrl, max: 2, connectionTimeoutMillis: 5_000 });
  const jobId = randomUUID();
  const businessKey = randomUUID();
  const jobKind = `ren2_105_metrics_${jobId.replaceAll('-', '').slice(0, 16)}`;
  try {
    const version = Number((await pool.query('SHOW server_version_num')).rows[0].server_version_num);
    assert.ok(version >= 160000 && version < 170000, 'metrics acceptance requires PostgreSQL 16');
    const reader = new W2OperationalMetricsReader(pool);
    const before = await reader.readSnapshot();
    await pool.query(`INSERT INTO platform.durable_jobs(id,job_kind,business_key,state)
      VALUES($1,$2,$3,'pending')`, [jobId, jobKind, businessKey]);
    const after = await reader.readSnapshot();
    assert.equal(after.workers.pendingJobs, before.workers.pendingJobs + 1);
    assert.ok(after.workers.activeJobKinds >= 1);
    assert.equal(JSON.stringify(after).includes(jobId), false);
    assert.equal(JSON.stringify(after).includes(businessKey), false);
    assert.equal(JSON.stringify(after).includes(jobKind), false);
  } finally {
    await pool.query('DELETE FROM platform.durable_jobs WHERE id=$1', [jobId]).catch(() => undefined);
    await pool.end();
  }
});

test('a simulated import worker crash emits a redacted dead-letter alert correlated to its outbox event', {
  skip: !databaseUrl && 'requires disposable PostgreSQL 16', timeout: 30_000,
}, async () => {
  assertDisposable(databaseUrl);
  const pool = new Pool({ connectionString: databaseUrl, max: 4, connectionTimeoutMillis: 5_000 });
  const eventId = randomUUID();
  const aggregateId = randomUUID();
  const eventKey = `ren2-105-import-crash-${eventId}`;
  const logs = [];
  const alerts = [];
  const handler = {
    consumerId: 'imports.retry',
    eventTypes: ['ren2_105.import_crash'],
    authorization: { scope: 'system' },
    async handle() { throw Object.assign(new Error('supplier name=private; signed-url=secret'), { code: 'EAI_AGAIN' }); },
  };
  const worker = new DurableWorker(pool, [handler], {
    maxAttempts: 1, baseRetryDelayMs: 0, maxRetryDelayMs: 0, jitterMs: 0,
    log: (entry) => logs.push(entry), onDeadLetter: (alert) => alerts.push(alert),
  });
  try {
    await pool.query(`INSERT INTO platform.outbox_events(id,aggregate_type,aggregate_id,event_type,event_version,event_payload,event_key)
      VALUES($1,'imports.import_batch',$2,'ren2_105.import_crash',1,'{"synthetic":true}'::jsonb,$3)`, [eventId, aggregateId, eventKey]);
    assert.equal(await worker.enqueueOutboxBatch(), 1);
    assert.deepEqual(await worker.runOnce('imports.retry', `ren2-105-${eventId}`, 1), {
      enqueuedEvents: 0, claimed: 1, processed: 0, duplicate: 0, retry: 0, deadLetter: 1, leaseLost: 0,
    });
    assert.equal(alerts.length, 1);
    assert.deepEqual(alerts[0], {
      jobId: (await pool.query('SELECT id FROM platform.durable_jobs WHERE business_key=$1', [eventId])).rows[0].id,
      jobKind: 'imports.retry', correlationId: eventId, code: 'EAI_AGAIN', attemptCount: 1, maxAttempts: 1,
    });
    assert.ok(logs.some((entry) => entry.event === 'worker.job.failed' && entry.correlationId === eventId && entry.code === 'EAI_AGAIN'));
    assert.doesNotMatch(JSON.stringify({ logs, alerts }), /private|signed-url|secret/);
  } finally {
    const job = await pool.query('SELECT id FROM platform.durable_jobs WHERE business_key=$1', [eventId]).catch(() => ({ rows: [] }));
    if (job.rows[0]) {
      await pool.query('DELETE FROM platform.inbox_receipts WHERE message_id=$1', [eventId]).catch(() => undefined);
      await pool.query('DELETE FROM platform.dead_letter_cases WHERE job_id=$1', [job.rows[0].id]).catch(() => undefined);
      await pool.query('DELETE FROM platform.durable_jobs WHERE id=$1', [job.rows[0].id]).catch(() => undefined);
    }
    await pool.query('DELETE FROM platform.outbox_events WHERE id=$1', [eventId]).catch(() => undefined);
    await pool.end();
  }
});
