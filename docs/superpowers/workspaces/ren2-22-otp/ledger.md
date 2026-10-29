# REN2-22 implementation ledger

Branch: `feature/REN2-22-purpose-bound-otp-challenges` (based on `origin/main` at `01852d25d22b29d36d9d17b8ed2dfa9f4962bc34`).

## Acceptance trace

- AC-01: HMAC proof binds challenge ID, user, channel, purpose, current contact and code; PostgreSQL locks challenge and user rows, persists failed attempts, enforces expiry, and consumes successful challenges in the same transaction. Unit and disposable PostgreSQL cases cover wrong, expired, replayed, mismatched-purpose, contact-change, attempt-exhaustion and simultaneous verification.
- AC-02: Redis fixed-window limits cover IP, normalized identity/purpose, verify IP, resend window and cooldown; Redis token-owned locks serialize issue/verify operations. Unit tests cover lock contention/failure; disposable CI covers cooldown and no provider call when limited.
- AC-03: Redis/proof configuration failures fail closed before database mutation. The default delivery adapter is uniformly unavailable before identity lookup. A transient fake-provider failure invalidates the newly created row and returns the same neutral accepted shape as unknown contacts. Responses redact provider/contact/code data.
- AC-04: No real delivery provider or external side effect exists. NestJS-generated OpenAPI and a separate handwritten Postman collection document and exercise the implemented operations. CI runs the Postman collection against disposable PostgreSQL/Redis and an in-memory fake provider.

## Verification

Locally passed: TypeScript build, unit/HTTP contract suite, `tsc --noEmit`, ESLint, OpenAPI generation, and OpenAPI/Postman drift check.

Disposable PostgreSQL 16 + Redis 7 integration/Postman suite is checked into CI. It could not be run on this workstation because PostgreSQL/Redis are not listening on loopback and Docker Desktop's Linux engine is unavailable. Do not claim the database acceptance run passed until CI reports success.

No Drizzle schema, migration, production service, live provider, or Postman Cloud workspace was changed. REN2-22 route/DTO approval against D04 remains a Draft PR owner-review gate; no Linear status was changed and no PR was merged.
