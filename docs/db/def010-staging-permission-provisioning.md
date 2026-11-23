# DEF-010 — Reproducible staging database permissions

## What failed and why
An initial `pg_restore` to `renivet_staging` failed at `CREATE SCHEMA access` with
`permission denied for database`. The staging role had not been provisioned
with database-level CREATE. A one-off manual GRANT unblocked this environment,
but it was not documented or repeatable.

## Approved setup (never run against production)
1. Create the DigitalOcean managed PostgreSQL 16 cluster, database
   `renivet_staging` and login role `renivet_staging_user`.
2. Connect as DigitalOcean `doadmin` **to `renivet_staging`**, with TLS.
   Run `psql -v ON_ERROR_STOP=1 -f scripts/staging-database-permissions.sql`.
3. Connect as `renivet_staging_user` with TLS and verify
   `SELECT has_database_privilege(current_user,current_database(),'CREATE');`
   returns `true`.
4. Run migrations or restore a custom-format dump as **`renivet_staging_user`**
   using `pg_restore --no-owner --no-acl --exit-on-error` against an empty
   disposable staging database. Do not run on nonempty databases without a
   reviewed backup and migration plan. The staging role owns created objects.
5. Verify schema count, ownership, a transaction-rolled-back test write and
   application-facing API permissions on a safe test environment. Repeat the
   setup on a fresh disposable PostgreSQL database before calling it proven.

## Security and automation
- Database access and role provisioning are distinct steps: the normal backend
  role is **not** doadmin, cannot create roles, and is not a superuser.
- Keep the DB in trusted-source network scope. Grant the app only required
  privileges and migrate away from broad public-schema grants if not needed.
- Store both credentials in DigitalOcean encrypted secrets, rotate previously
  exposed values and never put a database password or TLS key in this repo.
- This is a privileged **provisioning runbook**, not a migration secretly
  escalating privileges from within the app.
