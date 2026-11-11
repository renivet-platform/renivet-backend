# Durable background work

`DurableWorker` provides the PostgreSQL processing primitives for W1-C2. It is deliberately not registered with `AppModule`, and no scheduler, timer, provider adapter or production job handler is activated. PostgreSQL remains the durable source of truth; a future scheduler can call `runOnce()` for each registered consumer as a wakeup. A missed scheduler tick is safe because committed work remains in PostgreSQL for the next poll.

## Processing and recovery behavior

- Committed `platform.outbox_events` are locked with `FOR UPDATE SKIP LOCKED` and transactionally converted into one `platform.durable_jobs` row per matching consumer. The outbox row is marked delivered in that same transaction. Unsupported event types remain pending.
- Consumers claim due or expired work with `FOR UPDATE SKIP LOCKED`. Leases are bounded to five minutes; attempt count is bounded by the schema's maximum of five.
- `claim()` returns a per-claim random fencing token as `leaseToken`. Pass the returned claim object to `process()` unchanged; stale claims are rejected even when a restarted process reuses the same worker ID. Never log or expose lease tokens.
- The consumer's `platform.inbox_receipts` row, internal domain effect and successful job transition share one PostgreSQL transaction. A crash rolls all three back; a replay after commit sees the receipt and does not reapply the effect.
- Failures store only a safe error code and use capped exponential backoff with jitter. Exhausted work enters `dead_letter`; `listDeadLetters()` exposes IDs, state, attempt limits and safe reason codes, never event payloads or raw exception text.
- `recoverDeadLetter()` requires an authorization callback to allow the actor/case pair and fails closed when none is configured. The requeue, case transition and `platform.dead_letter_recovery_audit` insert are atomic. Callers must connect this callback to the approved operator authorization system before exposing recovery to any user or service.
- Structured logs contain a `traceId` equal to the durable job UUID and a `correlationId` equal to its originating outbox event ID, along with consumer/job kind, job/case/actor IDs, outcome, attempt counts and safe error/reason codes. This is a work correlation ID, not a distributed tracing span. Batch metrics report aggregate enqueue/claim/process/duplicate/retry/dead-letter/lease-lost counts. Metrics and log sinks are best-effort and cannot change a committed job outcome. Neither includes payloads, credentials, lease tokens or exception messages.

## Operator recovery runbook

1. Confirm the code version and verify the relevant consumer is explicitly registered. The default application does not activate a worker or scheduler; the executable procedure here is for disposable integration fixtures until an authorized operator surface exists.
2. Inspect open cases with `listDeadLetters()`. Record case/job IDs, state, attempt count/limit and safe reason code. Correlate these with structured logs using `traceId` (the job UUID) and batch counters. Never print payloads, lease tokens or raw errors.
3. Diagnose and correct the internal failure. In the synthetic poison-event test, the fixture is marked corrected after locating the case. In a real consumer, verify the source record or dependency has been fixed before proceeding. Do not clear leases, reset attempts or edit receipts with SQL.
4. Construct the worker with `authorizeRecovery` connected to the approved operator authorization policy, verify the actor has permission for the case, and call `recoverDeadLetter(caseId, actorId, 'DATA_CORRECTED')` (or another approved bounded reason). Recovery fails closed without an authorizer. Requeue, case transition and append-only audit record commit atomically.
5. Run a subsequent worker poll and verify the job reaches `succeeded`, one inbox receipt exists, the expected internal effect exists once, and the audit row records actor/case/reason. Replay the same delivery in the disposable test; the receipt suppresses a duplicate effect.
6. For a missed scheduler tick, do not manually requeue pending jobs: the next bounded `runOnce()` poll discovers due PostgreSQL work. A poison event that still fails remains quarantined and needs investigation instead of repeated requeue.
7. External HTTP delivery is at-least-once only; use provider-supported idempotency and independent reconciliation. Never implement seller bank transfers in these workers.

There is no production operator endpoint or active scheduler in this repository. Do not invoke recovery against a shared or production database. No test proves exactly-once behavior at an external provider boundary.

The recovery audit is retained with its case/actor foreign keys. No retention/deletion schedule is defined yet; cleanup requires an approved retention policy. Tenant/brand scope must be resolved from authoritative domain records by each future event handler and must never be trusted solely from event payload data.

## W2 operational snapshot (REN2-105)

`W2OperationalMetricsReader` in `w2-operational-metrics.ts` provides one repeatable-read, read-only aggregate snapshot for submitted QC backlog, recent import throughput and row failures, pending media scans, open reconciliation cases, stock balance/journal drift, durable worker queue/dead-letter/fairness counters, stale search projections and restricted products still marked published in the projection. It returns counts and ages only: no brand IDs, product names, raw rows, object keys, job IDs, event payloads or signed URLs. Inventory drift is detected from the final A4 balance bucket set and append-only `stock_events`; it never updates balances or opens cases.

`evaluateW2OperationalAlerts` requires explicit thresholds from the caller. It has no defaults or production alert sink. The snapshot reader and evaluator are not registered as an HTTP route, scheduled poller or worker. Do not activate or expose them until operator access, threshold baselines, an alert destination and retention duration are reviewed. The current audit-retention TTL is unapproved.

The PostgreSQL 16 integration tests exercise the query against the migrated schema, inject and remove a synthetic pending job, and simulate an importer worker failure. The latter verifies a redacted dead-letter alert correlated to the outbox event; it does not authorize a production alert integration.

REN2-51 requires every handler to declare `authorization: { scope: 'system' }` or `authorization: { scope: 'brand', purpose, effects }`. A brand-scoped handler cannot be registered without a `WorkerAuthorizationPort`. When outbox records become jobs, `DatabaseWorkerAuthorizationService` persists an immutable job entitlement from the authenticated service principal and database-resolved media-asset or stock-event owner. Before processing, it rechecks the live principal, job entitlement, source event, owner, purpose and effects. It audits allowed effects in the handler transaction and writes denials through an independent transaction so audit survives worker rollback. Handlers receive an authorization context and must `await authorizeEffect(effectKey, targetBrandId)` before each brand-owned write. No W2 handler or service credential adapter is activated; implement that provider against the owner-approved service authentication mechanism before registering a production consumer.

## Testing

Pure retry/error-code policy tests run with `npm test`. PostgreSQL 16 integration tests run only with `RENIVET_TEST_DATABASE_URL` set to a loopback `renivet_ci` disposable database. CI checks pre-commit child-process exit rollback, post-commit exit/restart, duplicate concurrent processing, lease expiry, missed polling, bounded retry, poison exhaustion, redacted logs/metrics, authorization and audited recovery followed by one-effect replay. TAP output is uploaded as a seven-day CI artifact. No provider or external HTTP calls are made by these tests.
