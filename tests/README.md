# Tests

`npm test` runs local unit and HTTP tests without external services. The PostgreSQL 16 CI job applies the checked-in Drizzle migrations to its disposable `renivet_ci` database, then runs `identity-schema.integration.cjs` and `postgres-foundation.integration.cjs` against that service. The identity test refuses non-loopback hosts, any database other than `renivet_ci`, and any role other than `renivet_ci`.

Do not point migration or integration commands at a shared, staging or production database. The integration fixtures use synthetic identifiers and cryptographic test digests only.
