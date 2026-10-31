# REN2-31 Worker Reliability Design

## Goal

Provide repeatable PostgreSQL 16 evidence that durable jobs survive process crashes, duplicate/concurrent delivery, retries, missed scheduler ticks and poison work; make recovery observable and safely operable.

## Current implementation

`src/workers/durable-worker.ts` already uses PostgreSQL as the durable queue, leases/fencing tokens, transactional inbox receipts, bounded retries and an authorization callback for dead-letter recovery. It is not registered in `AppModule`; no production scheduler or handler is active. Existing `tests/durable-worker.integration.cjs` covers concurrent claims, retry rollback, manual lease expiry, replay, poison quarantine, secret redaction and recovery authorization, but it does not actually terminate a worker process at commit boundaries, complete a recovered job, or persist a test artifact.

## Design

1. Keep the existing database schema and worker activation boundary. Use a test-only child process that exits abruptly inside or immediately after `DurableWorker.process()` to simulate crash-before-commit and crash-after-commit.
2. Restart through a new `DurableWorker` instance, then assert durable state, receipt/effect atomicity, lease recovery and duplicate-effect suppression.
3. Expose a dependency-free batch metrics callback based on the existing `WorkerBatchSummary`. Emit sanitized per-job logs with a stable job UUID correlation field (`traceId`), attempt counts, state/outcome and safe reason codes. Telemetry callback failures must not roll back or misreport already committed work.
4. Make `listDeadLetters()` actionable by returning safe job state, attempts and error/reason codes, never event payloads or raw exception text.
5. Document an operator runbook that mirrors the tested dead-letter inspection, authorization, requeue, reprocessing and verification flow. Clearly state the worker remains dormant and no production operator endpoint exists.
6. Run the disposable PostgreSQL integration suite before and after CI recovery and upload TAP output as a short-lived CI artifact. Do not add production chaos tests, migrations, endpoints, provider calls or payout behavior.

## Acceptance mapping

- AC-01 / T-JOB-03..07: subprocess crashes, worker restart, duplicate processing race, retries, missed wake-up, poison exhaustion run in disposable PostgreSQL CI.
- AC-02: safe state/attempt/reason logs and batch counters; operator authorization fails closed; no payloads, secrets or raw errors in telemetry.
- AC-03: the runbook's recover-and-verify sequence is exercised by the integration test, with one durable internal effect and recovery audit evidence.
- AC-04 / T-JOB-01..08 / T-OPS-01..03: scenario crosswalk and limitations in `tests/README.md` and runbook; actual passing CI artifact linked in the PR/Linear.

## Constraints

- Synthetic fixtures only, loopback disposable PostgreSQL 16 only.
- At-least-once external delivery; no exactly-once network guarantee.
- No live worker, scheduler, HTTP API, database schema change, deployment or production recovery.
