# Tests

`npm test` runs local unit and HTTP tests without external services. The PostgreSQL 16 CI job applies the checked-in Drizzle migrations to its disposable `renivet_ci` database, verifies the exact identity index definitions, and runs both identity and foundation integration tests. It then clones the migrated database as a disposable recovery snapshot, rebuilds `renivet_ci` from that snapshot, verifies migration replay, and reruns both integration suites after recovery.

The recovery test is destructive by design and refuses to run without `RENIVET_ALLOW_DISPOSABLE_DATABASE_REBUILD=1`. It also requires loopback PostgreSQL, database `renivet_ci`, role `renivet_ci`, PostgreSQL 16, and a superuser role. Run it only against an isolated disposable database; never point it at a shared or deployed database.

Do not point migration or integration commands at a shared, staging or production database. The integration fixtures use synthetic identifiers and cryptographic test digests only.
