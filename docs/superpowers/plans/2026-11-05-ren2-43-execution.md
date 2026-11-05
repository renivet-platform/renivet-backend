# REN2-43 Epic Execution Ledger

## Authorization and boundary

- Owner activated `ACTIVATE RENIVET EPIC MODE REN2-43` in this conversation.
- Repository: `renivet-backend`; branch: `epic/REN2-43-product-qc-publishing-search`.
- Base: `origin/main` at `56394b064cc360fee6bf16e1b1b2ff8e5393367df`.
- Implement only the five REN2-43 children in dependency order. Keep G03/G07/G09/G14/G17 runtime release gates closed unless their evidence is independently met. Do not activate public routes or claim production readiness.
- One traceable commit per child; one integrated PR to `main`; stop for owner review. Never merge, self-approve, enable auto-merge, push to `main`, or mark child issues Done.

## Issue sequence and gates

| Issue | Scope | Depends on | Status |
|---|---|---|---|
| REN2-71 | Immutable submitted product revision and submission validation | REN2-63, 64, 67, 68 merged | Implemented; ready to commit |
| REN2-72 | Maker-checker QC decision and immutable decision history | REN2-71, 51 merged | Pending |
| REN2-73 | Atomic publication/restriction, audit event and W1 outbox | REN2-72, 65, 69 merged | Pending |
| REN2-74 | Versioned Typesense projection, tombstone and stale-event suppression | REN2-73, 51 merged | Pending |
| REN2-75 | Internal authoritative catalog buyability validation port | REN2-73, 64 merged | Pending |

## Verification record

- `npm ci`: PASS after resolving the initial Windows `ENOTEMPTY` cleanup issue by isolating the partial generated install and reinstalling from the lockfile.
- Base verification before code: `npm run build`, `npm run typecheck`, `npm run lint`: PASS; `npm test`: 129 passed, 4 skipped, 0 failed.
- REN2-71 focused unit tests: PASS (canonical hash, unsupported values, readiness failures, incomplete field errors, input/CAS validation, migration structure).
- REN2-71 PostgreSQL 16 integration: PASS in a newly created disposable database after applying the complete migration chain. Covers valid submit/hash/replay, incomplete-submit rollback, edit-after-submit immutability, and competing CAS submissions.
- REN2-61/62 PostgreSQL 16 regression: PASS after parent row-version increments were added for variant mutations.
- `npm run build`, `npm run typecheck`, `npm run lint`: PASS after REN2-71 changes.
- Root `npm test`: PASS (129 passed, 3 skipped, 0 failed) on the repeat run; initial combined run had one transient failure, which did not reproduce.
- CI-equivalent W2 draft/submission suite: PASS (18 passed, 0 failed), including PG16 integration.
- `npm run api:check`: PASS (generated OpenAPI/SDK and Postman drift checks; W2 traceability still reports only route-implemented operations).

## Per-child changes and evidence

To be updated after each independently tested child commit. Tests must include relevant unit/security cases and disposable PostgreSQL 16 integration coverage. The final PR must list exact PASS/FAIL/NOT RUN evidence and any still-open activation gates.
