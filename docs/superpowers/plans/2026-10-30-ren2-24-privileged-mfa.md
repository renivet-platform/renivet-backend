# REN2-24 Privileged MFA and Authentication Audit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement reviewed first-party privileged MFA, session step-up enforcement, auditable lifecycle events, and repeatable API/CI evidence for REN2-24.

**Architecture:** Add a provider-independent RFC 6238 TOTP service, AES-GCM secret protection, one-use recovery-code digests, and transactional MFA/session/audit persistence through the existing PostgreSQL identity repository. Expose only the lifecycle endpoints in scope and a reusable server-side MFA guard; do not invent missing seller/admin business handlers.

**Tech Stack:** NestJS 12, TypeScript, PostgreSQL 16, Drizzle, Node.js crypto, Redis-backed auth rate limiter, Nest Swagger/OpenAPI, Postman CLI, Node test runner.

**Spec:** `docs/superpowers/specs/2026-10-30-ren2-24-privileged-mfa-design.md`

## Global Constraints

- No client-supplied role or MFA claim grants privilege.
- Never store or log plaintext TOTP secrets, OTPs, recovery codes, or session tokens.
- TOTP: RFC 6238, HMAC-SHA1, six digits, 30 seconds, ±1 step; reject an already-used step.
- MFA elevation lasts at most 300 seconds; this conservative implementation default is not represented as a prior owner decision.
- Pending factor expires after 10 minutes; its provisioning secret is returned only by the creation response; allow only one pending/active factor at a time.
- Session rotation preserves the existing fixed absolute expiry, revokes the old token and elevates only the new session.
- Step-up: rotate the opaque cookie and store elevation only on the new server-side session.
- Mutations retain existing exact-Origin, same-origin fetch metadata and session CSRF protections.
- No hosted DB migration, provider call, deployment, Postman Cloud sync, or merge.

## Review Focus

- Concurrent replay / recovery redemption: must have one successful transaction and one denied attempt.
- Secret leakage via HTTP/log/audit/error: all external and persistent surfaces exclude factor material.
- Key missing or malformed in protected environment: configuration validation must fail closed.
- Forged client role/elevation fields and stale MFA: the guard only trusts the persisted authenticated session.
- Database or Redis outage / rate-limit bypass: MFA fails closed with safe errors.

---

### Task 1: Crypto, configuration and schema foundation

**Files:**
- Create: `src/modules/identity/mfa-crypto.ts`
- Create: `tests/identity-mfa-crypto.test.cjs`
- Modify: `src/config/environment.ts`, `.env.example`, `tests/config.test.cjs`, `src/db/schema.ts`
- Create: generated migration and snapshot under `drizzle/`

**Interfaces:**
- `generateTotpSecret(): Buffer`, `totpCode(secret, timeMs): string`, `verifyTotp(secret, code, timeMs, lastAcceptedStep?): number | null`
- AES-256-GCM encrypt/decrypt helpers accept a 32-byte decoded key and factor/user identifiers as authenticated context.
- Schema models factors (encrypted secret, lifecycle, replay counter), recovery-code digests, audit events, and session elevation timestamp.

- [ ] Add RFC 6238 test vectors, ±1 window tests, malformed-key/code rejection, cipher AAD/tamper tests, recovery-code randomness and keyed digest tests.
- [ ] Run `node --test tests/identity-mfa-crypto.test.cjs` and observe the expected missing-module failures.
- [ ] Implement the minimal crypto functions and config validation; protected environments require dedicated base64-encoded 32-byte `AUTH_MFA_ENCRYPTION_KEY` distinct from existing auth keys.
- [ ] Add Drizzle schema and generate migration; inspect SQL for FK, checks, uniqueness and indexes.
- [ ] Run crypto/config tests and `npm run typecheck`.

### Task 2: Transactional factor lifecycle, audit and session step-up

**Files:**
- Create: `src/modules/identity/mfa.service.ts`
- Modify: `src/modules/identity/identity.repository.ts`, `src/modules/identity/session.service.ts`, `src/modules/identity/identity.module.ts`
- Create: `tests/identity-mfa-service.test.cjs`

**Interfaces:**
- `MfaService.beginEnrollment(userId, sessionId, ip): enrollment`
- `MfaService.confirmEnrollment(userId, code, ip): oneTimeRecoveryCodes`
- `MfaService.stepUp(userId, currentTokenHash, proof, ip): rotatedSession`
- `MfaService.revokeFactor(userId, sessionId, ip): void`
- `MfaService.status(userId): status`
- Repository methods persist and verify with row locks/transactions; session authentication returns persisted `mfaVerifiedAt`.

- [ ] Add tests for enrollment, bad/replayed TOTP denial, recovery code one-time use, exhausted codes, session rotation, stale elevation, revocation, safe audit metadata and DB failure handling.
- [ ] Run focused tests RED before implementation.
- [ ] Implement encrypted pending factor and expiry, activation plus one-time recovery codes, atomic proof consumption and elevation rotation, revocation, and allowlisted audit writes.
- [ ] Add fixed-window MFA rate limits and fail-closed Redis behavior.
- [ ] Run focused service tests and disposable PostgreSQL migration/integration verification.

### Task 3: HTTP endpoints and reusable authorization guard

**Files:**
- Create: `src/modules/identity/mfa.controller.ts`, `src/modules/identity/mfa.dto.ts`
- Create: `src/common/guards/require-mfa.ts`
- Modify: `src/modules/identity/identity.module.ts`, session/auth request wiring
- Create: `tests/mfa-api.integration.test.cjs`, guard tests

- [ ] Add failing API/guard tests for missing session, bad CSRF/origin, unauthenticated setup, missing/stale elevation, forged client role/elevation, invalid/replayed/revoked factor and safe errors.
- [ ] Verify expected RED results.
- [ ] Implement only the `GET /auth/mfa`, enrollment start/verify, step-up and factor-revocation routes. Apply server-side session+CSRF verification to mutations and cookie rotation/expiry to step-up/revocation.
- [ ] Add `@RequireMfa()` guard that uses session state from the cookie and never request-body role fields; test it on a test-only route, not a fabricated business API.
- [ ] Run API/guard tests through the disposable test app.

### Task 4: OpenAPI, Postman, CI and documentation

**Files:**
- Modify: `postman/collections/renivet-backend-auth.postman_collection.json`, `scripts/check-postman-contract.cjs`, `tests/auth-openapi.test.cjs`, `.github/workflows/ci.yml`
- Modify: generated `openapi/renivet.openapi.json`, `src/generated/api-schema.d.ts`
- Modify: identity/Postman/test README documentation

- [ ] Add OpenAPI and Postman structural tests, synthetic request/response examples, authorization/error cases, and `{{apiBaseUrl}}` usage before generating contract output.
- [ ] Confirm tests detect missing MFA routes and outdated collection before implementation.
- [ ] Generate the authoritative OpenAPI artifacts and add handwritten Postman requests without replacing existing custom tests/scripts.
- [ ] Add CI migration replay and provider-independent PostgreSQL/Postman tests on disposable services only.
- [ ] Run `npm run api:check`, full tests, lint, typecheck, build, and all applicable local disposable integration steps.

### Task 5: Reviewable delivery

**Files:** all feature files in this plan.

- [ ] Check AC-01..AC-04 against evidence and document the absent business route limitation accurately.
- [ ] Review diff, secret-bearing paths and migration idempotency.
- [ ] Commit feature changes and open a PR targeting `main`; never merge.

## Execution Ledger

- Base: `835e513f672349bb65e94e6b4dc28558642eb3eb` (`origin/main` at branch creation).
