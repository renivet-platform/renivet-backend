# REN2-21 Registration and Password Authentication

## Intent

Implement first-party email registration and password authentication in the NestJS backend. Users can create a pending-verification account; only an active account with a verified email can establish a password session. The API returns neutral outcomes for duplicate registration and failed authentication.

## Goals

- Expose only `POST /api/v1/auth/register` and `POST /api/v1/auth/sessions`.
- Validate requests in NestJS and keep the public DTO separate from database models.
- Normalize email using `lower(trim(email))`, store passwords only as Argon2id PHC hashes, and persist registration/session state using the REN2-20 identity schema.
- Apply account and IP throttles with Redis. Throttle-store failures deny the request safely.
- Issue a host-only, opaque, HttpOnly session cookie only after verified-email password authentication.
- Generate the OpenAPI artifact from live NestJS decorators, maintain a local Postman collection, and check generated OpenAPI types in CI.
- Exercise successful and adversarial HTTP behavior against disposable PostgreSQL and Redis services using the Postman CLI. Disable run reporting and Cloud synchronization.

## Non-goals

- Email/phone OTP delivery and verification (REN2-22), account recovery, MFA, session refresh/CSRF lifecycle (REN2-23/24), third-party auth, frontend integration, and cloud Postman publication.
- Production or shared database migration, provider calls, deployments, or live credentials.

## Contract decisions for this slice

The source-verified D04 OpenAPI starter contains a `firstPartySession` cookie scheme but no registration/password operations. The Engineering OS API candidates list `POST /api/v1/auth/register` and `POST /api/v1/auth/sessions`, and REN2-21 requires the first real registration/password endpoints. This branch uses only those two candidate paths and records a concrete proposed request/response contract in code and generated OpenAPI for per-slice owner review. The current Linear REN2-21 brief explicitly requires D04 signoff; it has not been found in the starter contract. The branch/PR must remain a proposal until the owner records that signoff. Do not mark REN2-21 Done or merge before then.

Registration accepts `{ email, password }`, returns the same `202` body for a new or already-owned canonical email, creates new accounts in `pending_verification`, and does not merge or overwrite existing accounts. Email verification delivery is left to REN2-22. Password length is 8–128 characters with no composition rule. Password hashes use Argon2id with `m=19456 KiB, t=2, p=1`.

Password authentication accepts `{ email, password }`. Unknown, unverified, inactive, and wrong-password cases return the same `401` error. Success creates a random 256-bit opaque session secret, stores only its SHA-256 digest in `identity.user_sessions`, and returns it only in the `__Host-renivet_session; Secure; HttpOnly; SameSite=Lax; Path=/` cookie. This slice uses a 30-minute server expiry; REN2-23 owns idle extension, absolute lifetime, CSRF, revocation flows, and full session lifecycle.

Validation failures return a neutral `400` envelope; throttling returns `429`; unavailable PostgreSQL or Redis returns `503`. Error bodies include `code`, generic `message`, and `requestId`, never submitted contact or credential values.

## Approaches considered

- Wait for an auth-specific D04 route definition: safest source-only route, but no such operations are present in the verified D04 starter and it would leave REN2-21 unimplemented.
- Implement only a password verification service without HTTP: avoids a route decision but fails REN2-21's actual API/OpenAPI/Postman acceptance criteria.
- Use the two explicitly listed API candidate operations, implement a narrowly scoped contract from the already owner-accepted W1 defaults, and expose that proposal for owner review in the feature PR: selected because it delivers the requested slice without adding unrelated routes or claiming D04 itself contains auth DTOs.

## Constraints and review points

- `renivet-backend` remains the implementation owner. No edits to other repositories.
- Existing cloud Postman workspace and collection are read-only for this task. Local artifacts are version-controlled; cloud sync requires separate authorization.
- No PR merge without explicit owner approval.
- Review focus: normalization/uniqueness races, duplicate-account response equality, constant-work failed login, fail-closed Redis, request/log redaction, session-cookie behavior, migration-free database use, and OpenAPI/Postman drift.
