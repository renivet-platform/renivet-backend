# REN2-46 Allocation Engine & Durable Processing — Execution Plan

> Owner activated Epic Mode on 2026-11-10. This is a single-repository backend epic branch; no routes are activated and owner-only merge rules remain in force.

**Goal:** Deliver every child slice that fits the approved W2/W3 ownership boundary, with traceable commits, safe PostgreSQL allocation and processing, and real disposable PostgreSQL 16 proof. Record and stop at scope conflicts instead of implementing W3-owned services in W2.

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
2. **REN2-91 — durable admission sequence: blocked by an approved-scope conflict.** Linear asks this backend to own the W3 acceptance inbox and overlapping-stock FIFO. The approved W2 v1.5 master (W3 boundary section and SOP-W2-09) says those remain W3-owned and are not a running W2 service. Do not implement the sequence counter or FIFO in this repository unless the owner updates the controlling scope; W2 will validate/consume W3's trusted sequence.
3. **REN2-92 — ordered worker and retry/DLQ: blocked by REN2-91.** Its per-pool head claims depend on the W3-owned eligible-head contract. Do not build a competing backend queue. Revisit after REN2-91 is reconciled with the master and W3 ownership.
4. **REN2-93 — release/dispatch/cancel and W3 ports** (independently eligible after REN2-90 and merged REN2-89/75). Add versioned internal release/ship/cancel/return semantics, idempotent effects, paid-no-stock reconciliation event and a production service-principal port without inventing transport/payment/refund providers. Tests: duplicate cancellation, dispatch bucket accounting, paid-no-stock and unauthorized/stale source events.
5. **REN2-94 — race and journal recovery evidence: blocked until REN2-90..93 and the W3 FIFO contract are available.** Add independent PG16 multi-connection stress, crash-before/after-commit, retry, poison-job, concurrent transfer, FIFO and full P/Q/U/A/B rebuild evidence. Acceptance: 3 successes/97 rejections, no same-pool FIFO inversion, rebuilt journal equals balance/version and no duplicate effects.

## Per-slice completion gate

For each child: re-read live issue and relations; add failing tests first; implement the smallest approved slice; run focused unit and disposable PostgreSQL tests plus build/typecheck/lint/API checks applicable to changed code; review authorization, lock ordering, idempotency, rollback and cross-brand behavior; stage only that slice; commit with its `REN2-###` ID; record SHA and actual test evidence below. Do not proceed past a missing external dependency, unresolved correctness decision or failing required check.

## Evidence ledger

- Baseline: `npm ci` completed (571 packages; existing audit reports 11 moderate advisories). `npm run build` passed. `npm test` passed: 149 passed, 4 skipped, 0 failed. First raw `npm test` before build failed because the clean worktree had no generated `dist`; after the required build it passed.
- REN2-90: implementation commit `ed998039b09227afc602d972bbf1acbd8c37d1e9`. Migration 0038 was applied and migration replayed twice against the approved disposable PostgreSQL 16 container. Acceptance test passed with 100 concurrent commands/3 units (3 allocations, 97 sold-out receipts), exact replay/key-reuse rejection, duplicate line delivery, cross-brand/source/foreign SKU/location denial, composite FK rejection, ATS/A-bucket journal/outbox consistency and unverified-event refusal. Existing stock-ledger and W2-schema PostgreSQL integration tests passed. `npm run build`, `npm run typecheck`, `npm run lint`, `npm test` (149 passed, 4 skipped, 0 failed), and `npm run deps:check:syntax` passed. `npm run api:check` did not complete locally: its OpenAPI exporter remained alive without output for more than one minute and was stopped; no API route or generated artifact was changed. REN2-93 further tightens validation to match the persisted W3 sequence proof.
- REN2-91: blocked by the Linear/master ownership conflict above; not implemented and not marked Done.
- REN2-92: blocked pending a W3-owned eligible-head command/contract; not implemented.
- REN2-93: implementation, review and local verification complete; its traceable child commit is in the epic branch history. Migration 0039 adds separate released-quantity accounting, database lifecycle invariants, service-principal provenance, and immutable paid-no-stock reconciliation cases. Internal dispatch/release commands enforce brand/effect authorization, exact shipment/cancellation source event types, current pool version, stable idempotency receipts, and atomic stock journal/outbox effects. The existing reviewed return intake/review remains the return path and now has explicit duplicate-intake/decision replay assertions. Disposable PG16 evidence: 100 competing accepted completions against 3 units produced exactly 3 allocations and 97 immutable reconciliation obligations; partial dispatch then cancellation reduced A once and P only for shipped units; stale versions, wrong source events, changed retries, invalid terminal accounting, immutable case rows and brand/source checks rejected. `npm run db:migrate` passed twice on the disposable database, including a clean rebuild through migration 0039. Focused stock-allocation, existing inventory-ledger and W2-schema integration tests passed sequentially.
- REN2-94: blocked pending predecessor slices and a W3-owned FIFO proof.
- REN2-93 static/regression verification: `npm run build`, `npm run lint`, `npm run typecheck`, `npm test` (149 passed, 4 skipped, 0 failed), `npm run api:check` (Postman/OpenAPI and W2 traceability checks passed), and `git diff --check` passed. These were rerun after the final code and migration changes; route activation remains gated.
- Final epic PR: pending. REN2-91/92/94 remain blocked by the documented W3 FIFO ownership conflict; do not claim all epic acceptance criteria are complete or activate the W3 runtime without the missing ownership/ordering proof.

## Review focus

- Multi-SKU allocation must not partially commit when any pool is unavailable.
- Competing requests must lock pools in stable order and preserve accepted sequence fairness.
- Duplicate command replay must return the recorded result; same key with changed payload must reject.
- A worker retry after commit/crash cannot duplicate journal, outbox or allocation effects.
- Cross-brand IDs, revoked principals, COD and provider events must fail closed or remain explicitly unsupported.
