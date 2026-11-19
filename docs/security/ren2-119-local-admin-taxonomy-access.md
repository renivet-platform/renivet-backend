# REN2-119 — Taxonomy permission and local QA super-admin diagnosis

## Root cause
The Taxonomy controller requires global `taxonomy.manage`. Migration `0044` registers the permission, but does not attach it to the existing global `renivet_admin` role. This produces `PLATFORM_ACCESS_DENIED` even when the user is displayed as an administrator. Migration `0047` adds the missing **role-to-permission mapping**. It does not promote, create, or assign any user.

## Explicit disposable QA account bootstrap

The account `admin.w2.e2e@renivet.test` is a local testing identity. The bootstrap script runs only when all conditions are true: a verified, active account already exists; `NODE_ENV` is `development` or `test`; the operator explicitly opts in; and the connection is exactly PostgreSQL 16 at `127.0.0.1:5432/renivet_ci` under `renivet_ci`. It will not connect to your ordinary development database, staging or production. It never creates a login or password, and never changes production roles.

Run reviewed migrations first, then from the backend repo in PowerShell:

```powershell
$env:NODE_ENV = "development"
$env:RENIVET_ENABLE_LOCAL_SUPERADMIN_BOOTSTRAP = "1"
$env:RENIVET_TEST_DATABASE_URL = "postgresql://renivet_ci:<local-test-password>@127.0.0.1:5432/renivet_ci"
node scripts/bootstrap-ren2-119-local-superadmin.cjs
```

Replace the placeholder password locally. The script requires an existing email-verified test account, adds its `renivet_admin` role and a dedicated `renivet_e2e_superadmin` global QA role with a tightly defined platform-level permission allowlist. It does not grant brand-scoped seller permissions, bypass maker-checker review, disable MFA policies for independent approvals, or silently grant all future permissions. A database audit event records the bootstrap.

To confirm, the operator can inspect `access.effective_permissions` scoped to the test account and verify that `taxonomy.manage` appears under `renivet_admin`. The backend remains the source of truth, so a new session alone cannot substitute for applying migrations and role assignments.

**Not completed automatically:** this change is a repository PR only. The assistant cannot inspect or mutate the user's localhost PostgreSQL instance. Run reviewed migrations and the explicit bootstrap on the authorized disposable DB, restart the backend only if its configuration or process needs it, then recheck the Taxonomy create request.

**Important:** `renivet_admin` is the backend's recognized platform-admin system role. The QA helper's title `superadmin` does not imply unconditional access to every brand, inventory operation or protected independent approval.
