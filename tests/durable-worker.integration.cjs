'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
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

test('REN2-30/31 claims, crash recovery, observability and audited replay are safe', { timeout: 60_000 }, async () => {
  const pool = new Pool({ connectionString: disposableUrl(), max: 8, connectionTimeoutMillis: 5000 });
  const prefix = `ren2-31-${randomUUID()}`;
  const consumerId = `test_consumer_${randomUUID().replaceAll('-', '')}`;
  const outboxIds = [];
  const effectNames = [];
  const logs = [];
  const metrics = [];
  const alerts = [];
  const failedOnce = new Set();
  const resolvedPoisonEvents = new Set();
  let recoveryAuthorized = true;
  const handler = {
    consumerId,
    eventTypes: ['test.worker.created'],
    authorization: { scope: 'system' },
    async handle(event, transaction) {
      const effect = `${prefix}:${event.id}:effect`;
      effectNames.push(effect);
      await transaction.query('INSERT INTO system_events (event_name) VALUES ($1)', [effect]);
      if (!failedOnce.has(event.id) && event.eventPayload.failOnce === true) {
        failedOnce.add(event.id);
        throw Object.assign(new Error('OTP 123456 session token=synthetic bank account=synthetic'), { code: 'EAI_AGAIN' });
      }
      if (event.eventPayload.poison === true && !resolvedPoisonEvents.has(event.id)) throw new Error('raw sensitive provider response should not persist');
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
    metrics: (summary) => metrics.push(summary),
    onDeadLetter: (alert) => alerts.push(alert),
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

  function exitWorkerProcess(job, mode, effectName) {
    const result = spawnSync(process.execPath, [path.join(__dirname, 'helpers', 'durable-worker-crash-child.cjs')], {
      input: JSON.stringify({ databaseUrl: disposableUrl(), job, mode, effectName }),
      encoding: 'utf8',
      timeout: 15_000,
      windowsHide: true,
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        RENIVET_TEST_DATABASE_URL: disposableUrl(),
      },
    });
    assert.equal(result.error, undefined, result.error?.message);
    return result.status;
  }

  try {
    const version = await pool.query('SHOW server_version_num');
    assert.match(version.rows[0].server_version_num, /^16/);

    const basicEventId = await createEvent('basic', { marker: 'synthetic' });
    // A missed wakeup does not lose the committed event: the next poll sees it.
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(await worker.enqueueOutboxBatch(), 1);
    const job = await pool.query(
      `SELECT id FROM platform.durable_jobs WHERE job_kind = $1 AND business_key = $2`, [consumerId, basicEventId],
    );
    assert.ok(job.rows[0].id);
    const [claimA, claimB] = await Promise.all([
      worker.claim(consumerId, `${prefix}:worker-a`, 1),
      worker.claim(consumerId, `${prefix}:worker-b`, 1),
    ]);
    assert.equal(claimA.length + claimB.length, 1, 'two claimers must not own the same job concurrently');
    const claimed = claimA[0] ?? claimB[0];
    const concurrentResults = await Promise.all([worker.process(claimed), worker.process(claimed)]);
    assert.deepEqual(concurrentResults.sort(), ['lease_lost', 'processed']);

    // Replaying the same delivery after commit is a no-op because its receipt committed with the effect.
    await pool.query(
      `UPDATE platform.durable_jobs SET state = 'pending', attempt_count = 0, scheduled_for = now()
       WHERE id = $1`, [claimed.id],
    );
    const replay = (await worker.claim(consumerId, `${prefix}:replay`, 1))[0];
    assert.equal(await worker.process(replay), 'duplicate');
    const effectCount = await pool.query('SELECT count(*)::int AS count FROM system_events WHERE event_name = $1', [`${prefix}:${basicEventId}:effect`]);
    assert.equal(effectCount.rows[0].count, 1);

    // A real child-process exit while the DB transaction is open rolls back effect and receipt.
    const crashBeforeEventId = await createEvent('crash-before-commit', { marker: 'synthetic' });
    await worker.enqueueOutboxBatch();
    const crashBeforeJob = (await worker.claim(consumerId, `${prefix}:crash-before`, 1))[0];
    const crashBeforeEffect = `${prefix}:${crashBeforeEventId}:effect`;
    effectNames.push(crashBeforeEffect);
    assert.equal(exitWorkerProcess(crashBeforeJob, 'before_commit', crashBeforeEffect), 71);
    const crashBeforeState = await pool.query(
      `SELECT job.state, receipt.id AS receipt_id FROM platform.durable_jobs AS job
       LEFT JOIN platform.inbox_receipts AS receipt ON receipt.consumer_id = job.job_kind AND receipt.message_id = job.business_key::uuid
       WHERE job.id = $1`, [crashBeforeJob.id],
    );
    assert.equal(crashBeforeState.rows[0].state, 'leased');
    assert.equal(crashBeforeState.rows[0].receipt_id, null);
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM system_events WHERE event_name = $1', [crashBeforeEffect])).rows[0].count, 0);
    await pool.query(
      `UPDATE platform.durable_jobs SET lease_started_at = now() - interval '3 seconds',
       lease_until = now() - interval '1 second' WHERE id = $1`, [crashBeforeJob.id],
    );
    const restartedBefore = await worker.runOnce(consumerId, `${prefix}:restart-before`, 1);
    assert.equal(restartedBefore.processed, 1);
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM system_events WHERE event_name = $1', [crashBeforeEffect])).rows[0].count, 1);

    // Exit immediately after process() commits: restart observes terminal success and does not repeat the effect.
    const crashAfterEventId = await createEvent('crash-after-commit', { marker: 'synthetic' });
    await worker.enqueueOutboxBatch();
    const crashAfterJob = (await worker.claim(consumerId, `${prefix}:crash-after`, 1))[0];
    const crashAfterEffect = `${prefix}:${crashAfterEventId}:effect`;
    effectNames.push(crashAfterEffect);
    assert.equal(exitWorkerProcess(crashAfterJob, 'after_commit', crashAfterEffect), 72);
    const crashAfterState = await pool.query('SELECT state FROM platform.durable_jobs WHERE id = $1', [crashAfterJob.id]);
    assert.equal(crashAfterState.rows[0].state, 'succeeded');
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM system_events WHERE event_name = $1', [crashAfterEffect])).rows[0].count, 1);
    assert.equal((await worker.runOnce(consumerId, `${prefix}:restart-after`, 1)).claimed, 0);

    // A failure after the synthetic effect write rolls the effect and receipt back; retry safely applies it once.
    const retryEventId = await createEvent('retry', { failOnce: true });
    await worker.enqueueOutboxBatch();
    const retryJob = await pool.query(`SELECT id FROM platform.durable_jobs WHERE job_kind = $1 AND business_key = $2`, [consumerId, retryEventId]);
    assert.ok(retryJob.rows[0].id);
    const firstAttempt = (await worker.claim(consumerId, `${prefix}:retry-a`, 1))[0];
    assert.equal(await worker.process(firstAttempt), 'retry');
    const rolledBack = await pool.query('SELECT count(*)::int AS count FROM system_events WHERE event_name = $1', [`${prefix}:${retryEventId}:effect`]);
    assert.equal(rolledBack.rows[0].count, 0);
    await pool.query('UPDATE platform.durable_jobs SET scheduled_for = now() - interval \'1 second\' WHERE id = $1', [firstAttempt.id]);
    const secondAttempt = (await worker.claim(consumerId, `${prefix}:retry-b`, 1))[0];
    assert.equal(await worker.process(secondAttempt), 'processed');

    // A later runOnce poll discovers already-committed work after a missed wakeup.
    await createEvent('missed-wakeup', { marker: 'synthetic' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(await worker.runOnce(consumerId, `${prefix}:poll`, 1), {
      enqueuedEvents: 1,
      claimed: 1,
      processed: 1,
      duplicate: 0,
      retry: 0,
      deadLetter: 0,
      leaseLost: 0,
    });
    assert.ok(metrics.some((entry) => entry.enqueuedEvents === 1 && entry.processed === 1), 'batch metrics report recovered work');

    // Broken telemetry sinks cannot change a durable result after it commits.
    const telemetryEventId = await createEvent('telemetry-sink-failure', { marker: 'synthetic' });
    const telemetryWorker = new DurableWorker(pool, [handler], {
      log: () => { throw new Error('sink must not affect job outcome'); },
      metrics: () => { throw new Error('metrics sink must not affect job outcome'); },
    });
    assert.equal((await telemetryWorker.runOnce(consumerId, `${prefix}:telemetry`, 1)).processed, 1);
    assert.ok(telemetryEventId);

    // Expired leases are reclaimable after a worker crash.
    const leaseEventId = await createEvent('lease', { marker: 'lease' });
    await worker.enqueueOutboxBatch();
    const leaseJob = await pool.query(`SELECT id FROM platform.durable_jobs WHERE job_kind = $1 AND business_key = $2`, [consumerId, leaseEventId]);
    assert.ok(leaseJob.rows[0].id);
    const reusedWorkerId = `${prefix}:reused-worker`;
    const abandoned = (await worker.claim(consumerId, reusedWorkerId, 1))[0];
    await pool.query(
      `UPDATE platform.durable_jobs
       SET lease_started_at = now() - interval '3 seconds', lease_until = now() - interval '1 second'
       WHERE id = $1`, [abandoned.id],
    );
    const takenOver = (await worker.claim(consumerId, reusedWorkerId, 1))[0];
    assert.equal(takenOver.id, abandoned.id);
    assert.notEqual(takenOver.leaseToken, abandoned.leaseToken, 'a takeover must issue a fresh fencing token even when the worker ID is reused');
    assert.equal(await worker.process(abandoned), 'lease_lost');
    assert.equal(await worker.process(takenOver), 'processed');

    // Poison work is quarantined, visible, denied to unauthorized operators and auditable when requeued.
    const actorId = randomUUID();
    await pool.query(`INSERT INTO identity.users (id, state) VALUES ($1, 'active')`, [actorId]);
    const poisonEventId = await createEvent('poison', { poison: true, marker: 'synthetic' });
    await worker.enqueueOutboxBatch();
    const poisonJob = await pool.query(`SELECT id FROM platform.durable_jobs WHERE job_kind = $1 AND business_key = $2`, [consumerId, poisonEventId]);
    await pool.query('UPDATE platform.durable_jobs SET max_attempts = 1 WHERE id = $1', [poisonJob.rows[0].id]);
    const poison = (await worker.claim(consumerId, `${prefix}:poison`, 1))[0];
    const stalePoisonData = { ...poison, businessKey: 'private-supplied-correlation', attemptCount: 0, maxAttempts: 5 };
    assert.equal(await worker.process(stalePoisonData), 'dead_letter', 'retry decisions must use the stored final attempt count');
    const visible = await worker.listDeadLetters();
    const recoveryCase = visible.find((item) => item.jobId === poisonJob.rows[0].id);
    assert.ok(recoveryCase);
    assert.equal(recoveryCase.state, 'dead_letter');
    assert.equal(recoveryCase.attemptCount, 1);
    assert.equal(recoveryCase.maxAttempts, 1);
    assert.equal(recoveryCase.lastErrorCode, 'WORKER_FAILURE');
    recoveryAuthorized = false;
    await assert.rejects(worker.recoverDeadLetter(recoveryCase.id, actorId, 'OPERATOR_RETRY'), /not authorized/);
    await assert.rejects(
      worker.recoverDeadLetter(recoveryCase.id, actorId, 'OTP_123456'),
      /approved recovery code/,
    );
    recoveryAuthorized = true;
    await worker.recoverDeadLetter(recoveryCase.id, actorId, 'OPERATOR_RETRY');
    resolvedPoisonEvents.add(poisonEventId);
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
    assert.equal((await worker.runOnce(consumerId, `${prefix}:recovery`, 1)).processed, 1);
    await pool.query(
      `UPDATE platform.durable_jobs SET state = 'pending', attempt_count = 0, scheduled_for = now()
       WHERE id = $1`, [poisonJob.rows[0].id],
    );
    const recoveryReplay = (await worker.claim(consumerId, `${prefix}:replay-recovered`, 1))[0];
    assert.ok(recoveryReplay);
    assert.equal(await worker.process(recoveryReplay), 'duplicate');
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM system_events WHERE event_name = $1', [`${prefix}:${poisonEventId}:effect`])).rows[0].count, 1);

    const serializedLogs = JSON.stringify(logs);
    assert.doesNotMatch(serializedLogs, /123456|raw sensitive provider response|session token|bank account/i);
    assert.ok(logs.some((entry) => entry.event === 'worker.job.failed' && entry.code === 'EAI_AGAIN' && entry.traceId && entry.correlationId && entry.attemptCount === 1));
    assert.ok(logs.some((entry) => entry.event === 'worker.job.failed' && entry.jobId === poisonJob.rows[0].id && entry.attemptCount === 1 && entry.maxAttempts === 1), 'attempt telemetry comes from durable state, not the supplied claim object');
    assert.ok(logs.some((entry) => entry.event === 'worker.job.failed' && entry.jobId === poisonJob.rows[0].id && entry.correlationId === poisonEventId),
      'correlation telemetry comes from the persisted outbox link, not the supplied claim object');
    assert.ok(alerts.some((entry) => entry.jobId === poisonJob.rows[0].id && entry.correlationId === poisonEventId));
    assert.ok(logs.some((entry) => entry.event === 'worker.dead_letter.recovered' && entry.traceId === poisonJob.rows[0].id && entry.correlationId === poisonEventId));
    assert.doesNotMatch(JSON.stringify(metrics), /123456|raw sensitive provider response|session token|bank account/i);
  } finally {
    // The append-only audit intentionally keeps its synthetic actor, case and job in this disposable DB.
    if (outboxIds.length) await pool.query('DELETE FROM platform.inbox_receipts WHERE message_id = ANY($1::uuid[])', [outboxIds]).catch(() => undefined);
    if (outboxIds.length) await pool.query('DELETE FROM platform.outbox_events WHERE id = ANY($1::uuid[])', [outboxIds]).catch(() => undefined);
    if (effectNames.length) await pool.query('DELETE FROM system_events WHERE event_name = ANY($1::text[])', [effectNames]).catch(() => undefined);
    await pool.end();
  }
});
