# REN2-46 Provisional Admission Proof and Worker Plan

> **For agentic workers:** Inline execution was explicitly selected by the owner. Follow the test-first steps and preserve the existing epic branch/PR.

**Goal:** Add a provisional W2 adapter that durably validates and consumes W3-owned checkout admission proofs, retries out-of-order work through the existing PostgreSQL worker, and records real PG16 evidence.

**Architecture:** W3 continues to issue immutable accepted-order hashes and per-pool eligibility tokens. W2 stores proof receipts and a per-pool consumed-token cursor, applying stock allocation or an explicit W3 skip atomically with cursor advancement. An unregistered event handler wires the proof events into the existing durable jobs/outbox/inbox framework; it is not activated at startup.

**Tech Stack:** NestJS/TypeScript, PostgreSQL 16, existing Drizzle SQL migrations, `DurableWorker`, Node test runner.

**Spec:** `docs/superpowers/specs/2026-11-10-ren2-46-provisional-w3-admission-proof-design.md`

## Global Constraints

- W3 remains the authority for provider-verified acceptance order, eligible head and predecessor skip decisions.
- W2 consumes only trusted W3 outbox proofs and never derives FIFO from HTTP arrival or `SKIP LOCKED` alone.
- Keep COD, checkout/refund providers, W3 scheduler, W2 HTTP activation and production worker registration out of scope.
- Fail closed for multi-line orders pending an approved all-or-none rule.
- Real database tests use only the approved disposable PostgreSQL 16 container.
- Preserve the existing open PR, owner-only merge, and no Linear status mutation.

## Review Focus

- A later pool eligibility token cannot overtake the current cursor, even when workers claim jobs concurrently.
- An accepted-event hash or W3 proof cannot be replayed for altered brand, sequence, checkout line, SKU, location or quantity.
- An explicit predecessor skip is idempotent and advances one pool cursor exactly once; arbitrary skip reasons fail closed.
- Worker crash after allocation commit replays the same proof receipt without a second stock effect.
- Unknown/cross-brand checkout lines cannot establish worker authorization scope from payload claims alone.

## File Map

- `drizzle/0040_ren2_91_checkout_admission_proofs.sql`: immutable W3 proof receipts and per-pool eligibility cursor.
- `drizzle/meta/_journal.json`: register migration 0040.
- `src/modules/inventory/inventory.repository.ts`: validate/consume eligibility proof and explicit skip atomically with allocation state.
- `src/workers/worker-authorization.ts`: derive a checkout event's brand from database-owned variant/location records.
- `src/workers/checkout-admission-event.handler.ts`: map eligible and skip outbox events to the repository worker ports.
- `src/workers/durable-worker.ts`: classify the not-yet-eligible head as retryable.
- `tests/w2/stock-allocation.integration.test.cjs`: PG16 sequence, proof, skip, race, durable retry and replay evidence.
- `tests/durable-worker.test.cjs` and `tests/worker-authorization.integration.cjs`: retry-code and database-derived checkout brand regression.
- `.github/workflows/ci.yml`: existing REN2-90/93 and REN2-51 PostgreSQL steps run the extended suites; no new CI step is required.
- `docs/w2/checkout-admission-proof-contract.md`: provisional W3/W2 handoff and non-activation limits.
- `docs/superpowers/plans/2026-11-10-ren2-46-allocation-engine-durable-processing.md`: record owner scope direction and current evidence.

## Task 1 — REN2-91 provisional durable proof and per-pool head cursor

**Interfaces:** W3 events follow the contract in the spec. `checkout.allocation_eligible` supplies the accepted event ID, brand, checkout, accepted sequence, request hash, one canonical line and positive per-pool eligibility sequence. `checkout.allocation_skipped` supplies the same proof identity and an allowlisted skip reason. W2 persists but does not mint these sequence values.

- [x] Add PG16 coverage for accepting the pool head, rejecting a later token before it, then allowing it after the head has a terminal outcome; cover proof replay.
- [x] Observe the expected red test before implementation; the initial run failed because W2 did not recognize/validate the new eligibility proof.
- [x] Add migration 0040 with accepted-order identity, immutable proof/skip evidence, per-pool unique eligibility sequence and cursor constraints.
- [x] Make `allocateTrusted` validate an eligible event against its referenced accepted event/hash/canonical line; serialize the cursor and atomically store proof/cursor with allocation or paid-no-stock outcome.
- [x] Cover mismatched source, brand, and line; multi-line fail-closed; explicit skip replay and rejected reason; 100 concurrent requests for 3 units.
- [x] Implement `skipCheckoutAdmission` with an explicit W3 skip event and immutable skip receipt; W2 does not invent expiry timing.
- [x] Run the focused PostgreSQL stock-allocation suite successfully.
- [x] Commit `feat(REN2-91): consume durable W3 admission proofs` (`2ce0fc3`), followed by replay-identity hardening (`05022b0`).

## Task 2 — REN2-92 durable worker adapter

- [x] Implement a handler limited to eligible/skip proof events and declare brand-scoped allocation/skip effects.
- [x] Derive checkout worker scope from the approved brand owning the active variant/location; a spoofed payload brand is rejected in PostgreSQL integration coverage.
- [x] Implement `CheckoutAdmissionEventHandler` on the existing `DurableWorker` and proof-checked repository methods.
- [x] Add the safe `CHECKOUT_ELIGIBLE_HEAD_NOT_READY` retry code; verified durable PG16 test shows the later token retries, the head completes, and the successor then succeeds.
- [x] Verify an independent pool starts at its own sequence while another pool has a later cursor.
- [ ] Inject before/after-commit process crashes at this new consumer boundary; the existing generic worker crash test and proof replay test cover the shared mechanisms but not this exact integration point.
- [x] Keep the consumer unregistered from `AppModule`; no scheduler or auth transport is added.
- [x] Run worker authorization/unit and stock allocation PG16 tests successfully; final lint/typecheck/build and broad suite remain.
- [x] Commit `feat(REN2-92): add dormant checkout admission consumer` (`1e38b89`).

## Task 3 — REN2-94 provisional evidence and handoff

- [x] Verify independent pool sequencing; existing inventory-ledger PG16 test rebuilds journal P/Q/U/A/B and matches balance/version. Same-pool no-overtake, explicit skip and replay, and 100-for-3 evidence pass in `tests/w2/stock-allocation.integration.test.cjs`.
- [x] Apply all migrations to a fresh disposable PostgreSQL 16 database and rerun migrations as a no-op; both runs passed.
- [x] Run `npm run build`, `npm run lint`, `npm run typecheck`, `npm test`, relevant PG16 integration tests, `npm run api:check`, `npm run deps:check:syntax`, and `git diff --check`.
- [x] Publish the provisional contract and non-activation limits in `docs/w2/checkout-admission-proof-contract.md`.
- [x] Update the epic ledger with actual results and clearly retain unresolved W3 full-system/activation gates.
- [ ] Add consumer-specific before/after-commit crash injection; do not claim this piece of REN2-94 is complete.
- [x] Commit `test(REN2-94): prove provisional admission ordering and recovery` after recording evidence and remaining W3-owned gates.

## Final Review Focus

W3 producer ownership and eligibility-token monotonicity; event hash canonicalization; authorization scope derived from authoritative database rows; per-pool lock ordering; exact retry/DLQ behavior; no route/worker activation; explicit limits on multi-line and COD behavior.
