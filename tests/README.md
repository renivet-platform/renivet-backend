# Tests

`npm test` runs local unit and HTTP tests without external services. The PostgreSQL 16 CI job applies the checked-in Drizzle migrations to its disposable `renivet_ci` database, verifies identity constraints, foundation transaction behavior, and the REN2-29 outbox/inbox schema. It runs REN2-24 repository and full HTTP integration tests against disposable PostgreSQL and Redis, including invalid/replayed/revoked factors, one-use/exhausted recovery codes, CSRF, session rotation, rate limiting and audit secrecy. It then clones the migrated database as a disposable recovery snapshot, rebuilds `renivet_ci` from that snapshot, verifies migration replay, and reruns all integration suites after recovery.

The same disposable PostgreSQL 16 job runs `node --test tests/brand-access-schema.integration.cjs` for REN2-26. This validates canonical brand roots/memberships, the seeded first-slice role matrix, global-vs-brand scope constraints, principal/membership foreign keys, duplicate/invalid grant rejection, effective-permission denial for future/expired assignments and inactive memberships/unapproved brands, durable regrant behavior, and immutable access audit events. The test requires `RENIVET_TEST_DATABASE_URL` to point to loopback PostgreSQL database `renivet_ci` as user `renivet_ci`; it rolls back synthetic fixtures, including audit events, inside a transaction. It must never be pointed at a shared or deployed database.

REN2-27 adds `tests/session-cookie.test.cjs` and `tests/brand-access-guard.test.cjs` to the local unit suite, plus `tests/brand-access.integration.test.cjs` to the PostgreSQL 16 disposable CI job. The integration test creates and removes synthetic users, memberships, role assignments and brands; its resource rows live only in a temporary table. It verifies session-derived identity, brand-specific and global permissions, multi-brand isolation, detail/list/search/count/nested/bulk-write/export scopes, and that committed grant expiry or membership suspension blocks the next SQL statement using an already issued context. It must only use the loopback `renivet_ci` disposable database.

REN2-49 adds `tests/platform-permission-guard.test.cjs`, `tests/brand-access-global-permission.test.cjs`, and `tests/ren2-49-authorization-matrix.test.cjs` to the local unit suite. The platform guard accepts only a global-scope W1 permission; it does not fall back to brand grants. `tests/brand-access.integration.test.cjs` also verifies against disposable PostgreSQL that a brand-scoped membership permission cannot satisfy the platform guard, a taxonomy mutation is denied to a brand principal, and an explicit current W1 global permission passes. No taxonomy permission is seeded, so no taxonomy handler is enabled by this task. The matrix check enforces 44 unique candidate operation IDs and requires each row to declare a permission, guard lane, and mapped or explicitly denied role status.

REN2-28 maps the W1 authorization-abuse matrix into executable checks:

| Scenario | Executable evidence |
| --- | --- |
| T-AZ-01 | `brand-access.integration.test.cjs`: guessed foreign-brand detail IDs return no rows. |
| T-AZ-02 | Same suite: list, filter, sort, page, search and count stay within the authorized brand. |
| T-AZ-03 | Same suite: guessed cross-brand export and bulk update return no rows and change no fixture. |
| T-AZ-04 | Same suite: a two-connection revocation/old-context request check, plus grant expiry and membership suspension/expiry, deny fresh SQL statements after the commit boundary. |
| T-AZ-05 | `brand-access-schema.integration.cjs` and same suite: pending/suspended memberships and unapproved brands do not resolve effective permissions. |
| T-AZ-06 | `brand-access-guard.test.cjs` and same suite: caller-supplied identity, role, brand and MFA claims do not establish access. |
| T-AZ-07 | Same suite: both parent and child SQL aliases are scoped; guessed foreign nested IDs are invisible. |
| T-AZ-08 | Same suite: a multi-brand principal can access each authorized brand independently, not an ungranted one. |
| T-AZ-09 / T-ID-09 | `mfa-guard.test.cjs` plus `mfa-api.integration.test.cjs`: the actual MFA guard rejects forged/stale elevation and records persisted allow/deny audit decisions without factor/session secrets. |
| Grant/removal audit | `brand-access-schema.integration.cjs`: synthetic grant/revocation actions use hashed safe metadata and append-only access audit rows inside a rolled-back transaction. |

The protected brand, staff and finance operations do not yet have real domain HTTP handlers. These tests exercise the reusable authorization controls and synthetic resource fixtures; they do not claim real product routes or end-to-end seller/admin workflows exist. The database-backed CI gate runs the brand/access tests before recovery and reruns brand query and privileged-MFA evidence after rebuilding the disposable PostgreSQL 16 database. Every assertion is a normal `node --test` failure, with no allowed-failure or soft-fail setting.

The recovery test is destructive by design and refuses to run without `RENIVET_ALLOW_DISPOSABLE_DATABASE_REBUILD=1`. It also requires loopback PostgreSQL, database `renivet_ci`, role `renivet_ci`, PostgreSQL 16, and a superuser role. Run it only against an isolated disposable database; never point it at a shared or deployed database.

Do not point migration or integration commands at a shared, staging or production database. The integration fixtures use synthetic identifiers and cryptographic test digests only.

To run the REN2-29 schema test locally, use an isolated PostgreSQL 16 database named `renivet_ci` on loopback with role `renivet_ci`, then set `RENIVET_TEST_DATABASE_URL` and run `node --test tests/outbox-inbox.integration.cjs`. The test checks schema-qualified tables, reviewed claim and dedupe indexes, bounded lease/attempt metadata, transaction rollback and concurrent receipt deduplication. It cleans up its synthetic fixtures.

To run the REN2-30/31 worker test locally, first build the app, then use that same isolated database URL and run `node --test tests/durable-worker.integration.cjs`. It checks process exits before and after commit, concurrent claims and duplicate processing, missed-poll discovery, receipt/effect atomicity, retry after rollback, lease takeover, poison-job quarantine, redacted structured logs/metrics and authorized/audited recovery followed by replay. All event and identity data is synthetic. The recovery audit rows are intentionally retained with their dead-letter case and actor; use only a disposable database.

REN2-31 evidence crosswalk:

| QA ID | Evidence and boundary |
| --- | --- |
| T-JOB-01 | Existing outbox/inbox PostgreSQL integration proves domain/outbox atomicity in `tests/outbox-inbox.integration.cjs`; worker suite confirms receipt/effect/job commit together. |
| T-JOB-02 | Existing transaction rollback integration plus child-process exit inside the worker transaction proves receipt/effect rollback. |
| T-JOB-03 | Child worker exits before commit; PostgreSQL rolls back its open transaction, then a fresh worker claims the expired lease and applies one effect. |
| T-JOB-04 | Concurrent claimers and two concurrent `process()` calls prove one processing owner and one internal effect; post-commit replay is deduplicated by the inbox receipt. |
| T-JOB-05 | Synthetic transient failure rolls back and retries with bounded backoff; succeeding retry applies the effect once. |
| T-JOB-06 | Poison work exhausts attempts, becomes visible with safe state/attempt/error metadata, and excludes raw exception text. |
| T-JOB-07 | A committed event missed by a wakeup is discovered by the next `runOnce()` poll. |
| T-JOB-08 | External delivery remains at-least-once; exact-once external effects are not claimed and require provider idempotency/reconciliation. |
| T-OPS-01 | CI step names, test IDs, TAP artifact, PR and Linear issue provide traceability. |
| T-OPS-02 | Disposable PostgreSQL 16 suite runs before and after recovery; test failures fail CI and TAP is retained for seven days. |
| T-OPS-03 | No production worker, scheduler, endpoint or database change is activated; release and operator access remain owner-controlled. |

The recovery integration test exercises the runbook sequence only on synthetic disposable rows: inspect a dead-letter case, reject unauthorized recovery, record an authorized bounded reason, requeue atomically, process the corrected fixture, verify one effect and audit entry, then replay without a duplicate. The worker is not registered at application startup and no production operator UI/API exists. It does not prove provider delivery or external exactly-once behavior.
