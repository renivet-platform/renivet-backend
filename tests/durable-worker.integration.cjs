'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const { DurableWorker } = require('../dist/workers/durable-worker.js');

function disposableUrl() {
  const raw = process.env.RENIVET_TEST_DATABASE_URL;
  assert.ok(raw, 'RENIVET_TEST_DATABASE_URL is required');
  const url = new URL(raw);
  assert.equal(url.protocol, 'postgresql:');
  assert.equal(url.hostname, '127.0.0.1');
  assert.equal(url.pathname, '/renivet_ci');
  assert.equal(url.username, 'renivet_ci');
  return raw;
}

test('REN2-30 claims, dedupes, retries and recovers durable work safely', { timeout: 30_000 }, async () => {
  const pool = new Pool({ connectionString: disposableUrl(), max: 8, connectionTimeoutMillis: 5000 });
  const prefix = `ren2-30-${randomUUID()}`;
  const outboxIds = [];
  const jobIds = [];
  const effectNames = [];
  const userIds = [];
  const caseIds = [];
  const logs = [];
  const failedOnce = new Set();
  let recoveryAuthorized = true;
  const handler = {
    consumerId: 'test-consumer',
    eventTypes: ['test.worker.created'],
    async handle(event, transaction) {
      const effect = `${prefix}:${event.id}:effect`;
      effectNames.push(effect);
      await transaction.query('INSERT INTO system_events (event_name) VALUES ($1)', [effect]);
      if (!failedOnce.has(event.id) && event.eventPayload.failOnce === true) {
        failedOnce.add(event.id);
        throw Object.assign(new Error('OTP 123456 session token=synthetic bank account=synthetic'), { code: 'EAI_AGAIN' });
      }
      if (event.eventPayload.poison === true) throw new Error('raw sensitive provider response should not persist');
    },
  };
  const worker = new DurableWorker(pool, [handler], {
    leaseSeconds: 2,
    maxAttempts: 2,
    baseRetryDelayMs: 1,
    maxRetryDelayMs: 5,
    jitterMs: 0,
    random: () => 0,
    log: (entry) => logs.push(entry),
    authorizeRecovery: async () => recoveryAuthorized,
  });

  async function createEvent(key, payload) {
    const result = await pool.query(
      `INSERT INTO platform.outbox_events
         (aggregate_type, aggregate_id, event_type, event_version, event_payload, event_key)
       VALUES ('test_worker', $1, 'test.worker.created', 1, $2::jsonb, $3) RETURNING id`,
      [randomUUID(), JSON.stringify(payload), `${prefix}:${key}`],
    );
    outboxIds.push(result.rows[0].id);
    return result.rows[0].id;
  }

  try {
    const version = await pool.query('SHOW server_version_num');
    assert.match(version.rows[0].server_version_num, /^16/);

    const basicEventId = await createEvent('basic', { marker: 'synthetic' });
    // A missed wakeup does not lose the committed event: the next poll sees it.
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(await worker.enqueueOutboxBatch(), 1);
    const job = await pool.query(
      `SELECT id FROM platform.durable_jobs WHERE job_kind = 'test-consumer' AND business_key = $1`, [basicEventId],
    );
    jobIds.push(job.rows[0].id);
    const [claimA, claimB] = await Promise.all([
      worker.claim('test-consumer', `${prefix}:worker-a`, 1),
      worker.claim('test-consumer', `${prefix}:worker-b`, 1),
    ]);
    assert.equal(claimA.length + claimB.length, 1, 'two claimers must not own the same job concurrently');
    const claimed = claimA[0] ?? claimB[0];
    const owner = claimA.length ? `${prefix}:worker-a` : `${prefix}:worker-b`;
    assert.equal(await worker.process(claimed, owner), 'processed');

    // Replaying the same delivery after commit is a no-op because its receipt committed with the effect.
    await pool.query(
      `UPDATE platform.durable_jobs SET state = 'pending', attempt_count = 0, scheduled_for = now()
       WHERE id = $1`, [claimed.id],
    );
    const replay = (await worker.claim('test-consumer', `${prefix}:replay`, 1))[0];
    assert.equal(await worker.process(replay, `${prefix}:replay`), 'duplicate');
    const effectCount = await pool.query('SELECT count(*)::int AS count FROM system_events WHERE event_name = $1', [`${prefix}:${basicEventId}:effect`]);
    assert.equal(effectCount.rows[0].count, 1);

    // A failure after the synthetic effect write rolls the effect and receipt back; retry safely applies it once.
    const retryEventId = await createEvent('retry', { failOnce: true });
    await worker.enqueueOutboxBatch();
    const retryJob = await pool.query(`SELECT id FROM platform.durable_jobs WHERE job_kind = 'test-consumer' AND business_key = $1`, [retryEventId]);
    jobIds.push(retryJob.rows[0].id);
    const firstAttempt = (await worker.claim('test-consumer', `${prefix}:retry-a`, 1))[0];
    assert.equal(await worker.process(firstAttempt, `${prefix}:retry-a`), 'retry');
    const rolledBack = await pool.query('SELECT count(*)::int AS count FROM system_events WHERE event_name = $1', [`${prefix}:${retryEventId}:effect`]);
    assert.equal(rolledBack.rows[0].count, 0);
    await pool.query('UPDATE platform.durable_jobs SET scheduled_for = now() - interval \'1 second\' WHERE id = $1', [firstAttempt.id]);
    const secondAttempt = (await worker.claim('test-consumer', `${prefix}:retry-b`, 1))[0];
    assert.equal(await worker.process(secondAttempt, `${prefix}:retry-b`), 'processed');

    // Expired leases are reclaimable after a worker crash.
    const leaseEventId = await createEvent('lease', { marker: 'lease' });
    await worker.enqueueOutboxBatch();
    const leaseJob = await pool.query(`SELECT id FROM platform.durable_jobs WHERE job_kind = 'test-consumer' AND business_key = $1`, [leaseEventId]);
    jobIds.push(leaseJob.rows[0].id);
    const abandoned = (await worker.claim('test-consumer', `${prefix}:crashed`, 1))[0];
    await pool.query(
      `UPDATE platform.durable_jobs
       SET lease_started_at = now() - interval '3 seconds', lease_until = now() - interval '1 second'
       WHERE id = $1`, [abandoned.id],
    );
    const takenOver = (await worker.claim('test-consumer', `${prefix}:restarted`, 1))[0];
    assert.equal(takenOver.id, abandoned.id);
    assert.equal(await worker.process(abandoned, `${prefix}:crashed`), 'lease_lost');
    assert.equal(await worker.process(takenOver, `${prefix}:restarted`), 'processed');

    // Poison work is quarantined, visible, denied to unauthorized operators and auditable when requeued.
    const actorId = randomUUID();
    userIds.push(actorId);
    await pool.query(`INSERT INTO identity.users (id, state) VALUES ($1, 'active')`, [actorId]);
    const poisonEventId = await createEvent('poison', { poison: true, marker: 'synthetic' });
    await worker.enqueueOutboxBatch();
    const poisonJob = await pool.query(`SELECT id FROM platform.durable_jobs WHERE job_kind = 'test-consumer' AND business_key = $1`, [poisonEventId]);
    jobIds.push(poisonJob.rows[0].id);
    for (const attemptName of ['poison-a', 'poison-b']) {
      const poison = (await worker.claim('test-consumer', `${prefix}:${attemptName}`, 1))[0];
      const result = await worker.process(poison, `${prefix}:${attemptName}`);
      assert.equal(result, attemptName === 'poison-a' ? 'retry' : 'dead_letter');
      if (attemptName === 'poison-a') await pool.query('UPDATE platform.durable_jobs SET scheduled_for = now() - interval \'1 second\' WHERE id = $1', [poison.id]);
    }
    const visible = await worker.listDeadLetters();
    const recoveryCase = visible.find((item) => item.jobId === poisonJob.rows[0].id);
    assert.ok(recoveryCase);
    caseIds.push(recoveryCase.id);
    recoveryAuthorized = false;
    await assert.rejects(worker.recoverDeadLetter(recoveryCase.id, actorId, 'OPERATOR_RETRY'), /not authorized/);
    await assert.rejects(
      worker.recoverDeadLetter(recoveryCase.id, actorId, 'OTP_123456'),
      /approved recovery code/,
    );
    recoveryAuthorized = true;
    await worker.recoverDeadLetter(recoveryCase.id, actorId, 'OPERATOR_RETRY');
    const audit = await pool.query('SELECT actor_id, reason_code FROM platform.dead_letter_recovery_audit WHERE case_id = $1', [recoveryCase.id]);
    assert.deepEqual(audit.rows, [{ actor_id: actorId, reason_code: 'OPERATOR_RETRY' }]);
    await assert.rejects(
      pool.query('UPDATE platform.dead_letter_recovery_audit SET reason_code = \'ALTERED\' WHERE case_id = $1', [recoveryCase.id]),
      /append-only/,
    );
    await assert.rejects(
      pool.query('DELETE FROM platform.dead_letter_recovery_audit WHERE case_id = $1', [recoveryCase.id]),
      /append-only/,
    );
    const recovered = await pool.query('SELECT state, attempt_count FROM platform.durable_jobs WHERE id = $1', [poisonJob.rows[0].id]);
    assert.equal(recovered.rows[0].state, 'pending');
    assert.equal(recovered.rows[0].attempt_count, 0);

    const serializedLogs = JSON.stringify(logs);
    assert.doesNotMatch(serializedLogs, /123456|raw sensitive provider response|session token|bank account/i);
    assert.ok(logs.some((entry) => entry.event === 'worker.job.failed' && entry.code === 'EAI_AGAIN'));
  } finally {
    if (caseIds.length) await pool.query('DELETE FROM platform.dead_letter_recovery_audit WHERE case_id = ANY($1::uuid[])', [caseIds]).catch(() => undefined);
    if (caseIds.length) await pool.query('DELETE FROM platform.dead_letter_cases WHERE id = ANY($1::uuid[])', [caseIds]).catch(() => undefined);
    if (jobIds.length) await pool.query('DELETE FROM platform.dead_letter_cases WHERE job_id = ANY($1::uuid[])', [jobIds]).catch(() => undefined);
    if (jobIds.length) await pool.query('DELETE FROM platform.durable_jobs WHERE id = ANY($1::uuid[])', [jobIds]).catch(() => undefined);
    if (outboxIds.length) await pool.query('DELETE FROM platform.inbox_receipts WHERE message_id = ANY($1::uuid[])', [outboxIds]).catch(() => undefined);
    if (outboxIds.length) await pool.query('DELETE FROM platform.outbox_events WHERE id = ANY($1::uuid[])', [outboxIds]).catch(() => undefined);
    if (effectNames.length) await pool.query('DELETE FROM system_events WHERE event_name = ANY($1::text[])', [effectNames]).catch(() => undefined);
    if (userIds.length) await pool.query('DELETE FROM identity.users WHERE id = ANY($1::uuid[])', [userIds]).catch(() => undefined);
    await pool.end();
  }
});
