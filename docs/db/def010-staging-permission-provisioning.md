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
5. Run `psql -v ON_ERROR_STOP=1 -f scripts/staging-verify-role-permissions.sql`
   as a role with SELECT access to `access.roles`, `access.permissions` and
   `access.role_permissions`. This checks the **application RBAC grants** that
   the database-level CREATE/CONNECT provisioning does not address.
6. Verify schema count, ownership, a transaction-rolled-back test write and
   application-facing API permissions on a safe test environment. Repeat the
   setup on a fresh disposable PostgreSQL database before calling it proven.

## Security and automation
- Database access and role provisioning are distinct steps: the normal backend
  role is **not** doadmin, cannot create roles, and is not a superuser.
- Keep the DB in trusted-source network scope. Grant the app only required
  privileges; the script intentionally avoids blanket table DML or role promotion.
- Store both credentials in DigitalOcean encrypted secrets, rotate previously
  exposed values and never put a database password or TLS key in this repo.
- This is a privileged **provisioning runbook**, not a migration secretly
  escalating privileges from within the app.

## QA interpretation
The original DEF-010 report describes possible *application role-permission*
drift; an earlier restore additionally hit a separate database-level `CREATE`
privilege error. These are different problems. Current repo migrations include
explicit W1/W2 RBAC grants, and `tests/brand-access-schema.integration.cjs`
asserts the complete role matrix on disposable PostgreSQL. The read-only SQL
audit here checks that **staging** has not drifted from those migrations.
If it fails, do not manually elevate roles: investigate migration history,
then add a reviewed, narrowly-scoped migration and re-run the full QA suite.
