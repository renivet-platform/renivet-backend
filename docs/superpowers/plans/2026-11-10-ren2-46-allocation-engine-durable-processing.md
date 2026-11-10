# REN2-46 Allocation Engine & Durable Processing — Execution Plan

> Owner activated Epic Mode on 2026-11-10. This is a single-repository backend epic branch; no routes are activated and owner-only merge rules remain in force.

**Goal:** Deliver the five REN2-46 child slices with traceable commits, safe PostgreSQL allocation and processing, and real disposable PostgreSQL 16 proof.

**Base:** `d97481a3aa7ad0279d716d0ecb62ea7de5bf9464` (`origin/main` at activation)
**Branch:** `epic/REN2-46-allocation-engine-durable-processing`
**Repository:** `renivet-platform/renivet-backend`
**Controlling requirements:** W2 v1.5 master specification, SOP-W2-07A, activation gates G05/G06/G16/G07/G08/G17; live Linear REN2-90 through REN2-94.

## Guardrails

- Use W1 identity, approved worker authorization and PostgreSQL as the stock authority.
- Preserve Master A4: `ATS = max(0, P - Q - U - A - B)`; one allocation bucket; dispatch consumes physical and releases A once.
- Keep prepaid verified completion ordering; do not invent COD, mixed-cart, refund-provider or external fulfillment policy.
- Keep public inventory routes dormant. G07/G08/G17 are release gates, not implicitly satisfied by code.
- Run database tests only against a fresh, disposable PostgreSQL 16 container; never run migrations against the existing local database.
- Commit one reviewed logical change per child; do not change Linear issue statuses. Open one final PR and stop for owner review.

## Dependency-ordered slices

1. **REN2-90 — atomic allocator** (eligible after merged REN2-49/50/51/60 and REN2-83/84/85 prerequisites). Add a trusted internal allocation command; atomically persist order/SKU/location allocation, stock commitment event, pool journal/balance update, idempotency and outbox under deterministic PostgreSQL locks. Tests: valid allocation; sold out; duplicate/reused effect key; cross-brand and invalid target; CAS; 100 independent PG connections competing for 3 units gives exactly 3 allocations.
2. **REN2-91 — durable admission sequence** (after REN2-90). Persist trusted verified-prepaid acceptance sequence and request digest; define per-conflicting-pool eligible-head and multi-SKU lock order without using HTTP arrival time. Tests: concurrent sequence uniqueness, predecessor blocking/skip recovery, no FIFO inversion; COD remains explicitly unimplemented/open.
3. **REN2-92 — ordered worker and retry/DLQ** (after REN2-91). Use existing W1 durable jobs/outbox, scoped worker authorization, per-pool eligible-head claims, bounded retry/backoff and review state; unrelated pools remain parallel. Tests: crash/replay, poison job, same-pool ordering, separate-pool progress and revocation/forged worker denial.
4. **REN2-93 — release/dispatch/cancel and W3 ports** (after REN2-90 and merged REN2-89/75). Add versioned internal release/ship/cancel/return semantics, idempotent effects, paid-no-stock reconciliation event and a production service-principal port without inventing transport/payment/refund providers. Tests: duplicate cancellation, dispatch bucket accounting, paid-no-stock and unauthorized/stale source events.
5. **REN2-94 — race and journal recovery evidence** (after REN2-90..93 and REN2-50). Add independent PG16 multi-connection stress, crash-before/after-commit, retry, poison-job, concurrent transfer, FIFO and full P/Q/U/A/B rebuild evidence. Acceptance: 3 successes/97 rejections, no same-pool FIFO inversion, rebuilt journal equals balance/version and no duplicate effects.

## Per-slice completion gate

For each child: re-read live issue and relations; add failing tests first; implement the smallest approved slice; run focused unit and disposable PostgreSQL tests plus build/typecheck/lint/API checks applicable to changed code; review authorization, lock ordering, idempotency, rollback and cross-brand behavior; stage only that slice; commit with its `REN2-###` ID; record SHA and actual test evidence below. Do not proceed past a missing external dependency, unresolved correctness decision or failing required check.

## Evidence ledger

- Baseline: `npm ci` completed (571 packages; existing audit reports 11 moderate advisories). `npm run build` passed. `npm test` passed: 149 passed, 4 skipped, 0 failed. First raw `npm test` before build failed because the clean worktree had no generated `dist`; after the required build it passed.
- REN2-90: implemented as an internal trusted command; additive migration 0038 applied and replayed twice against the approved disposable PostgreSQL 16 container. Acceptance test passes with 100 concurrent commands/3 units (3 allocations, 97 sold-out receipts), exact replay and key-reuse rejection, duplicate accepted-line delivery, cross-brand/source/foreign SKU/location denial, composite FK rejection, ATS/A-bucket journal/outbox consistency and unverified-event refusal. Existing stock-ledger and W2-schema PostgreSQL integration tests pass. `npm run build`, `npm run typecheck`, `npm run lint`, `npm test` (149 passed, 4 skipped, 0 failed), and `npm run deps:check:syntax` pass. `npm run api:check` did not complete locally: its OpenAPI exporter remained alive without output for more than one minute and was stopped; no API route or generated artifact was changed. Commit SHA pending.
- REN2-91: pending.
- REN2-92: pending.
- REN2-93: pending.
- REN2-94: pending.
- Final integration/security/regression suite and PR: pending.

## Review focus

- Multi-SKU allocation must not partially commit when any pool is unavailable.
- Competing requests must lock pools in stable order and preserve accepted sequence fairness.
- Duplicate command replay must return the recorded result; same key with changed payload must reject.
- A worker retry after commit/crash cannot duplicate journal, outbox or allocation effects.
- Cross-brand IDs, revoked principals, COD and provider events must fail closed or remain explicitly unsupported.
