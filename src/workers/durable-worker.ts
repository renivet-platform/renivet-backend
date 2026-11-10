import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { BrandWorkerPolicy, WorkerAuthorizationContext, WorkerAuthorizationPort } from './worker-authorization';

const MAX_LEASE_SECONDS = 300;
const DEFAULT_MAX_ATTEMPTS = 5;
const SAFE_FAILURE_CODES = new Set(['EAI_AGAIN', 'ECONNRESET', 'ETIMEDOUT', 'EVENT_NOT_FOUND', 'LEASE_EXPIRED',
  'CHECKOUT_ELIGIBLE_HEAD_NOT_READY']);
const SAFE_RECOVERY_REASONS = new Set(['OPERATOR_RETRY', 'DATA_CORRECTED', 'DEPENDENCY_RESTORED']);

export type RetryOptions = {
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitterMs?: number;
  random?: () => number;
};

export function calculateRetryDelayMs(attempt: number, options: RetryOptions = {}): number {
  if (!Number.isInteger(attempt) || attempt < 1) throw new RangeError('attempt must be a positive integer');
  const base = options.baseDelayMs ?? 1_000;
  const cap = options.maxDelayMs ?? 300_000;
  const jitter = options.jitterMs ?? 1_000;
  const random = options.random ?? Math.random;
  if (!Number.isSafeInteger(base) || base < 0 || !Number.isSafeInteger(cap) || cap < base ||
      !Number.isSafeInteger(jitter) || jitter < 0) throw new RangeError('retry delays must be non-negative integers and maxDelayMs must be >= baseDelayMs');
  const sample = random();
  if (!Number.isFinite(sample) || sample < 0 || sample >= 1) throw new RangeError('random must return a value in [0, 1)');
  const exponential = Math.min(cap, base * (2 ** Math.min(attempt - 1, 52)));
  return Math.min(cap, exponential + Math.floor(sample * (jitter + 1)));
}

export function safeFailureCode(error: unknown): string {
  const object = error && typeof error === 'object' ? error as { code?: unknown; response?: unknown } : undefined;
  const response = object?.response && typeof object.response === 'object' ? object.response as { code?: unknown } : undefined;
  const code = object?.code ?? response?.code;
  return typeof code === 'string' && SAFE_FAILURE_CODES.has(code)
    ? code
    : 'WORKER_FAILURE';
}

export type DurableEvent = {
  id: string;
  eventType: string;
  eventVersion: number;
  aggregateType: string;
  aggregateId: string;
  eventPayload: unknown;
};

export type DurableJob = {
  id: string;
  jobKind: string;
  businessKey: string;
  attemptCount: number;
  maxAttempts: number;
  leaseToken: string;
};

export type EventHandler = {
  consumerId: string;
  eventTypes: readonly string[];
  authorization: Readonly<{ scope: 'system' }> | Readonly<{ scope: 'brand'; purpose: string; effects: readonly string[] }>;
  handle(event: DurableEvent, transaction: PoolClient, authorization?: WorkerAuthorizationContext): Promise<void>;
};

export type WorkerLog = (entry: Readonly<Record<string, string | number>>) => void;
export type WorkerMetrics = (summary: Readonly<WorkerBatchSummary>) => void;
export type DeadLetterAlert = (details: Readonly<{ jobId: string; jobKind: string; code: string; attemptCount: number; maxAttempts: number }>) => void | Promise<void>;

export type RecoveryAuthorizer = (actorId: string, caseId: string) => Promise<boolean>;

export type WorkerBatchSummary = {
  enqueuedEvents: number;
  claimed: number;
  processed: number;
  duplicate: number;
  retry: number;
  deadLetter: number;
  leaseLost: number;
};

export class DurableWorker {
  constructor(
    private readonly pool: Pool,
    private readonly handlers: readonly EventHandler[],
    private readonly options: {
      leaseSeconds?: number;
      maxAttempts?: number;
      baseRetryDelayMs?: number;
      maxRetryDelayMs?: number;
      jitterMs?: number;
      random?: () => number;
      log?: WorkerLog;
      metrics?: WorkerMetrics;
      onDeadLetter?: DeadLetterAlert;
      authorizeRecovery?: RecoveryAuthorizer;
      workerAuthorization?: WorkerAuthorizationPort;
    } = {},
  ) {
    const leaseSeconds = options.leaseSeconds ?? 60;
    if (!Number.isInteger(leaseSeconds) || leaseSeconds < 1 || leaseSeconds > MAX_LEASE_SECONDS) {
      throw new RangeError(`leaseSeconds must be between 1 and ${MAX_LEASE_SECONDS}`);
    }
    const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > DEFAULT_MAX_ATTEMPTS) {
      throw new RangeError(`maxAttempts must be between 1 and ${DEFAULT_MAX_ATTEMPTS}`);
    }
    if (new Set(handlers.map((handler) => handler.consumerId)).size !== handlers.length ||
        handlers.some((handler) => !/^[a-z][a-z0-9._-]{0,63}$/.test(handler.consumerId) ||
          handler.eventTypes.length === 0 || handler.eventTypes.some((type) => !/^[a-z][a-z0-9._-]{0,127}$/.test(type)))) {
      throw new TypeError('consumerId values must be unique safe identifiers');
    }
    if (handlers.some((handler) => !handler.authorization || !['system', 'brand'].includes(handler.authorization.scope))) {
      throw new TypeError('every consumer must declare an authorization scope');
    }
    if (handlers.some((handler) => handler.authorization?.scope === 'brand' &&
      (!options.workerAuthorization || typeof options.workerAuthorization.bindJob !== 'function' ||
        typeof options.workerAuthorization.authorize !== 'function'))) {
      throw new TypeError('brand-scoped consumers require a worker authorization provider');
    }
    if (handlers.some((handler) => handler.authorization?.scope === 'brand' &&
      (typeof handler.authorization.purpose !== 'string' || !/^[a-z][a-z0-9._-]{0,127}$/.test(handler.authorization.purpose) ||
        !Array.isArray(handler.authorization.effects) || handler.authorization.effects.length === 0 || handler.authorization.effects.length > 32 ||
        handler.authorization.effects.some((effect) => typeof effect !== 'string' || !/^[a-z][a-z0-9._-]{0,127}$/.test(effect)) ||
        new Set(handler.authorization.effects).size !== handler.authorization.effects.length))) {
      throw new TypeError('brand-scoped consumers must declare a purpose and permitted effects');
    }
  }

  /** Turn committed outbox records into one durable job per registered consumer. */
  async enqueueOutboxBatch(limit = 100): Promise<number> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) throw new RangeError('limit must be between 1 and 1000');
    if (this.handlers.length === 0) return 0;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const events = await client.query<DurableEvent>(
        `SELECT id, event_type AS "eventType", event_version AS "eventVersion",
                aggregate_type AS "aggregateType", aggregate_id AS "aggregateId", event_payload AS "eventPayload"
         FROM platform.outbox_events
         WHERE delivered_at IS NULL AND event_type = ANY($2::text[])
         ORDER BY occurred_at, id
         LIMIT $1
         FOR UPDATE SKIP LOCKED
         `, [limit, [...new Set(this.handlers.flatMap((handler) => handler.eventTypes))]],
      );
      let enqueuedEvents = 0;
      for (const event of events.rows) {
        const matchingHandlers = this.handlers.filter((handler) => handler.eventTypes.includes(event.eventType));
        if (matchingHandlers.length === 0) continue;
        for (const handler of matchingHandlers) {
          const inserted = await client.query<{ id: string }>(
            `INSERT INTO platform.durable_jobs (job_kind, business_key, max_attempts)
             VALUES ($1, $2, $3) ON CONFLICT (job_kind, business_key) DO NOTHING RETURNING id`,
            [handler.consumerId, event.id, this.options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS],
          );
          const jobId = inserted.rows[0]?.id ?? (await client.query<{ id: string }>(
            'SELECT id FROM platform.durable_jobs WHERE job_kind = $1 AND business_key = $2', [handler.consumerId, event.id],
          )).rows[0]?.id;
          if (!jobId) throw new Error('durable job could not be resolved');
          if (handler.authorization.scope === 'brand') {
            const policy: BrandWorkerPolicy = { purpose: handler.authorization.purpose, effects: handler.authorization.effects };
            await this.options.workerAuthorization!.bindJob(
              { jobId, consumerId: handler.consumerId, event, policy }, client,
            );
          }
        }
        await client.query(
          'UPDATE platform.outbox_events SET delivered_at = now(), updated_at = now() WHERE id = $1',
          [event.id],
        );
        enqueuedEvents += 1;
      }
      await client.query('COMMIT');
      return enqueuedEvents;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /** Claim pending or expired jobs for a specific consumer without blocking other workers. */
  async claim(consumerId: string, workerId = randomUUID(), limit = 10): Promise<DurableJob[]> {
    const handler = this.handlers.find((item) => item.consumerId === consumerId);
    if (!handler) throw new TypeError('consumerId is not registered');
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(workerId)) throw new TypeError('workerId is invalid');
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new RangeError('limit must be between 1 and 100');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `WITH exhausted AS (
           SELECT id FROM platform.durable_jobs
           WHERE job_kind = $1 AND state = 'leased' AND lease_until <= now() AND attempt_count >= max_attempts
           FOR UPDATE SKIP LOCKED
         ), dead AS (
           UPDATE platform.durable_jobs AS job
           SET state = 'dead_letter', lease_until = NULL, lease_owner = NULL,
               lease_started_at = NULL, updated_at = now(), row_version = row_version + 1,
               last_error_code = 'LEASE_EXPIRED'
           FROM exhausted WHERE job.id = exhausted.id
           RETURNING job.id, job.last_error_code
         )
         INSERT INTO platform.dead_letter_cases (job_id, reason_code)
         SELECT id, last_error_code FROM dead
         ON CONFLICT DO NOTHING`, [consumerId],
      );
      const claimed = await client.query<DurableJob>(
        `WITH candidates AS (
           SELECT id FROM platform.durable_jobs
           WHERE job_kind = $1 AND attempt_count < max_attempts
             AND ((state = 'pending' AND scheduled_for <= now()) OR (state = 'leased' AND lease_until <= now()))
           ORDER BY scheduled_for, id
           LIMIT $2 FOR UPDATE SKIP LOCKED
         )
         UPDATE platform.durable_jobs AS job
         SET state = 'leased', lease_owner = $3 || ':' || gen_random_uuid()::text, lease_started_at = now(),
             lease_until = now() + ($4::integer * interval '1 second'),
             attempt_count = attempt_count + 1, updated_at = now(), row_version = row_version + 1
         FROM candidates WHERE job.id = candidates.id
         RETURNING job.id, job.job_kind AS "jobKind", job.business_key AS "businessKey",
                   job.attempt_count AS "attemptCount", job.max_attempts AS "maxAttempts",
                   job.lease_owner AS "leaseToken"`,
        [consumerId, limit, workerId, this.options.leaseSeconds ?? 60],
      );
      await client.query('COMMIT');
      return claimed.rows;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /** Run one bounded polling cycle; callers decide when to wake the dormant worker. */
  async runOnce(consumerId: string, workerId = randomUUID(), limit = 10): Promise<WorkerBatchSummary> {
    if (!this.handlers.some((handler) => handler.consumerId === consumerId)) {
      throw new TypeError('consumerId is not registered');
    }
    const enqueuedEvents = await this.enqueueOutboxBatch();
    const jobs = await this.claim(consumerId, workerId, limit);
    const summary: WorkerBatchSummary = {
      enqueuedEvents,
      claimed: jobs.length,
      processed: 0,
      duplicate: 0,
      retry: 0,
      deadLetter: 0,
      leaseLost: 0,
    };
    for (const job of jobs) {
      const result = await this.process(job);
      if (result === 'processed') summary.processed += 1;
      else if (result === 'duplicate') summary.duplicate += 1;
      else if (result === 'retry') summary.retry += 1;
      else if (result === 'dead_letter') summary.deadLetter += 1;
      else summary.leaseLost += 1;
    }
    try {
      this.options.metrics?.(Object.freeze({ ...summary }));
    } catch {
      // Telemetry is best-effort and must never change durable processing outcomes.
    }
    return summary;
  }

  private safeLog(entry: Readonly<Record<string, string | number>>): void {
    try {
      this.options.log?.(Object.freeze({ ...entry }));
    } catch {
      // A logging sink cannot turn a committed job into a retry or hide its outcome.
    }
  }

  async process(job: DurableJob): Promise<'processed' | 'duplicate' | 'lease_lost' | 'retry' | 'dead_letter'> {
    const handler = this.handlers.find((item) => item.consumerId === job.jobKind);
    if (!handler) throw new TypeError('job kind is not registered');
    const client = await this.pool.connect();
    let outcome: 'processed' | 'duplicate' | 'lease_lost' = 'lease_lost';
    let attemptCount = job.attemptCount;
    let maxAttempts = job.maxAttempts;
    try {
      await client.query('BEGIN');
      const current = await client.query(
        `SELECT id, business_key, attempt_count AS "attemptCount", max_attempts AS "maxAttempts" FROM platform.durable_jobs
         WHERE id = $1 AND job_kind = $2 AND state = 'leased' AND lease_owner = $3 AND lease_until > now()
         FOR UPDATE`, [job.id, job.jobKind, job.leaseToken],
      );
      if (current.rowCount === 1) {
        attemptCount = Number(current.rows[0].attemptCount);
        maxAttempts = Number(current.rows[0].maxAttempts);
        const event = await client.query<DurableEvent>(
          `SELECT id, event_type AS "eventType", event_version AS "eventVersion",
                  aggregate_type AS "aggregateType", aggregate_id AS "aggregateId", event_payload AS "eventPayload"
           FROM platform.outbox_events WHERE id = $1 FOR SHARE`, [current.rows[0].business_key],
        );
        if (event.rowCount !== 1) throw Object.assign(new Error('event missing'), { code: 'EVENT_NOT_FOUND' });
        const receipt = await client.query(
          `INSERT INTO platform.inbox_receipts (consumer_id, message_id, event_version)
           VALUES ($1, $2, $3) ON CONFLICT (consumer_id, message_id) DO NOTHING RETURNING id`,
          [job.jobKind, event.rows[0].id, event.rows[0].eventVersion],
        );
        if (receipt.rowCount === 1) {
          let authorization: WorkerAuthorizationContext | undefined;
          if (handler.authorization.scope === 'brand') {
            const policy: BrandWorkerPolicy = { purpose: handler.authorization.purpose, effects: handler.authorization.effects };
            authorization = await this.options.workerAuthorization!.authorize(
              { job, event: event.rows[0], policy }, client,
            );
          }
          await handler.handle(event.rows[0], client, authorization);
        }
        const completed = await client.query(
          `UPDATE platform.durable_jobs SET state = 'succeeded', lease_until = NULL,
             lease_owner = NULL, lease_started_at = NULL, updated_at = now(), row_version = row_version + 1
           WHERE id = $1 AND state = 'leased' AND lease_owner = $2 RETURNING id`, [job.id, job.leaseToken],
        );
        if (completed.rowCount === 1) outcome = receipt.rowCount === 1 ? 'processed' : 'duplicate';
      }
      await client.query('COMMIT');
      if (outcome !== 'lease_lost') this.safeLog({ event: 'worker.job.completed', traceId: job.id, jobId: job.id, jobKind: job.jobKind, outcome, attemptCount, maxAttempts, state: 'succeeded' });
      return outcome;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      const failure = await this.recordFailure(job, error);
      this.safeLog({ event: 'worker.job.failed', traceId: job.id, jobId: job.id, jobKind: job.jobKind, code: safeFailureCode(error), outcome: failure, attemptCount, maxAttempts, state: failure });
      if (failure === 'dead_letter') {
        try { await this.options.onDeadLetter?.({ jobId: job.id, jobKind: job.jobKind, code: safeFailureCode(error), attemptCount, maxAttempts }); }
        catch { this.safeLog({ event: 'worker.dead_letter.alert_failed', traceId: job.id, jobId: job.id, jobKind: job.jobKind, code: 'ALERT_SINK_UNAVAILABLE' }); }
      }
      return failure;
    } finally {
      client.release();
    }
  }

  private async recordFailure(job: DurableJob, error: unknown): Promise<'lease_lost' | 'retry' | 'dead_letter'> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const code = safeFailureCode(error);
      const current = await client.query(
        `SELECT attempt_count AS "attemptCount", max_attempts AS "maxAttempts"
         FROM platform.durable_jobs
         WHERE id = $1 AND state = 'leased' AND lease_owner = $2 AND lease_until > now()
         FOR UPDATE`, [job.id, job.leaseToken],
      );
      if (current.rowCount !== 1) {
        await client.query('ROLLBACK');
        return 'lease_lost';
      }
      const attemptCount = current.rows[0].attemptCount as number;
      const maxAttempts = current.rows[0].maxAttempts as number;
      const retry = attemptCount < maxAttempts;
      const delayMs = retry ? calculateRetryDelayMs(attemptCount, {
        baseDelayMs: this.options.baseRetryDelayMs,
        maxDelayMs: this.options.maxRetryDelayMs,
        jitterMs: this.options.jitterMs,
        random: this.options.random,
      }) : 0;
      const result = await client.query(
        `UPDATE platform.durable_jobs SET state = $3,
           scheduled_for = CASE WHEN $3 = 'pending' THEN now() + ($4::double precision * interval '1 millisecond') ELSE scheduled_for END,
           lease_until = NULL, lease_owner = NULL, lease_started_at = NULL,
           last_error_code = $5, updated_at = now(), row_version = row_version + 1
         WHERE id = $1 AND state = 'leased' AND lease_owner = $2 AND lease_until > now()
         RETURNING id`, [job.id, job.leaseToken, retry ? 'pending' : 'dead_letter', delayMs, code],
      );
      if (result.rowCount !== 1) {
        await client.query('ROLLBACK');
        return 'lease_lost';
      }
      if (!retry) {
        await client.query(
          `INSERT INTO platform.dead_letter_cases (job_id, reason_code)
           SELECT $1, $2 WHERE NOT EXISTS (
             SELECT 1 FROM platform.dead_letter_cases WHERE job_id = $1 AND state = 'open'
           )`, [job.id, code],
        );
      }
      await client.query('COMMIT');
      return retry ? 'retry' : 'dead_letter';
    } catch (failure) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw failure;
    } finally {
      client.release();
    }
  }

  async listDeadLetters(limit = 100): Promise<Array<{ id: string; jobId: string | null; reasonCode: string; createdAt: Date; state: string | null; attemptCount: number | null; maxAttempts: number | null; lastErrorCode: string | null }>> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new RangeError('limit must be between 1 and 500');
    const result = await this.pool.query(
      `SELECT dead.id, dead.job_id AS "jobId", dead.reason_code AS "reasonCode", dead.created_at AS "createdAt",
              job.state, job.attempt_count AS "attemptCount", job.max_attempts AS "maxAttempts",
              job.last_error_code AS "lastErrorCode"
       FROM platform.dead_letter_cases AS dead
       LEFT JOIN platform.durable_jobs AS job ON job.id = dead.job_id
       WHERE dead.state = 'open' ORDER BY dead.created_at, dead.id LIMIT $1`, [limit],
    );
    return result.rows;
  }

  async recoverDeadLetter(
    caseId: string,
    actorId: string,
    reasonCode: string,
  ): Promise<void> {
    if (!SAFE_RECOVERY_REASONS.has(reasonCode)) throw new TypeError('reasonCode must be an approved recovery code');
    if (!this.options.authorizeRecovery || !await this.options.authorizeRecovery(actorId, caseId)) {
      throw new Error('operator is not authorized to recover this job');
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const item = await client.query(
        `SELECT id, job_id FROM platform.dead_letter_cases WHERE id = $1 AND state = 'open' FOR UPDATE`, [caseId],
      );
      if (item.rowCount !== 1 || !item.rows[0].job_id) throw new Error('open job recovery case was not found');
      const job = await client.query(
        `UPDATE platform.durable_jobs SET state = 'pending', scheduled_for = now(), attempt_count = 0,
           max_attempts = $2, last_error_code = NULL, updated_at = now(), row_version = row_version + 1
         WHERE id = $1 AND state = 'dead_letter' RETURNING id`,
        [item.rows[0].job_id, this.options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS],
      );
      if (job.rowCount !== 1) throw new Error('job is not in a recoverable state');
      await client.query(
        `INSERT INTO platform.dead_letter_recovery_audit (case_id, actor_id, reason_code)
         VALUES ($1, $2, $3)`, [caseId, actorId, reasonCode],
      );
      await client.query(
        `UPDATE platform.dead_letter_cases SET state = 'requeued', assigned_to_id = $2,
           updated_at = now(), row_version = row_version + 1 WHERE id = $1`, [caseId, actorId],
      );
      await client.query('COMMIT');
      this.safeLog({ event: 'worker.dead_letter.recovered', traceId: String(item.rows[0].job_id), jobId: String(item.rows[0].job_id), caseId, actorId, reasonCode, state: 'pending' });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}
