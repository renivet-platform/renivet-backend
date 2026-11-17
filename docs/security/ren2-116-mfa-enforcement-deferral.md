# REN2-116: controlled development MFA deferral

## Policy and recovery

`MFA_ENFORCEMENT_MODE` is a server-only setting. It defaults to `enforced`; only `development` and `test` accept `deferred`. Staging and production reject `deferred` during configuration validation. Return to the existing policy by unsetting the variable or setting it to `enforced`; this changes no MFA records and needs no migration. No deploy or shared environment has been changed by this task.

The `MfaGuard` still authenticates the opaque first-party session and records an audit decision in both modes. In deferred mode it skips only the persisted 300-second MFA freshness predicate. Route decorators and action metadata remain in place. Permission, brand scope, CSRF, origin/fetch metadata, idempotency, maker-checker, current-version checks and audit availability remain independent requirements. Authentication failure or audit failure still denies the action. Client claims cannot set mode or identity. No `mfa_verified_at` value is generated.

`GET /api/v1/auth/session` returns the effective mode with `Cache-Control: no-store`; this is informational and derived from backend configuration. Frontend defaults missing/unknown values to enforced, and business APIs remain authoritative.

## Configuration and secret boundary

`AUTH_MFA_ENCRYPTION_KEY` remains required in staging/production for MFA factor encryption. Development local import storage now uses a separate `AUTH_IMPORT_UPLOAD_HMAC_KEY` (at least 32 characters), never CSRF/MFA key fallback. Set a unique random value only in the local developer environment when local import storage is enabled. Artifact generation uses a synthetic key and disables the local adapter; it does not read developer service credentials.

## Inventory and changed behavior

Backend `@RequireMfa` call sites currently cover import preview/upload/confirm/recovery, brand application review, catalog publication and quality decisions, claims review, pricing review, taxonomy proposal/approval/activation, media upload/ZIP operations and inventory approval/return decisions (`inventory.adjust.approve`). Inventory admin retains `PlatformPermissionGuard` before `MfaGuard`. The reusable `brand.manage`, `staff.manage`, and `finance.evidence.manage` action metadata has no matching current routes. Auth enrollment, factor revocation, step-up and recovery APIs remain implemented and available.

Frontend privileged controls now resolve `mfaEnforcementMode` from the no-store current-session endpoint in the operations console, brand application review and taxonomy administration. Only exact server value `deferred` hides the step-up requirement; loading/error state and all unknown states remain enforced. Optional account enrollment remains user initiated; this change adds no automatic enrollment flow. Import/media business screens do not collect MFA proofs directly; server guards remain authoritative.

## Evidence matrix

| Area | Evidence | Current result |
| --- | --- | --- |
| Mode validation | `tests/config.test.cjs` | Covers default, accepted dev/test, invalid values, staging/production rejection |
| Guard semantics | `tests/mfa-guard.test.cjs` | Covers deferred authenticated pass, missing session, audit failure, forged client claims, enforced freshness |
| Session policy | `tests/current-session-policy.test.cjs` | Covers server mode, enforced fallback and no-store |
| Import signing key | `tests/w2/local-import-storage.test.cjs` | Covers isolated key signing and capability validation |
| Frontend policy | `tests/mfa-policy.test.ts`, `tests/ren2-100-admin-console.test.ts` | Covers fail-closed normalization and conditional admin-console prompt |
| Auth/API contracts | generated OpenAPI, backend Postman contract checks, frontend generated SDK | Regenerated; `npm run api:check` passed |
| Disposable DB/two-brand/full browser/API journeys | `tests/mfa-api.integration.test.cjs`, brand access, worker auth, API and frontend suites | Not executed here; requires explicitly disposable PostgreSQL/Redis and browser integration setup. Keep G07/G17 open pending this evidence. |

Do not treat controlled development as permission to activate protected W2 routes or production. Revalidate the full security suite and obtain the required security owner review and release approval before those gates close.
