# Durable background work

`DurableWorker` provides the PostgreSQL processing primitives for W1-C2. It is deliberately not registered with `AppModule`, and no scheduler, timer, provider adapter or production job handler is activated. PostgreSQL remains the durable source of truth; the future scheduler only needs to call `enqueueOutboxBatch()` and wake the registered handlers.

## Processing and recovery behavior

- Committed `platform.outbox_events` are locked with `FOR UPDATE SKIP LOCKED` and transactionally converted into one `platform.durable_jobs` row per matching consumer. The outbox row is marked delivered in that same transaction. Unsupported event types remain pending.
- Consumers claim due or expired work with `FOR UPDATE SKIP LOCKED`. Leases are bounded to five minutes; attempt count is bounded by the schema's maximum of five.
- The consumer's `platform.inbox_receipts` row, internal domain effect and successful job transition share one PostgreSQL transaction. A crash rolls all three back; a replay after commit sees the receipt and does not reapply the effect.
- Failures store only a safe error code and use capped exponential backoff with jitter. Exhausted work enters `dead_letter`; `listDeadLetters()` exposes only IDs and safe reason codes.
- `recoverDeadLetter()` requires an authorization callback to allow the actor/case pair and fails closed when none is configured. The requeue, case transition and `platform.dead_letter_recovery_audit` insert are atomic. Callers must connect this callback to the approved operator authorization system before exposing recovery to any user or service.
- Logs contain consumer/job kind, job/case/actor IDs, attempt count, outcome and safe error/reason codes. They never include payloads or exception messages.

## Operator recovery runbook

1. Confirm the running code version and the relevant consumer is explicitly registered. No worker is activated by this repository's default application startup.
2. Inspect open cases with the worker's `listDeadLetters()` operation. Use the job/case IDs and reason code to locate safe structured logs; do not print event payloads or raw errors.
3. Investigate and correct the underlying internal failure before requeueing. Do not use manual SQL updates to clear a lease, reset attempts, or alter receipts.
4. Invoke `recoverDeadLetter(caseId, actorId, reasonCode, authorize)` only from an operator path whose authorization callback independently verifies the actor's permission. Record a bounded reason code. The transaction persists actor, case, reason and timestamp in `platform.dead_letter_recovery_audit` with the requeue.
5. Verify a subsequent worker claim and the consumer's idempotent effect. External HTTP delivery is at-least-once only; use provider-supported idempotency and independent reconciliation. Never implement seller bank transfers in these workers.

The recovery audit is retained with its case/actor foreign keys. No retention/deletion schedule is defined yet; cleanup requires an approved retention policy. Tenant/brand scope must be resolved from authoritative domain records by each future event handler and must never be trusted solely from event payload data.

## Testing

Pure retry/error-code policy tests run with `npm test`. PostgreSQL claim, concurrency, replay, rollback, lease expiry, poison-job and operator recovery tests run only against disposable PostgreSQL 16 using `RENIVET_TEST_DATABASE_URL`; CI provisions and destroys that service for each run. Never point the integration suite at a shared, staging or production database. No provider or external HTTP calls are made by these tests.
