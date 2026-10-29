# Identity authentication foundation

This module implements the REN2-21 registration/password authentication slice, REN2-22 email/phone verification challenges, and REN2-23 opaque sessions, CSRF-protected logout, and email password recovery. NestJS DTO/decorator metadata is authoritative for the generated OpenAPI contract. Handwritten Postman functional collections are version controlled under `postman/collections/` and run against disposable CI services.

## Public operations

- `POST /api/v1/auth/register` creates a pending-verification email account and returns the same `202` body for new and duplicate canonical addresses.
- `POST /api/v1/auth/sessions` accepts an active, email-verified account's password and issues a 30-minute opaque first-party session cookie.
- `GET /api/v1/auth/session` validates the opaque cookie, renews its 30-minute idle expiry up to a seven-day absolute maximum, and returns a minimal identity plus session-bound CSRF proof.
- `DELETE /api/v1/auth/session` requires the active cookie, an exact configured `Origin`, `Sec-Fetch-Site: same-origin`, and matching `X-CSRF-Token`; it revokes the database session before expiring the cookie.
- `POST /api/v1/auth/challenges` requests email or phone verification. Unknown and already-verified contacts receive a neutral accepted response without delivery.
- `POST /api/v1/auth/challenges` also accepts the email-only `password_recovery` purpose. Ineligible contacts receive a neutral accepted response.
- `POST /api/v1/auth/challenges/{challengeId}/verify` verifies and consumes a one-use proof. Verification marks only its bound contact; password recovery additionally validates and hashes a replacement password and atomically revokes all prior user sessions.

## Credential and challenge controls

- Passwords are stored only as Argon2id PHC hashes (`m=19456 KiB`, `t=2`, `p=1`); unknown, wrong, unverified and inactive login identities share one generic failure.
- Session tokens are random 256-bit values returned only in a `__Host-renivet_session` cookie (`Secure`, `HttpOnly`, `SameSite=Lax`, `Path=/`, no `Domain`). PostgreSQL stores only a SHA-256 digest.
- Session lookup and revocation use only the database digest. Login rotates a presented same-user session. Recovery changes the active password credential and revokes all sessions inside the same transaction as challenge consumption.
- Cookie-authenticated logout requires a CSRF proof derived with the dedicated `AUTH_CSRF_HMAC_KEY`, exact allowlisted Origin, and same-origin Fetch Metadata. `AUTH_ALLOWED_ORIGINS` must contain exact origins; staging/production require HTTPS origins and a dedicated key.
- OTPs are six-digit CSPRNG values with the approved initial defaults: five-minute expiry, five failed attempts, a 60-second resend cooldown, and three resends per contact/purpose in 15 minutes. Bounded environment settings configure lifecycle limits.
- PostgreSQL `identity.auth_challenges` is the durable authority. It stores only an HMAC-SHA-256 proof that binds challenge, user, channel, purpose, canonical contact, and code. Redis provides HMAC-keyed rate limits and short-lived operation locks; PostgreSQL transactions and row locks govern replacement, attempts, verification, and one-use consumption.
- Raw OTPs exist transiently only in the delivery adapter. The production default adapter is unavailable and performs no network I/O. Real email, SMS or WhatsApp providers require separate approval and configuration. CI injects an in-memory synthetic adapter only.
- Limiter-store failures fail closed. Responses and exception handling omit contact, code, proof, password, and provider-error details; submitted credentials are not logged.

## Contract and scope boundaries

REN2-21/22/23 route/DTO contracts continue the proposed API candidate paths and remain subject to D04 owner approval; no production/deployed topology is asserted by disposable local tests. Existing REN2-20 tables are reused; no new migration is introduced. The default OTP delivery adapter is unavailable and performs no network I/O, so actual email recovery delivery requires separately approved provider configuration. Privileged MFA and tenant/brand authorization remain outside these slices. Do not add live provider integrations until provider accounts, templates, consent and security review are authorized.

For integration tests, use only PostgreSQL 16 database `renivet_ci` and Redis database 15 on loopback, with `RENIVET_TEST_SERVICES_DISPOSABLE=1`. CI provides disposable services and runs the Postman collections. Local integration tests reject missing disposable markers or non-loopback targets.
