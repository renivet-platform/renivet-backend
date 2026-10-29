# Identity authentication foundation

This module implements REN2-21 registration/password authentication and the proposed REN2-22 email/phone verification challenge slice. NestJS DTO/decorator metadata is authoritative for the generated OpenAPI contract. Handwritten Postman functional collections are version controlled under `postman/collections/` and run against disposable CI services.

## Public operations

- `POST /api/v1/auth/register` creates a pending-verification email account and returns the same `202` body for new and duplicate canonical addresses.
- `POST /api/v1/auth/sessions` accepts an active, email-verified account's password and issues a 30-minute opaque first-party session cookie.
- `POST /api/v1/auth/challenges` requests email or phone verification. Unknown and already-verified contacts receive a neutral accepted response without delivery.
- `POST /api/v1/auth/challenges/{challengeId}/verify` verifies and consumes a one-use proof, marking only its bound contact verified. It does not issue a session.

## Credential and challenge controls

- Passwords are stored only as Argon2id PHC hashes (`m=19456 KiB`, `t=2`, `p=1`); unknown, wrong, unverified and inactive login identities share one generic failure.
- Session tokens are random 256-bit values returned only in a `__Host-renivet_session` cookie (`Secure`, `HttpOnly`, `SameSite=Lax`, `Path=/`, no `Domain`). PostgreSQL stores only a SHA-256 digest.
- OTPs are six-digit CSPRNG values with the approved initial defaults: five-minute expiry, five failed attempts, a 60-second resend cooldown, and three resends per contact/purpose in 15 minutes. Bounded environment settings configure lifecycle limits.
- PostgreSQL `identity.auth_challenges` is the durable authority. It stores only an HMAC-SHA-256 proof that binds challenge, user, channel, purpose, canonical contact, and code. Redis provides HMAC-keyed rate limits and short-lived operation locks; PostgreSQL transactions and row locks govern replacement, attempts, verification, and one-use consumption.
- Raw OTPs exist transiently only in the delivery adapter. The production default adapter is unavailable and performs no network I/O. Real email, SMS or WhatsApp providers require separate approval and configuration. CI injects an in-memory synthetic adapter only.
- Limiter-store failures fail closed. Responses and exception handling omit contact, code, proof, password, and provider-error details; submitted credentials are not logged.

## Contract and scope boundaries

REN2-21 and REN2-22 route/DTO contracts remain proposals because the Engineering OS D04 contract candidates are not approved. Keep their PRs in Draft until the owner reviews those operations. Existing REN2-20 tables are reused; no new migration is introduced. Session lookup/rotation/revocation, CSRF, recovery, MFA, and tenant/brand authorization are outside these slices. Do not add live provider integrations until provider accounts, templates, consent and security review are authorized.

For integration tests, use only PostgreSQL 16 database `renivet_ci` and Redis database 15 on loopback, with `RENIVET_TEST_SERVICES_DISPOSABLE=1`. CI provides disposable services and runs the Postman collections. Local integration tests reject missing disposable markers or non-loopback targets.
