# Tests

`npm test` runs local unit and HTTP tests without external services. The PostgreSQL 16 CI job applies the checked-in Drizzle migrations to its disposable `renivet_ci` database, verifies identity constraints, foundation transaction behavior, and the REN2-29 outbox/inbox schema. It runs REN2-24 repository and full HTTP integration tests against disposable PostgreSQL and Redis, including invalid/replayed/revoked factors, one-use/exhausted recovery codes, CSRF, session rotation, rate limiting and audit secrecy. It then clones the migrated database as a disposable recovery snapshot, rebuilds `renivet_ci` from that snapshot, verifies migration replay, and reruns all integration suites after recovery.

The recovery test is destructive by design and refuses to run without `RENIVET_ALLOW_DISPOSABLE_DATABASE_REBUILD=1`. It also requires loopback PostgreSQL, database `renivet_ci`, role `renivet_ci`, PostgreSQL 16, and a superuser role. Run it only against an isolated disposable database; never point it at a shared or deployed database.

Do not point migration or integration commands at a shared, staging or production database. The integration fixtures use synthetic identifiers and cryptographic test digests only.

To run the REN2-29 schema test locally, use an isolated PostgreSQL 16 database named `renivet_ci` on loopback with role `renivet_ci`, then set `RENIVET_TEST_DATABASE_URL` and run `node --test tests/outbox-inbox.integration.cjs`. The test checks schema-qualified tables, reviewed claim and dedupe indexes, bounded lease/attempt metadata, transaction rollback and concurrent receipt deduplication. It cleans up its synthetic fixtures.

To run the REN2-30 worker test locally, first build the app, then use that same isolated database URL and run `node --test tests/durable-worker.integration.cjs`. It checks concurrent claims, missed-poll discovery, receipt/effect atomicity, replay, retry after rollback, lease takeover, poison-job quarantine, redacted logs and authorized/audited recovery. All event and identity data is synthetic. The recovery audit rows are intentionally retained with their dead-letter case and actor; use only a disposable database.
