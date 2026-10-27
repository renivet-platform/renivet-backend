# Identity authentication foundation

This module implements the REN2-21 slice only. It registers two public operations:

- `POST /api/v1/auth/register` creates a pending-verification email account and returns the same `202` body for new and duplicate canonical email addresses.
- `POST /api/v1/auth/sessions` accepts an active, email-verified account's password and creates a 30-minute opaque first-party session cookie.

NestJS DTO/decorator metadata is authoritative. The generated OpenAPI document is checked in at `openapi/renivet.openapi.json`; the local, handwritten Postman functional collection is under `postman/collections/` and runs on disposable CI services.

## Credential and abuse controls

- Password length is 15–128 Unicode code points. There is no composition rule.
- Passwords are stored only as Argon2id PHC hashes with `m=19456 KiB`, `t=2`, `p=1`, a unique library-generated salt and a 32-byte output.
- Login performs a dummy Argon2id verification for an unknown account. Unknown, wrong-password, unverified and inactive accounts share the same public `401` response.
- Registration and login use atomic Redis fixed-window account and IP limits. Redis keys use HMAC-SHA-256 identifiers; the HMAC key is never placed in Redis key text. Limiter-store failures fail closed.
- Successful login returns a random 256-bit session token only in `__Host-renivet_session` (`Secure`, `HttpOnly`, `SameSite=Lax`, `Path=/`, no `Domain`). PostgreSQL stores only its SHA-256 digest and expiry.
- Responses and exception handling do not include submitted email, password, hash or raw session value. This module does not log submitted credentials.

## Boundaries and approval

Email verification/delivery, session lookup/rotation/revocation, CSRF, recovery, MFA, phone auth and tenant/brand authorization remain outside REN2-21. Existing REN2-20 identity tables are used without a new migration. The D04 starter currently has no registration/password operation DTOs; the two paths above match the Engineering OS API candidates and remain proposed for the required per-slice owner contract review. Do not merge until that review is recorded.

For integration tests, use only PostgreSQL 16 database `renivet_ci` and Redis database 15 on loopback, and set `RENIVET_TEST_SERVICES_DISPOSABLE=1` explicitly. The checked-in CI job provides fresh disposable services. The local test refuses to run without the marker, database/role checks and loopback URLs.
