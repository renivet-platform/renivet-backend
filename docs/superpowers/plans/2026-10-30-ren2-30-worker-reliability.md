# REN2-30 Worker Reliability Implementation Plan

> **For agentic workers:** Use this plan task-by-task with test-first verification.

**Goal:** Implement dormant, PostgreSQL-backed idempotent work processing with bounded claims/retries and audited dead-letter recovery.

**Architecture:** Add a worker service around the approved `platform.durable_jobs`, `platform.outbox_events`, `platform.inbox_receipts` and `platform.dead_letter_cases` schema. Claim with `FOR UPDATE SKIP LOCKED`; commit each consumer effect and receipt in one transaction. No scheduler, provider, or production worker is activated.

**Tech Stack:** NestJS 12, TypeScript, PostgreSQL 16, `pg`, Node test runner.

**Spec:** Linear REN2-30; ADR-W1-001 JOB-01..04; W1 SRS SRS-JOB-001; acceptance scenarios T-JOB-03..08.

## Global Constraints

- PostgreSQL is durable authority; wakeup tick is not queue state.
- Maximum attempts default to five; lease must be no longer than five minutes.
- No claim of exactly-once external delivery or automatic seller payout.
- Keep OTP, password, session and bank secrets out of events, logs and failure metadata.
- Do not add HTTP routes or make migrations on a shared/deployed database.

## Review Focus

- Concurrent claims and transaction rollback must not duplicate internal effects.
- Stale lease owners must not complete/retry work after lease takeover.
- Missing ticks and crashes must leave committed work discoverable.
- Malformed/secret-bearing error details must not enter persisted diagnostics.
- Recovery must be denied without authorization and leave an actor/time audit record.

## Files

- Create `src/workers/durable-worker.ts` for claim/execute/retry/recover primitives.
- Extend `src/db/schema.ts` and add a forward migration only if an append-only recovery audit relation is required by the verified approved contract.
- Create `tests/durable-worker.test.cjs` and `tests/durable-worker.integration.cjs`.
- Extend `.github/workflows/ci.yml` to run worker integration tests against disposable PostgreSQL 16.
- Expand `src/workers/README.md` with operating boundaries and recovery runbook.

## Tasks

### Task 1 — Retry policy and safe diagnostics

Add test-first deterministic exponential backoff with bounded jitter and safe error-code normalization. Prove no raw exception text is persisted or logged.

### Task 2 — Atomic claim and internal event processing

Add PostgreSQL-backed claims using row locks and bounded leases; enforce owner-guarded renew/complete/fail transitions. Process outbox events with consumer receipts and effects in one transaction. Test concurrent claimers, duplicate delivery, crash/restart and stale lease behavior using a disposable Postgres 16 instance.

### Task 3 — Retry, quarantine and operator recovery

Add bounded retries and dead-letter visibility. Require an authorization port for recovery; persist an auditable actor/time/reason record atomically with requeue. Test denial and authorized recovery. Do not create an HTTP endpoint.

### Task 4 — CI and runbook

Run unit and disposable PostgreSQL integration checks in CI and document how operators inspect/recover jobs safely, including the current disabled-provider/worker state.

## Verification

Run focused worker tests, the full `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`, and the disposable PostgreSQL 16 worker integration suite. Never run these migrations or integration tests against a shared database.
