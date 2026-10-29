# REN2-24 Privileged MFA and Authentication Audit — Design

## Intent

Protect seller/admin operations from password-only or stale sessions. Add a provider-independent TOTP authenticator factor, one-time recovery codes, server-held step-up state, security event auditing, and runnable API contract tests.

## Goals and constraints

- Meet REN2-24 AC-01 through AC-04 using the owner-approved ADR-W1-001 and the current Linear brief.
- Use the existing NestJS, PostgreSQL, Redis, opaque-cookie session, CSRF, OpenAPI, Postman and disposable CI patterns.
- Encrypt TOTP secrets with AES-256-GCM at rest; require a dedicated 32-byte base64 key in staging/production. Recovery codes carry 128 bits of randomness and are stored only as SHA-256 digests.
- Verify TOTP using RFC 6238, SHA-1, six digits, 30-second steps, a ±1-step clock window, and a persisted monotonic counter to prevent replay.
- Treat step-up as fresh for at most 300 seconds. This is a conservative implementation default for this issue, not an owner-approved policy value.
- Keep audit metadata allowlisted and omit OTP, recovery code, raw session token, and TOTP secret.
- Do not create brand, staff, finance-evidence, or other domain endpoints that do not exist. Supply a reusable server-side MFA guard for actual privileged routes and test it on a test-only route.
- Do not apply migrations to shared or hosted databases, call an SMS/provider service, publish to Postman Cloud, deploy, or merge.

## Approaches

1. Store a TOTP secret in plaintext and rely on database access control. Rejected because a database read would expose factors.
2. Delegate MFA to an external identity provider. Rejected because the approved architecture is first-party auth and the issue requires provider-independent tests.
3. Implement first-party TOTP, encrypt its secret with a dedicated application key, hash one-time recovery codes, and persist session elevation and audit state in PostgreSQL. Selected because it follows the ADR and existing session architecture without adding a provider dependency.

## API and enforcement design

- `GET /auth/mfa`: authenticated status and remaining recovery-code count.
- `POST /auth/mfa/enrollments`: CSRF-protected enrollment start; return a one-time `otpauth://` setup URI and synthetic-safe metadata; persist only an encrypted pending factor for 10 minutes. Permit one non-expired pending or active factor per user; an expired pending factor can be replaced. Never redisclose the secret from status or retry responses.
- `POST /auth/mfa/enrollments/verify`: verify first TOTP, activate factor, and return generated recovery codes once.
- `POST /auth/mfa/step-up`: verify TOTP or one recovery code, consume it atomically, rotate the opaque session, and set `mfa_verified_at` only in the new server-side session.
- `DELETE /auth/mfa/factor`: require a currently elevated session, revoke the factor and recovery codes, revoke the user's sessions, and expire the cookie.
- A `@RequireMfa()` metadata decorator and guard authenticate the cookie server-side and require a recent `mfa_verified_at`; client-supplied role or elevation fields are ignored. The initial repository has no concrete privileged domain routes, so no such product route is fabricated.

## Data and audit design

Add a reviewed Drizzle migration for encrypted MFA factors, hashed one-time recovery codes, allowlisted authentication security audit events, and nullable `mfa_verified_at` plus fixed `absolute_expires_at` on sessions. Session rotation atomically revokes the prior token, inserts a new token digest, marks only the new session elevated, and preserves the prior absolute expiry. Transactions lock the factor and session rows when consuming a TOTP counter/recovery code and rotating elevation. Revocation and audit writes are atomic with the state change; denied attempts receive an audit event without credential material. Audit retention remains subject to the existing owner/security decision; this feature does not invent a deletion period.

## Non-goals and limits

- No SMS, Twilio, Google OAuth, support bypass, or checkout OTP reuse.
- No role assignment or business permission matrix; no privileged domain handlers currently exist to wire.
- No claim of browser BFF/proxy behavior; the frontend is not part of this repository.
- The application's dedicated MFA encryption key must be configured before MFA is usable in a protected environment.

## Verification

Use unit tests for RFC vectors, clock windows, replay and secret protection; PostgreSQL disposable integration tests for enrollment, one-time recovery consumption, step-up rotation, revocation and audit metadata; provider-independent API/Postman tests for authorization denials; OpenAPI drift checks; and the existing full backend CI suite. Tests use synthetic data and disposable local services only.
